/**
 * SEC-REALTIME-EVENT-PII — value-PII coverage for the realtime / agent
 * event-payload redactor.
 *
 * `redactEventPayload` is the SINGLE PII/secret gate for the realtime +
 * agent-event pipeline (at-rest: realtime_events + friday_agent_run_events;
 * on-wire: event bus, WS gateway, execution-control audit). Before this slice
 * it only masked (a) values under a fixed SENSITIVE_KEYS set and (b)
 * secret-SHAPED strings — email / phone / SSN / card in free text,
 * full-width / CJK-adjacent PII, and numeric-typed PII all egressed CLEAR.
 *
 * These tests assert BOTH layered passes:
 *   - PII-by-value (via the shared production `redactDeep`) — RED before the fix.
 *   - Secret-shaped + sensitive-key coverage — must STAY green (no regression).
 *   - Benign business identifiers preserved (NO DEGRADE / no over-redaction).
 *   - Cyclic payloads do not stack-overflow (cycle-safe combined path).
 *
 * The at-rest + on-wire blocks drive the REAL repositories / bus / emitter
 * (the DEFAULT production path — redaction is not a test-only injection).
 */

import { describe, it, expect } from "vitest";

import type { FridaySqliteLayer } from "#state";
import {
  redactEventPayload,
  createFridayRealtimeEventRepository,
  createFridayRealtimeEventBus,
  createExecutionControlEventEmitter,
} from "#api";
import type { FridayRealtimeEventEnvelope } from "#api";
import {
  createFridayAgentRunEventRepository,
  createFridayAgentRunRepository,
} from "#agent";
import {
  createTestDb,
  createTestIdGenerator,
} from "../../satellites/_helpers/create-test-db.helper.js";

// ─── Canonical PII fixtures (synthetic) ───

const EMAIL = "john.doe@example.com";
const PHONE = "415-555-0132";
const SSN = "123-45-6789";
const CARD = "4111 1111 1111 1111"; // Luhn-valid synthetic test PAN // pragma: allowlist secret

/** Fold ASCII digits/hyphen to their full-width (U+FF10–19 / U+FF0D) forms. */
function toFullWidth(s: string): string {
  return s
    .replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + Number(d)))
    .replace(/-/g, "－");
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

// ─── PII-by-value (RED before fix, GREEN after) ───

describe("redactEventPayload — PII by value", () => {
  it("redacts an email in free text under a non-sensitive key", () => {
    const out = redactEventPayload({ note: `reach me at ${EMAIL} please` });
    const s = serialize(out);
    expect(s).not.toContain(EMAIL);
    expect(s).toContain("[EMAIL]");
  });

  it("redacts a US phone number in free text", () => {
    const out = redactEventPayload({ note: `call ${PHONE} today` });
    const s = serialize(out);
    expect(s).not.toContain(PHONE);
    expect(s).toContain("[PHONE_US]");
  });

  it("redacts a full-width-digit phone number (Unicode fold)", () => {
    const fwPhone = toFullWidth(PHONE);
    const out = redactEventPayload({ note: `拨打 ${fwPhone} 谢谢` });
    const s = serialize(out);
    expect(s).not.toContain(fwPhone);
    expect(s).toContain("[PHONE_US]");
  });

  it("redacts a US SSN in free text", () => {
    const out = redactEventPayload({ note: `SSN on file: ${SSN}.` });
    const s = serialize(out);
    expect(s).not.toContain(SSN);
    expect(s).toContain("[SSN_US]");
  });

  it("redacts a Luhn-valid credit-card number in free text", () => {
    const out = redactEventPayload({ note: `credit card ${CARD} was charged` });
    const s = serialize(out);
    expect(s).not.toContain(CARD);
    expect(s).not.toContain(CARD.replace(/ /g, ""));
    expect(s).toContain("[CREDIT_CARD]");
  });

  it("redacts an email adjacent to CJK text (no whitespace boundary)", () => {
    const out = redactEventPayload({ note: `联系${EMAIL}谢谢` });
    const s = serialize(out);
    expect(s).not.toContain(EMAIL);
    expect(s).toContain("[EMAIL]");
  });

  it("redacts numeric-typed phone PII under a key the old set missed", () => {
    // key "phone" is NOT in the legacy SENSITIVE_KEYS set and the value is a
    // number, so the pre-slice redactor let it through CLEAR (RED).
    const out = redactEventPayload({ phone: 4155550132 });
    const s = serialize(out);
    expect(s).not.toContain("4155550132");
    expect(s).toContain("[PHONE_US]");
  });

  it("redacts numeric-typed SSN under a descriptive key (two-gate)", () => {
    const out = redactEventPayload({ socialSecurity: 123456789 });
    const s = serialize(out);
    expect(s).not.toContain("123456789");
    expect(s).toContain("[SSN_US]");
  });

  it("redacts PII nested in objects and arrays", () => {
    const out = redactEventPayload({
      contacts: [
        { email: EMAIL },
        { detail: { note: `SSN ${SSN}` } },
      ],
    });
    const s = serialize(out);
    expect(s).not.toContain(EMAIL);
    expect(s).not.toContain(SSN);
    expect(s).toContain("[EMAIL]");
    expect(s).toContain("[SSN_US]");
  });
});

