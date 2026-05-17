import { describe, it, expect, vi } from "vitest";
import {
  dispatchDeterministic,
} from "../../../src/sessions/services/friday-deterministic-dispatch.js";
import type {
  FridayDeterministicDispatchDeps,
} from "../../../src/sessions/services/friday-deterministic-dispatch.js";
import type { FridayAgentCapabilitiesSnapshot } from "../../../src/agent/tools/friday-agent-capabilities-tool.js";
import type { FridayAgentTaskStatusSnapshot } from "../../../src/agent/tools/friday-agent-task-status-tool.js";
import type { FridayWorkflowApprovalService } from "../../../src/workflows/services/friday-workflow-approval-service.types.js";
import type { FridayWorkflowExecutionService, FridayWorkflowRunEntity } from "#workflows";
import type { FridayWorkflowApprovalRequestEntity } from "../../../src/workflows/model/friday-workflow-engine.types.js";
import type { FridaySessionMessageRecord } from "../../../src/sessions/model/friday-session.types.js";

function makeWorkflowRun(overrides?: Partial<FridayWorkflowRunEntity>): FridayWorkflowRunEntity {
  return {
    id: "wf-run-1",
    workflowId: "wf-1",
    workflowVersionId: "wf-v-1",
    status: "running",
    triggerType: "manual",
    startedAt: "2026-03-24T10:00:00.000Z",
    createdAt: "2026-03-24T10:00:00.000Z",
    updatedAt: "2026-03-24T10:00:00.000Z",
    ...overrides,
  };
}

function makeApproval(overrides?: Partial<FridayWorkflowApprovalRequestEntity>): FridayWorkflowApprovalRequestEntity {
  return {
    id: "approval-1",
    workflowId: "wf-1",
    workflowVersionId: "wf-v-1",
    runId: "wf-run-1",
    runNodeAttemptId: "attempt-1",
    nodeId: "approval-node",
    status: "pending",
    requestPayload: {},
    createdAt: "2026-03-24T10:00:00.000Z",
    updatedAt: "2026-03-24T10:00:00.000Z",
    ...overrides,
  };
}

function makeSessionMessage(input: {
  sequence: number;
  role: "user" | "assistant";
  contentText: string;
}): FridaySessionMessageRecord {
  return {
    id: `msg-${String(input.sequence)}`,
    sessionId: "session-1",
    sessionKey: "test",
    sequence: input.sequence,
    role: input.role,
    content: input.contentText,
    contentText: input.contentText,
    tokenCount: 0,
    metadata: {},
    memoryExtractStatus: "skipped",
    occurredAt: "2026-03-24T10:00:00.000Z",
    createdAt: "2026-03-24T10:00:00.000Z",
    updatedAt: "2026-03-24T10:00:00.000Z",
  };
}

