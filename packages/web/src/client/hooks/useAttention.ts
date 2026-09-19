import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { fetchAttention } from '../lib/api';
import type { AttentionResponse } from '../lib/types';

/**
 * Server-authoritative "Needs attention" inbox.
 *
 * Polls GET /api/attention every 15s and refetches on window focus so the
 * sidebar badge, bell entry and /attention page all agree with Web Push even
 * when a notification fired while no tab was open. The request goes through the
 * shared authenticated fetch wrapper (`fetchJSON` → `authHeaders`), so the
 * session cookie rides along and a 401 bounces to /login like every other hook.
 *
 * Pass `eventTick` from a collection-events hook (e.g. `useRunsEvents`) to
 * invalidate immediately on server-pushed updates instead of waiting for the
 * next poll, matching the SSE invalidation pattern used by BoardView.
 */
export function useAttention(eventTick = 0) {
  const queryClient = useQueryClient();

  const query = useQuery<AttentionResponse, Error>({
    queryKey: ['attention'],
    queryFn: fetchAttention,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (eventTick > 0) {
      void queryClient.invalidateQueries({ queryKey: ['attention'] });
    }
  }, [eventTick, queryClient]);

  return query;
}
