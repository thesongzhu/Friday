/**
 * Tests for engine audit fixes:
 * CX-001: batchSize clamping
 * CX-002: Approval resolution ordering (resume before commit)
 * CX-003: Expired approvals unblock paused runs
 * CX-004: Approver authorization check
 * CX-005: when: "success" edge condition
 * CX-006: Transform-step config shape
 * CX-008: AbortSignal passthrough to node executor
 *
 * CX-007 (addMessage lineage) is tested in friday-session-service.test.ts additions.
 * E2E version numbering + HEAD body suppression are tested separately.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { FridayDomainError } from "#errors";
import {
  createFridayWorkflowCompiler,
  createFridayWorkflowNodeExecutor,
  createFridayExpressionEvaluator,
} from "#workflows";
import type {
  FridayWorkflowSpecV1,
  FridayNodeExecutionInput,
  FridayWorkflowNode,
  FridayExpressionContext,
} from "#workflows";
import type { JsonValue } from "#workflows";
import {
  FRIDAY_SESSION_MEMORY_EXTRACTION_MIN_BATCH_SIZE,
  FRIDAY_SESSION_MEMORY_EXTRACTION_MAX_BATCH_SIZE,
} from "#sessions";
import { createFridayWorkflowApprovalService } from "#workflows";
import type { FridayWorkflowApprovalRequestEntity } from "#workflows";
import type { CreateFridayWorkflowApprovalServiceDeps } from "../../../src/workflows/services/friday-workflow-approval-service.types.js";

// ──────────────────────────────────────────────────────────────────────────────
// CX-001: batchSize guard constants
// ──────────────────────────────────────────────────────────────────────────────

describe("CX-001: batchSize guard constants", () => {
  it("MIN_BATCH_SIZE is 1", () => {
    expect(FRIDAY_SESSION_MEMORY_EXTRACTION_MIN_BATCH_SIZE).toBe(1);
  });

  it("MIN < MAX", () => {
    expect(FRIDAY_SESSION_MEMORY_EXTRACTION_MIN_BATCH_SIZE).toBeLessThan(
      FRIDAY_SESSION_MEMORY_EXTRACTION_MAX_BATCH_SIZE,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// CX-005: when: "success" edge condition
// ──────────────────────────────────────────────────────────────────────────────

describe("CX-005: when: 'success' edge condition", () => {
  const compiler = createFridayWorkflowCompiler({
    computeChecksum: (content) => createHash("sha256").update(content).digest("hex"),
    idGenerator: (() => {
      let c = 0;
      return () => `edge-id-${String(++c).padStart(4, "0")}`;
    })(),
  });

  function makeSpec(
    edges: FridayWorkflowSpecV1["edges"],
    steps?: FridayWorkflowSpecV1["steps"],
  ): FridayWorkflowSpecV1 {
    return {
      schemaVersion: "1.0",
      workflowId: "wf-edge",
      name: "Edge Test",
      description: "test",
      startStepId: "step1",
      trigger: { type: "manual" },
      inputs: [],
      steps: steps ?? [
        { id: "step1", type: "skill_call", ref: "s1" },
        { id: "step2", type: "skill_call", ref: "s2" },
      ],
      edges,
      outputs: [],
      errorPolicy: { onFailure: "continue_on_error", notifyUser: false },
      tests: [],
    };
  }

  it("when: 'success' produces a non-failed condition", () => {
    const result = compiler.compile(
      makeSpec([{ from: "step1", to: "step2", when: "success" }]),
      "wv-1",
    );
    const edge = result.graph.edges.find(
      (e) => e.sourceNodeId === "step1" && e.targetNodeId === "step2",
    );
    expect(edge).toBeDefined();
    expect(edge!.condition).toBeDefined();
    expect(edge!.condition).toContain("status");
    expect(edge!.condition).toContain("failed");
    expect(edge!.condition).toContain("!=");
  });

  it("when: 'failure' produces a failed condition", () => {
    const result = compiler.compile(
      makeSpec([{ from: "step1", to: "step2", when: "failure" }]),
      "wv-1",
    );
    const edge = result.graph.edges.find(
      (e) => e.sourceNodeId === "step1" && e.targetNodeId === "step2",
    );
    expect(edge!.condition).toContain("==");
    expect(edge!.condition).toContain("failed");
  });

  it("when: undefined produces no condition (unconditional)", () => {
    const result = compiler.compile(
      makeSpec([{ from: "step1", to: "step2" }]),
      "wv-1",
    );
    const edge = result.graph.edges.find(
      (e) => e.sourceNodeId === "step1" && e.targetNodeId === "step2",
    );
    expect(edge!.condition).toBeUndefined();
  });

  it("success and failure edges from same step produce different conditions", () => {
    const result = compiler.compile(
      makeSpec(
        [
          { from: "step1", to: "step2", when: "success" },
          { from: "step1", to: "step3", when: "failure" },
        ],
        [
          { id: "step1", type: "skill_call", ref: "s1" },
          { id: "step2", type: "skill_call", ref: "s2" },
          { id: "step3", type: "skill_call", ref: "s3" },
        ],
      ),
      "wv-1",
    );
    const successEdge = result.graph.edges.find(
      (e) => e.sourceNodeId === "step1" && e.targetNodeId === "step2",
    );
    const failureEdge = result.graph.edges.find(
      (e) => e.sourceNodeId === "step1" && e.targetNodeId === "step3",
    );
    expect(successEdge!.condition).not.toBe(failureEdge!.condition);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// CX-006: Transform-step config shape
// ──────────────────────────────────────────────────────────────────────────────

describe("CX-006: Transform-step compiled config shape", () => {
  const compiler = createFridayWorkflowCompiler({
    computeChecksum: (content) => createHash("sha256").update(content).digest("hex"),
    idGenerator: (() => {
      let c = 0;
      return () => `tf-id-${String(++c).padStart(4, "0")}`;
    })(),
  });

  function makeTransformSpec(
    args: Record<string, unknown>,
  ): FridayWorkflowSpecV1 {
    return {
      schemaVersion: "1.0",
      workflowId: "wf-transform",
      name: "Transform Test",
      description: "test",
      startStepId: "step1",
      trigger: { type: "manual" },
      inputs: [],
      steps: [{ id: "step1", type: "transform", args }],
      edges: [],
      outputs: [],
      errorPolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
    };
  }

  it("maps transform and mapping to top-level config", () => {
    const result = compiler.compile(
      makeTransformSpec({
        transform: "$steps.a.output.x * 2",
        mapping: { x: "$inputs.x" },
        extra: 42,
      }),
      "wv-1",
    );
    const node = result.graph.nodes.find((n) => n.id === "step1");
    expect(node).toBeDefined();
    expect(node!.config.transform).toBe("$steps.a.output.x * 2");
    expect(node!.config.mapping).toEqual({ x: "$inputs.x" });
    expect((node!.config.args as Record<string, unknown>)?.extra).toBe(42);
  });

  it("does NOT set config.args for transform-only step", () => {
    const result = compiler.compile(
      makeTransformSpec({ transform: "$inputs.x" }),
      "wv-1",
    );
    const node = result.graph.nodes.find((n) => n.id === "step1");
    expect(node!.config.transform).toBe("$inputs.x");
    // No extra rest keys → no args
    expect(node!.config.args).toBeUndefined();
  });

  it("non-transform step puts all args into config.args", () => {
    const spec: FridayWorkflowSpecV1 = {
      schemaVersion: "1.0",
      workflowId: "wf-action",
      name: "Action",
      description: "test",
      startStepId: "step1",
      trigger: { type: "manual" },
      inputs: [],
      steps: [{ id: "step1", type: "skill_call", ref: "s1", args: { x: 1, y: "z" } }],
      edges: [],
      outputs: [],
      errorPolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
    };
    const result = compiler.compile(spec, "wv-1");
    const node = result.graph.nodes.find((n) => n.id === "step1");
    expect(node!.config.args).toEqual({ x: 1, y: "z" });
    // transform/mapping should not leak into non-transform nodes
    expect(node!.config.transform).toBeUndefined();
    expect(node!.config.mapping).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// CX-002 / CX-003 / CX-004: Approval service fixes
// ──────────────────────────────────────────────────────────────────────────────

describe("CX-002/003/004: Approval service fixes", () => {
  const NOW = "2026-02-18T10:00:00.000Z";
  let idCounter = 0;

  function makeApproval(overrides: Partial<FridayWorkflowApprovalRequestEntity> = {}): FridayWorkflowApprovalRequestEntity {
    return {
      id: `approval-${++idCounter}`,
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      runId: "run-1",
      runNodeAttemptId: "att-1",
      nodeId: "approval-node",
      status: "pending",
      requestPayload: {},
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  function makeDeps(overrides: Partial<CreateFridayWorkflowApprovalServiceDeps> = {}): CreateFridayWorkflowApprovalServiceDeps {
    const stored = new Map<string, FridayWorkflowApprovalRequestEntity>();
    return {
      approvalRepo: {
        insert: vi.fn((entity: FridayWorkflowApprovalRequestEntity) => {
          stored.set(entity.id, entity);
          return entity;
        }),
        getById: vi.fn((id: string) => stored.get(id) ?? null),
        listPending: vi.fn(() => Array.from(stored.values()).filter((a) => a.status === "pending")),
        resolvePending: vi.fn((input: { id: string; status: "approved" | "rejected"; decidedByUserId: string; comment?: string; nowIso: string }) => {
          const entity = stored.get(input.id);
          if (!entity || entity.status !== "pending") return null;
          const resolved = { ...entity, status: input.status, decidedByUserId: input.decidedByUserId, decidedAt: input.nowIso, updatedAt: input.nowIso };
          stored.set(input.id, resolved);
          return resolved;
        }),
        expirePending: vi.fn((_nowIso: string, _limit: number) => []),
      },
      executionService: {
        resumeRun: vi.fn().mockResolvedValue({}),
        cancelRun: vi.fn().mockResolvedValue({}),
      },
      idGenerator: () => `gen-${++idCounter}`,
      nowIso: () => NOW,
      ...overrides,
    };
  }

  beforeEach(() => {
    idCounter = 0;
  });

  // ── CX-002: resume before commit ──

  describe("CX-002: approve/reject resume before commit", () => {
    it("approve calls resumeRun BEFORE resolvePending", async () => {
      const callOrder: string[] = [];
      const deps = makeDeps();
      const approval = makeApproval();
      (deps.approvalRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(approval);

      (deps.executionService.resumeRun as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push("resumeRun");
        return {};
      });
      (deps.approvalRepo.resolvePending as ReturnType<typeof vi.fn>).mockImplementation((input: { id: string }) => {
        callOrder.push("resolvePending");
        return { ...approval, status: "approved" as const, decidedByUserId: "user-1" };
      });

      const service = createFridayWorkflowApprovalService(deps);
      await service.approve({ approvalId: approval.id, decidedByUserId: "user-1" });

      expect(callOrder).toEqual(["resumeRun", "resolvePending"]);
    });

    it("reject calls resumeRun BEFORE resolvePending", async () => {
      const callOrder: string[] = [];
      const deps = makeDeps();
      const approval = makeApproval();
      (deps.approvalRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(approval);

      (deps.executionService.resumeRun as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push("resumeRun");
        return {};
      });
      (deps.approvalRepo.resolvePending as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push("resolvePending");
        return { ...approval, status: "rejected" as const, decidedByUserId: "user-1" };
      });

      const service = createFridayWorkflowApprovalService(deps);
      await service.reject({ approvalId: approval.id, decidedByUserId: "user-1" });

      expect(callOrder).toEqual(["resumeRun", "resolvePending"]);
    });

    it("re-throws transient errors (approval stays pending)", async () => {
      const deps = makeDeps();
      const approval = makeApproval();
      (deps.approvalRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(approval);

      (deps.executionService.resumeRun as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("database connection lost"),
      );

      const service = createFridayWorkflowApprovalService(deps);
      await expect(
        service.approve({ approvalId: approval.id, decidedByUserId: "user-1" }),
      ).rejects.toThrow("database connection lost");

      // resolvePending should NOT have been called
      expect(deps.approvalRepo.resolvePending).not.toHaveBeenCalled();
    });

    it("swallows INVALID_RUN_TRANSITION and still commits resolution", async () => {
      const deps = makeDeps();
      const approval = makeApproval();
      (deps.approvalRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(approval);

      (deps.executionService.resumeRun as ReturnType<typeof vi.fn>).mockRejectedValue(
        new FridayDomainError("INVALID_RUN_TRANSITION", "already completed", { httpStatus: 409 }),
      );
      (deps.approvalRepo.resolvePending as ReturnType<typeof vi.fn>).mockReturnValue({
        ...approval,
        status: "approved" as const,
      });

      const service = createFridayWorkflowApprovalService(deps);
      const result = await service.approve({ approvalId: approval.id, decidedByUserId: "user-1" });

      expect(result.approval.status).toBe("approved");
      expect(result.resumed).toBe(false);
      expect(deps.approvalRepo.resolvePending).toHaveBeenCalled();
    });
  });

  // ── CX-003: expired approvals unblock runs ──

  describe("CX-003: expirePending unblocks paused runs", () => {
    it("calls resumeRun with rejected for each expired approval", async () => {
      const expired1 = makeApproval({ id: "exp-1", runId: "run-a" });
      const expired2 = makeApproval({ id: "exp-2", runId: "run-b" });

      const deps = makeDeps();
      (deps.approvalRepo.expirePending as ReturnType<typeof vi.fn>).mockReturnValue([
        expired1,
        expired2,
      ]);

      const service = createFridayWorkflowApprovalService(deps);
      const count = await service.expirePending(NOW);

      expect(count).toBe(2);
      expect(deps.executionService.resumeRun).toHaveBeenCalledTimes(2);
      expect(deps.executionService.resumeRun).toHaveBeenCalledWith("run-a", {
        approvalDecision: "rejected",
      });
      expect(deps.executionService.resumeRun).toHaveBeenCalledWith("run-b", {
        approvalDecision: "rejected",
      });
    });

    it("falls back to cancelRun when resumeRun throws", async () => {
      const expired = makeApproval({ id: "exp-1", runId: "run-x" });
      const deps = makeDeps();
      (deps.approvalRepo.expirePending as ReturnType<typeof vi.fn>).mockReturnValue([expired]);
      (deps.executionService.resumeRun as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("run locked"),
      );

      const service = createFridayWorkflowApprovalService(deps);
      const count = await service.expirePending(NOW);

      expect(count).toBe(1);
      expect(deps.executionService.cancelRun).toHaveBeenCalledWith("run-x", "Approval expired");
    });
  });

  // ── CX-004: approver authorization ──

  describe("CX-004: approver authorization", () => {
    it("rejects when approverUserId does not match", async () => {
      const approval = makeApproval({ approverUserId: "specific-user" });
      const deps = makeDeps();
      (deps.approvalRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(approval);

      const service = createFridayWorkflowApprovalService(deps);
      await expect(
        service.approve({ approvalId: approval.id, decidedByUserId: "wrong-user" }),
      ).rejects.toThrow(
        expect.objectContaining({ code: "WORKFLOW_APPROVAL_UNAUTHORIZED" }),
      );
    });

    it("allows when approverUserId matches", async () => {
      const approval = makeApproval({ approverUserId: "right-user" });
      const deps = makeDeps();
      (deps.approvalRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(approval);
      (deps.approvalRepo.resolvePending as ReturnType<typeof vi.fn>).mockReturnValue({
        ...approval,
        status: "approved" as const,
      });

      const service = createFridayWorkflowApprovalService(deps);
      const result = await service.approve({ approvalId: approval.id, decidedByUserId: "right-user" });
      expect(result.approval.status).toBe("approved");
    });

    it("rejects when approverRole requires admin but user is operator", async () => {
      const approval = makeApproval({ approverRole: "admin" });
      const deps = makeDeps({
        resolveUserRole: () => "operator",
      });
      (deps.approvalRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(approval);

      const service = createFridayWorkflowApprovalService(deps);
      await expect(
        service.approve({ approvalId: approval.id, decidedByUserId: "user-1" }),
      ).rejects.toThrow(
        expect.objectContaining({ code: "WORKFLOW_APPROVAL_UNAUTHORIZED" }),
      );
    });

    it("allows when approverRole requires admin and user is owner", async () => {
      const approval = makeApproval({ approverRole: "admin" });
      const deps = makeDeps({
        resolveUserRole: () => "owner",
      });
      (deps.approvalRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(approval);
      (deps.approvalRepo.resolvePending as ReturnType<typeof vi.fn>).mockReturnValue({
        ...approval,
        status: "approved" as const,
      });

      const service = createFridayWorkflowApprovalService(deps);
      const result = await service.approve({ approvalId: approval.id, decidedByUserId: "user-1" });
      expect(result.approval.status).toBe("approved");
    });

    it("allows when no approverUserId/approverRole set (open approval)", async () => {
      const approval = makeApproval(); // no approverUserId, no approverRole
      const deps = makeDeps();
      (deps.approvalRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(approval);
      (deps.approvalRepo.resolvePending as ReturnType<typeof vi.fn>).mockReturnValue({
        ...approval,
        status: "rejected" as const,
      });

      const service = createFridayWorkflowApprovalService(deps);
      const result = await service.reject({ approvalId: approval.id, decidedByUserId: "anyone" });
      expect(result.approval.status).toBe("rejected");
    });

    it("skips role check when resolveUserRole is not provided", async () => {
      const approval = makeApproval({ approverRole: "admin" });
      const deps = makeDeps(); // no resolveUserRole
      (deps.approvalRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(approval);
      (deps.approvalRepo.resolvePending as ReturnType<typeof vi.fn>).mockReturnValue({
        ...approval,
        status: "approved" as const,
      });

      const service = createFridayWorkflowApprovalService(deps);
      // Should not throw even with approverRole set — no resolveUserRole means skip check
      const result = await service.approve({ approvalId: approval.id, decidedByUserId: "user-1" });
      expect(result.approval.status).toBe("approved");
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// CX-008: AbortSignal passthrough to node executor
// ──────────────────────────────────────────────────────────────────────────────

describe("CX-008: AbortSignal passthrough", () => {
  const expressionEvaluator = createFridayExpressionEvaluator();

  function makeInput(
    node: FridayWorkflowNode,
    signal?: AbortSignal,
  ): FridayNodeExecutionInput {
    return {
      runId: "run-1",
      nodeId: node.id,
      attemptId: "att-1",
      node,
      inputData: {},
      expressionContext: { inputs: {}, steps: {} },
      signal,
    };
  }

  it("passes signal to invokeSkill for action nodes (combined with timeout)", async () => {
    let receivedSignal: AbortSignal | undefined;
    const executor = createFridayWorkflowNodeExecutor({
      expressionEvaluator,
      resolveSkill: () => ({}),
      invokeSkill: async (_id, _runId, _nodeId, _payload, signal) => {
        receivedSignal = signal;
        return { ok: true };
      },
      nowIso: () => "2026-01-01T00:00:00Z",
    });

    const ac = new AbortController();
    const node: FridayWorkflowNode = {
      id: "action-1",
      type: "action",
      label: "Action",
      config: { skillId: "my-skill" },
    };

    await executor.executeNode(makeInput(node, ac.signal));
    // Signal is now an AbortSignal.any() combining input signal with a timeout signal
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).not.toBe(ac.signal);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  it("passes signal to invokeSkill for ai nodes", async () => {
    let receivedSignal: AbortSignal | undefined;
    const executor = createFridayWorkflowNodeExecutor({
      expressionEvaluator,
      resolveSkill: () => ({}),
      invokeSkill: async (_id, _runId, _nodeId, _payload, signal) => {
        receivedSignal = signal;
        return { result: "ai response" };
      },
      nowIso: () => "2026-01-01T00:00:00Z",
    });

    const ac = new AbortController();
    const node: FridayWorkflowNode = {
      id: "ai-1",
      type: "ai",
      label: "AI",
      config: { prompt: "Hello", model: "test" },
    };

    await executor.executeNode(makeInput(node, ac.signal));
    expect(receivedSignal).toBe(ac.signal);
  });

  it("does not pass signal for non-skill nodes (trigger, condition, data)", async () => {
    let invokeSkillCalled = false;
    const executor = createFridayWorkflowNodeExecutor({
      expressionEvaluator,
      resolveSkill: () => ({}),
      invokeSkill: async () => {
        invokeSkillCalled = true;
        return {};
      },
      nowIso: () => "2026-01-01T00:00:00Z",
    });

    const ac = new AbortController();
    const triggerNode: FridayWorkflowNode = {
      id: "trigger-1",
      type: "trigger",
      label: "Trigger",
      config: {},
    };

    await executor.executeNode(makeInput(triggerNode, ac.signal));
    expect(invokeSkillCalled).toBe(false); // trigger doesn't invoke skill
  });

  it("signal is a timeout signal when no input signal provided", async () => {
    let receivedSignal: AbortSignal | undefined = undefined;
    const executor = createFridayWorkflowNodeExecutor({
      expressionEvaluator,
      resolveSkill: () => ({}),
      invokeSkill: async (_id, _runId, _nodeId, _payload, signal) => {
        receivedSignal = signal;
        return {};
      },
      nowIso: () => "2026-01-01T00:00:00Z",
    });

    const node: FridayWorkflowNode = {
      id: "action-1",
      type: "action",
      label: "Action",
      config: { skillId: "my-skill" },
    };

    await executor.executeNode(makeInput(node)); // no signal
    // Action nodes now always get a timeout signal even without an input signal
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });
});
