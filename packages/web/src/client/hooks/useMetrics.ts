import { useQuery } from '@tanstack/react-query';
import { authHeaders } from '../lib/auth';

interface ContainerUsage {
  name: string;
  usage: { cpu: string; memory: string };
  requests: { cpu: string; memory: string; storage: number | null } | null;
  limits: { cpu: string; memory: string; storage: number | null } | null;
}

export interface PodMetricRow {
  name: string;
  namespace: string;
  timestamp: string;
  window: string;
  containers: ContainerUsage[];
  totalCpuMillicores: number;
  totalMemoryBytes: number;
  totalCpuRequest: number;
  totalMemoryRequest: number;
  totalCpuLimit: number;
  totalMemoryLimit: number;
  totalStorageRequestBytes: number | null;
  totalStorageLimitBytes: number | null;
}

export interface NodeMetricRow {
  name: string;
  timestamp: string;
  window: string;
  usage: { cpu: string; memory: string };
  cpuMillicores: number;
  memoryBytes: number;
  capacity: { cpu: string; memory: string } | null;
  capacityCpuMillicores: number;
  capacityMemoryBytes: number;
  allocatable: { cpu: string; memory: string } | null;
  allocatableCpuMillicores: number;
  allocatableMemoryBytes: number;
  allocated: { cpu: string; memory: string } | null;
  allocatedCpuMillicores: number;
  allocatedMemoryBytes: number;
  volume: {
    usedBytes: number | null;
    capacityBytes: number | null;
    availableBytes: number | null;
  } | null;
}

function parseCpu(raw: string): number {
  const n = parseInt(raw, 10);
  if (raw.endsWith('n')) return Math.round(n / 1_000_000);
  if (raw.endsWith('u')) return Math.round(n / 1_000);
  if (raw.endsWith('m')) return n;
  return n * 1000;
}

function parseMemory(raw: string): number {
  const n = parseInt(raw, 10);
  if (raw.endsWith('Ki')) return n * 1024;
  if (raw.endsWith('Mi')) return n * 1024 * 1024;
  if (raw.endsWith('Gi')) return n * 1024 * 1024 * 1024;
  return n;
}

/** Parse a Kubernetes storage quantity string to bytes. Handles Ki/Mi/Gi/Ti and plain integers. */
function parseStorageBytes(raw: string): number {
  const n = parseInt(raw, 10);
  if (raw.endsWith('Ki')) return n * 1024;
  if (raw.endsWith('Mi')) return n * 1024 * 1024;
  if (raw.endsWith('Gi')) return n * 1024 * 1024 * 1024;
  if (raw.endsWith('Ti')) return n * 1024 * 1024 * 1024 * 1024;
  // Plain integer — treat as bytes.
  return n;
}

export function useMetrics(refetchInterval: number | false = 15_000) {
  return useQuery<{ nodes: NodeMetricRow[]; pods: PodMetricRow[] }>({
    queryKey: ['metrics'],
    queryFn: async () => {
      const [nodesRes, podsRes] = await Promise.all([
        fetch('/api/metrics/nodes', { headers: authHeaders() }),
        fetch('/api/metrics/pods', { headers: authHeaders() }),
      ]);

      if (!nodesRes.ok && !podsRes.ok) {
        const nodeErr = await nodesRes.json().catch(() => ({ error: 'unavailable' }));
        throw new Error(nodeErr.error ?? 'metrics unavailable');
      }

      const nodesData = nodesRes.ok
        ? ((await nodesRes.json()) as {
            items: Array<{
              name: string;
              timestamp: string;
              window: string;
              usage: { cpu: string; memory: string };
              capacity: { cpu: string; memory: string } | null;
              allocatable: { cpu: string; memory: string } | null;
              allocated: { cpu: string; memory: string } | null;
              volume: {
                usedBytes: number | null;
                capacityBytes: number | null;
                availableBytes: number | null;
              } | null;
            }>;
          })
        : { items: [] };
      const podsData = podsRes.ok
        ? ((await podsRes.json()) as {
            items: Array<{
              name: string;
              namespace: string;
              timestamp: string;
              window: string;
              containers: ContainerUsage[];
              podRequests: { cpu: string; memory: string; storage: number | null } | null;
              podLimits: { cpu: string; memory: string; storage: number | null } | null;
            }>;
          })
        : { items: [] };

      const nodes: NodeMetricRow[] = nodesData.items.map((n) => ({
        name: n.name,
        timestamp: n.timestamp,
        window: n.window,
        usage: n.usage,
        cpuMillicores: parseCpu(n.usage.cpu),
        memoryBytes: parseMemory(n.usage.memory),
        capacity: n.capacity,
        capacityCpuMillicores: n.capacity ? parseCpu(n.capacity.cpu) : 0,
        capacityMemoryBytes: n.capacity ? parseMemory(n.capacity.memory) : 0,
        allocatable: n.allocatable,
        allocatableCpuMillicores: n.allocatable ? parseCpu(n.allocatable.cpu) : 0,
        allocatableMemoryBytes: n.allocatable ? parseMemory(n.allocatable.memory) : 0,
        allocated: n.allocated,
        allocatedCpuMillicores: n.allocated ? parseCpu(n.allocated.cpu) : 0,
        allocatedMemoryBytes: n.allocated ? parseMemory(n.allocated.memory) : 0,
        volume: n.volume,
      }));

      const pods: PodMetricRow[] = podsData.items.map((p) => {
        const totalCpuMillicores = p.containers.reduce((sum, c) => sum + parseCpu(c.usage.cpu), 0);
        const totalMemoryBytes = p.containers.reduce(
          (sum, c) => sum + parseMemory(c.usage.memory),
          0,
        );
        const totalCpuRequest = p.podRequests ? parseCpu(p.podRequests.cpu) : 0;
        const totalMemoryRequest = p.podRequests ? parseMemory(p.podRequests.memory) : 0;
        const totalCpuLimit = p.podLimits ? parseCpu(p.podLimits.cpu) : 0;
        const totalMemoryLimit = p.podLimits ? parseMemory(p.podLimits.memory) : 0;
        const totalStorageRequestBytes = p.podRequests?.storage ?? null;
        const totalStorageLimitBytes = p.podLimits?.storage ?? null;
        return {
          name: p.name,
          namespace: p.namespace,
          timestamp: p.timestamp,
          window: p.window,
          containers: p.containers,
          totalCpuMillicores,
          totalMemoryBytes,
          totalCpuRequest,
          totalMemoryRequest,
          totalCpuLimit,
          totalMemoryLimit,
          totalStorageRequestBytes,
          totalStorageLimitBytes,
        };
      });

      return { nodes, pods };
    },
    refetchInterval,
  });
}
