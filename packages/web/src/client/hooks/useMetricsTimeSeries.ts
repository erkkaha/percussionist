import { useQuery } from '@tanstack/react-query';
import { authHeaders } from '../lib/auth';

export interface TimeSeriesPoint {
  recordedAt: string;
  cpuPct: number;
  memPct: number;
}

export interface RunWindow {
  name: string;
  agent: string;
  task: string;
  startedAt: string;
  completedAt: string;
}

interface MetricsTimeSeriesResponse {
  dataPoints: TimeSeriesPoint[];
  runWindows: RunWindow[];
  nodeBuckets: Record<string, TimeSeriesPoint[]>;
}

export function useMetricsTimeSeries(
  hours = 1,
  node = 'all',
  refetchInterval: number | false = 60_000,
) {
  return useQuery<MetricsTimeSeriesResponse>({
    queryKey: ['metrics-timeseries', hours, node],
    queryFn: async () => {
      const params = new URLSearchParams({ hours: String(hours), node });
      const res = await fetch(`/api/stats/metrics-timeseries?${params}`, {
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'unavailable' }));
        throw new Error(body.error ?? 'metrics timeseries unavailable');
      }
      return res.json() as Promise<MetricsTimeSeriesResponse>;
    },
    refetchInterval,
  });
}
