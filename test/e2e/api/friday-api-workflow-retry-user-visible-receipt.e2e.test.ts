import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FridayCompiledWorkflowGraphV2 } from "#workflows";
import {
  authHeaders,
  createFridayApiTestEnv,
  loginTestUser,
  type FridayApiTestEnv,
} from "./_helpers/friday-api-test-server.helper.js";

function makeRetryReceiptGraph(
  workflowId = "wf-placeholder",
  versionId = "wv-placeholder",
): FridayCompiledWorkflowGraphV2 {
  return {
    schemaVersion: "2.0",
    workflowId,
    workflowVersionId: versionId,
    sourceSpecSchemaVersion: "1.0",
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", label: "Trigger", config: {} },
        {
          id: "action1",
          type: "action",
          label: "Recoverable operator action",
          config: { skillId: "retry-receipt-skill" },
        },
      ],
      edges: [{ id: "e1", sourceNodeId: "trigger", targetNodeId: "action1" }],
    },
    failurePolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    checksum: "retry-receipt-placeholder",
  };
}

async function createAndPublishWorkflow(
  baseUrl: string,
  token: string,
): Promise<{ workflowId: string; versionId: string }> {
  const slug = `retry-receipt-${Date.now()}`;
  const createRes = await fetch(`${baseUrl}/v1/workflows`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      slug,
      name: "Retry Receipt Proof",
      graph: makeRetryReceiptGraph(),
    }),
  });
  expect(createRes.status).toBe(200);
  const createJson = (await createRes.json()) as {
    data: {
      workflow: { id: string };
      version: { id: string; versionNumber: number };
    };
  };

  const publishRes = await fetch(`${baseUrl}/v1/workflows/${createJson.data.workflow.id}/publish`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ versionNumber: createJson.data.version.versionNumber }),
  });
  expect(publishRes.status).toBe(200);

  return {
    workflowId: createJson.data.workflow.id,
    versionId: createJson.data.version.id,
  };
}

async function waitForRunStatus(
  baseUrl: string,
  token: string,
  runId: string,
  expected: "failed" | "completed",
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/v1/workflow-runs/${runId}`, {
      headers: authHeaders(token),
    });
    if (res.ok) {
      const json = (await res.json()) as { data: { run: { status: string } } };
      if (json.data.run.status === expected) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Run ${runId} did not reach ${expected}`);
}

