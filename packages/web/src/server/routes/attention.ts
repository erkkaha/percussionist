// routes/attention.ts — global HITL "Needs attention" inbox.
//
// GET /api/attention — every Task in the namespace parked on a human decision
// (awaiting-human / waiting-for-input / failed), oldest-waiting first.
//
// Read-only aggregation over the authoritative Task CR phases: no new DB
// tables, no writes, and no extra pushes. Web Push already fires on
// transitions into these phases; this endpoint is the pull-based equivalent so
// the SPA can show what is still waiting even after a notification was
// dismissed (or fired while no tab was open).
//
// Mounted at /api/attention.

import type { RunPhase } from '@percussionist/api';
import { Hono } from 'hono';
import { auth } from '../auth.js';
import { listRuns, listTasks } from '../kube.js';
import { collectAttention } from '../lib/attention.js';

const attention = new Hono();

type KubeError = { statusCode?: number; body?: { message?: string }; message?: string };
function errMsg(e: KubeError) {
  return e.body?.message ?? e.message ?? String(e);
}

// ---------------------------------------------------------------------------
// GET /api/attention
attention.get('/', auth(), async (c) => {
  try {
    // Namespace note: listTasks()/listRuns() with no ns argument return the
    // server's default namespace (NAMESPACE, default "percussionist") only,
    // matching the Web Push poller (lib/push-triggers.ts). Projects in other
    // namespaces are invisible in v1 — the same gap push already has. Fanning
    // out over every project namespace (N+1) is deliberately out of scope.
    const [tasks, runs] = await Promise.all([listTasks(), listRuns()]);

    // Board parity: a run can be WaitingForInput while the Task phase is still
    // running during reconciler lag. Pass the run phases so collectAttention
    // promotes those tasks instead of dropping them until the next reconcile.
    const runPhaseByRun = new Map<string, RunPhase>();
    for (const run of runs) {
      if (run.metadata.name && run.status?.phase) {
        runPhaseByRun.set(run.metadata.name, run.status.phase);
      }
    }

    const items = collectAttention(tasks, runPhaseByRun);
    return c.json({ items, count: items.length, generatedAt: new Date().toISOString() });
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, 500);
  }
});

export default attention;
