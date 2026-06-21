import { describe, expect, it } from "vitest";

import {
  buildRunOutcomeLearningDecisionEnvelope,
  parseRunOutcomeLearningDecisionResult,
} from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";

describe("buildRunOutcomeLearningDecisionEnvelope", () => {
  it("emits the exact nested RunOutcomeLearningDecisionRequest wire shape", () => {
    const env = buildRunOutcomeLearningDecisionEnvelope({
      candidateId: "a1:run-1:preference",
      decision: "confirm",
      reason: "owner confirmed",
    });
    expect(env.msg_id).toBe("run-outcome-learning-decision-a1:run-1:preference");
    expect(env.correlation_id).toBe("run-outcome-learning-decision-a1:run-1:preference");
    expect(env.message).toEqual({
      kind: "RunOutcomeLearningDecisionRequest",
      request: {
        candidate_id: "a1:run-1:preference",
        decision: "confirm",
        reason: "owner confirmed",
      },
    });
    const message = env.message as Record<string, unknown>;
    expect(Object.keys(message).sort()).toEqual(["kind", "request"]);
  });

  it("omits reason when absent and carries reject verbatim", () => {
    const message = buildRunOutcomeLearningDecisionEnvelope({
      candidateId: "a1:run-1:world_model",
      decision: "reject",
    }).message as Record<string, unknown>;
    expect(message).toEqual({
      kind: "RunOutcomeLearningDecisionRequest",
      request: {
        candidate_id: "a1:run-1:world_model",
        decision: "reject",
      },
    });
  });
});

describe("parseRunOutcomeLearningDecisionResult", () => {
  it("unwraps refs-only confirmed result", () => {
    expect(
      parseRunOutcomeLearningDecisionResult({
        kind: "RunOutcomeLearningDecisionResult",
        result: {
          candidate_id: "a1:run-1:preference",
          run_id: "run-1",
          kind: "preference",
          state: "confirmed",
          status: "confirmed",
        },
      }),
    ).toEqual({
      truthLabel: "rust_wired",
      candidateId: "a1:run-1:preference",
      runId: "run-1",
      kind: "preference",
      state: "confirmed",
      status: "confirmed",
    });
  });

  it("surfaces blocked blocker and fails closed on missing required refs", () => {
    expect(
      parseRunOutcomeLearningDecisionResult({
        result: {
          candidate_id: "a1:run-1:preference",
          state: "pending",
          status: "blocked",
          blocker: "owner_scope_mismatch",
        },
      }),
    ).toEqual({
      truthLabel: "rust_wired",
      candidateId: "a1:run-1:preference",
      state: "pending",
      status: "blocked",
      blocker: "owner_scope_mismatch",
    });

    expect(parseRunOutcomeLearningDecisionResult({ kind: "RunOutcomeLearningDecisionResult" })).toBeUndefined();
    expect(
      parseRunOutcomeLearningDecisionResult({
        result: { state: "confirmed", status: "confirmed" },
      }),
    ).toBeUndefined();
  });
});
