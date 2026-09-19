// interactive-requests.ts — consume `percussionist.dev/action-interactive`
// requests written by the board, CLI, and manager MCP tool.
//
// An interactive run is auxiliary: it is linked to the task by spec.boardTask
// and the `percussionist.dev/task-id` label, but never touches
// Task.status.phase or status.worker.runName. The manager is the only
// component that creates Runs, so every affordance funnels through this pass.
// The run name is derived from the writer-generated request id, which makes
// the pass idempotent: a retry after a partial failure rebuilds the same name
// and the createRun 409 is adopted instead of duplicating the run.

import type { Project, Task, TaskPhase } from '@percussionist/api';
import {
  INTERACTIVE_RUN_ANNOTATION,
  InteractiveRunRequestSchema,
  interactiveRunName,
} from '@percussionist/api';
import { createRun, patchTask } from '@percussionist/kube';
import { emitEvent } from '../events.js';
import { buildWorkerRun } from '../worker-builder.js';
import { persistEvent } from './audit.js';

const NAMESPACE = process.env.PERCUSSIONIST_NAMESPACE ?? 'percussionist';

/**
 * Clear the consumed request annotation. A `null` value is required — per the
 * merge-patch rule in AGENTS.md, `undefined` is dropped by JSON.stringify and
 * would leave the annotation in place, recreating the run on every cycle.
 */
async function clearRequestAnnotation(taskName: string, ns: string): Promise<void> {
  try {
    await patchTask(
      taskName,
      {
        metadata: {
          name: taskName,
          annotations: { [INTERACTIVE_RUN_ANNOTATION]: null },
        },
      } as never,
      ns,
    );
  } catch (e) {
    // Non-fatal: a leftover annotation is harmless (the deterministic run name
    // makes the next pass adopt the existing Run).
    console.warn(
      `[interactive-requests] failed to clear annotation on ${taskName}:`,
      (e as Error).message,
    );
  }
}

function isAlreadyExists(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { statusCode?: number }).statusCode === 409;
}

/**
 * Process every task carrying an interactive-run request annotation.
 *
 * Called before the per-task decision loop so blocked tasks (skipped there)
 * can still get an auxiliary run for debugging. Per-task failures are
 * isolated: the annotation is left in place so the next cycle retries with the
 * same deterministic run name.
 */
export async function processInteractiveRequests(
  project: Project,
  tasks: Task[],
  namespace: string = NAMESPACE,
): Promise<void> {
  const projectName = project.metadata.name;

  for (const task of tasks) {
    const taskName = task.metadata.name;
    if (!taskName) continue;

    const raw = task.metadata.annotations?.[INTERACTIVE_RUN_ANNOTATION];
    if (!raw) continue;

    const phase = task.status?.phase;

    // Defensive: the writers reject done/idea, but a stale annotation must not
    // keep a terminal task busy.
    if (phase === 'done' || phase === 'idea') {
      await clearRequestAnnotation(taskName, namespace);
      continue;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      console.warn(`[interactive-requests] ${taskName}: request annotation is not valid JSON`);
      await clearRequestAnnotation(taskName, namespace);
      continue;
    }

    const parsed = InteractiveRunRequestSchema.safeParse(payload);
    if (!parsed.success) {
      console.warn(
        `[interactive-requests] ${taskName}: invalid request payload —`,
        parsed.error.issues[0]?.message ?? 'unknown',
      );
      await clearRequestAnnotation(taskName, namespace);
      continue;
    }

    const request = parsed.data;
    const runName = interactiveRunName(projectName, taskName, request.id);

    try {
      const run = await buildWorkerRun(project, task, runName, 0, undefined, tasks, {
        interactive: true,
        agent: request.agent,
        model: request.model,
        timeoutSeconds: request.timeoutSeconds,
      });

      try {
        await createRun(run, namespace);
        console.log(`[interactive-requests] ${taskName}: created interactive run ${runName}`);
      } catch (e) {
        if (!isAlreadyExists(e)) throw e;
        console.log(`[interactive-requests] ${taskName}: adopted existing run ${runName}`);
      }

      await clearRequestAnnotation(taskName, namespace);

      // Best-effort audit trail; never fail the pass because of it.
      const event = {
        project: projectName,
        task: taskName,
        fromPhase: (phase ?? 'pending') as TaskPhase,
        reason: 'interactive-run-requested',
        message: `created interactive run ${runName}`,
        effects: ['CreateRun'],
        at: new Date().toISOString(),
      };
      await persistEvent(event, namespace, taskName, task.metadata.uid ?? '');
      emitEvent(projectName, taskName, task.spec.type, 'interactive-run-requested', { runName });
    } catch (e) {
      // Leave the annotation so the next cycle retries (deterministic name).
      console.error(`[interactive-requests] ${taskName} failed:`, (e as Error).message);
    }
  }
}
