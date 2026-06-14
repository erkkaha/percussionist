// Feature branch resolution logic.
//
// When featureBranchingEnabled: true, tasks work on isolated feature branches:
//   - PLAN tasks: feature/{plan-task-id}
//   - BUILD tasks (with parent): feature/{plan-task-id}--{build-task-id}
//   - Standalone BUILD tasks: feature/{build-task-id}

import type { Project, Task } from '@percussionist/api';

/**
 * Resolve the git branch a task should work on.
 * Returns undefined when feature branching is disabled (use project default ref).
 */
export function resolveTaskBranch(
  task: Task,
  project: Project,
  allTasks: Task[],
): string | undefined {
  if (!project.spec.featureBranchingEnabled) {
    return undefined; // Feature branching disabled
  }

  const taskName = task.metadata.name;
  if (!taskName) {
    throw new Error('Task has no metadata.name');
  }

  // If task already has a branch assigned, reuse it (idempotent).
  if (task.status?.worker?.gitBranch) {
    return task.status.worker.gitBranch;
  }

  // PLAN task: feature/{plan-task-id}
  if (task.spec.type === 'PLAN') {
    return `feature/${taskName}`;
  }

  // BUILD task with parent PLAN. Do not use `${parentBranch}/${taskName}`:
  // Git refs are path-like, so refs/heads/feature/plan and
  // refs/heads/feature/plan/build cannot coexist.
  if (task.spec.type === 'BUILD' && task.spec.parentTaskRef) {
    const parentPlan = allTasks.find((t) => t.metadata.name === task.spec.parentTaskRef);
    if (!parentPlan) {
      throw new Error(
        `BUILD task ${taskName} references non-existent parent PLAN: ${task.spec.parentTaskRef}`,
      );
    }
    const parentBranch = resolveTaskBranch(parentPlan, project, allTasks);
    if (!parentBranch) {
      throw new Error(
        `Parent PLAN ${task.spec.parentTaskRef} has no branch (feature branching disabled?)`,
      );
    }
    return `${parentBranch}--${taskName}`;
  }

  // Standalone BUILD task: feature/{build-task-id}
  if (task.spec.type === 'BUILD') {
    return `feature/${taskName}`;
  }

  throw new Error(`Unknown task type: ${task.spec.type}`);
}

/**
 * Resolve the parent branch a task should be created from.
 * Returns undefined when feature branching is disabled (use project default ref).
 */
export function resolveParentBranch(
  task: Task,
  project: Project,
  allTasks: Task[],
): string | undefined {
  if (!project.spec.featureBranchingEnabled) {
    return undefined; // Feature branching disabled
  }

  const taskName = task.metadata.name;
  if (!taskName) {
    throw new Error('Task has no metadata.name');
  }

  // If task already has a parent branch assigned, reuse it (idempotent).
  if (task.status?.worker?.parentBranch) {
    return task.status.worker.parentBranch;
  }

  // PLAN task: create from main
  if (task.spec.type === 'PLAN') {
    return project.spec.source?.git?.ref || 'main';
  }

  // BUILD task with parent PLAN: create from parent's feature branch
  if (task.spec.type === 'BUILD' && task.spec.parentTaskRef) {
    const parentPlan = allTasks.find((t) => t.metadata.name === task.spec.parentTaskRef);
    if (!parentPlan) {
      throw new Error(
        `BUILD task ${taskName} references non-existent parent PLAN: ${task.spec.parentTaskRef}`,
      );
    }
    const parentBranch = resolveTaskBranch(parentPlan, project, allTasks);
    if (!parentBranch) {
      throw new Error(
        `Parent PLAN ${task.spec.parentTaskRef} has no branch (feature branching disabled?)`,
      );
    }
    return parentBranch;
  }

  // Standalone BUILD task: create from main
  if (task.spec.type === 'BUILD') {
    return project.spec.source?.git?.ref || 'main';
  }

  throw new Error(`Unknown task type: ${task.spec.type}`);
}

/**
 * Resolve the target branch a task should merge into on approval.
 * Returns undefined when feature branching is disabled (no auto-merge).
 */
export function resolveMergeBranch(
  task: Task,
  project: Project,
  allTasks: Task[],
): string | undefined {
  if (!project.spec.featureBranchingEnabled) {
    return undefined; // Feature branching disabled
  }

  const taskName = task.metadata.name;
  if (!taskName) {
    throw new Error('Task has no metadata.name');
  }

  // If task already has a merge target assigned, reuse it (idempotent).
  if (task.status?.worker?.mergeIntoBranch) {
    return task.status.worker.mergeIntoBranch;
  }

  // PLAN task: merge into project default ref (main) when feature branching is enabled.
  // The decision engine controls whether this is auto-merge or manual approval.
  if (task.spec.type === 'PLAN') {
    return project.spec.source?.git?.ref || 'main';
  }

  // BUILD task with parent PLAN: merge into parent's feature branch
  if (task.spec.type === 'BUILD' && task.spec.parentTaskRef) {
    const parentPlan = allTasks.find((t) => t.metadata.name === task.spec.parentTaskRef);
    if (!parentPlan) {
      throw new Error(
        `BUILD task ${taskName} references non-existent parent PLAN: ${task.spec.parentTaskRef}`,
      );
    }
    const parentBranch = resolveTaskBranch(parentPlan, project, allTasks);
    if (!parentBranch) {
      throw new Error(
        `Parent PLAN ${task.spec.parentTaskRef} has no branch (feature branching disabled?)`,
      );
    }
    return parentBranch;
  }

  // Standalone BUILD task: merge into main
  if (task.spec.type === 'BUILD') {
    return project.spec.source?.git?.ref || 'main';
  }

  throw new Error(`Unknown task type: ${task.spec.type}`);
}
