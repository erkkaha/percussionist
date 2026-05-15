import { useCollectionEvents } from "./useCollectionEvents";

export function useRunsEvents(enabled = true): { connected: boolean; eventTick: number } {
  return useCollectionEvents({
    url: "/api/runs/events",
    eventName: "runs.updated",
    queryKey: ["runs"],
    enabled,
  });
}
