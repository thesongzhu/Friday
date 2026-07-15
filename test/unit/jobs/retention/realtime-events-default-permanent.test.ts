import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import {
  createFridaySatellitePairingRequestRepository,
  createFridaySatelliteHeartbeatRepository,
  createFridayOutboxMessageRepository,
} from "#satellites";
import { createFridayLearningEventLedger, createFridaySkillRunStore } from "#ledger";
import { createFridaySetupBootstrapNonceRepository } from "#api";
import { createFridayRetentionJob } from "#jobs";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

/**
 * DATA-RETENTION-001 negative for realtime_events.
 *
 * realtime_events is an unbounded, append-only, DERIVED projection/replay stream.
 * PR #1606 originally (and wrongly) wired a default 30-day auto-delete of it into
 * the hourly retention job — a DATA-RETENTION-001 violation (local data is
 * default-PERMANENT until the user deletes it). That reaper is fully removed;
 * this guard proves the DEFAULT-policy retention job deletes ZERO realtime_events
 * rows even after unbounded time-travel. Lives in a standalone file (NOT
 * friday-retention-job.test.ts, which #1608 owns) to keep #1606 independent.
 */
describe("retention job — realtime_events is default-permanent", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";

  const pairingRequestRepo = createFridaySatellitePairingRequestRepository();
  const heartbeatRepo = createFridaySatelliteHeartbeatRepository();
  const outboxRepo = createFridayOutboxMessageRepository();
  const bootstrapNonceRepo = createFridaySetupBootstrapNonceRepository();

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function insertRealtimeEvents(count: number, emittedAt: string): void {
    db.withWriteTransaction((writerDb) => {
      const stmt = writerDb.prepare(
        `INSERT INTO realtime_events
           (event_id, stream_id, seq, event, payload_json, emitted_at, correlation_id, state_version_json, created_at)
         VALUES (?, 'stream-1', ?, 'projection.update', '{"k":"v"}', ?, NULL, NULL, ?)`,
      );
      for (let i = 0; i < count; i++) {
        stmt.run(`evt-${i}`, i, emittedAt, emittedAt);
      }
    });
  }

  function countRealtimeEvents(): number {
    return (
      db.writer.prepare("SELECT COUNT(*) AS c FROM realtime_events").get() as { c: number }
    ).c;
  }

  it("never deletes realtime_events under the DEFAULT policy, even far in the future", () => {
    const N = 40;
    // Ancient rows (emitted years before NOW) — the strongest case for a
    // time-based reaper to fire, yet none may be deleted by default.
    insertRealtimeEvents(N, "2020-01-01T00:00:00.000Z");
    expect(countRealtimeEvents()).toBe(N);

    // DEFAULT policy: omit `policy` so the job uses FRIDAY_DEFAULT_RETENTION_POLICY.
    const job = createFridayRetentionJob({
      db,
      pairingRequestRepo,
      heartbeatRepo,
      outboxRepo,
      learningLedger: createFridayLearningEventLedger({ db }),
      skillRunStore: createFridaySkillRunStore({ db }),
      bootstrapNonceRepo,
      nowIso: () => NOW,
    });

    // Advance time far into the future — no elapsed-time cutoff may touch it.
    job.run("2999-12-31T23:59:59.000Z");

    expect(countRealtimeEvents()).toBe(N);
  });
});
