import { EventSourceParserStream } from "eventsource-parser/stream";

import type { FridaySystemEvent } from "./system-types";

export type FridaySystemEventConnectionState =
  | "idle"
  | "connecting"
  | "streaming"
  | "closed"
  | "error";

export interface FridaySystemEventStreamOptions {
  getAccessToken?: () => string | undefined;
  refreshSession?: () => Promise<void>;
  fetchFn?: typeof fetch;
  path?: string;
  afterSeq?: number;
  signal?: AbortSignal;
  onConnectionState?: (state: FridaySystemEventConnectionState) => void;
  onError?: (message: string) => void;
  onEvent: (event: FridaySystemEvent) => void;
}

export async function openFridaySystemEventStream(
  options: FridaySystemEventStreamOptions,
): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
  };
  const token = options.getAccessToken?.();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const params = new URLSearchParams();
  if (options.afterSeq !== undefined) {
    params.set("afterSeq", String(options.afterSeq));
  }
  const path = options.path
    ?? (params.size > 0 ? `/v1/system/events?${params.toString()}` : "/v1/system/events");

  options.onConnectionState?.("connecting");
  const response = await fetchFn(path, {
    headers,
    signal: options.signal,
  });

  if (response.status === 401 && token && options.refreshSession) {
    await options.refreshSession();
    return openFridaySystemEventStream({
      ...options,
      fetchFn,
    });
  }

  if (!response.ok || !response.body) {
    const message = `HTTP ${response.status}`;
    options.onConnectionState?.("error");
    options.onError?.(message);
    throw new Error(message);
  }

  options.onConnectionState?.("streaming");

  const stream = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream());
  const reader = stream.getReader();

  while (!options.signal?.aborted) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value.data) {
      continue;
    }
    try {
      options.onEvent(JSON.parse(value.data) as FridaySystemEvent);
    } catch {
      // Ignore malformed keepalive frames or partial payloads.
    }
  }

  if (!options.signal?.aborted) {
    options.onConnectionState?.("closed");
  }
}
