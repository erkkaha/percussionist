# Plan: Add volume information to Metrics page

## Context

The Metrics page currently visualizes CPU and memory only:

- **Backend API**: `packages/web/src/server/routes/metrics.ts`
  - `GET /api/metrics/nodes` returns node usage/capacity/allocatable/allocated for CPU+memory.
  - `GET /api/metrics/pods` returns pod/container usage and request/limit for CPU+memory.
- **K8s data access**: `packages/kube/src/index.ts`
  - `listNodeMetrics()` and `listPodMetrics()` read `metrics.k8s.io` usage data.
  - `listNodeHostStats()` (kubelet `/stats/summary`) currently exposes only `hostMemoryBytes` + `hostCpuNanoCores` via `NodeHostStats`.
  - `listPodResources()` currently extracts only CPU+memory requests/limits from pod specs.
- **Client mapping**: `packages/web/src/client/hooks/useMetrics.ts`
  - `NodeMetricRow` and `PodMetricRow` model only CPU+memory aggregates.
- **UI**: `packages/web/src/client/components/MetricsView.tsx`
  - Node cards show CPU + Memory usage bars and request bars.
  - Pod table shows CPU and memory columns only.
- **History path** (`metrics-collector`, `metric_snapshots`, `/api/stats/metrics-timeseries`) stores CPU/memory percentages only.

So the end-to-end contract does not yet include any storage/volume fields.

## Scope boundaries

### In scope

- Add **live volume/storage visibility** to Metrics page data and UI.
- Extend API contracts and client types so volume metrics are first-class (not ad-hoc UI-only values).
- Keep behavior backward-compatible when volume data is unavailable (graceful null/zero display).

### Out of scope

- Full storage observability suite (PV/PVC inventory page, StorageClass analytics, per-volume IOPS/latency).
- Reworking Stats history schema unless explicitly required (CPU/memory history can remain unchanged initially).
- Cluster-wide RBAC redesign beyond minimal permissions needed for chosen data source.

## Assumptions

1. “Volume information” means **storage usage/capacity (disk/volume)** on the Metrics page, not token/call volume metrics in Stats.
2. Initial implementation should prioritize **node-level disk usage** and a practical **pod-level storage signal** over exhaustive per-volume deep inspection.
3. Existing kubelet summary access (`nodes/proxy`) is acceptable as the primary source where metrics-server does not provide storage usage directly.

## Approach

1. **Define explicit volume data contract first**
   - Add optional volume fields to node and pod metric payloads so backend and frontend stay type-aligned.
   - Keep fields nullable/optional to avoid breaking clusters where volume fields are missing in kubelet summary.

2. **Source node volume usage from kubelet summary**
   - Extend `NodeHostStats` in `packages/kube/src/index.ts` to include node filesystem totals from `/stats/summary` (`node.fs.*`).
   - Reuse existing `listNodeHostStats()` call path in `GET /api/metrics/nodes` to attach volume usage/capacity/available in node response.

3. **Add pod-level volume signal with bounded complexity**
   - Extend pod resource extraction to include `ephemeral-storage` request/limit from container resources (same place CPU/memory is parsed now).
   - Optionally include per-pod PVC requested bytes if required by UX (requires reading PVC objects and summing claim requests); otherwise ship with ephemeral-storage first.

4. **Render volume in UI using existing visual patterns**
   - Node cards: add a “Volume” usage bar (`used / total`) with percentage color thresholds mirroring CPU/memory bars.
   - Pod table: add a storage column (e.g., `Storage (use/req/limit)` or `Ephemeral (req/limit)` depending on available backend signal).
   - Ensure formatting helpers support larger storage units (`TiB`) where relevant.

5. **Preserve compatibility and failure behavior**
   - If volume fields are unavailable for a node/pod, display `-` and keep page functional.
   - Do not regress current metrics-server unavailability handling (`503 metrics-server not available`).

## Acceptance criteria

1. `GET /api/metrics/nodes` includes volume-related fields per node (usage and capacity; available optional) when data exists.
2. `useMetrics` maps these fields into `NodeMetricRow`/`PodMetricRow` typed data without `any` casts.
3. Metrics Live tab displays volume information:
   - Node cards show volume usage.
   - Pod table shows at least one storage/volume indicator column.
4. UI handles missing volume values gracefully (no runtime errors, no NaN percentages).
5. Auth coverage remains intact for metrics endpoints (`packages/web/tests/auth.test.ts` still passes and is updated if new endpoint behavior needs assertions).
6. Typecheck/build/test commands relevant to touched packages pass.