// ─── Secret-shaped coverage must NOT regress ───

describe("redactEventPayload — secret shapes (no regression)", () => {
  it("redacts Bearer / sk- / gh_ / JWT / assignment / PEM secret shapes", () => {
    const out = redactEventPayload({
      log:
        "Authorization: Bearer sk-a5-canary-bearer-secret-1234 " + // pragma: allowlist secret
        "loose sk-a5canarylooseapikey0000 " + // pragma: allowlist secret
        "ghp_a5CanaryGithubPat0123456789abcdef " + // pragma: allowlist secret
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhNSJ9.a5canarysignature01 " + // pragma: allowlist secret
        'api_key="a5canaryassignmentvalue0" ' + // pragma: allowlist secret
        "-----BEGIN PRIVATE KEY-----\na5canarypem\n-----END PRIVATE KEY-----", // pragma: allowlist secret
    });
    const s = serialize(out);
    expect(s).not.toContain("sk-a5-canary-bearer-secret-1234"); // pragma: allowlist secret
    expect(s).not.toContain("sk-a5canarylooseapikey0000"); // pragma: allowlist secret
    expect(s).not.toContain("ghp_a5CanaryGithubPat0123456789abcdef"); // pragma: allowlist secret
    expect(s).not.toContain("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhNSJ9.a5canarysignature01"); // pragma: allowlist secret
    expect(s).not.toContain("a5canaryassignmentvalue0"); // pragma: allowlist secret
    expect(s).not.toContain("a5canarypem");
    expect(s).toContain("[REDACTED]");
  });

  // SEC-SECRET-GLUED-PREFIX-001: a distinctive-prefix credential GLUED directly to a preceding word
  // char (`keyhf_<34>`) had no word boundary before the prefix, so the canonical detector's leading
  // `\b` skipped it and it egressed on-wire to agents/channels. Built from parts (`seg`) so no literal
  // token appears in SOURCE. RED on bf6968f9 (credential survives in the payload), GREEN after.
  it("redacts a distinctive-prefix credential GLUED after a word char (glued-prefix evasion, on-wire)", () => {
    const seg = (...p: string[]) => p.join(""); // pragma: allowlist secret
    const HF = seg("hf_", "AbCdEfGhIjKlMnOpQrStUvWxYz01234567"); // pragma: allowlist secret — 34 base62
    const GSK = seg("gsk_", "abcdefghijklmnopqrstuvwxyz0123456789ABCDwx"); // pragma: allowlist secret — 42 base62
    const GLPAT = seg("glpat-", "ABCdef0123456789ghijkLMNop"); // pragma: allowlist secret
    const out = redactEventPayload({
      log: seg("deploy key", HF, " and x", GSK, " and id", GLPAT, " done"),
    });
    const s = serialize(out);
    for (const cred of [HF, GSK, GLPAT]) expect(s, cred).not.toContain(cred);
    expect(s).toContain("[REDACTED]");
    // Benign surrounding + glued leading chars survive (only the credential subspan is masked).
    expect(s).toContain("deploy key");
    expect(s).toContain("done");
  });

  it("masks values under legacy sensitive keys", () => {
    const out = redactEventPayload({
      password: "hunter2-a5", // pragma: allowlist secret
      apiKey: "sk-a5-short", // pragma: allowlist secret
      credit_card: "4111111111", // short partial // pragma: allowlist secret
      userId: "user-1",
      name: "Test",
    });
    expect(out.password).toBe("[REDACTED]");
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.credit_card).toBe("[REDACTED]");
    expect(out.userId).toBe("user-1");
    expect(out.name).toBe("Test");
  });
});

