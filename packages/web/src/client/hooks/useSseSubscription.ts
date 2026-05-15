import { useEffect, useRef, useState } from "react";

interface UseSseSubscriptionOptions {
  url: string;
  eventNames: string[];
  enabled?: boolean;
  onEvent: () => void;
}

const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 15_000;

export function useSseSubscription({
  url,
  eventNames,
  enabled = true,
  onEvent,
}: UseSseSubscriptionOptions): boolean {
  const [connected, setConnected] = useState(false);
  const retryDelayRef = useRef(MIN_RETRY_MS);
  const reconnectTimerRef = useRef<number | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const eventNamesRef = useRef(eventNames);
  eventNamesRef.current = eventNames;
  const eventNamesKey = eventNames.join("\u0000");
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled || !url) {
      setConnected(false);
      return;
    }

    let stopped = false;

    const clearReconnect = () => {
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const closeSource = () => {
      if (!sourceRef.current) return;
      sourceRef.current.close();
      sourceRef.current = null;
    };

    const scheduleReconnect = () => {
      if (stopped) return;
      clearReconnect();
      const delay = retryDelayRef.current;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
      retryDelayRef.current = Math.min(retryDelayRef.current * 2, MAX_RETRY_MS);
    };

    const connect = () => {
      if (stopped) return;
      closeSource();

      const src = new EventSource(url);
      sourceRef.current = src;

      src.onopen = () => {
        if (stopped) return;
        setConnected(true);
        retryDelayRef.current = MIN_RETRY_MS;
      };

      const handler = () => {
        if (stopped) return;
        onEventRef.current();
      };

      for (const eventName of eventNamesRef.current) {
        src.addEventListener(eventName, handler);
      }

      src.onerror = () => {
        if (stopped) return;
        setConnected(false);
        closeSource();
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      stopped = true;
      setConnected(false);
      clearReconnect();
      closeSource();
    };
  }, [enabled, eventNamesKey, url]);

  return connected;
}