## Tasks

1. **Confirm product interpretation of “volume information”**
   - Decide whether pod-level requirement is:
     - ephemeral-storage requests/limits, or
     - PVC requested capacity, or
     - both.
   - Record decision in task notes to avoid ambiguous implementation.

2. **Extend kube metrics types for storage**
   - File: `packages/kube/src/index.ts`
   - Update `NodeHostStats` with filesystem fields (e.g., `hostFsUsedBytes`, `hostFsCapacityBytes`, `hostFsAvailableBytes`).
   - Update kubelet summary parsing in `listNodeHostStats()` to populate the new fields defensively.

3. **Add storage parsing helpers for resource quantities**
   - File: `packages/kube/src/index.ts`
   - Generalize/extend memory parsing utilities so `ephemeral-storage` resource quantities can be normalized reliably.
   - Avoid duplicating conversion logic between server and client.

4. **Extend pod resource extraction with storage requests/limits**
   - File: `packages/kube/src/index.ts`
   - Add `ephemeral-storage` request/limit extraction at container and pod aggregate levels in `listPodResources()`.
   - Update `ContainerResources` / `PodResourceSpec` types accordingly.

5. **Expose node volume fields in metrics API response**
   - File: `packages/web/src/server/routes/metrics.ts`
   - In `/nodes`, merge new `NodeHostStats` filesystem values into returned node objects.
   - Keep null fallbacks when kubelet data is absent.

6. **Expose pod storage fields in metrics API response**
   - File: `packages/web/src/server/routes/metrics.ts`
   - In `/pods`, include storage request/limit aggregates in each item.
   - If scope includes PVC totals, add retrieval + mapping and handle RBAC/absent-claim cases.

7. **Update client metrics hook contracts**
   - File: `packages/web/src/client/hooks/useMetrics.ts`
   - Extend `NodeMetricRow`, `PodMetricRow`, and response parsing to include volume/storage numeric fields.
   - Add conversion helpers if needed for storage quantities not currently handled by `parseMemory`.

8. **Render volume info in MetricsView**
   - File: `packages/web/src/client/components/MetricsView.tsx`
   - NodeCard: add “Volume” bar and textual value.
   - PodTable: add storage column(s) and compact formatter.
   - Ensure sort order and layout remain readable at narrow widths.

9. **RBAC and manifest check (only if new API access is required)**
   - File: `k8s/deploy/web.yaml`
   - If PVC reads are added, include minimal verbs/resources (`persistentvolumeclaims` get/list) for web ServiceAccount.
   - Keep least-privilege scope.

10. **Tests and verification pass**
   - Update/add web tests where deterministic (route shape/auth regression).
   - Run: `pnpm typecheck`, `pnpm build`, and relevant `pnpm test` subset for `packages/web`.
   - Manually verify Metrics page with and without available volume data.

## Risks / open questions

1. **Data source variability**
   - Kubelet `/stats/summary` shape can vary by Kubernetes/runtime versions; missing fs fields must not break API.

2. **Meaning of “volume” at pod level**
   - Usage bytes per mounted PVC may require deeper kubelet pod-volume traversal and non-trivial joins; this can inflate scope.

3. **Unit parsing edge cases**
   - Storage quantities can include `Ki/Mi/Gi/Ti` (and decimal variants in some clusters). Parsing must be consistent to avoid incorrect percentages.

4. **UI density risk**
   - Adding another metric row + pod column may overcrowd current layout; may require responsive simplification.

5. **History tab expectation**
   - If stakeholders expect volume history in the chart, schema/API updates (`metric_snapshots`, collector, `/metrics-timeseries`, chart) become a separate extension task.

## Proposed BUILD task breakdown

1. **BUILD 1 — Backend data contract + node volume metrics**
   - Extend kube types/parsing + `/api/metrics/nodes` response with volume fields.
   - Ensure safe fallbacks and no regressions in existing node metrics behavior.

2. **BUILD 2 — Pod storage signal + API/client wiring**
   - Add pod storage aggregates (ephemeral and/or PVC per final decision) through `listPodResources` → `/api/metrics/pods` → `useMetrics` types.

3. **BUILD 3 — Metrics UI rendering + verification**
   - Add node volume bar and pod storage column(s) in `MetricsView.tsx`.
   - Complete tests, typecheck/build, and manual QA notes.
