# B12: Fix operator infinite retry loop on deleted Run CRs

## Context

The operator's work queue (`packages/operator/src/reconciler.ts`) processes Run CRs via a `runWorker` function that pulls keys from a FIFO array, fetches fresh data from the K8s API, and calls `reconcile()`. When a Run CR is deleted while it sits in the queue or during processing, the worker receives a 404 from the K8s API but the catch block re-enqueues it after 5 seconds unconditionally — creating an infinite retry loop until the next full resync clears the `seen` map.

### Root cause analysis

**Bug #1 — No 404 check in error handler.** In `runWorker` (line 622–627), the catch block catches all errors and re-enqueues after 5 seconds:
```typescript
} catch (e) {
  err(`reconcile(${key}) failed:`, (e as Error).message);
  setTimeout(() => {
    const current = seen.get(key);
    if (current) enqueue(current);
  }, 5000);
}
```
When `co.getNamespacedCustomObject` throws a 404 (CR was deleted), this still re-enqueues. The `seen.get(key)` check only prevents re-enqueueing if the informer's delete handler already ran and removed it from `seen`. But there's a race: the worker may have already fetched fresh data into `seen` before the informer fires, so the key remains in `seen` with stale data.

**Bug #2 — `dequeue` does not remove from `queue` array.** The `dequeue` function (line 591–596) removes keys from `seen`, `pending`, `processing`, and `dirty` sets, but the `queue` is a plain `string[]` that dequeue never splices. So even after `dequeue(key)` is called by the informer's delete handler, the key can linger in the queue array until it reaches the front via `shift()`.

**Existing helper:** The file already has an `isNotFound(e)` function (line 511–513) that checks both `.statusCode` and `.code` for 404. It's used in `cleanupChildResources` but not in the worker error handler.

### Affected code paths

| File | Function/Line | Issue |
|------|--------------|-------|
| `packages/operator/src/reconciler.ts:622–627` | `runWorker` catch block | Re-enqueues on ALL errors including 404 |
| `packages/operator/src/reconciler.ts:591–596` | `dequeue` | Does not splice from `queue` array |

## Approach

Two minimal, surgical fixes in a single file (`reconciler.ts`):

1. **Fix `dequeue` to also remove from the queue array** — ensures deleted items are fully cleaned up immediately when the informer fires.
2. **Add 404 check in `runWorker` catch block** — if the error is a 404, call `dequeue(key)` and log at info level; do NOT re-enqueue. Non-404 errors keep existing behavior (5-second retry).

### Design decisions

- Use the existing `isNotFound(e)` helper rather than creating new logic. It already handles both `.statusCode` and `.code` properties, covering multiple K8s client versions.
- The 404 check must wrap the entire try block (both the API fetch AND reconcile), because either could throw a 404:
  - `co.getNamespacedCustomObject` throws 404 if CR was deleted before processing
  - `reconcile(fresh)` calls `patchStatus` which also uses K8s API and can throw 404
- Log at info level (not error) for 404 — this is expected behavior when a CR is deleted, not an anomaly.

## Tasks

### Task 1: Fix `dequeue` to remove from queue array

**File:** `packages/operator/src/reconciler.ts`, lines 591–596

Change the `dequeue` function to also splice the key out of the `queue` array:

```typescript
export function dequeue(key: string): void {
  seen.delete(key);
  pending.delete(key);
  processing.delete(key);
  dirty.delete(key);
  const idx = queue.indexOf(key);
  if (idx !== -1) queue.splice(idx, 1);
}
```

This ensures that when the informer's `onDelete` handler calls `dequeue`, the key is removed from ALL data structures immediately — not just the sets.

### Task 2: Add 404 check in `runWorker` catch block

**File:** `packages/operator/src/reconciler.ts`, lines 622–627

Replace the current catch block with one that checks for 404:

```typescript
} catch (e) {
  if (isNotFound(e)) {
    log(`run ${key} not found, removing from queue`);
    dequeue(key);
  } else {
    err(`reconcile(${key}) failed:`, (e as Error).message);
    setTimeout(() => {
      const current = seen.get(key);
      if (current) enqueue(current);
    }, 5000);
  }
}
```

This handles both failure modes:
- **404 from API fetch** (`co.getNamespacedCustomObject`): CR was deleted, dequeue and stop.
- **404 from reconcile internals** (e.g., `patchStatus` on a deleted CR): Same handling.
- **Any other error**: Keep existing 5-second retry behavior.

### Task 3: Verify build passes

Run `pnpm typecheck && pnpm build` to confirm no type errors are introduced. The changes only touch internal queue management — no public API surface is affected.

## Risks / Open Questions

1. **Queue splice performance**: `queue.splice(idx, 1)` is O(n) on the array length. In practice the queue is small (number of pending Run CRs), so this is negligible. If it becomes a concern, consider using a Set-based queue instead — but that's out of scope for B12.

2. **Race between informer delete and worker fetch**: With both fixes applied:
   - If informer fires first → `dequeue` removes from all structures including queue → worker won't find the key when it shifts (or finds it already removed) → safe.
   - If worker fetches fresh data first → key stays in `seen` with new data → informer delete calls `dequeue` which now also splices from queue → worker's finally block checks `dirty` but key was removed → safe.
   - If neither fires before error → catch block sees 404, calls `dequeue`, logs info → safe.

3. **The `isNotFound` helper** currently checks `{ statusCode }` and `{ code }`. The `@kubernetes/client-node` library throws errors with `.body?.code === 404` for 404 responses. This should be covered by the existing helper, but if testing reveals otherwise, we may need to also check `(e as { body?: { code?: number } }).body?.code`.

## Acceptance Criteria

- [ ] Deleting a Run CR while it is queued stops reconciliation immediately (no re-enqueue).
- [ ] Non-404 errors still retry with 5-second backoff.
- [ ] `pnpm typecheck && pnpm build` pass.
- [ ] The `dequeue` function removes keys from the queue array in addition to all sets.

## BUILD Task Breakdown (if needed)

1. **BUILD #1**: Fix `dequeue` — add `queue.splice(indexOf(key), 1)` at end of function.
2. **BUILD #2**: Fix `runWorker` catch block — add `isNotFound(e)` check with info log + dequeue for 404, else keep existing retry logic.
3. **BUILD #3** (optional): Verify build passes (`pnpm typecheck && pnpm build`).

These can be combined into a single BUILD since both changes are in the same file and small.
