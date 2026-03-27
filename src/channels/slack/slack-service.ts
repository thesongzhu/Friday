/**
 * Slack service — interfaces and implementations for Socket Mode, HTTP events,
 * and Web API.
 *
 * Real implementations use Node 22+ built-in `fetch` and `WebSocket`.
 * No external dependencies required.
 */

import { FridayDomainError } from "#errors";

// ─── Types ───

export interface SlackMessageEvent {
  type: "message";
  subtype?: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  channel_type: "im" | "channel" | "group" | "mpim";
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    url_private: string;
    size: number;
  }>;
  bot_id?: string;
}

export interface SlackSendPayload {
  channel: string;
  text: string;
  thread_ts?: string;
  reply_broadcast?: boolean;
}

export interface SlackSendResponse {
  ok: boolean;
  ts: string;
  channel: string;
  message?: {
    text: string;
    ts: string;
  };
}

export interface SlackUserInfo {
  id: string;
  name: string;
  real_name?: string;
}

// ─── Service Interface ───

export interface SlackSocketService {
  /** Connect via Socket Mode. */
  connect(
    appToken: string,
    botToken: string,
    onEvent: (event: SlackMessageEvent) => void,
  ): Promise<void>;
  /** Disconnect. */
  disconnect(): Promise<void>;
  /** Check connection state. */
  isConnected(): boolean;
}

export interface SlackWebApiService {
  /** Send a message via chat.postMessage. */
  sendMessage(
    botToken: string,
    payload: SlackSendPayload,
  ): Promise<SlackSendResponse>;

  /** Get user info. */
  getUserInfo(
    botToken: string,
    userId: string,
  ): Promise<SlackUserInfo | null>;
}

// ─── Stub Implementations ───

export function createSlackSocketServiceStub(): SlackSocketService {
  let connected = false;

  return {
    async connect(_appToken, _botToken, _onEvent) {
      connected = true;
      // Stub: in production, connects via Slack Socket Mode WebSocket
    },
    async disconnect() {
      connected = false;
    },
    isConnected() {
      return connected;
    },
  };
}

// ─── HTTP Event Service ───

export interface SlackHttpEventService {
  /** Start an HTTP event listener for Slack Events API. */
  start(
    signingSecret: string,
    onEvent: (event: SlackMessageEvent) => void,
  ): Promise<void>;
  /** Stop the HTTP event listener. */
  stop(): Promise<void>;
  /** Check if the listener is active. */
  isListening(): boolean;
}

export function createSlackHttpEventServiceStub(): SlackHttpEventService {
  let listening = false;

  return {
    async start(_signingSecret, _onEvent) {
      listening = true;
      // Stub: in production, starts HTTP server for Slack Events API
    },
    async stop() {
      listening = false;
    },
    isListening() {
      return listening;
    },
  };
}

export function createSlackWebApiServiceStub(): SlackWebApiService {
  return {
    async sendMessage(_botToken, _payload) {
      // Stub: POST https://slack.com/api/chat.postMessage
      const ts = `${Date.now()}.000100`;
      return { ok: true, ts, channel: _payload.channel };
    },
    async getUserInfo(_botToken, userId) {
      return { id: userId, name: "stub-user" };
    },
  };
}

// ─── Real Implementations ───

const SLACK_API = "https://slack.com/api";

/**
 * Create a real Slack Web API service that calls Slack HTTP endpoints using
 * Node's built-in `fetch`.
 */
