/**
 * Discord API service — interfaces, stubs, and real implementations
 * for the Discord gateway (WebSocket) and REST API.
 *
 * All external API calls are behind this service interface,
 * making it easy to mock in tests and swap implementations.
 */

// ─── Types ───

export interface DiscordGatewayEvent {
  op: number;
  t?: string;
  s?: number;
  d?: unknown;
}

export interface DiscordMessageCreatePayload {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: {
    id: string;
    username: string;
    discriminator?: string;
    bot?: boolean;
  };
  content: string;
  timestamp: string;
  message_reference?: {
    message_id?: string;
    channel_id?: string;
    guild_id?: string;
  };
  attachments?: Array<{
    id: string;
    filename: string;
    content_type?: string;
    url: string;
    size: number;
  }>;
  mentions?: Array<{ id: string }>;
  /** Present when message is in a thread. */
  thread?: {
    id: string;
    type?: number;
    parent_id?: string;
  };
}

export interface DiscordSendMessagePayload {
  content: string;
  message_reference?: {
    message_id: string;
  };
  allowed_mentions?: {
    parse?: string[];
    users?: string[];
    roles?: string[];
    replied_user?: boolean;
  };
  embeds?: Array<{
    image?: {
      url: string;
    };
  }>;
  files?: Array<{
    filename: string;
    data: Uint8Array;
    contentType?: string;
  }>;
}

export interface DiscordSendMessageResponse {
  id: string;
}

export type DiscordGatewayStatusChange = "connected" | "disconnected" | "connecting";

// ─── Service Interface ───

export interface DiscordGatewayService {
  /** Connect to the Discord gateway WebSocket. */
  connect(
    token: string,
    intents: number,
    onEvent: (event: DiscordGatewayEvent) => void,
    onStatusChange?: (status: DiscordGatewayStatusChange) => void,
  ): Promise<void>;
  /** Disconnect from the gateway. */
  disconnect(): Promise<void>;
  /** Get current connection state. */
  isConnected(): boolean;
}

export interface DiscordRestService {
  /** Send a message to a channel. */
  sendMessage(
    token: string,
    channelId: string,
    payload: DiscordSendMessagePayload,
  ): Promise<DiscordSendMessageResponse>;
  /** Trigger typing indicator in a channel. */
  sendTyping(token: string, channelId: string): Promise<void>;
}

// ─── Stub Implementations ───

export function createDiscordGatewayServiceStub(): DiscordGatewayService {
  let connected = false;

  return {
    async connect(_token, _intents, _onEvent, _onStatusChange) {
      connected = true;
      // Stub: in production, this would open a WebSocket to wss://gateway.discord.gg
    },
    async disconnect() {
      connected = false;
    },
    isConnected() {
      return connected;
    },
  };
}

export function createDiscordRestServiceStub(): DiscordRestService {
  return {
    async sendMessage(_token, _channelId, _payload) {
      // Stub: in production, POST to https://discord.com/api/v10/channels/{id}/messages
      return { id: `stub-msg-${Date.now()}` };
    },
    async sendTyping(_token, _channelId) {
      // Stub: in production, POST to https://discord.com/api/v10/channels/{id}/typing
    },
  };
}

// ─── Discord Gateway Op Codes ───

const GatewayOp = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  Reconnect: 7,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
} as const;

const DISCORD_API_BASE = "https://discord.com/api/v10";

// ─── Reconnect constants ───

const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 60_000;

// ─── Real REST Implementation ───

