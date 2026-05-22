# 05 — API Schema Changes

## Summary

All CRD schema changes for the new phase system, retry/review policies.
No migration. Remove old fields. Deploy.

## Task CRD — Status

### New shape (replaces old)

```typescript
const TaskStatus = z.object({
  phase: TaskPhase.default("pending"),
  blocked: z.boolean().default(false),
  blockedReason: z.string().max(1024).optional(),
  retryAfter: z.string().optional(),
  lastFailureReason: z.string().max(4096).optional(),
  lastFailureDuration: z.number().optional(),
  worker: WorkerStatus.optional(),
});
```

Old `status.column` and old `status.phase` (Pending|Active|Done|Escalated) are gone.

### WorkerStatus

**Add:**
- `aiReworkCount: z.number().int().default(0)`

**Delete:**
- `facilitated`
- `facilitationRunName`
- `facilitationResult`
- `reworkAgent`
- `escalation`

**Keep:**
- `runName`, `status`, `branch`, `gitBranch`, `parentBranch`, `mergeIntoBranch`
- `prNumber`, `startedAt`, `completedAt`, `retryCount`
- `reviewRunName`, `reviewApproved`, `reviewFeedback`
- `buildTasksFacilitatorRun`, `buildTasksCreated`, `createdBuildTaskRefs`
- `mergeRunName`, `mergedAt`, `mergeError`

## Task CRD — Spec

```typescript
retryPolicy: z.object({
  enabled: z.boolean().optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  backoffSeconds: z.number().int().min(5).max(600).optional(),
}).optional()
```

## Project CRD — Spec

```typescript
retryPolicy: z.object({
  enabled: z.boolean().default(false),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  backoffSeconds: z.number().int().min(5).max(600).default(30),
  backoffMultiplier: z.number().min(1).max(5).default(2),
  maxBackoffSeconds: z.number().int().min(5).max(3600).default(300),
  poisonPillThresholdSeconds: z.number().int().min(5).max(300).default(30),
}).optional()

reviewPolicy: z.object({
  aiReviewerEnabled: z.boolean().default(false),
  aiReviewerAgent: z.string().max(63).default("reviewer"),
  maxAutoReworks: z.number().int().min(1).max(10).default(2),
}).optional()
```

## New Exports from `@percussionist/api`

```typescript
export const TaskPhase = z.enum([
  "idea", "pending", "scheduled", "initializing", "running",
  "waiting-for-input", "succeeded", "reviewing", "awaiting-human",
  "awaiting-merge", "rework-requested", "generating-builds", "done", "failed",
]);
export type TaskPhase = z.infer<typeof TaskPhase>;

export const BoardColumn = z.enum(["ideas", "backlog", "in-progress", "review", "done"]);
export type BoardColumn = z.infer<typeof BoardColumn>;

export function computeBoardColumn(phase: TaskPhase): BoardColumn {
  if (phase === "idea") return "ideas";
  if (phase === "pending") return "backlog";
  if (phase === "done") return "done";
  if (["waiting-for-input", "succeeded", "reviewing", "awaiting-human", "failed"].includes(phase))
    return "review";
  return "in-progress";
}
```

## Backfill (one-time, in reconciler)

```typescript
if (!task.status?.phase) {
  const phase = backfillPhase(task.status?.column, task.status?.worker);
  await patchTaskStatus(taskName, { phase }, ns);
}
```

Old tasks with `column` field in etcd: the CRD uses `x-kubernetes-preserve-unknown-fields`
on status subresource OR we just leave `column` as an optional field that we never write.
Simplest: keep it optional in schema, never write it. It'll sit there harmlessly on old objects.

## MCP Tools

| Tool | Change |
|------|--------|
| `set_task_state` | `targetColumn` → `targetPhase` |
| `create_run` | Sets phase to `scheduled` |
| `force_retry` | Sets phase to `scheduled` or `failed` |

## Deployment

```bash
pnpm codegen
kubectl apply -f k8s/crds/
kubectl -n percussionist rollout restart deploy/percussionist-manager
kubectl -n percussionist rollout restart deploy/percussionist-operator
```

## Files to Change

| File | Change |
|------|--------|
| `packages/api/src/index.ts` | All changes above |
| `packages/api/codegen/` | Regenerate |
| `k8s/crds/tasks.yaml` | Generated |
| `packages/kube/src/` | Update patch helpers |
| `packages/manager-controller/src/agent/tools.ts` | MCP tools use phase |
| `packages/cli/src/` | `computeBoardColumn` for display |
