/**
 * SEC-EVENT-REDACTION-001 / FINDING 2 — v106 upgrade-boundary replay gap.
 *
 * A hub upgrading across v106 has pre-upgrade `realtime_events` rows. Without a
 * backfill they keep `owner_id = NULL` and become invisible to the canonical-owner
 * read path, so a reconnecting canonical owner silently loses same-epoch history.
 * v106 backfills legacy NULL rows to the canonical owner; this test simulates the
 * upgrade (apply migrations up to v105, insert a legacy row, then apply v106) and
 * proves the owner-scoped read returns the backfilled legacy seq 1 AND the new seq 2
 * with NO same-epoch gap.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";
import { createFridayRealtimeEventRepository } from "#api";

const CANONICAL_OWNER = "admin-001";
const NOW = "2026-02-25T12:00:00.000Z";
const RUN_STREAM = "run:legacy-run";

describe("v106 upgrade-boundary backfill closes the replay gap", () => {
  it("a canonical owner pulling after seq 0 sees the backfilled legacy seq 1 AND the new seq 2", () => {
    const db = new Database(":memory:");
    try {
      // 1. Upgrade the hub only up to v105 (pre-owner-column).
      runFridayMigrations({
        db,
        migrations: FRIDAY_SQLITE_MIGRATIONS.filter((m) => m.version <= 105),
      });

      // 2. A pre-upgrade realtime event exists (no owner_id column yet → legacy row).
      db.prepare(
        `INSERT INTO realtime_events (event_id, stream_id, seq, event, payload_json, emitted_at, correlation_id, state_version_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("evt-legacy", RUN_STREAM, 1, "workflow.node.completed", "{}", NOW, null, null, NOW);

      // 3. Apply the rest (v106) — ADD COLUMN + backfill NULL → canonical owner.
      runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

      // The legacy row is now attributed to the canonical owner.
      const legacyOwner = db
        .prepare("SELECT owner_id FROM realtime_events WHERE event_id = ?")
        .get("evt-legacy") as { owner_id: string | null };
      expect(legacyOwner.owner_id).toBe(CANONICAL_OWNER);

      // 4. A NEW post-upgrade event is written (owner stamped by the repo).
      const repo = createFridayRealtimeEventRepository({ resolveOwnerId: () => CANONICAL_OWNER });
      repo.append(db, {
        eventId: "evt-new",
        streamId: RUN_STREAM,
        seq: 2,
        event: "workflow.node.completed" as never,
        payload: {} as never,
        emittedAt: NOW,
        correlationId: undefined,
        stateVersion: undefined,
      });

      // 5. Owner-scoped read after seq 0 returns BOTH — no same-epoch gap.
      const events = repo.listAfterSeq(db, RUN_STREAM, 0, 50, CANONICAL_OWNER);
      expect(events.map((e) => e.seq)).toEqual([1, 2]);
      expect(events.map((e) => e.eventId)).toEqual(["evt-legacy", "evt-new"]);
    } finally {
      db.close();
    }
  });
});
