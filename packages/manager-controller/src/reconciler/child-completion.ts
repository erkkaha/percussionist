// Shared gate predicate for BUILD child completion — used by every site that
// waits on "is this child (or predecessor) actually done" so they cannot drift.

import type { Project, Task } from '@percussionist/api';
import type { ResolvedFlow } from './flow.js';

/** True when the configured flow routes BUILD children through a merge run,
 *  i.e. children are expected to end `done` WITH `mergedAt`. */
export function childMergeExpected(project: Project, flow: ResolvedFlow): boolean {
  return (
    project.spec.featureBranchingEnabled === true &&
    flow.merge.mode !== 'disabled' &&
    flow.build.onSuccess !== 'done' &&
    flow.build.onApprove === 'merge'
  );
}

/** A done child satisfies its parent's gate when it merged, was abandoned,
 *  or the flow never merges children in the first place. */
export function childSatisfiesGate(child: Task, mergeExpected: boolean): boolean {
  if (child.status?.phase !== 'done') return false;
  const w = child.status?.worker;
  return Boolean(w?.mergedAt) || w?.abandoned === true || !mergeExpected;
}
