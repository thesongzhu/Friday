import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFridayAgentEventEmitter,
  createFridayAgentMemoryTools,
  createFridayAgentRuntime,
  createFridayAgentWorkflowListTool,
  createFridayAgentWorkflowTool,
  type FridayAgentLlmClient,
  type FridayAgentMessage,
} from "#agent";
import {
  createFridayApiRuntime,
  createFridayHttpServer,
  encodeToken,
  type FridayHttpServer,
} from "#api";
import {
  createFridayMemoryGuardServiceFactory,
  createFridayMemoryService,
} from "#memory";
import { createFridayProviderService } from "#providers";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayWorkflowRuntime,
  createFridayWorkflowTriggerRepository,
  type FridayCompiledWorkflowGraphV2,
  type FridayWorkflowRuntime,
} from "#workflows";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";

const NOW = "2026-05-27T03:00:00.000Z";
const AUTH_TOKEN_TEST_KEY = "dp10-sop-memory-workflow-test-key";
const WORKFLOW_SKILL_ID = "dp10-followup-workflow-skill";

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close();
      if (!addr || typeof addr === "string") {
        reject(new Error("No free port"));
        return;
      }
      resolve(addr.port);
    });
    srv.on("error", reject);
  });
}

function authHeaders(): Record<string, string> {
  const nowSec = Math.floor(Date.parse(NOW) / 1000);
  const token = encodeToken(
    {
      tokenId: "dp10-workflow-token",
      principalType: "user",
      principalId: "dp10-user",
      tenantId: "dp10-tenant",
      userId: "dp10-user",
      role: "admin",
      scopes: [
        "agent.run",
        "hub.admin",
        "memory.read",
        "memory.write",
        "session.read",
        "session.write",
        "workflow.write",
      ],
      iat: nowSec,
      exp: nowSec + 3600,
    },
    AUTH_TOKEN_TEST_KEY,
  );
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function jsonFetch<T>(
  baseUrl: string,
  method: string,
  routePath: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const res = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

function textFromMessages(messages: FridayAgentMessage[]): string {
  return messages
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
    .join("\n");
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function makeSopWorkflowGraph(
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
          label: "Write followup outputs",
          config: {
            skillId: WORKFLOW_SKILL_ID,
            args: {
              routine: "$inputs.routine",
              sourceTask: "$inputs.sourceTask",
              outboxPath: "$inputs.outboxPath",
            },
          },
        },
      ],
      edges: [{ id: "e1", sourceNodeId: "trigger", targetNodeId: "action1" }],
    },
    failurePolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    checksum: "placeholder-checksum",
  };
}

async function createAndPublishWorkflow(
  baseUrl: string,
): Promise<{ workflowId: string; versionId: string; versionNumber: number }> {
  const createRes = await jsonFetch<{
    ok: boolean;
    data: {
      workflow: { id: string };
      version: { id: string; versionNumber: number };
    };
  }>(baseUrl, "POST", "/v1/workflows", {
    slug: "dp10-sop-memory-workflow",
    name: "DP-10 SOP memory workflow",
    description: "Writes customer followup outputs inside an isolated workspace.",
    tags: ["dp10", "sop", "workflow"],
    graph: makeSopWorkflowGraph(),
  });
  expect(createRes.status).toBe(200);
  expect(createRes.json.ok).toBe(true);

  const { workflow, version } = createRes.json.data;
  const publishRes = await jsonFetch<{ ok: boolean }>(
    baseUrl,
    "POST",
    `/v1/workflows/${encodeURIComponent(workflow.id)}/publish`,
    { versionNumber: version.versionNumber },
  );
  expect(publishRes.status).toBe(200);
  expect(publishRes.json.ok).toBe(true);

  return {
    workflowId: workflow.id,
    versionId: version.id,
    versionNumber: version.versionNumber,
  };
}

