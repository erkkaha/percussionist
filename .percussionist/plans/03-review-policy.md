# 03 — Review Policy

## Summary

Make AI reviewer opt-in per project. Add a ceiling on AI-initiated reworks.
`waiting-for-input` is PLAN-only. Staleness detection for reviewing phase.

## Current Behavior

- AI reviewer runs if agent config exists (implicit enablement)
- AI reviewer can `request_changes` indefinitely
- AI reviewer can `retry_alternative` (try different agent)
- `waiting-for-input` handled for all task types

## Target Behavior

### AI Reviewer: Opt-in With Ceiling

```yaml
spec:
  reviewPolicy:
    aiReviewerEnabled: false    # default
    aiReviewerAgent: "reviewer"
    maxAutoReworks: 2           # max AI-initiated reworks before escalating to human
```

Flow:
```
succeeded → reviewing (AI evaluating)
  → AI approves → awaiting-human
  → AI request_changes (count < ceiling) → rework-requested
  → AI request_changes (count >= ceiling) → awaiting-human (with AI feedback shown)
```

If `aiReviewerAgent` doesn't exist in project agent roster: skip AI review with
warning log, go straight to `awaiting-human`.

### Staleness on Reviewing Phase

Same 5min timeout as worker runs. If review run hangs:
- Delete review run
- Move to `awaiting-human` (skip AI, let human decide)

### AI Rework Count

`status.worker.aiReworkCount: number` (default 0):
- Incremented on AI `request_changes`
- Reset to 0 on human rework (human decision = fresh count)
- Reset to 0 on human approve
- Persists on WorkerStatus across rework cycles

### `retry_alternative` — Removed

AI can't trigger agent changes. If it thinks the agent is wrong, it says so in
feedback. Human picks a different agent via the UI agent picker.

### Waiting-for-Input: PLAN Only

BUILD tasks cannot enter `waiting-for-input`. If stuck, they fail.

PLAN tasks can:
- Maps to **review** column
- Human answers via UI (`POST /api/tasks/:name/action { action: "answer", feedback: "..." }`)
- Answer written as task annotation
- Dispatcher in run pod polls for annotation, injects into agent session
- Run transitions Running → handler moves phase back to `running`

## Schema Changes

```typescript
// Project spec
reviewPolicy: z.object({
  aiReviewerEnabled: z.boolean().default(false),
  aiReviewerAgent: z.string().max(63).default("reviewer"),
  maxAutoReworks: z.number().int().min(1).max(10).default(2),
}).optional()

// WorkerStatus
aiReworkCount: z.number().int().default(0)
```

## Files to Change

| File | Change |
|------|--------|
| `packages/api/src/index.ts` | Add `reviewPolicy`, `aiReworkCount` |
| `packages/manager-controller/src/reconciler/handlers/reviewing.ts` | Staleness, ceiling |
| `packages/manager-controller/src/reconciler/handlers/succeeded.ts` | Check aiReviewerEnabled |
| `packages/manager-controller/src/reconciler/handlers/waiting-for-input.ts` | PLAN-only enforcement |
| `packages/manager-controller/src/facilitator.ts` | Remove `retry_alternative` |
| `packages/manager-controller/src/agent/decision-engine.ts` | Remove `retry_alternative` case |
| `packages/web/` | Show AI feedback when ceiling hit |
