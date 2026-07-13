/**
 * Telegram Bot API service — interfaces, stubs, and real HTTP implementations.
 *
 * Real implementations use Node's built-in fetch (Node 22+).
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { FridayDomainError } from "#errors";
import {
  createInMemoryTelegramInboxStore,
  TELEGRAM_INBOX_RETENTION_MS,
  type TelegramInboxStore,
} from "./telegram-inbox-store.js";

/**
 * How often the durable inbox's bounded-retention reaper is allowed to run. The prune itself is
 * a cheap terminal-row DELETE, but throttling it to at most once per interval keeps a fast poll
 * loop / high webhook rate from opening a write transaction every cycle. This follows the
 * repo's opportunistic-prune convention (e.g. the HTTP operation journal prunes inline from the
 * request path) rather than a central retention scheduler, which this codebase does not have.
 */
export const TELEGRAM_INBOX_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Creates a throttled, non-blocking reaper closure shared by the poll loop and the webhook
 * handler. It reaps TERMINAL inbox rows older than {@link TELEGRAM_INBOX_RETENTION_MS} at most
 * once per {@link TELEGRAM_INBOX_PRUNE_INTERVAL_MS}, and swallows any error so a prune failure
 * can never disrupt inbound delivery. 'pending' rows are never touched (that gate lives in the
 * store's `pruneTerminalOlderThan`).
 */
function createInboxRetentionReaper(
  inbox: TelegramInboxStore,
  channelId: string,
): (nowMs: number) => void {
  let lastPruneAtMs = 0;
  return (nowMs: number): void => {
    if (nowMs - lastPruneAtMs < TELEGRAM_INBOX_PRUNE_INTERVAL_MS) return;
    lastPruneAtMs = nowMs;
    try {
      inbox.pruneTerminalOlderThan(channelId, nowMs - TELEGRAM_INBOX_RETENTION_MS);
    } catch (err) {
      console.warn(
        "[friday][telegram-inbox] retention prune failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  };
}

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

export interface TelegramWebhookRelayResult {
  accepted: boolean;
  statusCode: number;
  code?:
    | "TELEGRAM_LISTENER_INACTIVE"
    | "TELEGRAM_SECRET_UNCONFIGURED"
    | "TELEGRAM_SECRET_MISSING"
    | "TELEGRAM_SECRET_INVALID"
    | "TELEGRAM_PAYLOAD_INVALID";
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
    webhookSecretToken: string,
    onUpdate: (update: TelegramUpdate) => void,
  ): Promise<void>;
  /** Stop the webhook listener. */
  stopWebhook(): Promise<void>;
  /** Check if webhook is active. */
  isListening(): boolean;
  /** Handle inbound Telegram webhook POST relayed by the HTTP server. */
  handleHttpWebhook(
    rawBody: string,
    secretTokenHeader?: string,
  ): TelegramWebhookRelayResult;
}

// ─── Helpers ───

const TELEGRAM_API_BASE = "https://api.telegram.org";

function botUrl(token: string, method: string): string {
  return `${TELEGRAM_API_BASE}/bot${token}/${method}`;
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
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
    async startWebhook(_botToken, _webhookUrl, _webhookSecretToken, _onUpdate) {
      listening = true;
      // Stub: in production, calls setWebhook and starts HTTP listener
    },
    async stopWebhook() {
      listening = false;
    },
    isListening() {
      return listening;
    },
    handleHttpWebhook() {
      return {
        accepted: false,
        statusCode: 503,
        code: "TELEGRAM_LISTENER_INACTIVE",
      };
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

// ─── Durable-inbox getUpdates transport ───

export interface TelegramGetUpdatesTransportInput {
  botToken: string;
  offset: number;
  timeoutSec: number;
  signal: AbortSignal;
}

/**
 * Fetches one batch of updates from the Bot API. Injectable so the durable poll loop
 * (offset persistence, commit-before-advance, exactly-once dedupe) can be exercised
 * end-to-end without a real bot token or network.
 */
export type TelegramGetUpdatesTransport = (
  input: TelegramGetUpdatesTransportInput,
) => Promise<TelegramUpdate[]>;

/** The default transport: long-polls `https://api.telegram.org/bot{token}/getUpdates`. */
export function createFetchGetUpdatesTransport(): TelegramGetUpdatesTransport {
  return async ({ botToken, offset, timeoutSec, signal }) => {
    const url = botUrl(botToken, "getUpdates");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offset, timeout: timeoutSec }),
      signal,
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

    return json.result;
  };
}

export interface TelegramPollingServiceOptions {
  /** Telegram server-side long-poll timeout (default 30s). */
  pollingTimeoutSec?: number;
  /**
   * Durable inbox. Defaults to a volatile in-memory store so a db-less caller keeps working
   * (behaves like today for a fresh process, minus the offset-before-commit bug).
   */
  inbox?: TelegramInboxStore;
  /** Inbox identity namespace for this channel (default "telegram"). */
  channelId?: string;
  /** Injectable getUpdates transport (default: real Bot API fetch). */
  transport?: TelegramGetUpdatesTransport;
}

/**
 * Creates a real Telegram polling service that long-polls the getUpdates endpoint through a
 * DURABLE inbox: the poll offset is persisted (survives restart, never resets to 0), each
 * update is committed to the inbox BEFORE the offset advances, dispatch is exactly-once
 * (duplicate `update_id`s are deduped), and un-processed rows are recovered on (re)start.
 *
 * Accepts either a plain long-poll timeout (legacy positional arg) or an options object.
 */
export function createTelegramPollingService(
  optionsOrTimeout: number | TelegramPollingServiceOptions = {},
): TelegramPollingService {
  const options: TelegramPollingServiceOptions =
    typeof optionsOrTimeout === "number"
      ? { pollingTimeoutSec: optionsOrTimeout }
      : optionsOrTimeout;
  const pollingTimeoutSec = options.pollingTimeoutSec ?? 30;
  const inbox = options.inbox ?? createInMemoryTelegramInboxStore();
  const channelId = options.channelId ?? "telegram";
  const transport = options.transport ?? createFetchGetUpdatesTransport();
  // Bounded-retention reaper: opportunistically prunes OLD terminal inbox rows once per poll
  // cycle (throttled), so the durable inbox does not grow unbounded. Never prunes 'pending'.
  const maybePruneInbox = createInboxRetentionReaper(inbox, channelId);

  let polling = false;
  let abortController: AbortController | null = null;

  // Dispatch to the handler, tolerating both sync and async handlers and turning a synchronous
  // throw into a rejected promise so the loop can react to a dispatch failure uniformly.
  async function deliver(
    onUpdate: (update: TelegramUpdate) => void,
    update: TelegramUpdate,
  ): Promise<void> {
    await Promise.resolve(onUpdate(update));
  }

  // Re-drive inbox rows left un-processed by a crash BEFORE polling for new updates. Orphaned
  // `pending` rows are first reconciled to `delivery_unknown`, then re-driven through the same
  // dedupe path — never a blind re-insert.
  async function recoverPending(onUpdate: (update: TelegramUpdate) => void): Promise<void> {
    inbox.reconcileOrphaned(channelId);
    for (const row of inbox.listUnprocessed(channelId)) {
      if (!polling) break;
      try {
        await deliver(onUpdate, row.update);
        inbox.markProcessed(channelId, row.updateId);
      } catch {
        // Leave the row un-processed; the next recovery pass re-drives it. Never lost.
      }
    }
  }

  async function pollLoop(
    botToken: string,
    onUpdate: (update: TelegramUpdate) => void,
  ): Promise<void> {
    // 1. Recover in-flight rows from a previous (possibly crashed) run.
    await recoverPending(onUpdate);
    // 2. Resume from the DURABLE offset — a restart never resets to 0.
    let offset = inbox.loadOffset(channelId);

    while (polling) {
      const controller = abortController;
      if (!controller) break;
      // Opportunistic, throttled, non-blocking retention prune once per poll cycle.
      maybePruneInbox(Date.now());
      try {
        const updates = await transport({
          botToken,
          offset,
          timeoutSec: pollingTimeoutSec,
          signal: controller.signal,
        });

        let processedUpdateCount = 0;
        for (const update of updates) {
          if (update.update_id < offset) {
            continue;
          }
          // 3. Durably COMMIT before advancing the offset. If this throws, the offset is NOT
          //    advanced, so Telegram redelivers the update (nothing was durably captured).
          const commit = inbox.commitInbound(channelId, update);
          // 4. Advance + persist the offset ONLY after the durable commit succeeded.
          offset = update.update_id + 1;
          inbox.saveOffset(channelId, offset);
          processedUpdateCount += 1;
          // 5. Dispatch ONLY when the durable row is not already `processed` (exactly-once). A
          //    dispatch failure leaves the row `pending` → redelivered from the inbox on
          //    recovery; a duplicate `update_id` is deduped and never re-dispatched.
          //
          // DEFERRED (follow-up, not this change): this status-gated dispatch is safe today
          // because Telegram enforces webhook XOR polling — only one transport is ever live — and
          // recovery RELIES on re-driving existing `pending`/`delivery_unknown` rows through this
          // same gate. A per-row atomic claim (compare-and-set pending→processing) would be the
          // hardening IF a future change ever ran both transports live concurrently; until then a
          // CAS would break recovery, so it is intentionally NOT introduced here.
          if (commit.shouldDeliver) {
            try {
              await deliver(onUpdate, update);
              inbox.markProcessed(channelId, update.update_id);
            } catch {
              // Row stays pending/delivery_unknown; recovery re-drives it. The offset already
              // advanced past it, but the durable inbox owns redelivery.
            }
          }
        }
        if (polling && updates.length > 0 && processedUpdateCount === 0) {
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
        // For transient network errors, wait briefly before retrying. Because the offset only
        // advances after a durable commit, a mid-batch failure re-fetches the same updates and
        // the inbox dedupe keeps dispatch exactly-once.
        if (polling) {
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
export interface TelegramWebhookServiceOptions {
  /**
   * Durable inbox. Defaults to a volatile in-memory store so a db-less caller keeps working
   * (behaves like today for a fresh process, minus the ACK-before-commit bug).
   */
  inbox?: TelegramInboxStore;
  /** Inbox identity namespace for this channel (default "telegram"). */
  channelId?: string;
}

export function createTelegramWebhookService(
  options: TelegramWebhookServiceOptions = {},
): TelegramWebhookService {
  const inbox = options.inbox ?? createInMemoryTelegramInboxStore();
  const channelId = options.channelId ?? "telegram";
  // Bounded-retention reaper: opportunistically prunes OLD terminal inbox rows on inbound
  // webhook traffic (throttled, non-blocking). Never prunes 'pending'.
  const maybePruneInbox = createInboxRetentionReaper(inbox, channelId);
  let listening = false;
  let storedOnUpdate: ((update: TelegramUpdate) => void) | null = null;
  let storedToken: string | null = null;
  let storedWebhookSecretToken: string | null = null;

  // Re-drive inbox rows left un-processed by a crash. Called on startWebhook so a restart
  // recovers in-flight rows before accepting new POSTs.
  const recoverPending = (onUpdate: (update: TelegramUpdate) => void): void => {
    inbox.reconcileOrphaned(channelId);
    for (const row of inbox.listUnprocessed(channelId)) {
      try {
        onUpdate(row.update);
        inbox.markProcessed(channelId, row.updateId);
      } catch {
        // Leave the row un-processed; the next recovery pass re-drives it. Never lost.
      }
    }
  };

  return {
    async startWebhook(botToken, webhookUrl, webhookSecretToken, onUpdate) {
      const normalizedSecretToken = webhookSecretToken.trim();
      if (!normalizedSecretToken) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "Telegram webhook mode requires webhookSecretToken in config",
          { httpStatus: 400 },
        );
      }
      // Register the webhook URL with Telegram.
      const url = botUrl(botToken, "setWebhook");
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl, secret_token: normalizedSecretToken }),
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
      storedWebhookSecretToken = normalizedSecretToken;
      storedOnUpdate = onUpdate;
      listening = true;
      // Recover any rows a previous run committed but did not finish dispatching.
      recoverPending(onUpdate);
    },

    async stopWebhook() {
      if (!listening || !storedToken) {
        listening = false;
        storedOnUpdate = null;
        storedToken = null;
        storedWebhookSecretToken = null;
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
        storedWebhookSecretToken = null;
      }
    },

    isListening() {
      return listening;
    },

    handleHttpWebhook(rawBody, secretTokenHeader) {
      if (!listening || !storedOnUpdate) {
        return {
          accepted: false,
          statusCode: 503,
          code: "TELEGRAM_LISTENER_INACTIVE",
        };
      }

      if (!storedWebhookSecretToken) {
        return {
          accepted: false,
          statusCode: 503,
          code: "TELEGRAM_SECRET_UNCONFIGURED",
        };
      }

      if (!secretTokenHeader) {
        return {
          accepted: false,
          statusCode: 401,
          code: "TELEGRAM_SECRET_MISSING",
        };
      }

      if (!constantTimeStringEqual(secretTokenHeader, storedWebhookSecretToken)) {
        return {
          accepted: false,
          statusCode: 403,
          code: "TELEGRAM_SECRET_INVALID",
        };
      }

      let payload: TelegramUpdate;
      try {
        payload = JSON.parse(rawBody) as TelegramUpdate;
      } catch (err) {
        console.warn("[friday][telegram-webhook] invalid payload:", err instanceof Error ? err.message : String(err));
        return {
          accepted: false,
          statusCode: 400,
          code: "TELEGRAM_PAYLOAD_INVALID",
        };
      }

      // A well-formed update MUST carry a numeric update_id — it is the inbox dedupe identity.
      // Without it we cannot dedupe, so reject (Telegram will resend) rather than swallow.
      if (!payload || typeof payload.update_id !== "number") {
        return {
          accepted: false,
          statusCode: 400,
          code: "TELEGRAM_PAYLOAD_INVALID",
        };
      }

      // Opportunistic, throttled, non-blocking retention prune on inbound webhook traffic.
      maybePruneInbox(Date.now());

      // Durably COMMIT before ACK. The 200 that ACKs Telegram is returned ONLY after the update
      // is safely in the inbox, so a crash after ACK cannot lose it (recovered from the inbox).
      // A resent update_id (Telegram retry) is deduped here and never re-dispatched.
      //
      // DEFERRED (follow-up, not this change): this status-gated dispatch is safe today because
      // Telegram enforces webhook XOR polling — only one transport is ever live — and recovery
      // RELIES on re-driving existing `pending`/`delivery_unknown` rows through this same gate. A
      // per-row atomic claim (compare-and-set pending→processing) would be the hardening IF a
      // future change ever ran both transports live concurrently; until then a CAS would break
      // recovery, so it is intentionally NOT introduced here.
      const commit = inbox.commitInbound(channelId, payload);
      if (commit.shouldDeliver) {
        try {
          storedOnUpdate(payload);
          inbox.markProcessed(channelId, payload.update_id);
        } catch (err) {
          // Handler threw: leave the row pending for recovery. Still ACK 200 — the update is
          // durably captured and will be re-driven, so a redelivery is not needed.
          console.warn(
            "[friday][telegram-webhook] handler error:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      return {
        accepted: true,
        statusCode: 200,
      };
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
