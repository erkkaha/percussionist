import { useQuery } from '@tanstack/react-query';
import { fetchSessionStat } from '../lib/api';
import type { StatSession } from '../lib/types';

/**
 * Fetch a session's stats-DB row by run name. The DB row outlives the Run CR
 * (deleted after runTTLDays), so this is the durable source of truth for the
 * session detail page — the live Run CR is only enrichment on top. No retry:
 * a missing row is a deterministic 404, and the page can still render from the
 * Run CR when that exists.
 */
export function useSessionStat(name: string) {
  return useQuery<StatSession, Error>({
    queryKey: ['session-stat', name],
    queryFn: () => fetchSessionStat(name),
    retry: false,
  });
}