function createMockDeps(overrides?: Partial<FridayDeterministicDispatchDeps>): FridayDeterministicDispatchDeps {
  return {
    sessionMessageGetter: vi.fn(() => []),
    capabilitySnapshotGetter: vi.fn().mockResolvedValue({
      readOnly: false,
      messaging: { enabled: true, kinds: ["discord"] },
      mcp: {
        enabled: true,
        serverCount: 2,
        servers: [
          { name: "filesystem", connected: true, authenticated: true },
          { name: "github", connected: true, authenticated: false },
        ],
      },
      provider: { available: true, configuredCount: 1, mutationBlockedByReadOnly: false },
      browser: { activeMode: "puppeteer" },
      runtime: {
        schemaVersion: "1.0",
        generatedAt: "2026-03-24T10:00:00.000Z",
        summary: {
          available: 1,
          needsVerification: 0,
          needsUserAction: 1,
          installable: 0,
          unsupported: 0,
        },
        items: [
          {
            capability: "vision",
            label: "Image understanding",
            description: "Send image inputs to a vision-capable model.",
            state: "needs_user_auth",
            sources: [],
            blockers: ["No verified vision provider configured."],
            repairOptions: [
              {
                id: "configure-qwen-vl",
                label: "Configure Qwen-VL",
                description: "Add a Qwen vision model and verify image understanding.",
                kind: "configure_provider",
                requiresApproval: true,
                providerKind: "qwen",
                setupHref: "/setup?step=provider&providerKind=qwen&recipeId=provider-qwen",
                href: "https://help.aliyun.com/zh/model-studio/",
                risks: ["auth", "paid_api"],
              },
            ],
          },
        ],
      },
      system: { enabled: true },
      desktop: { connected: false },
      companion: { connected: false },
    } satisfies FridayAgentCapabilitiesSnapshot),
    taskStatusSnapshotGetter: vi.fn().mockResolvedValue({
      readOnly: false,
      runStatus: "executing",
      task: "Build feature X",
      phase: "executing",
      elapsedMs: 5000,
      latestTool: "exec",
      activeSubagents: [],
      blockers: [],
    } satisfies FridayAgentTaskStatusSnapshot),
    getDaemonStatus: () => ({
      running: true,
      pid: 12345,
      startedAt: "2026-01-01T00:00:00Z",
      uptime: 60000,
    }),
    approvalService: {
      requestForNode: vi.fn(),
      listPending: vi.fn(() => []),
      getById: vi.fn(() => null),
      approve: vi.fn(async (input: { approvalId: string }) => ({
        approval: makeApproval({ id: input.approvalId, status: "approved" }),
        resumed: true,
      })),
      reject: vi.fn(async (input: { approvalId: string }) => ({
        approval: makeApproval({ id: input.approvalId, status: "rejected" }),
        resumed: false,
      })),
      expirePending: vi.fn(async () => 0),
    } satisfies FridayWorkflowApprovalService,
    workflowExecutionService: {
      setDistributedDispatcher: vi.fn(),
      startRun: vi.fn(),
      resumeRun: vi.fn(async (runId: string) => makeWorkflowRun({ id: runId, status: "running" })),
      cancelRun: vi.fn(async (runId: string) => makeWorkflowRun({ id: runId, status: "cancelled", finishedAt: "2026-03-24T10:05:00.000Z" })),
      retryRun: vi.fn(async (runId: string) => makeWorkflowRun({ id: runId, status: "queued" })),
      getRun: vi.fn((runId: string) => makeWorkflowRun({ id: runId })),
      listRuns: vi.fn(() => []),
      listActiveRuns: vi.fn(() => [
        makeWorkflowRun({ id: "wf-run-1", workflowId: "wf-1", status: "running" }),
        makeWorkflowRun({ id: "wf-run-2", workflowId: "wf-2", status: "queued" }),
      ]),
      getRunNodes: vi.fn(() => []),
      recoverActiveRuns: vi.fn(async () => 0),
      reportRemoteNodeResult: vi.fn(),
      reapExpiredLeases: vi.fn(async () => 0),
      sweepTimedOutRuns: vi.fn(async () => 0),
      sweepTimedOutNodes: vi.fn(async () => 0),
    } satisfies FridayWorkflowExecutionService,
    ...overrides,
  };
}

