import { useCollectionEvents } from "./useCollectionEvents";

export function useBoardEvents(projectName: string, enabled: boolean): { connected: boolean; eventTick: number } {
  return useCollectionEvents({
    url: `/api/projects/${encodeURIComponent(projectName)}/board/events`,
    eventNames: ["board.updated", "board.error"],
    invalidateQuery: false,
    enabled,
  });
}
