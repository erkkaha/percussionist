import { useCollectionEvents } from "./useCollectionEvents";

export function useProjectsEvents(enabled = true): { connected: boolean; eventTick: number } {
  return useCollectionEvents({
    url: "/api/projects/events",
    eventName: "projects.updated",
    queryKey: ["projects"],
    enabled,
  });
}
