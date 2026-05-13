# Agent Management UI — Implementation Plan

## Goal
Add full ClusterAgent CRUD management to the web UI: dedicated Agents page with list/create/edit/delete, sidebar navigation, and inline agent display on RunDetail.

## Files to Create/Modify

### 1. `packages/web/src/server/kube.ts` (modify)
**After existing `listClusterAgents()` function**, add these helpers following the project pattern:
```ts
export async function getClusterAgent(name: string): Promise<ClusterAgent> { ... }
export async function createClusterAgent(agent: ClusterAgent): Promise<ClusterAgent> { ... }
export async function updateClusterAgent(name: string, spec: ClusterAgent["spec"]): Promise<ClusterAgent> { ... }
export async function deleteClusterAgent(name: string): Promise<void> { ... }
```

### 2. `packages/web/src/server/routes/agents.ts` (modify)
**Replace current single GET endpoint** with full CRUD following the projects.ts pattern:
- `GET /api/agents` — list all (existing, keep as-is)
- `GET /api/agents/:name` — get single agent by name
- `POST /api/agents` — create ClusterAgent (body: `{ name?, content }`)
  - Auto-generate name if absent: `agent-${Date.now().toString(16)}`
  - Validate with `ClusterAgentSpecSchema.safeParse(body)`
  - Build full CRD object with apiVersion/kind/metadata/spec
- `PUT /api/agents/:name` — update ClusterAgent spec.content
  - Parse body, validate, call `updateClusterAgent(name, parsed.data)`
- `DELETE /api/agents/:name` — delete ClusterAgent

### 3. `packages/web/src/client/lib/types.ts` (modify)
**Add after AgentDef interface:**
```ts
export interface ClusterAgent {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; uid?: string; creationTimestamp?: string };
  spec: { content: string };
}

export interface CreateAgentRequest {
  name?: string;
  content: string;
}
```

### 4. `packages/web/src/client/lib/api.ts` (modify)
**Add after existing fetchProjects/deleteProject functions:**
```ts
// Agents
export async function fetchAgents(): Promise<ClusterAgent[]> { ... }
export async function fetchAgent(name: string): Promise<ClusterAgent> { ... }
export async function submitAgent(req: CreateAgentRequest): Promise<ClusterAgent> { ... }
export async function updateAgent(name: string, req: CreateAgentRequest): Promise<ClusterAgent> { ... }
export async function deleteAgent(name: string): Promise<void> { ... }
```

### 5. `packages/web/src/client/hooks/useAgents.ts` (new file)
**Same pattern as useProjects:**
```ts
import { useQuery } from "@tanstack/react-query";
import { fetchAgents } from "../lib/api";
import type { ClusterAgent } from "../lib/types";

export function useAgents(refetchInterval = 10_000) {
  return useQuery<ClusterAgent[], Error>({
    queryKey: ["agents"],
    queryFn: fetchAgents,
    refetchInterval,
  });
}
```

### 6. `packages/web/src/client/components/AgentsPage.tsx` (new file)
**List table following ProjectsPage pattern:**
- Header with title "Agents" + subtitle "Cluster-scoped reusable agent definitions."
- "+ New Agent" button → `/agents/new`
- Table columns: Name, Description (extracted from frontmatter), Content preview (truncated to ~80 chars), Age
- Each row has Edit and Delete buttons
- Empty state when no agents exist
- Loading skeleton matching ProjectsPage style

**Helper function for description extraction:**
```ts
function extractDescription(content: string): string {
  const match = content.match(/^---\ndescription:\s*(.+?)\n---/);
  return match?.[1]?.trim() ?? "-";
}
```

### 7. `packages/web/src/client/components/AgentForm.tsx` (new file)
**Reusable form for create/edit:**
- Props: `initialName?`, `initialContent?`, `onSubmit(name, content)`, `isSubmitting?`
- Name input (monospace, k8s-compatible validation hint)
- Content textarea with KB counter in footer
- Submit button + Cancel link back to `/agents`
- Uses react-query mutation for submit/update/delete

### 8. `packages/web/src/client/App.tsx` (modify)
**Add routes:**
```tsx
import AgentsPage from "./components/AgentsPage";
import AgentForm from "./components/AgentForm";

// Inside Routes:
<Route path="/agents" element={<AgentsPage />} />
<Route path="/agents/new" element={<AgentForm />} />
<Route path="/agents/:name/edit" element={<AgentForm />} />
```

### 9. `packages/web/src/client/components/Layout.tsx` (modify)
**Add sidebar link:**
```tsx
<SidebarLink to="/agents">Agents</SidebarLink>
```
Place between Projects and Stats links.

### 10. `packages/web/src/client/components/RunDetail.tsx` (modify)
**In the Spec card, after Agent field**, add inline agents display:
```tsx
{run.spec.agents && run.spec.agents.length > 0 && (
  <div className="flex items-baseline gap-3 text-sm">
    <span className="text-text-dim w-36 shrink-0">Inline Agents</span>
    <div className="flex flex-wrap gap-1.5">
      {run.spec.agents.map((a, i) => (
        <span key={i} className="inline-flex items-center rounded bg-surface-overlay px-2 py-0.5 text-xs font-mono text-text-muted">
          {a.name}
        </span>
      ))}
    </div>
  </div>
)}
```

## Build & Deploy
After all changes:
1. `eval "$(minikube docker-env)"`
2. `docker build -t percussionist/web:dev -f images/web/Dockerfile .`
3. `kubectl rollout restart deployment percussionist-web -n percussionist`
