/**
 * CHAN-TELEGRAM-RETENTION — bounded-retention reaper for the durable `telegram_inbox`.
 *
 * The durable inbox (CHAN-TELEGRAM-INBOX-001) writes one row per inbound update and never
 * pruned terminal rows, so the table grows unbounded. These tests drive the REAL
 * FridaySqliteTelegramInboxStore + real polling service against a scratch SQLite DB (same
 * harness as telegram-inbox.test.ts) to prove:
 *
 *   - OLD terminal rows ('processed' / 'delivery_unknown') are pruned past the window.
 *   - RECENT terminal rows are KEPT and still deduped (dedupe correctness preserved).
 *   - 'pending' rows are NEVER pruned at ANY age (recovery re-drives them).
 *   - The reaper runs opportunistically inside the poll loop without disturbing dispatch.
 *
 * No real bot token / network — the getUpdates transport is injected, exactly like the
 * inbox suite.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createFridaySqliteLayer } from "#state";
import {
  FridaySqliteTelegramInboxStore,
  TELEGRAM_INBOX_RETENTION_MS,
  createInMemoryTelegramInboxStore,
  createTelegramPollingService,
} from "#channels";
import type { TelegramGetUpdatesTransport, TelegramUpdate } from "#channels";

const CHANNEL_ID = "telegram";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let tmpDir: string;
let db: ReturnType<typeof createFridaySqliteLayer>;
let store: FridaySqliteTelegramInboxStore;
const activePollServices: Array<{ stopPolling: () => Promise<void> }> = [];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-tg-retention-"));
  db = createFridaySqliteLayer({
    dbPath: path.join(tmpDir, "test.db"),
    readPoolSize: 1,
    pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
  });
  store = new FridaySqliteTelegramInboxStore(db);
});

afterEach(async () => {
  for (const svc of activePollServices.splice(0)) {
    try {
      await svc.stopPolling();
    } catch {
      // ignore
    }
  }
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

// ─── Direct-SQL helpers to backdate timestamps + observe rows (age is time-based) ───

function setProcessedAt(updateId: number, ms: number): void {
  db.withWriteTransaction((d) =>
    d
      .prepare(
        `UPDATE telegram_inbox SET processed_at_ms = ? WHERE channel_id = ? AND update_id = ?`,
      )
      .run(ms, CHANNEL_ID, updateId),
  );
}

function setReceivedAt(updateId: number, ms: number): void {
  db.withWriteTransaction((d) =>
    d
      .prepare(
        `UPDATE telegram_inbox SET received_at_ms = ? WHERE channel_id = ? AND update_id = ?`,
      )
      .run(ms, CHANNEL_ID, updateId),
  );
}

function rowCount(updateId: number): number {
  const row = db.withReadConnection((d) =>
    d
      .prepare(
        `SELECT COUNT(*) AS n FROM telegram_inbox WHERE channel_id = ? AND update_id = ?`,
      )
      .get(CHANNEL_ID, updateId),
  ) as { n: number };
  return row.n;
}

function createFakeTransport(initial: TelegramUpdate[] = []): TelegramGetUpdatesTransport {
  let queue = [...initial];
  return async ({ offset, signal }) => {
    if (offset > 0) queue = queue.filter((u) => u.update_id >= offset);
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
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
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

// ─── Store-level prune semantics ───

describe("CHAN-TELEGRAM-RETENTION store prune", () => {
  it("prunes an OLD 'processed' row past the retention window (age by processed_at_ms)", () => {
    const now = Date.now();
    store.commitInbound(CHANNEL_ID, makeUpdate(5));
    store.markProcessed(CHANNEL_ID, 5);
    // Backdate the terminal timestamp to well past the window.
    setProcessedAt(5, now - TELEGRAM_INBOX_RETENTION_MS - DAY_MS);
    expect(rowCount(5)).toBe(1);

    const deleted = store.pruneTerminalOlderThan(CHANNEL_ID, now - TELEGRAM_INBOX_RETENTION_MS);
    expect(deleted).toBe(1);
    expect(rowCount(5)).toBe(0);
  });

  it("prunes an OLD 'delivery_unknown' row by the received_at_ms fallback (processed_at_ms NULL)", () => {
    const now = Date.now();
    store.commitInbound(CHANNEL_ID, makeUpdate(6)); // pending, processed_at_ms NULL
    store.reconcileOrphaned(CHANNEL_ID); // → delivery_unknown, processed_at_ms stays NULL
    setReceivedAt(6, now - TELEGRAM_INBOX_RETENTION_MS - DAY_MS);
    expect(rowCount(6)).toBe(1);

    const deleted = store.pruneTerminalOlderThan(CHANNEL_ID, now - TELEGRAM_INBOX_RETENTION_MS);
    expect(deleted).toBe(1); // pruned via COALESCE(processed_at_ms, received_at_ms) fallback
    expect(rowCount(6)).toBe(0);
  });

  it("KEEPS a RECENT terminal row and still dedupes a resend of that update_id", () => {
    const now = Date.now();
    store.commitInbound(CHANNEL_ID, makeUpdate(7));
    store.markProcessed(CHANNEL_ID, 7); // processed_at_ms ≈ now (fresh)

    const deleted = store.pruneTerminalOlderThan(CHANNEL_ID, now - TELEGRAM_INBOX_RETENTION_MS);
    expect(deleted).toBe(0); // within the window → retained
    expect(rowCount(7)).toBe(1);

    // Dedupe correctness preserved: a redelivery/webhook-resend is still deduped, not re-dispatched.
    const resend = store.commitInbound(CHANNEL_ID, makeUpdate(7));
    expect(resend).toMatchObject({ inserted: false, shouldDeliver: false, status: "processed" });
  });

  it("NEVER prunes a 'pending' row at ANY age (recovery still finds it)", () => {
    const now = Date.now();
    store.commitInbound(CHANNEL_ID, makeUpdate(8)); // pending
    setReceivedAt(8, now - TELEGRAM_INBOX_RETENTION_MS * 10); // ancient

    // Even with a cutoff FAR in the future (would catch any terminal row), pending is excluded
    // by status, not by age.
    const deleted = store.pruneTerminalOlderThan(CHANNEL_ID, now + TELEGRAM_INBOX_RETENTION_MS);
    expect(deleted).toBe(0);
    expect(rowCount(8)).toBe(1);
    expect(store.listUnprocessed(CHANNEL_ID).map((r) => r.updateId)).toContain(8);
  });
});

// ─── Reaper wiring: runs opportunistically in the poll loop, no dispatch degrade ───

describe("CHAN-TELEGRAM-RETENTION reaper wiring (poll loop)", () => {
  it("reaps an OLD terminal row during a poll cycle while dispatching a new update exactly once", async () => {
    const now = Date.now();
    // Seed an OLD terminal row that must be reaped.
    store.commitInbound(CHANNEL_ID, makeUpdate(1));
    store.markProcessed(CHANNEL_ID, 1);
    setProcessedAt(1, now - TELEGRAM_INBOX_RETENTION_MS - DAY_MS);
    expect(rowCount(1)).toBe(1);

    const delivered: number[] = [];
    startPolling(createFakeTransport([makeUpdate(50)]), (u) => delivered.push(u.update_id));

    // The poll loop's throttled reaper prunes the old row, and the fresh update dispatches once.
    await waitFor(() => delivered.includes(50) && rowCount(1) === 0);
    expect(rowCount(1)).toBe(0); // reaped during the poll cycle
    expect(delivered).toEqual([50]); // normal dispatch unaffected (exactly once)
    expect(store.loadOffset(CHANNEL_ID)).toBe(51);
  });

  it("no-degrade: recovery of a committed-but-unprocessed row still works with the reaper wired", async () => {
    // Simulate a prior crash: a fresh row was committed but never dispatched.
    store.commitInbound(CHANNEL_ID, makeUpdate(9));
    expect(store.listUnprocessed(CHANNEL_ID)).toHaveLength(1);

    const delivered: number[] = [];
    startPolling(createFakeTransport([]), (u) => delivered.push(u.update_id));
    await waitFor(() => delivered.includes(9) && store.listUnprocessed(CHANNEL_ID).length === 0);

    expect(delivered).toEqual([9]); // re-driven from the inbox (reaper never touched the pending row)
    expect(store.listUnprocessed(CHANNEL_ID)).toHaveLength(0);
  });
});

// ─── In-memory default store: same prune contract (used when no db is injected) ───

describe("CHAN-TELEGRAM-RETENTION in-memory default store", () => {
  it("prunes OLD terminal rows, keeps recent ones, and never prunes pending", () => {
    const mem = createInMemoryTelegramInboxStore();
    // Recent processed row.
    mem.commitInbound(CHANNEL_ID, makeUpdate(1));
    mem.markProcessed(CHANNEL_ID, 1);
    // Pending row (must survive at any age).
    mem.commitInbound(CHANNEL_ID, makeUpdate(2));

    // Cutoff just after "now" would catch every terminal row; pending is excluded by status.
    const deleted = mem.pruneTerminalOlderThan(CHANNEL_ID, Date.now() + 1_000);
    expect(deleted).toBe(1); // only the processed row (update 1)
    // Pending row still recoverable.
    expect(mem.listUnprocessed(CHANNEL_ID).map((r) => r.updateId)).toEqual([2]);

    // A far-past cutoff keeps the (recent) pending-derived terminal untouched.
    const none = mem.pruneTerminalOlderThan(CHANNEL_ID, Date.now() - TELEGRAM_INBOX_RETENTION_MS);
    expect(none).toBe(0);
  });
});
