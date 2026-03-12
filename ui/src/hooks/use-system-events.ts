import * as React from "react";
import {
  openFridaySystemEventStream,
  type FridaySystemEvent,
  type FridaySystemEventConnectionState,
} from "@friday-operator-client";
import { authStorage } from "@/lib/storage/auth-storage";
import { apiClient } from "@/lib/api/client";

export interface UseSystemEventsResult {
  connectionState: FridaySystemEventConnectionState;
  events: FridaySystemEvent[];
  errorMessage?: string;
  reconnect: () => void;
}

const BACKOFF_MS = [500, 1000, 2000, 5000];

export function useSystemEvents(enabled = true): UseSystemEventsResult {
  const [events, setEvents] = React.useState<FridaySystemEvent[]>([]);
  const [connectionState, setConnectionState] = React.useState<UseSystemEventsResult["connectionState"]>("idle");
  const [errorMessage, setErrorMessage] = React.useState<string | undefined>();
  const [reconnectKey, setReconnectKey] = React.useState(0);
  const retryCountRef = React.useRef(0);
  const afterSeqRef = React.useRef<number | undefined>(undefined);

  const reconnect = React.useCallback(() => {
    setReconnectKey((value) => value + 1);
  }, []);

  React.useEffect(() => {
    if (!enabled) {
      setConnectionState("idle");
      return;
    }

    const controller = new AbortController();

    async function connect(): Promise<void> {
      setErrorMessage(undefined);

      try {
        await openFridaySystemEventStream({
          afterSeq: afterSeqRef.current,
          fetchFn: fetch,
          getAccessToken: () => authStorage.getAccessToken() ?? undefined,
          refreshSession: () => apiClient.refreshSession(),
          signal: controller.signal,
          onConnectionState: (state) => {
            setConnectionState(state);
            if (state === "streaming") {
              retryCountRef.current = 0;
            }
          },
          onError: (message) => {
            setErrorMessage(message);
          },
          onEvent: (parsed) => {
            setEvents((previous) => {
              if (previous.some((item) => item.id === parsed.id)) {
                return previous;
              }
              afterSeqRef.current = parsed.seq;
              return [...previous, parsed];
            });
          },
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setConnectionState("error");
        setErrorMessage(error instanceof Error ? error.message : "System event stream disconnected");
        const delay = BACKOFF_MS[Math.min(retryCountRef.current, BACKOFF_MS.length - 1)];
        retryCountRef.current += 1;
        window.setTimeout(() => {
          if (!controller.signal.aborted) {
            void connect();
          }
        }, delay);
      }
    }

    void connect();

    return () => {
      controller.abort();
    };
  }, [enabled, reconnectKey]);

  return {
    connectionState,
    events,
    errorMessage,
    reconnect,
  };
}
