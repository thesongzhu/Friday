import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createOnboardingEngine,
} from "../../../../src/uix/engine/onboarding-engine.js";
import type {
  OnboardingEngine,
  OnboardingFlowDefinition,
  OnboardingStepDefinition,
} from "../../../../src/uix/engine/onboarding-engine.js";

// ─── Fixtures ───

function makeStep(overrides: Partial<OnboardingStepDefinition> = {}): OnboardingStepDefinition {
  return {
    id: "step-1",
    title: "Welcome",
    sortOrder: 0,
    skippable: false,
    ...overrides,
  };
}

function makeFlow(overrides: Partial<OnboardingFlowDefinition> = {}): OnboardingFlowDefinition {
  return {
    id: "flow-1",
    name: "Getting Started",
    steps: [
      makeStep({ id: "step-1", title: "Welcome", sortOrder: 0 }),
      makeStep({ id: "step-2", title: "Connect", sortOrder: 1, skippable: true }),
      makeStep({ id: "step-3", title: "Create", sortOrder: 2 }),
    ],
    enabled: true,
    version: 1,
    ...overrides,
  };
}

// ─── Tests ───

describe("OnboardingEngine", () => {
  let engine: OnboardingEngine;

  beforeEach(() => {
    engine = createOnboardingEngine();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("flow definitions", () => {
    it("registers and retrieves a flow", () => {
      const flow = makeFlow();
      engine.registerFlow(flow);
      expect(engine.getFlow("flow-1")).toEqual(flow);
    });

    it("returns undefined for unknown flow", () => {
      expect(engine.getFlow("unknown")).toBeUndefined();
    });

    it("lists all flows", () => {
      engine.registerFlow(makeFlow({ id: "f1" }));
      engine.registerFlow(makeFlow({ id: "f2" }));
      expect(engine.getAllFlows()).toHaveLength(2);
    });

    it("unregisters a flow", () => {
      engine.registerFlow(makeFlow());
      expect(engine.unregisterFlow("flow-1")).toBe(true);
      expect(engine.getFlow("flow-1")).toBeUndefined();
    });

    it("returns false when unregistering unknown flow", () => {
      expect(engine.unregisterFlow("unknown")).toBe(false);
    });
  });

  describe("sessions", () => {
    it("starts a session for a registered flow", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1");
      expect(session).toBeDefined();
      expect(session!.flowId).toBe("flow-1");
      expect(session!.principalId).toBe("user-1");
      expect(session!.status).toBe("in_progress");
      expect(session!.stepProgress).toHaveLength(3);
      expect(session!.stepProgress[0].status).toBe("active");
      expect(session!.stepProgress[1].status).toBe("pending");
    });

    it("returns undefined for disabled flow", () => {
      engine.registerFlow(makeFlow({ enabled: false }));
      expect(engine.startSession("flow-1", "user-1")).toBeUndefined();
    });

    it("returns undefined for unknown flow", () => {
      expect(engine.startSession("unknown", "user-1")).toBeUndefined();
    });

    it("returns existing session for same user+flow", () => {
      engine.registerFlow(makeFlow());
      const s1 = engine.startSession("flow-1", "user-1");
      const s2 = engine.startSession("flow-1", "user-1");
      expect(s1!.id).toBe(s2!.id);
    });

    it("creates separate sessions for different users", () => {
      engine.registerFlow(makeFlow());
      const s1 = engine.startSession("flow-1", "user-1");
      const s2 = engine.startSession("flow-1", "user-2");
      expect(s1!.id).not.toBe(s2!.id);
    });

    it("retrieves session by id", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;
      expect(engine.getSession(session.id)).toEqual(session);
    });

    it("retrieves session by user and flow", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;
      expect(engine.getSessionByUser("flow-1", "user-1")?.id).toBe(session.id);
    });
  });

  describe("step progression", () => {
    it("completes a step and advances to next", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;
      const updated = engine.completeStep(session.id, "step-1", { name: "Alice" });
      expect(updated).toBeDefined();
      expect(updated!.stepProgress[0].status).toBe("completed");
      expect(updated!.stepProgress[0].data).toEqual({ name: "Alice" });
      expect(updated!.stepProgress[1].status).toBe("active");
    });

    it("completes all steps and marks session as completed", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;
      engine.completeStep(session.id, "step-1");
      engine.completeStep(session.id, "step-2");
      const final = engine.completeStep(session.id, "step-3");
      expect(final!.status).toBe("completed");
      expect(final!.finishedAt).toBeDefined();
    });

    it("returns undefined for already completed step", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;
      engine.completeStep(session.id, "step-1");
      expect(engine.completeStep(session.id, "step-1")).toBeUndefined();
    });

    it("returns undefined for unknown session", () => {
      expect(engine.completeStep("unknown", "step-1")).toBeUndefined();
    });

    it("refuses to complete a non-active step", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;

      expect(engine.completeStep(session.id, "step-2")).toBeUndefined();

      const latest = engine.getSession(session.id)!;
      const activeSteps = latest.stepProgress.filter((step) => step.status === "active");
      expect(activeSteps).toHaveLength(1);
      expect(activeSteps[0].stepId).toBe("step-1");
    });

    it("skips a skippable step", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;
      engine.completeStep(session.id, "step-1");
      const updated = engine.skipStep(session.id, "step-2");
      expect(updated).toBeDefined();
      expect(updated!.stepProgress[1].status).toBe("skipped");
      expect(updated!.stepProgress[2].status).toBe("active");
    });

    it("refuses to skip a non-skippable step", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;
      expect(engine.skipStep(session.id, "step-1")).toBeUndefined();
    });

    it("refuses to skip a non-active step even if the step is skippable", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;

      expect(engine.skipStep(session.id, "step-2")).toBeUndefined();

      const latest = engine.getSession(session.id)!;
      const activeSteps = latest.stepProgress.filter((step) => step.status === "active");
      expect(activeSteps).toHaveLength(1);
      expect(activeSteps[0].stepId).toBe("step-1");
    });

    it("dismisses a session", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;
      const dismissed = engine.dismissSession(session.id);
      expect(dismissed!.status).toBe("dismissed");
      expect(dismissed!.finishedAt).toBeDefined();
    });

    it("returns undefined when dismissing non-in-progress session", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;
      engine.dismissSession(session.id);
      expect(engine.dismissSession(session.id)).toBeUndefined();
    });
  });

  describe("rollback", () => {
    it("goes back to the previous completed step", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;
      engine.completeStep(session.id, "step-1");

      const rolledBack = engine.goBackStep(session.id);
      expect(rolledBack).toBeDefined();
      expect(rolledBack!.currentStepIndex).toBe(0);
      expect(rolledBack!.stepProgress[0].status).toBe("active");
      expect(rolledBack!.stepProgress[1].status).toBe("pending");
    });

    it("returns undefined when going back from the first step", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;
      expect(engine.goBackStep(session.id)).toBeUndefined();
    });

    it("returns undefined when going back on a completed session", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;
      engine.completeStep(session.id, "step-1");
      engine.completeStep(session.id, "step-2");
      engine.completeStep(session.id, "step-3");
      expect(engine.goBackStep(session.id)).toBeUndefined();
    });
  });

  describe("conditional steps", () => {
    it("filters steps based on condition data", () => {
      const flow = makeFlow({
        steps: [
          makeStep({ id: "s1", sortOrder: 0 }),
          makeStep({ id: "s2", sortOrder: 1, showConditionKey: "needsSlack" }),
          makeStep({ id: "s3", sortOrder: 2 }),
        ],
      });
      engine.registerFlow(flow);

      // Without condition met → s2 hidden
      const session = engine.startSession("flow-1", "user-a", {});
      expect(session!.stepProgress).toHaveLength(2);
      expect(session!.stepProgress.map((s) => s.stepId)).toEqual(["s1", "s3"]);
    });

    it("includes conditional step when condition is truthy", () => {
      const flow = makeFlow({
        steps: [
          makeStep({ id: "s1", sortOrder: 0 }),
          makeStep({ id: "s2", sortOrder: 1, showConditionKey: "needsSlack" }),
          makeStep({ id: "s3", sortOrder: 2 }),
        ],
      });
      engine.registerFlow(flow);

      const session = engine.startSession("flow-1", "user-b", { needsSlack: true });
      expect(session!.stepProgress).toHaveLength(3);
    });

    it("excludes step when negated condition is truthy", () => {
      const flow = makeFlow({
        steps: [
          makeStep({ id: "s1", sortOrder: 0 }),
          makeStep({ id: "s2", sortOrder: 1, showConditionKey: "hasSlack", showConditionNegate: true }),
        ],
      });
      engine.registerFlow(flow);

      const session = engine.startSession("flow-1", "user-c", { hasSlack: true });
      expect(session!.stepProgress).toHaveLength(1);
    });
  });

  describe("display helpers", () => {
    it("returns checklist items", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;
      engine.completeStep(session.id, "step-1");

      const checklist = engine.getChecklist(session.id);
      expect(checklist).toHaveLength(3);
      expect(checklist[0].completed).toBe(true);
      expect(checklist[0].active).toBe(false);
      expect(checklist[1].active).toBe(true);
      expect(checklist[1].completed).toBe(false);
      expect(checklist[2].active).toBe(false);
    });

    it("returns empty checklist for unknown session", () => {
      expect(engine.getChecklist("unknown")).toEqual([]);
    });

    it("returns progress summary", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;
      engine.completeStep(session.id, "step-1");

      const progress = engine.getProgress(session.id);
      expect(progress).toBeDefined();
      expect(progress!.totalSteps).toBe(3);
      expect(progress!.completedSteps).toBe(1);
      expect(progress!.percentComplete).toBe(33);
    });

    it("returns undefined progress for unknown session", () => {
      expect(engine.getProgress("unknown")).toBeUndefined();
    });

    it("counts skipped steps in progress", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;
      engine.completeStep(session.id, "step-1");
      engine.skipStep(session.id, "step-2");

      const progress = engine.getProgress(session.id)!;
      expect(progress.completedSteps).toBe(1);
      expect(progress.skippedSteps).toBe(1);
      expect(progress.percentComplete).toBe(67);
    });
  });

  describe("metrics and telemetry", () => {
    it("records step durations and completion timing", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;

      vi.advanceTimersByTime(1_000);
      engine.completeStep(session.id, "step-1");
      vi.advanceTimersByTime(500);
      engine.completeStep(session.id, "step-2");
      vi.advanceTimersByTime(200);
      engine.completeStep(session.id, "step-3");

      const metrics = engine.getMetrics();
      const sessionMetrics = metrics.sessions.find((m) => m.sessionId === session.id)!;

      expect(sessionMetrics.startedAt).toBeDefined();
      expect(sessionMetrics.completedAt).toBeDefined();
      expect(sessionMetrics.completionTimeMs).toBe(1700);
      expect(sessionMetrics.stepDurationsMs["step-1"]).toBe(1000);
      expect(sessionMetrics.stepDurationsMs["step-2"]).toBe(500);
      expect(sessionMetrics.stepDurationsMs["step-3"]).toBe(200);
      expect(metrics.events.some((event) => event.type === "session_started")).toBe(true);
      expect(metrics.events.some((event) => event.type === "step_completed")).toBe(true);
      expect(metrics.events.some((event) => event.type === "session_completed")).toBe(true);
    });

    it("emits dead-end failures for invalid transitions", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-1")!;

      expect(engine.completeStep(session.id, "step-2")).toBeUndefined();

      const metrics = engine.getMetrics();
      expect(metrics.events.some((event) =>
        event.type === "session_failed" && event.reason === "step_not_active"
      )).toBe(true);
      const sessionMetrics = metrics.sessions.find((m) => m.sessionId === session.id)!;
      expect(sessionMetrics.deadEndDetected).toBe(true);
      expect(sessionMetrics.failedAt).toBeDefined();
    });

    it("meets KPI thresholds for first-run success and dead-end rate", () => {
      engine.registerFlow(makeFlow());

      const totalSessions = 120;
      for (let i = 0; i < totalSessions; i++) {
        const session = engine.startSession("flow-1", `user-${i}`)!;
        if (i < 110) {
          engine.completeStep(session.id, "step-1");
          engine.completeStep(session.id, "step-2");
          engine.completeStep(session.id, "step-3");
        } else if (i < 119) {
          engine.dismissSession(session.id);
        } else {
          engine.completeStep(session.id, "step-2");
        }
      }

      const metrics = engine.getMetrics();
      expect(metrics.totalSessions).toBe(120);
      expect(metrics.firstRunSuccessRate).toBeGreaterThan(0.85);
      expect(metrics.deadEndRate).toBeLessThan(0.01);
    });
  });

  describe("immutability", () => {
    it("returns frozen session snapshots from getters", () => {
      engine.registerFlow(makeFlow());
      const session = engine.startSession("flow-1", "user-immutable")!;
      const snapshot = engine.getSession(session.id)!;

      expect(() => {
        Object.assign(snapshot.stepProgress[0], { status: "completed" });
      }).toThrow(TypeError);
    });
  });
});
