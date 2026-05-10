import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apiFetch } from "./_helpers/api.js";
import { pollUntil } from "./_helpers/poll.js";
import {
  cleanupFridayDeepProofHubEnv,
  createFridayDeepProofHubEnv,
  createFridayDeepProofHubEnvFromStateDir,
  ensureFridayDeepProofProviders,
  FRIDAY_DEEP_PROOF_GATED,
  FRIDAY_DEEP_PROOF_PROVIDER_LABEL,
  selectFridayDeepProofProviderKind,
  shutdownFridayDeepProofHubEnv,
  type RealHubEnv,
} from "./_helpers/deep-proof-env.js";

const SUBAGENT_FORK_GATED = process.env.FRIDAY_SUBAGENT_FORK_MODE_ENABLED === "true";
// Provider-aware obviously-invalid model fixture. Stays clearly-invalid for
// every provider lane while signalling which lane the run is exercising.
const INVALID_LIVE_MODEL = `${selectFridayDeepProofProviderKind() ?? "no-provider"}-invalid-subagent-live`;

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
  childSessionKey?: string;
  task: string;
  status: string;
  mode: string;
  model?: string;
  forkedFromMessageId?: string;
  inheritedMessageCount?: number;
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

interface SessionMessageEnvelope {
  ok: boolean;
  data: {
    message: {
      id: string;
      role: string;
      contentText: string;
    };
  };
}

interface SessionMessageListEnvelope {
  ok: boolean;
  data: {
    items: Array<{
      id: string;
      role: string;
      contentText: string;
    }>;
  };
}

async function fetchRunAudit(
  env: RealHubEnv,
  runId: string,
): Promise<{ status: number; json: AgentRunAuditEnvelope }> {
  return apiFetch<AgentRunAuditEnvelope>(
    env.baseUrl,
    env.accessToken,
    "GET",
    `/v1/agent/runs/${encodeURIComponent(runId)}/audit`,
  );
}

async function listRunSubagents(
  env: RealHubEnv,
  parentRunId: string,
): Promise<{ status: number; json: ListSubagentsEnvelope }> {
  return apiFetch<ListSubagentsEnvelope>(
    env.baseUrl,
    env.accessToken,
    "GET",
    `/v1/agent/runs/${encodeURIComponent(parentRunId)}/subagents`,
  );
}

function extractToolNames(audit: AgentRunAuditEnvelope): string[] {
  return audit.data.events
    .filter((event) => event.type === "agent.run.tool_start")
    .map((event) => {
      const payload = event.payload as { toolName?: string } | undefined;
      return payload?.toolName;
    })
    .filter((toolName): toolName is string => typeof toolName === "string" && toolName.length > 0);
}

async function listSessionMessages(
  env: RealHubEnv,
  sessionKey: string,
): Promise<{ status: number; json: SessionMessageListEnvelope }> {
  return apiFetch<SessionMessageListEnvelope>(
    env.baseUrl,
    env.accessToken,
    "GET",
    `/v1/sessions/${encodeURIComponent(sessionKey)}/messages?limit=24`,
  );
}

