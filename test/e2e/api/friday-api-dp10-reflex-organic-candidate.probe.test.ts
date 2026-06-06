import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFridayAgentEventEmitter,
  createFridayAgentMemoryTools,
  createFridayAgentRunEventRepository,
  createFridayAgentRuntime,
  createFridayAgentWorkflowListTool,
  createFridayAgentWorkflowTool,
  type FridayAgentLlmClient,
  type FridayAgentMessage,
  type FridayContextEngine,
} from "#agent";
import {
  createFridayApiRuntime,
  createFridayHttpServer,
  encodeToken,
  type FridayHttpServer,
} from "#api";
import {
  createFridayEpisodeExtractor,
  createFridayMemoryGuardServiceFactory,
  createFridayMemoryService,
  createFridayPatternExtractor,
} from "#memory";
import { createFridayProviderService } from "#providers";
import {
  createFridayReflexCandidateRepository,
  createFridayReflexOnboardingRepository,
  createFridayReflexService,
} from "../../../src/reflex/index.js";
import type { FridaySqliteLayer } from "#state";
import { createFridayUixUserPreferenceRepository } from "../../../src/uix/persistence/friday-uix-user-preference-repository.js";
import {
  createFridayWorkflowRuntime,
  createFridayWorkflowTriggerRepository,
  type FridayCompiledWorkflowGraphV2,
} from "#workflows";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";

const NOW = "2026-05-27T03:30:00.000Z";
const AUTH_TOKEN_TEST_KEY = "dp10-reflex-organic-test-key";
const USER_ID = "dp10-user";
const TENANT_ID = "dp10-tenant";
const GENERATED_WORKFLOW_SKILL_ID = "dp10-approved-generated-workflow-skill";

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
      tokenId: "dp10-reflex-token",
      principalType: "user",
      principalId: USER_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
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

