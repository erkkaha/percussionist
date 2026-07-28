// board.ts — `beatctl board` subcommands.
//
// Manages the kanban board for an Project.
// Task state is authoritative in Task CRs (status subresource).
//
// Subcommands:
//   get <project>                  — show board state (columns, workers, escalations)
//   task add <project>             — create a new Task CR
//   task move <project>            — patch task status.column
//   task remove <project>          — delete the Task CR
//   task approve <project>         — approve an awaiting-human task
//   task request-changes <project> — send an awaiting-human task back for rework
//   plan <project>                 — read a PLAN artifact from the plans ConfigMap

import {
  BoardColumn,
  computeBoardColumn,
  type Project,
  type Task,
  type TaskColumn,
  type TaskPhase,
} from '@percussionist/api';
import {
  buildTask,
  createTask,
  deleteTask,
  fatal,
  getPlansConfigMap,
  getProject,
  getTask,
  listTasks,
  loadFromKubeconfig,
  NAMESPACE,
  padCols,
  patchTask,
  patchTaskStatus,
} from '@percussionist/kube';
import YAML from 'yaml';

// ---------------------------------------------------------------------------
// board get

export interface BoardGetOpts {
  namespace?: string;
  output?: 'yaml' | 'json';
}

export async function runBoardGet(projectName: string, opts: BoardGetOpts): Promise<void> {
  const ns = opts.namespace ?? NAMESPACE;
  const { custom } = loadFromKubeconfig();

  let project: Project;
  try {
    project = await getProject(projectName, ns, custom);
  } catch (e) {
    fatal('get project failed', e);
  }

  const tasks = await listTasks(projectName, ns, custom);

  if (opts.output === 'json') {
    console.log(JSON.stringify({ project: project.spec, tasks }, null, 2));
    return;
  }
  if (opts.output === 'yaml') {
    console.log(YAML.stringify({ project: project.spec, tasks }));
    return;
  }

  console.log(`Board: ${projectName}`);
  console.log(`Phase: ${project.spec.phase ?? 'Active'}`);
  console.log(`Max parallel: ${project.spec.maxParallel ?? 2}`);
  console.log(`Team: ${(project.spec.agents ?? []).map((a) => a.name).join(', ') || '(none)'}`);
  console.log();

  // Columns are derived from each task's phase, never read off the CR — the
  // `status.column` field is legacy and the controllers stopped writing it, so
  // filtering on it silently parked every task in one column.
  const colRows: string[][] = [['COLUMN', 'TASKS']];
  for (const col of BoardColumn.options) {
    const colTasks = tasks.filter((t) => computeBoardColumn(t.status?.phase ?? 'pending') === col);
    colRows.push([
      col,
      colTasks.length > 0
        ? colTasks
            .map((t) => `${t.metadata.name} [${t.status?.phase ?? 'pending'}] (${t.spec.title})`)
            .join(', ')
        : '(empty)',
    ]);
  }
  console.log(padCols(colRows));
  console.log();

  const running = tasks.filter((t) => t.status?.worker?.status === 'Running');
  if (running.length > 0) {
    console.log('Active workers:');
    const workerRows: string[][] = [['TASK', 'AGENT', 'RUN', 'RETRIES']];
    for (const t of running) {
      const w = t.status?.worker;
      if (!w) continue;
      const workerStatus = w;
      workerRows.push([
        t.metadata.name,
        t.spec.agent ?? '-',
        workerStatus.runName ?? '-',
        String(workerStatus.retryCount ?? 0),
      ]);
    }
    console.log(padCols(workerRows));
    console.log();
  }

  const escalated = tasks.filter((t) => t.status?.worker?.status === 'Escalated');
  if (escalated.length > 0) {
    console.log(`Escalations (${escalated.length}):`);
    for (const t of escalated) {
      console.log(`--- ${t.metadata.name} ---`);
      // Note: escalation field removed in new schema
      console.log('(escalation details no longer stored in worker status)');
      console.log();
    }
  }
}

// ---------------------------------------------------------------------------
// board task add

export interface BoardTaskAddOpts {
  namespace?: string;
  title: string;
  description?: string;
  type: 'PLAN' | 'BUILD';
  priority?: 'high' | 'medium' | 'low';
  agent: string;
  column?: string;
}

