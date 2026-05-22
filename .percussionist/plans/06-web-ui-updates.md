# 06 — Web UI Updates

## Summary

Board renders computed columns from phase. Phase badges on cards. Action buttons
for human decisions. Ideas column. Agent picker on retry/rework.

## Board Layout

```
| Ideas | Backlog | In Progress | Review | Done |
```

### Column Derivation (client-side)

```typescript
import { computeBoardColumn } from "@percussionist/api";
const columns = groupBy(tasks, t => computeBoardColumn(t.status.phase));
```

No stored field. Computed at render time.

## Task Card

```
┌─────────────────────────────────┐
│ [PLAN] Fix authentication flow  │
│ ● running          agent: planner│
│ Attempt 2/3                     │
│ 3m 42s elapsed                  │
│ [blocked: waiting for auth-api] │
└─────────────────────────────────┘
```

### Phase Badge Colors

| Phase | Color | Icon |
|-------|-------|------|
| `idea` | gray | lightbulb |
| `pending` | slate | circle |
| `scheduled` | blue | clock |
| `initializing` | blue | spinner |
| `running` | green | play |
| `waiting-for-input` | amber | question |
| `succeeded` | emerald | check |
| `reviewing` | purple | eye |
| `awaiting-human` | amber | hand |
| `awaiting-merge` | blue | git-merge |
| `rework-requested` | orange | rotate |
| `generating-builds` | blue | split |
| `failed` | red | x-circle |
| `done` | gray | check-circle |

### Blocked

Dashed border + muted overlay with `blockedReason`. Stays in computed column.

## Actions (Review Column)

### Failed

```
[Retry ▾] [Rework] [Abandon]
[View Logs] [View Session]
```

Retry dropdown: default agent or pick different one.

### Awaiting Human

```
[Approve] [Request Changes]
[View Diff] [View Session]
```

Shows AI reviewer feedback if available. Shows "(AI rework ceiling reached)" if applicable.

### Waiting-for-Input (PLAN)

```
"Should we use OAuth2 or SAML?"
[Answer...] [Skip]
```

## Ideas Column

- Compact cards (title only)
- "Promote to backlog" button (opens agent assignment)
- Quick-add at top ("+ Add idea")
- No drag-and-drop (just buttons)

## API

### Task action endpoint

```
POST /api/tasks/:name/action
{
  action: "retry" | "rework" | "approve" | "abandon" | "answer" | "promote",
  feedback?: string,
  agent?: string,
}
```

Backend patches `status.phase` directly. For `answer`: also writes annotation.

## Files to Change

| File | Change |
|------|--------|
| `packages/web/src/client/` | Board: group by `computeBoardColumn(phase)` |
| `packages/web/src/client/` | Task card: phase badges, action buttons |
| `packages/web/src/client/` | Ideas column + promote flow |
| `packages/web/src/client/` | Agent picker on retry/rework |
| `packages/web/src/server/` | `POST /api/tasks/:name/action` |
| `packages/web/src/server/schema.ts` | taskEvents: phase transitions |
| `packages/cli/src/` | Board display via `computeBoardColumn` |

## Dependencies

- Plans 01 + 05 first (phases must exist)
- Build incrementally: board rendering → actions → ideas
