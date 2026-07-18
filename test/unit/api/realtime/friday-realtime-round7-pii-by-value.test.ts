/**
 * SEC-REALTIME-EVENT-PII-BY-VALUE / round-7 — RED-FIRST proofs for the three NEW
 * blocking defects the Advisor found by real-Hub probes:
 *
 *   F1 — Envelope `correlationId` bypassed the sink: it was copied verbatim into the
 *        persistence/delivery envelope and persisted RAW in
 *        `realtime_events.correlation_id`, leaking a PII-shaped identifier at rest AND
 *        on the delivered envelope. Fix pseudonymizes it at the unavoidable sink with
 *        the SAME owner-scoped DETERMINISTIC key as streamId (correlation semantics
 *        survive: same raw correlationId → same opaque), and the legacy-rewrite pass
 *        re-keys existing raw `correlation_id` values.
 *
 *   F2 — Realtime payload SECRET redaction was not Unicode-obfuscation resistant: it
 *        matched only contiguous ASCII `sk-`, so `sk-<U+200B>…`, combining-split,
 *        fullwidth and math-alphanumeric secrets survived RAW. Fix normalizes a
 *        detection copy (NFKD → strip combining marks → strip Cf/Default_Ignorable →
 *        fold Nd digits), matches over the copy, and redacts the mapped ORIGINAL span
 *        (storage byte-identical when nothing matches).
 *
 *   F3 — A malformed/unparseable legacy payload was preserved byte-for-byte while
 *        `identifier_epoch` was stamped → FALSE clean provenance, so a raw canary
 *        stayed at rest AND the row was marked converted (future boots skip it forever).
 *        Fix FAILS CLOSED: an unparseable payload is stripped to a safe placeholder so
 *        NO raw bytes remain BEFORE the epoch is stamped (honest provenance), bounded
 *        and restart-safe.
 *
 * These drive the REAL event bus + repository + legacy-rewrite (the default production
 * path) and raw-read `realtime_events`. All assertions are written to FAIL against the
 * pre-round-7 implementation.
 */

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";
import {
  redactEventPayload,
  createFridayRealtimeEventBus,
  createFridayRealtimeEventRepository,
} from "#api";
import type { FridayRealtimeEventEnvelope } from "#api";
import { createFridayRealtimePseudonymizer } from "../../../../src/api/realtime/friday-realtime-pseudonym.js";
import { rewriteLegacyRealtimeIdentifiers } from "../../../../src/api/realtime/friday-realtime-legacy-rewrite.js";

const OWNER = "admin-001";
const KEY = "durable-master-derived-pseudonym-key-round7"; // pragma: allowlist secret
const NOW = "2026-02-25T12:00:00.000Z";

function activePseudonymizer() {
  return createFridayRealtimePseudonymizer({ resolveOwnerId: () => OWNER, key: KEY });
}

/** In-memory FridaySqliteLayer with the full migration set (v106 owner + epoch). */
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

// ─── F1 — correlationId must be pseudonymized at the sink ───