describe("API - workflow retry user-visible receipt", () => {
  let env: FridayApiTestEnv;
  let token: string;
  let originalPipelineEnable: string | undefined;
  let originalPipelineMode: string | undefined;
  let invocationCount = 0;

  beforeAll(async () => {
    originalPipelineEnable = process.env.FRIDAY_PIPELINE_ENABLE;
    originalPipelineMode = process.env.FRIDAY_PIPELINE_MODE;
    process.env.FRIDAY_PIPELINE_ENABLE = "true";
    process.env.FRIDAY_PIPELINE_MODE = "enforce";

    env = await createFridayApiTestEnv({
      resolveSkill: (skillId) => skillId === "retry-receipt-skill" ? { id: skillId } : null,
      invokeSkill: async (_skillId, runId, nodeId, payload) => {
        invocationCount += 1;
        if (invocationCount === 1) {
          throw new Error("invalid input: deterministic retry receipt first attempt");
        }
        return {
          output: {
            recovered: true,
            runId,
            nodeId,
            attempt: invocationCount,
            checksum: createHash("sha256")
              .update(JSON.stringify(payload))
              .digest("hex"),
          },
        };
      },
    });
    token = (await loginTestUser(env.baseUrl)).accessToken;
  });

  afterAll(async () => {
    await env.close();
    if (originalPipelineEnable === undefined) {
      delete process.env.FRIDAY_PIPELINE_ENABLE;
    } else {
      process.env.FRIDAY_PIPELINE_ENABLE = originalPipelineEnable;
    }
    if (originalPipelineMode === undefined) {
      delete process.env.FRIDAY_PIPELINE_MODE;
    } else {
      process.env.FRIDAY_PIPELINE_MODE = originalPipelineMode;
    }
  });

  it("shows failed node retry receipt, final recovery, evidence, and unbound retry denial", async () => {
    const { workflowId, versionId } = await createAndPublishWorkflow(env.baseUrl, token);

    const startRes = await fetch(`${env.baseUrl}/v1/workflow-runs`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        workflowId,
        workflowVersionId: versionId,
        triggerType: "manual",
        triggerPayload: { operatorVisible: true },
        proofRequired: true,
      }),
    });
    expect(startRes.status).toBe(200);
    const startJson = (await startRes.json()) as { data: { run: { id: string } } };
    const runId = startJson.data.run.id;

    await waitForRunStatus(env.baseUrl, token, runId, "failed");

    const failedNodesRes = await fetch(`${env.baseUrl}/v1/workflow-runs/${runId}/nodes`, {
      headers: authHeaders(token),
    });
    expect(failedNodesRes.status).toBe(200);
    const failedNodesJson = (await failedNodesRes.json()) as {
      data: { items: Array<{ nodeId: string; status: string; attempt: number }> };
    };
    expect(failedNodesJson.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: "action1", status: "failed", attempt: 1 }),
      ]),
    );

    const deniedRetryRes = await fetch(`${env.baseUrl}/v1/workflow-runs/${runId}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(deniedRetryRes.status).toBe(401);
    const deniedRetryJson = (await deniedRetryRes.json()) as { error: { code: string } };
    expect(deniedRetryJson.error.code).toBe("OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED");

    const retryRes = await fetch(`${env.baseUrl}/v1/workflow-runs/${runId}/retry`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({}),
    });
    expect(retryRes.status).toBe(200);
    const retryJson = (await retryRes.json()) as {
      data: { run: { id: string; status: string }; retriedNodes: string[] };
    };
    expect(retryJson.data.run.id).toBe(runId);
    expect(retryJson.data.retriedNodes).toEqual(["action1"]);

    await waitForRunStatus(env.baseUrl, token, runId, "completed");

    const recoveredNodesRes = await fetch(`${env.baseUrl}/v1/workflow-runs/${runId}/nodes`, {
      headers: authHeaders(token),
    });
    expect(recoveredNodesRes.status).toBe(200);
    const recoveredNodesJson = (await recoveredNodesRes.json()) as {
      data: { items: Array<{ nodeId: string; status: string; attempt: number; output?: unknown }> };
    };
    expect(recoveredNodesJson.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: "action1", status: "failed", attempt: 1 }),
        expect.objectContaining({ nodeId: "action1", status: "completed", attempt: 2 }),
      ]),
    );

    const evidenceRes = await fetch(`${env.baseUrl}/v1/workflow-runs/${runId}/evidence?modules=retry`, {
      headers: authHeaders(token),
    });
    expect(evidenceRes.status).toBe(200);
    const evidenceJson = (await evidenceRes.json()) as {
      data: {
        summary: { retryTraceCount: number };
        retry: { traces: Array<{ nodeId: string; attempt: number; decision: { shouldRetry: boolean } }> };
        correlation: { items: Array<{ nodeId?: string; retryTraceCount: number }> };
      };
    };
    expect(evidenceJson.data.summary.retryTraceCount).toBeGreaterThan(0);
    expect(evidenceJson.data.retry.traces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: "action1",
          attempt: 1,
          decision: expect.objectContaining({ shouldRetry: false }),
        }),
      ]),
    );
    expect(
      evidenceJson.data.correlation.items.some(
        (item) => item.nodeId === "action1" && item.retryTraceCount > 0,
      ),
    ).toBe(true);

    const exportRes = await fetch(`${env.baseUrl}/v1/workflow-runs/${runId}/evidence/exports`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ modules: ["retry"], nodeId: "action1" }),
    });
    expect(exportRes.status).toBe(200);
    const exportJson = (await exportRes.json()) as {
      data: { export: { persisted: boolean; checksum: string }; evidence: { summary: { retryTraceCount: number } } };
    };
    expect(exportJson.data.export.persisted).toBe(true);
    expect(exportJson.data.export.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(exportJson.data.evidence.summary.retryTraceCount).toBeGreaterThan(0);
  });
});