export function createDiscordRestService(): DiscordRestService {
  return {
    async sendMessage(token, channelId, payload) {
      const url = `${DISCORD_API_BASE}/channels/${channelId}/messages`;
      const files = payload.files ?? [];

      let res: Response;
      if (files.length > 0) {
        const form = new FormData();
        const payloadWithoutFiles = {
          ...payload,
          files: undefined,
        };
        form.append("payload_json", JSON.stringify(payloadWithoutFiles));

        for (const [index, file] of files.entries()) {
          const bytes = Uint8Array.from(file.data);
          form.append(
            `files[${String(index)}]`,
            new Blob([bytes], { type: file.contentType ?? "application/octet-stream" }),
            file.filename,
          );
        }

        res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bot ${token}`,
          },
          body: form,
        });
      } else {
        res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bot ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Discord REST API error ${res.status}: ${res.statusText} — ${body}`,
        );
      }

      const data = (await res.json()) as DiscordSendMessageResponse;
      return data;
    },
    async sendTyping(token, channelId) {
      const url = `${DISCORD_API_BASE}/channels/${channelId}/typing`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
        },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Discord typing API error ${res.status}: ${res.statusText} — ${body}`,
        );
      }
    },
  };
}

// ─── Real Gateway Implementation ───

export function createDiscordGatewayService(): DiscordGatewayService {
  let ws: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let connected = false;
  let abortController: AbortController | null = null;
  let lastSequence: number | null = null;
  let heartbeatAcked = true;

  // Reconnect state — persists across connection cycles
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let savedToken: string | null = null;
  let savedIntents: number | null = null;
  let savedOnEvent: ((event: DiscordGatewayEvent) => void) | null = null;
  let savedOnStatusChange: ((status: DiscordGatewayStatusChange) => void) | null = null;

  function cleanup() {
    connected = false;
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (ws !== null) {
      try {
        ws.close(1000, "Client disconnect");
      } catch {
        // Already closed — ignore.
      }
      ws = null;
    }
    if (abortController !== null) {
      abortController.abort();
      abortController = null;
    }
    lastSequence = null;
    heartbeatAcked = true;
  }

  function sendHeartbeat(socket: WebSocket) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: lastSequence }));
    }
  }

  function sendIdentify(socket: WebSocket, token: string, intents: number) {
    const identifyPayload = {
      op: GatewayOp.Identify,
      d: {
        token,
        intents,
        properties: {
          os: "linux",
          browser: "friday",
          device: "friday",
        },
      },
    };
    socket.send(JSON.stringify(identifyPayload));
  }

  function backoffDelay(): number {
    return Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_DELAY_MS);
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== null) return;
    const delay = backoffDelay();
    reconnectAttempt++;
    console.log(`[friday] Discord gateway reconnecting in ${String(delay)}ms (attempt ${String(reconnectAttempt)})`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped) return;
      savedOnStatusChange?.("connecting");

      doConnect()
        .then(() => {
          console.log("[friday] Discord gateway reconnected successfully");
        })
        .catch(() => {
          if (!stopped) {
            scheduleReconnect();
          }
        });
    }, delay);
  }

  async function doConnect(): Promise<void> {
    const token = savedToken!;
    const intents = savedIntents!;
    const onEvent = savedOnEvent!;

    // Clean up any existing connection first.
    cleanup();

    abortController = new AbortController();
    const { signal } = abortController;

    // Step 1: Fetch the gateway URL from Discord.
    const gatewayRes = await fetch(`${DISCORD_API_BASE}/gateway`, {
      headers: { Authorization: `Bot ${token}` },
      signal,
    });

    if (!gatewayRes.ok) {
      const body = await gatewayRes.text().catch(() => "");
      throw new Error(
        `Failed to fetch Discord gateway URL: ${gatewayRes.status} — ${body}`,
      );
    }

    const { url: gatewayUrl } = (await gatewayRes.json()) as { url: string };
    const wssUrl = `${gatewayUrl}?v=10&encoding=json`;

    // Step 2: Connect via WebSocket.
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Connection aborted"));
        return;
      }

      const socket = new WebSocket(wssUrl);
      ws = socket;

      // If the AbortController fires while we're connecting, tear down.
      const onAbort = () => {
        socket.close(1000, "Connection aborted");
        reject(new Error("Connection aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });

      let identified = false;

      socket.addEventListener("message", (event) => {
        let parsed: DiscordGatewayEvent;
        try {
          parsed = JSON.parse(String(event.data)) as DiscordGatewayEvent;
        } catch {
          return; // Ignore malformed frames.
        }

        // Track sequence number for heartbeats.
        if (parsed.s !== undefined && parsed.s !== null) {
          lastSequence = parsed.s;
        }

        switch (parsed.op) {
          case GatewayOp.Hello: {
            // Start heartbeating at the interval Discord specifies.
            const interval = (parsed.d as { heartbeat_interval: number })
              .heartbeat_interval;
            heartbeatAcked = true;

            // Send an immediate heartbeat, then start the interval.
            sendHeartbeat(socket);
            heartbeatTimer = setInterval(() => {
              if (!heartbeatAcked) {
                // Missed ACK — zombie connection. Reconnect.
                socket.close(4009, "Zombie connection");
                return;
              }
              heartbeatAcked = false;
              sendHeartbeat(socket);
            }, interval);

            // Send Identify.
            sendIdentify(socket, token, intents);
            break;
          }

          case GatewayOp.HeartbeatAck: {
            heartbeatAcked = true;
            break;
          }

          case GatewayOp.Heartbeat: {
            // Discord may request an immediate heartbeat.
            sendHeartbeat(socket);
            break;
          }

          case GatewayOp.Dispatch: {
            // The READY event means Identify succeeded.
            if (parsed.t === "READY" && !identified) {
              identified = true;
              connected = true;
              reconnectAttempt = 0;
              signal.removeEventListener("abort", onAbort);
              savedOnStatusChange?.("connected");
              resolve();
            }
            // Forward all Dispatch events to the callback.
            onEvent(parsed);
            break;
          }

          case GatewayOp.Reconnect: {
            // Discord is asking us to reconnect.
            socket.close(4000, "Reconnect requested");
            break;
          }

          case GatewayOp.InvalidSession: {
            // d is boolean: true means resumable, false means not.
            const resumable = parsed.d as boolean;
            if (!resumable) {
              // Cannot resume — close and let the error handler deal with it.
              socket.close(4000, "Invalid session (non-resumable)");
            }
            break;
          }

          default:
            break;
        }
      });

      socket.addEventListener("error", () => {
        if (!identified) {
          signal.removeEventListener("abort", onAbort);
          cleanup();
          reject(new Error("Discord gateway WebSocket error during connect"));
        }
      });

      socket.addEventListener("close", (closeEvent) => {
        signal.removeEventListener("abort", onAbort);
        const wasConnected = connected;
        cleanup();

        if (!identified) {
          reject(
            new Error(
              `Discord gateway closed before READY: code=${String(closeEvent.code)} reason=${closeEvent.reason}`,
            ),
          );
          return;
        }

        // Notify status change — connection dropped
        savedOnStatusChange?.("disconnected");

        // If we were connected, schedule a reconnect within the same closure.
        if (wasConnected && !stopped) {
          scheduleReconnect();
        }
      });
    });
  }

  return {
    async connect(token, intents, onEvent, onStatusChange) {
      // Reset reconnect state for a fresh connection
      stopped = false;
      reconnectAttempt = 0;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      // Save credentials for reconnection
      savedToken = token;
      savedIntents = intents;
      savedOnEvent = onEvent;
      savedOnStatusChange = onStatusChange ?? null;

      savedOnStatusChange?.("connecting");
      await doConnect();
    },

    async disconnect() {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      cleanup();
      savedOnStatusChange?.("disconnected");
    },

    isConnected() {
      return connected;
    },
  };
}