// ─── NO DEGRADE — benign business identifiers preserved ───

describe("redactEventPayload — no over-redaction (NO DEGRADE)", () => {
  it("preserves benign numeric business identifiers under non-sensitive keys", () => {
    const payload = {
      orderId: 123456789, // SSN-shaped digits, but benign under a non-sensitive key
      invoiceNumber: 987654321012,
      transactionRef: 4111111111111111, // Luhn-valid 16-digit number, benign id // pragma: allowlist secret
      count: 42,
      retries: 3,
      timestampMs: 1719792000000,
    };
    const out = redactEventPayload(payload);
    expect(out).toEqual(payload);
  });

  it("preserves benign values under sensitive-sounding keys (value gate)", () => {
    const payload = { giftCard: 3, headPhone: 42, simCard: 2 };
    const out = redactEventPayload(payload);
    expect(out).toEqual(payload);
  });

  it("preserves benign non-PII strings", () => {
    const payload = { status: "active", region: "us-west-2", sku: "ORD-98765" };
    const out = redactEventPayload(payload);
    expect(out).toEqual(payload);
  });

  // NO-DEGRADE (SEC-SECRET-GLUED-PREFIX-001 round-2): benign snake_case words ending in `ghs`/etc before
  // `_` must NOT be over-redacted on-wire — the github-classic base62 body breaks at the `_`. The
  // first-round `[A-Za-z0-9_]` body corrupted these (`walkthroughs_completed_counter` → `walkthrou[REDACTED]`).
  it("preserves benign `…ghs_<snake_case>` identifiers (github-classic base62 body, no over-redaction)", () => {
    const payload = {
      walk: "walkthroughs_completed_counter",
      breakt: "breakthroughs_this_quarter_list",
      cough: "coughs_detected_in_recording_v2",
      laugh: "laughs_per_minute_counter",
      note: "metric name walkthroughs_started_and_completed today",
    };
    const out = redactEventPayload(payload);
    expect(out).toEqual(payload);
    expect(serialize(out)).not.toContain("[REDACTED]");
  });

  it("preserves a pure-digit object key (business id, \\p{Nd} exemption)", () => {
    const out = redactEventPayload({ "1234567890123456": "ok" }); // pragma: allowlist secret
    expect(Object.keys(out)).toContain("1234567890123456");
    expect((out as Record<string, unknown>)["1234567890123456"]).toBe("ok");
  });

  it("does not mutate the original payload", () => {
    const original = { note: `email ${EMAIL}`, token: "abc" };
    const out = redactEventPayload(original);
    expect(original.note).toBe(`email ${EMAIL}`);
    expect(serialize(out)).not.toContain(EMAIL);
  });

  it("passes primitive and null values through unchanged", () => {
    expect(redactEventPayload(null)).toBe(null);
    expect(redactEventPayload(undefined)).toBe(undefined);
    expect(redactEventPayload(42)).toBe(42);
    expect(redactEventPayload("plain text")).toBe("plain text");
  });
});

