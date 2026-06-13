import { useQuery } from '@tanstack/react-query';
import { fetchTaskDiff } from '../lib/api';
import type { TaskDiffResponse } from '../lib/types';

export function useTaskDiff(projectName: string | null, taskName: string | null, enabled = true) {
  return useQuery<TaskDiffResponse, Error>({
    queryKey: ['taskDiff', projectName, taskName],
    queryFn: () => fetchTaskDiff(projectName ?? '', taskName ?? ''),
    enabled: enabled && !!projectName && !!taskName,
    staleTime: 30_000,
  });
}
