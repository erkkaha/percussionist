import { useCollectionEvents } from "./useCollectionEvents";

export function useMetricsEvents(enabled = true): { connected: boolean; eventTick: number } {
  return useCollectionEvents({
    url: "/api/metrics/events",
    eventName: "metrics.updated",
    queryKey: ["metrics"],
    enabled,
  });
}
