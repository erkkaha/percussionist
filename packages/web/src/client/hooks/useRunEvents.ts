import { useCollectionEvents } from './useCollectionEvents';

export function useRunEvents(
  name: string,
  enabled: boolean,
): { connected: boolean; eventTick: number } {
  return useCollectionEvents({
    url: `/api/runs/${encodeURIComponent(name)}/session/events`,
    eventNames: ['message.updated', 'permission.updated', 'session.idle'],
    queryKeys: [
      ['session', name],
      ['logs', name],
    ],
    enabled,
  });
}
