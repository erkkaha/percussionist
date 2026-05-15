import { useCollectionEvents } from "./useCollectionEvents";

export function useRunEvents(name: string, enabled: boolean): { connected: boolean; eventTick: number } {
  return useCollectionEvents({
    url: `/api/runs/${encodeURIComponent(name)}/events`,
    eventNames: ["message.updated", "permission.updated", "session.idle"],
    invalidateQuery: false,
    enabled,
  });
}
