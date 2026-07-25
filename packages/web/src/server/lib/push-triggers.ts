// lib/push-triggers.ts — server-side notify decisions for Web Push.
//
// The in-tab notifications (useRunNotifications/useBoardNotifications) decide
// client-side from SSE-refreshed data, which only works with a tab open. Push
// must be decided here: a background loop polls Run and Task phases and sends
// to every subscribed device on transitions that need a human.
//
// Deliberately quieter than the in-tab notifications — a push interrupts
// whatever the operator is doing, so routine progress (task started, task
// succeeded → reviewing) stays in-tab only, and transitions push only when:
//
//   - a Task needs a decision: awaiting-human, waiting-for-input, failed
//   - a standalone Run finishes or asks a question. Runs belonging to a board
//     task are skipped — retries/review are automatic there, and the task-level
//     transition above is the one that means "you're needed".
//
// Only transitions fire, never states seen on the first pass — a server
// restart must not re-buzz phones for everything already sitting on a human
// gate. The poll is skipped entirely while nobody is subscribed.

import type { Run, Task } from '@percussionist/api';
import { getDb } from '../db.js';
import { listRuns, listTasks } from '../kube.js';
import { pushSubscription } from '../schema.js';
import { type PushPayload, sendPushToAll } from './push.js';

const POLL_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Transition detection (pure, tested directly)

export interface PhaseTransition {
  name: string;
  from: string;
  to: string;
}

/**
 * Diff current phases against the previous poll.
 *
 * Returns the transitions and the map to carry to the next poll. Names absent
 * from `current` are dropped from the carried map (deleted objects), and names
 * with no previous entry populate it without firing.
 */
export function diffPhases(
  prev: ReadonlyMap<string, string> | null,
  current: Array<{ name: string; phase: string | undefined }>,
): { transitions: PhaseTransition[]; next: Map<string, string> } {
  const next = new Map<string, string>();
  const transitions: PhaseTransition[] = [];
  for (const { name, phase } of current) {
    if (!phase) continue;
    next.set(name, phase);
    const before = prev?.get(name);
    if (prev !== null && before !== undefined && before !== phase) {
      transitions.push({ name, from: before, to: phase });
    }
  }
  return { transitions, next };
}

// ---------------------------------------------------------------------------
// Payload builders (exported for tests)

const PUSHED_TASK_PHASES: Record<string, { title: string }> = {
  'awaiting-human': { title: 'Task needs your decision' },
  'waiting-for-input': { title: 'Task is asking a question' },
  failed: { title: 'Task failed' },
};

export function taskPush(task: Task, to: string): PushPayload | null {
  const meta = PUSHED_TASK_PHASES[to];
  if (!meta) return null;
  const name = task.metadata.name;
  const project = task.spec.projectRef;
  return {
    title: meta.title,
    body: `${task.spec.title || name} in ${project}`,
    // One live notification per task — a newer transition replaces the older.
    tag: `task:${project}:${name}`,
    url: `/projects/${encodeURIComponent(project)}/board`,
  };
}

const PUSHED_RUN_PHASES: Record<string, { title: string }> = {
  Succeeded: { title: 'Run succeeded' },
  Failed: { title: 'Run failed' },
  Cancelled: { title: 'Run cancelled' },
  WaitingForInput: { title: 'Run is waiting for your input' },
};

export function runPush(run: Run, to: string): PushPayload | null {
  // Board-owned runs surface through their task's transitions instead.
  if (run.spec.boardTask) return null;
  const meta = PUSHED_RUN_PHASES[to];
  if (!meta) return null;
  const name = run.metadata.name;
  return {
    title: meta.title,
    body: name,
    tag: `run:${name}`,
    url: `/runs/${encodeURIComponent(name)}`,
  };
}

// ---------------------------------------------------------------------------
// Poller

let _prevTaskPhases: Map<string, string> | null = null;
let _prevRunPhases: Map<string, string> | null = null;

function hasSubscribers(): boolean {
  return (
    getDb().select({ id: pushSubscription.id }).from(pushSubscription).limit(1).all().length > 0
  );
}

async function poll(): Promise<void> {
  // No devices → skip the K8s round-trips. Also drop the carried phase maps:
  // whatever happens while nobody listens should not fire retroactively when
  // the first device subscribes.
  if (!hasSubscribers()) {
    _prevTaskPhases = null;
    _prevRunPhases = null;
    return;
  }

  const [tasks, runs] = await Promise.all([listTasks(), listRuns()]);

  const taskDiff = diffPhases(
    _prevTaskPhases,
    tasks.map((t) => ({ name: t.metadata.name, phase: t.status?.phase })),
  );
  _prevTaskPhases = taskDiff.next;

  const runDiff = diffPhases(
    _prevRunPhases,
    runs.map((r) => ({ name: r.metadata.name, phase: r.status?.phase })),
  );
  _prevRunPhases = runDiff.next;

  const payloads: PushPayload[] = [];
  const taskByName = new Map(tasks.map((t) => [t.metadata.name, t]));
  for (const tr of taskDiff.transitions) {
    const task = taskByName.get(tr.name);
    const payload = task ? taskPush(task, tr.to) : null;
    if (payload) payloads.push(payload);
  }
  const runByName = new Map(runs.map((r) => [r.metadata.name, r]));
  for (const tr of runDiff.transitions) {
    const run = runByName.get(tr.name);
    const payload = run ? runPush(run, tr.to) : null;
    if (payload) payloads.push(payload);
  }

  for (const payload of payloads) {
    const { sent, failed, pruned } = await sendPushToAll(payload);
    console.log(
      `[push-triggers] "${payload.title}" (${payload.tag}): sent=${sent} failed=${failed} pruned=${pruned}`,
    );
  }
}

/** Start the trigger loop. No-op when auth is disabled (nobody can subscribe). */
export function startPushTriggers(): void {
  if (process.env.AUTH_DISABLED === '1') {
    console.log('[push-triggers] disabled (AUTH_DISABLED=1)');
    return;
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await poll();
    } catch (e) {
      // K8s API hiccups are routine (rolling restarts); next tick retries.
      console.warn('[push-triggers] poll failed:', (e as Error).message);
    } finally {
      running = false;
    }
  };

  void tick();
  const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);
  interval.unref();
  console.log(`[push-triggers] watching run/task transitions every ${POLL_INTERVAL_MS / 1000}s`);
}
