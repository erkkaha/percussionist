// lib/findings.ts — small helpers around the Finding status enum.
//
// "Closed" findings are those in a terminal state (resolved / duplicate /
// wontfix); everything else is still open and actionable from the UI.

import type { Finding } from './types';

/** Terminal finding statuses — the finding is considered closed. */
export const CLOSED_FINDING_STATUSES: ReadonlyArray<Finding['status']> = [
  'resolved',
  'duplicate',
  'wontfix',
];

/** Open (non-terminal) finding statuses. */
export const OPEN_FINDING_STATUSES: ReadonlyArray<Finding['status']> = [
  'new',
  'triaged',
  'in-progress',
];

export function isClosedFindingStatus(status: Finding['status']): boolean {
  return (CLOSED_FINDING_STATUSES as ReadonlyArray<string>).includes(status);
}

export function isOpenFindingStatus(status: Finding['status']): boolean {
  return !isClosedFindingStatus(status);
}