// ─── Cycle safety (combined path must not stack-overflow) ───

describe("redactEventPayload — cycle safety", () => {
  it("does not throw on a cyclic payload and preserves scalar leaves", () => {
    const cyclic: Record<string, unknown> = { a: 1, note: `contact ${EMAIL}` };
    cyclic.self = cyclic;
    let out: Record<string, unknown> | undefined;
    expect(() => {
      out = redactEventPayload(cyclic) as Record<string, unknown>;
    }).not.toThrow();
    expect(out?.a).toBe(1);
    expect(serialize(out?.note)).not.toContain(EMAIL);
  });
});

// ─── E2E at-rest: REAL repositories (default production path) ───

describe("redactEventPayload — at-rest via real repositories", () => {
  const NOW = "2026-02-25T12:00:00.000Z";

  it("realtime_events: PII does not persist clear in payload_json", () => {
    const db: FridaySqliteLayer = createTestDb();
    try {
      const repo = createFridayRealtimeEventRepository();
      const envelope: FridayRealtimeEventEnvelope = {
        eventId: "evt-pii-1",
        streamId: "workflow:wf-pii",
        seq: 1,
        event: "workflow.run.failed",
        payload: {
          runId: "run-pii",
          error: { message: `user ${EMAIL} card ${CARD} phone ${PHONE}` },
        },
        emittedAt: NOW,
        correlationId: undefined,
        stateVersion: undefined,
      };
      db.withWriteTransaction((w) => repo.append(w, envelope));

      const stored = db.withReadConnection(
        (r) =>
          r
            .prepare("SELECT payload_json FROM realtime_events WHERE event_id = ?")
            .get("evt-pii-1") as { payload_json: string },
      );
      const readBack = db.withReadConnection((r) =>
        repo.listByStream(r, "workflow:wf-pii", 10),
      );

      expect(stored.payload_json).not.toContain(EMAIL);
      expect(stored.payload_json).not.toContain(CARD.replace(/ /g, ""));
      expect(stored.payload_json).not.toContain(PHONE);
      expect(stored.payload_json).toContain("[EMAIL]");
      expect(serialize(readBack[0].payload)).not.toContain(EMAIL);
    } finally {
      db.close();
    }
  });

  it("friday_agent_run_events: PII does not persist clear in payload_json", () => {
    const db: FridaySqliteLayer = createTestDb();
    try {
      const idGen = createTestIdGenerator();
      const runRepo = createFridayAgentRunRepository();
      const eventRepo = createFridayAgentRunEventRepository();
      const runId = "run-pii-agent";
      db.withWriteTransaction((w) =>
        runRepo.create(w, {
          id: runId,
          task: "test task",
          sessionKey: `agent:run:${runId}`,
          maxAttempts: 3,
          nowIso: NOW,
        }),
      );
      db.withWriteTransaction((w) =>
        eventRepo.append(w, {
          eventId: idGen(),
          runId,
          seq: 1,
          eventName: "agent.run.failed",
          payload: { runId, message: `contact ${EMAIL} ssn ${SSN}` },
          emittedAt: NOW,
          createdAt: NOW,
        }),
      );

      const stored = db.withReadConnection(
        (r) =>
          r
            .prepare(
              "SELECT payload_json FROM friday_agent_run_events WHERE run_id = ?",
            )
            .get(runId) as { payload_json: string },
      );
      const readBack = db.withReadConnection((r) => eventRepo.list(r, runId));

      expect(stored.payload_json).not.toContain(EMAIL);
      expect(stored.payload_json).not.toContain(SSN);
      expect(stored.payload_json).toContain("[EMAIL]");
      expect(stored.payload_json).toContain("[SSN_US]");
      expect(serialize(readBack[0].payload)).not.toContain(EMAIL);
    } finally {
      db.close();
    }
  });
});

// ─── E2E on-wire: REAL event bus + execution-control emitter ───

