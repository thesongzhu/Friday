/**
 * Telegram Bot API service — interfaces, stubs, and real HTTP implementations.
 *
 * Real implementations use Node's built-in fetch (Node 22+).
 */

import { FridayDomainError } from "#errors";

// ─── Types ───

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  reply_to_message?: { message_id: number };
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramSendMessagePayload {
  chat_id: string | number;
  text: string;
  reply_to_message_id?: number;
}

export interface TelegramSendMessageResponse {
  ok: boolean;
  result: {
    message_id: number;
  };
}

// ─── Service Interface ───

export interface TelegramPollingService {
  /** Start polling for updates. */
  startPolling(
    botToken: string,
    onUpdate: (update: TelegramUpdate) => void,
  ): Promise<void>;
  /** Stop polling. */
  stopPolling(): Promise<void>;
  /** Check if polling is running. */
  isPolling(): boolean;
}

export interface TelegramApiService {
  /** Send a message via Bot API. */
  sendMessage(
    botToken: string,
    payload: TelegramSendMessagePayload,
  ): Promise<TelegramSendMessageResponse>;
}

// ─── Webhook Service ───

export interface TelegramWebhookService {
  /** Set up the webhook endpoint and start listening for updates. */
  startWebhook(
    botToken: string,
    webhookUrl: string,
    onUpdate: (update: TelegramUpdate) => void,
  ): Promise<void>;
  /** Stop the webhook listener. */
  stopWebhook(): Promise<void>;
  /** Check if webhook is active. */
  isListening(): boolean;
}

// ─── Helpers ───

const TELEGRAM_API_BASE = "https://api.telegram.org";

function botUrl(token: string, method: string): string {
  return `${TELEGRAM_API_BASE}/bot${token}/${method}`;
}

// ─── Stub Implementations ───

export function createTelegramPollingServiceStub(): TelegramPollingService {
  let polling = false;

  return {
    async startPolling(_botToken, _onUpdate) {
      polling = true;
      // Stub: in production, long-poll https://api.telegram.org/bot{token}/getUpdates
    },
    async stopPolling() {
      polling = false;
    },
    isPolling() {
      return polling;
    },
  };
}

export function createTelegramWebhookServiceStub(): TelegramWebhookService {
  let listening = false;

  return {
    async startWebhook(_botToken, _webhookUrl, _onUpdate) {
      listening = true;
      // Stub: in production, calls setWebhook and starts HTTP listener
    },
    async stopWebhook() {
      listening = false;
    },
    isListening() {
      return listening;
    },
  };
}

export function createTelegramApiServiceStub(): TelegramApiService {
  return {
    async sendMessage(_botToken, _payload) {
      // Stub: POST https://api.telegram.org/bot{token}/sendMessage
      return {
        ok: true,
        result: { message_id: Math.floor(Math.random() * 100000) },
      };
    },
  };
}

// ─── Real Implementations ───

/**
 * Creates a real Telegram polling service that long-polls the getUpdates
 * endpoint. Uses AbortController to cancel in-flight requests on stop.
 *
 * @param pollingTimeoutSec  Telegram server-side long-poll timeout (default 30s).
 */
