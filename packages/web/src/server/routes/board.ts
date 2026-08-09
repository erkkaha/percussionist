// routes/board.ts — board endpoints nested under projects.
//
// Tasks are now first-class Task CRs — state lives in K8s, not SQLite.
//
// Mounted at /api/projects (so :project param is accessible).
//
// GET    /api/projects/:project/board                         — board settings + task list grouped by column
// PATCH  /api/projects/:project/board/spec                    — patch project settings (maxParallel, agents, phase)
// POST   /api/projects/:project/board/tasks                   — create a new Task CR
// DELETE /api/projects/:project/board/tasks/:taskName         — delete an Task CR
// POST   /api/projects/:project/board/tasks/:taskName/approve — set approved annotation
// POST   /api/projects/:project/board/tasks/:taskName/request-changes

import { randomBytes } from 'node:crypto';
import {
  buildRepoWebUrl,
  computeBoardColumn,
  type RunPhase,
  type Task,
  type TaskPhase,
  type TaskSpec,
  TaskStatusSchema,
} from '@percussionist/api';
import { validateModelAuth } from '@percussionist/kube';
import { Hono } from 'hono';
import { adminAuth, auth, scoped } from '../auth.js';
import { getDb, taskEvents } from '../db.js';

import {
  buildTask,
  createTask,
  deleteTask,
  getProject,
  getTask,
  listRuns,
  listTasks,
  NAMESPACE,
  patchProjectSpec,
  patchTask,
  patchTaskStatus,
  validateAgentTaskCapability,
} from '../kube.js';
import { resolveIntegrationMode } from '../lib/integration-mode.js';
import { isKubeNotFound } from '../lib/kube-errors.js';
import { createPollingSseResponse } from '../lib/sse.js';

const board = new Hono();

type KubeError = { statusCode?: number; body?: { message?: string }; message?: string };
function errStatus(e: KubeError) {
  return isKubeNotFound(e) ? 404 : 500;
}
function errMsg(e: KubeError) {
  return e.body?.message ?? e.message ?? String(e);
}

// ---------------------------------------------------------------------------
// Helpers

function taskCRName(project: string, type: 'PLAN' | 'BUILD'): string {
  const suffix = randomBytes(3).toString('hex');
  return `${project}-${type.toLowerCase()}-${suffix}`;
}

function taskShortId(taskName: string): string {
  const parts = taskName.split('-');
  return parts[parts.length - 1] || taskName;
}

function resolveTaskDisplayLabel(
  taskName: string | undefined,
  tasksByName: Map<string, Task>,
  titleCounts: Map<string, number>,
): string | null {
  if (!taskName) return null;
  const task = tasksByName.get(taskName);
  if (!task) return taskName;
  const title = task.spec.title?.trim();
  if (!title) return taskName;
  if ((titleCounts.get(title) ?? 0) > 1) {
    return `${title} (${taskShortId(taskName)})`;
  }
  return title;
}

export async function appendTaskEvent(
  project: string,
  taskName: string,
  taskType: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    const db = getDb();
    db.insert(taskEvents)
      .values({
        project,
        taskName,
        taskType,
        eventType,
        payload: JSON.stringify(payload),
        createdAt: new Date().toISOString(),
      })
      .run();
  } catch {
    // Event logging is best-effort — never fail the main operation.
  }
}

/**
 * Resolve a Task CR scoped to its project's namespace, verifying it actually
 * belongs to the project.
 *
 * Task action routes (approve, request-changes, retry-review, answer, ...)
 * previously called getTask(taskName) with the default namespace and never
 * verified task.spec.projectRef. That broke tasks in non-default namespaces
 * (the default-ns lookup 404s) and — worse — when a task with the same name
 * existed in the default namespace, the annotation was patched on the wrong
 * task and appendTaskEvent recorded the event under the URL project,
 * corrupting the activity feed.
 *
 * Resolves the namespace from the project (project.metadata.namespace ??
 * NAMESPACE, same as the delete/move routes) and cross-checks both
 * task.spec.projectRef (required by TaskSpecSchema, authoritative) and the
 * percussionist.dev/project label before any patch/annotation/event write.
 * Throws a 404-shaped error (mapped by the route's existing errStatus/errMsg
 * handling) when the task doesn't belong to the project.
 */
