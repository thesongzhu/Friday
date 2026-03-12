/**
 * Signal service — stubbed interfaces for signal-cli daemon SSE and JSON-RPC.
 */

// ─── Types ───

export interface SignalInboundMessage {
  envelope: {
    source: string;
    sourceNumber: string;
    sourceName?: string;
    timestamp: number;
    dataMessage?: {
      message: string;
      timestamp: number;
      groupInfo?: {
        groupId: string;
        groupName?: string;
      };
      attachments?: Array<{
        contentType: string;
        id: string;
        filename?: string;
        size: number;
      }>;
      quote?: {
        id: number;
        author: string;
        text: string;
      };
    };
  };
  account: string;
}

export interface SignalSendPayload {
  recipients: string[];
  message: string;
  quote_timestamp?: number;
  quote_author?: string;
}

export interface SignalSendResponse {
  timestamp: number;
}

// ─── Service Interface ───

export interface SignalSseService {
  /** Connect to signal-cli daemon SSE endpoint. */
  connect(
    baseUrl: string,
    account: string,
    onMessage: (msg: SignalInboundMessage) => void,
  ): Promise<void>;
  /** Disconnect from SSE. */
  disconnect(): Promise<void>;
  /** Check connection state. */
  isConnected(): boolean;
}

export interface SignalRpcService {
  /** Send a message via JSON-RPC. */
  sendMessage(
    baseUrl: string,
    account: string,
    payload: SignalSendPayload,
  ): Promise<SignalSendResponse>;
}

// ─── Stub Implementations ───

export function createSignalSseServiceStub(): SignalSseService {
  let connected = false;

  return {
    async connect(_baseUrl, _account, _onMessage) {
      connected = true;
      // Stub: in production, GET {baseUrl}/v1/receive/{account} as SSE
    },
    async disconnect() {
      connected = false;
    },
    isConnected() {
      return connected;
    },
  };
}

export function createSignalRpcServiceStub(): SignalRpcService {
  return {
    async sendMessage(_baseUrl, _account, _payload) {
      // Stub: POST {baseUrl}/v2/send
      return { timestamp: Date.now() };
    },
  };
}

// ─── Real Implementations ───

/**
 * Create a real SSE service that streams inbound Signal messages from
 * the signal-cli REST API daemon.
 *
 * Uses `fetch` with a streaming body reader and an `AbortController`
 * so the connection can be torn down cleanly.
 */
export function createSignalSseService(): SignalSseService {
  let connected = false;
  let abortController: AbortController | null = null;

  return {
    async connect(
      baseUrl: string,
      account: string,
      onMessage: (msg: SignalInboundMessage) => void,
    ): Promise<void> {
      if (connected) {
        throw new Error("Signal SSE service is already connected");
      }

      abortController = new AbortController();
      const url = `${baseUrl}/v1/receive/${encodeURIComponent(account)}`;

      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "<unreadable>");
        throw new Error(
          `Signal SSE connection failed: ${response.status} ${response.statusText} — ${errorBody}`,
        );
      }

      if (!response.body) {
        throw new Error("Signal SSE response has no readable body");
      }

      connected = true;

      // Process the stream in the background — we intentionally do not
      // await this; the caller controls lifetime via disconnect().
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const processStream = async (): Promise<void> => {
        try {
          while (connected) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            // Keep the last (possibly incomplete) line in the buffer
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;

              const jsonStr = trimmed.slice("data:".length).trim();
              if (!jsonStr) continue;

              try {
                const parsed = JSON.parse(jsonStr) as SignalInboundMessage;
                onMessage(parsed);
              } catch {
                // Skip malformed JSON lines
              }
            }
          }
        } catch (err: unknown) {
          // AbortError is expected on disconnect — swallow it
          if (err instanceof DOMException && err.name === "AbortError") return;
          if (err instanceof Error && err.name === "AbortError") return;
          throw err;
        } finally {
          connected = false;
        }
      };

      // Fire-and-forget; errors after initial connect surface in onMessage consumer
      processStream().catch(() => {
        connected = false;
      });
    },

    async disconnect(): Promise<void> {
      connected = false;
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
    },

    isConnected(): boolean {
      return connected;
    },
  };
}

/**
 * Create a real JSON-RPC service for sending Signal messages via the
 * signal-cli REST API daemon.
 */
export function createSignalRpcService(): SignalRpcService {
  return {
    async sendMessage(
      baseUrl: string,
      account: string,
      payload: SignalSendPayload,
    ): Promise<SignalSendResponse> {
      const url = `${baseUrl}/v2/send`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          number: account,
          recipients: payload.recipients,
          message: payload.message,
          ...(payload.quote_timestamp != null
            ? {
                quote_timestamp: payload.quote_timestamp,
                quote_author: payload.quote_author,
              }
            : {}),
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "<unreadable>");
        throw new Error(
          `Signal send failed: ${response.status} ${response.statusText} — ${errorBody}`,
        );
      }

      const json = (await response.json()) as SignalSendResponse;
      return json;
    },
  };
}
