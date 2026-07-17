/**
 * SEC-REALTIME-EVENT-PII-BY-VALUE / round-6 red-first proofs for the legacy
 * upgrade rewrite (friday-realtime-legacy-rewrite.ts):
 *
 *   P0-2 — CONTENT PII in a legacy payload was NEVER redacted (only identifier
 *          fields were pseudonymized). Proven: an email in a CONTENT field
 *          survived the rewrite verbatim at rest and through the pull read seam.
 *   P1-3 — Idempotency trusted the opaque marker SHAPE (`o<ver>_<hex>`), so a
 *          legacy RAW stream id that merely LOOKS opaque (`run:o1_<40hex>`) was
 *          wrongly skipped → never rewritten → unreachable via the re-keyed read
 *          path. Shape != provenance.
 *   P1-4 — Boot rewrite loaded the WHOLE table via a single `.all()` and re-scanned
 *          the full corpus on every restart even after completion.
 *
 * All four assertions are written to FAIL against the pre-fix implementation and
 * pass only once the rewrite (a) applies the canonical content redactor, (b) uses
 * a DURABLE per-row provenance column instead of shape, and (c) is bounded +
 * skips a completed table.
 */

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";
import {
  createFridayRealtimeEventRepository,
  createFridayRealtimeCheckpointRepository,
  createFridayRealtimeSubscriptionService,
} from "#api";
import type { FridayAuthPrincipal } from "#api";
import { createFridayRealtimePseudonymizer } from "../../../../src/api/realtime/friday-realtime-pseudonym.js";
import { rewriteLegacyRealtimeIdentifiers } from "../../../../src/api/realtime/friday-realtime-legacy-rewrite.js";

const OWNER = "admin-001";
const KEY = "durable-master-derived-pseudonym-key-round6"; // pragma: allowlist secret
const NOW = "2026-02-25T12:00:00.000Z";

function activePseudonymizer() {
  return createFridayRealtimePseudonymizer({ resolveOwnerId: () => OWNER, key: KEY });
}

/** A raw stream id whose id-part is EXACTLY the opaque shape `o1_<40 hex>`. */
const SHAPE_COLLIDING_STREAM = `run:o1_${"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"}`;

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

function readAll(db: FridaySqliteLayer): Array<{ event_id: string; stream_id: string; payload_json: string }> {
  return db.withReadConnection((r) =>
    r
      .prepare("SELECT event_id, stream_id, payload_json FROM realtime_events ORDER BY seq ASC")
      .all() as Array<{ event_id: string; stream_id: string; payload_json: string }>,
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

function simpleTestDb(): FridaySqliteLayer {
  const db = new Database(":memory:");
  runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });
  return {
    dbPath: ":memory:",
    writer: db,
    reads: {
      size: 1,
      withReadConnection: (fn) => fn(db),
      close() {},
    },
    withWriteTransaction: (fn) => db.transaction(() => fn(db))(),
    withReadConnection: (fn) => fn(db),
    checkpoint() {},
    optimize() {},
    close() {
      db.close();
    },
  } as FridaySqliteLayer;
}

