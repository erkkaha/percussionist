import { randomBytes } from 'node:crypto';
import {
  API_GROUP_VERSION,
  KIND_RUN,
  type Run,
  RunSpecSchema,
  type Task,
  TERMINAL_PHASES,
} from '@percussionist/api';
import { Hono } from 'hono';
import { adminAuth, auth } from '../auth.js';
import {
  createRun,
  createRunnerSession,
  deleteRun,
  getRun,
  getTask,
  interruptRunnerSession,
  listRunnerSessions,
  listRuns,
  listTasks,
  NAMESPACE,
  postSessionMessage,
} from '../kube.js';
import { isKubeNotFound, kubeStatusCode } from '../lib/kube-errors.js';
import { createPollingSseResponse } from '../lib/sse.js';

const runs = new Hono();

// Deterministic projection of the Task a run is linked to via spec.boardTask.
// Enough for the client to render a purpose line without a second request.
type RelatedTask = {
  name: string;
  title?: string;
  type: Task['spec']['type'];
  phase?: string;
};

function toRelatedTask(task: Task): RelatedTask {
  return {
    name: task.metadata.name,
    title: task.spec.title,
    type: task.spec.type,
    phase: task.status?.phase,
  };
}

// Bounded, whitespace-collapsed preview of the worker prompt. The full
// spec.task (up to 8 KB) stays out of the list response.
const TASK_PREVIEW_MAX = 200;

function taskPreview(task: string | undefined): string | undefined {
  if (!task) return undefined;
  for (const line of task.split('\n')) {
    const collapsed = line.replace(/\s+/g, ' ').trim();
    if (collapsed) return collapsed.slice(0, TASK_PREVIEW_MAX);
  }
  return undefined;
}

// Resolve boardTask → Task for a page of runs with at most one listTasks()
// call. Short-circuits when no run carries a boardTask. A lookup failure is
// non-fatal: the list degrades to no relatedTask (logged once).
async function buildRelatedTaskMap(items: Run[]): Promise<Map<string, RelatedTask>> {
  const map = new Map<string, RelatedTask>();
  const names = new Set<string>();
  for (const run of items) {
    if (run.spec.boardTask) names.add(run.spec.boardTask);
  }
  if (names.size === 0) return map;

  try {
    const tasks = await listTasks();
    for (const task of tasks) {
      if (!names.has(task.metadata.name)) continue;
      map.set(task.metadata.name, toRelatedTask(task));
    }
  } catch (e: unknown) {
    console.error('run list task enrichment failed:', (e as Error).message);
  }
  return map;
}

// Detail counterpart of buildRelatedTaskMap: a single getTask lookup, omitted
// on 404/error so a missing Task never fails the run request.
async function resolveRelatedTask(run: Run): Promise<RelatedTask | undefined> {
  const taskName = run.spec.boardTask;
  if (!taskName) return undefined;
  try {
    const task = await getTask(taskName, run.metadata.namespace ?? NAMESPACE);
    return toRelatedTask(task);
  } catch {
    return undefined;
  }
}

