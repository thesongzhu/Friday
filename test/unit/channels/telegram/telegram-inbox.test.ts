/**
 * CHAN-TELEGRAM-INBOX-001 — durable inbox / exactly-once delivery substrate.
 *
 * These tests drive the REAL Telegram polling + webhook services (not a reimplemented copy)
 * against a REAL durable inbox backed by a scratch SQLite DB in a tmp dir, with an injected
 * getUpdates transport / webhook. NO real bot token and NO real network are used — the live
 * real-bot proof is operator-gated and out of scope.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createFridaySqliteLayer } from "#state";
import {
  FridaySqliteTelegramInboxStore,
  createFridayTelegramChannel,
  createTelegramPollingService,
  createTelegramWebhookService,
} from "#channels";
import type {
  FridayChannelMessage,
  TelegramGetUpdatesTransport,
  TelegramUpdate,
} from "#channels";

const CHANNEL_ID = "telegram";
const WEBHOOK_SECRET = "telegram-inbox-webhook-marker"; // pragma: allowlist secret

let tmpDir: string;
let db: ReturnType<typeof createFridaySqliteLayer>;
let store: FridaySqliteTelegramInboxStore;
const activePollServices: Array<{ stopPolling: () => Promise<void> }> = [];
let savedFetch: typeof globalThis.fetch;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-tg-inbox-"));
  db = createFridaySqliteLayer({
    dbPath: path.join(tmpDir, "test.db"),
    readPoolSize: 1,
    pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
  });
  store = new FridaySqliteTelegramInboxStore(db);
  savedFetch = globalThis.fetch;
});

afterEach(async () => {
  for (const svc of activePollServices.splice(0)) {
    try {
      await svc.stopPolling();
    } catch {
      // ignore
    }
  }
  globalThis.fetch = savedFetch;
  try {
    db.close();
  } catch {
    // ignore
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeUpdate(updateId: number, text = "hello"): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      from: { id: 100, is_bot: false, first_name: "Alice" },
      chat: { id: 100, type: "private" },
      date: 1_740_150_000,
      text,
    },
  };
}

/** A faithful fake of Telegram getUpdates: `getUpdates(offset)` confirms (deletes) updates
 *  below `offset`, then returns the remaining queue; idles (abortable) when empty. */
