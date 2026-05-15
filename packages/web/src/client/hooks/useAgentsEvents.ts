import { useCollectionEvents } from "./useCollectionEvents";

export function useAgentsEvents(enabled = true): { connected: boolean; eventTick: number } {
  return useCollectionEvents({
    url: "/api/agents/events",
    eventName: "agents.updated",
    queryKey: ["agents"],
    enabled,
  });
}
