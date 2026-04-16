import { describe, expect, it, vi } from "vitest";

import { selectJudgeLane } from "../../../validation/real-world/lib/env-truth.mjs";
import { finalizeArtifact, runLlmJudge } from "../../../validation/real-world/lib/judge.mjs";

describe("real-world judge gating", () => {
  it("skips the llm judge unless the scenario explicitly opts in", async () => {
    const client = {
      startAgentRun: vi.fn(),
    };
    const judge = await runLlmJudge({
      client,
      scenario: {
        id: "l1-chat-ui",
        layer: "L1",
        routeFamily: "surface",
        expectedEvidence: ["page becomes visibly interactive"],
        execution: { kind: "ui_probe" },
      },
      artifact: { result: "passed" },
      envTruth: {},
      judgePolicy: "auto",
    });

    expect(judge).toEqual({
      available: false,
      reason: "judge disabled for this run",
    });
    expect(client.startAgentRun).not.toHaveBeenCalled();
  });

  it("parses fenced json even when the judge adds leading commentary", async () => {
    const client = {
      startAgentRun: vi.fn().mockResolvedValue({
        data: {
          finalResponse: [
            "Tool evidence gathered successfully.",
            "```json",
            '{"verdict":"pass","confidence":0.81,"reasons":["deterministic evidence satisfied"],"misroute":false}',
            "```",
          ].join("\n"),
        },
      }),
    };

    const judge = await runLlmJudge({
      client,
      scenario: {
        id: "l4-file-tool-roundtrip",
        layer: "L4",
        routeFamily: "file tool",
        expectedEvidence: ["agent run completes"],
        execution: { kind: "agent_run", useJudge: true },
      },
      artifact: {
        result: "passed",
        observedEvidence: ["turn 1 run run-123", "turn 1 status completed"],
        raw: {
          lane: { providerId: "provider-default" },
          outputText: "Friday",
        },
      },
      envTruth: {
        providerLanes: {
          default: { id: "default-provider-default", providerId: "provider-default", model: "claude-sonnet-4-20250514", backendKind: "http" },
          fallback: { id: "fallback-provider-fallback", providerId: "provider-fallback", model: "gpt-4o-mini", backendKind: "http" },
        },
        enabledProviderLanes: [],
      },
      judgePolicy: "auto",
    });

    expect(judge.available).toBe(true);
    expect(judge.verdict).toBe("pass");
    expect(judge.confidence).toBe(0.81);
    expect(judge.reasons).toEqual(["deterministic evidence satisfied"]);
  });

  it("skips judge execution when the only alternate lane is CLI-only", () => {
    const judgeLane = selectJudgeLane({
      providerLanes: {
        default: { id: "default-provider-default", providerId: "provider-default", model: "gpt-4o-mini", backendKind: "http" },
        fallback: { id: "fallback-provider-cli", providerId: "provider-cli", model: "claude-sonnet-4-20250514", backendKind: "cli" },
      },
      enabledProviderLanes: [],
    }, { providerId: "provider-default", backendKind: "http" });

    expect(judgeLane).toBeNull();
  });

  it("keeps a passed artifact green when the judge is disabled", () => {
    const artifact = finalizeArtifact({
      scenario: {
        id: "l2-health-contract",
        severityOnFailure: "P1",
      },
      artifact: {
        result: "passed",
        observedEvidence: ["HTTP 200 GET /v1/health"],
        raw: {},
      },
      rubric: {
        available: false,
        pass: true,
        confidence: 0,
        reasons: [],
        parsedJson: null,
      },
      judge: {
        available: false,
        reason: "judge disabled for this run",
      },
    });

    expect(artifact.result).toBe("passed");
    expect(artifact.humanReviewRequired).not.toBe(true);
  });
});
