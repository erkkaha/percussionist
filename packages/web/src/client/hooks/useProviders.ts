import { useQuery } from '@tanstack/react-query';
import type { ProvidersResponse } from '../lib/api';
import { fetchProviders } from '../lib/api';

export function useProviders() {
  return useQuery<ProvidersResponse, Error>({
    queryKey: ['providers'],
    queryFn: fetchProviders,
    // Provider list changes rarely — refresh every 60s, keep stale data visible.
    staleTime: 60_000,
    refetchInterval: 60_000,
    // Don't retry aggressively — opencode sidecar may not be reachable in dev.
    retry: 1,
  });
}