describe("dispatchDeterministic", () => {
  describe("capabilities handler", () => {
    it("returns formatted capabilities", async () => {
      const deps = createMockDeps();
      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "capabilities" },
          sessionKey: "test",
          runId: "run-1",
        },
        deps,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain("Current capabilities:");
      expect(result.response).toContain("Messaging: enabled (discord)");
      expect(result.response).toContain("MCP: enabled (2 server(s))");
      expect(result.response).toContain("filesystem (connected, authenticated)");
      expect(result.response).toContain("vision: needs_user_auth");
      expect(result.response).toContain("/setup?step=provider&providerKind=qwen&recipeId=provider-qwen");
    });

    it("answers Chinese channel authority questions with verified/blocked capability boundaries", async () => {
      const deps = createMockDeps({
        capabilitySnapshotGetter: vi.fn().mockResolvedValue({
          readOnly: false,
          messaging: { enabled: true, kinds: ["feishu", "telegram"] },
          mcp: { enabled: false, serverCount: 0, servers: [] },
          provider: { available: true, configuredCount: 1, mutationBlockedByReadOnly: false },
          browser: { activeMode: "headless", targetBrowser: "Playwright Chromium" },
          runtime: {
            schemaVersion: "1.0",
            generatedAt: "2026-03-24T10:00:00.000Z",
            summary: {
              available: 4,
              needsVerification: 2,
              needsUserAction: 1,
              installable: 1,
              unsupported: 0,
            },
            items: [
              {
                capability: "text",
                label: "Text generation",
                description: "Route language tasks to a configured model.",
                state: "available",
                sources: [
                  {
                    kind: "provider",
                    id: "provider-1:deepseek-v4-flash",
                    label: "DeepSeek / deepseek-v4-flash",
                    status: "verified",
                    providerId: "provider-1",
                    providerKind: "deepseek",
                    model: "deepseek-v4-flash",
                  },
                ],
                blockers: [],
                repairOptions: [],
              },
              {
                capability: "ocr",
                label: "OCR",
                description: "Extract text from images.",
                state: "needs_user_auth",
                sources: [],
                blockers: ["No verified OCR provider configured."],
                repairOptions: [
                  {
                    id: "capability-ocr",
                    label: "Configure OCR",
                    description: "Add and verify OCR.",
                    kind: "configure_provider",
                    requiresApproval: true,
                    setupHref: "/setup?recipeId=capability-ocr&targetService=ocr",
                    risks: ["auth"],
                  },
                ],
              },
            ],
          },
          system: { enabled: true },
          desktop: { connected: false },
          companion: { connected: true },
        } satisfies FridayAgentCapabilitiesSnapshot),
      });

      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "capabilities" },
          task: "飞书和其他渠道可以控制100%的 Friday 所有能力对吧？",
          sessionKey: "test",
          runId: "run-channel-authority",
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toContain("当前能力：");
      expect(result.response).toContain("消息渠道：已启用（feishu、telegram）");
      expect(result.response).toContain("已验证能力：4 个可用，2 个需要验证，1 个需要你配置，1 个可在批准后安装或生成。");
      expect(result.response).toContain("text: available（DeepSeek / deepseek-v4-flash");
      expect(result.response).toContain("ocr: needs_user_auth（No verified OCR provider configured.；修复：Configure OCR");
      expect(result.response).not.toContain("100%");
      expect(result.response).not.toContain("所有能力都可用");
    });

    it("returns handled:false when snapshot getter throws", async () => {
      const deps = createMockDeps({
        capabilitySnapshotGetter: vi.fn().mockRejectedValue(new Error("fail")),
      });
      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "capabilities" },
          sessionKey: "test",
          runId: "run-1",
        },
        deps,
      );
      expect(result.handled).toBe(false);
    });
  });

  describe("task_status handler", () => {
    it("returns formatted task status", async () => {
      const deps = createMockDeps();
      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "task_status" },
          sessionKey: "test",
          runId: "run-1",
        },
        deps,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain("Task status: executing");
      expect(result.response).toContain("Build feature X");
    });

    it("shows terminal outcome when available", async () => {
      const deps = createMockDeps({
        taskStatusSnapshotGetter: vi.fn().mockResolvedValue({
          readOnly: false,
          activeSubagents: [],
          blockers: [],
          terminalOutcome: {
            status: "completed",
            summary: "Done building feature X",
          },
        } satisfies FridayAgentTaskStatusSnapshot),
      });
      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "task_status" },
          sessionKey: "test",
          runId: "run-1",
        },
        deps,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain("Task completed");
      expect(result.response).toContain("Done building feature X");
    });

    it("shows cancelled terminal outcome with the persisted reason", async () => {
      const deps = createMockDeps({
        taskStatusSnapshotGetter: vi.fn().mockResolvedValue({
          readOnly: false,
          activeSubagents: [],
          blockers: [],
          terminalOutcome: {
            status: "cancelled",
            summary: "Cancelled via API",
            responseText: "Cancelled via API",
          },
        } satisfies FridayAgentTaskStatusSnapshot),
      });
      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "task_status" },
          sessionKey: "test",
          runId: "run-1",
          task: "为什么 Request was cancelled before completion?",
        },
        deps,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain("任务已取消");
      expect(result.response).toContain("Cancelled via API");
    });

    it("shows no active task when status is empty", async () => {
      const deps = createMockDeps({
        taskStatusSnapshotGetter: vi.fn().mockResolvedValue({
          readOnly: false,
          activeSubagents: [],
          blockers: [],
        } satisfies FridayAgentTaskStatusSnapshot),
      });
      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "task_status" },
          sessionKey: "test",
          runId: "run-1",
        },
        deps,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain("No active task");
    });

    it("localizes task status for Chinese requests", async () => {
      const deps = createMockDeps();
      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "task_status" },
          sessionKey: "test",
          runId: "run-1",
          task: "现在进度怎么样？",
        },
        deps,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain("任务状态：执行中");
      expect(result.response).toContain("最近工具：exec");
      expect(result.response).not.toContain("Task status");
    });
  });

  describe("last_user_message handler", () => {
    it("returns only the previous user message for Chinese recall", async () => {
      const deps = createMockDeps({
        sessionMessageGetter: vi.fn(() => [
          makeSessionMessage({
            sequence: 1,
            role: "user",
            contentText: "要 promote Friday，在不同社交媒体上，中国和美国",
          }),
          makeSessionMessage({
            sequence: 2,
            role: "assistant",
            contentText: "我可以帮你拆渠道。",
          }),
          makeSessionMessage({
            sequence: 3,
            role: "user",
            contentText: "你还记得我上次最后写的是什么吗？",
          }),
        ]),
      });

      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "last_user_message" },
          sessionKey: "test",
          runId: "run-1",
          task: "你还记得我上次最后写的是什么吗？",
          currentUserSequence: 3,
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toBe("你上次问的是：要 promote Friday，在不同社交媒体上，中国和美国");
      expect(result.response).not.toContain("**");
    });
  });

  describe("unsafe_automation_boundary handler", () => {
    it("refuses anti-detection scraping requests in Chinese without invoking the agent", async () => {
      const deps = createMockDeps();
      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "unsafe_automation_boundary" },
          sessionKey: "test",
          runId: "run-1",
          task: "你可以自己写一个skills去爬小红书的内容吗？不被发现和不被ban的。",
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toContain("不能帮你写");
      expect(result.response).toContain("合规版本");
      expect(result.response).not.toContain("Still working");
    });
  });

  describe("Phase 14.5B module_28b: repair_preview handler", () => {
    function makePlannedAction(overrides?: Partial<{ actionId: string; title: string; riskTier: 0 | 1 | 2 }>) {
      const actionId = overrides?.actionId ?? "action-A1";
      const title = overrides?.title ?? "Retry timed-out workflow node";
      const riskTier = overrides?.riskTier ?? 1;
      return {
        action: {
          actionId,
          incidentId: "inc-1",
          userId: "user-bound-1",
          riskTier,
          plan: {
            title,
            summary: title,
            steps: [],
            evidence: { fingerprint: "fp", matchedLessonIds: [], diagnosisId: "diag", recurrenceCount: 1 },
          },
          status: "planned" as const,
          outcome: null,
          createdAt: "2026-05-16T00:00:00.000Z",
          updatedAt: "2026-05-16T00:00:00.000Z",
        },
        incident: null,
        diagnosis: null,
        approval: null,
        lesson: null,
        risk: { riskTier, reasons: [], requiresApproval: false, autoApplyAllowed: true },
        evidence: {
          rootCauseSummary: title,
          selectedPlan: { title, summary: title, stepCount: 0, rollbackPlanAvailable: false },
          riskTier,
          executionResult: { status: "planned" as const, outcome: null, repairOutcome: "failed" as const },
          rollbackResult: { available: false, rollbackAttempted: false, rollbackSucceeded: false },
          acceptanceResult: { passed: false, reason: "Mitigation has not completed acceptance checks" },
        },
      };
    }

    it("Phase 14.5B module_28b: channel \"repair\" command emits preview and never auto-executes", async () => {
      const listActions = vi.fn(() => [
        makePlannedAction({ actionId: "action-A1", title: "Retry timed-out workflow node", riskTier: 0 }),
        makePlannedAction({ actionId: "action-A2", title: "Apply config patch", riskTier: 1 }),
      ]);
      const deps = createMockDeps({
        selfHealingService: { listActions } as never,
      });

      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "repair_preview" },
          sessionKey: "test",
          actorId: "user-bound-1",
          task: "repair",
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toContain("2 planned repair action(s)");
      expect(result.response).toContain("action-A1");
      expect(result.response).toContain("action-A2");
      expect(result.response).toContain("Preview only");
      expect(result.response).toContain("bound owner principal");
      // Auto-execution surfaces must NEVER be called from the channel preview.
      expect(listActions).toHaveBeenCalledWith({ userId: "user-bound-1", status: "planned", limit: 5 });
    });

    it("Phase 14.5B module_28b: channel \"repair\" command refuses synthetic public actor", async () => {
      const listActions = vi.fn(() => []);
      const deps = createMockDeps({
        selfHealingService: { listActions } as never,
      });

      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "repair_preview" },
          sessionKey: "test",
          actorId: "public:default",
          task: "repair",
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toContain("bound owner/session/channel actor");
      // The synthetic public actor must not be able to enumerate planned actions.
      expect(listActions).not.toHaveBeenCalled();
    });

    it("Phase 14.5B module_28b: Chinese \"修复\" command emits preview without auto-execution", async () => {
      const listActions = vi.fn(() => []);
      const deps = createMockDeps({
        selfHealingService: { listActions } as never,
      });

      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "repair_preview" },
          sessionKey: "test",
          actorId: "user-bound-1",
          task: "修复",
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toContain("没有待执行的修复");
      expect(listActions).toHaveBeenCalledWith({ userId: "user-bound-1", status: "planned", limit: 5 });
    });

    it("Phase 14.5B module_28b: returns not-handled when self-healing service is unavailable", async () => {
      const deps = createMockDeps();
      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "repair_preview" },
          sessionKey: "test",
          actorId: "user-bound-1",
          task: "repair",
        },
        deps,
      );

      expect(result.handled).toBe(false);
    });
  });

  describe("daemon_status handler", () => {
    it("returns running status when daemon is available", async () => {
      const deps = createMockDeps();
      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "daemon_status" },
          sessionKey: "test",
          runId: "run-1",
        },
        deps,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain("running");
      expect(result.response).toContain("12345");
    });

    it("returns not available when daemon service is missing", async () => {
      const deps = createMockDeps({ getDaemonStatus: undefined });
      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "daemon_status" },
          sessionKey: "test",
          runId: "run-1",
        },
        deps,
      );
      expect(result.handled).toBe(false);
    });
  });

  describe("mcp_list handler", () => {
    it("returns server list when adapter is available", async () => {
      const deps = createMockDeps({
        listMcpServers: () => [
          { id: "filesystem", transport: "stdio" },
          { id: "remote-api", transport: "http" },
        ],
      });
      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "mcp_list" },
          sessionKey: "test",
          runId: "run-1",
        },
        deps,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain("2 MCP server(s)");
      expect(result.response).toContain("filesystem");
      expect(result.response).toContain("remote-api");
    });

    it("returns no servers when adapter is missing", async () => {
      const deps = createMockDeps({ listMcpServers: undefined });
      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "mcp_list" },
          sessionKey: "test",
          runId: "run-1",
        },
        deps,
      );
      expect(result.handled).toBe(false);
    });
  });

  describe("approval_decision handler", () => {
    it("returns no pending approvals when none exist", async () => {
      const deps = createMockDeps();
      const result = await dispatchDeterministic(
        {
          classification: {
            category: "sync_immediate",
            handler: "approval_decision",
            extractedParams: { decision: "approve" },
          },
          sessionKey: "test",
          runId: "run-1",
          actorId: "user-1",
        },
        deps,
      );
      expect(result.handled).toBe(true);
      expect(result.response).toContain("No pending approvals");
    });

    it("localizes no pending approval replies for Chinese Feishu users", async () => {
      const deps = createMockDeps();
      const result = await dispatchDeterministic(
        {
          classification: {
            category: "sync_immediate",
            handler: "approval_decision",
            extractedParams: { decision: "approve" },
          },
          task: "批准",
          sessionKey: "channel:feishu:oc-test",
          actorId: "user-1",
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toBe("当前没有待审批操作。");
    });

    it("auto-approves the single pending approval when no id is provided", async () => {
      const deps = createMockDeps({
        approvalService: {
          requestForNode: vi.fn(),
          listPending: vi.fn(() => [makeApproval({ id: "approval-7", runId: "wf-run-7" })]),
          getById: vi.fn(() => makeApproval({ id: "approval-7", runId: "wf-run-7" })),
          approve: vi.fn(async () => ({
            approval: makeApproval({ id: "approval-7", runId: "wf-run-7", status: "approved" }),
            resumed: true,
          })),
          reject: vi.fn(async () => ({ approval: makeApproval({ status: "rejected" }), resumed: false })),
          expirePending: vi.fn(async () => 0),
        } satisfies FridayWorkflowApprovalService,
      });
      const result = await dispatchDeterministic(
        {
          classification: {
            category: "sync_immediate",
            handler: "approval_decision",
            extractedParams: { decision: "approve" },
          },
          actorId: "user-7",
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(deps.approvalService!.approve).toHaveBeenCalledWith({
        approvalId: "approval-7",
        decidedByUserId: "user-7",
        comment: undefined,
      });
      expect(result.response).toContain("Approved approval approval-7");
      expect(result.response).toContain("wf-run-7");
    });

    it("localizes single pending approval decisions for Chinese Feishu users", async () => {
      const deps = createMockDeps({
        approvalService: {
          requestForNode: vi.fn(),
          listPending: vi.fn(() => [makeApproval({ id: "approval-7", runId: "wf-run-7" })]),
          getById: vi.fn(() => makeApproval({ id: "approval-7", runId: "wf-run-7" })),
          approve: vi.fn(async () => ({
            approval: makeApproval({ id: "approval-7", runId: "wf-run-7", status: "approved" }),
            resumed: true,
          })),
          reject: vi.fn(async () => ({ approval: makeApproval({ status: "rejected" }), resumed: false })),
          expirePending: vi.fn(async () => 0),
        } satisfies FridayWorkflowApprovalService,
      });

      const result = await dispatchDeterministic(
        {
          classification: {
            category: "sync_immediate",
            handler: "approval_decision",
            extractedParams: { decision: "approve" },
          },
          task: "批准这个审批",
          sessionKey: "channel:feishu:oc-test",
          actorId: "user-7",
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toBe("已批准 approval-7，workflow run wf-run-7。已恢复：是。");
    });

    it("returns deterministic clarification when multiple pending approvals exist", async () => {
      const deps = createMockDeps({
        approvalService: {
          requestForNode: vi.fn(),
          listPending: vi.fn(() => [
            makeApproval({ id: "approval-1", runId: "wf-run-1" }),
            makeApproval({ id: "approval-2", runId: "wf-run-2" }),
          ]),
          getById: vi.fn(() => null),
          approve: vi.fn(async () => ({ approval: makeApproval({ status: "approved" }), resumed: true })),
          reject: vi.fn(async () => ({ approval: makeApproval({ status: "rejected" }), resumed: false })),
          expirePending: vi.fn(async () => 0),
        } satisfies FridayWorkflowApprovalService,
      });

      const result = await dispatchDeterministic(
        {
          classification: {
            category: "sync_immediate",
            handler: "approval_decision",
            extractedParams: { decision: "reject" },
          },
          actorId: "user-1",
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toContain("Multiple pending approvals");
      expect(result.response).toContain("approval-1");
      expect(result.response).toContain("approval-2");
      expect(deps.approvalService!.reject).not.toHaveBeenCalled();
    });

    it("localizes multiple pending approval clarification for Chinese Feishu users", async () => {
      const deps = createMockDeps({
        approvalService: {
          requestForNode: vi.fn(),
          listPending: vi.fn(() => [
            makeApproval({ id: "approval-1", runId: "wf-run-1" }),
            makeApproval({ id: "approval-2", runId: "wf-run-2" }),
          ]),
          getById: vi.fn(() => null),
          approve: vi.fn(async () => ({ approval: makeApproval({ status: "approved" }), resumed: true })),
          reject: vi.fn(async () => ({ approval: makeApproval({ status: "rejected" }), resumed: false })),
          expirePending: vi.fn(async () => 0),
        } satisfies FridayWorkflowApprovalService,
      });

      const result = await dispatchDeterministic(
        {
          classification: {
            category: "sync_immediate",
            handler: "approval_decision",
            extractedParams: { decision: "reject" },
          },
          task: "拒绝",
          sessionKey: "channel:feishu:oc-test",
          actorId: "user-1",
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toContain("当前有多个待审批操作");
      expect(result.response).toContain("approval-1（run wf-run-1，node approval-node）");
      expect(result.response).toContain("approval-2（run wf-run-2，node approval-node）");
      expect(deps.approvalService!.reject).not.toHaveBeenCalled();
    });

    it("uses an explicit approval id when provided", async () => {
      const deps = createMockDeps();
      const result = await dispatchDeterministic(
        {
          classification: {
            category: "sync_immediate",
            handler: "approval_decision",
            extractedParams: { decision: "reject", approvalId: "approval-99" },
          },
          actorId: "user-99",
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(deps.approvalService!.reject).toHaveBeenCalledWith({
        approvalId: "approval-99",
        decidedByUserId: "user-99",
        comment: undefined,
      });
      expect(result.response).toContain("Rejected approval approval-99");
    });

    // ── Phase 14.5A WP-001 decision 8: conversational approve/reject parity ─

    it("Phase 14.5A: refuses session-text approval from the synthetic public principal", async () => {
      const deps = createMockDeps({
        approvalService: {
          requestForNode: vi.fn(),
          listPending: vi.fn(() => [makeApproval({ id: "approval-7", runId: "wf-run-7" })]),
          getById: vi.fn(() => makeApproval({ id: "approval-7", runId: "wf-run-7" })),
          approve: vi.fn(async () => ({
            approval: makeApproval({ id: "approval-7", runId: "wf-run-7", status: "approved" }),
            resumed: true,
          })),
          reject: vi.fn(async () => ({ approval: makeApproval({ status: "rejected" }), resumed: false })),
          expirePending: vi.fn(async () => 0),
        } satisfies FridayWorkflowApprovalService,
      });
      const result = await dispatchDeterministic(
        {
          classification: {
            category: "sync_immediate",
            handler: "approval_decision",
            extractedParams: { decision: "approve" },
          },
          actorId: "public:default",
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toMatch(/bound owner\/session\/channel actor/i);
      expect(deps.approvalService!.approve).not.toHaveBeenCalled();
      expect(deps.approvalService!.reject).not.toHaveBeenCalled();
    });

    it("Phase 14.5A: refuses session-text approval when actorId is missing", async () => {
      const deps = createMockDeps({
        approvalService: {
          requestForNode: vi.fn(),
          listPending: vi.fn(() => [makeApproval({ id: "approval-7", runId: "wf-run-7" })]),
          getById: vi.fn(() => makeApproval({ id: "approval-7", runId: "wf-run-7" })),
          approve: vi.fn(async () => ({
            approval: makeApproval({ id: "approval-7", runId: "wf-run-7", status: "approved" }),
            resumed: true,
          })),
          reject: vi.fn(async () => ({ approval: makeApproval({ status: "rejected" }), resumed: false })),
          expirePending: vi.fn(async () => 0),
        } satisfies FridayWorkflowApprovalService,
      });
      const result = await dispatchDeterministic(
        {
          classification: {
            category: "sync_immediate",
            handler: "approval_decision",
            extractedParams: { decision: "reject" },
          },
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toMatch(/bound owner\/session\/channel actor/i);
      expect(deps.approvalService!.approve).not.toHaveBeenCalled();
      expect(deps.approvalService!.reject).not.toHaveBeenCalled();
    });
  });

  describe("workflow_query handler", () => {
    it("lists active workflow runs for generic workflow status queries", async () => {
      const deps = createMockDeps();

      const result = await dispatchDeterministic(
        {
          classification: {
            category: "sync_immediate",
            handler: "workflow_query",
          },
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toContain("2 active workflow run(s)");
      expect(result.response).toContain("wf-run-1");
      expect(result.response).toContain("wf-run-2");
    });

    it("returns a specific workflow run when a run id is provided", async () => {
      const deps = createMockDeps();

      const result = await dispatchDeterministic(
        {
          classification: {
            category: "sync_immediate",
            handler: "workflow_query",
            extractedParams: { runId: "wf-run-42" },
          },
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toContain("Workflow run wf-run-42");
      expect(result.response).toContain("running");
      expect(deps.workflowExecutionService!.getRun).toHaveBeenCalledWith("wf-run-42");
    });
  });

  describe("setup_guidance handler", () => {
    it("returns concrete Chinese setup guidance for Discord binding", async () => {
      const deps = createMockDeps();

      const result = await dispatchDeterministic(
        {
          classification: {
            category: "sync_immediate",
            handler: "setup_guidance",
            extractedParams: { setupTargetService: "discord" },
          },
          task: "需要绑定discord",
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toContain("不能用 message 工具直接绑定");
      expect(result.response).toContain("channel-discord-bot");
      expect(result.response).toContain("Discord Bot Token");
      expect(result.response).toContain("/setup?step=channels&channel=discord");
      expect(result.response).not.toContain("<!--action:");
    });

    it("uses a registered recipe when available", async () => {
      const deps = createMockDeps({
        setupRecipeRegistry: {
          getByTarget: vi.fn(() => ({
            id: "channel-discord-custom",
            name: "Custom Discord Setup",
            description: "Configure Discord",
            category: "channel",
            version: "1.0.0",
            targetService: "discord",
            prerequisites: [],
            steps: [],
            outputs: [{ key: "botToken", label: "Bot Token", sensitive: true }],
          })),
        },
      });

      const result = await dispatchDeterministic(
        {
          classification: {
            category: "sync_immediate",
            handler: "setup_guidance",
            extractedParams: { setupTargetService: "discord" },
          },
          task: "connect discord",
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(deps.setupRecipeRegistry!.getByTarget).toHaveBeenCalledWith("discord");
      expect(result.response).toContain("channel-discord-custom");
      expect(result.response).toContain("Custom Discord Setup");
    });

    it("returns capability setup guidance for OCR", async () => {
      const deps = createMockDeps();

      const result = await dispatchDeterministic(
        {
          classification: {
            category: "sync_immediate",
            handler: "setup_guidance",
            extractedParams: { setupTargetService: "ocr" },
          },
          task: "帮我配置OCR",
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toContain("能力闭环");
      expect(result.response).toContain("capability-ocr");
      expect(result.response).toContain("OCR 服务账号/API key");
      expect(result.response).toContain("/setup?recipeId=capability-ocr&targetService=ocr");
      expect(result.response).toContain("跑一次验证");
    });

    it("returns capability setup guidance for generated custom capabilities", async () => {
      const deps = createMockDeps();

      const result = await dispatchDeterministic(
        {
          classification: {
            category: "sync_immediate",
            handler: "setup_guidance",
            extractedParams: { setupTargetService: "custom" },
          },
          task: "配置自定义能力",
        },
        deps,
      );

      expect(result.handled).toBe(true);
      expect(result.response).toContain("capability-custom");
      expect(result.response).toContain("生成本地工具");
      expect(result.response).toContain("代表性测试");
      expect(result.response).toContain("/setup?recipeId=capability-custom&targetService=custom");
    });
  });

  describe("unknown handler", () => {
    it("returns handled:false", async () => {
      const deps = createMockDeps();
      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate", handler: "unknown_handler" },
          sessionKey: "test",
          runId: "run-1",
        },
        deps,
      );
      expect(result.handled).toBe(false);
    });
  });

  describe("no handler specified", () => {
    it("returns handled:false", async () => {
      const deps = createMockDeps();
      const result = await dispatchDeterministic(
        {
          classification: { category: "sync_immediate" },
          sessionKey: "test",
          runId: "run-1",
        },
        deps,
      );
      expect(result.handled).toBe(false);
    });
  });
});