async function waitForNewestWorkflowRun(
  runtime: FridayWorkflowRuntime,
  workflowId: string,
  previousCount: number,
  timeoutMs = 12_000,
): Promise<string> {
  const terminal = new Set(["completed", "failed", "cancelled"]);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const runs = runtime.execution.listRuns(workflowId, undefined, 20);
    if (runs.length > previousCount) {
      const [newest] = runs;
      if (newest && terminal.has(newest.status)) {
        return newest.id;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Workflow ${workflowId} did not produce a terminal run after count ${String(previousCount)}`);
}

/**
 * Poll until a workflow output file exists and its size is non-zero and stable
 * (unchanged across two consecutive stats), up to a bounded timeout.
 *
 * The probe drives async workflow runs that WRITE output files; a run can be
 * observed terminal a beat before its output file is durably flushed and
 * visible to a subsequent read, producing an ENOENT (or a partial read) under
 * CI load. This guard closes that timing race BEFORE the readback/assert while
 * still failing loudly with a clear message if the file genuinely never lands —
 * it never masks a real non-write and does not touch the content assertions.
 */
async function waitForStableFile(
  filePath: string,
  timeoutMs = 5_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStableSize = -1;
  let lastStatError: unknown;
  while (Date.now() < deadline) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 0 && stat.size === lastStableSize) {
        // Same non-zero size observed across two consecutive stats → stable.
        return;
      }
      lastStableSize = stat.size > 0 ? stat.size : -1;
      lastStatError = undefined;
    } catch (error) {
      lastStableSize = -1;
      lastStatError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const detail = lastStatError instanceof Error ? ` (last stat error: ${lastStatError.message})` : "";
  throw new Error(
    `waitForStableFile timed out after ${String(timeoutMs)}ms waiting for a non-empty, stable file at ${filePath}${detail}`,
  );
}

describe("DP-10 probe — SOP memory triggers workflow execution", () => {
  let db: FridaySqliteLayer | undefined;
  let server: FridayHttpServer | undefined;
  let workspaceDir: string | undefined;

  afterEach(async () => {
    await server?.close();
    db?.close();
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
    server = undefined;
    db = undefined;
    workspaceDir = undefined;
  });

  it("recalls a durable SOP in fresh sessions, starts approved workflow runs, writes fixture outputs, and refuses a destructive near-miss", async () => {
    db = createTestDb();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-dp10-sop-workflow-"));
    const idGenerator = createTestIdGenerator();
    const providerService = createFridayProviderService({
      db,
      idGenerator,
      nowIso: () => NOW,
    });
    const memoryService = createFridayMemoryService({
      db,
      providerService,
      idGenerator,
      nowIso: () => NOW,
    });
    const memoryGuardFactory = createFridayMemoryGuardServiceFactory({
      core: memoryService,
      db,
      nowIso: () => NOW,
      nowMs: () => Date.parse(NOW),
    });

    const workflowInvocations: Array<{
      skillId: string;
      runId: string;
      nodeId: string;
      outputPath: string;
      checksum: string;
    }> = [];

    const workflowRuntime = createFridayWorkflowRuntime({
      allowTestOnlyWorkflowRunExecution: true, // TS-retirement method guard: test-oracle opt-in
      db,
      idGenerator,
      nowIso: () => NOW,
      computeChecksum: sha256,
      resolveSkill: (skillId) => skillId === WORKFLOW_SKILL_ID ? { id: skillId } : null,
      invokeSkill: async (skillId, runId, nodeId, payload) => {
        const outboxPath = String(payload.outboxPath ?? "");
        expect(path.isAbsolute(outboxPath)).toBe(false);
        expect(outboxPath.split(/[\\/]/)).not.toContain("..");

        const absoluteOutputPath = path.join(workspaceDir!, outboxPath);
        const content = [
          "DP10_WORKFLOW_OUTPUT",
          `routine=${String(payload.routine ?? "")}`,
          `sourceTask=${String(payload.sourceTask ?? "")}`,
          `runId=${runId}`,
          `nodeId=${nodeId}`,
        ].join("\n");
        await fs.mkdir(path.dirname(absoluteOutputPath), { recursive: true });
        await fs.writeFile(absoluteOutputPath, `${content}\n`, "utf8");
        const checksum = sha256(content);
        workflowInvocations.push({ skillId, runId, nodeId, outputPath: outboxPath, checksum });
        return { outputPath: outboxPath, checksum };
      },
      triggerRepo: createFridayWorkflowTriggerRepository({ db }),
    });

    let workflowId = "";
    let versionId = "";
    let positiveRunIndex = 0;
    let workflowCallPendingFinal = false;
    const finalPrompts: string[] = [];
    const approvalPrompts: Array<{ toolName: string; reason: string; canonicalAction?: string }> = [];
    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        const prompt = textFromMessages(params.messages);
        const isDestructive = /delete the followup routine outputs/i.test(prompt);

        if (!prompt.includes("SOP-DP10-WORKFLOW-FOLLOWUP")) {
          yield {
            type: "tool_use",
            id: `dp10-workflow-memory-search-${positiveRunIndex}`,
            name: "memory_search",
            input: {
              query: "SOP-DP10-WORKFLOW-FOLLOWUP refund followup workflow routine",
              namespace: "default",
              limit: 3,
            },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 30, outputTokens: 5 };
          return;
        }

        if (isDestructive) {
          finalPrompts.push(prompt);
          yield {
            type: "text_delta",
            text: "DP10_WORKFLOW_REFUSED_DESTRUCTIVE_TRIGGER: SOP-DP10-WORKFLOW-FOLLOWUP was recalled, but deletion requires a separate explicit approval and no workflow was started.",
          };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 35, outputTokens: 12 };
          return;
        }

        if (!prompt.includes(workflowId)) {
          yield {
            type: "tool_use",
            id: `dp10-workflow-list-${positiveRunIndex}`,
            name: "workflow_list",
            input: {
              tag: "dp10",
              publishedOnly: true,
              limit: 5,
            },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 36, outputTokens: 6 };
          return;
        }

        if (!workflowCallPendingFinal) {
          positiveRunIndex += 1;
          workflowCallPendingFinal = true;
          yield {
            type: "tool_use",
            id: `dp10-workflow-run-${positiveRunIndex}`,
            name: "workflow_run",
            input: {
              workflowId,
              versionId,
              input: {
                routine: "refund-followup",
                sourceTask: `dp10-positive-${positiveRunIndex}`,
                outboxPath: `outbox/customer-followups-${positiveRunIndex}.md`,
              },
            },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 40, outputTokens: 8 };
          return;
        }

        workflowCallPendingFinal = false;
        finalPrompts.push(prompt);
        yield {
          type: "text_delta",
          text: `DP10_WORKFLOW_EXECUTED: workflow_run_result_seen for SOP-DP10-WORKFLOW-FOLLOWUP run ${String(positiveRunIndex)}.`,
        };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 40, outputTokens: 14 };
      },
    };

    const agentRuntime = createFridayAgentRuntime({
      allowTestOnlyAgentRunExecution: true,
      db,
      llmClient,
      model: "dp10-deterministic-model",
      providerId: "dp10-deterministic-provider",
      systemPrompt: "You are Friday. Use memory before applying learned SOPs. Start workflows only after approval.",
      tools: [
        ...createFridayAgentMemoryTools({
          memoryService,
          memoryGuardFactory,
        }),
        createFridayAgentWorkflowListTool({
          workflowCrudService: workflowRuntime.crud,
        }),
        createFridayAgentWorkflowTool({
          workflowExecutionService: workflowRuntime.execution,
        }),
      ],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      canonicalMutatingActionGate: true,
      canonicalApprovalSecret: AUTH_TOKEN_TEST_KEY,
      toolApprovalResolver: async (prompt) => {
        approvalPrompts.push({
          toolName: prompt.toolName,
          reason: prompt.reason,
          canonicalAction: prompt.canonicalAction,
        });
        return {
          approved: true,
          decidedByPrincipalId: "dp10-user",
          decidedByPrincipalType: "user",
          approvalSurface: "dp10-probe",
        };
      },
    });

    const runtime = createFridayApiRuntime({
      db,
      idGenerator,
      nowIso: () => NOW,
      providerService,
      memoryService,
      workflowRuntime,
      agentRuntime,
      agentEventEmitter: createFridayAgentEventEmitter(),
      tokenSecret: AUTH_TOKEN_TEST_KEY,
      allowTestOnlyWorkflowCatalogMutationExecution: true,
      allowTestOnlyWorkflowDeployExecution: true,
      allowTestOnlySessionExecution: true,
      allowTestOnlySessionRunExecution: true,
      allowTestOnlySessionMemoryExtractionExecution: true,
      allowTestOnlyTsMemoryWrites: true,
      computeChecksum: sha256,
      resolveSkill: (skillId) => skillId === WORKFLOW_SKILL_ID ? { id: skillId } : null,
      invokeSkill: async () => ({}),
    });

    const port = await findFreePort();
    server = createFridayHttpServer({
      routes: runtime.routes,
      wsGateway: runtime.wsGateway,
      middleware: runtime.middleware,
      port,
      host: "127.0.0.1",
    });
    await server.listen();
    const baseUrl = `http://127.0.0.1:${port}`;

    const workflow = await createAndPublishWorkflow(baseUrl);
    workflowId = workflow.workflowId;
    versionId = workflow.versionId;

    const store = await jsonFetch<{
      ok: boolean;
      data: { item: { id: string; accessCount?: number } };
    }>(baseUrl, "POST", "/v1/memory/store", {
      namespace: "default",
      content: [
        "SOP-DP10-WORKFLOW-FOLLOWUP",
        "Trigger phrases: run the refund followup routine; do the customer followup cleanup; prepare the refund followup pack.",
        "Discovery rule: list published workflows tagged dp10, then run the matching DP-10 SOP memory workflow.",
        "Allowed mutation: workflow may write only outbox/customer-followups-*.md in the isolated workspace.",
        "Approval boundary: deletion, external send, or writes outside workspace require separate explicit approval.",
      ].join("\n"),
      source: "dp10-workflow-probe",
      tags: ["dp10", "sop", "workflow", "trigger"],
      memoryType: "procedure",
      confidence: 0.98,
    });
    expect(store.status).toBe(200);
    expect(store.json.ok).toBe(true);
    expect(store.json.data.item.accessCount ?? 0).toBe(0);

    const directSearch = await jsonFetch<{
      ok: boolean;
      data: { items: Array<{ item: { id: string; content: string } }> };
    }>(baseUrl, "POST", "/v1/memory/search", {
      namespace: "default",
      query: "SOP-DP10-WORKFLOW-FOLLOWUP refund followup workflow",
      limit: 3,
    });
    expect(directSearch.status).toBe(200);
    expect(directSearch.json.data.items.map((result) => result.item.id)).toContain(store.json.data.item.id);

    async function runInFreshSession(task: string): Promise<{
      response: string;
      workflowRunId?: string;
    }> {
      const createSession = await jsonFetch<{
        ok: boolean;
        data: { session: { key: string } };
      }>(baseUrl, "POST", "/v1/sessions", {
        channel: "dp10",
        chatId: `sop-workflow-${crypto.randomUUID()}`,
      });
      expect(createSession.status).toBe(200);
      const sessionKey = createSession.json.data.session.key;

      const reset = await jsonFetch<{ ok: boolean }>(
        baseUrl,
        "POST",
        `/v1/sessions/${encodeURIComponent(sessionKey)}/reset`,
      );
      expect(reset.status).toBe(200);
      expect(reset.json.ok).toBe(true);

      const beforeCount = workflowRuntime.execution.listRuns(workflowId, undefined, 20).length;
      const run = await jsonFetch<{
        ok: boolean;
        data: { run: { status: string; response: string; toolCallCount: number } };
      }>(
        baseUrl,
        "POST",
        `/v1/sessions/${encodeURIComponent(sessionKey)}/run`,
        { task },
      );
      expect(run.status).toBe(200);
      if (run.json.data.run.status !== "completed") {
        console.info("DP10 workflow session run diagnostic", JSON.stringify(run.json.data.run, null, 2));
      }
      expect(run.json.data.run.status).toBe("completed");

      if (/delete the followup routine outputs/i.test(task)) {
        return { response: run.json.data.run.response };
      }

      expect(run.json.data.run.toolCallCount).toBe(3);
      const workflowRunId = await waitForNewestWorkflowRun(workflowRuntime, workflowId, beforeCount);
      return { response: run.json.data.run.response, workflowRunId };
    }

    const runA = await runInFreshSession("run the refund followup routine");
    const runB = await runInFreshSession("do the customer followup cleanup");
    const runC = await runInFreshSession("prepare the refund followup pack with priority escalation");

    for (const [index, workflowRunId] of [runA.workflowRunId, runB.workflowRunId, runC.workflowRunId].entries()) {
      expect(workflowRunId).toBeDefined();
      const run = workflowRuntime.execution.getRun(workflowRunId!);
      expect(run?.status).toBe("completed");
      const evidence = workflowRuntime.evidence.getRunEvidence(workflowRunId!);
      expect(evidence.evidenceStatus).toBe("available");
      expect(evidence.summary.totalEvents).toBeGreaterThan(0);

      const outputPath = path.join(workspaceDir, `outbox/customer-followups-${index + 1}.md`);
      await waitForStableFile(outputPath);
      const content = await fs.readFile(outputPath, "utf8");
      expect(content).toContain("DP10_WORKFLOW_OUTPUT");
      expect(content).toContain(`sourceTask=dp10-positive-${index + 1}`);
    }

    expect(runA.response).toContain("DP10_WORKFLOW_EXECUTED");
    expect(runB.response).toContain("DP10_WORKFLOW_EXECUTED");
    expect(runC.response).toContain("DP10_WORKFLOW_EXECUTED");
    expect(workflowInvocations).toHaveLength(3);
    expect(approvalPrompts).toHaveLength(3);
    expect(approvalPrompts.every((prompt) => prompt.toolName === "workflow_run")).toBe(true);
    expect(approvalPrompts.every((prompt) => prompt.canonicalAction === "agent.tool.workflow_run")).toBe(true);

    const beforeNegativeCount = workflowRuntime.execution.listRuns(workflowId, undefined, 20).length;
    const negative = await runInFreshSession("delete the followup routine outputs");
    const afterNegativeCount = workflowRuntime.execution.listRuns(workflowId, undefined, 20).length;
    expect(negative.response).toContain("DP10_WORKFLOW_REFUSED_DESTRUCTIVE_TRIGGER");
    expect(afterNegativeCount).toBe(beforeNegativeCount);
    expect(workflowInvocations).toHaveLength(3);
    expect(approvalPrompts).toHaveLength(3);

    const fetched = await jsonFetch<{
      ok: boolean;
      data: { item: { id: string; accessCount?: number; lastAccessedAt?: string } };
    }>(baseUrl, "GET", `/v1/memory/items/${encodeURIComponent(store.json.data.item.id)}`);
    expect(fetched.status).toBe(200);
    expect(fetched.json.data.item.accessCount).toBeGreaterThanOrEqual(4);
    expect(fetched.json.data.item.lastAccessedAt).toBeDefined();

    expect(finalPrompts.length).toBeGreaterThanOrEqual(4);
    expect(finalPrompts.every((prompt) => prompt.includes("SOP-DP10-WORKFLOW-FOLLOWUP"))).toBe(true);
    expect(finalPrompts.some((prompt) => prompt.includes(workflowId))).toBe(true);
    expect(finalPrompts.some((prompt) => prompt.includes("DP-10 SOP memory workflow"))).toBe(true);
  });
});
