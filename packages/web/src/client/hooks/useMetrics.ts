import { useQuery } from "@tanstack/react-query";
import { authHeaders } from "../lib/auth";

interface ContainerUsage {
  name: string;
  usage: { cpu: string; memory: string };
}

export interface PodMetricRow {
  name: string;
  namespace: string;
  timestamp: string;
  window: string;
  containers: ContainerUsage[];
  totalCpuMillicores: number;
  totalMemoryBytes: number;
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
}

function parseCpu(raw: string): number {
  const n = parseInt(raw, 10);
  if (raw.endsWith("n")) return Math.round(n / 1_000_000);
  if (raw.endsWith("u")) return Math.round(n / 1_000);
  if (raw.endsWith("m")) return n;
  return n * 1000;
}

function parseMemory(raw: string): number {
  const n = parseInt(raw, 10);
  if (raw.endsWith("Ki")) return n * 1024;
  if (raw.endsWith("Mi")) return n * 1024 * 1024;
  if (raw.endsWith("Gi")) return n * 1024 * 1024 * 1024;
  return n;
}

export function useMetrics(refetchInterval: number | false = 15_000) {
  return useQuery<{ nodes: NodeMetricRow[]; pods: PodMetricRow[] }>({
    queryKey: ["metrics"],
    queryFn: async () => {
      const [nodesRes, podsRes] = await Promise.all([
        fetch("/api/metrics/nodes", { headers: authHeaders() }),
        fetch("/api/metrics/pods", { headers: authHeaders() }),
      ]);

      if (!nodesRes.ok && !podsRes.ok) {
        const nodeErr = await nodesRes.json().catch(() => ({ error: "unavailable" }));
        throw new Error(nodeErr.error ?? "metrics unavailable");
      }

      const nodesData = nodesRes.ok ? (await nodesRes.json() as { items: Array<{ name: string; timestamp: string; window: string; usage: { cpu: string; memory: string }; capacity: { cpu: string; memory: string } | null }> }) : { items: [] };
      const podsData = podsRes.ok ? (await podsRes.json() as { items: Array<{ name: string; namespace: string; timestamp: string; window: string; containers: ContainerUsage[] }> }) : { items: [] };

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
      }));

      const pods: PodMetricRow[] = podsData.items.map((p) => {
        const totalCpuMillicores = p.containers.reduce((sum, c) => sum + parseCpu(c.usage.cpu), 0);
        const totalMemoryBytes = p.containers.reduce((sum, c) => sum + parseMemory(c.usage.memory), 0);
        return {
          name: p.name,
          namespace: p.namespace,
          timestamp: p.timestamp,
          window: p.window,
          containers: p.containers,
          totalCpuMillicores,
          totalMemoryBytes,
        };
      });

      return { nodes, pods };
    },
    refetchInterval,
  });
}
