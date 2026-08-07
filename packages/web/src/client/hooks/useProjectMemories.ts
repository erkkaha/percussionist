import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createProjectMemory,
  deleteProjectMemory,
  fetchMemoryHealth,
  fetchProjectMemories,
  updateProjectMemory,
} from '../lib/api';
import type { CreateMemoryRequest, UpdateMemoryRequest } from '../lib/types';

const QUERY_KEY = ['project-memories'];

function requireProject(project: string | undefined): string {
  if (!project) throw new Error('Project is required');
  return project;
}

export function useProjectMemories(project: string | undefined) {
  return useQuery({
    queryKey: [...QUERY_KEY, project],
    queryFn: () => fetchProjectMemories(requireProject(project)),
    enabled: !!project,
  });
}

/**
 * Whether the project's memory service can actually embed anything.
 *
 * Memory depends on Ollama, which is an opt-in add-on rather than part of the
 * control plane — so memory can be enabled on a project while nothing is able
 * to generate embeddings. Without this the dashboard showed an empty list and
 * gave no hint that the feature was inert.
 */
export function useMemoryHealth(project: string | undefined) {
  return useQuery({
    queryKey: [...QUERY_KEY, project, 'health'],
    queryFn: () => fetchMemoryHealth(requireProject(project)),
    enabled: !!project,
    // Cheap, and the answer changes the moment the add-on is deployed.
    refetchInterval: 30_000,
  });
}

export function useCreateMemory(project: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateMemoryRequest) => createProjectMemory(requireProject(project), req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...QUERY_KEY, project] });
    },
  });
}

export function useUpdateMemory(project: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, req }: { id: string; req: UpdateMemoryRequest }) =>
      updateProjectMemory(requireProject(project), id, req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...QUERY_KEY, project] });
    },
  });
}

export function useDeleteMemory(project: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteProjectMemory(requireProject(project), id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...QUERY_KEY, project] });
    },
  });
}
