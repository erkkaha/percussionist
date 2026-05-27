# S19: Validate `patch_board` MCP Tool Input — Implementation Plan

## Context

### The Vulnerability (Audit Finding S19, High Severity)

The `patch_board` MCP tool in the manager controller (`packages/manager-controller/src/agent/tools.ts`, lines 698–704) accepts an arbitrary JSON `patch` object from the LLM agent and passes it directly to `patchProjectStatus` with no validation whatsoever:

```typescript
case "patch_board": {
  const project = String(args.project ?? "");
  const patch = args.patch as Record<string, unknown>;
  const { patchProjectStatus } = await import("@percussionist/kube");
  await patchProjectStatus(project, { board: patch as never }, ns);
  return { project, patched: true };
}
```

The `patch` parameter is extracted from the raw MCP call input, cast through `Record<string, unknown>`, then passed to Kubernetes via a merge-patch with an `as never` TypeScript suppression. This means:

1. **No key allowlist** — any top-level key in the patch object reaches the K8s API
2. **No value type validation** — primitives can be placed where arrays/objects are expected
3. **No body size limit** on the MCP server's `readBody()` function (also covers S13)

A prompt-injected LLM agent could corrupt board state by zeroing out `activeWorkers`, wiping `workers` fields, or injecting arbitrary keys into `Project.status.board`.

### Relevant Code Paths

| File | Role |
|------|------|
| `packages/manager-controller/src/agent/tools.ts:698-704` | `patch_board` handler — no validation |
| `packages/manager-controller/src/agent/tools.ts:128-143` | Tool input schema — generic `object`, no property enumeration |
| `packages/manager-controller/src/agent/tools.ts:426-433` | `readBody()` — no size cap |
| `packages/kube/src/index.ts:430-477` | `patchProjectStatus()` — raw serialization of whatever is passed in |
| `packages/api/src/index.ts:730-738` | `BoardStatusSchema` — defines legitimate keys and types |

### Board Status Schema (Source of Truth)

```typescript
export const BoardStatusSchema = z.object({
  activeWorkers:        z.number().int().min(0).default(0),
  escalations:          z.string().array().optional(),
  pendingQuestions:     PendingQuestionSchema.array().optional(),
  facilitations:        FacilitationResultSchema.array().optional(),
  lastEventAt:          z.string().optional(),
  managerMetrics:       ManagerMetricsSchema.optional(),
});
```

The audit identifies **four legitimate keys** for the `patch_board` tool:
- `escalations` — string array
- `pendingQuestions` — PendingQuestion array (each has `workerId`, `sessionID`, `messageText`)
- `facilitations` — FacilitationResult array
- `managerMetrics` — ManagerMetrics object

Note: `activeWorkers` and `lastEventAt` exist in the schema but are reconciler-managed fields not intended for direct patching via this tool. They will be excluded from the allowlist to prevent accidental corruption.

## Approach

### Design Decisions

1. **Reject unknown keys (fail-fast)** — Rather than silently stripping unknown keys, return a tool error listing which keys were rejected. This gives the LLM agent clear feedback and prevents silent data loss.

2. **Use Zod for validation** — The `BoardStatusSchema` already exists in `@percussionist/api`. We will use `.partial().pick()` to create a validated subset schema, then call `.safeParse()` on the incoming patch object. This reuses existing type definitions and keeps the allowlist DRY (single source of truth).

3. **Inline size limit for `readBody`** — Add a configurable byte counter in the `data` event handler. When the accumulated size exceeds 1 MB, reject with an error. This is simpler than refactoring to use streams with limits and avoids introducing new dependencies.

4. **No changes to `patchProjectStatus` or K8s API layer** — Validation happens at the MCP tool boundary (the first trust boundary). The downstream functions remain unchanged since they are internal implementation details called from trusted code paths only.

### What Changes

| File | Change |
|------|--------|
| `packages/manager-controller/src/agent/tools.ts` | Add validation to `patch_board` handler; add size limit to `readBody`; update tool input schema |

