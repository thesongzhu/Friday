import { describe, it, expect, beforeEach } from "vitest";
import { FridayTraceManager } from "../../../../src/observability/engine/trace-manager.js";

describe("FridayTraceManager", () => {
  let manager: FridayTraceManager;

  beforeEach(() => {
    manager = new FridayTraceManager();
  });

  // ─── Trace Creation ───

  describe("startTrace", () => {
    it("creates a trace with a root span", () => {
      const handle = manager.startTrace({
        name: "workflow-run:wf-1",
        module: "workflows",
        operationName: "workflow.execute",
      });

      expect(handle.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(handle.rootSpanContext.traceId).toBe(handle.traceId);
      expect(handle.rootSpanContext.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(handle.rootSpanContext.traceFlags).toBe(1);
    });

    it("marks the trace as active", () => {
      const { traceId } = manager.startTrace({
        name: "test-trace",
        module: "api",
        operationName: "api.request",
      });
      expect(manager.isTraceActive(traceId)).toBe(true);
      expect(manager.getActiveTraceCount()).toBe(1);
    });

    it("creates root span with correct defaults", () => {
      const { rootSpanContext } = manager.startTrace({
        name: "test-trace",
        module: "rules",
        operationName: "rules.evaluate",
      });
      const span = manager.getActiveSpan(rootSpanContext);
      expect(span).not.toBeNull();
      expect(span!.kind).toBe("internal");
      expect(span!.status).toBe("unset");
      expect(span!.module).toBe("rules");
      expect(span!.parentSpanId).toBeUndefined();
    });

    it("applies custom kind and attributes", () => {
      const { rootSpanContext } = manager.startTrace({
        name: "api-request",
        module: "api",
        operationName: "api.handle",
        kind: "server",
        spanAttributes: { "http.method": "GET" },
      });
      const span = manager.getActiveSpan(rootSpanContext);
      expect(span!.kind).toBe("server");
      expect(span!.attributes["http.method"]).toBe("GET");
    });
  });

  // ─── Child Spans ───

  describe("startSpan", () => {
    it("creates a child span with parent reference", () => {
      const { rootSpanContext } = manager.startTrace({
        name: "test",
        module: "workflows",
        operationName: "root",
      });

      const child = manager.startSpan({
        operationName: "child.op",
        module: "rules",
        parentContext: rootSpanContext,
      });

      const childSpan = manager.getActiveSpan(child.spanContext);
      expect(childSpan).not.toBeNull();
      expect(childSpan!.parentSpanId).toBe(rootSpanContext.spanId);
      expect(childSpan!.traceId).toBe(rootSpanContext.traceId);
    });

    it("throws without parentContext", () => {
      expect(() =>
        manager.startSpan({
          operationName: "orphan",
          module: "api",
        }),
      ).toThrow("parentContext with traceId is required");
    });

    it("throws for non-existent trace", () => {
      expect(() =>
        manager.startSpan({
          operationName: "orphan",
          module: "api",
          parentContext: { traceId: "nonexistent", spanId: "abc", traceFlags: 1 },
        }),
      ).toThrow("not found or already completed");
    });

    it("throws for non-existent parent span in an active trace", () => {
      const { traceId } = manager.startTrace({
        name: "parent-missing",
        module: "api",
        operationName: "root",
      });

      expect(() =>
        manager.startSpan({
          operationName: "child",
          module: "rules",
          parentContext: { traceId, spanId: "deadbeefdeadbeef", traceFlags: 1 },
        }),
      ).toThrow("Parent span");
    });

    it("supports deeply nested spans", () => {
      const { rootSpanContext } = manager.startTrace({
        name: "deep",
        module: "workflows",
        operationName: "root",
      });

      const child1 = manager.startSpan({
        operationName: "level1",
        module: "rules",
        parentContext: rootSpanContext,
      });

      const child2 = manager.startSpan({
        operationName: "level2",
        module: "node-runner",
        parentContext: child1.spanContext,
      });

      const deepSpan = manager.getActiveSpan(child2.spanContext);
      expect(deepSpan!.parentSpanId).toBe(child1.spanContext.spanId);
    });
  });

  // ─── Span Events ───

  describe("addSpanEvent", () => {
    it("adds events to an active span", () => {
      const { rootSpanContext } = manager.startTrace({
        name: "test",
        module: "api",
        operationName: "root",
      });

      manager.addSpanEvent(rootSpanContext, { name: "cache.miss" });
      manager.addSpanEvent(rootSpanContext, {
        name: "retry.scheduled",
        attributes: { "retry.attempt": 2 },
      });

      const span = manager.getActiveSpan(rootSpanContext);
      expect(span!.events).toHaveLength(2);
      expect(span!.events[0].name).toBe("cache.miss");
      expect(span!.events[1].name).toBe("retry.scheduled");
      expect(span!.events[1].attributes).toEqual({ "retry.attempt": 2 });
    });

    it("silently ignores events on non-existent spans", () => {
      manager.addSpanEvent(
        { traceId: "bad", spanId: "bad", traceFlags: 1 },
        { name: "event" },
      );
      // Should not throw
    });
  });

  // ─── Span Attributes ───

  describe("setSpanAttributes", () => {
    it("merges attributes on an active span", () => {
      const { rootSpanContext } = manager.startTrace({
        name: "test",
        module: "api",
        operationName: "root",
        spanAttributes: { existing: "value" },
      });

      manager.setSpanAttributes(rootSpanContext, { added: "new" });

      const span = manager.getActiveSpan(rootSpanContext);
      expect(span!.attributes).toEqual({ existing: "value", added: "new" });
    });
  });

  // ─── Span Status ───

  describe("setSpanStatus", () => {
    it("sets status on an active span", () => {
      const { rootSpanContext } = manager.startTrace({
        name: "test",
        module: "api",
        operationName: "root",
      });

      manager.setSpanStatus(rootSpanContext, "error", "Something broke");

      const span = manager.getActiveSpan(rootSpanContext);
      expect(span!.status).toBe("error");
      expect(span!.statusMessage).toBe("Something broke");
    });
  });

  // ─── Ending Spans and Trace Finalization ───

  describe("endSpan", () => {
    it("sets endedAt and durationMs", () => {
      const { rootSpanContext, traceId } = manager.startTrace({
        name: "test",
        module: "api",
        operationName: "root",
      });

      manager.endSpan(rootSpanContext, "ok");

      // Trace should be finalized (single span)
      const trace = manager.getTrace(traceId);
      expect(trace).not.toBeNull();
      expect(trace!.spans[0].endedAt).toBeDefined();
      expect(typeof trace!.spans[0].durationMs).toBe("number");
      expect(trace!.spans[0].status).toBe("ok");
    });

    it("defaults unset status to ok on end", () => {
      const { rootSpanContext, traceId } = manager.startTrace({
        name: "test",
        module: "api",
        operationName: "root",
      });

      manager.endSpan(rootSpanContext);

      const trace = manager.getTrace(traceId);
      expect(trace!.spans[0].status).toBe("ok");
    });

    it("finalizes trace when all spans are ended", () => {
      const { rootSpanContext, traceId } = manager.startTrace({
        name: "multi-span",
        module: "workflows",
        operationName: "root",
      });

      const child = manager.startSpan({
        operationName: "child",
        module: "rules",
        parentContext: rootSpanContext,
      });

      // End child first
      manager.endSpan(child.spanContext, "ok");
      expect(manager.isTraceActive(traceId)).toBe(true);

      // End root — trace should finalize
      manager.endSpan(rootSpanContext, "ok");
      expect(manager.isTraceActive(traceId)).toBe(false);

      const trace = manager.getTrace(traceId);
      expect(trace).not.toBeNull();
      expect(trace!.spanCount).toBe(2);
      expect(trace!.status).toBe("ok");
    });

    it("silently ignores ending non-existent spans", () => {
      manager.endSpan({ traceId: "bad", spanId: "bad", traceFlags: 1 });
      // Should not throw
    });
  });

  // ─── Completed Traces ───

  describe("completed trace properties", () => {
    it("computes correct trace duration", () => {
      const { rootSpanContext, traceId } = manager.startTrace({
        name: "test",
        module: "api",
        operationName: "root",
      });

      manager.endSpan(rootSpanContext, "ok");

      const trace = manager.getTrace(traceId);
      expect(trace!.durationMs).toBeGreaterThanOrEqual(0);
      expect(trace!.startedAt).toBeDefined();
      expect(trace!.endedAt).toBeDefined();
    });

    it("sorts spans by startedAt", () => {
      const { rootSpanContext, traceId } = manager.startTrace({
        name: "test",
        module: "workflows",
        operationName: "root",
      });

      const child = manager.startSpan({
        operationName: "child",
        module: "rules",
        parentContext: rootSpanContext,
      });

      manager.endSpan(child.spanContext, "ok");
      manager.endSpan(rootSpanContext, "ok");

      const trace = manager.getTrace(traceId);
      expect(trace!.spans[0].operationName).toBe("root");
      expect(trace!.spans[1].operationName).toBe("child");
    });

    it("inherits root span status as trace status", () => {
      const { rootSpanContext, traceId } = manager.startTrace({
        name: "error-trace",
        module: "api",
        operationName: "root",
      });

      manager.setSpanStatus(rootSpanContext, "error", "failed");
      manager.endSpan(rootSpanContext);

      const trace = manager.getTrace(traceId);
      expect(trace!.status).toBe("error");
    });

    it("preserves trace-level attributes", () => {
      const { rootSpanContext, traceId } = manager.startTrace({
        name: "attributed",
        module: "workflows",
        operationName: "root",
        attributes: { "friday.workflow.id": "wf-1" },
      });

      manager.endSpan(rootSpanContext, "ok");

      const trace = manager.getTrace(traceId);
      expect(trace!.attributes["friday.workflow.id"]).toBe("wf-1");
    });
  });

  // ─── Query ───

  describe("query methods", () => {
    it("getCompletedTraces returns all finalized traces", () => {
      for (let i = 0; i < 3; i++) {
        const { rootSpanContext } = manager.startTrace({
          name: `trace-${i}`,
          module: "api",
          operationName: "op",
        });
        manager.endSpan(rootSpanContext, "ok");
      }

      expect(manager.getCompletedTraces()).toHaveLength(3);
    });

    it("removeCompletedTrace removes a trace", () => {
      const { rootSpanContext, traceId } = manager.startTrace({
        name: "removable",
        module: "api",
        operationName: "op",
      });
      manager.endSpan(rootSpanContext, "ok");

      expect(manager.removeCompletedTrace(traceId)).toBe(true);
      expect(manager.getTrace(traceId)).toBeNull();
    });

    it("removeCompletedTrace returns false for unknown trace", () => {
      expect(manager.removeCompletedTrace("unknown")).toBe(false);
    });

    it("getTrace returns null for unknown trace", () => {
      expect(manager.getTrace("unknown")).toBeNull();
    });
  });

  describe("tamper resistance", () => {
    it("getActiveSpan returns deep-frozen snapshots that cannot mutate internals", () => {
      const { rootSpanContext } = manager.startTrace({
        name: "active-span-immutability",
        module: "api",
        operationName: "root",
        spanAttributes: { service: "frontend" },
      });

      const snapshot = manager.getActiveSpan(rootSpanContext)!;

      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.attributes)).toBe(true);
      expect(Object.isFrozen(snapshot.events)).toBe(true);

      expect(() => {
        snapshot.operationName = "tampered";
      }).toThrow(TypeError);
      expect(() => {
        snapshot.attributes.service = "hijacked";
      }).toThrow(TypeError);
      expect(() => {
        snapshot.events.push({ name: "bad", timestamp: new Date().toISOString() });
      }).toThrow(TypeError);

      manager.setSpanStatus(rootSpanContext, "error", "updated internally");
      const freshSnapshot = manager.getActiveSpan(rootSpanContext)!;
      expect(freshSnapshot.status).toBe("error");
      expect(freshSnapshot.operationName).toBe("root");
      expect(freshSnapshot.attributes.service).toBe("frontend");
    });

    it("getTrace and getCompletedTraces return deep-frozen copies", () => {
      const { rootSpanContext, traceId } = manager.startTrace({
        name: "completed-trace-immutability",
        module: "workflows",
        operationName: "root",
        attributes: { "trace.owner": "scheduler" },
      });

      const child = manager.startSpan({
        operationName: "child",
        module: "rules",
        parentContext: rootSpanContext,
        attributes: { "child.stage": "evaluate" },
      });

      manager.addSpanEvent(child.spanContext, { name: "rule.checked", attributes: { result: "ok" } });
      manager.endSpan(child.spanContext, "ok");
      manager.endSpan(rootSpanContext, "ok");

      const traceById = manager.getTrace(traceId)!;
      const allTraces = manager.getCompletedTraces();
      const childSnapshot = traceById.spans.find((span) => span.operationName === "child")!;

      expect(Object.isFrozen(traceById)).toBe(true);
      expect(Object.isFrozen(traceById.attributes)).toBe(true);
      expect(Object.isFrozen(traceById.spans)).toBe(true);
      expect(Object.isFrozen(traceById.spans[0])).toBe(true);
      expect(Object.isFrozen(traceById.spans[0].attributes)).toBe(true);
      expect(Object.isFrozen(childSnapshot.events)).toBe(true);
      expect(Object.isFrozen(childSnapshot.events[0])).toBe(true);
      expect(Object.isFrozen(allTraces)).toBe(true);
      expect(Object.isFrozen(allTraces[0])).toBe(true);

      expect(() => {
        traceById.name = "tampered";
      }).toThrow(TypeError);
      expect(() => {
        traceById.attributes["trace.owner"] = "mutated";
      }).toThrow(TypeError);
      expect(() => {
        childSnapshot.events[0].name = "tampered-event";
      }).toThrow(TypeError);
      expect(() => {
        allTraces.push(traceById);
      }).toThrow(TypeError);

      const refreshed = manager.getTrace(traceId)!;
      const refreshedChild = refreshed.spans.find((span) => span.operationName === "child")!;
      expect(refreshed.name).toBe("completed-trace-immutability");
      expect(refreshed.attributes["trace.owner"]).toBe("scheduler");
      expect(refreshedChild.events[0].name).toBe("rule.checked");
    });
  });

  // ─── Reset ───

  describe("reset", () => {
    it("clears all state", () => {
      const { rootSpanContext } = manager.startTrace({
        name: "test",
        module: "api",
        operationName: "op",
      });
      manager.endSpan(rootSpanContext, "ok");

      manager.startTrace({ name: "active", module: "api", operationName: "op" });

      manager.reset();

      expect(manager.getCompletedTraces()).toHaveLength(0);
      expect(manager.getActiveTraceCount()).toBe(0);
    });
  });
});