function createFakeTransport(initial: TelegramUpdate[] = []): {
  transport: TelegramGetUpdatesTransport;
  offsetsRequested: number[];
  push: (...updates: TelegramUpdate[]) => void;
} {
  let queue = [...initial];
  const offsetsRequested: number[] = [];
  const transport: TelegramGetUpdatesTransport = async ({ offset, signal }) => {
    offsetsRequested.push(offset);
    if (offset > 0) {
      queue = queue.filter((u) => u.update_id >= offset);
    }
    const batch = queue.slice();
    if (batch.length === 0) {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        const timer = setTimeout(resolve, 10);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
    return batch;
  };
  return {
    transport,
    offsetsRequested,
    push: (...updates: TelegramUpdate[]) => {
      queue.push(...updates);
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function startPolling(
  transport: TelegramGetUpdatesTransport,
  onUpdate: (u: TelegramUpdate) => void,
): { stopPolling: () => Promise<void> } {
  const svc = createTelegramPollingService({
    inbox: store,
    channelId: CHANNEL_ID,
    transport,
    pollingTimeoutSec: 1,
  });
  activePollServices.push(svc);
  void svc.startPolling("scratch-bot-token", onUpdate);
  return svc;
}

async function makeWebhookRelay(
  onUpdate: (u: TelegramUpdate) => void,
): Promise<ReturnType<typeof createTelegramWebhookService>> {
  // Stub the setWebhook network call so no real bot API is contacted.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof globalThis.fetch;
  const relay = createTelegramWebhookService({ inbox: store, channelId: CHANNEL_ID });
  await relay.startWebhook("scratch-bot-token", "https://example.com/hook", WEBHOOK_SECRET, onUpdate);
  return relay;
}

// ─── Store-level: exactly-once identity + durable cursor ───

describe("CHAN-TELEGRAM-INBOX-001 store", () => {
  it("dedupes on the (channel, update_id) identity: a duplicate commit is a no-op", () => {
    const first = store.commitInbound(CHANNEL_ID, makeUpdate(5));
    expect(first).toMatchObject({ inserted: true, shouldDeliver: true, status: "pending" });
    store.markProcessed(CHANNEL_ID, 5);

    const dup = store.commitInbound(CHANNEL_ID, makeUpdate(5));
    expect(dup).toMatchObject({ inserted: false, shouldDeliver: false, status: "processed" });
  });

  it("persists the poll offset durably and keeps it monotonic (never rewinds)", () => {
    expect(store.loadOffset(CHANNEL_ID)).toBe(0);
    store.saveOffset(CHANNEL_ID, 12);
    expect(store.loadOffset(CHANNEL_ID)).toBe(12);
    store.saveOffset(CHANNEL_ID, 8); // stale/late save must not rewind
    expect(store.loadOffset(CHANNEL_ID)).toBe(12);

    // A fresh store on the SAME db still sees the persisted cursor (survives "restart").
    const fresh = new FridaySqliteTelegramInboxStore(db);
    expect(fresh.loadOffset(CHANNEL_ID)).toBe(12);
  });

  it("reconciles orphaned pending rows to delivery_unknown and lists them for recovery", () => {
    store.commitInbound(CHANNEL_ID, makeUpdate(7));
    expect(store.listUnprocessed(CHANNEL_ID).map((r) => r.status)).toEqual(["pending"]);
    const reconciled = store.reconcileOrphaned(CHANNEL_ID);
    expect(reconciled).toBe(1);
    expect(store.listUnprocessed(CHANNEL_ID).map((r) => r.status)).toEqual(["delivery_unknown"]);
  });
});

// ─── Defect #1 + #2: commit-before-ACK, no offset advance on lost dispatch ───

describe("CHAN-TELEGRAM-INBOX-001 commit-before-ACK", () => {
  it("redelivers (from the inbox after restart) an update whose dispatch was interrupted", async () => {
    // Instance A: the dispatch crashes AFTER the durable commit. Today (old code) the offset
    // is advanced before the fire-and-forget handler, so the update is LOST on restart.
    const transportA = createFakeTransport([makeUpdate(5)]);
    startPolling(transportA.transport, () => {
      throw new Error("crash during dispatch");
    });
    // Durable commit is observable via the persisted offset advancing past the update.
    await waitFor(() => store.loadOffset(CHANNEL_ID) >= 6);
    await activePollServices.splice(0)[0].stopPolling();

    // The row remains un-processed (committed but never dispatched).
    expect(store.listUnprocessed(CHANNEL_ID).map((r) => r.updateId)).toContain(5);

    // Instance B ("restart"): Telegram has already forgotten update 5 (empty transport), so the
    // ONLY way to recover it is from the durable inbox.
    const deliveredB: number[] = [];
    const transportB = createFakeTransport([]);
    startPolling(transportB.transport, (u) => {
      deliveredB.push(u.update_id);
    });
    await waitFor(() => deliveredB.includes(5) && store.listUnprocessed(CHANNEL_ID).length === 0);

    expect(deliveredB).toContain(5); // redelivered from inbox
    expect(store.listUnprocessed(CHANNEL_ID)).toHaveLength(0); // now processed
  });
});

// ─── Defect #3: exactly-once across poll retry AND webhook resend ───

describe("CHAN-TELEGRAM-INBOX-001 exactly-once", () => {
  it("dispatches the same update_id exactly once across webhook resend AND a later poll", async () => {
    const dispatched: number[] = [];
    const record = (u: TelegramUpdate) => dispatched.push(u.update_id);

    const relay = await makeWebhookRelay(record);
    const rawBody = JSON.stringify(makeUpdate(5));
    // First webhook delivery → dispatched once.
    const first = relay.handleHttpWebhook(rawBody, WEBHOOK_SECRET);
    expect(first).toMatchObject({ accepted: true, statusCode: 200 });
    // Webhook RESEND of the same update_id → deduped, still 200, NOT re-dispatched.
    const resend = relay.handleHttpWebhook(rawBody, WEBHOOK_SECRET);
    expect(resend).toMatchObject({ accepted: true, statusCode: 200 });
    await relay.stopWebhook();

    // A later POLL surfaces the same update_id (poll retry) → inbox dedupe, NOT re-dispatched.
    const transport = createFakeTransport([makeUpdate(5)]);
    startPolling(transport.transport, record);
    // Let the poll loop observe + dedupe the update (offset advances past it).
    await waitFor(() => store.loadOffset(CHANNEL_ID) >= 6);

    expect(dispatched).toEqual([5]); // exactly once total across both paths
  });
});

// ─── Defect #4: offset persistence + in-flight recovery on restart ───

describe("CHAN-TELEGRAM-INBOX-001 offset persistence + recovery", () => {
  it("resumes from the persisted offset on restart instead of resetting to 0", async () => {
    const deliveredA: number[] = [];
    const transportA = createFakeTransport([makeUpdate(10), makeUpdate(11)]);
    startPolling(transportA.transport, (u) => deliveredA.push(u.update_id));
    await waitFor(() => deliveredA.length === 2 && store.loadOffset(CHANNEL_ID) >= 12);
    await activePollServices.splice(0)[0].stopPolling();

    expect(store.loadOffset(CHANNEL_ID)).toBe(12);

    // Instance B ("restart"): Telegram still holds 10 & 11 (never confirmed). Resuming from the
    // persisted offset (12) confirms/skips them; resetting to 0 (old code) re-dispatches them.
    const deliveredB: number[] = [];
    const transportB = createFakeTransport([makeUpdate(10), makeUpdate(11)]);
    startPolling(transportB.transport, (u) => deliveredB.push(u.update_id));
    // Give the loop time to poll at least once and settle.
    await waitFor(() => transportB.offsetsRequested.length >= 1);
    await new Promise((r) => setTimeout(r, 40));

    expect(deliveredB).toEqual([]); // resumed at 12 → no re-dispatch of already-processed updates
    expect(transportB.offsetsRequested[0]).toBe(12);
  });

  it("recovers in-flight (committed-but-unprocessed) inbox rows on start", async () => {
    // Simulate a prior crash: a row was durably committed but never dispatched.
    store.commitInbound(CHANNEL_ID, makeUpdate(7));
    expect(store.listUnprocessed(CHANNEL_ID)).toHaveLength(1);

    const delivered: number[] = [];
    const transport = createFakeTransport([]);
    startPolling(transport.transport, (u) => delivered.push(u.update_id));
    await waitFor(() => delivered.includes(7) && store.listUnprocessed(CHANNEL_ID).length === 0);

    expect(delivered).toEqual([7]); // re-driven from the inbox
    expect(store.listUnprocessed(CHANNEL_ID)).toHaveLength(0); // marked processed
  });
});

// ─── Webhook: commit-before-200 ───

describe("CHAN-TELEGRAM-INBOX-001 webhook durability", () => {
  it("returns 200 only after the update is durably committed to the inbox", async () => {
    const relay = await makeWebhookRelay(() => {
      /* dispatch */
    });
    const result = relay.handleHttpWebhook(JSON.stringify(makeUpdate(42)), WEBHOOK_SECRET);
    expect(result).toMatchObject({ accepted: true, statusCode: 200 });
    // The durable row exists by the time the 200 ACK was returned.
    const fresh = new FridaySqliteTelegramInboxStore(db);
    const row = fresh
      .listUnprocessed(CHANNEL_ID)
      .concat([]) // pending list may be empty if already processed
      .find((r) => r.updateId === 42);
    // Either still pending or already processed — but it MUST be durably present.
    const committed =
      row !== undefined || fresh.commitInbound(CHANNEL_ID, makeUpdate(42)).inserted === false;
    expect(committed).toBe(true);
    await relay.stopWebhook();
  });

  it("rejects a webhook payload missing a numeric update_id with 400 (cannot dedupe)", async () => {
    const relay = await makeWebhookRelay(() => {
      throw new Error("must not dispatch");
    });
    const result = relay.handleHttpWebhook(JSON.stringify({ message: {} }), WEBHOOK_SECRET);
    expect(result).toMatchObject({ accepted: false, statusCode: 400, code: "TELEGRAM_PAYLOAD_INVALID" });
    await relay.stopWebhook();
  });
});

// ─── No-degrade: happy path, pairing gate, single-run dispatch ───

describe("CHAN-TELEGRAM-INBOX-001 no-degrade", () => {
  it("dispatches a single normal update exactly once and advances the offset", async () => {
    const delivered: number[] = [];
    const transport = createFakeTransport([makeUpdate(5, "hi there")]);
    startPolling(transport.transport, (u) => delivered.push(u.update_id));
    await waitFor(() => delivered.length === 1 && store.loadOffset(CHANNEL_ID) >= 6);

    expect(delivered).toEqual([5]);
    expect(store.loadOffset(CHANNEL_ID)).toBe(6);
    expect(store.listUnprocessed(CHANNEL_ID)).toHaveLength(0);
  });

  it("keeps the pairing gate + normalization intact through the real channel + durable service", async () => {
    const messages: FridayChannelMessage[] = [];
    const fake = createFakeTransport([
      makeUpdate(20, "/start friday_abc123def4"), // pairing handshake — must NOT dispatch
      makeUpdate(21, "a normal already-paired message"), // must dispatch exactly once
    ]);
    const channel = createFridayTelegramChannel({
      polling: createTelegramPollingService({
        inbox: store,
        channelId: CHANNEL_ID,
        transport: fake.transport,
        pollingTimeoutSec: 1,
      }),
    });
    await channel.init({ kind: "telegram", botToken: "scratch-bot-token" });
    await channel.start((msg) => messages.push(msg));
    await waitFor(() => store.loadOffset(CHANNEL_ID) >= 22 && store.listUnprocessed(CHANNEL_ID).length === 0);

    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("a normal already-paired message");
    expect(messages[0].id).toBe("210");
    // Both updates were durably consumed (pairing update is committed + processed, just not dispatched).
    expect(store.listUnprocessed(CHANNEL_ID)).toHaveLength(0);
    await channel.stop();
  });

  it("dispatches a normal already-paired webhook message through the real relay once", async () => {
    const dispatched: number[] = [];
    const relay = await makeWebhookRelay((u) => dispatched.push(u.update_id));
    const result = relay.handleHttpWebhook(JSON.stringify(makeUpdate(30, "hello")), WEBHOOK_SECRET);
    expect(result).toMatchObject({ accepted: true, statusCode: 200 });
    expect(dispatched).toEqual([30]);
    await relay.stopWebhook();
  });
});