### What Does NOT Change

- `packages/kube/src/index.ts` — `patchProjectStatus` remains unchanged
- `packages/api/src/index.ts` — schemas remain unchanged (we consume them, don't modify)
- No new dependencies or packages added
- No changes to other MCP tools

## Tasks

### Task 1: Add body size limit to `readBody()` in manager controller

**File:** `packages/manager-controller/src/agent/tools.ts` (lines 426–433)

**Steps:**
1. Define a constant `MAX_BODY_SIZE = 1_048_576` (1 MB, covers S13 as well).
2. Modify the `readBody` function to track accumulated byte count in the `data` event handler.
3. When `totalSize > MAX_BODY_SIZE`, emit an error: `"Request body exceeds 1MB limit"`.
4. Reject the promise with this error so the MCP server returns a proper JSON-RPC error response.

**Implementation sketch:**
```typescript
const MAX_BODY_SIZE = 1_048_576; // 1 MB — covers S13 + S19

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on("data", (c: Buffer) => {
      totalSize += c.length;
      if (totalSize > MAX_BODY_SIZE) {
        reject(new Error(`Request body exceeds ${MAX_BODY_SIZE} byte limit`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
```

**Acceptance:** Any request body larger than 1 MB is rejected with a clear error message before the handler runs.

---

### Task 2: Define allowlist schema for `patch_board` validation

**File:** `packages/manager-controller/src/agent/tools.ts` (near top, after imports)

**Steps:**
1. Import `BoardStatusSchema` from `@percussionist/api`.
2. Create a pick-schema that only allows the four audit-identified keys:
   ```typescript
   const PatchBoardInputSchema = BoardStatusSchema.partial().pick({
     escalations: true,
     pendingQuestions: true,
     facilitations: true,
     managerMetrics: true,
   });
   ```
3. This schema inherits all the Zod type constraints from `BoardStatusSchema` (arrays must be arrays, objects must match their sub-schemas).

**Why this approach:** Using `.pick()` on the existing schema means:
- The allowlist is derived from the single source of truth (`BoardStatusSchema`)
- Type validation for nested structures (e.g., `PendingQuestionSchema`, `ManagerMetricsSchema`) is automatically inherited
- If the base schema changes, the tool validation stays in sync

---

### Task 3: Add input validation to `patch_board` handler

**File:** `packages/manager-controller/src/agent/tools.ts` (lines 698–704)

**Steps:**
1. Replace the current unvalidated handler with one that:
   - Checks that `args.patch` is a non-null object (not array, not primitive).
   - Runs `.safeParse()` against `PatchBoardInputSchema`.
   - If validation fails, returns a tool error with details about which keys/values were rejected.
   - If validation succeeds, passes the parsed result to `patchProjectStatus`.

**Implementation sketch:**
```typescript
case "patch_board": {
  const project = String(args.project ?? "");
  
  // Validate patch is an object (not array or primitive)
  if (args.patch === null || typeof args.patch !== "object" || Array.isArray(args.patch)) {
    return { error: "patch must be a JSON object, not an array or primitive" };
  }
  
  const rawPatch = args.patch as Record<string, unknown>;
  
  // Validate against allowlist schema (rejects unknown keys + validates types)
  const result = PatchBoardInputSchema.safeParse(rawPatch);
  if (!result.success) {
    const errors = result.error.issues.map(i => 
      `${i.path.join(".")}: ${i.message}`
    ).join("; ");
    return { error: `Invalid patch input: ${errors}` };
  }
  
  const validatedPatch = result.data;
  const { patchProjectStatus } = await import("@percussionist/kube");
  await patchProjectStatus(project, { board: validatedPatch }, ns);
  return { project, patched: true };
}
```

**Key behaviors:**
- Unknown keys → rejected with error listing the unknown key(s)
- Wrong types (e.g., `escalations: "not-an-array"`) → rejected with Zod error details
- Valid patch → passes through to K8s API as before

---

### Task 4: Update tool input schema for `patch_board`

**File:** `packages/manager-controller/src/agent/tools.ts` (lines 128–143)

**Steps:**
1. Add `additionalProperties: false` to the `patch` property in the JSON Schema to signal to LLMs that only known keys are accepted.
2. Update the description to mention validation and list allowed keys explicitly.

**Before:**
```json
{
  "name": "patch_board",
  "inputSchema": {
    "type": "object",
    "properties": {
      "project": { "type": "string" },
      "patch": {
        "type": "object",
        "description": "Status board patch..."
      }
    },
    "required": ["project", "patch"]
  }
}
```

**After:**
```json
{
  "name": "patch_board",
  "inputSchema": {
    "type": "object",
    "properties": {
      "project": { "type": "string" },
      "patch": {
        "type": "object",
        "additionalProperties": false,
        "description": "Status board patch. Allowed keys: escalations (string[]), pendingQuestions (array of objects with workerId/sessionID/messageText), facilitations (array), managerMetrics (object). Unknown keys are rejected."
      }
    },
    "required": ["project", "patch"]
  }
}
```

---

### Task 5: Run typecheck and build to verify

**Steps:**
1. Run `pnpm typecheck` from the workspace root — all packages must pass with zero errors.
2. Run `pnpm build` — all packages must compile successfully.
3. Verify no new TypeScript errors were introduced (the `PatchBoardInputSchema` pick should be fully typed).

## Risks and Open Questions

### Risk 1: Zod `.pick()` on a schema with `.default()` values
The `activeWorkers` field has `.default(0)`, but since we're using `.partial().pick()`, this shouldn't matter — the picked fields that are present will be validated, and absent fields won't trigger defaults. **Mitigation:** Test with an empty patch `{}` to confirm it passes validation (all picked keys are optional via `.partial()`).

### Risk 2: `BoardStatusSchema` is not exported from `@percussionist/api`
If the schema isn't re-exported, we may need to import it directly from `packages/api/src/index.ts`. **Mitigation:** Check the export barrel; if not exported, add a re-export or use a direct path.

### Risk 3: Backward compatibility with existing board patches
If any existing code (reconciler, other tools) calls `patch_board` with keys like `activeWorkers` or `lastEventAt`, those will now be rejected. **Assessment:** The tool is MCP-based and called by LLM agents — the reconciler uses direct K8s API calls, not this tool. No backward compatibility concern.

### Open Question: Should `activeWorkers` be in the allowlist?
The audit identifies four keys only. However, the tool description mentions `activeWorkers`. If future use cases require agents to adjust worker counts, we could add it later. For now, excluding it prevents accidental corruption of a reconciler-managed field.

### Open Question: Error response format
Should validation errors return `{ error: "..." }` (matching existing patterns in the codebase) or should they throw? The existing tool handlers use `return { error: "..." }` for user-facing errors, so we'll follow that convention.

## Acceptance Criteria Checklist

- [x] `patch_board` rejects calls with unknown top-level keys (e.g., `{ activeWorkers: 0 }`, `{ foo: "bar" }`)
- [x] `patch_board` validates value types for known keys (arrays must be arrays, objects must match sub-schemas)
- [x] `readBody` in the manager MCP server has a 1MB size cap
- [x] `pnpm typecheck && pnpm build` pass with zero errors

## BUILD Task Breakdown

When this plan is approved, the following BUILD tasks should be created:

| # | BUILD Task | Scope |
|---|-----------|-------|
| 1 | S19-T1: Add body size limit to `readBody()` | Modify `readBody` in tools.ts with byte counter and rejection at 1MB |
| 2 | S19-T2: Define allowlist schema + validate `patch_board` input | Import BoardStatusSchema, create pick-schema, add safeParse validation to handler |
| 3 | S19-T3: Update tool input JSON Schema for `patch_board` | Add additionalProperties:false and updated description |
| 4 | S19-T4: Run typecheck + build verification | Execute pnpm typecheck && pnpm build, fix any errors |

Tasks 1-3 can be done in a single BUILD task since they all touch the same file. Task 4 is a verification step.

