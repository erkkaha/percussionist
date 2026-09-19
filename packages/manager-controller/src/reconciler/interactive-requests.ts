// Reconciler pass: turn `percussionist.dev/action-interactive` Task annotations
// into auxiliary interactive Run CRs.
//
// Interactive runs are requested by the web UI, the `start_interactive_run`
// manager MCP tool, and the CLI by writing a JSON payload to the Task
// annotation. The reconciler is the single Run-creation authority, so this pass
// consumes those requests — the writers never create a Run themselves.
//
// The run is auxiliary: it never touches `Task.status.phase` or
// `Task.status.worker.runName`. The deterministic run name (derived from the
// writer-generated request id) makes a retry idempotent: a repeated create for
// the same request 409s and the existing Run is adopted.

import type { InteractiveRunRequest, Project, Task, TaskPhase } from '@percussionist/api';
import {
  INTERACTIVE_RUN_ANNOTATION,
  InteractiveRunRequestSchema,
  interactiveRunName,
} from '@percussionist/api';
import { createRun, patchTask } from '@percussionist/kube';
import { emitEvent } from '../events.js';
import { isKubeConflictError } from '../kube-errors.js';
import { buildWorkerRun } from '../worker-builder.js';
import { persistEvent } from './audit.js';
import type { AuditEvent } from './decision.js';

/**
 * Consume pending interactive-run requests for a project's tasks.
 *
 * Each request is handled independently: a failure on one task is logged and
 * leaves that task's annotation in place so the next reconcile cycle retries
 * (the deterministic run name keeps the retry idempotent), while the remaining
 * tasks are still processed.
 */
export async function processInteractiveRequests(
  project: Project,
  tasks: Task[],
  namespace: string,
): Promise<void> {
  const projectName = project.metadata.name;

  for (const task of tasks) {
    const taskName = task.metadata.name;
    const raw = task.metadata.annotations?.[INTERACTIVE_RUN_ANNOTATION];
    if (!raw) continue;

    try {
      const phase = (task.status?.phase ?? 'pending') as TaskPhase;

      // Terminal tasks are not actionable — defensively clear a stale request
      // that was written just before the task moved to done/idea.
      if (phase === 'done' || phase === 'idea') {
        await clearAnnotation(taskName, namespace);
        continue;
      }

      const request = parseRequest(raw);
      if (!request) {
        console.warn(
          `[reconcile] ${taskName}: invalid interactive run request; clearing annotation`,
        );
        await clearAnnotation(taskName, namespace);
        continue;
      }

      const runName = interactiveRunName(projectName, taskName, request.id);
      // buildWorkerRun resolves the branch internally for interactive runs:
      // `worker.gitBranch` wins over resolveTaskBranch so the terminal attaches
      // to the branch the worker actually used, even without feature branching.
      const run = await buildWorkerRun(project, task, runName, 0, undefined, tasks, {
        interactive: true,
        agent: request.agent,
        model: request.model,
        timeoutSeconds: request.timeoutSeconds,
      });

      try {
        await createRun(run, namespace);
      } catch (e) {
        // A retry recreates the same deterministic name; a 409 means an earlier
        // attempt already created it — adopt the existing run and move on.
        if (!isKubeConflictError(e)) throw e;
      }

      await clearAnnotation(taskName, namespace);
      await auditStarted(project, task, namespace, phase, runName);
    } catch (e) {
      // Leave the annotation in place so the next cycle retries; the
      // deterministic run name makes that retry idempotent.
      console.error(`[reconcile] ${taskName} interactive run request failed:`, e);
    }
  }
}

function parseRequest(raw: string): InteractiveRunRequest | null {
  try {
    const parsed = InteractiveRunRequestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // Malformed JSON — treat as an invalid payload.
    return null;
  }
}

/**
 * Clear the interactive-run request annotation. `null` (not `undefined`) is
 * required: JSON.stringify drops undefined keys, so an undefined value would
 * leave the annotation in place forever (see AGENTS.md).
 */
async function clearAnnotation(taskName: string, namespace: string): Promise<void> {
  const annotations: Record<string, string | null> = { [INTERACTIVE_RUN_ANNOTATION]: null };
  await patchTask(
    taskName,
    {
      metadata: {
        name: taskName,
        annotations: annotations as Record<string, string>,
      },
    },
    namespace,
  );
}

/**
 * Record a best-effort audit event for the created run. Neither helper throws,
 * so audit failure can never abort the pass or leave a task unprocessed.
 */
async function auditStarted(
  project: Project,
  task: Task,
  namespace: string,
  phase: TaskPhase,
  runName: string,
): Promise<void> {
  const projectName = project.metadata.name;
  const taskName = task.metadata.name;
  const event: AuditEvent = {
    project: projectName,
    task: taskName,
    fromPhase: phase,
    reason: 'InteractiveRunStarted',
    message: `Interactive run ${runName} created`,
    effects: [runName],
    at: new Date().toISOString(),
  };
  await persistEvent(event, namespace, taskName, task.metadata.uid ?? '');
  emitEvent(projectName, taskName, task.spec.type, 'InteractiveRunStarted', {
    message: event.message,
    effects: event.effects,
  });
}