async function getProjectTask(
  projectName: string,
  taskName: string,
): Promise<{ task: Task; ns: string }> {
  const project = await getProject(projectName);
  const ns = project.metadata.namespace ?? NAMESPACE;
  const task = await getTask(taskName, ns);
  const projectRef = task.spec.projectRef;
  const labelProject = task.metadata.labels?.['percussionist.dev/project'];
  if (projectRef !== projectName || (labelProject !== undefined && labelProject !== projectName)) {
    throw Object.assign(new Error('Task not found in project'), { statusCode: 404 });
  }
  return { task, ns };
}

// ---------------------------------------------------------------------------
// GET /api/projects/:project/board
board.get('/:project/board', auth(), async (c) => {
  const name = c.req.param('project');
  try {
    const [project, tasks] = await Promise.all([getProject(name), listTasks(name)]);
    const ns = project.metadata.namespace ?? NAMESPACE;
    // Build a name → phase map for the project's runs. A task whose worker run
    // is parked on a human (WaitingForInput) must be distinguishable from a
    // genuinely failed one — worker.status alone can't tell them apart. This is
    // a server-computed view field on the board response, not a Task status field.
    const runs = await listRuns(ns, undefined, `percussionist.dev/project=${name}`);
    const runPhaseMap = new Map<string, RunPhase>();
    const runMessageMap = new Map<string, string>();
    for (const run of runs) {
      if (!run.metadata.name || !run.status?.phase) continue;
      runPhaseMap.set(run.metadata.name, run.status.phase);
      if (run.status.message) runMessageMap.set(run.metadata.name, run.status.message);
    }
    const tasksByName = new Map(tasks.map((task) => [task.metadata.name, task]));
    const titleCounts = new Map<string, number>();
    for (const task of tasks) {
      const title = task.spec.title?.trim();
      if (!title) continue;
      titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    }

    // Build a map of child progress for PLAN tasks in awaiting-children phase.
    const childProgressMap = new Map<
      string,
      { total: number; completed: number; childRefs: string[]; childDisplayRefs: string[] }
    >();
    for (const task of tasks) {
      if (task.spec.type === 'PLAN' && task.status?.phase === 'awaiting-children') {
        const taskName = task.metadata.name;
        const children = tasks.filter(
          (t) => t.spec.type === 'BUILD' && t.spec.parentTaskRef === taskName,
        );
        const completed = children.filter((t) => t.status?.phase === 'done').length;
        childProgressMap.set(taskName, {
          total: children.length,
          completed,
          childRefs: children.map((t) => t.metadata.name),
          childDisplayRefs: children.map((t) =>
            resolveTaskDisplayLabel(t.metadata.name, tasksByName, titleCounts),
          ) as string[],
        });
      }
    }

    // Group tasks by board column derived from phase (authoritative).
    const columns: Record<string, unknown[]> = {};
    for (const task of tasks) {
      const phase = task.status?.phase ?? 'pending';
      let col: string;
      if (task.status?.blocked) {
        col = 'blocked';
      } else {
        col = computeBoardColumn(phase);
        // Override to blocked if waiting for a predecessor that isn't done.
        const predRef = task.spec.predecessorRef;
        if (predRef && phase !== 'done') {
          const pred = tasksByName.get(predRef);
          if (pred?.status?.phase !== 'done') {
            col = 'blocked';
            const predDisplay =
              resolveTaskDisplayLabel(predRef, tasksByName, titleCounts) ?? predRef;
            task.status = { ...task.status, blockedReason: `Waiting for: ${predDisplay}` };
          }
        }
      }
      if (!columns[col]) columns[col] = [];

      const displayRefs = {
        parentTask: resolveTaskDisplayLabel(task.spec.parentTaskRef, tasksByName, titleCounts),
        predecessorTask: resolveTaskDisplayLabel(
          task.spec.predecessorRef,
          tasksByName,
          titleCounts,
        ),
        parentTaskCanonical: task.spec.parentTaskRef ?? null,
        predecessorTaskCanonical: task.spec.predecessorRef ?? null,
      };

      // Attach child progress if available.
      const workerRunName = task.status?.worker?.runName;
      const taskWithProgress = {
        ...task,
        childProgress: childProgressMap.get(task.metadata.name),
        displayRefs,
        // Worker run phase/message (e.g. WaitingForInput) — lets the client tell
        // "failed" from "parked on a human". Absent when the task has no run or
        // the run isn't in the project's run list (JSON.stringify drops undefined).
        workerRunPhase: workerRunName ? runPhaseMap.get(workerRunName) : undefined,
        workerRunMessage: workerRunName ? runMessageMap.get(workerRunName) : undefined,
      };
      columns[col]?.push(taskWithProgress);
    }

    // Collect per-task approval annotations from task metadata.
    const approvals: Record<string, { approved: boolean; requestChanges: boolean }> = {};
    for (const task of tasks) {
      const taskAnnotations = task.metadata.annotations ?? {};
      approvals[task.metadata.name] = {
        approved: taskAnnotations['percussionist.dev/action-approved'] === 'true',
        requestChanges: taskAnnotations['percussionist.dev/action-request-changes'] === 'true',
      };
    }

    const settings = {
      maxParallel: project.spec.maxParallel ?? 2,
      agents: project.spec.agents ?? [],
      phase: project.spec.phase ?? 'Active',
      codeServer: project.spec.codeServer,
      displayName: project.spec.displayName,
      color: project.spec.color,
      repoWebUrl: buildRepoWebUrl(project.spec.source?.git?.url ?? ''),
      integrationMode: resolveIntegrationMode(project),
    };

    const authResult = validateModelAuth(project.spec.model, project.spec.secrets);
    return c.json({
      settings,
      columns,
      approvals,
      status: project.status?.board ?? {},
      authWarning: authResult.ok ? undefined : authResult.error,
    });
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// GET /api/projects/:project/board/events — SSE stream for board changes.
board.get('/:project/board/events', auth(), async (c) => {
  const name = c.req.param('project');

  try {
    await getProject(name);
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }

  return createPollingSseResponse({
    signal: c.req.raw.signal,
    getSignature: async () => {
      const [project, tasks] = await Promise.all([getProject(name), listTasks(name)]);
      // Collect task annotations for change detection.
      const taskApprovalAnnotations: [string, string][] = [];
      for (const task of tasks) {
        const taskAnnotations = task.metadata.annotations ?? {};
        for (const key of Object.keys(taskAnnotations)) {
          if (key.startsWith('percussionist.dev/action-')) {
            taskApprovalAnnotations.push([key, taskAnnotations[key] ?? '']);
          }
        }
      }
      taskApprovalAnnotations.sort((a, b) => a[0].localeCompare(b[0]));

      // Include task resourceVersions so any task status change triggers an event.
      const taskVersions = tasks
        .map((t) => `${t.metadata.name}:${t.metadata.resourceVersion}`)
        .join(',');

      return JSON.stringify({
        resourceVersion: project.metadata.resourceVersion,
        generation: project.metadata.generation,
        taskVersions,
        boardStatus: project.status?.board ?? {},
        taskApprovalAnnotations,
      });
    },
    updatedEvent: 'board.updated',
    errorEvent: 'board.error',
    readyEvent: { event: 'ready', data: { project: name } },
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/projects/:project/board/spec — patch project settings.
board.patch('/:project/board/spec', adminAuth(), async (c) => {
  const name = c.req.param('project');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  try {
    const updated = await patchProjectSpec(name, body as Parameters<typeof patchProjectSpec>[1]);
    return c.json({
      maxParallel: updated.spec.maxParallel,
      agents: updated.spec.agents,
      phase: updated.spec.phase,
    });
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// POST /api/projects/:project/board/tasks — create a new Task CR.
board.post('/:project/board/tasks', adminAuth(), async (c) => {
  const name = c.req.param('project');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const { type, title, description, agent, priority } = body as Partial<TaskSpec> & {
    column?: string;
  };
  const { column: targetColumn } = body as { column?: string };

  if (!type || !title || !agent) {
    return c.json({ error: 'type, title, and agent are required' }, 400);
  }
  if (type !== 'PLAN' && type !== 'BUILD') {
    return c.json({ error: 'Invalid task type. Must be PLAN or BUILD' }, 400);
  }

  try {
    const project = await getProject(name);
    const validation = await validateAgentTaskCapability(project, type, agent);
    if (!validation.ok) {
      return c.json({ error: validation.error }, 400);
    }

    const taskName = taskCRName(name, type);
    const ns = project.metadata.namespace ?? NAMESPACE;

    const task = buildTask({
      name: taskName,
      projectName: name,
      projectUid: project.metadata.uid ?? '',
      ns,
      spec: {
        projectRef: name,
        type,
        title,
        description,
        agent,
        priority: priority ?? 'medium',
      },
    });

    const created = await createTask(task, ns);

    // If the caller specified ideas column, patch status to phase=idea immediately.
    if (targetColumn === 'ideas') {
      await patchTaskStatus(taskName, { phase: 'idea' }, ns);
    }

    await appendTaskEvent(name, taskName, type, 'run.created', { title, agent, priority });

    return c.json({ task: created }, 201);
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/projects/:project/board/tasks/:taskName

board.delete('/:project/board/tasks/:taskName', adminAuth(), async (c) => {
  const projectName = c.req.param('project');
  const taskName = c.req.param('taskName');
  try {
    const project = await getProject(projectName);
    const ns = project.metadata.namespace ?? NAMESPACE;
    await deleteTask(taskName, ns);
    return c.body(null, 204);
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// POST /api/projects/:project/board/tasks/:taskName/move
//
// Body: { column: string }
// Resets a failed/escalated task back to "pending" phase so the reconciler
// picks it up again. "column" in the body is accepted for API compatibility
// but only "ready"/"pending" makes sense here — anything else is rejected.

board.post('/:project/board/tasks/:taskName/move', adminAuth(), async (c) => {
  const projectName = c.req.param('project');
  const taskName = c.req.param('taskName');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const { column } = body as { column?: string };
  if (!column?.trim()) return c.json({ error: 'column is required' }, 400);

  // Supported target columns and the phase they map to.
  const columnPhaseMap: Record<string, TaskPhase> = {
    ready: 'pending',
    pending: 'pending',
    backlog: 'pending',
    ideas: 'idea',
  };
  if (!(column in columnPhaseMap)) {
    return c.json(
      { error: `Unsupported target column: ${column}. Supported: ready, backlog, ideas.` },
      400,
    );
  }

  try {
    const project = await getProject(projectName);
    const ns = project.metadata.namespace ?? NAMESPACE;
    const targetPhase = columnPhaseMap[column];
    if (!targetPhase) return c.json({ error: `Unknown column: ${column}` }, 400);
    const patch: Record<string, unknown> = { phase: targetPhase, blocked: false };

    // When resetting to backlog/pending, increment retryCount so the
    // reconciler generates a new unique run name (workerRunName hashes
    // retryCount into the name), preserving the old failed Run and its history.
    // A task that never ran (an idea) has no worker status, and
    // WorkerStatusSchema requires `status` — patching a bare { retryCount }
    // would fail validation, so leave worker untouched in that case.
    const resetTargets = ['ready', 'pending', 'backlog'];
    if (resetTargets.includes(column)) {
      const task = await getTask(taskName, ns);
      const worker = task.status?.worker;
      if (worker?.status) {
        patch.worker = { ...worker, retryCount: (worker.retryCount ?? 0) + 1 };
      }
    }

    const parsedPatch = TaskStatusSchema.partial().safeParse(patch);
    if (!parsedPatch.success) {
      return c.json(
        {
          error: `Invalid task status patch: ${parsedPatch.error.issues[0]?.message ?? 'unknown'}`,
        },
        400,
      );
    }

    await patchTaskStatus(taskName, parsedPatch.data, ns);
    await appendTaskEvent(projectName, taskName, 'unknown', 'moved', { column });
    return c.json({ success: true });
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// POST /api/projects/:project/board/tasks/:taskName/approve

board.post('/:project/board/tasks/:taskName/approve', adminAuth(), async (c) => {
  const name = c.req.param('project');
  const taskName = c.req.param('taskName');
  try {
    // Write approval as Task annotation (new format).
    const { task, ns } = await getProjectTask(name, taskName);
    const currentAnnotations = task.metadata.annotations ?? {};
    await patchTask(
      taskName,
      {
        metadata: {
          ...task.metadata,
          annotations: {
            ...currentAnnotations,
            'percussionist.dev/action-approved': 'true',
            'percussionist.dev/action-request-changes': 'false',
          },
        },
      },
      ns,
    );
    await appendTaskEvent(name, taskName, 'unknown', 'approved', {});
    return c.json({ success: true });
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// POST /api/projects/:project/board/tasks/:taskName/request-changes

board.post('/:project/board/tasks/:taskName/request-changes', adminAuth(), async (c) => {
  const name = c.req.param('project');
  const taskName = c.req.param('taskName');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const { feedback } = body as { feedback?: string };
  if (!feedback?.trim()) {
    return c.json({ error: 'Feedback is required' }, 400);
  }
  try {
    // Write rework as Task annotation (new format).
    const { task, ns } = await getProjectTask(name, taskName);
    const currentAnnotations = task.metadata.annotations ?? {};
    await patchTask(
      taskName,
      {
        metadata: {
          ...task.metadata,
          annotations: {
            ...currentAnnotations,
            'percussionist.dev/action-request-changes': 'true',
            'percussionist.dev/action-rework-feedback': feedback.trim(),
          },
        },
      },
      ns,
    );
    await appendTaskEvent(name, taskName, 'unknown', 'request-changes', {
      feedback: feedback.trim(),
    });
    return c.json({ success: true });
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// POST /api/projects/:project/board/tasks/:taskName/retry-review
//
// Moves a BUILD task with a failed review back to succeeded phase so the
// manager creates a new review run. Increments aiReworkCount for a unique
// review run name, clears the stale reviewRunName and reviewFeedback.

board.post('/:project/board/tasks/:taskName/retry-review', adminAuth(), async (c) => {
  const projectName = c.req.param('project');
  const taskName = c.req.param('taskName');
  try {
    const { task, ns } = await getProjectTask(projectName, taskName);
    const phase = task.status?.phase;
    const reviewRunName = task.status?.worker?.reviewRunName;
    if (phase !== 'awaiting-human') {
      return c.json({ error: `Task phase is "${phase}", expected "awaiting-human"` }, 400);
    }
    if (!reviewRunName) {
      return c.json({ error: 'Task has no reviewRunName to retry' }, 400);
    }
    const currentAiReworkCount = (task.status?.worker?.aiReworkCount ?? 0) + 1;
    const patch: Record<string, unknown> = {
      phase: 'succeeded',
      worker: {
        ...task.status?.worker,
        aiReworkCount: currentAiReworkCount,
      },
    };
    const parsedPatch = TaskStatusSchema.partial().safeParse(patch);
    if (!parsedPatch.success) {
      return c.json(
        {
          error: `Invalid task status patch: ${parsedPatch.error.issues[0]?.message ?? 'unknown'}`,
        },
        400,
      );
    }

    await patchTaskStatus(taskName, parsedPatch.data, ns);
    await appendTaskEvent(projectName, taskName, 'BUILD', 'review-retry', {});
    return c.json({ success: true });
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// POST /api/projects/:project/board/tasks/:taskName/abandon

board.post('/:project/board/tasks/:taskName/abandon', adminAuth(), async (c) => {
  const name = c.req.param('project');
  const taskName = c.req.param('taskName');
  try {
    // Write abandon as Task annotation (new format).
    const { task, ns } = await getProjectTask(name, taskName);
    const currentAnnotations = task.metadata.annotations ?? {};
    await patchTask(
      taskName,
      {
        metadata: {
          ...task.metadata,
          annotations: {
            ...currentAnnotations,
            'percussionist.dev/action-abandon': 'true',
          },
        },
      },
      ns,
    );
    await appendTaskEvent(name, taskName, 'unknown', 'abandoned', {});
    return c.json({ success: true });
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// POST /api/projects/:project/board/tasks/:taskName/answer

board.post('/:project/board/tasks/:taskName/answer', adminAuth(), async (c) => {
  const name = c.req.param('project');
  const taskName = c.req.param('taskName');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const { answer } = body as { answer?: string };
  if (!answer?.trim()) {
    return c.json({ error: 'Answer is required' }, 400);
  }
  try {
    // Answer is written as a Task annotation (not Project).
    const { task, ns } = await getProjectTask(name, taskName);
    const currentAnnotations = task.metadata.annotations ?? {};
    await patchTask(
      taskName,
      {
        metadata: {
          ...task.metadata,
          annotations: {
            ...currentAnnotations,
            'percussionist.dev/action-answer': answer.trim(),
          },
        },
      },
      ns,
    );
    await appendTaskEvent(name, taskName, 'PLAN', 'answered', { answer: answer.trim() });
    return c.json({ success: true });
  } catch (e) {
    const ke = e as KubeError;
    return c.json({ error: errMsg(ke) }, errStatus(ke));
  }
});

// ---------------------------------------------------------------------------
// POST /api/projects/:project/board/task-events — internal endpoint for the
// manager controller to append task lifecycle events.
// Body: { taskName, taskType, eventType, payload? }

board.post('/:project/board/task-events', scoped('events', 'write'), async (c) => {
  const project = c.req.param('project');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const { taskName, taskType, eventType, payload } = body as {
    taskName?: string;
    taskType?: string;
    eventType?: string;
    payload?: Record<string, unknown>;
  };
  if (!taskName || !taskType || !eventType) {
    return c.json({ error: 'taskName, taskType, and eventType are required' }, 400);
  }
  await appendTaskEvent(project, taskName, taskType, eventType, payload ?? {});
  return c.body(null, 204);
});

export default board;
