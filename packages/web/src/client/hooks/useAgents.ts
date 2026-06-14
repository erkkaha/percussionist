import { useQuery } from '@tanstack/react-query';
import { fetchAgents } from '../lib/api';
import type { AgentCapability } from '../lib/types';

interface AgentListItem {
  name: string;
  content: string;
  model?: string;
  capabilities?: AgentCapability[];
}

export function useAgents(refetchInterval: number | false = 10_000) {
  return useQuery<AgentListItem[], Error>({
    queryKey: ['agents'],
    queryFn: fetchAgents,
    refetchInterval,
  });
}
