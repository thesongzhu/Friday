/**
 * SEC-EVENT-REDACTION-001 / P0-C -- upgrade legacy-rewrite + sequence continuity.
 *
 * Proves that after the one-time runtime rewrite: legacy raw stream_ids + payload
 * identifiers are rewritten to the opaque namespace (no raw PII at rest), a canonical
 * owner pulling with the CLIENT RAW id sees BOTH the rewritten legacy event AND the
 * new event in one continuous sequence, and the rewrite is idempotent.
 */

import { describe, it, expect } from "vitest";

import type { FridaySqliteLayer } from "#state";
import {
  createFridayRealtimeEventRepository,
  createFridayRealtimeCheckpointRepository,
  createFridayRealtimeSubscriptionService,
} from "#api";
import type { FridayAuthPrincipal } from "#api";
import { createFridayRealtimePseudonymizer } from "../../../../src/api/realtime/friday-realtime-pseudonym.js";
import { rewriteLegacyRealtimeIdentifiers } from "../../../../src/api/realtime/friday-realtime-legacy-rewrite.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

const OWNER = "admin-001";
const KEY = "durable-master-derived-pseudonym-key-xyz"; // pragma: allowlist secret
const NOW = "2026-02-25T12:00:00.000Z";
const RAW_STREAM = "run:alice@example.com";
const RAW_RUN_ID = "alice@example.com";

function pseudonymizer() {
  return createFridayRealtimePseudonymizer({ resolveOwnerId: () => OWNER, key: KEY });
}

function insertRow(
  db: FridaySqliteLayer,
  eventId: string,
  streamId: string,
  seq: number,
  payload: Record<string, unknown>,
): void {
  db.withWriteTransaction((conn) =>
    conn
      .prepare(
        `INSERT INTO realtime_events (event_id, stream_id, seq, event, payload_json, emitted_at, correlation_id, state_version_json, created_at, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(eventId, streamId, seq, "workflow.run.started", JSON.stringify(payload), NOW, null, null, NOW, OWNER),
  );
}

function canonicalPrincipal(): FridayAuthPrincipal {
  return {
    principalType: "user",
    principalId: OWNER,
    userId: OWNER,
    role: "admin",
    scopes: ["workflow.read"],
    tokenId: "tok",
    tokenKind: "access",
    issuedAt: NOW,
  };
}

describe("SEC-EVENT-REDACTION-001 P0-C legacy rewrite + continuity", () => {
  it("rewrites legacy raw rows to opaque, preserves sequence, removes raw PII, and is idempotent", () => {
    const db = createTestDb();
    try {
      const p = pseudonymizer();
      // Legacy raw row (seq 1) as it existed pre-upgrade, plus a NEW opaque row (seq 2)
      // on the SAME logical stream written post-upgrade by the pseudonymizing sink.
      insertRow(db, "evt-legacy", RAW_STREAM, 1, { runId: RAW_RUN_ID });
      insertRow(db, "evt-new", p.streamId(RAW_STREAM), 2, { runId: p.value(RAW_RUN_ID) });

      const result = rewriteLegacyRealtimeIdentifiers(db, p);
      expect(result.rewritten).toBe(1); // only the legacy row

      // No raw PII remains at rest (stream_id or payload).
      const rows = db.withReadConnection((r) =>
        r
          .prepare("SELECT stream_id, payload_json FROM realtime_events")
          .all() as Array<{ stream_id: string; payload_json: string }>,
      );
      for (const row of rows) {
        expect(row.stream_id).not.toContain(RAW_RUN_ID);
        expect(row.payload_json).not.toContain(RAW_RUN_ID);
      }

      // The legacy row now shares the opaque stream_id of the new row (continuity).
      const legacyStream = db.withReadConnection((r) =>
        (r.prepare("SELECT stream_id FROM realtime_events WHERE event_id = ?").get("evt-legacy") as { stream_id: string }).stream_id,
      );
      expect(legacyStream).toBe(p.streamId(RAW_STREAM));

      // A canonical owner pulling with the CLIENT RAW streamId sees BOTH events in seq.
      const service = createFridayRealtimeSubscriptionService({
        db,
        eventRepo: createFridayRealtimeEventRepository({ resolveOwnerId: () => OWNER }),
        checkpointRepo: createFridayRealtimeCheckpointRepository(),
        nowIso: () => NOW,
        currentEpoch: 1,
        resolveCanonicalOwnerId: () => OWNER,
        pseudonymizeStreamId: (s) => p.streamId(s),
      });
      expect(service.isStreamAuthorized(canonicalPrincipal(), RAW_STREAM)).toBe(true);
      const events = service.pullEvents(RAW_STREAM, 0, 50);
      expect(events.map((e) => e.seq)).toEqual([1, 2]); // no same-epoch gap
      expect(events.map((e) => e.eventId)).toEqual(["evt-legacy", "evt-new"]);

      // Idempotent: a second rewrite touches nothing (all rows already opaque).
      expect(rewriteLegacyRealtimeIdentifiers(db, p).rewritten).toBe(0);
    } finally {
      db.close();
    }
  });

  it("is a no-op when the pseudonymizer is inactive (no key)", () => {
    const db = createTestDb();
    try {
      insertRow(db, "evt-legacy", RAW_STREAM, 1, { runId: RAW_RUN_ID });
      const inactive = createFridayRealtimePseudonymizer({ resolveOwnerId: () => OWNER, key: undefined });
      expect(rewriteLegacyRealtimeIdentifiers(db, inactive)).toEqual({ scanned: 0, rewritten: 0 });
      const streamId = db.withReadConnection((r) =>
        (r.prepare("SELECT stream_id FROM realtime_events WHERE event_id = ?").get("evt-legacy") as { stream_id: string }).stream_id,
      );
      expect(streamId).toBe(RAW_STREAM); // unchanged (fail-safe legacy behavior)
    } finally {
      db.close();
    }
  });
});