// GET /api/runs — list Runs in the namespace with optional pagination.
// Supported query params: ?task=, ?limit=, ?offset=
// Strips large spec/status fields from the response (UI only needs a subset).
// When limit is omitted, returns all runs (backward compatible).
runs.get('/', auth(), async (c) => {
  try {
    const taskFilter = c.req.query('task');
    const limitStr = c.req.query('limit');
    const offsetStr = c.req.query('offset');

    let items = await listRuns();
    if (taskFilter) {
      items = items.filter((r) => r.spec.boardTask === taskFilter);
    }

    items.sort((a, b) => {
      const aTime = a.metadata.creationTimestamp ?? '';
      const bTime = b.metadata.creationTimestamp ?? '';
      return bTime.localeCompare(aTime);
    });

    const total = items.length;
    const limit = limitStr ? Math.max(1, Math.min(200, parseInt(limitStr, 10) || 50)) : 0;
    const offset = offsetStr ? Math.max(0, parseInt(offsetStr, 10) || 0) : 0;

    if (limit > 0) {
      items = items.slice(offset, offset + limit);
    }

    // One Task lookup for the whole page. Runs without a boardTask add nothing
    // to the map, and an enrichment failure degrades to no relatedTask.
    const relatedTasks = await buildRelatedTaskMap(items);

    // Lightweight response — UI only needs these fields. serviceName and the
    // full spec.task stay server-side; taskPreview carries the first line.
    const stripped = items.map((r) => {
      const relatedTask = r.spec.boardTask ? relatedTasks.get(r.spec.boardTask) : undefined;
      return {
        metadata: {
          name: r.metadata.name,
          uid: r.metadata.uid,
          namespace: r.metadata.namespace,
          creationTimestamp: r.metadata.creationTimestamp,
        },
        spec: {
          project: r.spec.project,
          boardTask: r.spec.boardTask,
          interactive: r.spec.interactive,
          runContext: r.spec.runContext,
          agent: r.spec.agent,
          model: r.spec.model,
          taskPreview: taskPreview(r.spec.task),
        },
        status: r.status
          ? {
              phase: r.status.phase,
              message: r.status.message,
              sessionID: r.status.sessionID,
              tokensIn: r.status.tokensIn,
              tokensOut: r.status.tokensOut,
              startedAt: r.status.startedAt,
              completedAt: r.status.completedAt,
              lastEventAt: r.status.lastEventAt,
              podName: r.status.podName,
            }
          : undefined,
        ...(relatedTask ? { relatedTask } : {}),
      };
    });

    return c.json({ items: stripped, total });
  } catch (e: unknown) {
    const msg = (e as { body?: { message?: string } })?.body?.message ?? String(e);
    return c.json({ error: msg }, 500);
  }
});

// GET /api/runs/events — SSE stream for run list changes.
runs.get('/events', auth(), async (c) => {
  return createPollingSseResponse({
    signal: c.req.raw.signal,
    getSignature: async () =>
      JSON.stringify(
        (await listRuns()).map((r) => ({
          resourceVersion: r.metadata.resourceVersion,
          generation: r.metadata.generation,
          name: r.metadata.name,
          namespace: r.metadata.namespace,
          phase: r.status?.phase,
          completedAt: r.status?.completedAt,
          startedAt: r.status?.startedAt,
          sessionID: r.status?.sessionID,
          tokensIn: r.status?.tokensIn,
          tokensOut: r.status?.tokensOut,
          lastEventAt: r.status?.lastEventAt,
          message: r.status?.message,
        })),
      ),
    updatedEvent: 'runs.updated',
    errorEvent: 'runs.error',
    readyEvent: { event: 'ready', data: { collection: 'runs' } },
  });
});

// GET /api/runs/:name — get a single Run by name.
runs.get('/:name', auth(), async (c) => {
  const name = c.req.param('name');
  try {
    const run = await getRun(name);
    // Enrich with the linked Task when it still exists. A missing/erroring Task
    // is non-fatal — the raw run is returned either way.
    const relatedTask = await resolveRelatedTask(run);
    return c.json(relatedTask ? { ...run, relatedTask } : run);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = isKubeNotFound(e) ? 404 : 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status);
  }
});

// POST /api/runs — create a new Run.
runs.post('/', adminAuth(), async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Validate spec fields.
  const parsed = RunSpecSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
  }
  const spec = parsed.data;

  // Auto-generate a name with crypto-random suffix to avoid collisions under concurrent submits.
  const name = (body as { name?: string }).name ?? `run-${randomBytes(5).toString('hex')}`;

  const run = {
    apiVersion: API_GROUP_VERSION,
    kind: KIND_RUN,
    metadata: {
      name,
      labels: { 'percussionist.dev/project': spec.project },
    },
    spec,
  };

  try {
    const created = await createRun(run as Parameters<typeof createRun>[0]);
    return c.json(created, 201);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = kubeStatusCode(e) ?? 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status as 400 | 409 | 500);
  }
});

// DELETE /api/runs/:name — delete (cancel) a run and all its child resources.
runs.delete('/:name', adminAuth(), async (c) => {
  const name = c.req.param('name');
  try {
    await deleteRun(name);
    return c.body(null, 204);
  } catch (e: unknown) {
    const anyE = e as { statusCode?: number; body?: { message?: string }; message?: string };
    const status = isKubeNotFound(e) ? 404 : 500;
    const msg = anyE.body?.message ?? anyE.message ?? String(e);
    return c.json({ error: msg }, status);
  }
});

