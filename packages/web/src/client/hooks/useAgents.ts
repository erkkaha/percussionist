import { useQuery } from "@tanstack/react-query";
import { fetchAgents } from "../lib/api";

interface AgentListItem {
  name: string;
  content: string;
}

export function useAgents(
  refetchInterval: number | false = 10_000,
  eventTick: number = 0,
) {
  return useQuery<AgentListItem[], Error>({
    queryKey: ["agents", eventTick],
    queryFn: fetchAgents,
    refetchInterval,
  });
}
