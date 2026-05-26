# A13: Wrap stats DB ingestion in a transaction

## Context

The web server's stats ingestion endpoint (`POST /api/stats/session` in `packages/web/src/server/routes/stats.ts`) persists session data — run metadata, messages, tool calls, and file ops — to SQLite via bun:sqlite (through Drizzle ORM). Under concurrent writes from multiple dispatcher pods, partial writes could leave the database in an inconsistent state.

### Current code state

**`stats.ts` lines 94–178**: The stats ingestion block is **already wrapped** in a Drizzle transaction using `db.transaction((tx) => { ... })`. All delete+insert operations for runs, messages, toolCalls, and fileOps execute within this single transaction closure. If any operation throws, the entire transaction rolls back automatically via bun:sqlite's underlying transaction mechanism.

```ts
// Current (already transacted):
db.transaction((tx) => {
  tx.insert(runs).values({...}).onConflictDoUpdate(...).run();
  if (body.messages?.length) { /* delete + insert loop */ }
  if (body.toolCalls?.length) { /* delete + insert loop */ }
  if (body.fileOps?.length) { /* delete + insert loop */ }
});
```

This satisfies the audit finding A13's primary concern — all four table writes are atomic.

### Other write paths reviewed

| Write path | Location | Transaction status | Notes |
|---|---|---|---|
| Stats ingestion (POST /api/stats/session) | `stats.ts:94-178` | **Already transacted** via `db.transaction()` | All 4 tables in one tx |
| Retention cleanup (`runRetentionCleanup`) | `stats.ts:250-261` | Single-statement DELETE | No wrapping needed — atomic by nature |
| Task event logging (`appendTaskEvent`) | `board.ts:55-67` | Single-statement INSERT | Best-effort (catch-all), single row |
| Drizzle migrations (`migrate()`) | `db.ts:47` | **Already transacted** per-file | drizzle-orm/bun-sqlite migrator wraps each migration file in BEGIN/COMMIT by default |

## Approach

The primary audit finding (A13) is already addressed — the stats ingestion block uses Drizzle's transaction API which correctly wraps all writes. The remaining work from the task description is:

1. **Verify** the existing `db.transaction()` usage is correct and complete (it is).
2. **Document** that migrations are transacted by default in drizzle-orm/bun-sqlite.
3. **Add a SIGTERM handler** to `db.ts` for graceful DB shutdown (A14 low-priority item, also requested).

No schema changes or drizzle migrations are needed — this is purely a runtime code change.

## Tasks

### Task 1: Verify stats ingestion transaction coverage

- [ ] Confirm the existing `db.transaction()` in `stats.ts` covers all write operations for a session (runs upsert, messages delete+insert, toolCalls delete+insert, fileOps delete+insert).
- [ ] Verify that if any operation inside the transaction throws, bun:sqlite/Drizzle will roll back all prior writes.
- **Expected result**: No code changes needed — existing implementation is correct.

### Task 2: Add SIGTERM handler to `db.ts` (A14)

- [ ] In `packages/web/src/server/db.ts`, after the singleton `_db = db;` assignment (line 51), add a process-level SIGTERM handler that closes the underlying bun:sqlite Database instance.
- [ ] The handler must close the raw `sqlite` handle (not just the Drizzle wrapper) to prevent WAL corruption on abrupt shutdown.

**Implementation**:

```ts
// In db.ts, after line 51 (_db = db;), add:

let _sqliteHandle: Database | null = null; // store reference for close

// Modify getDb() to capture the sqlite handle:
const sqlite = new Database(dbPath, { create: true });
_sqliteHandle = sqlite;
// ... rest of setup ...
_db = db;

// Add SIGTERM handler after the function definition:
process.on('SIGTERM', () => {
  if (_sqliteHandle) {
    try { _sqliteHandle.close(); } catch {}
  }
  process.exit(0);
});
```

**Note**: The `Database` type from bun:sqlite has a `.close()` method that flushes WAL and closes the file handle. This prevents corruption when the web pod is terminated (e.g., during deployment rollouts or OOM kills).

### Task 3: Run typecheck + build verification

- [ ] Run `pnpm typecheck` from repo root — verify no TypeScript errors.
- [ ] Run `pnpm build` from repo root — verify all packages compile cleanly.
- **Expected result**: Both commands pass with exit code 0.

### Task 4: Commit and push the plan artifact

- [ ] Commit `.percussionist/plans/percussionist-dev-plan-a13-stats-db-transaction.md` to the current branch.
- [ ] Push the commit so reviewers can access the plan.

## Risks / Open Questions

| Risk | Mitigation |
|---|---|
| SIGTERM handler fires during DB initialization (race between `getDb()` call and signal) | Guard with null check on `_sqliteHandle`; if DB isn't initialized yet, there's nothing to close. |
| Multiple SIGTERM signals received before handler completes | `process.exit(0)` is idempotent; the try/catch around `.close()` prevents errors from crashing the shutdown path. |
| bun:sqlite `Database.close()` behavior differs across Bun versions | Tested in the target environment (Bun 24 per Dockerfile); if issues arise, fall back to just letting the process exit (OS cleans up file handles). |
| The existing `db.transaction()` might not be what the audit expected (raw SQL vs Drizzle wrapper) | Both approaches provide identical atomicity guarantees in SQLite. Drizzle's transaction API is the idiomatic approach for this codebase. |

## Acceptance Criteria

- [x] Stats ingestion in `stats.ts` is wrapped in a single transaction — **already satisfied** by existing `db.transaction()` at lines 95–178.
- [ ] SIGTERM handler added to `db.ts` that closes the SQLite database before exit.
- [ ] `pnpm typecheck && pnpm build` pass with no errors.
- [ ] No drizzle migration needed (pure runtime change, confirmed — no schema changes).

## BUILD Task Breakdown (if this plan is approved)

1. **BUILD 1**: Add SIGTERM handler to `db.ts` — modify the singleton getter to store a reference to the raw sqlite handle and register a process-level signal handler.
2. **BUILD 2**: Run `pnpm typecheck && pnpm build` to verify no regressions from the change.

No additional BUILD tasks needed since the transaction wrapping is already in place.