export async function runBoardTaskAdd(projectName: string, opts: BoardTaskAddOpts): Promise<void> {
  const ns = opts.namespace ?? NAMESPACE;
  const { custom } = loadFromKubeconfig();

  let project: Project;
  try {
    project = await getProject(projectName, ns, custom);
  } catch (e) {
    fatal('get project failed', e);
  }

  const teamNames = (project.spec.agents ?? []).map((a) => a.name);
  if (!teamNames.includes(opts.agent)) {
    console.error(`beatctl: agent "${opts.agent}" is not in the project's agents list.`);
    console.error(`  Available agents: ${teamNames.join(', ') || '(none)'}`);
    process.exit(1);
  }

  // Generate a unique name for the task CR.
  const { randomBytes } = await import('node:crypto');
  const suffix = randomBytes(3).toString('hex');
  const taskName = `${projectName}-${opts.type.toLowerCase()}-${suffix}`;

  const task = buildTask({
    name: taskName,
    projectName,
    projectUid: project.metadata.uid ?? '',
    ns,
    spec: {
      projectRef: projectName,
      type: opts.type,
      title: opts.title,
      description: opts.description,
      agent: opts.agent,
      priority: opts.priority ?? 'medium',
    },
  });

  // Set initial phase in status (defaults to pending).
  const initialPhase: TaskPhase = 'pending';

  task.status = { phase: initialPhase };

  try {
    const created = await createTask(task, ns, custom);
    const column = computeBoardColumn(initialPhase);
    console.log(
      `task ${created.metadata.name} created in "${column}" (phase: ${initialPhase}) on project ${projectName}`,
    );
    // Patch status subresource to set initial phase.
    await patchTaskStatus(created.metadata.name, { phase: initialPhase }, ns);
  } catch (e) {
    fatal('create task failed', e);
  }
}

// ---------------------------------------------------------------------------
// board task move

export interface BoardTaskMoveOpts {
  namespace?: string;
  taskName: string;
  to: string;
}

export async function runBoardTaskMove(
  projectName: string,
  opts: BoardTaskMoveOpts,
): Promise<void> {
  const ns = opts.namespace ?? NAMESPACE;
  void projectName;

  try {
    await patchTaskStatus(opts.taskName, { column: opts.to as TaskColumn }, ns);
    console.log(`task ${opts.taskName} moved to "${opts.to}"`);
  } catch (e) {
    fatal('task move failed', e);
  }
}

// ---------------------------------------------------------------------------
// board task remove

export interface BoardTaskRemoveOpts {
  namespace?: string;
  taskName: string;
}

export async function runBoardTaskRemove(
  projectName: string,
  opts: BoardTaskRemoveOpts,
): Promise<void> {
  const ns = opts.namespace ?? NAMESPACE;
  const { custom } = loadFromKubeconfig();
  void projectName;
  void custom;

  try {
    await deleteTask(opts.taskName, ns);
    console.log(`task ${opts.taskName} deleted`);
  } catch (e) {
    fatal('delete task failed', e);
  }
}

// ---------------------------------------------------------------------------
// board plan
//
// A PLAN task parks in `awaiting-human` and there is otherwise no way to read
// what you are being asked to approve short of hand-decoding a ConfigMap.
//
// The ConfigMap is the primary store, not a workaround for a planner that could
// not push: the facilitator reads plan content from it when generating BUILD
// tasks precisely so it needs no workspace access, and the manager's `read_plan`
// checks it before anything else. But `complete_plan` does not enforce that the
// planner ever called `write_plan`, so a plan can exist only as the committed
// `.percussionist/plans/{task}.md` file — which is why `read_plan` keeps a
// workspace fallback. Reproducing that fallback here would mean exec'ing into a
// pod, so this command reports the gap and names the path instead of pretending
// no plan exists.

export interface BoardPlanOpts {
  namespace?: string;
  taskName?: string;
}

export async function runBoardPlan(projectName: string, opts: BoardPlanOpts): Promise<void> {
  const ns = opts.namespace ?? NAMESPACE;

  let cm: Awaited<ReturnType<typeof getPlansConfigMap>>;
  try {
    cm = await getPlansConfigMap(projectName, ns);
  } catch (e) {
    fatal('read plans failed', e);
  }

  const plans = cm?.data ?? {};
  const keys = Object.keys(plans).sort();
  if (keys.length === 0) {
    console.error(`beatctl: no plans persisted for project ${projectName}.`);
    console.error('  A planner populates this by calling write_plan, which is not enforced —');
    console.error('  check the workspace for .percussionist/plans/<task>.md before concluding');
    console.error('  that no plan was written.');
    process.exit(1);
  }

  // No --task: list what is on offer rather than guessing which plan is meant.
  if (!opts.taskName) {
    console.log(`Plans for ${projectName}:`);
    for (const key of keys) {
      const size = Math.round((plans[key]?.length ?? 0) / 1024);
      console.log(`  ${key.replace(/\.md$/, '')}  (${size}KB)`);
    }
    console.log();
    console.log(`Read one with: beatctl board plan ${projectName} --task <name>`);
    return;
  }

  // Accept the task name with or without the .md suffix the key carries.
  const key = opts.taskName.endsWith('.md') ? opts.taskName : `${opts.taskName}.md`;
  const content = plans[key];
  if (content === undefined) {
    console.error(`beatctl: no persisted plan for task "${opts.taskName}" in ${projectName}.`);
    console.error(`  Available: ${keys.map((k) => k.replace(/\.md$/, '')).join(', ')}`);
    console.error(`  If the planner skipped write_plan, the artifact may only exist at`);
    console.error(
      `  .percussionist/plans/${opts.taskName.replace(/\.md$/, '')}.md in the workspace.`,
    );
    process.exit(1);
  }

  console.log(content);
}