// POST /api/runs/:name/reply — human answers a worker's pending question.
runs.post('/:name/reply', adminAuth(), async (c) => {
  const runName = c.req.param('name');

  let run: import('@percussionist/api').Run;
  try {
    run = await getRun(runName);
  } catch {
    return c.json({ error: 'Run not found' }, 404);
  }

  const serviceName = run.status?.serviceName;
  if (!serviceName || !run.status?.sessionID) {
    return c.json({ error: 'No active session for this run' }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const textBody = body as { message?: string };
  if (!textBody?.message || typeof textBody.message !== 'string') {
    return c.json({ error: "Missing 'message' field (human reply text)" }, 400);
  }

  try {
    // Route the turn the way the dispatcher routes the first prompt: on the
    // run's model and agent, not the runner's config default.
    await postSessionMessage(serviceName, run.status.sessionID, textBody.message, {
      model: run.spec.model,
      agent: run.spec.agent,
    });
    return c.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    console.error('reply failed:', msg);
    return c.json({ error: `Failed to forward reply: ${msg}` }, 502);
  }
});

// POST /api/runs/:name/session — start the session of an interactive run.
//
// Prompt-mode runs get their session from the dispatcher; an interactive run
// (`spec.interactive`) waits for someone to create one, which used to mean the
// in-pod TUI. The dispatcher's discovery loop adopts the new session within a
// few seconds and publishes `status.sessionID`; the client polls the run for
// that rather than this route patching status it does not own.
runs.post('/:name/session', adminAuth(), async (c) => {
  const runName = c.req.param('name');

  let run: import('@percussionist/api').Run;
  try {
    run = await getRun(runName);
  } catch {
    return c.json({ error: 'Run not found' }, 404);
  }

  const phase = run.status?.phase;
  if (phase && TERMINAL_PHASES.has(phase)) {
    return c.json({ error: `Run is ${phase}; nothing to start a session on` }, 400);
  }
  if (!run.spec.interactive) {
    return c.json({ error: 'Not an interactive run; the dispatcher creates its session' }, 400);
  }
  if (run.status?.sessionID) {
    return c.json({ error: 'Run already has a session', sessionID: run.status.sessionID }, 409);
  }
  const serviceName = run.status?.serviceName;
  if (!serviceName || run.status?.podPhase !== 'Running') {
    return c.json({ error: 'Runner is not up yet; try again shortly' }, 400);
  }

  try {
    // `status.sessionID` lags the runner by one dispatcher discovery tick
    // (~3 s), so a second click in that window would create a second session
    // the dispatcher never adopts. Ask the runner first and hand back what is
    // already there.
    const existing = (await listRunnerSessions(serviceName))[0];
    if (existing) {
      return c.json({ sessionID: existing.id, existing: true });
    }
    const session = await createRunnerSession(serviceName, `run/${runName}`, run.spec.agent);
    return c.json({ sessionID: session.id }, 201);
  } catch (e) {
    const msg = (e as Error).message;
    console.error('start session failed:', msg);
    return c.json({ error: `Failed to start session: ${msg}` }, 502);
  }
});

// POST /api/runs/:name/interrupt — stop the agent's current turn. The session
// stays open; the next message continues the conversation.
runs.post('/:name/interrupt', adminAuth(), async (c) => {
  const runName = c.req.param('name');

  let run: import('@percussionist/api').Run;
  try {
    run = await getRun(runName);
  } catch {
    return c.json({ error: 'Run not found' }, 404);
  }

  const serviceName = run.status?.serviceName;
  if (!serviceName || !run.status?.sessionID) {
    return c.json({ error: 'No active session for this run' }, 400);
  }

  try {
    await interruptRunnerSession(serviceName, run.status.sessionID);
    return c.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    console.error('interrupt failed:', msg);
    return c.json({ error: `Failed to interrupt: ${msg}` }, 502);
  }
});

export default runs;
