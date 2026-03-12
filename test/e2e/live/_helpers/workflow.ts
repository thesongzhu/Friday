/**
 * Workflow helpers for real-scenario E2E tests.
 */

import { apiFetch } from "./api.js";
import { pollUntil } from "./poll.js";

// ─── Types ───

export interface WorkflowGraph {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    config: Record<string, unknown>;
  }>;
  edges: Array<{
    id: string;
    sourceNodeId: string;
    targetNodeId: string;
    condition?: string;
  }>;
}

export interface WorkflowRunResult {
  run: {
    id: string;
    status: string;
    nodeResults?: Record<string, { status: string; output?: unknown }>;
  };
}

// ─── Create, Publish, and Run Workflow ───

export async function createPublishRunWorkflow(
  baseUrl: string,
  token: string,
  opts: {
    slug: string;
    name: string;
    graph: WorkflowGraph;
    triggerPayload?: Record<string, unknown>;
    pollMaxMs?: number;
  },
): Promise<WorkflowRunResult> {
  // 1. Create workflow
  const createRes = await apiFetch<{
    ok: boolean;
    data: { workflow: { id: string } };
  }>(baseUrl, token, "POST", "/v1/workflows", {
    slug: opts.slug,
    name: opts.name,
    tags: ["e2e-real"],
    graph: opts.graph,
  });
  if (createRes.status !== 200 || !createRes.json.ok) {
    throw new Error(`Create workflow failed: ${JSON.stringify(createRes.json)}`);
  }
  const workflowId = createRes.json.data.workflow.id;

  // 2. Publish
  const publishRes = await apiFetch<{ ok: boolean }>(
    baseUrl,
    token,
    "POST",
    `/v1/workflows/${workflowId}/publish`,
    { versionNumber: 1 },
  );
  if (publishRes.status !== 200 || !publishRes.json.ok) {
    throw new Error(`Publish workflow failed: ${JSON.stringify(publishRes.json)}`);
  }

  // 3. Trigger run
  const runRes = await apiFetch<{
    ok: boolean;
    data: { run: { id: string; status: string } };
  }>(baseUrl, token, "POST", "/v1/workflow-runs", {
    workflowId,
    triggerType: "manual",
    triggerPayload: opts.triggerPayload ?? {},
  });
  if (runRes.status !== 200 || !runRes.json.ok) {
    throw new Error(`Trigger workflow run failed: ${JSON.stringify(runRes.json)}`);
  }
  const runId = runRes.json.data.run.id;

  // 4. Poll until terminal
  const result = await pollRunTerminal(baseUrl, token, runId, opts.pollMaxMs);
  return result;
}

/**
 * Poll a workflow run until it reaches a terminal status.
 */
export async function pollRunTerminal(
  baseUrl: string,
  token: string,
  runId: string,
  maxMs: number = 30_000,
): Promise<WorkflowRunResult> {
  const settled = await pollUntil(
    async () =>
      apiFetch<{
        ok: boolean;
        data?: WorkflowRunResult;
        error?: { code?: string; message?: string };
      }>(
        baseUrl,
        token,
        "GET",
        `/v1/workflow-runs/${runId}`,
        undefined,
        { timeoutMs: 20_000 },
      ),
    (res) => {
      if (res.status !== 200 || !res.json.ok || res.json.data?.run == null) {
        return false;
      }
      const status = res.json.data.run.status;
      return status === "completed" || status === "failed" || status === "cancelled";
    },
    { maxMs, intervalMs: 1000 },
  );

  if (settled.status !== 200 || !settled.json.ok || settled.json.data?.run == null) {
    throw new Error(
      `Workflow run polling failed for ${runId}: ${JSON.stringify(settled.json)}`,
    );
  }

  return settled.json.data;
}

/**
 * Run an AI-node "ping" workflow: a manual trigger → AI node → data collector.
 * Returns the AI node output.
 */
export async function runAiPing(
  baseUrl: string,
  token: string,
  opts: {
    prompt: string;
    model?: string;
    slug?: string;
    timeoutMs?: number;
  },
): Promise<{ aiOutput: unknown; runStatus: string }> {
  const slug = opts.slug ?? `ai-ping-${Date.now()}`;
  const graph: WorkflowGraph = {
    nodes: [
      {
        id: "trigger1",
        type: "trigger",
        label: "Manual Trigger",
        config: { triggerType: "manual" },
      },
      {
        id: "ai1",
        type: "ai",
        label: "AI Node",
        config: {
          prompt: opts.prompt,
          ...(opts.model ? { model: opts.model } : {}),
        },
      },
      {
        id: "data1",
        type: "data",
        label: "Collect",
        config: { mapping: { aiResponse: "$steps.ai1.output" } },
      },
    ],
    edges: [
      { id: "e1", sourceNodeId: "trigger1", targetNodeId: "ai1" },
      { id: "e2", sourceNodeId: "ai1", targetNodeId: "data1" },
    ],
  };

  const result = await createPublishRunWorkflow(baseUrl, token, {
    slug,
    name: `AI Ping ${slug}`,
    graph,
    pollMaxMs: opts.timeoutMs ?? 60_000,
  });

  // Get node results
  const nodesRes = await apiFetch<{
    ok: boolean;
    data: {
      items: Array<{ nodeId: string; status: string; output: unknown }>;
    };
  }>(baseUrl, token, "GET", `/v1/workflow-runs/${result.run.id}/nodes`, undefined, {
    timeoutMs: 20_000,
  });
  if (nodesRes.status !== 200 || !nodesRes.json.ok) {
    throw new Error(`Workflow run nodes fetch failed: ${JSON.stringify(nodesRes.json)}`);
  }

  const aiNode = nodesRes.json.data?.items?.find((n) => n.nodeId === "ai1");
  return {
    aiOutput: aiNode?.output ?? null,
    runStatus: result.run.status,
  };
}
