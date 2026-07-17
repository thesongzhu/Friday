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