function makeApprovedGeneratedWorkflowGraph(
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
          label: "Write approved generated followup pack",
          config: {
            skillId: GENERATED_WORKFLOW_SKILL_ID,
            args: {
              outboxPath: "$inputs.outboxPath",
              triggerPhrase: "$inputs.triggerPhrase",
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

async function waitForNewestWorkflowRun(
  workflowRuntime: ReturnType<typeof createFridayWorkflowRuntime>,
  workflowId: string,
  previousCount: number,
  timeoutMs = 12_000,
): Promise<string> {
  const terminal = new Set(["completed", "failed", "cancelled"]);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const runs = workflowRuntime.execution.listRuns(workflowId, undefined, 20);
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

describe("DP-10 probe — repeated sessions.run tasks create Reflex candidates but do not auto-enable automation", () => {
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

  it("turns repeated successful tool runs into review-gated recipe/workflow candidates through afterTurn", async () => {
    db = createTestDb();
    db.withWriteTransaction((writer) => {
      writer.prepare(
        `INSERT OR IGNORE INTO users (id, display_name, role, is_local_only, created_at, updated_at)
         VALUES (?, ?, 'admin', 1, ?, ?)`,
      ).run(USER_ID, "DP10 User", NOW, NOW);
    });

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

    const workflowGenerator = {
      startSession: vi.fn(async () => ({
        mode: "new",
        session: { sessionId: `dp10-workflow-generator-${String(workflowGenerator.startSession.mock.calls.length + 1)}` },
      })),
      submitTurn: vi.fn(),
      getSession: vi.fn(),
      generateDraft: vi.fn(async (sessionId: string) => ({
        spec: {
          workflowId: `draft-${sessionId}`,
          name: "DP-10 repeated refund followup candidate",
        },
        validation: { ok: true },
      })),
      getQaVerdict: vi.fn(async () => ({ status: "passed", source: "dp10-deterministic-generator" })),
      getHarnessSummary: vi.fn(async () => ({ status: "passed", source: "dp10-deterministic-generator" })),
      approveAndSave: vi.fn(async () => {
        throw new Error("approveAndSave must not run during organic candidate discovery.");
      }),
      cancelSession: vi.fn(),
    };

    const reflexService = createFridayReflexService({
      db,
      candidateRepo: createFridayReflexCandidateRepository(),
      onboardingRepo: createFridayReflexOnboardingRepository(),
      preferenceRepo: createFridayUixUserPreferenceRepository(),
      memoryService,
      workflowGenerator: workflowGenerator as never,
      idGenerator,
      nowIso: () => NOW,
    });

    const runEventRepository = createFridayAgentRunEventRepository();
    const episodeExtractor = createFridayEpisodeExtractor({
      db,
      idGenerator,
      nowIso: () => NOW,
    });
    const patternExtractor = createFridayPatternExtractor({
      db,
      idGenerator,
      nowIso: () => NOW,
    });
    const contextEngine: FridayContextEngine = {
      async afterTurn(input) {
        const episode = await episodeExtractor.extractFromRun(input.runId, input.userId ?? USER_ID);
        if (episode) {
          await patternExtractor.extractPatterns(episode.userId, 50);
        }
        const toolEndEvents = db!.withReadConnection((reader) =>
          runEventRepository.list(reader, input.runId)
            .filter((event) => event.eventName === "agent.run.tool_end"));
        const toolSequence = toolEndEvents
          .map((event) => typeof event.payload.toolName === "string" ? event.payload.toolName : undefined)
          .filter((toolName): toolName is string => Boolean(toolName));
        await reflexService.processRunCompletion({
          userId: input.userId ?? USER_ID,
          runId: input.runId,
          sessionKey: input.sessionKey,
          task: input.task,
          outcome: input.status === "completed" ? "success" : input.status === "failed" ? "failure" : "unknown",
          toolSequence,
        });
      },
    };

    let llmStep = 0;
    const finalPrompts: string[] = [];
    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        const prompt = textFromMessages(params.messages);
        if (llmStep === 0) {
          llmStep = 1;
          yield {
            type: "tool_use",
            id: `dp10-c2-search-${idGenerator()}`,
            name: "memory_search",
            input: {
              query: "weekly refund followup reusable path",
              namespace: "agent",
              limit: 3,
            },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 20, outputTokens: 5 };
          return;
        }
        if (llmStep === 1) {
          llmStep = 2;
          yield {
            type: "tool_use",
            id: `dp10-c2-store-${idGenerator()}`,
            name: "memory_store",
            input: {
              content: "DP10_C2_REUSABLE_STEP: weekly refund followup pack uses memory_search -> memory_store -> memory_search.",
              namespace: "agent",
              tags: ["dp10-c2", "repeated-success"],
            },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 25, outputTokens: 8 };
          return;
        }
        if (llmStep === 2) {
          llmStep = 3;
          yield {
            type: "tool_use",
            id: `dp10-c2-confirm-${idGenerator()}`,
            name: "memory_search",
            input: {
              query: "DP10_C2_REUSABLE_STEP weekly refund followup",
              namespace: "agent",
              limit: 3,
            },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 25, outputTokens: 8 };
          return;
        }
        llmStep = 0;
        finalPrompts.push(prompt);
        yield {
          type: "text_delta",
          text: "DP10_C2_RUN_COMPLETED: repeated refund followup path completed; any reusable automation must stay review-gated.",
        };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 30, outputTokens: 12 };
      },
    };

    const eventEmitter = createFridayAgentEventEmitter();
    const agentRuntime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "dp10-c2-deterministic-model",
      providerId: "dp10-c2-deterministic-provider",
      systemPrompt: "You are Friday. Complete the task using tools; reusable automation must remain review-gated.",
      tools: createFridayAgentMemoryTools({
        memoryService,
        memoryGuardFactory,
      }),
      eventEmitter,
      runEventRepository,
      contextEngine,
      idGenerator,
      nowIso: () => NOW,
    });

    const workflowRuntime = createFridayWorkflowRuntime({
      db,
      idGenerator,
      nowIso: () => NOW,
      computeChecksum: sha256,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
      triggerRepo: createFridayWorkflowTriggerRepository({ db }),
    });

    const runtime = createFridayApiRuntime({
      db,
      idGenerator,
      nowIso: () => NOW,
      providerService,
      memoryService,
      workflowRuntime,
      agentRuntime,
      agentEventEmitter: eventEmitter,
      reflexService,
      tokenSecret: AUTH_TOKEN_TEST_KEY,
      computeChecksum: sha256,
      allowTestOnlySessionExecution: true,
      allowTestOnlySessionRunExecution: true,
      allowTestOnlySessionMemoryExtractionExecution: true,
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

    async function runRepeatedTask(chatId: string): Promise<void> {
      const createSession = await jsonFetch<{
        ok: boolean;
        data: { session: { key: string } };
      }>(baseUrl, "POST", "/v1/sessions", {
        channel: "dp10",
        chatId,
      });
      expect(createSession.status).toBe(200);
      const sessionKey = createSession.json.data.session.key;

      const run = await jsonFetch<{
        ok: boolean;
        data: { run: { status: string; response: string; toolCallCount: number } };
      }>(
        baseUrl,
        "POST",
        `/v1/sessions/${encodeURIComponent(sessionKey)}/run`,
        { task: "prepare the weekly refund followup pack" },
      );
      expect(run.status).toBe(200);
      expect(run.json.data.run.status).toBe("completed");
      expect(run.json.data.run.response).toContain("DP10_C2_RUN_COMPLETED");
      expect(run.json.data.run.toolCallCount).toBe(3);
    }

    await runRepeatedTask("organic-candidate-a");

    const recipesAfterFirstRun = reflexService.listCandidates({ userId: USER_ID, kind: "recipe" });
    expect(recipesAfterFirstRun).toHaveLength(1);
    expect(reflexService.listCandidates({ userId: USER_ID, kind: "workflow" })).toHaveLength(0);

    await runRepeatedTask("organic-candidate-b");

    const recipes = reflexService.listCandidates({ userId: USER_ID, kind: "recipe" });
    const workflows = reflexService.listCandidates({ userId: USER_ID, kind: "workflow" });
    expect(recipes.length).toBeGreaterThanOrEqual(2);
    expect(workflows).toHaveLength(1);
    expect(workflows[0]).toMatchObject({
      status: "ready_for_review",
      origin: "post_run",
      title: "Draft workflow: prepare the weekly refund followup pack",
      riskTier: 3,
    });
    expect(workflows[0]?.payload.approvalBoundary).toBe("draft_only_until_user_approval");
    expect(workflows[0]?.evidence.priorRecipeCandidate).toBe(true);
    expect(workflows[0]?.evidence.generatorSessionId).toBeTruthy();
    expect(workflows[0]?.evidence.draftWorkflowId).toBeTruthy();
    expect(workflows[0]?.evidence.testCompletedAt).toBeTruthy();
    expect(workflowGenerator.startSession).toHaveBeenCalledTimes(1);
    expect(workflowGenerator.generateDraft).toHaveBeenCalledTimes(1);
    expect(workflowGenerator.approveAndSave).not.toHaveBeenCalled();

    const episodes = db.withReadConnection((reader) =>
      reader.prepare("SELECT task_intent, outcome, tool_sequence_json FROM friday_episodes WHERE user_id = ? ORDER BY created_at").all(USER_ID) as Array<{
        task_intent: string;
        outcome: string;
        tool_sequence_json: string;
      }>);
    expect(episodes).toHaveLength(2);
    expect(episodes.every((episode) => episode.outcome === "success")).toBe(true);
    expect(episodes.every((episode) => JSON.parse(episode.tool_sequence_json).length === 3)).toBe(true);

    const patterns = db.withReadConnection((reader) =>
      reader.prepare("SELECT kind, sample_count FROM friday_learned_patterns WHERE user_id = ?").all(USER_ID) as Array<{
        kind: string;
        sample_count: number;
      }>);
    expect(patterns.some((pattern) => pattern.kind === "tool_sequence" && pattern.sample_count >= 2)).toBe(true);
    expect(patterns.some((pattern) => pattern.kind === "preference" && pattern.sample_count >= 2)).toBe(true);

    expect(finalPrompts).toHaveLength(2);
  });

  it("approves a generated workflow candidate and executes it from a fresh trigger through workflow_list", async () => {
    db = createTestDb();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-dp10-approved-workflow-"));
    db.withWriteTransaction((writer) => {
      writer.prepare(
        `INSERT OR IGNORE INTO users (id, display_name, role, is_local_only, created_at, updated_at)
         VALUES (?, ?, 'admin', 1, ?, ?)`,
      ).run(USER_ID, "DP10 User", NOW, NOW);
    });

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
      runId: string;
      outputPath: string;
      checksum: string;
    }> = [];

    const workflowRuntime = createFridayWorkflowRuntime({
      db,
      idGenerator,
      nowIso: () => NOW,
      computeChecksum: sha256,
      resolveSkill: (skillId) => skillId === GENERATED_WORKFLOW_SKILL_ID ? { id: skillId } : null,
      invokeSkill: async (_skillId, runId, _nodeId, payload) => {
        const outboxPath = String(payload.outboxPath ?? "");
        expect(path.isAbsolute(outboxPath)).toBe(false);
        expect(outboxPath.split(/[\\/]/)).not.toContain("..");
        const absoluteOutputPath = path.join(workspaceDir!, outboxPath);
        const content = [
          "DP10_APPROVED_GENERATED_WORKFLOW_OUTPUT",
          `triggerPhrase=${String(payload.triggerPhrase ?? "")}`,
          `runId=${runId}`,
        ].join("\n");
        await fs.mkdir(path.dirname(absoluteOutputPath), { recursive: true });
        await fs.writeFile(absoluteOutputPath, `${content}\n`, "utf8");
        const checksum = sha256(content);
        workflowInvocations.push({ runId, outputPath: outboxPath, checksum });
        return { outputPath: outboxPath, checksum };
      },
      triggerRepo: createFridayWorkflowTriggerRepository({ db }),
    });

    let generatorSessionCounter = 0;
    let approvedWorkflowId = "";
    let approvedWorkflowVersionId = "";
    const workflowGenerator = {
      startSession: vi.fn(async () => {
        generatorSessionCounter += 1;
        return {
          mode: "new",
          session: { sessionId: `dp10-approved-workflow-generator-${String(generatorSessionCounter)}` },
        };
      }),
      submitTurn: vi.fn(),
      getSession: vi.fn(),
      generateDraft: vi.fn(async (sessionId: string) => ({
        spec: {
          workflowId: `draft-${sessionId}`,
          name: "DP-10 approved generated refund followup workflow",
        },
        validation: { ok: true },
      })),
      getQaVerdict: vi.fn(async () => ({ status: "passed", source: "dp10-deterministic-generator" })),
      getHarnessSummary: vi.fn(async () => ({ status: "passed", source: "dp10-deterministic-generator" })),
      approveAndSave: vi.fn(async (sessionId: string) => {
        const slug = `dp10-approved-generated-${sessionId}`;
        const { workflow, version } = workflowRuntime.crud.createWorkflowWithVersion(
          {
            slug,
            name: "DP-10 approved weekly refund followup automation",
            description: "Generated from repeated DP-10 sessions.run behavior and approved by Reflex.",
            tags: ["dp10-generated", "refund-followup"],
            ownerUserId: USER_ID,
          },
          makeApprovedGeneratedWorkflowGraph(),
          USER_ID,
          "Approved generated workflow candidate from DP-10 probe",
        );
        const published = workflowRuntime.crud.publishVersion(workflow.id, version.versionNumber);
        approvedWorkflowId = workflow.id;
        approvedWorkflowVersionId = published.id;
        return {
          sessionId,
          workflowId: workflow.id,
          workflowVersionId: published.id,
          versionNumber: published.versionNumber,
          slug: workflow.slug,
          published: true,
          publicationBoundary: {
            stage: "published_version",
            lifecyclePromotion: "not_lifecycle_promoted",
            proofBoundary: "crud_publish_only",
            summary: "Published for deterministic DP-10 trigger proof; lifecycle promotion remains separate.",
          },
        };
      }),
      cancelSession: vi.fn(),
    };

    const reflexService = createFridayReflexService({
      db,
      candidateRepo: createFridayReflexCandidateRepository(),
      onboardingRepo: createFridayReflexOnboardingRepository(),
      preferenceRepo: createFridayUixUserPreferenceRepository(),
      memoryService,
      workflowGenerator: workflowGenerator as never,
      idGenerator,
      nowIso: () => NOW,
    });

    const runEventRepository = createFridayAgentRunEventRepository();
    const episodeExtractor = createFridayEpisodeExtractor({
      db,
      idGenerator,
      nowIso: () => NOW,
    });
    const patternExtractor = createFridayPatternExtractor({
      db,
      idGenerator,
      nowIso: () => NOW,
    });
    const contextEngine: FridayContextEngine = {
      async afterTurn(input) {
        const episode = await episodeExtractor.extractFromRun(input.runId, input.userId ?? USER_ID);
        if (episode) {
          await patternExtractor.extractPatterns(episode.userId, 50);
        }
        const toolEndEvents = db!.withReadConnection((reader) =>
          runEventRepository.list(reader, input.runId)
            .filter((event) => event.eventName === "agent.run.tool_end"));
        const toolSequence = toolEndEvents
          .map((event) => typeof event.payload.toolName === "string" ? event.payload.toolName : undefined)
          .filter((toolName): toolName is string => Boolean(toolName));
        await reflexService.processRunCompletion({
          userId: input.userId ?? USER_ID,
          runId: input.runId,
          sessionKey: input.sessionKey,
          task: input.task,
          outcome: input.status === "completed" ? "success" : input.status === "failed" ? "failure" : "unknown",
          toolSequence,
        });
      },
    };

    let repeatedStep = 0;
    let approvedExecutionStep = 0;
    let approvedRunIndex = 0;
    const approvalPrompts: Array<{ toolName: string; canonicalAction?: string }> = [];
    const finalPrompts: string[] = [];
    const llmClient: FridayAgentLlmClient = {
      async *stream(params) {
        const prompt = textFromMessages(params.messages);
        const destructiveApprovedTrigger = /delete .*approved weekly refund followup automation/i.test(prompt);
        const approvedExecutionTask =
          approvedExecutionStep > 0
          || /run the approved weekly refund followup automation/i.test(prompt);

        if (destructiveApprovedTrigger) {
          finalPrompts.push(prompt);
          yield {
            type: "text_delta",
            text: "DP10_APPROVED_GENERATED_WORKFLOW_REFUSED_DESTRUCTIVE_TRIGGER: deletion requires separate explicit approval and no workflow was started.",
          };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 30, outputTokens: 10 };
          return;
        }

        if (approvedExecutionTask) {
          if (approvedExecutionStep === 0 && !prompt.includes(approvedWorkflowId)) {
            approvedExecutionStep = 1;
            yield {
              type: "tool_use",
              id: `dp10-approved-workflow-list-${idGenerator()}`,
              name: "workflow_list",
              input: {
                tag: "dp10-generated",
                publishedOnly: true,
                limit: 5,
              },
            };
            yield { type: "message_end", stopReason: "tool_use", inputTokens: 28, outputTokens: 6 };
            return;
          }
          if (approvedExecutionStep === 1) {
            approvedExecutionStep = 2;
            approvedRunIndex += 1;
            yield {
              type: "tool_use",
              id: `dp10-approved-workflow-run-${idGenerator()}`,
              name: "workflow_run",
              input: {
                workflowId: approvedWorkflowId,
                versionId: approvedWorkflowVersionId,
                input: {
                  triggerPhrase: "run the approved weekly refund followup automation",
                  outboxPath: `outbox/approved-generated-followup-${approvedRunIndex}.md`,
                },
              },
            };
            yield { type: "message_end", stopReason: "tool_use", inputTokens: 30, outputTokens: 8 };
            return;
          }
          approvedExecutionStep = 0;
          finalPrompts.push(prompt);
          yield {
            type: "text_delta",
            text: "DP10_APPROVED_GENERATED_WORKFLOW_EXECUTED: approved generated workflow ran from fresh trigger after workflow_list discovery.",
          };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 30, outputTokens: 12 };
          return;
        }

        if (repeatedStep === 0) {
          repeatedStep = 1;
          yield {
            type: "tool_use",
            id: `dp10-c5-search-${idGenerator()}`,
            name: "memory_search",
            input: {
              query: "weekly refund followup reusable path",
              namespace: "agent",
              limit: 3,
            },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 20, outputTokens: 5 };
          return;
        }
        if (repeatedStep === 1) {
          repeatedStep = 2;
          yield {
            type: "tool_use",
            id: `dp10-c5-store-${idGenerator()}`,
            name: "memory_store",
            input: {
              content: "DP10_C5_REUSABLE_STEP: weekly refund followup pack uses memory_search -> memory_store -> memory_search.",
              namespace: "agent",
              tags: ["dp10-c5", "approved-generated-workflow"],
            },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 25, outputTokens: 8 };
          return;
        }
        if (repeatedStep === 2) {
          repeatedStep = 3;
          yield {
            type: "tool_use",
            id: `dp10-c5-confirm-${idGenerator()}`,
            name: "memory_search",
            input: {
              query: "DP10_C5_REUSABLE_STEP weekly refund followup",
              namespace: "agent",
              limit: 3,
            },
          };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 25, outputTokens: 8 };
          return;
        }
        repeatedStep = 0;
        finalPrompts.push(prompt);
        yield {
          type: "text_delta",
          text: "DP10_C5_RUN_COMPLETED: repeated refund followup path completed; generated automation remains draft-only until approval.",
        };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 30, outputTokens: 12 };
      },
    };

    const eventEmitter = createFridayAgentEventEmitter();
    const agentRuntime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "dp10-c5-deterministic-model",
      providerId: "dp10-c5-deterministic-provider",
      systemPrompt: "You are Friday. Use workflow_list before workflow_run when no workflow ID is provided. Workflow runs require approval.",
      tools: [
        ...createFridayAgentMemoryTools({
          memoryService,
          memoryGuardFactory,
        }),
        createFridayAgentWorkflowListTool({ workflowCrudService: workflowRuntime.crud }),
        createFridayAgentWorkflowTool({ workflowExecutionService: workflowRuntime.execution }),
      ],
      eventEmitter,
      runEventRepository,
      contextEngine,
      idGenerator,
      nowIso: () => NOW,
      canonicalMutatingActionGate: true,
      canonicalApprovalSecret: AUTH_TOKEN_TEST_KEY,
      toolApprovalResolver: async (prompt) => {
        approvalPrompts.push({
          toolName: prompt.toolName,
          canonicalAction: prompt.canonicalAction,
        });
        return {
          approved: true,
          decidedByPrincipalId: USER_ID,
          decidedByPrincipalType: "user",
          approvalSurface: "dp10-c5-probe",
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
      agentEventEmitter: eventEmitter,
      reflexService,
      tokenSecret: AUTH_TOKEN_TEST_KEY,
      computeChecksum: sha256,
      allowTestOnlySessionExecution: true,
      allowTestOnlySessionRunExecution: true,
      allowTestOnlySessionMemoryExtractionExecution: true,
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

    async function runSessionTask(task: string, chatId: string): Promise<{
      response: string;
      toolCallCount: number;
    }> {
      const createSession = await jsonFetch<{
        ok: boolean;
        data: { session: { key: string } };
      }>(baseUrl, "POST", "/v1/sessions", {
        channel: "dp10",
        chatId,
      });
      expect(createSession.status).toBe(200);
      const sessionKey = createSession.json.data.session.key;

      const reset = await jsonFetch<{ ok: boolean }>(
        baseUrl,
        "POST",
        `/v1/sessions/${encodeURIComponent(sessionKey)}/reset`,
      );
      expect(reset.status).toBe(200);

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
        console.info("DP10 approved workflow diagnostic", JSON.stringify(run.json.data.run, null, 2));
      }
      expect(run.json.data.run.status).toBe("completed");
      return {
        response: run.json.data.run.response,
        toolCallCount: run.json.data.run.toolCallCount,
      };
    }

    const repeatedA = await runSessionTask("prepare the weekly refund followup pack", "approved-generated-a");
    expect(repeatedA.response).toContain("DP10_C5_RUN_COMPLETED");
    const repeatedB = await runSessionTask("prepare the weekly refund followup pack", "approved-generated-b");
    expect(repeatedB.response).toContain("DP10_C5_RUN_COMPLETED");

    const workflowCandidates = reflexService.listCandidates({ userId: USER_ID, kind: "workflow" });
    expect(workflowCandidates).toHaveLength(1);
    expect(workflowCandidates[0]).toMatchObject({
      status: "ready_for_review",
      riskTier: 3,
    });
    expect(workflowGenerator.approveAndSave).not.toHaveBeenCalled();

    const approvedCandidate = await reflexService.approveCandidate({
      userId: USER_ID,
      candidateId: workflowCandidates[0]!.id,
    });
    expect(workflowGenerator.approveAndSave).toHaveBeenCalledTimes(1);
    expect(approvedCandidate.status).toBe("approved");
    expect(approvedCandidate.evidence.savedWorkflowId).toBe(approvedWorkflowId);
    expect(approvedCandidate.evidence.workflowVersionId).toBe(approvedWorkflowVersionId);
    expect(approvedCandidate.evidence.published).toBe(true);

    const listedWorkflows = workflowRuntime.crud.listWorkflows({ tag: "dp10-generated", archived: false });
    expect(listedWorkflows.map((workflow) => workflow.id)).toContain(approvedWorkflowId);

    const beforeApprovedRunCount = workflowRuntime.execution.listRuns(approvedWorkflowId, undefined, 20).length;
    const approvedRun = await runSessionTask(
      "run the approved weekly refund followup automation",
      "approved-generated-trigger",
    );
    expect(approvedRun.response).toContain("DP10_APPROVED_GENERATED_WORKFLOW_EXECUTED");
    expect(approvedRun.toolCallCount).toBe(2);

    const workflowRunId = await waitForNewestWorkflowRun(workflowRuntime, approvedWorkflowId, beforeApprovedRunCount);
    const run = workflowRuntime.execution.getRun(workflowRunId);
    expect(run?.status).toBe("completed");
    const evidence = workflowRuntime.evidence.getRunEvidence(workflowRunId);
    expect(evidence.evidenceStatus).toBe("available");
    expect(evidence.summary.totalEvents).toBeGreaterThan(0);

    const outputPath = path.join(workspaceDir, "outbox/approved-generated-followup-1.md");
    const output = await fs.readFile(outputPath, "utf8");
    expect(output).toContain("DP10_APPROVED_GENERATED_WORKFLOW_OUTPUT");
    expect(output).toContain("triggerPhrase=run the approved weekly refund followup automation");

    const workflowApprovals = approvalPrompts.filter((prompt) => prompt.toolName === "workflow_run");
    expect(workflowApprovals).toHaveLength(1);
    expect(workflowApprovals[0]?.canonicalAction).toBe("agent.tool.workflow_run");

    const beforeNegativeCount = workflowRuntime.execution.listRuns(approvedWorkflowId, undefined, 20).length;
    const negative = await runSessionTask(
      "delete outputs from the approved weekly refund followup automation",
      "approved-generated-negative",
    );
    expect(negative.response).toContain("DP10_APPROVED_GENERATED_WORKFLOW_REFUSED_DESTRUCTIVE_TRIGGER");
    expect(workflowRuntime.execution.listRuns(approvedWorkflowId, undefined, 20)).toHaveLength(beforeNegativeCount);
    expect(workflowInvocations).toHaveLength(1);
    expect(approvalPrompts.filter((prompt) => prompt.toolName === "workflow_run")).toHaveLength(1);
    expect(finalPrompts.some((prompt) => prompt.includes(approvedWorkflowId))).toBe(true);
  });
});