describe("redactEventPayload — on-wire via real bus + emitter", () => {
  const NOW = "2026-02-25T12:00:00.000Z";

  it("PII does not egress to bus subscribers or the audit sink", () => {
    let counter = 0;
    const persisted: FridayRealtimeEventEnvelope[] = [];
    const bus = createFridayRealtimeEventBus({
      idGenerator: () => `evt-${++counter}`,
      nowIso: () => NOW,
      persistEvent: (env) => persisted.push(env),
    });
    const received: FridayRealtimeEventEnvelope[] = [];
    bus.subscribe((env) => received.push(env));

    const auditRecords: Array<Record<string, unknown>> = [];
    const emitter = createExecutionControlEventEmitter({
      eventBus: bus,
      nowIso: () => NOW,
      auditSink: (record) => auditRecords.push(record as unknown as Record<string, unknown>),
    });

    emitter.emit("execution.node.failed", {
      executionId: "exec-1",
      runId: "run-1",
      nodeId: "node-a",
      attempt: 1,
      errorCode: "CRASH",
      errorMessage: `user ${EMAIL} phone ${PHONE} card ${CARD}`,
    });

    const sinks: unknown[] = [
      ...received.map((e) => e.payload),
      ...persisted.map((e) => e.payload),
      ...auditRecords.map((r) => r.details),
    ];
    expect(sinks.length).toBeGreaterThanOrEqual(3);
    for (const payload of sinks) {
      const s = serialize(payload);
      expect(s).not.toContain(EMAIL);
      expect(s).not.toContain(PHONE);
      expect(s).not.toContain(CARD.replace(/ /g, ""));
    }
    expect(serialize(received[0].payload)).toContain("[EMAIL]");
  });
});

// ─── Field-role-aware identity preservation (re-audit findings #1 + #2) ───
//
// Drives the REAL execution-control emitter → event bus → durable event
// repository → audit sink → replay/readback — the production chain the public
// /v1/node-runner/execute seam invokes. Proves distinct PII-shaped identifiers
// stay distinct (no collapse), benign string business ids round-trip unchanged,
// and content-field PII is still redacted.

