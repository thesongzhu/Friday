import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  buildFridayAgentSystemPrompt,
  createFridayAgentEventEmitter,
  createFridayAgentRuntime,
  evaluateFridayExecutionVoiceResponse,
  FRIDAY_EXECUTION_VOICE_SAMPLE_SCENARIOS,
} from "#agent";
import type {
  FridayAgentLlmClient,
  FridayAgentLlmStreamParams,
} from "#agent";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";

describe("Friday execution voice eval", () => {
  let db: FridaySqliteLayer;
  let idGenerator: () => string;
  const NOW = "2026-04-26T12:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGenerator = createTestIdGenerator();
  });

  afterEach(() => {
    db.close();
  });

  it("accepts the fixed execution voice sample responses", () => {
    for (const scenario of FRIDAY_EXECUTION_VOICE_SAMPLE_SCENARIOS) {
      const result = evaluateFridayExecutionVoiceResponse({
        scenarioId: scenario.id,
        response: scenario.sampleResponse,
      });

      expect(result.failures, scenario.id).toEqual([]);
      expect(result.passed, scenario.id).toBe(true);
    }
  });

  it("rejects stock ChatGPT-style and non-closed-loop responses", () => {
    const badResponses = [
      {
        scenarioId: "failure_next_step" as const,
        response: "当然可以。很抱歉，这一步失败了。如果你需要，我可以继续帮你看看。",
        expectedCodes: ["stock_phrase", "failure_evidence_missing", "failure_next_step_missing"],
      },
      {
        scenarioId: "completion_closeout" as const,
        response: "没问题，已经完成。",
        expectedCodes: ["stock_phrase", "change_summary_missing", "verification_missing", "remaining_risk_missing"],
      },
      {
        scenarioId: "assumption_correction" as const,
        response: "结论是调度坏了。日志里其实是 401。",
        expectedCodes: ["evidence_after_conclusion"],
      },
    ];

    for (const bad of badResponses) {
      const result = evaluateFridayExecutionVoiceResponse({
        scenarioId: bad.scenarioId,
        response: bad.response,
      });
      const codes = result.failures.map((failure) => failure.code);

      expect(result.passed, bad.scenarioId).toBe(false);
      for (const code of bad.expectedCodes) {
        expect(codes, `${bad.scenarioId}:${code}`).toContain(code);
      }
    }
  });

  it.each(FRIDAY_EXECUTION_VOICE_SAMPLE_SCENARIOS)(
    "checks runtime dialogue output for $id",
    async (scenario) => {
      let capturedParams: FridayAgentLlmStreamParams | null = null;
      const llmClient: FridayAgentLlmClient = {
        async *stream(params) {
          capturedParams = params;
          yield { type: "text_delta", text: scenario.sampleResponse };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 10, outputTokens: 10 };
        },
      };

      const runtime = createFridayAgentRuntime({
        allowTestOnlyAgentRunExecution: true,
        db,
        llmClient,
        model: "test-model",
        providerId: "test-provider",
        systemPromptBuilder: (context) => buildFridayAgentSystemPrompt({
          toolNames: context.toolNames,
          modelIdentity: "test-model (provider: test)",
          version: "0.0.0-test",
          currentTime: {
            nowIso: context.nowIso,
            timezone: context.timezone,
            localDate: context.localDate,
          },
        }),
        tools: [],
        eventEmitter: createFridayAgentEventEmitter(),
        idGenerator,
        nowIso: () => NOW,
      });

      const result = await runtime.executeRun({
        task: scenario.task,
        principalId: "user-voice-eval",
        timezone: "America/Los_Angeles",
      });

      expect(capturedParams?.systemPrompt).toContain("Execution communication style:");
      expect(capturedParams?.systemPrompt).toContain("Default to Chinese when the language is ambiguous");
      expect(result.status).toBe("completed");

      const evalResult = evaluateFridayExecutionVoiceResponse({
        scenarioId: scenario.id,
        response: result.response,
      });

      expect(evalResult.failures, scenario.id).toEqual([]);
      expect(evalResult.passed, scenario.id).toBe(true);
    },
  );
});