// ---------------------------------------------------------------------------
// board task approve / request-changes
//
// The human-in-the-loop gate. A task parked in `awaiting-human` waits for a
// verdict; these two commands write the same annotations the web dashboard
// writes, and the manager's reconciler consumes them on its next pass. Writing
// the annotation rather than patching `status.phase` directly is what keeps the
// reconciler's side effects (merge-run scheduling, rework dispatch) intact —
// see the `manager_approve` note in AGENTS.md.

const ANNOTATION = {
  approved: 'percussionist.dev/action-approved',
  requestChanges: 'percussionist.dev/action-request-changes',
  reworkFeedback: 'percussionist.dev/action-rework-feedback',
} as const;

// Phases where a verdict has already been recorded and moved on. Re-approving
// is a no-op rather than an error so the command stays idempotent — retrying
// after a dropped connection must not fail.
const SETTLED_PHASES: readonly TaskPhase[] = ['awaiting-merge', 'done'];

// Read the task and confirm it is actually waiting on a human. Exits non-zero
// on any phase that a verdict cannot apply to.
async function requireAwaitingHuman(
  taskName: string,
  ns: string,
  verb: string,
): Promise<Task | undefined> {
  let task: Task;
  try {
    task = await getTask(taskName, ns);
  } catch (e) {
    fatal('get task failed', e);
  }

  const phase = task.status?.phase;
  if (phase === 'awaiting-human') return task;

  if (verb === 'approve' && phase && SETTLED_PHASES.includes(phase)) {
    console.log(`task ${taskName} is already "${phase}" — nothing to approve`);
    return undefined;
  }

  console.error(`beatctl: cannot ${verb} task ${taskName} in phase "${phase ?? 'unknown'}".`);
  console.error('  Only tasks in "awaiting-human" are waiting on a verdict.');
  process.exit(1);
}

export interface BoardTaskApproveOpts {
  namespace?: string;
  taskName: string;
}

export async function runBoardTaskApprove(
  projectName: string,
  opts: BoardTaskApproveOpts,
): Promise<void> {
  const ns = opts.namespace ?? NAMESPACE;
  void projectName;

  const task = await requireAwaitingHuman(opts.taskName, ns, 'approve');
  if (!task) return;

  try {
    await patchTask(
      opts.taskName,
      {
        metadata: {
          ...task.metadata,
          annotations: {
            ...(task.metadata.annotations ?? {}),
            [ANNOTATION.approved]: 'true',
            [ANNOTATION.requestChanges]: 'false',
          },
        },
      },
      ns,
    );
    console.log(`task ${opts.taskName} approved — the manager will schedule the next step`);
  } catch (e) {
    fatal('approve failed', e);
  }
}

export interface BoardTaskRequestChangesOpts {
  namespace?: string;
  taskName: string;
  feedback: string;
}

export async function runBoardTaskRequestChanges(
  projectName: string,
  opts: BoardTaskRequestChangesOpts,
): Promise<void> {
  const ns = opts.namespace ?? NAMESPACE;
  void projectName;

  const feedback = opts.feedback.trim();
  if (!feedback) {
    console.error('beatctl: --feedback must not be empty');
    console.error('  The rework run is driven by this text; without it the agent has no brief.');
    process.exit(1);
  }

  const task = await requireAwaitingHuman(opts.taskName, ns, 'request changes on');
  if (!task) return;

  try {
    await patchTask(
      opts.taskName,
      {
        metadata: {
          ...task.metadata,
          annotations: {
            ...(task.metadata.annotations ?? {}),
            [ANNOTATION.requestChanges]: 'true',
            [ANNOTATION.reworkFeedback]: feedback,
          },
        },
      },
      ns,
    );
    console.log(`changes requested on task ${opts.taskName} — the manager will dispatch rework`);
  } catch (e) {
    fatal('request changes failed', e);
  }
}
