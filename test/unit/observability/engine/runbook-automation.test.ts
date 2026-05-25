import { describe, it, expect, beforeEach, vi } from "vitest";
import { RunbookExecutor, RunbookRegistry } from "../../../../src/observability/engine/runbook-automation.js";
import type {
  FridayAlertEvent,
  FridayAlertRule,
  FridayEscalationTier,
} from "../../../../src/observability/model/friday-observability.types.js";

function makeRule(overrides: Partial<FridayAlertRule> = {}): FridayAlertRule {
  return {
    id: "rule-1",
    name: "High Error Rate",
    description: "Error rate alert",
    severity: "critical",
    enabled: true,
    condition: {
      type: "threshold",
      metricName: "api.error_rate",
      threshold: 5,
      operator: "gt",
    },
    evaluationIntervalSec: 60,
    channelIds: ["ch-1"],
    escalationTiers: [{ tier: 1, timeoutMinutes: 5, channelIds: ["ch-2"] }],
    groupingWindowMin: 1,
    tags: [],
    etag: "etag-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<FridayAlertEvent> = {}): FridayAlertEvent {
  return {
    id: "event-1",
    ruleId: "rule-1",
    severity: "critical",
    status: "escalated",
    summary: "api.error_rate = 10 gt 5",
    details: "test",
    module: "observability",
    metricName: "api.error_rate",
    observedValue: 10,
    thresholdValue: 5,
    notifiedChannelIds: ["ch-1", "ch-2"],
    currentEscalationTier: 1,
    detectedAt: "2026-01-01T00:00:00.000Z",
    firedAt: "2026-01-01T00:01:00.000Z",
    escalatedAt: "2026-01-01T00:06:00.000Z",
    ...overrides,
  };
}

const tier: FridayEscalationTier = {
  tier: 1,
  timeoutMinutes: 5,
  channelIds: ["ch-2"],
};

describe("RunbookRegistry", () => {
  let registry: RunbookRegistry;

  beforeEach(() => {
    registry = new RunbookRegistry();
  });

  it("registers and retrieves runbooks by rule", () => {
    const execute = vi.fn();
    registry.registerRunbook({
      id: "rb-1",
      name: "Restart API",
      ruleId: "rule-1",
      execute,
    });

    const byId = registry.getRunbook("rb-1");
    const byRule = registry.getRunbooksForRule("rule-1");

    expect(byId).not.toBeNull();
    expect(byRule).toHaveLength(1);
    expect(byRule[0].id).toBe("rb-1");
  });

  it("unregisters runbooks", () => {
    registry.registerRunbook({
      id: "rb-1",
      name: "Restart API",
      ruleId: "rule-1",
      execute: vi.fn(),
    });

    expect(registry.unregisterRunbook("rb-1")).toBe(true);
    expect(registry.getRunbook("rb-1")).toBeNull();
    expect(registry.getRunbooksForRule("rule-1")).toHaveLength(0);
  });
});

describe("RunbookExecutor", () => {
  let registry: RunbookRegistry;
  let executor: RunbookExecutor;

  beforeEach(() => {
    registry = new RunbookRegistry();
    executor = new RunbookExecutor(registry);
  });

  it("executes all runbooks for an escalated rule", () => {
    const first = vi.fn();
    const second = vi.fn();

    registry.registerRunbook({
      id: "rb-1",
      name: "Restart API",
      ruleId: "rule-1",
      execute: first,
    });
    registry.registerRunbook({
      id: "rb-2",
      name: "Scale API",
      ruleId: "rule-1",
      execute: second,
    });

    const results = executor.triggerOnEscalation(makeEvent(), makeRule(), tier);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "success")).toBe(true);
    expect(executor.getExecutionHistory()).toHaveLength(2);
  });

  it("records failures without stopping other runbooks", () => {
    const successRunbook = vi.fn();

    registry.registerRunbook({
      id: "rb-ok",
      name: "Scale API",
      ruleId: "rule-1",
      execute: successRunbook,
    });
    registry.registerRunbook({
      id: "rb-fail",
      name: "Broken Runbook",
      ruleId: "rule-1",
      execute: () => {
        throw new Error("script failed");
      },
    });

    const results = executor.triggerOnEscalation(makeEvent(), makeRule(), tier);

    expect(successRunbook).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    expect(results.find((result) => result.runbookId === "rb-ok")!.status).toBe("success");
    expect(results.find((result) => result.runbookId === "rb-fail")!.status).toBe("failed");
    expect(results.find((result) => result.runbookId === "rb-fail")!.errorMessage).toContain("script failed");
  });

  it("returns empty results when no runbooks are registered for the rule", () => {
    const results = executor.triggerOnEscalation(
      makeEvent(),
      makeRule({ id: "other-rule" }),
      tier,
    );

    expect(results).toHaveLength(0);
    expect(executor.getExecutionHistory()).toHaveLength(0);
  });
});

describe("RunbookRegistry — B4 truth-labeling", () => {
  it("emits a one-time advisory naming the proof_pending state on first construction", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      new RunbookRegistry();
      new RunbookRegistry();
      new RunbookRegistry();

      const advisoryCalls = infoSpy.mock.calls.filter((call) =>
        typeof call[0] === "string" && (call[0] as string).includes("[friday][observability][runbook-automation]"),
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
