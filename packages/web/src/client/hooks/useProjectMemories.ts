import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createProjectMemory,
  deleteProjectMemory,
  fetchProjectMemories,
  updateProjectMemory,
} from '../lib/api';
import type { CreateMemoryRequest, UpdateMemoryRequest } from '../lib/types';

const QUERY_KEY = ['project-memories'];

export function useProjectMemories(project: string | undefined) {
  return useQuery({
    queryKey: [...QUERY_KEY, project],
    queryFn: () => fetchProjectMemories(project!),
    enabled: !!project,
  });
}

export function useCreateMemory(project: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateMemoryRequest) => createProjectMemory(project!, req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...QUERY_KEY, project] });
    },
  });
}

export function useUpdateMemory(project: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, req }: { id: string; req: UpdateMemoryRequest }) =>
      updateProjectMemory(project!, id, req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...QUERY_KEY, project] });
    },
  });
}

export function useDeleteMemory(project: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteProjectMemory(project!, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...QUERY_KEY, project] });
    },
  });
}
