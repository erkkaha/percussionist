import type { Task } from '../../lib/types';

export interface PrPresentation {
  prNumber: number;
  url?: string;
  state: 'open' | 'merged' | 'closed';
}

export function getPrPresentation(task: Task, repoWebUrl?: string): PrPresentation | null {
  const worker = task.status?.worker;
  const prNumber = worker?.prNumber;
  if (prNumber === undefined) return null;

  const state: PrPresentation['state'] = worker?.mergedAt
    ? 'merged'
    : worker?.mergeError
      ? 'closed'
      : 'open';

  return {
    prNumber,
    url: repoWebUrl ? `${repoWebUrl}/pull/${prNumber}` : undefined,
    state,
  };
}