export function createTelegramPollingService(
  pollingTimeoutSec = 30,
): TelegramPollingService {
  let polling = false;
  let abortController: AbortController | null = null;

  async function pollLoop(
    botToken: string,
    onUpdate: (update: TelegramUpdate) => void,
  ): Promise<void> {
    let offset = 0;

    while (polling) {
      const url = botUrl(botToken, "getUpdates");
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offset,
            timeout: pollingTimeoutSec,
          }),
          signal: abortController!.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new FridayDomainError(
            "INTERNAL_ERROR",
            `Telegram getUpdates failed: HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
            { httpStatus: 500 },
          );
        }

        const json = (await res.json()) as {
          ok: boolean;
          result: TelegramUpdate[];
          description?: string;
        };

        if (!json.ok) {
          throw new FridayDomainError(
            "INTERNAL_ERROR",
            `Telegram getUpdates returned ok=false: ${json.description ?? "unknown error"}`,
            { httpStatus: 500 },
          );
        }

        let processedUpdateCount = 0;
        for (const update of json.result) {
          if (update.update_id < offset) {
            continue;
          }
          offset = update.update_id + 1;
          processedUpdateCount += 1;
          onUpdate(update);
        }
        if (polling && json.result.length > 0 && processedUpdateCount === 0) {
          await new Promise((r) => setTimeout(r, 1_000));
        }
      } catch (err: unknown) {
        // If the abort signal fired, exit silently — the loop was intentionally stopped.
        if (err instanceof DOMException && err.name === "AbortError") {
          break;
        }
        if (
          err instanceof Error &&
          err.cause instanceof DOMException &&
          (err.cause as DOMException).name === "AbortError"
        ) {
          break;
        }
        // For transient network errors, wait briefly before retrying.
        // Re-throw programming / non-transient errors so the caller
        // can surface them (e.g. invalid token → 401).
        if (polling) {
          // Brief back-off before retry
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }
    }
  }

  return {
    async startPolling(botToken, onUpdate) {
      if (polling) return;
      polling = true;
      abortController = new AbortController();
      // Start the poll loop without awaiting — it runs in the background.
      // We deliberately swallow rejections here; errors are handled inside the loop.
      void pollLoop(botToken, onUpdate);
    },

    async stopPolling() {
      if (!polling) return;
      polling = false;
      abortController?.abort();
      abortController = null;
    },

    isPolling() {
      return polling;
    },
  };
}

/**
 * Creates a real Telegram webhook service.
 *
 * `startWebhook` calls the Telegram `setWebhook` API to register the URL.
 * The actual HTTP listener that receives inbound webhook POSTs is managed
 * externally by the hub's HTTP server — this service only tells Telegram
 * where to send updates and stores the `onUpdate` callback so the hub can
 * invoke it when it receives a POST.
 *
 * `stopWebhook` calls `deleteWebhook` to deregister.
 */
export function createTelegramWebhookService(): TelegramWebhookService {
  let listening = false;
  let storedOnUpdate: ((update: TelegramUpdate) => void) | null = null;
  let storedToken: string | null = null;

  return {
    async startWebhook(botToken, webhookUrl, onUpdate) {
      // Register the webhook URL with Telegram.
      const url = botUrl(botToken, "setWebhook");
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new FridayDomainError(
          "INTERNAL_ERROR",
          `Telegram setWebhook failed: HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
          { httpStatus: 500 },
        );
      }

      const json = (await res.json()) as {
        ok: boolean;
        description?: string;
      };

      if (!json.ok) {
        throw new FridayDomainError(
          "INTERNAL_ERROR",
          `Telegram setWebhook returned ok=false: ${json.description ?? "unknown error"}`,
          { httpStatus: 500 },
        );
      }

      storedToken = botToken;
      storedOnUpdate = onUpdate;
      listening = true;
    },

    async stopWebhook() {
      if (!listening || !storedToken) {
        listening = false;
        storedOnUpdate = null;
        storedToken = null;
        return;
      }

      // Deregister the webhook.
      const url = botUrl(storedToken, "deleteWebhook");
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new FridayDomainError(
            "INTERNAL_ERROR",
            `Telegram deleteWebhook failed: HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
            { httpStatus: 500 },
          );
        }
      } finally {
        listening = false;
        storedOnUpdate = null;
        storedToken = null;
      }
    },

    isListening() {
      return listening;
    },
  };
}

/**
 * Creates a real Telegram API service that sends messages via the
 * Bot API's `sendMessage` endpoint.
 */
export function createTelegramApiService(): TelegramApiService {
  return {
    async sendMessage(botToken, payload) {
      const url = botUrl(botToken, "sendMessage");
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new FridayDomainError(
          "INTERNAL_ERROR",
          `Telegram sendMessage failed: HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
          { httpStatus: 500 },
        );
      }

      const json = (await res.json()) as TelegramSendMessageResponse & {
        description?: string;
      };

      if (!json.ok) {
        throw new FridayDomainError(
          "INTERNAL_ERROR",
          `Telegram sendMessage returned ok=false: ${json.description ?? "unknown error"}`,
          { httpStatus: 500 },
        );
      }

      return { ok: json.ok, result: json.result };
    },
  };
}
