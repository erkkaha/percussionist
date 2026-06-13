import { useQuery } from '@tanstack/react-query';
import { fetchTaskEvents } from '../lib/api';

export interface TaskEvent {
  id: number;
  project: string;
  taskName: string;
  taskType: string;
  eventType: string;
  payload: string;
  createdAt: string;
}

export function useTaskEvents(projectName: string | null, taskName: string | null) {
  return useQuery<TaskEvent[], Error>({
    queryKey: ['taskEvents', projectName, taskName],
    queryFn: () => fetchTaskEvents(projectName ?? '', taskName ?? ''),
    enabled: !!projectName && !!taskName,
    refetchInterval: 10_000,
  });
}
