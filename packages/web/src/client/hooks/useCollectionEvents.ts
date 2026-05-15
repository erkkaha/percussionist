import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSseSubscription } from "./useSseSubscription";

interface UseCollectionEventsOptions {
  url: string;
  eventName?: string;
  eventNames?: string[];
  queryKey?: readonly unknown[];
  invalidateQuery?: boolean;
  enabled?: boolean;
}

export function useCollectionEvents({
  url,
  eventName,
  eventNames,
  queryKey,
  invalidateQuery,
  enabled = true,
}: UseCollectionEventsOptions): { connected: boolean; eventTick: number } {
  const queryClient = useQueryClient();
  const [eventTick, setEventTick] = useState(0);
  const queryKeyRef = useRef<readonly unknown[] | undefined>(queryKey);
  queryKeyRef.current = queryKey;
  const shouldInvalidate = invalidateQuery ?? !!queryKey;

  const names = useMemo(() => {
    if (eventNames && eventNames.length > 0) return eventNames;
    if (eventName) return [eventName];
    return [];
  }, [eventName, eventNames]);

  const onEvent = useCallback(() => {
    setEventTick((n) => n + 1);
    if (shouldInvalidate && queryKeyRef.current) {
      queryClient.invalidateQueries({ queryKey: queryKeyRef.current });
    }
  }, [queryClient, shouldInvalidate]);

  const connected = useSseSubscription({
    url,
    eventNames: names,
    enabled,
    onEvent,
  });

  return { connected, eventTick };
}