describe("redactEventPayload — field-role-aware identity (re-audit)", () => {
  const NOW = "2026-02-25T12:00:00.000Z";

  function freshBus() {
    let counter = 0;
    return createFridayRealtimeEventBus({
      idGenerator: () => `evt-${++counter}`,
      nowIso: () => NOW,
    });
  }

  it("does NOT collapse two distinct PII-shaped executionIds (finding #1: distinct streamId + audit resourceId)", () => {
    const bus = freshBus();
    const auditRecords: Array<Record<string, unknown>> = [];
    const emitter = createExecutionControlEventEmitter({
      eventBus: bus,
      nowIso: () => NOW,
      auditSink: (r) => auditRecords.push(r as unknown as Record<string, unknown>),
    });

    const a = emitter.emit("execution.node.failed", {
      executionId: "alice@example.com",
      runId: "run-a",
      nodeId: "n-1",
      attempt: 1,
      errorCode: "E",
      errorMessage: "reach carol@example.com",
    });
    const b = emitter.emit("execution.node.failed", {
      executionId: "dave@example.com",
      runId: "run-b",
      nodeId: "n-1",
      attempt: 1,
      errorCode: "E",
      errorMessage: "no pii here",
    });

    // Distinct identifiers stay distinct — no collapse to one execution:[EMAIL] stream.
    expect(a.streamId).not.toBe(b.streamId);
    expect(a.streamId).toBe("execution:alice@example.com");
    expect(b.streamId).toBe("execution:dave@example.com");

    // Audit resourceId (derived from the intact executionId) stays distinct.
    expect(auditRecords[0].resourceId).not.toBe(auditRecords[1].resourceId);
    expect(auditRecords[0].resourceId).toBe("alice@example.com");

    // CONTENT-field PII (errorMessage) is still redacted on the wire.
    const s = serialize(a.payload);
    expect(s).not.toContain("carol@example.com");
    expect(s).toContain("[EMAIL]");
  });

  it("round-trips ordinary numeric-string business identifiers unchanged through persistence + readback (finding #2)", () => {
    const db = createTestDb();
    try {
      const repo = createFridayRealtimeEventRepository();
      const payload = {
        orderId: "2345678", // phone-shaped, benign business id
        invoiceId: "4155550132", // 10-digit, phone-shaped, benign
        executionId: "123456789", // 9-digit, SSN-shaped, benign
        runId: "123-45-6789", // SSN-formatted, benign routing id
        note: "processed", // content, non-PII
      };
      const envelope: FridayRealtimeEventEnvelope = {
        eventId: "evt-roundtrip",
        streamId: "execution:123456789",
        seq: 1,
        event: "execution.node.completed",
        payload: payload as unknown as FridayRealtimeEventEnvelope["payload"],
        emittedAt: NOW,
        correlationId: undefined,
        stateVersion: undefined,
      };
      db.withWriteTransaction((w) => repo.append(w, envelope));

      const stored = db.withReadConnection(
        (r) =>
          r
            .prepare("SELECT payload_json FROM realtime_events WHERE event_id = ?")
            .get("evt-roundtrip") as { payload_json: string },
      );
      const readBack = db.withReadConnection((r) =>
        repo.listByStream(r, "execution:123456789", 10),
      );

      expect(readBack[0].payload).toEqual(payload);
      expect(stored.payload_json).toContain("2345678");
      expect(stored.payload_json).toContain("4155550132");
      expect(stored.payload_json).toContain("123456789");
      expect(stored.payload_json).toContain("123-45-6789");
      expect(stored.payload_json).not.toContain("[PHONE_US]");
      expect(stored.payload_json).not.toContain("[SSN_US]");
    } finally {
      db.close();
    }
  });

  it("at-rest: intact identifiers coexist with redacted content PII (finding #1 + leak-fix together)", () => {
    const db = createTestDb();
    try {
      const repo = createFridayRealtimeEventRepository();
      const payload = {
        executionId: "alice@example.com", // identifier → preserved (distinct)
        runId: "4155550132", // identifier → preserved
        detail: `email carol@example.com ssn ${SSN}`, // content → redacted
      };
      const envelope: FridayRealtimeEventEnvelope = {
        eventId: "evt-coexist",
        streamId: "execution:alice@example.com",
        seq: 1,
        event: "execution.node.failed",
        payload: payload as unknown as FridayRealtimeEventEnvelope["payload"],
        emittedAt: NOW,
        correlationId: undefined,
        stateVersion: undefined,
      };
      db.withWriteTransaction((w) => repo.append(w, envelope));

      const stored = db.withReadConnection(
        (r) =>
          r
            .prepare("SELECT payload_json FROM realtime_events WHERE event_id = ?")
            .get("evt-coexist") as { payload_json: string },
      );

      // Identifiers intact (distinct-preserving).
      expect(stored.payload_json).toContain("alice@example.com");
      expect(stored.payload_json).toContain("4155550132");
      // Content-field PII redacted (original leak fix intact).
      expect(stored.payload_json).not.toContain("carol@example.com");
      expect(stored.payload_json).not.toContain(SSN);
      expect(stored.payload_json).toContain("[EMAIL]");
      expect(stored.payload_json).toContain("[SSN_US]");
    } finally {
      db.close();
    }
  });

  it("stream identities are stable + distinct across durable persistence and readback (finding #1)", () => {
    const db = createTestDb();
    try {
      const eventRepo = createFridayRealtimeEventRepository();
      let counter = 0;
      const bus = createFridayRealtimeEventBus({
        idGenerator: () => `evt-${++counter}`,
        nowIso: () => NOW,
        db,
        eventRepo,
      });
      const emitter = createExecutionControlEventEmitter({ eventBus: bus, nowIso: () => NOW });

      const a = emitter.emit("execution.node.completed", {
        executionId: "alice@example.com",
        runId: "run-a",
        nodeId: "n",
        attempt: 1,
        durationMs: 5,
      });
      const b = emitter.emit("execution.node.completed", {
        executionId: "dave@example.com",
        runId: "run-b",
        nodeId: "n",
        attempt: 1,
        durationMs: 5,
      });

      expect(a.streamId).not.toBe(b.streamId);

      const aStream = db.withReadConnection((r) => eventRepo.listByStream(r, a.streamId, 10));
      const bStream = db.withReadConnection((r) => eventRepo.listByStream(r, b.streamId, 10));

      // Each distinct identity persists to its OWN durable stream (no collapse).
      expect(aStream).toHaveLength(1);
      expect(bStream).toHaveLength(1);
      // streamId is stable across persistence + readback.
      expect(aStream[0].streamId).toBe(a.streamId);
      expect(bStream[0].streamId).toBe(b.streamId);
    } finally {
      db.close();
    }
  });
});

