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

    it("does not extract sensitive correction facts", () => {
      const sensitivePayloads = [
        { correctedField: "password", newValue: "hunter2" },
        { correctedField: "medical diagnosis", newValue: "diabetes" },
        { field: "credit card", value: "4111111111111111" },
      ];
      for (const [index, payload] of sensitivePayloads.entries()) {
        const event = makeEvent({
          eventId: `evt-sensitive-${String(index)}`,
          kind: "user_correction",
          payload,
        });

        expect(service.extract(event)).toHaveLength(0);
      }
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

    it("extracts Chinese display-name patterns", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "我的名字是 测试名，以后叫我 测试名。" },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("preference");
      expect(signals[0]!.key).toBe("pref:display_name");
      expect(signals[0]!.value).toBe("测试名");
    });

    it("does not extract sensitive user-message preferences", () => {
      for (const text of [
        "always use hunter2 for password",
        "I prefer insulin for medication",
        "call me my-secret-token",
        "always use driver license marker for driver's license",
        "以后叫我 密码123",
      ]) {
        const event = makeEvent({
          eventId: `evt-sensitive-${text.length}`,
          kind: "user_message",
          payload: { text },
        });

        expect(service.extract(event)).toHaveLength(0);
      }
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

    it("falls back to errorMessage for legacy bridge payloads", () => {
      const event = makeEvent({
        kind: "error_incident",
        payload: { category: "tool", errorMessage: "legacy_bridge_error" },
      });

      const signals = service.extract(event);
      const value = signals[0]!.value as Record<string, unknown>;
      expect(value["message"]).toBe("legacy_bridge_error");
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

  describe("outcome_confirmed events", () => {
    it("extracts operator rejection feedback into correction signals", () => {
      const event = makeEvent({
        kind: "outcome_confirmed",
        payload: {
          type: "autofix_rejected",
          reasonCode: "too_risky",
          reason: "This patch is too risky for prod",
          taskProfileId: "review",
          actualProviderId: "provider-1",
          actualModel: "gpt-4o-mini",
          backendKind: "http",
          fingerprint: "fp-1",
        },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(2);
      expect(signals[0]!.kind).toBe("correction");
      expect(signals[0]!.key).toBe("autofix:rejection_reason:too_risky");
      expect(signals[1]!.key).toBe("route_penalty:review:provider_1:http:gpt_4o_mini");
    });

    it("extracts manual resolution feedback into a correction signal", () => {
      const event = makeEvent({
        kind: "outcome_confirmed",
        payload: {
          type: "manual_resolved",
          fingerprint: "workflow-timeout",
          cause: "Bad timeout default",
          fix: "Raised timeout to 30s and retried",
        },
      });

      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe("correction");
      expect(signals[0]!.key).toBe("manual_resolution:workflow_timeout");
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

  describe("persona preference rules", () => {
    it("extracts verbosity=concise from 'be more concise'", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "Can you be more concise in your answers?" },
      });
      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.key).toBe("persona.verbosity");
      expect(signals[0]!.value).toBe("concise");
      expect(signals[0]!.confidence).toBe(0.65);
    });

    it("extracts verbosity=detailed from 'please be more detailed'", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "please be more detailed" },
      });
      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.key).toBe("persona.verbosity");
      expect(signals[0]!.value).toBe("detailed");
    });

    it("extracts tone=warm from 'be more friendly'", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "can you be more friendly when responding" },
      });
      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.key).toBe("persona.tone");
      expect(signals[0]!.value).toBe("warm");
    });

    it("extracts questionStyle=minimal from 'stop asking so many questions'", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "please stop asking so many questions" },
      });
      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.key).toBe("persona.question_style");
      expect(signals[0]!.value).toBe("minimal");
    });

    it("extracts directness=direct from 'be more direct'", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "I want you to be more direct" },
      });
      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.key).toBe("persona.directness");
      expect(signals[0]!.value).toBe("direct");
    });

    it("extracts Chinese verbosity=concise from '简洁一点'", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "回答简洁一点" },
      });
      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.key).toBe("persona.verbosity");
      expect(signals[0]!.value).toBe("concise");
    });

    it("extracts Chinese verbosity=detailed from '详细一点'", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "请详细一点��明" },
      });
      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.key).toBe("persona.verbosity");
      expect(signals[0]!.value).toBe("detailed");
    });

    it("extracts Chinese questionStyle=minimal from '别问那么多'", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "别问那么多问题" },
      });
      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.key).toBe("persona.question_style");
      expect(signals[0]!.value).toBe("minimal");
    });

    it("extracts tone=analytical from 'be more formal'", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "could you be more formal in your responses" },
      });
      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.key).toBe("persona.tone");
      expect(signals[0]!.value).toBe("analytical");
    });

    it("extracts Chinese directness from '直接一点'", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "请回答直接一点" },
      });
      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.key).toBe("persona.directness");
      expect(signals[0]!.value).toBe("direct");
    });

    it("extracts verbosity=concise from 'be more brief'", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "please be more brief" },
      });
      const signals = service.extract(event);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.key).toBe("persona.verbosity");
      expect(signals[0]!.value).toBe("concise");
    });

    it("does NOT match conversational mentions (false positive guard)", () => {
      const event = makeEvent({
        kind: "user_message",
        payload: { text: "The report was more concise than expected" },
      });
      const signals = service.extract(event);
      // Should NOT extract a persona preference from conversational text
      const personaSignals = signals.filter((s) => s.key.startsWith("persona."));
      expect(personaSignals).toHaveLength(0);
    });
  });
});
