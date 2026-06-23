// lib/diff-findings.ts — shared helpers for Task diff findings UI.

import { normalizeRepoPath } from '@percussionist/api';
import type { DiffFindingSeverity, TaskDiffFinding } from './types';

export const DIFF_FINDING_SEVERITIES: DiffFindingSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

export const SEVERITY_RANK: Record<DiffFindingSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export const SEVERITY_LABEL: Record<DiffFindingSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

export const SEVERITY_DOT_CLASS: Record<DiffFindingSeverity, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-blue-500',
  info: 'bg-gray-500',
};

export const SEVERITY_TEXT_CLASS: Record<DiffFindingSeverity, string> = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  medium: 'text-yellow-400',
  low: 'text-blue-400',
  info: 'text-gray-400',
};

export const SEVERITY_BG_CLASS: Record<DiffFindingSeverity, string> = {
  critical: 'bg-red-500/15 text-red-400 border-red-500/30',
  high: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  medium: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  low: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  info: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
};

export type DiffFindingSort = 'severity' | 'score' | 'path' | 'line';

/**
 * Kept as a named export for backwards compatibility with existing imports.
 * Delegates to the canonical implementation in `@percussionist/api`.
 */
export function normalizeAnchorPath(path: string): string {
  return normalizeRepoPath(path);
}

export function countBySeverity(findings: TaskDiffFinding[]): Record<DiffFindingSeverity, number> {
  const counts: Record<DiffFindingSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const f of findings) {
    counts[f.severity]++;
  }
  return counts;
}

export function sortFindings(
  findings: TaskDiffFinding[],
  sort: DiffFindingSort,
): TaskDiffFinding[] {
  const firstAnchor = (f: TaskDiffFinding) => f.anchors[0];

  const compare = (a: TaskDiffFinding, b: TaskDiffFinding): number => {
    switch (sort) {
      case 'severity': {
        const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
        if (sev !== 0) return sev;
        break;
      }
      case 'score': {
        const score = (b.score ?? 0) - (a.score ?? 0);
        if (score !== 0) return score;
        break;
      }
      case 'path': {
        const path = (firstAnchor(a)?.path ?? '').localeCompare(firstAnchor(b)?.path ?? '');
        if (path !== 0) return path;
        break;
      }
      case 'line': {
        const line = (firstAnchor(a)?.line ?? 0) - (firstAnchor(b)?.line ?? 0);
        if (line !== 0) return line;
        break;
      }
    }

    // Stable fallback: severity desc, score desc, path asc, line asc.
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    const score = (b.score ?? 0) - (a.score ?? 0);
    if (score !== 0) return score;
    const path = (firstAnchor(a)?.path ?? '').localeCompare(firstAnchor(b)?.path ?? '');
    if (path !== 0) return path;
    return (firstAnchor(a)?.line ?? 0) - (firstAnchor(b)?.line ?? 0);
  };

  return [...findings].sort(compare);
}