// ─── Over-exemption leak hardening (re-audit #2) ───
//
// An identifier field is exempt from value-PII redaction. Two exemptions were too
// broad and could carry CONTENT PII that then persisted CLEAR: (FIX 1) an ARRAY
// under an id-role key, and (FIX 2) a BARE `signature` / `fingerprint` field.

describe("redactEventPayload — over-exemption leak hardening", () => {
  it("FIX1: an array under an identifier-role key is content-redacted, not exempt", () => {
    const out = redactEventPayload({ externalId: ["alice@example.com", "bob@example.com"] });
    const s = serialize(out);
    expect(s).not.toContain("alice@example.com");
    expect(s).not.toContain("bob@example.com");
    expect((out as { externalId: string[] }).externalId).toEqual(["[EMAIL]", "[EMAIL]"]);
  });

  it("FIX1: a nested PII array under an id key is redacted at every element", () => {
    const out = redactEventPayload({ runId: [PHONE, { note: `SSN ${SSN}` }] });
    const s = serialize(out);
    expect(s).not.toContain(PHONE);
    expect(s).not.toContain(SSN);
    expect(s).toContain("[PHONE_US]");
    expect(s).toContain("[SSN_US]");
  });

  it("FIX1: the SCALAR-id exemption is preserved (findings #1/#2 intact)", () => {
    // Opaque scalar id round-trips; distinct PII-shaped scalar ids stay distinct
    // (disclosed owner-scoped residual — NOT collapsed to one marker).
    expect(redactEventPayload({ externalId: "opaque-123" }).externalId).toBe("opaque-123");
    const a = redactEventPayload({ executionId: "alice@example.com" });
    const b = redactEventPayload({ executionId: "bob@example.com" });
    expect(a.executionId).toBe("alice@example.com");
    expect(b.executionId).toBe("bob@example.com");
    expect(a.executionId).not.toBe(b.executionId);
  });

  it("FIX2: a bare free-text signature field is content-redacted (not exempt)", () => {
    const out = redactEventPayload({ signature: `reach me at ${EMAIL}` });
    const s = serialize(out);
    expect(s).not.toContain(EMAIL);
    expect(s).toContain("[EMAIL]");
  });

  it("FIX2: a bare fingerprint field is content-redacted", () => {
    const out = redactEventPayload({ fingerprint: `call ${PHONE}` });
    const s = serialize(out);
    expect(s).not.toContain(PHONE);
    expect(s).toContain("[PHONE_US]");
  });

  it("FIX2: the in-domain crash-fingerprint field stays exempt (no regression to legit fingerprints)", () => {
    // errorFingerprint is a system-generated opaque hash that must NOT be corrupted
    // even if it accidentally matches a PII shape — it remains exempt.
    const out = redactEventPayload({ errorFingerprint: PHONE });
    expect((out as { errorFingerprint: string }).errorFingerprint).toBe(PHONE);
  });
});
