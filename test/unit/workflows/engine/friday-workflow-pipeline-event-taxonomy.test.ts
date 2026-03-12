/**
 * A-008 Pipeline Event Taxonomy Tests
 *
 * Validates canonical event taxonomy, type-safe emission, correlation
 * tracking, redaction, backpressure safeguards, and replay consistency.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createPipelineEventEmitter,
  redactPipelineEvent,
  type PipelineEvent,
  type PipelineEventName,
  type PipelineEventCorrelation,
  type PipelineEventEmitterDeps,
} from "../../../../src/workflows/engine/friday-workflow-pipeline-event-taxonomy.js";

// ─── Helpers ───

function makeCorrelation(overrides: Partial<PipelineEventCorrelation> = {}): PipelineEventCorrelation {
  return {
    runId: "run-1",
    workflowId: "wf-1",
    nodeId: "node-1",
    ...overrides,
  };
}

let idCounter = 0;

function makeEmitter(overrides: Partial<PipelineEventEmitterDeps> = {}) {
  const publish = vi.fn();
  const onDrop = vi.fn();
  idCounter = 0;

  const emitter = createPipelineEventEmitter({
    publish,
    generateId: () => `evt-${++idCounter}`,
    nowIso: () => "2026-01-01T00:00:00Z",
    onDrop,
    ...overrides,
  });

  return { emitter, publish, onDrop };
}

// ─── Tests ───

describe("A-008 PipelineEventTaxonomy", () => {
  describe("event emission", () => {
    it("emits rules.evaluated event with correct module", () => {
      const { emitter, publish } = makeEmitter();

      const event = emitter.emit(
        "pipeline.rules.evaluated",
        { bundleId: "b-1", ruleCount: 5, outcome: "allow", durationMs: 12 },
        makeCorrelation(),
      );

      expect(event).not.toBeNull();
      expect(event!.event).toBe("pipeline.rules.evaluated");
      expect(event!.module).toBe("rules");
      expect(event!.payload.outcome).toBe("allow");
      expect(publish).toHaveBeenCalledOnce();
    });

    it("emits node-runner events with correct module", () => {
      const { emitter } = makeEmitter();

      const e1 = emitter.emit(
        "pipeline.node.step.started",
        { stepName: "pre-validate", stepIndex: 1 },
        makeCorrelation(),
      );
      const e2 = emitter.emit(
        "pipeline.node.step.completed",
        { stepName: "pre-validate", stepIndex: 1, durationMs: 50 },
        makeCorrelation(),
      );

      expect(e1!.module).toBe("node-runner");
      expect(e2!.module).toBe("node-runner");
    });

    it("emits acceptance events with correct module", () => {
      const { emitter } = makeEmitter();

      const event = emitter.emit(
        "pipeline.acceptance.passed",
        { checksRun: 3, checksPassed: 3 },
        makeCorrelation(),
      );

      expect(event!.module).toBe("acceptance");
    });

    it("emits retry events with correct module", () => {
      const { emitter } = makeEmitter();

      const event = emitter.emit(
        "pipeline.retry.attempted",
        { category: "transient", delayMs: 200, budgetRemaining: 4 },
        makeCorrelation(),
      );

      expect(event!.module).toBe("retry");
    });

    it("emits playbook events with correct module", () => {
      const { emitter } = makeEmitter();

      const event = emitter.emit(
        "pipeline.playbook.selected",
        { playbookId: "pb-1", versionNumber: 2, matchScore: 0.87 },
        makeCorrelation(),
      );

      expect(event!.module).toBe("playbook");
    });
  });

  describe("correlation tracking", () => {
    it("includes all correlation fields in emitted event", () => {
      const { emitter } = makeEmitter();

      const event = emitter.emit(
        "pipeline.rules.evaluated",
        { bundleId: "b-1", ruleCount: 1, outcome: "allow", durationMs: 5 },
        {
          runId: "run-42",
          workflowId: "wf-7",
          nodeId: "n-3",
          attempt: 2,
          traceId: "trace-abc",
          spanId: "span-xyz",
        },
      );

      expect(event!.correlation.runId).toBe("run-42");
      expect(event!.correlation.workflowId).toBe("wf-7");
      expect(event!.correlation.nodeId).toBe("n-3");
      expect(event!.correlation.attempt).toBe(2);
      expect(event!.correlation.traceId).toBe("trace-abc");
      expect(event!.correlation.spanId).toBe("span-xyz");
    });

    it("stores events queryable by runId", () => {
      const { emitter } = makeEmitter();

      emitter.emit("pipeline.rules.evaluated",
        { bundleId: "b-1", ruleCount: 1, outcome: "allow", durationMs: 5 },
        makeCorrelation({ runId: "run-1" }),
      );
      emitter.emit("pipeline.rules.denied",
        { bundleId: "b-2", reason: "policy denied" },
        makeCorrelation({ runId: "run-2" }),
      );
      emitter.emit("pipeline.retry.attempted",
        { category: "timeout", delayMs: 100, budgetRemaining: 3 },
        makeCorrelation({ runId: "run-1" }),
      );

      expect(emitter.getEvents("run-1")).toHaveLength(2);
      expect(emitter.getEvents("run-2")).toHaveLength(1);
    });

    it("tracks emitted count per run", () => {
      const { emitter } = makeEmitter();

      emitter.emit("pipeline.rules.evaluated",
        { bundleId: "b-1", ruleCount: 1, outcome: "allow", durationMs: 5 },
        makeCorrelation({ runId: "run-1" }),
      );
      emitter.emit("pipeline.rules.evaluated",
        { bundleId: "b-2", ruleCount: 2, outcome: "warn", durationMs: 8 },
        makeCorrelation({ runId: "run-1" }),
      );

      expect(emitter.getEmittedCount("run-1")).toBe(2);
      expect(emitter.getEmittedCount("run-99")).toBe(0);
    });
  });

  describe("event envelope structure", () => {
    it("generates unique event IDs", () => {
      const { emitter } = makeEmitter();

      const e1 = emitter.emit("pipeline.rules.evaluated",
        { bundleId: "b-1", ruleCount: 1, outcome: "allow", durationMs: 5 },
        makeCorrelation(),
      );
      const e2 = emitter.emit("pipeline.rules.evaluated",
        { bundleId: "b-1", ruleCount: 1, outcome: "allow", durationMs: 5 },
        makeCorrelation(),
      );

      expect(e1!.eventId).not.toBe(e2!.eventId);
    });

    it("includes timestamp in envelope", () => {
      const { emitter } = makeEmitter();

      const event = emitter.emit("pipeline.rules.evaluated",
        { bundleId: "b-1", ruleCount: 1, outcome: "allow", durationMs: 5 },
        makeCorrelation(),
      );

      expect(event!.emittedAt).toBe("2026-01-01T00:00:00Z");
    });

    it("marks events as not redacted by default", () => {
      const { emitter } = makeEmitter();

      const event = emitter.emit("pipeline.rules.evaluated",
        { bundleId: "b-1", ruleCount: 1, outcome: "allow", durationMs: 5 },
        makeCorrelation(),
      );

      expect(event!.redacted).toBe(false);
    });
  });

  describe("redaction", () => {
    it("redacts sensitive payload fields", () => {
      const { emitter } = makeEmitter();

      const event = emitter.emit("pipeline.rules.denied",
        { bundleId: "b-1", reason: "secret policy rule XYZ", ruleId: "r-1" },
        makeCorrelation(),
      );

      const redacted = redactPipelineEvent(event!);

      expect(redacted.redacted).toBe(true);
      expect(redacted.payload.reason).toBe("[REDACTED]");
      expect(redacted.payload.bundleId).toBe("b-1"); // non-sensitive preserved
    });

    it("redacts errorMessage fields", () => {
      const { emitter } = makeEmitter();

      const event = emitter.emit("pipeline.node.step.failed",
        { stepName: "execute", stepIndex: 3, errorCode: "TIMEOUT", errorMessage: "sensitive stack trace" },
        makeCorrelation(),
      );

      const redacted = redactPipelineEvent(event!);
      expect(redacted.payload.errorMessage).toBe("[REDACTED]");
      expect(redacted.payload.errorCode).toBe("TIMEOUT"); // preserved
    });

    it("preserves non-sensitive fields", () => {
      const { emitter } = makeEmitter();

      const event = emitter.emit("pipeline.acceptance.passed",
        { checksRun: 5, checksPassed: 5 },
        makeCorrelation(),
      );

      const redacted = redactPipelineEvent(event!);
      expect(redacted.payload.checksRun).toBe(5);
      expect(redacted.payload.checksPassed).toBe(5);
    });
  });

  describe("backpressure — rate limiting", () => {
    it("drops events when rate limit exceeded", () => {
      const { emitter, onDrop } = makeEmitter({ maxEventsPerSecondPerRun: 3 });

      // Emit 3 events (under limit)
      for (let i = 0; i < 3; i++) {
        const e = emitter.emit("pipeline.rules.evaluated",
          { bundleId: "b-1", ruleCount: 1, outcome: "allow", durationMs: 1 },
          makeCorrelation({ runId: "run-1" }),
        );
        expect(e).not.toBeNull();
      }

      // 4th event should be dropped
      const dropped = emitter.emit("pipeline.rules.evaluated",
        { bundleId: "b-1", ruleCount: 1, outcome: "allow", durationMs: 1 },
        makeCorrelation({ runId: "run-1" }),
      );
      expect(dropped).toBeNull();
      expect(onDrop).toHaveBeenCalledWith(1, "run-1");
      expect(emitter.getDroppedCount("run-1")).toBe(1);
    });

    it("rate limit is per-run (different runs are independent)", () => {
      const { emitter } = makeEmitter({ maxEventsPerSecondPerRun: 2 });

      // Fill run-1 budget
      emitter.emit("pipeline.rules.evaluated",
        { bundleId: "b-1", ruleCount: 1, outcome: "allow", durationMs: 1 },
        makeCorrelation({ runId: "run-1" }),
      );
      emitter.emit("pipeline.rules.evaluated",
        { bundleId: "b-1", ruleCount: 1, outcome: "allow", durationMs: 1 },
        makeCorrelation({ runId: "run-1" }),
      );

      // run-2 should still work
      const e = emitter.emit("pipeline.rules.evaluated",
        { bundleId: "b-1", ruleCount: 1, outcome: "allow", durationMs: 1 },
        makeCorrelation({ runId: "run-2" }),
      );
      expect(e).not.toBeNull();
    });

    it("unlimited rate when maxEventsPerSecondPerRun is 0", () => {
      const { emitter } = makeEmitter({ maxEventsPerSecondPerRun: 0 });

      for (let i = 0; i < 50; i++) {
        const e = emitter.emit("pipeline.rules.evaluated",
          { bundleId: "b-1", ruleCount: 1, outcome: "allow", durationMs: 1 },
          makeCorrelation(),
        );
        expect(e).not.toBeNull();
      }
    });
  });

  describe("backpressure — buffer overflow", () => {
    it("drops events when buffer is full", () => {
      const { emitter, onDrop } = makeEmitter({
        maxBufferSize: 5,
        maxEventsPerSecondPerRun: 0, // disable rate limit to test buffer only
      });

      for (let i = 0; i < 5; i++) {
        emitter.emit("pipeline.rules.evaluated",
          { bundleId: "b-1", ruleCount: 1, outcome: "allow", durationMs: 1 },
          makeCorrelation(),
        );
      }

      // 6th event should be dropped
      const dropped = emitter.emit("pipeline.rules.evaluated",
        { bundleId: "b-1", ruleCount: 1, outcome: "allow", durationMs: 1 },
        makeCorrelation(),
      );
      expect(dropped).toBeNull();
      expect(onDrop).toHaveBeenCalled();
    });
  });

  describe("replay consistency", () => {
    it("events maintain insertion order", () => {
      const { emitter } = makeEmitter();

      emitter.emit("pipeline.node.step.started",
        { stepName: "load", stepIndex: 0 },
        makeCorrelation({ runId: "run-1" }),
      );
      emitter.emit("pipeline.node.step.completed",
        { stepName: "load", stepIndex: 0, durationMs: 10 },
        makeCorrelation({ runId: "run-1" }),
      );
      emitter.emit("pipeline.node.step.started",
        { stepName: "validate", stepIndex: 1 },
        makeCorrelation({ runId: "run-1" }),
      );

      const events = emitter.getEvents("run-1");
      expect(events).toHaveLength(3);
      expect(events[0].event).toBe("pipeline.node.step.started");
      expect(events[1].event).toBe("pipeline.node.step.completed");
      expect(events[2].event).toBe("pipeline.node.step.started");
      expect((events[2].payload as { stepName: string }).stepName).toBe("validate");
    });

    it("event IDs are monotonically increasing", () => {
      const { emitter } = makeEmitter();

      const e1 = emitter.emit("pipeline.rules.evaluated",
        { bundleId: "b-1", ruleCount: 1, outcome: "allow", durationMs: 1 },
        makeCorrelation(),
      );
      const e2 = emitter.emit("pipeline.rules.evaluated",
        { bundleId: "b-1", ruleCount: 1, outcome: "allow", durationMs: 1 },
        makeCorrelation(),
      );

      expect(e1!.eventId).toBe("evt-1");
      expect(e2!.eventId).toBe("evt-2");
    });
  });

  describe("module mapping coverage", () => {
    const ALL_EVENTS: PipelineEventName[] = [
      "pipeline.rules.evaluated",
      "pipeline.rules.denied",
      "pipeline.node.step.started",
      "pipeline.node.step.completed",
      "pipeline.node.step.failed",
      "pipeline.node.execution.completed",
      "pipeline.acceptance.started",
      "pipeline.acceptance.passed",
      "pipeline.acceptance.warned",
      "pipeline.acceptance.failed",
      "pipeline.retry.attempted",
      "pipeline.retry.exhausted",
      "pipeline.retry.circuit.opened",
      "pipeline.retry.budget.exhausted",
      "pipeline.playbook.selected",
      "pipeline.playbook.no_match",
      "pipeline.playbook.promoted",
      "pipeline.playbook.rolled_back",
      "pipeline.playbook.feedback.recorded",
    ];

    it("all 19 event types are defined", () => {
      expect(ALL_EVENTS).toHaveLength(19);
    });

    it("taxonomy covers all 5 modules", () => {
      const { emitter } = makeEmitter();
      const modules = new Set<string>();

      // Emit one event from each module with dummy payloads
      const emitted = [
        emitter.emit("pipeline.rules.evaluated", { bundleId: "b", ruleCount: 1, outcome: "allow", durationMs: 1 }, makeCorrelation()),
        emitter.emit("pipeline.node.step.started", { stepName: "s", stepIndex: 0 }, makeCorrelation()),
        emitter.emit("pipeline.acceptance.started", { artifactType: "t", checkCount: 1 }, makeCorrelation()),
        emitter.emit("pipeline.retry.attempted", { category: "c", delayMs: 1, budgetRemaining: 1 }, makeCorrelation()),
        emitter.emit("pipeline.playbook.selected", { playbookId: "p", versionNumber: 1, matchScore: 0.9 }, makeCorrelation()),
      ];

      for (const e of emitted) {
        if (e) modules.add(e.module);
      }

      expect(modules.size).toBe(5);
      expect(modules).toContain("rules");
      expect(modules).toContain("node-runner");
      expect(modules).toContain("acceptance");
      expect(modules).toContain("retry");
      expect(modules).toContain("playbook");
    });
  });

  describe("reset", () => {
    it("clears all state", () => {
      const { emitter } = makeEmitter();

      emitter.emit("pipeline.rules.evaluated",
        { bundleId: "b-1", ruleCount: 1, outcome: "allow", durationMs: 1 },
        makeCorrelation({ runId: "run-1" }),
      );

      emitter.reset();

      expect(emitter.getEvents("run-1")).toHaveLength(0);
      expect(emitter.getEmittedCount("run-1")).toBe(0);
      expect(emitter.getDroppedCount("run-1")).toBe(0);
    });
  });
});
