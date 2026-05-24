# OpenCode OOM Investigation

## Symptom

OpenCode containers in run pods are repeatedly OOMKilled (exit code 137, reason OOMKilled)
with `connect ECONNREFUSED 127.0.0.1:4096` in the dispatcher, despite RSS never approaching
the pod's 8Gi memory limit.

Typical run characteristics before death:
- Duration: ~4.5 minutes
- Input tokens: ~23K
- Output tokens: ~400
- Model: remote LM Studio (not running in pod)

## Investigation

### Hypothesis 1: Pod cgroup memory limit exceeded

**Test:** Run OpenCode with full MCP config (shadcn + percussionist-dispatcher), live agent
processing, and remote model streaming under an identical 8Gi memory limit.

**Result:** Peak cgroup memory reached 660MB. RSS peaked at 417MB. Both well under 8Gi.
The pod's own `memory.events` showed `oom=0 oom_kill=0` — the cgroup limit was never
breached.

**Verdict:** ❌ Not a cgroup limit issue.

### Hypothesis 2: Memory leak in OpenCode

**Test:** Monitor RSS over time with idle OpenCode (2 minutes), with SSE connection (2 min),
with session + poll loop (2 min), and with live model processing (2 min).

**Result:** RSS flat at ~235MB idle. No growth over time. Even with 6K+ token prompts
and live model streaming, RSS stabilized at ~320MB.

**Verdict:** ❌ No memory leak.

### Hypothesis 3: Dispatcher interaction causes memory growth

**Test:** Simulate exact dispatcher interaction pattern: SSE `/event` connection, session
creation, poll loop, and prompt submission. Monitor cgroup memory throughout.

**Result:** SSE connection caused a one-time ~100MB cgroup memory jump. No further growth
from polling or session management. The dispatcher's 2-second poll loop, snapshotting,
and SSE reconnection all had negligible memory impact.

**Verdict:** ❌ Dispatcher interaction is not the cause.

### Hypothesis 4: Remote model streaming causes memory pressure

**Test:** Submit prompts to a remote LM Studio model (qwen3.6-27b-mtp) with the `builder`
agent and watch memory during streaming.

**Result:** During streaming, RSS peaked at ~417MB and cgroup at ~660MB. After streaming
completed, RSS returned to ~320MB. No anomalous growth.

**Verdict:** ❌ Model streaming has bounded, acceptable memory cost.

### Hypothesis 5: System-wide OOM killer targets OpenCode

**Test:** Examine node-level memory metrics and cgroup statistics.

**Result (node-level):**
| Metric | Value |
|---|---|
| System-wide OOM kills | 19 (cumulative) |
| Swap usage | 93% full (3.9/4.0 Gi) |
| IOWait | 25-32% (thrashing) |
| `overcommit_memory` | 1 (always overcommit) |
| `Committed_AS` | 50.6 GB |
| `CommitLimit` | 11.7 GB |
| Slab (kernel memory) | 2.9 GB |
| PageTables | 150 MB |

**Result (process-level):**
- OpenCode VmSize: **74 GB** (Bun pre-allocates huge virtual address space)
- OpenCode OOM Score: **1300** (very high)
- OpenCode oom_score_adj: **936** (explicitly made more killable)

**Verdict:** ✅ Root cause identified.

## Root Cause

OpenCode runs on **Bun**, which pre-allocates ~74GB of virtual address space (VmSize)
at startup. This is normal for Bun — it's virtual memory, not physical RAM. However:

1. The minikube node has `vm.overcommit_memory=1` (always overcommit), so the kernel
   permits this unbounded allocation.
2. `Committed_AS` (50.6 GB) far exceeds `CommitLimit` (11.7 GB) — the system is deeply
   overcommitted.
3. Swap is 93% full and IOWait is 25-32% — the system is thrashing under memory pressure.
4. When the kernel needs to reclaim memory, the OOM killer selects the process with the
   highest OOM score. OpenCode's VmSize of 74GB gives it an OOM score of 1300 — far higher
   than any other process.
5. The kernel sends SIGKILL. Kubernetes reports this as `OOMKilled` with exit code 137,
   indistinguishable from a cgroup limit OOM.

The pod's own memory cgroup (8Gi limit) is never breached — the kill comes from the
**system-wide OOM killer**, not the container-level cgroup OOM killer.

## Fix Options

### Option 1: Increase node memory (recommended)

Double minikube RAM to 24-32Gi to give the kernel breathing room:

```bash
minikube stop
minikube config set memory 24576
minikube start
```

**Pros:** Direct fix, addresses root system pressure, also benefits all other services.
**Cons:** Requires minikube restart, may not be feasible on host with limited RAM (host
has 16Gi).

### Option 2: Reduce swap pressure

Set `vm.swappiness=0` or `vm.swappiness=1` on the node to prevent the kernel from
swapping out pages when it could drop page cache instead:

```bash
minikube ssh -- "sudo sysctl -w vm.swappiness=1"
```

**Pros:** No restart needed, reduces thrashing.
**Cons:** Treats symptom, not root cause. System can still OOM under peak load.

### Option 3: Set `oom_score_adj` on OpenCode

Add `--oom-score-adj -500` or similar to the OpenCode startup to reduce its OOM score,
making it less likely to be targeted by the kernel OOM killer:

```dockerfile
# In CMD or entrypoint wrapper
echo -500 > /proc/self/oom_score_adj
exec opencode web --hostname 0.0.0.0 --port 4096
```

**Pros:** Simple, targeted fix, no restart needed.
**Cons:** Only shifts the problem — another process gets killed instead. If the killed
process is critical (kubelet, dockerd), the node becomes unstable.

### Option 4: Limit concurrent run pods

Configure project `maxParallel` to prevent too many OpenCode instances from running
simultaneously. Each instance adds 74GB of virtual address space commitment.

**Pros:** Prevents accumulation of Committed_AS.
**Cons:** Reduces throughput, may not help if a single run triggers the OOM.

### Option 5: Reduce Bun's virtual address space

Bun's large VmSize comes from pre-mapping memory for JIT compilation and garbage
collection. There is no documented way to reduce this, but setting environment
variables like `BUN_JSC_maxHeapSize` or `JSC_maxHeapSize` may help. This requires
experimentation.

**Pros:** Addresses the root mechanism (large VmSize → high OOM score).
**Cons:** Undocumented, may impact Bun's runtime performance or GC behavior.

## Evidence Summary

| Check | Finding |
|---|---|
| OpenCode RSS under load | ~320 MB |
| Peak cgroup memory | ~660 MB (well under 8Gi) |
| Pod cgroup oom events | 0 |
| OpenCode VmSize | 74 GB |
| OpenCode OOM Score | 1300 |
| System-wide OOM kills | 19 |
| Swap usage | 93% |
| Node IOWait | 25-32% |
| `Committed_AS` vs `CommitLimit` | 50.6 GB vs 11.7 GB |
