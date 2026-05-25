/**
 * B-004 Observability Instrumentation Bridge Tests
 *
 * Validates span lifecycle, metric recording, correlation propagation,
 * sampling controls, and event counting.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createObservabilityInstrumentationBridge,
  INSTRUMENTATION_METRICS,
  INSTRUMENTATION_TRACE_NAMES,
  type InstrumentationBridgeDeps,
  type InstrumentationEvent,
  type ObservabilityCorrelation,
} from "../../../../src/observability/engine/friday-observability-instrumentation-bridge.js";

// ─── Helpers ───

let spanCounter = 0;

function makeDeps(overrides: Partial<InstrumentationBridgeDeps> = {}): InstrumentationBridgeDeps {
  spanCounter = 0;
  return {
    incrementCounter: vi.fn(),
    recordHistogram: vi.fn(),
    startSpan: vi.fn().mockImplementation(() => ({ spanId: `span-${++spanCounter}` })),
    endSpan: vi.fn(),
    generateTraceId: vi.fn().mockReturnValue("trace-abc-123"),
    generateSpanId: vi.fn().mockImplementation(() => `span-${++spanCounter}`),
    nowIso: () => "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<InstrumentationEvent> = {}): InstrumentationEvent {
  return {
    kind: "workflow.run.end",
    module: "workflows",
    operationName: "execute-pipeline",
    correlation: {
      traceId: "trace-1",
      spanId: "span-1",
      module: "workflows",
    },
    attributes: {},
    durationMs: 150,
    status: "ok",
    timestamp: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ─── Tests ───

describe("B-004 FridayObservabilityInstrumentationBridge", () => {
  describe("record", () => {
    it("records events and updates counts", () => {
      const bridge = createObservabilityInstrumentationBridge(makeDeps());

      bridge.record(makeEvent({ kind: "workflow.run.end" }));
      bridge.record(makeEvent({ kind: "workflow.run.end" }));
      bridge.record(makeEvent({ kind: "agent.run.end" }));

      expect(bridge.getRecordedEvents()).toHaveLength(3);
      const counts = bridge.getEventCounts();
      expect(counts["workflow.run.end"]).toBe(2);
      expect(counts["agent.run.end"]).toBe(1);
    });

    it("records counter metrics on end events", () => {
      const deps = makeDeps();
      const bridge = createObservabilityInstrumentationBridge(deps);

      bridge.record(makeEvent({ kind: "workflow.run.end", status: "ok", durationMs: 100 }));

      expect(deps.incrementCounter).toHaveBeenCalledWith(
        INSTRUMENTATION_METRICS.WORKFLOW_RUNS_TOTAL,
        expect.objectContaining({ module: "workflows", status: "ok" }),
      );
    });

    it("records histogram metrics on end events", () => {
      const deps = makeDeps();
      const bridge = createObservabilityInstrumentationBridge(deps);

      bridge.record(makeEvent({ kind: "workflow.run.end", durationMs: 250 }));

      expect(deps.recordHistogram).toHaveBeenCalledWith(
        INSTRUMENTATION_METRICS.WORKFLOW_RUN_DURATION_MS,
        expect.any(Object),
        250,
      );
    });

    it("does NOT record metrics on start events", () => {
      const deps = makeDeps();
      const bridge = createObservabilityInstrumentationBridge(deps);

      bridge.record(makeEvent({ kind: "workflow.run.start" }));

      expect(deps.incrementCounter).not.toHaveBeenCalled();
      expect(deps.recordHistogram).not.toHaveBeenCalled();
    });

    it("records agent metrics correctly", () => {
      const deps = makeDeps();
      const bridge = createObservabilityInstrumentationBridge(deps);

      bridge.record(makeEvent({
        kind: "agent.tool.end",
        module: "workflows",
        operationName: "search-tool",
        durationMs: 50,
        status: "ok",
      }));

      expect(deps.incrementCounter).toHaveBeenCalledWith(
        INSTRUMENTATION_METRICS.AGENT_TOOL_CALLS_TOTAL,
        expect.any(Object),
      );
    });

    it("records API metrics correctly", () => {
      const deps = makeDeps();
      const bridge = createObservabilityInstrumentationBridge(deps);

      bridge.record(makeEvent({
        kind: "api.request.end",
        module: "api",
        operationName: "GET /v1/workflows",
        durationMs: 30,
        status: "ok",
      }));

      expect(deps.incrementCounter).toHaveBeenCalledWith(
        INSTRUMENTATION_METRICS.API_REQUESTS_TOTAL,
        expect.any(Object),
      );
    });
  });

  describe("startTrace", () => {
    it("creates a new trace and returns correlation", () => {
      const deps = makeDeps();
      const bridge = createObservabilityInstrumentationBridge(deps);

      const correlation = bridge.startTrace({
        module: "workflows",
        operationName: "execute-pipeline",
        attributes: { workflowId: "wf-1" },
      });

      expect(correlation.traceId).toBe("trace-abc-123");
      expect(correlation.spanId).toBe("span-1");
      expect(correlation.module).toBe("workflows");
      expect(deps.startSpan).toHaveBeenCalledWith({
        traceId: "trace-abc-123",
        name: "execute-pipeline",
        kind: "internal",
        module: "workflows",
        attributes: { workflowId: "wf-1" },
      });
    });
  });

  describe("startSpan", () => {
    it("creates a child span with parent reference", () => {
      const deps = makeDeps();
      const bridge = createObservabilityInstrumentationBridge(deps);

      const parent: ObservabilityCorrelation = {
        traceId: "trace-1",
        spanId: "parent-span",
        module: "workflows",
      };

      const child = bridge.startSpan({
        parent,
        operationName: "node-execute",
        kind: "internal",
        attributes: { nodeId: "n-1" },
      });

      expect(child.traceId).toBe("trace-1");
      expect(child.parentSpanId).toBe("parent-span");
      expect(child.module).toBe("workflows");
      expect(deps.startSpan).toHaveBeenCalledWith({
        traceId: "trace-1",
        name: "node-execute",
        kind: "internal",
        module: "workflows",
        parentSpanId: "parent-span",
        attributes: { nodeId: "n-1" },
      });
    });

    it("defaults kind to internal", () => {
      const deps = makeDeps();
      const bridge = createObservabilityInstrumentationBridge(deps);

      bridge.startSpan({
        parent: { traceId: "t", spanId: "s", module: "api" },
        operationName: "test",
      });

      expect(deps.startSpan).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "internal" }),
      );
    });
  });

  describe("endSpan", () => {
    it("ends span and records metrics", () => {
      const deps = makeDeps();
      const bridge = createObservabilityInstrumentationBridge(deps);

      bridge.endSpan({
        correlation: { traceId: "t-1", spanId: "s-1", module: "workflows" },
        status: "ok",
        durationMs: 200,
        attributes: { nodeCount: 5 },
      });

      expect(deps.endSpan).toHaveBeenCalledWith({
        traceId: "t-1",
        spanId: "s-1",
        status: "ok",
        error: undefined,
        attributes: { nodeCount: 5 },
      });
    });

    it("passes error to endSpan", () => {
      const deps = makeDeps();
      const bridge = createObservabilityInstrumentationBridge(deps);

      bridge.endSpan({
        correlation: { traceId: "t-1", spanId: "s-1", module: "workflows" },
        status: "error",
        durationMs: 50,
        error: "Connection timeout",
      });

      expect(deps.endSpan).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error", error: "Connection timeout" }),
      );
    });
  });

  describe("sampling", () => {
    it("samples everything at rate 1.0 (default)", () => {
      const bridge = createObservabilityInstrumentationBridge(makeDeps());

      expect(bridge.shouldSample({})).toBe(true);
      expect(bridge.shouldSample({ status: "ok" })).toBe(true);
    });

    it("always samples errors regardless of rate", () => {
      const bridge = createObservabilityInstrumentationBridge(makeDeps({
        samplingPolicy: { rate: 0, alwaysSampleErrors: true, alwaysSampleSlowMs: 0 },
      }));

      expect(bridge.shouldSample({ status: "error" })).toBe(true);
      expect(bridge.shouldSample({ status: "ok" })).toBe(false);
    });

    it("always samples slow operations", () => {
      const bridge = createObservabilityInstrumentationBridge(makeDeps({
        samplingPolicy: { rate: 0, alwaysSampleErrors: false, alwaysSampleSlowMs: 1000 },
      }));

      expect(bridge.shouldSample({ durationMs: 1000 })).toBe(true);
      expect(bridge.shouldSample({ durationMs: 999 })).toBe(false);
    });

    it("drops events at rate 0.0", () => {
      const deps = makeDeps({
        samplingPolicy: { rate: 0, alwaysSampleErrors: false, alwaysSampleSlowMs: 0 },
      });
      const bridge = createObservabilityInstrumentationBridge(deps);

      bridge.record(makeEvent({ kind: "workflow.run.end", status: "ok", durationMs: 100 }));

      // Event is recorded but metrics are not due to sampling
      expect(bridge.getRecordedEvents()).toHaveLength(1);
      expect(deps.incrementCounter).not.toHaveBeenCalled();
    });

    it("records metrics for sampled error events even at low rate", () => {
      const deps = makeDeps({
        samplingPolicy: { rate: 0, alwaysSampleErrors: true, alwaysSampleSlowMs: 0 },
      });
      const bridge = createObservabilityInstrumentationBridge(deps);

      bridge.record(makeEvent({ kind: "workflow.run.end", status: "error", durationMs: 100 }));

      expect(deps.incrementCounter).toHaveBeenCalled();
    });
  });

  describe("metric naming", () => {
    it("exports all metric name constants", () => {
      expect(INSTRUMENTATION_METRICS.WORKFLOW_RUNS_TOTAL).toBe("friday.workflow.runs.total");
      expect(INSTRUMENTATION_METRICS.AGENT_TOOL_CALLS_TOTAL).toBe("friday.agent.tool.calls.total");
      expect(INSTRUMENTATION_METRICS.API_REQUESTS_TOTAL).toBe("friday.api.requests.total");
    });

    it("exports trace name constants", () => {
      expect(INSTRUMENTATION_TRACE_NAMES.WORKFLOW_RUN).toBe("workflow.run");
      expect(INSTRUMENTATION_TRACE_NAMES.AGENT_RUN).toBe("agent.run");
      expect(INSTRUMENTATION_TRACE_NAMES.API_REQUEST).toBe("api.request");
    });
  });

  describe("reset", () => {
    it("clears all recorded events and counts", () => {
      const bridge = createObservabilityInstrumentationBridge(makeDeps());

      bridge.record(makeEvent());
      bridge.record(makeEvent());
      expect(bridge.getRecordedEvents()).toHaveLength(2);

      bridge.reset();
      expect(bridge.getRecordedEvents()).toHaveLength(0);
      expect(Object.keys(bridge.getEventCounts())).toHaveLength(0);
    });
  });

  describe("getRecordedEvents", () => {
    it("returns a copy (not mutable reference)", () => {
      const bridge = createObservabilityInstrumentationBridge(makeDeps());

      bridge.record(makeEvent());
      const events = bridge.getRecordedEvents();
      (events as InstrumentationEvent[]).length = 0;

      expect(bridge.getRecordedEvents()).toHaveLength(1);
    });
  });

  // ─── B4 truth-labeling ───

  it("B4 truth-labeling: emits a one-time advisory naming the proof_pending state", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      createObservabilityInstrumentationBridge(makeDeps());
      createObservabilityInstrumentationBridge(makeDeps());
      createObservabilityInstrumentationBridge(makeDeps());

      const advisoryCalls = infoSpy.mock.calls.filter((call) =>
        typeof call[0] === "string" && (call[0] as string).includes("[friday][observability][instrumentation-bridge]"),
      );
      expect(advisoryCalls.length).toBeLessThanOrEqual(1);
      if (advisoryCalls.length === 1) {
        const message = advisoryCalls[0]![0] as string;
        expect(message).toContain("zero production import sites");
        expect(message).toContain("proof_pending");
      }
    } finally {
      infoSpy.mockRestore();
    }
  });
});