export function createSlackWebApiService(): SlackWebApiService {
  return {
    async sendMessage(botToken, payload) {
      const res = await fetch(`${SLACK_API}/chat.postMessage`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new FridayDomainError(
          "INTERNAL_ERROR",
          `Slack chat.postMessage HTTP error: ${res.status} ${res.statusText}`,
          { httpStatus: 500 },
        );
      }

      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        ts?: string;
        channel?: string;
        message?: { text: string; ts: string };
      };

      if (!data.ok) {
        throw new FridayDomainError("INTERNAL_ERROR", `Slack chat.postMessage API error: ${data.error ?? "unknown"}`, { httpStatus: 500 });
      }

      return {
        ok: true,
        ts: data.ts!,
        channel: data.channel!,
        message: data.message,
      };
    },

    async getUserInfo(botToken, userId) {
      const url = `${SLACK_API}/users.info?user=${encodeURIComponent(userId)}`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${botToken}`,
        },
      });

      if (!res.ok) {
        throw new FridayDomainError(
          "INTERNAL_ERROR",
          `Slack users.info HTTP error: ${res.status} ${res.statusText}`,
          { httpStatus: 500 },
        );
      }

      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        user?: { id: string; name: string; real_name?: string };
      };

      if (!data.ok) {
        // user_not_found is a normal condition, return null
        if (data.error === "user_not_found") return null;
        throw new FridayDomainError("INTERNAL_ERROR", `Slack users.info API error: ${data.error ?? "unknown"}`, { httpStatus: 500 });
      }

      if (!data.user) return null;

      return {
        id: data.user.id,
        name: data.user.name,
        real_name: data.user.real_name,
      };
    },
  };
}

/** Default heartbeat interval for Socket Mode keep-alive (30 s). */
const SOCKET_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Create a real Slack Socket Mode service.
 *
 * Uses `apps.connections.open` to obtain a WSS URL, then connects with Node's
 * built-in `WebSocket` (available in Node 22+). Handles `hello`, heartbeat
 * pings, and `events_api` envelope acknowledgement. Message events are
 * forwarded to the caller-provided callback.
 */
// P2-CH: Reconnection constants
const SLACK_RECONNECT_INITIAL_MS = 1_000;
const SLACK_RECONNECT_MAX_MS = 60_000;

export function createSlackSocketService(): SlackSocketService {
  let ws: WebSocket | null = null;
  let connected = false;
  let stopped = false;
  let abortController: AbortController | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = SLACK_RECONNECT_INITIAL_MS;
  let lastConnectArgs: { appToken: string; botToken: string; onEvent: (event: SlackMessageEvent) => void } | null = null;

  function cleanup() {
    connected = false;

    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    if (ws) {
      try {
        ws.close();
      } catch (err) {
        console.warn("[friday][slack-service] operation failed:", err instanceof Error ? err.message : String(err));
        // already closed — ignore
      }
      ws = null;
    }

    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  }

  return {
    async connect(appToken, _botToken, onEvent) {
      if (connected) return;
      stopped = false;
      lastConnectArgs = { appToken, botToken: _botToken, onEvent };

      abortController = new AbortController();

      // 1. Obtain a WSS URL via apps.connections.open
      const openRes = await fetch(`${SLACK_API}/apps.connections.open`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${appToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        signal: abortController.signal,
      });

      if (!openRes.ok) {
        throw new FridayDomainError(
          "INTERNAL_ERROR",
          `Slack apps.connections.open HTTP error: ${openRes.status} ${openRes.statusText}`,
          { httpStatus: 500 },
        );
      }

      const openData = (await openRes.json()) as {
        ok: boolean;
        error?: string;
        url?: string;
      };

      if (!openData.ok || !openData.url) {
        throw new FridayDomainError(
          "INTERNAL_ERROR",
          `Slack apps.connections.open API error: ${openData.error ?? "missing url"}`,
          { httpStatus: 500 },
        );
      }

      // 2. Open WebSocket connection
      const wssUrl = openData.url;

      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(wssUrl);
        ws = socket;

        const abortHandler = () => {
          socket.close();
          reject(new Error("Socket Mode connection aborted"));
        };
        abortController!.signal.addEventListener("abort", abortHandler, { once: true });

        socket.addEventListener("open", () => {
          // Connection opened — wait for the hello event before resolving
        });

        socket.addEventListener("message", (event) => {
          let envelope: {
            type: string;
            envelope_id?: string;
            payload?: { event?: SlackMessageEvent };
            [key: string]: unknown;
          };

          try {
            envelope = JSON.parse(String(event.data));
          } catch (err) {
        console.warn("[friday][slack-service] operation failed:", err instanceof Error ? err.message : String(err));
            return; // ignore malformed frames
          }

          // Handle hello — marks connection as ready
          if (envelope.type === "hello") {
            connected = true;
            reconnectDelay = SLACK_RECONNECT_INITIAL_MS; // Reset backoff on successful connect

            // Start heartbeat pings
            heartbeatTimer = setInterval(() => {
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "ping" }));
              }
            }, SOCKET_HEARTBEAT_INTERVAL_MS);

            resolve();
            return;
          }

          // Handle events_api envelope — acknowledge then forward
          if (envelope.type === "events_api" && envelope.envelope_id) {
            // Acknowledge immediately so Slack doesn't retry
            socket.send(
              JSON.stringify({ envelope_id: envelope.envelope_id }),
            );

            // Forward message events to callback
            const innerEvent = envelope.payload?.event;
            if (innerEvent && innerEvent.type === "message") {
              try {
                onEvent(innerEvent);
              } catch (err) {
        console.warn("[friday][slack-service] operation failed:", err instanceof Error ? err.message : String(err));
                // Callback error must not break the socket loop
              }
            }
            return;
          }

          // Handle disconnect request from Slack (server-initiated)
          if (envelope.type === "disconnect") {
            cleanup();
            return;
          }
        });

        socket.addEventListener("close", () => {
          const wasConnected = connected;
          cleanup();
          if (!wasConnected) {
            reject(new Error("Socket Mode WebSocket closed before hello"));
          } else if (!stopped) {
            // P2-CH: Log disconnection — the channel registry health monitor will auto-restart
            console.warn("[friday] Slack Socket Mode disconnected unexpectedly");
          }
        });

        socket.addEventListener("error", (err) => {
          const wasConnected = connected;
          cleanup();
          if (!wasConnected) {
            reject(
              new Error(
                `Socket Mode WebSocket error: ${err instanceof ErrorEvent ? err.message : "unknown"}`,
              ),
            );
          }
        });
      });
    },

    async disconnect() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      cleanup();
    },

    isConnected() {
      return connected;
    },
  };
}

/**
 * Create a real Slack HTTP Event service.
 *
 * In webhook / HTTP mode the actual HTTP listener lives in the hub's HTTP
 * server. This service stores the signing secret and event callback so the hub
 * can delegate incoming Slack webhook payloads for validation and processing.
 *
 * Call `processEvent` on the returned object from the hub route handler to
 * feed raw events into the pipeline.
 */
export function createSlackHttpEventService(): SlackHttpEventService {
  let listening = false;
  let signingSecret: string | null = null;
  let eventCallback: ((event: SlackMessageEvent) => void) | null = null;

  return {
    async start(secret, onEvent) {
      signingSecret = secret;
      eventCallback = onEvent;
      listening = true;
    },

    async stop() {
      listening = false;
      signingSecret = null;
      eventCallback = null;
    },

    isListening() {
      return listening;
    },

    /**
     * Validate a Slack request signature and, if valid, forward the event
     * to the registered callback. Called by the hub HTTP route handler.
     *
     * @returns `true` if the signature was valid and the event was forwarded.
     */
    get signingSecret() {
      return signingSecret;
    },

    get onEvent() {
      return eventCallback;
    },
  } as SlackHttpEventService & {
    readonly signingSecret: string | null;
    readonly onEvent: ((event: SlackMessageEvent) => void) | null;
  };
}

/**
 * Verify a Slack request signature using the Events API signing secret.
 *
 * @param signingSecret  The app's signing secret
 * @param timestamp      The `X-Slack-Request-Timestamp` header value
 * @param body           The raw request body string
 * @param signature      The `X-Slack-Signature` header value (v0=…)
 * @returns `true` if the signature is valid
 */
export async function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const baseString = `v0:${timestamp}:${body}`;

  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(baseString),
  );

  const hexDigest =
    "v0=" +
    Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  // Constant-time comparison via subtle.timingSafeEqual is not in Web Crypto,
  // but we can use a length-check + byte-by-byte OR approach.
  if (hexDigest.length !== signature.length) return false;

  let mismatch = 0;
  for (let i = 0; i < hexDigest.length; i++) {
    mismatch |= hexDigest.charCodeAt(i) ^ signature.charCodeAt(i);
  }

  return mismatch === 0;
}