describe.skipIf(!FRIDAY_DEEP_PROOF_GATED)(`Friday Subagent Live (${FRIDAY_DEEP_PROOF_PROVIDER_LABEL})`, () => {
  let env: RealHubEnv;
  let providerId: string;
  let liveModel: string;

  beforeAll(async () => {
    env = await createFridayDeepProofHubEnv();

    const providers = await ensureFridayDeepProofProviders(env, {
      namePrefix: "Subagent Live",
    });

    providerId = providers.codeProviderId;
    liveModel = providers.codeModel;
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
          model: liveModel,
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
        parentRunAudit = await fetchRunAudit(env, runRes.json.data.runId);
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
        async () => listRunSubagents(env, parentRunId),
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

      expect(extractToolNames(parentRunAudit!.json)).toContain("spawn_subagent");
    },
  );

  it(
    "keeps the parent run alive when a waited child fails",
    { timeout: 240_000, retry: 2 },
    async () => {
      const marker = `subagent-fail-${Date.now().toString(36)}`;
      const parentAnswer = `PARENT_RECOVERED_${marker}`;

      const runRes = await apiFetch<StartAgentRunResponse>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        {
          providerId,
          model: liveModel,
          timeoutMs: 120_000,
          task: [
            "You must use spawn_subagent exactly once with wait=true.",
            `Override the child model to "${INVALID_LIVE_MODEL}" so the child fails deterministically.`,
            `The child task should attempt to return "CHILD_SHOULD_FAIL_${marker}" and nothing else.`,
            `When the child fails, do not retry and do not crash. Your final answer must be exactly "${parentAnswer}" and nothing else.`,
          ].join(" "),
        },
        { timeoutMs: 150_000 },
      );

      expect(runRes.status).toBe(200);
      expect(runRes.json.ok).toBe(true);
      expect(runRes.json.data.status).toBe("completed");
      expect(runRes.json.data.response).toContain(parentAnswer);

      const parentRunId = runRes.json.data.runId;
      const parentAudit = await fetchRunAudit(env, parentRunId);
      expect(parentAudit.status).toBe(200);
      expect(parentAudit.json.ok).toBe(true);
      expect(extractToolNames(parentAudit.json)).toContain("spawn_subagent");

      const subagentList = await pollUntil(
        async () => listRunSubagents(env, parentRunId),
        (result) =>
          result.status === 200
          && result.json.ok
          && result.json.data.items.length === 1
          && result.json.data.items[0]?.status === "failed",
        { intervalMs: 500, maxMs: 30_000 },
      );

      const subagent = subagentList.json.data.items[0]!;
      expect(subagent.status).toBe("failed");
      expect(subagent.mode).toBe("fresh");
      expect(subagent.model).toBe(INVALID_LIVE_MODEL);
      expect(subagent.outcome?.status).toBe("failed");
      expect((subagent.outcome?.response ?? "").trim().length).toBeGreaterThan(0);

      const childRun = await apiFetch<AgentRunEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/agent/runs/${encodeURIComponent(subagent.childRunId)}`,
      );
      expect(childRun.status).toBe(200);
      expect(childRun.json.ok).toBe(true);
      expect(childRun.json.data.run.status).toBe("failed");
      expect((childRun.json.data.run.errorMessage ?? childRun.json.data.run.responseText ?? "").trim().length).toBeGreaterThan(0);

      const parentRun = await apiFetch<AgentRunEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/agent/runs/${encodeURIComponent(parentRunId)}`,
      );
      expect(parentRun.status).toBe(200);
      expect(parentRun.json.ok).toBe(true);
      expect(parentRun.json.data.run.status).toBe("completed");
      expect(parentRun.json.data.run.responseText).toContain(parentAnswer);
    },
  );

  it(
    "does not treat a detached handoff snapshot as final and polls terminal child state before replying",
    { timeout: 240_000, retry: 2 },
    async () => {
      const marker = `subagent-detached-${Date.now().toString(36)}`;
      const childAnswer = `DETACHED_RESULT_${marker}`;
      const parentAnswer = `DETACHED_FINAL ${childAnswer}`;

      const runRes = await apiFetch<StartAgentRunResponse>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        {
          providerId,
          model: liveModel,
          timeoutMs: 120_000,
          task: [
            "You must use spawn_subagent exactly once with wait=false.",
            `The child task must return exactly "${childAnswer}" and nothing else.`,
            "The detached handoff snapshot is not the final result.",
            "After the handoff, use get_subagent until the delegated run reaches a terminal completed state. You may call list_subagents once if helpful.",
            `Your final answer must be exactly "${parentAnswer}" and nothing else.`,
            "Do not solve the child task yourself and do not switch to wait=true.",
          ].join(" "),
        },
        { timeoutMs: 150_000 },
      );

      expect(runRes.status).toBe(200);
      expect(runRes.json.ok).toBe(true);
      expect(runRes.json.data.status).toBe("completed");
      expect(runRes.json.data.response).toBe(parentAnswer);
      expect(runRes.json.data.toolCallCount).toBeGreaterThanOrEqual(2);

      const parentRunId = runRes.json.data.runId;
      const parentAudit = await fetchRunAudit(env, parentRunId);
      expect(parentAudit.status).toBe(200);
      expect(parentAudit.json.ok).toBe(true);
      const toolNames = extractToolNames(parentAudit.json);
      expect(toolNames).toContain("spawn_subagent");
      expect(toolNames.some((name) => name === "get_subagent" || name === "list_subagents")).toBe(true);

      const subagentList = await pollUntil(
        async () => listRunSubagents(env, parentRunId),
        (result) =>
          result.status === 200
          && result.json.ok
          && result.json.data.items.length === 1
          && result.json.data.items[0]?.status === "completed",
        { intervalMs: 500, maxMs: 30_000 },
      );

      const subagent = subagentList.json.data.items[0]!;
      expect(subagent.status).toBe("completed");
      expect(subagent.outcome?.status).toBe("completed");
      expect(subagent.outcome?.response).toContain(childAnswer);

      const parentRun = await apiFetch<AgentRunEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/agent/runs/${encodeURIComponent(parentRunId)}`,
      );
      expect(parentRun.status).toBe(200);
      expect(parentRun.json.ok).toBe(true);
      expect(parentRun.json.data.run.status).toBe("completed");
      expect(parentRun.json.data.run.responseText).toBe(parentAnswer);
    },
  );

  it.skipIf(!SUBAGENT_FORK_GATED)(
    "forks parent session context into the child without leaking the secret through task parameters",
    { timeout: 240_000, retry: 2 },
    async () => {
      const marker = `FORK_CONTEXT_${Date.now().toString(36).toUpperCase()}`;
      const rawSessionKey = `subagent-fork-live-${Date.now().toString(36)}`;
      const parentAnswer = `FORK_FINAL ${marker}`;

      const seededMessage = await apiFetch<SessionMessageEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/sessions/${encodeURIComponent(rawSessionKey)}/messages`,
        {
          role: "user",
          content: `For this session only, the exact secret token is ${marker}. If a forked child asks for the secret token later, answer with ${marker} and nothing else.`,
        },
      );
      expect(seededMessage.status).toBe(200);
      expect(seededMessage.json.ok).toBe(true);
      const sessionKey = seededMessage.json.data.message.sessionKey;
      const forkFromMessageId = seededMessage.json.data.message.id;

      const runRes = await apiFetch<StartAgentRunResponse>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        {
          providerId,
          model: liveModel,
          sessionKey,
          timeoutMs: 120_000,
          task: [
            `Use spawn_subagent exactly once with wait=true, mode=fork, inheritMessageCount=1, and forkFromMessageId="${forkFromMessageId}".`,
            "The child task text must be exactly: The exact secret token already appears in the inherited user message at the top of this session. Do not use any tools. Reply with the token only. If unavailable, answer UNKNOWN.",
            "Do not include the secret token literal in the child task text.",
            `Your final answer must be exactly "${parentAnswer}" and nothing else.`,
          ].join(" "),
        },
        { timeoutMs: 150_000 },
      );

      expect(runRes.status).toBe(200);
      expect(runRes.json.ok).toBe(true);
      expect(runRes.json.data.status).toBe("completed");
      expect(runRes.json.data.response).toBe(parentAnswer);

      const parentRunId = runRes.json.data.runId;
      const subagentList = await pollUntil(
        async () => listRunSubagents(env, parentRunId),
        (result) =>
          result.status === 200
          && result.json.ok
          && result.json.data.items.length === 1
          && result.json.data.items[0]?.status === "completed",
        { intervalMs: 500, maxMs: 30_000 },
      );

      const subagent = subagentList.json.data.items[0]!;
      expect(subagent.mode).toBe("fork");
      expect(subagent.inheritedMessageCount).toBe(1);
      expect(subagent.forkedFromMessageId).toBe(forkFromMessageId);
      expect(subagent.task).not.toContain(marker);
      expect(subagent.childSessionKey).toBeTruthy();
      expect(subagent.outcome?.status).toBe("completed");
      expect(subagent.outcome?.response).toContain(marker);
      expect(subagent.outcome?.response).not.toContain("UNKNOWN");

      const childRun = await apiFetch<AgentRunEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/agent/runs/${encodeURIComponent(subagent.childRunId)}`,
      );
      expect(childRun.status).toBe(200);
      expect(childRun.json.ok).toBe(true);
      expect(childRun.json.data.run.status).toBe("completed");
      expect(childRun.json.data.run.task).not.toContain(marker);
      expect(childRun.json.data.run.responseText).toContain(marker);
      expect(childRun.json.data.run.responseText).not.toContain("UNKNOWN");
    },
  );

  it(
    "preserves parent, child, subagent, and session evidence across runtime restart",
    { timeout: 240_000, retry: 1 },
    async () => {
      const marker = `subagent-restart-${Date.now().toString(36)}`;
      const childAnswer = `RESTART_CHILD_${marker}`;
      const parentAnswer = `RESTART_PARENT ${childAnswer}`;

      const runRes = await apiFetch<StartAgentRunResponse>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/agent/runs",
        {
          providerId,
          model: liveModel,
          timeoutMs: 120_000,
          task: [
            "You must use spawn_subagent exactly once with wait=false.",
            `The child task must return exactly "${childAnswer}" and nothing else.`,
            "After the handoff, use get_subagent until the delegated run is terminal and completed.",
            `Your final answer must be exactly "${parentAnswer}" and nothing else.`,
            "Do not solve the child task yourself.",
          ].join(" "),
        },
        { timeoutMs: 150_000 },
      );

      expect(runRes.status).toBe(200);
      expect(runRes.json.ok).toBe(true);
      expect(runRes.json.data.status).toBe("completed");
      expect(runRes.json.data.response).toBe(parentAnswer);

      const parentRunId = runRes.json.data.runId;
      const subagentList = await pollUntil(
        async () => listRunSubagents(env, parentRunId),
        (result) =>
          result.status === 200
          && result.json.ok
          && result.json.data.items.length === 1
          && result.json.data.items[0]?.status === "completed",
        { intervalMs: 500, maxMs: 30_000 },
      );
      const subagent = subagentList.json.data.items[0]!;
      expect(subagent.childSessionKey).toBeTruthy();

      const parentAuditBefore = await fetchRunAudit(env, parentRunId);
      expect(parentAuditBefore.status).toBe(200);
      expect(parentAuditBefore.json.ok).toBe(true);
      const toolNamesBefore = extractToolNames(parentAuditBefore.json);
      expect(toolNamesBefore).toContain("spawn_subagent");
      expect(toolNamesBefore).toContain("get_subagent");

      const childRunBefore = await apiFetch<AgentRunEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/agent/runs/${encodeURIComponent(subagent.childRunId)}`,
      );
      expect(childRunBefore.status).toBe(200);
      expect(childRunBefore.json.ok).toBe(true);
      expect(childRunBefore.json.data.run.status).toBe("completed");
      expect(childRunBefore.json.data.run.responseText).toContain(childAnswer);

      const childSessionBefore = await listSessionMessages(env, subagent.childSessionKey!);
      expect(childSessionBefore.status).toBe(200);
      expect(childSessionBefore.json.ok).toBe(true);
      expect(
        childSessionBefore.json.data.items.some((item) =>
          item.role === "assistant" && item.contentText.includes(childAnswer)),
      ).toBe(true);

      const stateDir = env.stateDir!;
      await shutdownFridayDeepProofHubEnv(env, { removeStateDir: false });
      env = await createFridayDeepProofHubEnvFromStateDir(stateDir);

      const parentRunAfter = await apiFetch<AgentRunEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/agent/runs/${encodeURIComponent(parentRunId)}`,
      );
      expect(parentRunAfter.status).toBe(200);
      expect(parentRunAfter.json.ok).toBe(true);
      expect(parentRunAfter.json.data.run.status).toBe("completed");
      expect(parentRunAfter.json.data.run.responseText).toBe(parentAnswer);

      const parentAuditAfter = await fetchRunAudit(env, parentRunId);
      expect(parentAuditAfter.status).toBe(200);
      expect(parentAuditAfter.json.ok).toBe(true);
      expect(extractToolNames(parentAuditAfter.json)).toEqual(toolNamesBefore);

      const subagentGetAfter = await apiFetch<GetSubagentEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/agent/subagents/${encodeURIComponent(subagent.id)}`,
      );
      expect(subagentGetAfter.status).toBe(200);
      expect(subagentGetAfter.json.ok).toBe(true);
      expect(subagentGetAfter.json.data.subagent.id).toBe(subagent.id);
      expect(subagentGetAfter.json.data.subagent.childRunId).toBe(subagent.childRunId);
      expect(subagentGetAfter.json.data.subagent.childSessionKey).toBe(subagent.childSessionKey);
      expect(subagentGetAfter.json.data.subagent.outcome?.response).toContain(childAnswer);

      const listAfter = await listRunSubagents(env, parentRunId);
      expect(listAfter.status).toBe(200);
      expect(listAfter.json.ok).toBe(true);
      expect(listAfter.json.data.items.map((item) => item.id)).toContain(subagent.id);

      const childRunAfter = await apiFetch<AgentRunEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/agent/runs/${encodeURIComponent(subagent.childRunId)}`,
      );
      expect(childRunAfter.status).toBe(200);
      expect(childRunAfter.json.ok).toBe(true);
      expect(childRunAfter.json.data.run.status).toBe("completed");
      expect(childRunAfter.json.data.run.responseText).toContain(childAnswer);

      const childSessionAfter = await listSessionMessages(env, subagent.childSessionKey!);
      expect(childSessionAfter.status).toBe(200);
      expect(childSessionAfter.json.ok).toBe(true);
      expect(
        childSessionAfter.json.data.items.some((item) =>
          item.role === "assistant" && item.contentText.includes(childAnswer)),
      ).toBe(true);
    },
  );
});
