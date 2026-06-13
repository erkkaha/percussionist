import { useQuery } from '@tanstack/react-query';
import { fetchAgent } from '../lib/api';
import type { ClusterAgent } from '../lib/types';

export function useAgent(name: string, refetchInterval = 0) {
  return useQuery<ClusterAgent, Error>({
    queryKey: ['agent', name],
    queryFn: () => fetchAgent(name),
    enabled: !!name && refetchInterval === 0,
    refetchOnWindowFocus: false,
  });
}
