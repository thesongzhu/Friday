import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LIVE_ANTHROPIC_MODEL, liveAnthropicCredentialMessage } from "../_helpers/live-anthropic.js";
import { apiFetch, ensureAnthropicProviders } from "./_helpers/api.js";
import { pollUntil } from "./_helpers/poll.js";
import {
  cleanupFridayDeepProofHubEnv,
  createFridayDeepProofHubEnv,
  FRIDAY_DEEP_PROOF_ANTHROPIC_API_KEY_ENV_REF,
  FRIDAY_DEEP_PROOF_GATED,
  type RealHubEnv,
} from "./_helpers/deep-proof-env.js";

const ANTHROPIC_BASE_URL = process.env.E2E_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";

interface StartAgentRunResponse {
  ok: boolean;
  data: {
    runId: string;
    status: string;
    response: string;
    toolCallCount: number;
    durationMs: number;
    usageInput: number;
    usageOutput: number;
  };
}

interface AgentRunEnvelope {
  ok: boolean;
  data: {
    run: {
      id: string;
      status: string;
      responseText?: string;
      task: string;
      errorMessage?: string;
    };
  };
}

interface AgentRunAuditEnvelope {
  ok: boolean;
  data: {
    runId: string;
    events: Array<{
      seq: number;
      type: string;
      timestamp: string;
      payload?: unknown;
    }>;
  };
}

interface SubagentRecord {
  id: string;
  parentRunId: string;
  childRunId: string;
  task: string;
  status: string;
  mode: string;
  outcome?: {
    status: string;
    response: string;
    toolCallCount: number;
  };
}

interface ListSubagentsEnvelope {
  ok: boolean;
  data: {
    items: SubagentRecord[];
  };
}

interface GetSubagentEnvelope {
  ok: boolean;
  data: {
    subagent: SubagentRecord;
  };
}

describe.skipIf(!FRIDAY_DEEP_PROOF_GATED)("Friday Subagent Live (Anthropic API key)", () => {
  let env: RealHubEnv;
  let providerId: string;

  beforeAll(async () => {
    env = await createFridayDeepProofHubEnv();

    const providers = await ensureAnthropicProviders(
      env.baseUrl,
      env.accessToken,
      ANTHROPIC_BASE_URL,
      LIVE_ANTHROPIC_MODEL,
      LIVE_ANTHROPIC_MODEL,
      FRIDAY_DEEP_PROOF_ANTHROPIC_API_KEY_ENV_REF ?? (() => { throw new Error(liveAnthropicCredentialMessage()); })(),
      { namePrefix: "Subagent Live" },
    );

    providerId = providers.codeProviderId;
  }, 60_000);

  afterAll(async () => {
    if (env) {
      await cleanupFridayDeepProofHubEnv(env);
    }
  }, 30_000);

  it(
    "delegates a real child task and exposes consistent parent/subagent/child-run evidence",
    { timeout: 240_000, retry: 2 },
    async () => {
      const marker = `subagent-live-${Date.now().toString(36)}`;
      const childAnswer = `SUBAGENT_RESULT_${marker}`;
      const parentAnswer = `FINAL ${childAnswer}`;

      const runRes = await apiFetch<StartAgentRunResponse>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        {
          providerId,
          model: LIVE_ANTHROPIC_MODEL,
          timeoutMs: 120_000,
          task: [
            "You must use spawn_subagent exactly once with wait=true because your final answer depends on the child result in this same run.",
            `The child task must return exactly "${childAnswer}" and nothing else.`,
            "Do not busy-poll detached status in this same run.",
            `Your final answer must be exactly "${parentAnswer}" and nothing else.`,
            "Do not solve the child task yourself.",
          ].join(" "),
        },
        { timeoutMs: 150_000 },
      );

      let parentRunAudit: { status: number; json: AgentRunAuditEnvelope } | null = null;
      if (runRes.json.ok && typeof runRes.json.data?.runId === "string") {
        parentRunAudit = await apiFetch<AgentRunAuditEnvelope>(
          env.baseUrl,
          env.accessToken,
          "GET",
          `/v1/agent/runs/${encodeURIComponent(runRes.json.data.runId)}/audit`,
        );
      }

      expect(runRes.status).toBe(200);
      expect(runRes.json.ok).toBe(true);
      expect(
        runRes.json.data.status,
        JSON.stringify(
          {
            run: runRes.json,
            audit: parentRunAudit?.json,
          },
          null,
          2,
        ),
      ).toBe("completed");
      expect(runRes.json.data.response).toContain(childAnswer);
      expect(runRes.json.data.response).toContain("FINAL");
      expect(runRes.json.data.toolCallCount).toBeGreaterThan(0);

      const parentRunId = runRes.json.data.runId;

      const subagentList = await pollUntil(
        async () => apiFetch<ListSubagentsEnvelope>(
          env.baseUrl,
          env.accessToken,
          "GET",
          `/v1/agent/runs/${encodeURIComponent(parentRunId)}/subagents`,
        ),
        (result) =>
          result.status === 200
          && result.json.ok
          && result.json.data.items.length === 1
          && result.json.data.items[0]?.status === "completed",
        { intervalMs: 500, maxMs: 30_000 },
      );

      const subagent = subagentList.json.data.items[0]!;
      expect(subagent.parentRunId).toBe(parentRunId);
      expect(subagent.mode).toBeTruthy();
      expect(subagent.task).toContain(childAnswer);
      expect(subagent.outcome?.status).toBe("completed");
      expect(subagent.outcome?.response).toContain(childAnswer);

      const subagentGet = await apiFetch<GetSubagentEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/agent/subagents/${encodeURIComponent(subagent.id)}`,
      );
      expect(subagentGet.status).toBe(200);
      expect(subagentGet.json.ok).toBe(true);
      expect(subagentGet.json.data.subagent.id).toBe(subagent.id);
      expect(subagentGet.json.data.subagent.childRunId).toBe(subagent.childRunId);
      expect(subagentGet.json.data.subagent.outcome?.response).toContain(childAnswer);

      const childRun = await apiFetch<AgentRunEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/agent/runs/${encodeURIComponent(subagent.childRunId)}`,
      );
      expect(childRun.status).toBe(200);
      expect(childRun.json.ok).toBe(true);
      expect(childRun.json.data.run.status).toBe("completed");
      expect(childRun.json.data.run.responseText).toContain(childAnswer);
      expect(childRun.json.data.run.task).toContain(childAnswer);

      const parentRun = await apiFetch<AgentRunEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/agent/runs/${encodeURIComponent(parentRunId)}`,
      );
      expect(parentRun.status).toBe(200);
      expect(parentRun.json.ok).toBe(true);
      expect(parentRun.json.data.run.status).toBe("completed");
      expect(parentRun.json.data.run.responseText).toContain(childAnswer);
      expect(parentRun.json.data.run.responseText).toContain(parentAnswer);
    },
  );
});
