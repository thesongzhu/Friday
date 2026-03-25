import { describe, it, expect, beforeEach } from "vitest";
import { createFridayPreferenceExtractionService } from "#learning";
import type { FridayPreferenceExtractionService } from "#learning";
import type { FridayLearningEventAppendInput } from "#ledger";
import { createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";

describe("FridayPreferenceExtractionService", () => {
  let service: FridayPreferenceExtractionService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    idGen = createTestIdGenerator();
    service = createFridayPreferenceExtractionService({
      idGenerator: idGen,
    });
  });

  function makeEvent(
    overrides: Partial<FridayLearningEventAppendInput>,
  ): FridayLearningEventAppendInput {
    return {
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_message",
      payload: {},
      ...overrides,
    };
  }

  describe("user_correction events", () => {
    it("extracts correction signal with confidence 1.0", () => {
      const event = makeEvent({
        kind: "user_correction",
        payload: { correctedField: "language", newValue: "Python" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("correction");
      expect(signals[0]!.key).toBe("pref:language");
      expect(signals[0]!.value).toBe("Python");
      expect(signals[0]!.confidence).toBe(1.0);
    });

    it("normalizes correctedField key", () => {
      const event = makeEvent({
        kind: "user_correction",
        payload: { correctedField: "Favorite Color", newValue: "blue" },
      });

      const signals = service.extract(event);
      expect(signals[0]!.key).toBe("pref:favorite_color");
    });

    it("accepts legacy field/value correction payloads", () => {
      const event = makeEvent({
        kind: "user_correction",
        payload: { field: "language", value: "TypeScript" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.key).toBe("pref:language");
      expect(signals[0]!.value).toBe("TypeScript");
    });

    it("returns empty for missing correctedField", () => {
      const event = makeEvent({
        kind: "user_correction",
        payload: { someOtherField: "value" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(0);
    });
  });

  describe("user_message events", () => {
    it("extracts 'prefer X' pattern", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "I prefer dark mode" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("preference");
      expect(signals[0]!.key).toBe("pref:dark_mode");
      expect(signals[0]!.value).toBe("dark mode");
      expect(signals[0]!.confidence).toBe(0.80);
    });

    it("extracts 'always use X' pattern", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "always use TypeScript" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("preference");
      expect(signals[0]!.value).toBe("TypeScript");
    });

    it("extracts 'don't use X' pattern", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "don't use Python" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("preference");
      expect(signals[0]!.key).toContain("avoid");
    });

    it("extracts 'call me X' pattern", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "call me Captain" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.key).toBe("pref:display_name");
      expect(signals[0]!.value).toBe("Captain");
    });

    it("returns empty for no matching pattern", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "hello, how are you?" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(0);
    });

    it("returns empty for missing text payload", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: {},
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(0);
    });
  });

  describe("tool_result events", () => {
    it("extracts error signal when ok=false", () => {
      const event = makeEvent({
        kind: "tool_result",
        payload: { ok: false, toolName: "search", errorCode: "timeout" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("error");
      expect(signals[0]!.key).toContain("tool_failure");
      expect(signals[0]!.key).toContain("search");
      expect(signals[0]!.confidence).toBe(1.0);
    });

    it("extracts error signal when error payload exists", () => {
      const event = makeEvent({
        kind: "tool_result",
        payload: { error: "connection refused", toolName: "api" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("error");
    });

    it("returns empty for successful tool result", () => {
      const event = makeEvent({
        kind: "tool_result",
        payload: { ok: true, result: "success" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(0);
    });
  });

  describe("error_incident events", () => {
    it("extracts error signal with confidence 1.0", () => {
      const event = makeEvent({
        kind: "error_incident",
        payload: { category: "config", message: "invalid_api_key" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("error");
      expect(signals[0]!.confidence).toBe(1.0);
      expect(signals[0]!.key).toContain("incident");
    });

    it("maps invalid category to 'tool' (V001 CHECK constraint)", () => {
      const event = makeEvent({
        kind: "error_incident",
        payload: { category: "unknown", message: "some_error" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      const value = signals[0]!.value as Record<string, unknown>;
      expect(value["category"]).toBe("tool");
    });

    it("maps missing category to 'tool'", () => {
      const event = makeEvent({
        kind: "error_incident",
        payload: { message: "some_error" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      const value = signals[0]!.value as Record<string, unknown>;
      expect(value["category"]).toBe("tool");
    });

    it("preserves valid categories unchanged", () => {
      for (const cat of ["tool", "model", "routing", "config", "workflow"]) {
        const event = makeEvent({
          eventId: `evt-${cat}`,
          kind: "error_incident",
          payload: { category: cat, message: "test" },
        });

        const signals = service.extract(event);
        const value = signals[0]!.value as Record<string, unknown>;
        expect(value["category"]).toBe(cat);
      }
    });

    it("preserves structured runtime context for downstream diagnosis", () => {
      const event = makeEvent({
        kind: "error_incident",
        payload: {
          category: "config",
          message: "satellite_degraded",
          severity: "medium",
          source: "satellite_runtime",
          satelliteId: "sat-1",
          toStatus: "degraded",
        },
      });

      const signals = service.extract(event);
      const value = signals[0]!.value as Record<string, unknown>;

      expect(value["source"]).toBe("satellite_runtime");
      expect(value["satelliteId"]).toBe("sat-1");
      expect(value["toStatus"]).toBe("degraded");
      expect(value["severity"]).toBe("medium");
    });
  });

  describe("workflow_outcome events", () => {
    it("extracts positive feedback for successful workflow", () => {
      const event = makeEvent({
        kind: "workflow_outcome",
        payload: { success: true, workflowId: "deploy-script" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("positive_feedback");
      expect(signals[0]!.confidence).toBe(0.55);
    });

    it("emits failure signal for failed workflow (success=false)", () => {
      const event = makeEvent({
        kind: "workflow_outcome",
        payload: { success: false, workflowId: "deploy-script" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("correction");
      expect(signals[0]!.key).toContain("workflow");
      expect(signals[0]!.key).toContain("success_rate");
      expect(signals[0]!.confidence).toBe(0.3);
      const value = signals[0]!.value as Record<string, unknown>;
      expect(value["value"]).toBe("low");
    });

    it("emits failure signal for workflow with status=failed", () => {
      const event = makeEvent({
        kind: "workflow_outcome",
        payload: { status: "failed", workflowId: "build-job" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("correction");
      expect(signals[0]!.key).toContain("build_job");
    });

    it("emits failure signal for workflow with error field", () => {
      const event = makeEvent({
        kind: "workflow_outcome",
        payload: { error: "OOM killed", workflowId: "train-model" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("correction");
      const value = signals[0]!.value as Record<string, unknown>;
      expect(value["error"]).toBe("OOM killed");
    });

    it("returns empty for ambiguous workflow outcome (no success/failure markers)", () => {
      const event = makeEvent({
        kind: "workflow_outcome",
        payload: { workflowId: "something" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(0);
    });
  });

  describe("assistant_message events", () => {
    it("returns empty to avoid self-reinforcement", () => {
      const event = makeEvent({
        kind: "assistant_message",
        payload: { text: "prefer TypeScript" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(0);
    });
  });

  it("sets correct signal metadata", () => {
    const event = makeEvent({
      eventId: "evt-123",
      kind: "user_correction",
      userId: "user-456",
      sessionId: "sess-789",
      runId: "run-abc",
      payload: { correctedField: "theme", newValue: "dark" },
    });

    const signals = service.extract(event);
    expect(signals[0]!.sourceEventId).toBe("evt-123");
    expect(signals[0]!.userId).toBe("user-456");
    expect(signals[0]!.sessionId).toBe("sess-789");
    expect(signals[0]!.runId).toBe("run-abc");
    expect(signals[0]!.ts).toBe(NOW);
    expect(signals[0]!.signalId).toBeTruthy();
  });
});
