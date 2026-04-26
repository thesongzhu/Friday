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

function createMockDeps(overrides?: Partial<FridayDeterministicDispatchDeps>): FridayDeterministicDispatchDeps {
  return {
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
      expect(result.response).toContain("<!--action:");
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
      expect(result.response).toContain("OCR provider/API key");
      expect(result.response).toContain("/setup?recipeId=capability-ocr&targetService=ocr");
      expect(result.response).toContain("运行 doctor 或代表性任务验证");
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
      expect(result.response).toContain("Representative test");
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