describe("SEC-REALTIME-EVENT-PII-BY-VALUE round-6 legacy rewrite", () => {
  it("P0-2: redacts CONTENT PII (email/phone/credential/unicode/nested) in legacy payloads at rest and through the pull seam", () => {
    const db = simpleTestDb();
    try {
      const p = activePseudonymizer();
      // A legacy row with PII in NON-identifier CONTENT fields (the identifier
      // pseudonymizer never touches these) plus an identifier field.
      insertRow(db, "evt-legacy", "run:legacy-run", 1, {
        runId: "legacy-run",
        message: "reach me at legacy-owner-canary@example.com or +1 (415) 555-0132",
        credential: "sk-legacylegacylegacylegacylegacy00",
        unicode: "e​mail: legacy＠example.com", // zero-width + fullwidth @
        nested: { note: "backup legacy-owner-canary@example.com", langs: ["café", "日本語"] },
      });

      const result = rewriteLegacyRealtimeIdentifiers(db, p);
      expect(result.rewritten).toBe(1);

      // No canary CONTENT bytes remain at rest.
      const rows = readAll(db);
      const raw = rows.map((r) => r.payload_json).join("\n");
      expect(raw).not.toContain("legacy-owner-canary@example.com");
      expect(raw).not.toContain("415) 555-0132");
      expect(raw).not.toContain("sk-legacylegacylegacylegacylegacy00");
      // Benign multilingual content stays usable.
      expect(raw).toContain("café");
      expect(raw).toContain("日本語");

      // Same guarantee through the real pull read seam.
      const service = createFridayRealtimeSubscriptionService({
        db,
        eventRepo: createFridayRealtimeEventRepository({ resolveOwnerId: () => OWNER }),
        checkpointRepo: createFridayRealtimeCheckpointRepository(),
        nowIso: () => NOW,
        currentEpoch: 1,
        resolveCanonicalOwnerId: () => OWNER,
        pseudonymizeStreamId: (s) => p.streamId(s),
      });
      expect(service.isStreamAuthorized(canonicalPrincipal(), "run:legacy-run")).toBe(true);
      const events = service.pullEvents("run:legacy-run", 0, 50);
      const pulled = JSON.stringify(events);
      expect(pulled).not.toContain("legacy-owner-canary@example.com");
      expect(pulled).not.toContain("sk-legacylegacylegacylegacylegacy00");
    } finally {
      db.close();
    }
  });

  it("P1-3: a legacy RAW stream id shaped EXACTLY like the opaque marker is rewritten ONCE and stays reachable via the client raw id (provenance, not shape)", () => {
    const db = simpleTestDb();
    try {
      const p = activePseudonymizer();
      // Pre-upgrade RAW row whose id-part coincidentally matches `o1_<40hex>`.
      insertRow(db, "evt-collide", SHAPE_COLLIDING_STREAM, 1, { runId: "raw-run-value" });

      const first = rewriteLegacyRealtimeIdentifiers(db, p);
      expect(first.rewritten).toBe(1); // NOT skipped by shape

      // Now stored under the properly re-keyed opaque stream id.
      const expectedOpaque = p.streamId(SHAPE_COLLIDING_STREAM);
      const row = readAll(db).find((r) => r.event_id === "evt-collide")!;
      expect(row.stream_id).toBe(expectedOpaque);

      // Reachable via the client RAW id through the re-keying read path.
      const service = createFridayRealtimeSubscriptionService({
        db,
        eventRepo: createFridayRealtimeEventRepository({ resolveOwnerId: () => OWNER }),
        checkpointRepo: createFridayRealtimeCheckpointRepository(),
        nowIso: () => NOW,
        currentEpoch: 1,
        resolveCanonicalOwnerId: () => OWNER,
        pseudonymizeStreamId: (s) => p.streamId(s),
      });
      const events = service.pullEvents(SHAPE_COLLIDING_STREAM, 0, 50);
      expect(events.map((e) => e.eventId)).toEqual(["evt-collide"]);

      // Survives restart: a second boot rewrites it ZERO more times (durable state).
      const second = rewriteLegacyRealtimeIdentifiers(db, p);
      expect(second.rewritten).toBe(0);
      const rowAfter = readAll(db).find((r) => r.event_id === "evt-collide")!;
      expect(rowAfter.stream_id).toBe(expectedOpaque); // not double-re-keyed
    } finally {
      db.close();
    }
  });

  it("P1-4: a completed rewrite does NOT re-scan the full table on the next boot", () => {
    const db = simpleTestDb();
    try {
      const p = activePseudonymizer();
      insertRow(db, "e1", "run:a", 1, { runId: "a" });
      insertRow(db, "e2", "run:b", 1, { runId: "b" });
      insertRow(db, "e3", "run:c", 1, { runId: "c" });

      expect(rewriteLegacyRealtimeIdentifiers(db, p).rewritten).toBe(3);
      // Second boot: nothing pending → the scan must not walk the whole corpus.
      const second = rewriteLegacyRealtimeIdentifiers(db, p);
      expect(second.rewritten).toBe(0);
      expect(second.scanned).toBe(0);
    } finally {
      db.close();
    }
  });

  it("P1-4: conversion is memory-bounded — no single SELECT loads the whole table", () => {
    const rawDb = new Database(":memory:");
    runFridayMigrations({ db: rawDb, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const TOTAL = 600;
    const insert = rawDb.prepare(
      `INSERT INTO realtime_events (event_id, stream_id, seq, event, payload_json, emitted_at, correlation_id, state_version_json, created_at, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMany = rawDb.transaction(() => {
      for (let i = 0; i < TOTAL; i++) {
        insert.run(`evt-${i}`, `run:raw-${i}`, 1, "workflow.run.started", JSON.stringify({ runId: `raw-${i}` }), NOW, null, null, NOW, OWNER);
      }
    });
    insertMany();

    // Spy: record the row count returned by every SELECT on realtime_events.
    let maxSingleSelectRows = 0;
    const originalPrepare = rawDb.prepare.bind(rawDb);
    (rawDb as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const stmt = originalPrepare(sql) as { all: (...a: unknown[]) => unknown[] };
      if (/select/i.test(sql) && /realtime_events/i.test(sql)) {
        const originalAll = stmt.all.bind(stmt);
        stmt.all = (...args: unknown[]) => {
          const out = originalAll(...args);
          if (Array.isArray(out)) maxSingleSelectRows = Math.max(maxSingleSelectRows, out.length);
          return out;
        };
      }
      return stmt;
    };

    const layer = {
      dbPath: ":memory:",
      writer: rawDb,
      reads: { size: 1, withReadConnection: (fn: (d: Database.Database) => unknown) => fn(rawDb), close() {} },
      withWriteTransaction: (fn: (d: Database.Database) => unknown) => rawDb.transaction(() => fn(rawDb))(),
      withReadConnection: (fn: (d: Database.Database) => unknown) => fn(rawDb),
      checkpoint() {},
      optimize() {},
      close() {
        rawDb.close();
      },
    } as unknown as FridaySqliteLayer;

    try {
      const p = activePseudonymizer();
      const result = rewriteLegacyRealtimeIdentifiers(layer, p);
      expect(result.rewritten).toBe(TOTAL); // all converted
      // Bounded: never materialize the whole table in one SELECT.
      expect(maxSingleSelectRows).toBeLessThan(TOTAL);
    } finally {
      rawDb.close();
    }
  });

  it("P1-4: crash-resumable — a second boot converts only the still-pending rows and leaves finished rows untouched", () => {
    const db = simpleTestDb();
    try {
      const p = activePseudonymizer();
      insertRow(db, "done-1", "run:x", 1, { runId: "x" });
      insertRow(db, "done-2", "run:y", 1, { runId: "y" });
      expect(rewriteLegacyRealtimeIdentifiers(db, p).rewritten).toBe(2);
      const afterFirst = new Map(readAll(db).map((r) => [r.event_id, r.stream_id]));

      // Simulate rows that existed but were not yet processed when the boot crashed.
      insertRow(db, "pending-1", "run:z", 1, { runId: "z" });
      insertRow(db, "pending-2", "run:w", 1, { runId: "w" });

      const resumed = rewriteLegacyRealtimeIdentifiers(db, p);
      expect(resumed.rewritten).toBe(2); // ONLY the still-pending rows
      // Finished rows are byte-identical (no double-processing).
      const afterSecond = new Map(readAll(db).map((r) => [r.event_id, r.stream_id]));
      expect(afterSecond.get("done-1")).toBe(afterFirst.get("done-1"));
      expect(afterSecond.get("done-2")).toBe(afterFirst.get("done-2"));
    } finally {
      db.close();
    }
  });
});