describe("round-7 F1 — correlationId is pseudonymized at the unavoidable sink", () => {
  const CORR_PII = "correlation-owner@example.com";

  it("persists an OPAQUE correlation_id (no raw PII) AND delivers an OPAQUE correlationId to listeners", () => {
    const db = simpleTestDb();
    try {
      const p = activePseudonymizer();
      const eventRepo = createFridayRealtimeEventRepository({ resolveOwnerId: () => OWNER });
      let counter = 0;
      const bus = createFridayRealtimeEventBus({
        idGenerator: () => `evt-${++counter}`,
        nowIso: () => NOW,
        db,
        eventRepo,
        pseudonymizer: p,
      });
      const delivered: FridayRealtimeEventEnvelope[] = [];
      bus.subscribe((env) => delivered.push(env));

      bus.publish(
        "run:some-stream",
        "workflow.run.started" as never,
        { runId: "some-stream", workflowId: "wf-1", workflowVersionId: "v-1" } as never,
        CORR_PII,
      );

      // RAW at-rest column must not carry the PII.
      const rawCorr = db.withReadConnection(
        (r) =>
          (r
            .prepare("SELECT correlation_id FROM realtime_events WHERE stream_id LIKE 'run:%'")
            .get() as { correlation_id: string | null }).correlation_id,
      );
      expect(rawCorr).not.toBeNull();
      expect(rawCorr!).not.toContain(CORR_PII);
      // Opaque under the current key namespace.
      expect(rawCorr!).toMatch(/^o\d+_[0-9a-f]{8,}$/);
      // Exactly the deterministic pseudonym of the raw value (same-key correlatable).
      expect(rawCorr!).toBe(p.value(CORR_PII));

      // Delivered envelope must ALSO carry only the opaque form (WS/listener plane).
      expect(delivered).toHaveLength(1);
      expect(delivered[0].correlationId).not.toContain(CORR_PII);
      expect(delivered[0].correlationId).toBe(p.value(CORR_PII));
    } finally {
      db.close();
    }
  });

  it("is DETERMINISTIC: two events with the SAME raw correlationId get the SAME opaque (correlation survives)", () => {
    const db = simpleTestDb();
    try {
      const p = activePseudonymizer();
      const eventRepo = createFridayRealtimeEventRepository({ resolveOwnerId: () => OWNER });
      let counter = 0;
      const bus = createFridayRealtimeEventBus({
        idGenerator: () => `evt-${++counter}`,
        nowIso: () => NOW,
        db,
        eventRepo,
        pseudonymizer: p,
      });

      // The persisted stream_ids are OPAQUE, so key on insertion order (rowid) instead.
      bus.publish("run:a", "workflow.run.started" as never, { runId: "a" } as never, CORR_PII);
      bus.publish("run:b", "workflow.run.started" as never, { runId: "b" } as never, CORR_PII);
      bus.publish("run:c", "workflow.run.started" as never, { runId: "c" } as never, "other-corr@example.com");

      const corrs = db
        .withReadConnection(
          (r) =>
            r
              .prepare("SELECT correlation_id FROM realtime_events ORDER BY rowid ASC")
              .all() as Array<{ correlation_id: string | null }>,
        )
        .map((c) => c.correlation_id);
      expect(corrs).toHaveLength(3);
      // Same raw correlationId → identical opaque (still correlatable).
      expect(corrs[0]).toBe(corrs[1]);
      // Distinct raw correlationId → distinct opaque.
      expect(corrs[0]).not.toBe(corrs[2]);
      for (const c of corrs) {
        expect(c).not.toBeNull();
        expect(c!).not.toContain("example.com");
      }
    } finally {
      db.close();
    }
  });

  it("legacy-rewrite re-keys a raw correlation_id AND stamps epoch", () => {
    const db = simpleTestDb();
    try {
      const p = activePseudonymizer();
      db.withWriteTransaction((conn) =>
        conn
          .prepare(
            `INSERT INTO realtime_events (event_id, stream_id, seq, event, payload_json, emitted_at, correlation_id, state_version_json, created_at, owner_id, identifier_epoch)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("evt-legacy-corr", "run:legacy", 1, "workflow.run.started", JSON.stringify({ runId: "legacy" }), NOW, CORR_PII, null, NOW, OWNER, null),
      );

      const result = rewriteLegacyRealtimeIdentifiers(db, p);
      expect(result.rewritten).toBe(1);

      const row = db.withReadConnection(
        (r) =>
          r
            .prepare("SELECT correlation_id, identifier_epoch FROM realtime_events WHERE event_id = ?")
            .get("evt-legacy-corr") as { correlation_id: string | null; identifier_epoch: number | null },
      );
      expect(row.correlation_id).not.toContain(CORR_PII);
      expect(row.correlation_id).toBe(p.value(CORR_PII));
      expect(row.identifier_epoch).toBe(1);
    } finally {
      db.close();
    }
  });
});

// ─── F2 — Unicode-obfuscation-resistant SECRET redaction ───

describe("round-7 F2 — secret redaction is Unicode-obfuscation resistant", () => {
  const ZWSP = "​"; // zero-width space (Cf)
  const COMBINING_ACUTE = "́";

  function serialize(v: unknown): string {
    return JSON.stringify(v);
  }

  it("redacts a zero-width-split sk- secret (Cf strip)", () => {
    const secret = `sk-${ZWSP}a5canaryzerowidthsecret0000`; // pragma: allowlist secret
    const out = redactEventPayload({ note: `token ${secret} end` });
    const s = serialize(out);
    expect(s).not.toContain("a5canaryzerowidthsecret0000"); // pragma: allowlist secret
    expect(s).toContain("[REDACTED]");
  });

  it("redacts a combining-mark-split sk- secret (\\p{M} strip)", () => {
    // A combining acute on the 's' breaks the contiguous ASCII match; NFKD + mark-strip
    // recovers `sk-…`.
    const secret = `s${COMBINING_ACUTE}k-a5canarycombiningsecret0000`; // pragma: allowlist secret
    const out = redactEventPayload({ note: `hdr ${secret}` });
    const s = serialize(out);
    expect(s).not.toContain("a5canarycombiningsecret0000"); // pragma: allowlist secret
    expect(s).toContain("[REDACTED]");
  });

  it("redacts a fullwidth-encoded sk- secret (NFKD compatibility fold)", () => {
    // Fullwidth 's','k' and fullwidth hyphen-minus.
    const secret = "ｓｋ－a5canaryfullwidthsecret0000"; // ｓｋ－… // pragma: allowlist secret
    const out = redactEventPayload({ note: `x ${secret} y` });
    const s = serialize(out);
    expect(s).not.toContain("a5canaryfullwidthsecret0000"); // pragma: allowlist secret
    expect(s).toContain("[REDACTED]");
  });

  it("redacts a math-alphanumeric sk- secret (NFKD compatibility fold)", () => {
    // Mathematical sans-serif 's' (U+1D5CC) and 'k' (U+1D5C4).
    const secret = "\u{1D5CC}\u{1D5C4}-a5canarymathsecret00000000"; // pragma: allowlist secret
    const out = redactEventPayload({ note: `m ${secret}` });
    const s = serialize(out);
    expect(s).not.toContain("a5canarymathsecret00000000"); // pragma: allowlist secret
    expect(s).toContain("[REDACTED]");
  });

  it("canonical equivalence: precomposed and decomposed accented forms redact identically", () => {
    // The secret body embeds an accented letter that NFKD folds to an ASCII letter after
    // mark-strip: `sk-café…` (precomposed é) and `sk-café…` (decomposed) must BOTH
    // be detected and redacted.
    const precomposed = "sk-cafécanarysecret000000"; // é precomposed // pragma: allowlist secret
    const decomposed = "sk-cafécanarysecret000000"; // e + combining acute // pragma: allowlist secret
    const outP = serialize(redactEventPayload({ note: `p ${precomposed}` }));
    const outD = serialize(redactEventPayload({ note: `d ${decomposed}` }));
    expect(outP).not.toContain("canarysecret000000");
    expect(outD).not.toContain("canarysecret000000");
    expect(outP).toContain("[REDACTED]");
    expect(outD).toContain("[REDACTED]");
  });

  it("does NOT over-redact benign multilingual / accented content (byte-identical)", () => {
    const payload = { note: "café ☕ 日本語 naïve résumé — a normal message", region: "us-west-2" };
    const out = redactEventPayload(payload);
    expect(out).toEqual(payload);
    expect(JSON.stringify(out)).toBe(JSON.stringify(payload));
  });

  it("at-rest: a zero-width-split secret does not persist raw in payload_json (real bus + repo)", () => {
    const db = simpleTestDb();
    try {
      const p = activePseudonymizer();
      const eventRepo = createFridayRealtimeEventRepository({ resolveOwnerId: () => OWNER });
      let counter = 0;
      const bus = createFridayRealtimeEventBus({
        idGenerator: () => `evt-${++counter}`,
        nowIso: () => NOW,
        db,
        eventRepo,
        pseudonymizer: p,
      });
      const delivered: FridayRealtimeEventEnvelope[] = [];
      bus.subscribe((env) => delivered.push(env));

      const secret = `sk-${ZWSP}a5canaryatrestsecret00000000`; // pragma: allowlist secret
      bus.publish(
        "run:s",
        "workflow.run.failed" as never,
        { runId: "s", error: { message: `stderr leaked ${secret}` } } as never,
      );

      const stored = db.withReadConnection(
        (r) =>
          (r
            .prepare("SELECT payload_json FROM realtime_events WHERE stream_id LIKE 'run:%'")
            .get() as { payload_json: string }).payload_json,
      );
      expect(stored).not.toContain("a5canaryatrestsecret00000000"); // pragma: allowlist secret
      expect(stored).toContain("[REDACTED]");
      // Delivered envelope too.
      expect(JSON.stringify(delivered[0].payload)).not.toContain("a5canaryatrestsecret00000000"); // pragma: allowlist secret
    } finally {
      db.close();
    }
  });
});

// ─── F3 — malformed legacy payload fails closed (no false clean provenance) ───

describe("round-7 F3 — malformed legacy payload fails closed", () => {
  const MALFORMED_PII = "malformed-legacy-owner@example.com";

  /** Insert a row with RAW, UNPARSEABLE payload_json bytes (identifier_epoch NULL). */
  function insertMalformed(db: FridaySqliteLayer, eventId: string, rawPayload: string, seq = 1): void {
    db.withWriteTransaction((conn) =>
      conn
        .prepare(
          `INSERT INTO realtime_events (event_id, stream_id, seq, event, payload_json, emitted_at, correlation_id, state_version_json, created_at, owner_id, identifier_epoch)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(eventId, "run:legacy-malformed", seq, "workflow.run.started", rawPayload, NOW, null, null, NOW, OWNER, null),
    );
  }

  it("strips an unparseable payload's raw canary and only THEN stamps epoch (honest provenance)", () => {
    const db = simpleTestDb();
    try {
      const p = activePseudonymizer();
      // Truncated / invalid JSON that still carries the raw canary bytes.
      insertMalformed(db, "evt-malformed", `{"message":"reach ${MALFORMED_PII}", "runId":`);

      const result = rewriteLegacyRealtimeIdentifiers(db, p);
      expect(result.rewritten).toBe(1);

      const row = db.withReadConnection(
        (r) =>
          r
            .prepare("SELECT payload_json, identifier_epoch FROM realtime_events WHERE event_id = ?")
            .get("evt-malformed") as { payload_json: string; identifier_epoch: number | null },
      );
      // The raw canary must be GONE from storage.
      expect(row.payload_json).not.toContain(MALFORMED_PII);
      // Provenance is honest ONLY because the bytes were safely removed: the row is
      // genuinely clean, so it may carry the epoch AND must be valid JSON for readers.
      expect(row.identifier_epoch).toBe(1);
      expect(() => JSON.parse(row.payload_json)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("bounded + restart-safe: a malformed row is converted once and never re-scanned or infinite-looped", () => {
    const db = simpleTestDb();
    try {
      const p = activePseudonymizer();
      insertMalformed(db, "m1", `not json at all ${MALFORMED_PII}`, 1);
      insertMalformed(db, "m2", `[unterminated ${MALFORMED_PII}`, 2);

      const first = rewriteLegacyRealtimeIdentifiers(db, p);
      expect(first.rewritten).toBe(2);

      // No raw canary remains anywhere.
      const raw = db
        .withReadConnection((r) => r.prepare("SELECT payload_json FROM realtime_events").all() as Array<{ payload_json: string }>)
        .map((x) => x.payload_json)
        .join("\n");
      expect(raw).not.toContain(MALFORMED_PII);

      // Second boot: nothing pending → zero rescanned, zero rewritten (no infinite loop).
      const second = rewriteLegacyRealtimeIdentifiers(db, p);
      expect(second).toEqual({ scanned: 0, rewritten: 0 });
    } finally {
      db.close();
    }
  });

  it("a valid legacy payload is still pseudonymized + content-redacted (no regression)", () => {
    const db = simpleTestDb();
    try {
      const p = activePseudonymizer();
      db.withWriteTransaction((conn) =>
        conn
          .prepare(
            `INSERT INTO realtime_events (event_id, stream_id, seq, event, payload_json, emitted_at, correlation_id, state_version_json, created_at, owner_id, identifier_epoch)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("evt-valid", "run:legacy-valid", 1, "workflow.run.started", JSON.stringify({ runId: "legacy-valid", message: `email ${MALFORMED_PII}` }), NOW, null, null, NOW, OWNER, null),
      );
      expect(rewriteLegacyRealtimeIdentifiers(db, p).rewritten).toBe(1);
      const row = db.withReadConnection(
        (r) =>
          r
            .prepare("SELECT payload_json, identifier_epoch FROM realtime_events WHERE event_id = ?")
            .get("evt-valid") as { payload_json: string; identifier_epoch: number | null },
      );
      expect(row.payload_json).not.toContain(MALFORMED_PII);
      expect(row.payload_json).toContain("[EMAIL]");
      expect(row.identifier_epoch).toBe(1);
    } finally {
      db.close();
    }
  });
});
