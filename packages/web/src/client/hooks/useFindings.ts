import { useMutation, useQueryClient } from '@tanstack/react-query';
import { promoteFindingToTask, updateFinding } from '../lib/api';
import type { UpdateFindingRequest } from '../lib/types';

function requireProject(project: string | undefined): string {
  if (!project) throw new Error('Project is required');
  return project;
}

/**
 * Update a finding's status/severity/category. On success the board query is
 * invalidated so the Findings panel reflects the change without a manual
 * refresh (mirrors useProjectMemories' update mutation).
 */
export function useUpdateFinding(project: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, req }: { id: string; req: UpdateFindingRequest }) =>
      updateFinding(requireProject(project), id, req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['board', project] });
    },
  });
}

/**
 * Promote a finding to a Task CR. On success the board query is invalidated so
 * the finding re-renders showing its `Task: <taskRef>` link without a manual
 * refresh (mirrors useUpdateFinding).
 */
export function usePromoteFindingToTask(project: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      opts,
    }: {
      id: string;
      opts?: { agent?: string; priority?: 'high' | 'medium' | 'low' };
    }) => promoteFindingToTask(requireProject(project), id, opts),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['board', project] });
    },
  });
}
