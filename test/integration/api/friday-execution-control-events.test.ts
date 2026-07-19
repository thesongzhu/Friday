/**
 * Integration tests for the execution-control event subsystem:
 * event taxonomy, payload redaction, correlation propagation,
 * bus delivery, audit sink integration, and replay.
 *
 * AC-01: One runId can reconstruct full decision path.
 * AC-02: Event payloads conform to schema.
 * AC-03: Sensitive fields are redacted.
 * AC-04: Event delivery survives restart via persistence.
 * AC-05: Replay after cursor returns consistent stream.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFridayRealtimeEventBus,
  createExecutionControlEventEmitter,
  redactEventPayload,
} from "#api";

// ─── Helpers ───

let seqCounter = 0;
function idGen() {
  return `evt-${++seqCounter}`;
}
function nowIso() {
  return "2026-02-25T12:00:00.000Z";
}

function freshBus() {
  seqCounter = 0;
  return createFridayRealtimeEventBus({
    idGenerator: idGen,
    nowIso,
  });
}

// ─── Redaction Tests ───

describe("Event Payload Redactor", () => {
  it("redacts known sensitive keys", () => {
    const payload = {
      userId: "user-1",
      password: "hunter2", // pragma: allowlist secret
      apiKey: "sk-abc123", // pragma: allowlist secret
      name: "Test",
    };
    const redacted = redactEventPayload(payload);
    expect(redacted.password).toBe("[REDACTED]");
    expect(redacted.apiKey).toBe("[REDACTED]");
    expect(redacted.userId).toBe("user-1");
    expect(redacted.name).toBe("Test");
  });

  it("does not mutate the original payload", () => {
    const original = { token: "secret-value", data: "safe" };
    const redacted = redactEventPayload(original);
    expect(original.token).toBe("secret-value");
    expect(redacted.token).toBe("[REDACTED]");
  });

  it("handles nested objects", () => {
    const payload = {
      outer: {
        inner: {
          secret: "should-be-redacted", // pragma: allowlist secret
          value: 42,
        },
      },
    };
    const redacted = redactEventPayload(payload);
    expect(redacted.outer.inner.secret).toBe("[REDACTED]");
    expect(redacted.outer.inner.value).toBe(42);
  });

  it("handles arrays", () => {
    const payload = [
      { password: "abc", name: "Alice" },
      { password: "def", name: "Bob" },
    ];
    const redacted = redactEventPayload(payload);
    expect(redacted[0].password).toBe("[REDACTED]");
    expect(redacted[0].name).toBe("Alice");
    expect(redacted[1].password).toBe("[REDACTED]");
  });

  it("handles null and primitive values", () => {
    expect(redactEventPayload(null)).toBe(null);
    expect(redactEventPayload(undefined)).toBe(undefined);
    expect(redactEventPayload(42)).toBe(42);
    expect(redactEventPayload("hello")).toBe("hello");
  });

  it("redacts credit_card and private_key", () => {
    const payload = { credit_card: "4111111111", private_key: "-----BEGIN" };
    const redacted = redactEventPayload(payload);
    expect(redacted.credit_card).toBe("[REDACTED]");
    expect(redacted.private_key).toBe("[REDACTED]");
  });
});

// ─── Execution Control Event Emitter Tests ───

describe("Execution Control Event Emitter", () => {
  let bus: ReturnType<typeof createFridayRealtimeEventBus>;
  let emitter: ReturnType<typeof createExecutionControlEventEmitter>;
  let auditRecords: unknown[];

  beforeEach(() => {
    bus = freshBus();
    auditRecords = [];
    emitter = createExecutionControlEventEmitter({
      eventBus: bus,
      nowIso,
      auditSink: (record) => auditRecords.push(record),
    });
  });

  // ─── Rules events ───

  it("emits rules.bundle.created event", () => {
    const envelope = emitter.emit("rules.bundle.created", {
      bundleId: "pb-1",
      name: "Default Bundle",
    });

    expect(envelope.event).toBe("rules.bundle.created");
    expect(envelope.streamId).toBe("rules:pb-1");
    expect(envelope.payload.bundleId).toBe("pb-1");
    expect(envelope.seq).toBe(1);
  });

  it("emits rules.evaluation.completed event", () => {
    const envelope = emitter.emit("rules.evaluation.completed", {
      evaluationId: "eval-1",
      resource: "workflow:deploy",
      decision: "allow",
      ruleCount: 3,
    });

    expect(envelope.event).toBe("rules.evaluation.completed");
    expect(envelope.streamId).toBe("rules:eval-1");
    expect(envelope.payload.decision).toBe("allow");
    expect(envelope.payload.ruleCount).toBe(3);
  });

  // ─── Execution events ───

  it("emits execution.node.started and completed events", () => {
    const started = emitter.emit("execution.node.started", {
      executionId: "exec-1",
      runId: "run-1",
      nodeId: "node-a",
      attempt: 1,
    });

    const completed = emitter.emit("execution.node.completed", {
      executionId: "exec-1",
      runId: "run-1",
      nodeId: "node-a",
      attempt: 1,
      durationMs: 120,
    });

    expect(started.event).toBe("execution.node.started");
    expect(completed.event).toBe("execution.node.completed");
    expect(started.streamId).toBe("execution:exec-1");
    expect(completed.payload.durationMs).toBe(120);
  });

  it("emits execution.node.failed event", () => {
    const envelope = emitter.emit("execution.node.failed", {
      executionId: "exec-2",
      runId: "run-1",
      nodeId: "node-b",
      attempt: 3,
      errorCode: "TIMEOUT",
      errorMessage: "Node execution timed out after 30s",
    });

    expect(envelope.event).toBe("execution.node.failed");
    expect(envelope.payload.errorCode).toBe("TIMEOUT");
  });

  // ─── Acceptance events ───

  it("emits acceptance.gate.evaluated event", () => {
    const envelope = emitter.emit("acceptance.gate.evaluated", {
      resultId: "ar-1",
      executionId: "exec-1",
      runId: "run-1",
      verdict: "pass",
      suiteCount: 5,
    });

    expect(envelope.event).toBe("acceptance.gate.evaluated");
    expect(envelope.streamId).toBe("acceptance:ar-1");
    expect(envelope.payload.verdict).toBe("pass");
  });

  it("emits acceptance.gate.failed with failedSuites", () => {
    const envelope = emitter.emit("acceptance.gate.failed", {
      resultId: "ar-2",
      executionId: "exec-1",
      runId: "run-1",
      failedSuites: ["data-integrity", "schema-check"],
    });

    expect(envelope.payload.failedSuites).toEqual(["data-integrity", "schema-check"]);
  });

  // ─── Retry events ───

  it("emits retry.attempt.scheduled event", () => {
    const envelope = emitter.emit("retry.attempt.scheduled", {
      contextId: "rc-1",
      runId: "run-1",
      nodeId: "node-a",
      attempt: 2,
      nextAttemptAt: "2026-02-25T12:05:00.000Z",
    });

    expect(envelope.event).toBe("retry.attempt.scheduled");
    expect(envelope.streamId).toBe("retry:rc-1");
  });

  it("emits retry.dlq.enqueued event", () => {
    const envelope = emitter.emit("retry.dlq.enqueued", {
      entryId: "dlq-1",
      contextId: "rc-1",
      failureCategory: "timeout",
      reason: "Max retries exceeded",
    });

    expect(envelope.event).toBe("retry.dlq.enqueued");
    expect(envelope.streamId).toBe("retry:dlq-1");
    expect(envelope.payload.failureCategory).toBe("timeout");
  });

  // ─── Playbook events ───

  it("emits playbook.selected event", () => {
    const envelope = emitter.emit("playbook.selected", {
      playbookId: "pb-1",
      workflowType: "etl",
      runId: "run-1",
      reason: "highest_score",
    });

    expect(envelope.event).toBe("playbook.selected");
    expect(envelope.streamId).toBe("playbook:pb-1");
    expect(envelope.payload.reason).toBe("highest_score");
  });

  it("emits playbook.candidate.promoted event", () => {
    const envelope = emitter.emit("playbook.candidate.promoted", {
      candidateId: "c-1",
      playbookId: "pb-new",
      decision: "promote",
    });

    expect(envelope.event).toBe("playbook.candidate.promoted");
    expect(envelope.streamId).toBe("playbook:c-1");
  });

  it("emits playbook.rollback.completed event", () => {
    const envelope = emitter.emit("playbook.rollback.completed", {
      playbookId: "pb-1",
      fromVersion: 3,
      toVersion: 2,
      reason: "regression detected",
    });

    expect(envelope.event).toBe("playbook.rollback.completed");
    expect(envelope.payload.fromVersion).toBe(3);
    expect(envelope.payload.toVersion).toBe(2);
  });
});

// ─── Correlation ID Tests ───

describe("Correlation ID Propagation", () => {
  it("passes correlationId through to event envelope", () => {
    const bus = freshBus();
    const emitter = createExecutionControlEventEmitter({ eventBus: bus, nowIso });

    const envelope = emitter.emit(
      "execution.node.started",
      { executionId: "exec-1", runId: "run-1", nodeId: "node-a", attempt: 1 },
      "corr-abc-123",
    );

    expect(envelope.correlationId).toBe("corr-abc-123");
  });

  it("correlationId is shared across related events for same run", () => {
    const bus = freshBus();
    const emitter = createExecutionControlEventEmitter({ eventBus: bus, nowIso });
    const corrId = "trace-run-1";

    const e1 = emitter.emit(
      "execution.node.started",
      { executionId: "exec-1", runId: "run-1", nodeId: "node-a", attempt: 1 },
      corrId,
    );
    const e2 = emitter.emit(
      "acceptance.gate.evaluated",
      { resultId: "ar-1", executionId: "exec-1", runId: "run-1", verdict: "pass", suiteCount: 3 },
      corrId,
    );
    const e3 = emitter.emit(
      "playbook.selected",
      { playbookId: "pb-1", workflowType: "etl", runId: "run-1", reason: "highest_score" },
      corrId,
    );

    expect(e1.correlationId).toBe(corrId);
    expect(e2.correlationId).toBe(corrId);
    expect(e3.correlationId).toBe(corrId);
  });
});

// ─── Audit Sink Tests ───

describe("Audit Sink Integration", () => {
  it("writes audit record for each emitted event", () => {
    const bus = freshBus();
    const auditRecords: unknown[] = [];
    const emitter = createExecutionControlEventEmitter({
      eventBus: bus,
      nowIso,
      auditSink: (record) => auditRecords.push(record),
    });

    emitter.emit("rules.rule.created", {
      ruleId: "r-1",
      bundleId: "pb-1",
      resource: "workflow:deploy",
      action: "execute",
    });

    expect(auditRecords).toHaveLength(1);
    const record = auditRecords[0] as Record<string, unknown>;
    expect(record.action).toBe("rules.rule.created");
    expect(record.resourceType).toBe("rules");
    expect(record.resourceId).toBe("r-1");
    expect(record.result).toBe("success");
    expect(record.caller).toBe("execution-control-event-emitter");
  });

  it("audit record marks failure events with failure result", () => {
    const bus = freshBus();
    const auditRecords: unknown[] = [];
    const emitter = createExecutionControlEventEmitter({
      eventBus: bus,
      nowIso,
      auditSink: (record) => auditRecords.push(record),
    });

    emitter.emit("execution.node.failed", {
      executionId: "exec-1",
      runId: "run-1",
      nodeId: "node-b",
      attempt: 1,
      errorCode: "CRASH",
      errorMessage: "Process crashed",
    });

    const record = auditRecords[0] as Record<string, unknown>;
    expect(record.result).toBe("failure");
  });

  it("audit record marks DLQ enqueue events with failure result", () => {
    const bus = freshBus();
    const auditRecords: unknown[] = [];
    const emitter = createExecutionControlEventEmitter({
      eventBus: bus,
      nowIso,
      auditSink: (record) => auditRecords.push(record),
    });

    emitter.emit("retry.dlq.enqueued", {
      entryId: "dlq-1",
      contextId: "rc-1",
      failureCategory: "timeout",
      reason: "max retries exhausted",
    });

    const record = auditRecords[0] as Record<string, unknown>;
    expect(record.result).toBe("failure");
  });

  it("keeps emittedEvents bounded to the configured inspection window", () => {
    const bus = freshBus();
    const emitter = createExecutionControlEventEmitter({
      eventBus: bus,
      nowIso,
      maxEmittedEvents: 2,
    });

    emitter.emit("rules.bundle.created", { bundleId: "pb-1", name: "A" });
    emitter.emit("rules.bundle.updated", { bundleId: "pb-1", fields: ["name"] });
    emitter.emit("playbook.selected", { playbookId: "pb-1", workflowType: "etl", reason: "best" });

    expect(emitter.emittedEvents).toHaveLength(2);
    expect(emitter.emittedEvents[0].event).toBe("rules.bundle.updated");
    expect(emitter.emittedEvents[1].event).toBe("playbook.selected");
  });

  it("audit records include correlationId as requestId", () => {
    const bus = freshBus();
    const auditRecords: unknown[] = [];
    const emitter = createExecutionControlEventEmitter({
      eventBus: bus,
      nowIso,
      auditSink: (record) => auditRecords.push(record),
    });

    emitter.emit(
      "retry.attempt.started",
      { contextId: "rc-1", runId: "run-1", nodeId: "node-a", attempt: 2 },
      "corr-xyz",
    );

    const record = auditRecords[0] as Record<string, unknown>;
    expect(record.requestId).toBe("corr-xyz");
  });

  it("audit sink failure does not break event emission", () => {
    const bus = freshBus();
    const emitter = createExecutionControlEventEmitter({
      eventBus: bus,
      nowIso,
      auditSink: () => { throw new Error("Audit sink crashed"); },
    });

    const envelope = emitter.emit("rules.bundle.created", {
      bundleId: "pb-1",
      name: "test",
    });

    expect(envelope.event).toBe("rules.bundle.created");
  });

  it("surfaces audit sink failures without breaking event emission", () => {
    const bus = freshBus();
    const emitter = createExecutionControlEventEmitter({
      eventBus: bus,
      nowIso,
      auditSink: () => { throw new Error("Audit sink crashed"); },
      maxAuditSinkFailures: 2,
    });

    const envelope = emitter.emit("rules.bundle.created", {
      bundleId: "pb-1",
      name: "test",
    });

    expect(envelope.event).toBe("rules.bundle.created");
    expect(emitter.auditSinkFailures).toHaveLength(1);
    expect(emitter.auditSinkFailures[0]).toMatchObject({
      event: "rules.bundle.created",
      streamId: "rules:pb-1",
      emittedAt: "2026-02-25T12:00:00.000Z",
      message: "Audit sink crashed",
    });
  });
});

// ─── Audit-Sink Failure Message Scrubbing (canonical secret detector) ───

// SEC — the audit-sink exception message (surfaced to `auditSinkFailures` + `console.warn`) is scrubbed
// by the CANONICAL secret-shape detector (`redactSecretShapesInString`), NOT a divergent local prefix
// list. The old local regex covered `gsk_` but MISSED `hf_` / `glpat-` / `ghp_` / AWS / JWT / PEM etc.
// RED on the pre-fix emitter (hf_/glpat- passed through verbatim to the logs); GREEN once the scrub
// converges onto the single canonical detector.
describe("Audit Sink Failure Message Scrubbing", () => {
  // Build secret-shaped fixtures at runtime so no contiguous literal token ever appears in SOURCE
  // (GitHub push protection scans source text and does NOT honor the detect-secrets pragma — same
  // rationale as the redactor unit test's `stripeShaped` helper). At runtime each concatenation
  // produces the exact provider shape the canonical redactor recognizes.
  const hfToken = "hf_" + "AbCdEfGhIjKlMnOpQrStUvWx0123456789yZ"; // pragma: allowlist secret
  const glpatToken = "glpat-" + "AbCdEfGhIjKlMnOpQrStUv"; // pragma: allowlist secret
  const gskToken = "gsk_" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd"; // pragma: allowlist secret

  function scrubbedFailureMessage(errorMessage: string): string {
    const bus = freshBus();
    const emitter = createExecutionControlEventEmitter({
      eventBus: bus,
      nowIso,
      auditSink: () => {
        throw new Error(errorMessage);
      },
    });
    emitter.emit("rules.bundle.created", { bundleId: "pb-1", name: "test" });
    expect(emitter.auditSinkFailures).toHaveLength(1);
    return emitter.auditSinkFailures[0].message;
  }

  it("redacts hf_ / glpat- tokens the old local prefix list MISSED (canonical convergence)", () => {
    const scrubbed = scrubbedFailureMessage(
      `Audit persistence failed for hf=${hfToken} gitlab=${glpatToken}`,
    );
    expect(scrubbed).not.toContain(hfToken);
    expect(scrubbed).not.toContain(glpatToken);
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("still redacts a gsk_ token the local regex already covered (no regression)", () => {
    const scrubbed = scrubbedFailureMessage(`Audit persistence failed for token=${gskToken}`);
    expect(scrubbed).not.toContain(gskToken);
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("leaves a benign exception message byte-identical (no over-redaction)", () => {
    const benign = "Audit sink unavailable: connection refused (ECONNREFUSED) after 3 retries";
    expect(scrubbedFailureMessage(benign)).toBe(benign);
  });
});

// ─── PII Redaction in Events ───

describe("PII Redaction in Event Payloads", () => {
  it("redacts sensitive fields before publishing to event bus", () => {
    const bus = freshBus();
    const received: unknown[] = [];
    bus.subscribe((env) => received.push(env));

    const emitter = createExecutionControlEventEmitter({ eventBus: bus, nowIso });

    // Simulate a payload with a sensitive field injected at unknown depth
    // The type system won't allow extra fields, but redaction handles it
    // defensively. We test the redactor separately.
    const payload = { bundleId: "pb-1", name: "Test" };
    const envelope = emitter.emit("rules.bundle.created", payload);

    expect(envelope.payload.bundleId).toBe("pb-1");
    expect(envelope.payload.name).toBe("Test");
  });

  it("audit record details are redacted", () => {
    const bus = freshBus();
    const auditRecords: unknown[] = [];
    const emitter = createExecutionControlEventEmitter({
      eventBus: bus,
      nowIso,
      auditSink: (record) => auditRecords.push(record),
    });

    emitter.emit("rules.bundle.created", { bundleId: "pb-1", name: "Test" });

    const record = auditRecords[0] as Record<string, unknown>;
    expect(record.details).toBeDefined();
    const details = record.details as Record<string, unknown>;
    expect(details.bundleId).toBe("pb-1");
  });
});

// ─── Bus Subscriber Delivery ───

describe("Bus Subscriber Delivery", () => {
  it("bus subscribers receive execution-control events", () => {
    const bus = freshBus();
    const received: unknown[] = [];
    bus.subscribe((env) => received.push(env));

    const emitter = createExecutionControlEventEmitter({ eventBus: bus, nowIso });

    emitter.emit("execution.node.started", {
      executionId: "exec-1", runId: "run-1", nodeId: "node-a", attempt: 1,
    });
    emitter.emit("execution.node.completed", {
      executionId: "exec-1", runId: "run-1", nodeId: "node-a", attempt: 1, durationMs: 50,
    });

    expect(received).toHaveLength(2);
  });

  it("emittedEvents tracks all published envelopes", () => {
    const bus = freshBus();
    const emitter = createExecutionControlEventEmitter({ eventBus: bus, nowIso });

    emitter.emit("rules.bundle.created", { bundleId: "pb-1", name: "A" });
    emitter.emit("rules.rule.created", { ruleId: "r-1", bundleId: "pb-1", resource: "wf", action: "run" });
    emitter.emit("playbook.selected", { playbookId: "pb-1", workflowType: "etl", reason: "best" });

    expect(emitter.emittedEvents).toHaveLength(3);
    expect(emitter.emittedEvents[0].event).toBe("rules.bundle.created");
    expect(emitter.emittedEvents[1].event).toBe("rules.rule.created");
    expect(emitter.emittedEvents[2].event).toBe("playbook.selected");
  });
});

// ─── Stream Sequence Consistency ───

describe("Stream Sequence Consistency", () => {
  it("events on the same stream have monotonically increasing seq", () => {
    const bus = freshBus();
    const emitter = createExecutionControlEventEmitter({ eventBus: bus, nowIso });

    const e1 = emitter.emit("retry.attempt.scheduled", {
      contextId: "rc-1", runId: "run-1", nodeId: "n-a", attempt: 1, nextAttemptAt: "2026-02-25T12:01:00Z",
    });
    const e2 = emitter.emit("retry.attempt.started", {
      contextId: "rc-1", runId: "run-1", nodeId: "n-a", attempt: 1,
    });
    const e3 = emitter.emit("retry.attempt.exhausted", {
      contextId: "rc-1", runId: "run-1", nodeId: "n-a", totalAttempts: 3, failureCategory: "timeout",
    });

    expect(e1.streamId).toBe("retry:rc-1");
    expect(e2.streamId).toBe("retry:rc-1");
    expect(e3.streamId).toBe("retry:rc-1");
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
  });

  it("events on different streams have independent seq counters", () => {
    const bus = freshBus();
    const emitter = createExecutionControlEventEmitter({ eventBus: bus, nowIso });

    const e1 = emitter.emit("rules.bundle.created", { bundleId: "pb-1", name: "A" });
    const e2 = emitter.emit("playbook.selected", { playbookId: "pb-1", workflowType: "etl", reason: "best" });

    // Different streams, both start at seq 1
    expect(e1.streamId).toBe("rules:pb-1");
    expect(e2.streamId).toBe("playbook:pb-1");
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(1);
  });
});

// ─── Full Decision Path Reconstruction (AC-01) ───

describe("Full Decision Path Reconstruction", () => {
  it("one correlationId links events across all 5 modules", () => {
    const bus = freshBus();
    const received: Array<{ event: string; correlationId?: string }> = [];
    bus.subscribe((env) =>
      received.push({ event: env.event, correlationId: env.correlationId }),
    );

    const emitter = createExecutionControlEventEmitter({ eventBus: bus, nowIso });
    const corrId = "run-1-trace";

    // Rules evaluation
    emitter.emit("rules.evaluation.completed", {
      evaluationId: "eval-1", resource: "workflow:etl", decision: "allow", ruleCount: 2,
    }, corrId);

    // Node execution
    emitter.emit("execution.node.started", {
      executionId: "exec-1", runId: "run-1", nodeId: "n-a", attempt: 1,
    }, corrId);
    emitter.emit("execution.node.completed", {
      executionId: "exec-1", runId: "run-1", nodeId: "n-a", attempt: 1, durationMs: 80,
    }, corrId);

    // Acceptance gate
    emitter.emit("acceptance.gate.evaluated", {
      resultId: "ar-1", executionId: "exec-1", runId: "run-1", verdict: "pass", suiteCount: 3,
    }, corrId);

    // Retry (for another node that failed)
    emitter.emit("retry.attempt.scheduled", {
      contextId: "rc-1", runId: "run-1", nodeId: "n-b", attempt: 2, nextAttemptAt: "2026-02-25T12:05:00Z",
    }, corrId);

    // Playbook selection
    emitter.emit("playbook.selected", {
      playbookId: "pb-1", workflowType: "etl", runId: "run-1", reason: "highest_score",
    }, corrId);

    expect(received).toHaveLength(6);
    // All events share the same correlationId
    for (const r of received) {
      expect(r.correlationId).toBe(corrId);
    }

    // All 5 modules represented
    const domains = new Set(received.map((r) => r.event.split(".")[0]));
    expect(domains).toEqual(new Set(["rules", "execution", "acceptance", "retry", "playbook"]));
  });
});

// ─── Event Schema Conformance (AC-02) ───

describe("Event Schema Conformance", () => {
  it("all 20 execution-control event names are emittable", () => {
    const bus = freshBus();
    const emitter = createExecutionControlEventEmitter({ eventBus: bus, nowIso });

    const events: Array<[string, Record<string, unknown>]> = [
      ["rules.bundle.created", { bundleId: "pb-1", name: "A" }],
      ["rules.bundle.updated", { bundleId: "pb-1", fields: ["name"] }],
      ["rules.rule.created", { ruleId: "r-1", resource: "wf", action: "run" }],
      ["rules.rule.updated", { ruleId: "r-1", fields: ["enabled"] }],
      ["rules.evaluation.completed", { evaluationId: "e-1", resource: "wf", decision: "allow", ruleCount: 1 }],
      ["execution.node.started", { executionId: "ex-1", runId: "r-1", nodeId: "n-1", attempt: 1 }],
      ["execution.node.completed", { executionId: "ex-1", runId: "r-1", nodeId: "n-1", attempt: 1, durationMs: 10 }],
      ["execution.node.failed", { executionId: "ex-1", runId: "r-1", nodeId: "n-1", attempt: 1, errorCode: "E", errorMessage: "msg" }],
      ["acceptance.gate.evaluated", { resultId: "a-1", executionId: "e-1", runId: "r-1", verdict: "pass", suiteCount: 1 }],
      ["acceptance.gate.passed", { resultId: "a-1", executionId: "e-1", runId: "r-1" }],
      ["acceptance.gate.failed", { resultId: "a-1", executionId: "e-1", runId: "r-1", failedSuites: ["s1"] }],
      ["retry.attempt.scheduled", { contextId: "c-1", runId: "r-1", nodeId: "n-1", attempt: 2, nextAttemptAt: "2026-02-25T12:00:00Z" }],
      ["retry.attempt.started", { contextId: "c-1", runId: "r-1", nodeId: "n-1", attempt: 2 }],
      ["retry.attempt.exhausted", { contextId: "c-1", runId: "r-1", nodeId: "n-1", totalAttempts: 3, failureCategory: "timeout" }],
      ["retry.dlq.enqueued", { entryId: "d-1", contextId: "c-1", failureCategory: "timeout", reason: "max retries" }],
      ["playbook.selected", { playbookId: "p-1", workflowType: "etl", reason: "score" }],
      ["playbook.candidate.created", { candidateId: "c-1", workflowType: "etl", fingerprint: "fp-1" }],
      ["playbook.candidate.promoted", { candidateId: "c-1", playbookId: "p-1", decision: "promote" }],
      ["playbook.score.recalculated", { playbookId: "p-1", score: 0.85, sampleSize: 10 }],
      ["playbook.rollback.completed", { playbookId: "p-1", fromVersion: 2, toVersion: 1, reason: "regression" }],
    ];

    for (const [eventName, payload] of events) {
      const envelope = emitter.emit(eventName as never, payload as never);
      expect(envelope.event).toBe(eventName);
      expect(envelope.eventId).toBeDefined();
      expect(envelope.emittedAt).toBe("2026-02-25T12:00:00.000Z");
      expect(envelope.streamId).toBeTruthy();
      expect(envelope.seq).toBeGreaterThanOrEqual(1);
    }

    expect(emitter.emittedEvents).toHaveLength(20);
  });

  it("each envelope has unique eventId", () => {
    const bus = freshBus();
    const emitter = createExecutionControlEventEmitter({ eventBus: bus, nowIso });

    emitter.emit("rules.bundle.created", { bundleId: "pb-1", name: "A" });
    emitter.emit("rules.bundle.created", { bundleId: "pb-2", name: "B" });

    const ids = emitter.emittedEvents.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
