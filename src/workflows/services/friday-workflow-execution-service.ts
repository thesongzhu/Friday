import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import type {
  FridayWorkflowRunEntity,
  FridayWorkflowRunNodeEntity,
  FridayWorkflowStartRunInput,
  JsonObject,
  JsonValue,
  NodeAttemptStatus,
  UUID,
  WorkflowRunStatus,
} from "../model/friday-workflow.types.js";
import {
  type FridayCompiledWorkflowGraphV2,
  type FridayWorkflowExecutionPlan,
  parseGraphJson,
} from "../model/friday-workflow-graph.types.js";
import type { FridayExpressionContext } from "../model/friday-workflow-expression.types.js";
import type { FridayWorkflowRepository } from "../persistence/friday-workflow-repository.js";
import type { FridayWorkflowRunRepository } from "../persistence/friday-workflow-run-repository.js";
import type { FridayWorkflowRunNodeRepository } from "../persistence/friday-workflow-run-node-repository.js";
import type { FridayWorkflowArtifactRepository } from "../persistence/friday-workflow-artifact-repository.js";
import type { FridayWorkflowDagScheduler } from "../engine/friday-workflow-dag-scheduler.js";
import type { FridayWorkflowRunMachine } from "../engine/friday-workflow-run-machine.js";
import type { FridayWorkflowNodeMachine } from "../engine/friday-workflow-node-machine.js";
import type { FridayWorkflowNodeExecutor } from "../engine/friday-workflow-node-executor.js";
import type { FridayWorkflowRetryManager } from "../engine/friday-workflow-retry-manager.js";
import type { FridayWorkflowArtifactWriter } from "../engine/friday-workflow-artifact-writer.js";
import type { FridayExpressionEvaluator } from "../engine/friday-workflow-expression-evaluator.js";

// ─── Interface ───

export interface FridayWorkflowResumeOptions {
  /** For approval nodes: the approval decision (approved/rejected) */
  approvalDecision?: "approved" | "rejected";
}

export interface FridayWorkflowDistributedDispatchRequest {
  runId: UUID;
  workflowId: UUID;
  workflowVersionId: UUID;
  nodeId: string;
  attemptId: UUID;
  attempt: number;
  node: FridayCompiledWorkflowGraphV2["graph"]["nodes"][number];
  inputData: Record<string, unknown>;
  expressionContext: FridayExpressionContext;
  idempotencyKey: string;
}

export type FridayWorkflowDistributedDispatchResult =
  | { kind: "hub" }
  | {
    kind: "satellite_dispatched";
    satelliteId: UUID;
    leaseOwner: string;
    leaseExpiresAt: string;
  }
  | {
    kind: "blocked";
    satelliteId?: UUID;
    code: string;
    message: string;
    retryable: boolean;
    details?: JsonValue;
  };

export interface FridayWorkflowDistributedDispatcher {
  dispatchNode(
    input: FridayWorkflowDistributedDispatchRequest,
  ): Promise<FridayWorkflowDistributedDispatchResult>;
}

export interface FridayWorkflowRemoteNodeResultInput {
  satelliteId: UUID;
  runId: UUID;
  nodeId: string;
  attemptId: UUID;
  attempt: number;
  status: "completed" | "failed";
  output?: JsonValue;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: JsonValue;
  };
}

export interface FridayWorkflowExecutionService {
  setDistributedDispatcher(
    dispatcher: FridayWorkflowDistributedDispatcher | null,
  ): void;
  startRun(
    input: FridayWorkflowStartRunInput,
  ): Promise<FridayWorkflowRunEntity>;
  resumeRun(runId: UUID, options?: FridayWorkflowResumeOptions): Promise<FridayWorkflowRunEntity>;
  pauseRun(
    runId: UUID,
    reason?: string,
  ): Promise<FridayWorkflowRunEntity>;
  cancelRun(
    runId: UUID,
    reason?: string,
  ): Promise<FridayWorkflowRunEntity>;
  retryRun(
    runId: UUID,
    nodeIds?: string[],
  ): Promise<FridayWorkflowRunEntity>;
  getRun(runId: UUID): FridayWorkflowRunEntity | null;
  listRuns(
    workflowId: UUID,
    status?: WorkflowRunStatus,
    limit?: number,
  ): FridayWorkflowRunEntity[];
  listActiveRuns(limit?: number): FridayWorkflowRunEntity[];
  getRunNodes(
    runId: UUID,
    status?: string,
  ): FridayWorkflowRunNodeEntity[];
  recoverActiveRuns(limit?: number): Promise<number>;
  reportRemoteNodeResult(
    input: FridayWorkflowRemoteNodeResultInput,
  ): Promise<FridayWorkflowRunEntity>;
  reapExpiredLeases(): Promise<number>;
  sweepTimedOutRuns(nowIso?: string): Promise<number>;
  sweepTimedOutNodes(nowIso?: string): Promise<number>;
}

// ─── Dependencies ───

export interface CreateWorkflowExecutionServiceDeps {
  db: FridaySqliteLayer;
  workflowRepo: FridayWorkflowRepository;
  runRepo: FridayWorkflowRunRepository;
  nodeRepo: FridayWorkflowRunNodeRepository;
  artifactRepo: FridayWorkflowArtifactRepository;
  dagScheduler: FridayWorkflowDagScheduler;
  runMachine: FridayWorkflowRunMachine;
  nodeMachine: FridayWorkflowNodeMachine;
  nodeExecutor: FridayWorkflowNodeExecutor;
  retryManager: FridayWorkflowRetryManager;
  artifactWriter: FridayWorkflowArtifactWriter;
  expressionEvaluator: FridayExpressionEvaluator;
  idGenerator: () => string;
  nowIso: () => string;
  publishEvent?: (event: string, payload: unknown) => Promise<void>;
  onRunIntake?: (input: {
    runId: UUID;
    workflowId: UUID;
    workflowVersionId: UUID;
    compiledGraph: FridayCompiledWorkflowGraphV2;
    triggerType: string;
    triggerPayload?: JsonObject;
    context?: JsonObject;
  }) => Promise<{ contextPatch?: JsonObject } | void>;
  onRetryDecision?: (input: {
    runId: UUID;
    workflowId: UUID;
    nodeId: string;
    attempt: number;
    errorCode: string;
    shouldRetry: boolean;
    delayMs: number;
    reason: string;
  }) => Promise<{
    shouldRetry: boolean;
    delayMs: number;
    reason: string;
  } | void> | {
    shouldRetry: boolean;
    delayMs: number;
    reason: string;
  } | void;
  onNodeAttemptResult?: (input: {
    runId: UUID;
    workflowId: UUID;
    nodeId: string;
    attempt: number;
    status: "completed" | "failed";
    errorCode?: string;
  }) => Promise<void> | void;
  onRunCompleted?: (input: {
    runId: UUID;
    workflowId: UUID;
    workflowVersionId: UUID;
    status: WorkflowRunStatus;
    plan: FridayWorkflowExecutionPlan;
    failedNodes: number;
    completedNodes: number;
    cancelledNodes: number;
  }) => Promise<void> | void;
  requestNodeApproval?: (input: {
    workflowId: string;
    workflowVersionId: string;
    runId: string;
    runNodeAttemptId: string;
    nodeId: string;
    approverUserId?: string;
    approverRole?: string;
    requestPayload?: Record<string, unknown>;
    timeoutMs?: number;
  }) => Promise<void>;
}

interface WorkflowRetryDecisionSnapshot {
  shouldRetry: boolean;
  delayMs: number;
  reason: string;
}

// ─── Factory ───

export function createFridayWorkflowExecutionService(
  deps: CreateWorkflowExecutionServiceDeps,
): FridayWorkflowExecutionService {
  // In-memory plan cache for active runs
  const activePlans = new Map<string, FridayWorkflowExecutionPlan>();

  // Per-run abort controllers for cancellation propagation
  const activeAbortControllers = new Map<string, AbortController>();
  const activeExecutions = new Set<string>();
  const pendingExecutions = new Set<string>();
  let distributedDispatcher: FridayWorkflowDistributedDispatcher | null = null;

  // Default lease TTL: 5 minutes
  const LEASE_TTL_MS = 300_000;

  interface NodeContextEntry {
    output: Record<string, unknown>;
    status?: "completed" | "failed";
    error?: { code: string; message: string };
  }

  /** Return type for single-node execution within a batch. */
  type NodeExecutionOutcome = {
    nodeId: string;
    status: "completed" | "failed" | "retrying" | "paused" | "dispatched" | "blocked" | "skipped";
    output?: unknown;
    error?: { code: string; message: string; retryable?: boolean };
    satelliteId?: UUID;
  };

  function buildExpressionContext(
    runEntity: FridayWorkflowRunEntity,
    nodeContexts: Map<string, NodeContextEntry>,
  ): FridayExpressionContext {
    const steps: Record<string, NodeContextEntry> = {};
    for (const [nodeId, entry] of nodeContexts) {
      steps[nodeId] = entry;
    }
    return {
      inputs: (runEntity.triggerPayload ?? runEntity.context ?? {}) as Record<
        string,
        unknown
      >,
      steps,
    };
  }

  function loadNodeContexts(runId: string): Map<string, NodeContextEntry> {
    const contexts = new Map<string, NodeContextEntry>();
    deps.db.withReadConnection((db) => {
      // Load ALL terminal nodes (completed AND failed) so failure-condition edges can fire
      const allNodes = deps.nodeRepo.listNodesByRun(db, runId);
      // Use latest attempt per node
      const latestAttempts = new Map<string, FridayWorkflowRunNodeEntity>();
      for (const n of allNodes) {
        const existing = latestAttempts.get(n.nodeId);
        if (!existing || n.attempt > existing.attempt) {
          latestAttempts.set(n.nodeId, n);
        }
      }
      for (const [nodeId, node] of latestAttempts) {
        if (node.status === "completed") {
          const output = node.output != null
            ? (typeof node.output === "object" && !Array.isArray(node.output)
              ? node.output
              : { value: node.output }) as Record<string, unknown>
            : {};
          contexts.set(nodeId, { output, status: "completed" });
        } else if (node.status === "failed") {
          const output = node.output != null
            ? (typeof node.output === "object" && !Array.isArray(node.output)
              ? node.output
              : { value: node.output }) as Record<string, unknown>
            : { status: "failed" };
          contexts.set(nodeId, {
            output,
            status: "failed",
            error: node.error
              ? { code: node.error.code, message: node.error.message }
              : { code: "UNKNOWN", message: "Unknown error" },
          });
        }
      }
    });
    return contexts;
  }

  function normalizeRetryDecision(
    override: WorkflowRetryDecisionSnapshot,
    fallback: WorkflowRetryDecisionSnapshot,
  ): WorkflowRetryDecisionSnapshot {
    const normalizedDelay = Number.isFinite(override.delayMs) && override.delayMs >= 0
      ? Math.floor(override.delayMs)
      : fallback.delayMs;
    const normalizedReason = typeof override.reason === "string" && override.reason.trim().length > 0
      ? override.reason
      : fallback.reason;
    return {
      shouldRetry: typeof override.shouldRetry === "boolean"
        ? override.shouldRetry
        : fallback.shouldRetry,
      delayMs: normalizedDelay,
      reason: normalizedReason,
    };
  }

  async function notifyNodeAttemptResultSafe(input: {
    runId: UUID;
    workflowId: UUID;
    nodeId: string;
    attempt: number;
    status: "completed" | "failed";
    errorCode?: string;
  }): Promise<void> {
    if (!deps.onNodeAttemptResult) {
      return;
    }
    try {
      await deps.onNodeAttemptResult(input);
    } catch (callbackError) {
      await deps.publishEvent?.("workflow.pipeline.retry.attempt_record_error", {
        runId: input.runId,
        workflowId: input.workflowId,
        nodeId: input.nodeId,
        attempt: input.attempt,
        status: input.status,
        errorCode: input.errorCode,
        error: callbackError instanceof Error ? callbackError.message : String(callbackError),
      });
    }
  }

  function resolvePlanForRun(runId: UUID, workflowVersionId: UUID): FridayWorkflowExecutionPlan {
    const cached = activePlans.get(runId);
    if (cached) {
      return cached;
    }
    const version = deps.db.withReadConnection((db) =>
      deps.workflowRepo.getVersionById(db, workflowVersionId),
    );
    if (!version) {
      throw new FridayDomainError("WORKFLOW_VERSION_NOT_FOUND", "Workflow version not found", { httpStatus: 404 });
    }
    return deps.dagScheduler.buildExecutionPlan(runId, parseGraphJson(version.graphJson));
  }

  async function notifyRunCompleted(input: {
    runId: UUID;
    workflowId: UUID;
    workflowVersionId: UUID;
    status: WorkflowRunStatus;
    plan: FridayWorkflowExecutionPlan;
    failedNodes: number;
    completedNodes: number;
    cancelledNodes: number;
  }): Promise<void> {
    if (!deps.onRunCompleted) {
      return;
    }
    try {
      await deps.onRunCompleted(input);
    } catch (error) {
      await deps.publishEvent?.("workflow.pipeline.completion.error", {
        runId: input.runId,
        workflowId: input.workflowId,
        status: input.status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function scheduleRunExecution(plan: FridayWorkflowExecutionPlan): Promise<void> {
    if (activeExecutions.has(plan.runId)) {
      pendingExecutions.add(plan.runId);
      return;
    }

    activeExecutions.add(plan.runId);
    try {
      do {
        pendingExecutions.delete(plan.runId);
        await executeRun(plan);
      } while (pendingExecutions.has(plan.runId));
    } finally {
      activeExecutions.delete(plan.runId);
      pendingExecutions.delete(plan.runId);
    }
  }

  async function persistNodeFailure(input: {
    runId: UUID;
    workflowId: UUID;
    attempt: FridayWorkflowRunNodeEntity;
    node: FridayCompiledWorkflowGraphV2["graph"]["nodes"][number];
    error: {
      code: string;
      message: string;
      retryable: boolean;
      details?: JsonValue;
    };
  }): Promise<"retrying" | "failed"> {
    const baseRetryDecision = deps.retryManager.evaluateRetry(
      input.attempt,
      input.node.retryPolicy,
      input.error.code,
    );

    let effectiveRetryDecision: WorkflowRetryDecisionSnapshot = {
      shouldRetry: baseRetryDecision.shouldRetry,
      delayMs: baseRetryDecision.delayMs,
      reason: baseRetryDecision.reason,
    };

    if (deps.onRetryDecision) {
      try {
        const override = await deps.onRetryDecision({
          runId: input.runId,
          workflowId: input.workflowId,
          nodeId: input.attempt.nodeId,
          attempt: input.attempt.attempt,
          errorCode: input.error.code,
          shouldRetry: baseRetryDecision.shouldRetry,
          delayMs: baseRetryDecision.delayMs,
          reason: baseRetryDecision.reason,
        });

        if (override) {
          effectiveRetryDecision = normalizeRetryDecision(
            override,
            effectiveRetryDecision,
          );
        }
      } catch (callbackError) {
        await deps.publishEvent?.("workflow.pipeline.retry.error", {
          runId: input.runId,
          workflowId: input.workflowId,
          nodeId: input.attempt.nodeId,
          attempt: input.attempt.attempt,
          errorCode: input.error.code,
          error: callbackError instanceof Error ? callbackError.message : String(callbackError),
        });
      }
    }

    await notifyNodeAttemptResultSafe({
      runId: input.runId,
      workflowId: input.workflowId,
      nodeId: input.attempt.nodeId,
      attempt: input.attempt.attempt,
      status: "failed",
      errorCode: input.error.code,
    });

    deps.db.withWriteTransaction((db) => {
      deps.nodeRepo.updateNodeAttempt(db, input.attempt.id, {
        status: "failed",
        error: input.error,
        finishedAt: deps.nowIso(),
        nowIso: deps.nowIso(),
      });
    });

    if (effectiveRetryDecision.shouldRetry) {
      // P2-WF: Cap delay to avoid blocking the execution batch for too long
      if (effectiveRetryDecision.delayMs > 0) {
        const cappedDelay = Math.min(effectiveRetryDecision.delayMs, 30_000);
        await new Promise((resolve) =>
          setTimeout(resolve, cappedDelay),
        );
      }
      return "retrying";
    }

    return "failed";
  }

  // ─── Extracted from executeRun: mark unreachable nodes as cancelled ───

  function cancelDeadEndedNodes(
    runId: UUID,
    deadEndedNodes: string[],
    nodeStatuses: Map<string, NodeAttemptStatus>,
    exprContext: FridayExpressionContext,
  ): void {
    deps.db.withWriteTransaction((db) => {
      for (const nodeId of deadEndedNodes) {
        const currentStatus = nodeStatuses.get(nodeId);
        if (currentStatus) {
          continue;
        }

        const latestAttempt = deps.nodeRepo.getLatestAttempt(db, runId, nodeId);
        if (latestAttempt) {
          nodeStatuses.set(nodeId, latestAttempt.status);
          continue;
        }

        const attemptId = deps.idGenerator();
        const entity: FridayWorkflowRunNodeEntity = {
          id: deps.idGenerator(),
          runId,
          nodeId,
          attempt: 1,
          attemptId,
          status: "cancelled",
          idempotencyKey: deps.retryManager.generateIdempotencyKey(
            runId,
            nodeId,
            1,
          ),
          input: exprContext as unknown as JsonValue,
          finishedAt: deps.nowIso(),
          createdAt: deps.nowIso(),
          updatedAt: deps.nowIso(),
        };

        deps.nodeRepo.insertNodeAttempt(db, entity);
        nodeStatuses.set(nodeId, "cancelled");
      }
    });
  }

  // ─── Extracted from executeRun: create or reuse attempt records for ready nodes ───

  function prepareNodeAttempts(
    runId: UUID,
    readyNodes: string[],
    nodeStatuses: Map<string, NodeAttemptStatus>,
    exprContext: FridayExpressionContext,
  ): FridayWorkflowRunNodeEntity[] {
    const attempts: FridayWorkflowRunNodeEntity[] = [];
    deps.db.withWriteTransaction((db) => {
      for (const nodeId of readyNodes) {
        const currentNodeStatus = nodeStatuses.get(nodeId);
        if (currentNodeStatus === "retrying") {
          const existingAttempt = deps.db.withReadConnection((rdb) =>
            deps.nodeRepo.getLatestAttempt(rdb, runId, nodeId),
          );
          if (existingAttempt && existingAttempt.status === "retrying") {
            attempts.push(existingAttempt);
            continue;
          }
        }

        const latestAttempt = deps.db.withReadConnection((rdb) =>
          deps.nodeRepo.getLatestAttempt(rdb, runId, nodeId),
        );
        const actualAttempt = latestAttempt
          ? latestAttempt.attempt + 1
          : 1;

        const attemptId = deps.idGenerator();
        const idempotencyKey = deps.retryManager.generateIdempotencyKey(
          runId,
          nodeId,
          actualAttempt,
        );

        const entity: FridayWorkflowRunNodeEntity = {
          id: deps.idGenerator(),
          runId,
          nodeId,
          attempt: actualAttempt,
          attemptId,
          status: "queued",
          idempotencyKey,
          // SAFETY: exprContext is a Record-based expression context, runtime-compatible with JsonValue
          input: exprContext as unknown as JsonValue,
          createdAt: deps.nowIso(),
          updatedAt: deps.nowIso(),
        };

        deps.nodeRepo.insertNodeAttempt(db, entity);
        attempts.push(entity);
      }
    });
    return attempts;
  }

  // ─── Extracted from executeRun: execute a single node (approval / satellite / local) ───

  async function executeSingleNode(
    runId: UUID,
    attempt: FridayWorkflowRunNodeEntity,
    plan: FridayWorkflowExecutionPlan,
    runEntity: FridayWorkflowRunEntity,
    nodeContexts: Map<string, NodeContextEntry>,
    runSignal: AbortSignal,
  ): Promise<NodeExecutionOutcome> {
    try {
      const node = plan.nodeMap.get(attempt.nodeId)!;

      // ── Approval nodes: block until explicit decision ──
      if (node.type === "approval") {
        const leaseExpiresAt = new Date(new Date(deps.nowIso()).getTime() + LEASE_TTL_MS).toISOString();
        const leaseAcquired = deps.db.withWriteTransaction((db) =>
          deps.nodeRepo.acquireLease(db, attempt.id, "hub", leaseExpiresAt, deps.nowIso()),
        );
        if (!leaseAcquired) {
          return { nodeId: attempt.nodeId, status: "skipped" };
        }

        deps.db.withWriteTransaction((db) => {
          deps.nodeRepo.updateNodeAttempt(db, attempt.id, {
            status: "blocked_offline",
            nowIso: deps.nowIso(),
          });
        });

        if (deps.requestNodeApproval) {
          const nodeConfig = node.config as Record<string, unknown> | undefined;
          try {
            await deps.requestNodeApproval({
              workflowId: runEntity.workflowId,
              workflowVersionId: runEntity.workflowVersionId,
              runId,
              runNodeAttemptId: attempt.id,
              nodeId: attempt.nodeId,
              approverUserId: nodeConfig?.approverUserId as string | undefined,
              approverRole: nodeConfig?.approverRole as string | undefined,
              requestPayload: nodeConfig?.requestPayload as Record<string, unknown> | undefined,
              timeoutMs: nodeConfig?.timeoutMs as number | undefined,
            });
          } catch (approvalErr) {
            const errMsg = approvalErr instanceof Error ? approvalErr.message : String(approvalErr);
            console.error(
              `[friday] requestNodeApproval failed for run=${runId} node=${attempt.nodeId}: ${errMsg}`,
            );
            await deps.publishEvent?.("workflow.approval.error", {
              runId,
              nodeId: attempt.nodeId,
              attemptId: attempt.id,
              error: errMsg,
            });
          }
        }

        deps.db.withWriteTransaction((db) => {
          deps.runRepo.updateRunStatus(db, runId, "paused", deps.nowIso());
        });

        return { nodeId: attempt.nodeId, status: "paused" };
      }

      // ── Distributed dispatch: route to satellite if available ──
      if (distributedDispatcher) {
        const dispatchResult = await distributedDispatcher.dispatchNode({
          runId,
          workflowId: runEntity.workflowId,
          workflowVersionId: runEntity.workflowVersionId,
          nodeId: attempt.nodeId,
          attemptId: attempt.attemptId,
          attempt: attempt.attempt,
          node,
          inputData: (attempt.input as Record<string, unknown>) ?? {},
          expressionContext: buildExpressionContext(runEntity, nodeContexts),
          idempotencyKey: attempt.idempotencyKey,
        });

        if (dispatchResult.kind === "satellite_dispatched") {
          deps.db.withWriteTransaction((db) => {
            deps.nodeRepo.updateNodeAttempt(db, attempt.id, {
              status: "running",
              satelliteId: dispatchResult.satelliteId,
              leaseOwner: dispatchResult.leaseOwner,
              leaseExpiresAt: dispatchResult.leaseExpiresAt,
              startedAt: deps.nowIso(),
              nowIso: deps.nowIso(),
            });
          });

          await deps.publishEvent?.("workflow.node.started", {
            runId,
            nodeId: attempt.nodeId,
            attempt: attempt.attempt,
            satelliteId: dispatchResult.satelliteId,
          });

          return { nodeId: attempt.nodeId, status: "dispatched", satelliteId: dispatchResult.satelliteId };
        }

        if (dispatchResult.kind === "blocked") {
          deps.db.withWriteTransaction((db) => {
            deps.nodeRepo.updateNodeAttempt(db, attempt.id, {
              status: "blocked_offline",
              satelliteId: dispatchResult.satelliteId,
              error: {
                code: dispatchResult.code,
                message: dispatchResult.message,
                retryable: dispatchResult.retryable,
                details: dispatchResult.details,
              },
              nowIso: deps.nowIso(),
            });
          });

          await deps.publishEvent?.("workflow.node.blocked_offline", {
            runId,
            nodeId: attempt.nodeId,
            attempt: attempt.attempt,
            satelliteId: dispatchResult.satelliteId,
            since: deps.nowIso(),
          });

          return {
            nodeId: attempt.nodeId,
            status: "blocked",
            satelliteId: dispatchResult.satelliteId,
            error: { code: dispatchResult.code, message: dispatchResult.message },
          };
        }
      }

      // ── Local execution: acquire lease and run node on hub ──
      const leaseExpiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
      const leaseAcquired = deps.db.withWriteTransaction((db) =>
        deps.nodeRepo.acquireLease(db, attempt.id, "hub", leaseExpiresAt, deps.nowIso()),
      );
      if (!leaseAcquired) {
        return { nodeId: attempt.nodeId, status: "skipped" };
      }

      const timeoutMs = node.timeoutMs ?? 300_000;
      let nodeTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        deps.nodeExecutor.executeNode({
          runId,
          workflowId: runEntity.workflowId,
          nodeId: attempt.nodeId,
          attemptId: attempt.attemptId,
          node,
          inputData: (attempt.input as Record<string, unknown>) ?? {},
          expressionContext: buildExpressionContext(runEntity, nodeContexts),
          signal: runSignal,
        }),
        new Promise<never>((_, reject) => {
          nodeTimeoutHandle = setTimeout(
            () => reject(new Error("NODE_TIMEOUT")),
            timeoutMs,
          );
        }),
      ]);
      if (nodeTimeoutHandle !== undefined) clearTimeout(nodeTimeoutHandle);

      deps.db.withWriteTransaction((db) => {
        deps.nodeRepo.updateNodeAttempt(db, attempt.id, {
          status: "completed",
          output: result.output,
          finishedAt: deps.nowIso(),
          nowIso: deps.nowIso(),
        });
      });

      await notifyNodeAttemptResultSafe({
        runId,
        workflowId: runEntity.workflowId,
        nodeId: attempt.nodeId,
        attempt: attempt.attempt,
        status: "completed",
      });

      if (result.output != null) {
        deps.artifactWriter.writeJsonArtifact(runId, attempt.nodeId, result.output);
      }

      return { nodeId: attempt.nodeId, status: "completed", output: result.output };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorCode = errorMessage.startsWith("NODE_")
        ? errorMessage.split(":")[0]!
        : "NODE_EXECUTION_FAILED";

      const errorObj = {
        code: errorCode,
        message: errorMessage,
        retryable: true,
      } as const;

      const failureStatus = await persistNodeFailure({
        runId,
        workflowId: runEntity.workflowId,
        attempt,
        node: plan.nodeMap.get(attempt.nodeId)!,
        error: errorObj,
      });

      return { nodeId: attempt.nodeId, status: failureStatus, error: errorObj };
    }
  }

  // ─── Extracted from executeRun: process batch results and apply failure policy ───

  async function applyBatchResults(
    runId: UUID,
    results: PromiseSettledResult<NodeExecutionOutcome>[],
    plan: FridayWorkflowExecutionPlan,
    runEntity: FridayWorkflowRunEntity,
    nodeStatuses: Map<string, NodeAttemptStatus>,
    nodeContexts: Map<string, NodeContextEntry>,
  ): Promise<{ aborted: boolean; paused: boolean; blocked: boolean }> {
    let hasFailure = false;
    let hasPause = false;
    let hasBlocked = false;

    for (const result of results) {
      if (result.status === "rejected") continue;
      const { value } = result;

      if (value.status === "completed") {
        nodeStatuses.set(value.nodeId, "completed");
        if ("output" in value && value.output != null) {
          const outputObj =
            typeof value.output === "object" && !Array.isArray(value.output)
              ? (value.output as Record<string, unknown>)
              : { value: value.output };
          nodeContexts.set(value.nodeId, { output: outputObj, status: "completed" });
        }
      } else if (value.status === "failed") {
        nodeStatuses.set(value.nodeId, "failed");
        if ("error" in value && value.error != null) {
          const errObj = value.error as { code: string; message: string };
          nodeContexts.set(value.nodeId, {
            output: { status: "failed" },
            status: "failed",
            error: { code: errObj.code, message: errObj.message },
          });
        }
        hasFailure = true;
      } else if (value.status === "retrying") {
        nodeStatuses.delete(value.nodeId);
      } else if (value.status === "paused") {
        nodeStatuses.set(value.nodeId, "blocked_offline");
        hasPause = true;
      } else if (value.status === "dispatched") {
        nodeStatuses.set(value.nodeId, "running");
      } else if (value.status === "blocked") {
        nodeStatuses.set(value.nodeId, "blocked_offline");
        hasBlocked = true;
      }
    }

    // Apply failure policy
    if (hasFailure) {
      const policy = plan.failurePolicy;
      switch (policy.onFailure) {
        case "fail_fast": {
          deps.db.withWriteTransaction((db) => {
            deps.nodeRepo.cancelAllPendingNodes(db, runId, deps.nowIso());
            deps.runRepo.finalizeRun(db, runId, "failed", deps.nowIso(), {
              code: "WORKFLOW_FAILED",
              message: "Workflow failed due to fail_fast policy",
            });
          });
          const counts = deps.db.withReadConnection((db) =>
            deps.nodeRepo.countByStatus(db, runId),
          );
          await notifyRunCompleted({
            runId,
            workflowId: runEntity.workflowId,
            workflowVersionId: runEntity.workflowVersionId,
            status: "failed",
            plan,
            failedNodes: counts.failed,
            completedNodes: counts.completed,
            cancelledNodes: counts.cancelled,
          });
          return { aborted: true, paused: false, blocked: false };
        }

        case "continue_on_error":
          break;

        case "pause_for_approval":
          deps.db.withWriteTransaction((db) => {
            deps.runRepo.updateRunStatus(db, runId, "paused", deps.nowIso());
          });
          return { aborted: false, paused: true, blocked: false };

        case "fallback_step":
          if (policy.fallbackStepId) {
            nodeStatuses.delete(policy.fallbackStepId);
          }
          break;

        case "compensate":
          deps.db.withWriteTransaction((db) => {
            deps.runRepo.updateRunStatus(db, runId, "compensating", deps.nowIso());
          });
          return { aborted: false, paused: true, blocked: false };
      }
    }

    if (hasPause) {
      return { aborted: false, paused: true, blocked: false };
    }

    if (hasBlocked) {
      deps.db.withWriteTransaction((db) => {
        deps.runRepo.updateRunStatus(db, runId, "paused", deps.nowIso());
      });
      await deps.publishEvent?.("workflow.run.paused", {
        runId,
        reason: "satellite_blocked_offline",
      });
      return { aborted: false, paused: false, blocked: true };
    }

    return { aborted: false, paused: false, blocked: false };
  }

  // ─── Extracted from executeRun: determine final run status after loop exit ───

  async function finalizeRunStatus(
    runId: UUID,
    plan: FridayWorkflowExecutionPlan,
    aborted: boolean,
  ): Promise<void> {
    if (!aborted) {
      const runEntity = deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      )!;

      if (runEntity.status === "running") {
        const counts = deps.db.withReadConnection((db) =>
          deps.nodeRepo.countByStatus(db, runId),
        );

        if (counts.running > 0 || counts.queued > 0 || counts.retrying > 0) {
          return;
        }

        if (counts.blocked_offline > 0) {
          deps.db.withWriteTransaction((db) => {
            deps.runRepo.updateRunStatus(db, runId, "paused", deps.nowIso());
          });
          await deps.publishEvent?.("workflow.run.paused", {
            runId,
            reason: "satellite_blocked_offline",
          });
          return;
        }

        const finalStatus: WorkflowRunStatus =
          counts.failed > 0 ? "failed" : "completed";

        deps.db.withWriteTransaction((db) => {
          const failure =
            finalStatus === "failed"
              ? {
                  code: "WORKFLOW_NODES_FAILED",
                  message: `${counts.failed} node(s) failed`,
                }
              : undefined;
          deps.runRepo.finalizeRun(db, runId, finalStatus, deps.nowIso(), failure);
        });

        await notifyRunCompleted({
          runId,
          workflowId: runEntity.workflowId,
          workflowVersionId: runEntity.workflowVersionId,
          status: finalStatus,
          plan,
          failedNodes: counts.failed,
          completedNodes: counts.completed,
          cancelledNodes: counts.cancelled,
        });
      }
    }

    const finalRun = deps.db.withReadConnection((db) =>
      deps.runRepo.getRunById(db, runId),
    );
    if (finalRun?.status === "completed" || finalRun?.status === "failed" || finalRun?.status === "cancelled") {
      activePlans.delete(runId);
      activeAbortControllers.delete(runId);
      await deps.publishEvent?.("workflow.run.finished", { runId });
    }
  }

  // ─── Core workflow execution loop ───

  async function executeRun(plan: FridayWorkflowExecutionPlan): Promise<void> {
    const runId = plan.runId;

    // Set up abort controller for this run
    let abortController = activeAbortControllers.get(runId);
    if (!abortController) {
      abortController = new AbortController();
      activeAbortControllers.set(runId, abortController);
    }
    const runSignal = abortController.signal;

    let runEntity = deps.db.withReadConnection((db) =>
      deps.runRepo.getRunById(db, runId),
    )!;

    // Transition to running
    if (runEntity.status !== "running") {
      deps.runMachine.assertTransition(runEntity.status, "running");
      deps.db.withWriteTransaction((db) => {
        deps.runRepo.updateRunStatus(db, runId, "running", deps.nowIso());
      });
    }

    const nodeContexts = loadNodeContexts(runId);

    // Build initial node status map from DB
    const nodeStatuses = new Map<string, NodeAttemptStatus>();
    deps.db.withReadConnection((db) => {
      const allNodes = deps.nodeRepo.listNodesByRun(db, runId);
      const latestAttempts = new Map<string, FridayWorkflowRunNodeEntity>();
      for (const n of allNodes) {
        const existing = latestAttempts.get(n.nodeId);
        if (!existing || n.attempt > existing.attempt) {
          latestAttempts.set(n.nodeId, n);
        }
      }
      for (const [nodeId, node] of latestAttempts) {
        nodeStatuses.set(nodeId, node.status);
      }
    });

    let aborted = false;

    // Main execution loop
    while (!aborted) {
      // Reload run entity to check for external cancellation
      runEntity = deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      )!;
      if (
        runEntity.status === "cancelled" ||
        runEntity.status === "paused" ||
        runEntity.status === "pausing"
      ) {
        break;
      }

      const exprContext = buildExpressionContext(runEntity, nodeContexts);
      const schedulingResult = deps.dagScheduler.computeSchedulingResult(
        plan.adjacency,
        nodeStatuses,
        plan.compiledGraph,
        exprContext,
        deps.expressionEvaluator,
      );
      const { readyNodes, deadEndedNodes } = schedulingResult;

      if (deadEndedNodes.length > 0) {
        cancelDeadEndedNodes(runId, deadEndedNodes, nodeStatuses, exprContext);
      }

      if (readyNodes.length === 0) {
        if (deadEndedNodes.length === 0) {
          break;
        }
        continue;
      }

      const attempts = prepareNodeAttempts(runId, readyNodes, nodeStatuses, exprContext);

      // Execute batch
      const results = await Promise.allSettled(
        attempts.map((attempt) =>
          executeSingleNode(runId, attempt, plan, runEntity, nodeContexts, runSignal),
        ),
      );

      // Process results and apply failure policy
      const outcome = await applyBatchResults(runId, results, plan, runEntity, nodeStatuses, nodeContexts);
      if (outcome.aborted) {
        aborted = true;
        return;
      }
      if (outcome.paused || outcome.blocked) {
        return;
      }
    }

    await finalizeRunStatus(runId, plan, aborted);
  }

  return {
    setDistributedDispatcher(dispatcher) {
      distributedDispatcher = dispatcher;
    },

    async startRun(input) {
      const workflowState = deps.db.withReadConnection((db) =>
        db
          .prepare("SELECT is_archived, deleted_at, owner_user_id FROM workflows WHERE id = ? LIMIT 1")
          .get(input.workflowId) as { is_archived: number; deleted_at: string | null; owner_user_id: string | null } | undefined,
      );
      if (!workflowState) {
        throw new FridayDomainError("WORKFLOW_NOT_FOUND", "Workflow not found", { httpStatus: 404 });
      }
      if (workflowState.is_archived === 1 || workflowState.deleted_at != null) {
        throw new FridayDomainError("WORKFLOW_ARCHIVED", "Workflow is archived", { httpStatus: 410 });
      }

      // C-2: Enforce ownership/entitlement — if workflow has an owner, only the
      // owner or a system/trigger-initiated start may proceed.
      if (
        workflowState.owner_user_id &&
        input.startedByUserId &&
        workflowState.owner_user_id !== input.startedByUserId &&
        input.triggerType !== "webhook" &&
        input.triggerType !== "schedule" &&
        input.triggerType !== "system"
      ) {
        throw new FridayDomainError(
          "WORKFLOW_PERMISSION_DENIED",
          "You do not have permission to run this workflow",
          { httpStatus: 403 },
        );
      }

      // Resolve version
      let versionId = input.workflowVersionId;
      let compiledGraph: FridayCompiledWorkflowGraphV2;

      if (!versionId) {
        const version = deps.db.withReadConnection((db) =>
          deps.workflowRepo.getPublishedVersion(db, input.workflowId),
        );
        if (!version) {
          throw new FridayDomainError("WORKFLOW_NO_PUBLISHED_VERSION", "Workflow has no published version", { httpStatus: 404 });
        }
        versionId = version.id;
        compiledGraph = parseGraphJson(version.graphJson);
      } else {
        const version = deps.db.withReadConnection((db) =>
          deps.workflowRepo.getVersionById(db, versionId!),
        );
        if (!version) {
          throw new FridayDomainError("WORKFLOW_VERSION_NOT_FOUND", "Workflow version not found", { httpStatus: 404 });
        }
        compiledGraph = parseGraphJson(version.graphJson);
      }

      const runId = deps.idGenerator();
      const nowIso = deps.nowIso();
      let runContext = input.context;

      if (deps.onRunIntake) {
        try {
          const intake = await deps.onRunIntake({
            runId,
            workflowId: input.workflowId,
            workflowVersionId: versionId,
            compiledGraph,
            triggerType: input.triggerType,
            triggerPayload: input.triggerPayload,
            context: input.context,
          });
          if (intake?.contextPatch) {
            runContext = {
              ...(runContext ?? {}),
              ...intake.contextPatch,
            };
          }
        } catch (error) {
          await deps.publishEvent?.("workflow.pipeline.intake.error", {
            runId,
            workflowId: input.workflowId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const runEntity: FridayWorkflowRunEntity = {
        id: runId,
        workflowId: input.workflowId,
        workflowVersionId: versionId,
        status: "queued",
        triggerType: input.triggerType ?? "manual",
        triggerPayload: input.triggerPayload,
        startedByUserId: input.startedByUserId,
        startedBySatelliteId: input.startedBySatelliteId,
        startedAt: nowIso,
        correlationId: input.correlationId,
        context: runContext,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      deps.db.withWriteTransaction((db) => {
        deps.runRepo.insertRun(db, runEntity);
      });

      if (input.dryRun) {
        return runEntity;
      }

      // Build execution plan
      const plan = deps.dagScheduler.buildExecutionPlan(
        runId,
        compiledGraph,
      );
      activePlans.set(runId, plan);

      // Start execution (non-blocking)
      scheduleRunExecution(plan).catch(async (error) => {
        try {
          const errorMessage = error instanceof Error ? error.message : String(error);
          void deps.publishEvent?.("workflow.run.error", {
            runId,
            code: "E-WF-RUN-ASYNC-001",
            message: `Unhandled workflow execution error for run ${runId}: ${errorMessage}`,
          });
          // Ensure run is marked failed on unhandled errors
          deps.db.withWriteTransaction((db) => {
            deps.runRepo.finalizeRun(db, runId, "failed", deps.nowIso(), {
              code: "WORKFLOW_EXECUTION_ERROR",
              message: `Unhandled execution error: ${errorMessage}`,
            });
          });
          const counts = deps.db.withReadConnection((db) =>
            deps.nodeRepo.countByStatus(db, runId),
          );
          await notifyRunCompleted({
            runId,
            workflowId: input.workflowId,
            workflowVersionId: versionId,
            status: "failed",
            plan,
            failedNodes: counts.failed,
            completedNodes: counts.completed,
            cancelledNodes: counts.cancelled,
          });
        } catch (innerError) {
          // Last-resort: prevent unhandled rejection from crashing the process
          const msg = innerError instanceof Error ? innerError.message : String(innerError);
          void deps.publishEvent?.("workflow.run.error", {
            runId,
            code: "E-WF-RUN-ASYNC-001-INNER",
            message: `Failed to finalize run ${runId} after execution error: ${msg}`,
          });
        }
      });

      // Return the queued run entity
      return runEntity;
    },

    async resumeRun(runId, options) {
      const runEntity = deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      );
      if (!runEntity) throw new FridayDomainError("WORKFLOW_RUN_NOT_FOUND", "Workflow run not found", { httpStatus: 404 });

      deps.runMachine.assertTransition(runEntity.status, "running");

      // Rebuild plan from version (needed before checking approval nodes)
      const version = deps.db.withReadConnection((db) =>
        deps.workflowRepo.getVersionById(db, runEntity.workflowVersionId),
      );
      if (!version) throw new FridayDomainError("WORKFLOW_VERSION_NOT_FOUND", "Workflow version not found", { httpStatus: 404 });

      const compiledGraph = parseGraphJson(version.graphJson);
      const plan = deps.dagScheduler.buildExecutionPlan(runId, compiledGraph);
      activePlans.set(runId, plan);

      // Check for blocked approval nodes that need a decision
      const blockedNodes = deps.db.withReadConnection((db) =>
        deps.nodeRepo.listNodesByRun(db, runId, "blocked_offline" as NodeAttemptStatus),
      );

      const approvalNodes = blockedNodes.filter((n) => {
        const graphNode = plan.nodeMap.get(n.nodeId);
        return graphNode?.type === "approval";
      });
      const remoteBlockedNodes = blockedNodes.filter((n) => {
        const graphNode = plan.nodeMap.get(n.nodeId);
        return graphNode?.type !== "approval";
      });

      if (approvalNodes.length > 0) {
        // Approval nodes require an explicit decision
        if (!options?.approvalDecision) {
          throw new FridayDomainError("WORKFLOW_APPROVAL_DECISION_REQUIRED", "Approval decision is required before continuing", { httpStatus: 400 });
        }

        if (options.approvalDecision === "rejected") {
          // Short-circuit: mark approval nodes as failed and fail the run immediately
          deps.db.withWriteTransaction((db) => {
            for (const approvalNode of approvalNodes) {
              deps.nodeRepo.updateNodeAttempt(db, approvalNode.id, {
                status: "failed",
                error: {
                  code: "APPROVAL_REJECTED",
                  message: "Approval was rejected",
                  retryable: false,
                },
                finishedAt: deps.nowIso(),
                nowIso: deps.nowIso(),
              });
            }
            deps.nodeRepo.cancelAllPendingNodes(db, runId, deps.nowIso());
            deps.runRepo.finalizeRun(db, runId, "failed", deps.nowIso(), {
              code: "APPROVAL_REJECTED",
              message: "Workflow failed because approval was rejected",
            });
          });
          const counts = deps.db.withReadConnection((db) =>
            deps.nodeRepo.countByStatus(db, runId),
          );
          await notifyRunCompleted({
            runId,
            workflowId: runEntity.workflowId,
            workflowVersionId: runEntity.workflowVersionId,
            status: "failed",
            plan,
            failedNodes: counts.failed,
            completedNodes: counts.completed,
            cancelledNodes: counts.cancelled,
          });
          activePlans.delete(runId);
          return deps.db.withReadConnection((db) =>
            deps.runRepo.getRunById(db, runId),
          )!;
        }

        // Approved: mark approval nodes as completed
        deps.db.withWriteTransaction((db) => {
          for (const approvalNode of approvalNodes) {
            deps.nodeRepo.updateNodeAttempt(db, approvalNode.id, {
              status: "completed",
              output: { approved: true, pending: false },
              finishedAt: deps.nowIso(),
              nowIso: deps.nowIso(),
            });
          }
        });
      }

      if (remoteBlockedNodes.length > 0) {
        deps.db.withWriteTransaction((db) => {
          for (const blockedNode of remoteBlockedNodes) {
            const retryEntity: FridayWorkflowRunNodeEntity = {
              id: deps.idGenerator(),
              runId,
              nodeId: blockedNode.nodeId,
              attempt: blockedNode.attempt + 1,
              attemptId: deps.idGenerator(),
              status: "retrying",
              idempotencyKey: deps.retryManager.generateIdempotencyKey(
                runId,
                blockedNode.nodeId,
                blockedNode.attempt + 1,
              ),
              input: blockedNode.input,
              createdAt: deps.nowIso(),
              updatedAt: deps.nowIso(),
            };

            deps.nodeRepo.insertNodeAttempt(db, retryEntity);
          }
        });
      }

      deps.db.withWriteTransaction((db) => {
        deps.runRepo.updateRunStatus(db, runId, "running", deps.nowIso());
      });

      scheduleRunExecution(plan).catch(async (error) => {
        try {
          const errorMessage = error instanceof Error ? error.message : String(error);
          void deps.publishEvent?.("workflow.run.error", {
            runId,
            code: "E-WF-RUN-ASYNC-002",
            message: `Resume execution failed for run ${runId}: ${errorMessage}`,
          });
          // P1-RT-001: Mark run as failed on unhandled resume errors
          deps.db.withWriteTransaction((db) => {
            deps.runRepo.finalizeRun(db, runId, "failed", deps.nowIso(), {
              code: "WORKFLOW_EXECUTION_ERROR",
              message: `Resume execution error: ${errorMessage}`,
            });
          });
          const counts = deps.db.withReadConnection((db) =>
            deps.nodeRepo.countByStatus(db, runId),
          );
          await notifyRunCompleted({
            runId,
            workflowId: runEntity.workflowId,
            workflowVersionId: runEntity.workflowVersionId,
            status: "failed",
            plan,
            failedNodes: counts.failed,
            completedNodes: counts.completed,
            cancelledNodes: counts.cancelled,
          });
        } catch (innerError) {
          const msg = innerError instanceof Error ? innerError.message : String(innerError);
          void deps.publishEvent?.("workflow.run.error", {
            runId,
            code: "E-WF-RUN-ASYNC-002-INNER",
            message: `Failed to finalize resumed run ${runId}: ${msg}`,
          });
        }
      });

      return deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      )!;
    },

    async pauseRun(runId, reason) {
      const runEntity = deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      );
      if (!runEntity) {
        throw new FridayDomainError("WORKFLOW_RUN_NOT_FOUND", "Workflow run not found", { httpStatus: 404 });
      }
      if (runEntity.status === "paused") {
        return runEntity;
      }
      if (runEntity.status === "completed" || runEntity.status === "failed" || runEntity.status === "cancelled") {
        throw new FridayDomainError(
          "WORKFLOW_RUN_NOT_PAUSABLE",
          `Workflow run ${runId} is '${runEntity.status}' and cannot be paused`,
          { httpStatus: 409 },
        );
      }

      deps.db.withWriteTransaction((db) => {
        deps.runRepo.updateRunStatus(db, runId, "paused", deps.nowIso());
      });
      await deps.publishEvent?.("workflow.run.paused", {
        runId,
        ...(reason ? { reason } : {}),
      });
      return deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      )!;
    },

    async cancelRun(runId, reason) {
      const runEntity = deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      );
      if (!runEntity) throw new FridayDomainError("WORKFLOW_RUN_NOT_FOUND", "Workflow run not found", { httpStatus: 404 });

      deps.runMachine.assertTransition(runEntity.status, "cancelled");

      // Abort in-flight node executions
      const controller = activeAbortControllers.get(runId);
      if (controller) {
        controller.abort();
        activeAbortControllers.delete(runId);
      }

      deps.db.withWriteTransaction((db) => {
        deps.nodeRepo.cancelAllPendingNodes(db, runId, deps.nowIso());
        deps.runRepo.finalizeRun(db, runId, "cancelled", deps.nowIso(), {
          code: "WORKFLOW_CANCELLED",
          message: reason ?? "Cancelled by user",
        });
      });

      const counts = deps.db.withReadConnection((db) =>
        deps.nodeRepo.countByStatus(db, runId),
      );
      await notifyRunCompleted({
        runId,
        workflowId: runEntity.workflowId,
        workflowVersionId: runEntity.workflowVersionId,
        status: "cancelled",
        plan: resolvePlanForRun(runId, runEntity.workflowVersionId),
        failedNodes: counts.failed,
        completedNodes: counts.completed,
        cancelledNodes: counts.cancelled,
      });

      activePlans.delete(runId);

      return deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      )!;
    },

    async retryRun(runId, nodeIds) {
      const runEntity = deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      );
      if (!runEntity) throw new FridayDomainError("WORKFLOW_RUN_NOT_FOUND", "Workflow run not found", { httpStatus: 404 });

      deps.runMachine.assertTransition(runEntity.status, "running");

      // Get failed nodes (latest attempt per node)
      const failedNodes = deps.db.withReadConnection((db) => {
        const allNodes = deps.nodeRepo.listNodesByRun(db, runId);
        const latestAttempts = new Map<string, FridayWorkflowRunNodeEntity>();
        for (const n of allNodes) {
          const existing = latestAttempts.get(n.nodeId);
          if (!existing || n.attempt > existing.attempt) {
            latestAttempts.set(n.nodeId, n);
          }
        }
        return Array.from(latestAttempts.values()).filter(
          (n) => n.status === "failed",
        );
      });

      const targetNodes = nodeIds
        ? failedNodes.filter((n) => nodeIds.includes(n.nodeId))
        : failedNodes;

      if (targetNodes.length === 0) {
        throw new FridayDomainError("WORKFLOW_NO_FAILED_NODES_TO_RETRY", "No failed nodes available to retry", { httpStatus: 400 });
      }

      // Rebuild plan
      const version = deps.db.withReadConnection((db) =>
        deps.workflowRepo.getVersionById(db, runEntity.workflowVersionId),
      );
      if (!version) throw new FridayDomainError("WORKFLOW_VERSION_NOT_FOUND", "Workflow version not found", { httpStatus: 404 });

      const compiledGraph = parseGraphJson(version.graphJson);
      const plan = deps.dagScheduler.buildExecutionPlan(runId, compiledGraph);
      activePlans.set(runId, plan);

      // Create new retry attempts for failed nodes so the scheduler picks them up
      deps.db.withWriteTransaction((db) => {
        for (const failedNode of targetNodes) {
          const newAttemptNumber = failedNode.attempt + 1;
          const attemptId = deps.idGenerator();
          const idempotencyKey = deps.retryManager.generateIdempotencyKey(
            runId,
            failedNode.nodeId,
            newAttemptNumber,
          );

          const retryEntity: FridayWorkflowRunNodeEntity = {
            id: deps.idGenerator(),
            runId,
            nodeId: failedNode.nodeId,
            attempt: newAttemptNumber,
            attemptId,
            status: "retrying",
            idempotencyKey,
            input: failedNode.input,
            createdAt: deps.nowIso(),
            updatedAt: deps.nowIso(),
          };

          deps.nodeRepo.insertNodeAttempt(db, retryEntity);
        }

        deps.runRepo.updateRunStatus(db, runId, "running", deps.nowIso());
      });

      scheduleRunExecution(plan).catch(async (error) => {
        try {
          const errorMessage = error instanceof Error ? error.message : String(error);
          void deps.publishEvent?.("workflow.run.error", {
            runId,
            code: "E-WF-RUN-ASYNC-003",
            message: `Retry execution failed for run ${runId}: ${errorMessage}`,
          });
          // P1-RT-002: Mark run as failed on unhandled retry errors
          deps.db.withWriteTransaction((db) => {
            deps.runRepo.finalizeRun(db, runId, "failed", deps.nowIso(), {
              code: "WORKFLOW_EXECUTION_ERROR",
              message: `Retry execution error: ${errorMessage}`,
            });
          });
          const counts = deps.db.withReadConnection((db) =>
            deps.nodeRepo.countByStatus(db, runId),
          );
          await notifyRunCompleted({
            runId,
            workflowId: runEntity.workflowId,
            workflowVersionId: runEntity.workflowVersionId,
            status: "failed",
            plan,
            failedNodes: counts.failed,
            completedNodes: counts.completed,
            cancelledNodes: counts.cancelled,
          });
        } catch (innerError) {
          const msg = innerError instanceof Error ? innerError.message : String(innerError);
          void deps.publishEvent?.("workflow.run.error", {
            runId,
            code: "E-WF-RUN-ASYNC-003-INNER",
            message: `Failed to finalize retried run ${runId}: ${msg}`,
          });
        }
      });

      return deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      )!;
    },

    getRun(runId) {
      return deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, runId),
      );
    },

    listRuns(workflowId, status, limit) {
      return deps.db.withReadConnection((db) =>
        deps.runRepo.listRunsByWorkflow(db, workflowId, status, limit),
      );
    },

    listActiveRuns(limit) {
      const runs = deps.db.withReadConnection((db) =>
        deps.runRepo.listActiveRuns(db),
      );
      return typeof limit === "number" ? runs.slice(0, limit) : runs;
    },

    getRunNodes(runId, status) {
      return deps.db.withReadConnection((db) =>
        deps.nodeRepo.listNodesByRun(
          db,
          runId,
          status as NodeAttemptStatus | undefined,
        ),
      );
    },

    async recoverActiveRuns(limit?: number) {
      const activeRuns = deps.db.withReadConnection((db) =>
        deps.runRepo.listActiveRuns(db),
      );

      const runsToRecover = limit != null ? activeRuns.slice(0, limit) : activeRuns;
      let recovered = 0;

      for (const run of runsToRecover) {
        const version = deps.db.withReadConnection((db) =>
          deps.workflowRepo.getVersionById(db, run.workflowVersionId),
        );
        if (!version) continue;

        const compiledGraph = parseGraphJson(version.graphJson);
        const plan = deps.dagScheduler.buildExecutionPlan(
          run.id,
          compiledGraph,
        );
        activePlans.set(run.id, plan);

        scheduleRunExecution(plan).catch(async (error) => {
          try {
            const errorMessage = error instanceof Error ? error.message : String(error);
            void deps.publishEvent?.("workflow.run.error", {
              runId: run.id,
              code: "E-WF-RUN-ASYNC-004",
              message: `Recovery execution failed for run ${run.id}: ${errorMessage}`,
            });
            // P1-RT-003: Mark run as failed on unhandled recovery errors
            deps.db.withWriteTransaction((db) => {
              deps.runRepo.finalizeRun(db, run.id, "failed", deps.nowIso(), {
                code: "WORKFLOW_EXECUTION_ERROR",
                message: `Recovery execution error: ${errorMessage}`,
              });
            });
            const counts = deps.db.withReadConnection((db) =>
              deps.nodeRepo.countByStatus(db, run.id),
            );
            await notifyRunCompleted({
              runId: run.id,
              workflowId: run.workflowId,
              workflowVersionId: run.workflowVersionId,
              status: "failed",
              plan,
              failedNodes: counts.failed,
              completedNodes: counts.completed,
              cancelledNodes: counts.cancelled,
            });
          } catch (innerError) {
            const msg = innerError instanceof Error ? innerError.message : String(innerError);
            void deps.publishEvent?.("workflow.run.error", {
              runId: run.id,
              code: "E-WF-RUN-ASYNC-004-INNER",
              message: `Failed to finalize recovered run ${run.id}: ${msg}`,
            });
          }
        });
        recovered++;
      }

      return recovered;
    },

    async reportRemoteNodeResult(input) {
      const runEntity = deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, input.runId),
      );
      if (!runEntity) {
        throw new FridayDomainError("WORKFLOW_RUN_NOT_FOUND", "Workflow run not found", { httpStatus: 404 });
      }

      const attemptEntity = deps.db.withReadConnection((db) =>
        deps.nodeRepo.getNodeAttemptByAttemptId(db, input.attemptId),
      );
      if (!attemptEntity || attemptEntity.runId !== input.runId || attemptEntity.nodeId !== input.nodeId) {
        throw new FridayDomainError("WORKFLOW_RUN_NODE_NOT_FOUND", "Workflow node attempt not found", {
          httpStatus: 404,
        });
      }
      if (attemptEntity.attempt !== input.attempt) {
        throw new FridayDomainError("WORKFLOW_RUN_NODE_ATTEMPT_MISMATCH", "Workflow node attempt number mismatch", {
          httpStatus: 409,
        });
      }
      if (attemptEntity.status === "completed" && input.status === "completed") {
        return runEntity;
      }
      if (attemptEntity.status === "failed" && input.status === "failed") {
        return runEntity;
      }
      if (attemptEntity.status === "completed" || attemptEntity.status === "failed" || attemptEntity.status === "cancelled") {
        throw new FridayDomainError(
          "WORKFLOW_RUN_NODE_TERMINAL",
          "Workflow node attempt is already terminal",
          { httpStatus: 409 },
        );
      }

      const plan = resolvePlanForRun(input.runId, runEntity.workflowVersionId);
      activePlans.set(input.runId, plan);
      const graphNode = plan.nodeMap.get(input.nodeId);
      if (!graphNode) {
        throw new FridayDomainError("WORKFLOW_NODE_NOT_FOUND", "Workflow node not found in execution plan", {
          httpStatus: 404,
        });
      }

      if (input.status === "completed") {
        deps.db.withWriteTransaction((db) => {
          deps.nodeRepo.updateNodeAttempt(db, attemptEntity.id, {
            status: "completed",
            satelliteId: input.satelliteId,
            finishedAt: deps.nowIso(),
            output: input.output,
            nowIso: deps.nowIso(),
          });
          deps.runRepo.updateRunStatus(db, input.runId, "running", deps.nowIso());
        });

        await notifyNodeAttemptResultSafe({
          runId: input.runId,
          workflowId: runEntity.workflowId,
          nodeId: input.nodeId,
          attempt: input.attempt,
          status: "completed",
        });

        if (input.output != null) {
          deps.artifactWriter.writeJsonArtifact(
            input.runId,
            input.nodeId,
            input.output,
          );
        }
      } else {
        await persistNodeFailure({
          runId: input.runId,
          workflowId: runEntity.workflowId,
          attempt: attemptEntity,
          node: graphNode,
          error: input.error ?? {
            code: "SATELLITE_NODE_FAILED",
            message: "Satellite node execution failed",
            retryable: true,
          },
        });
      }

      await scheduleRunExecution(plan);

      return deps.db.withReadConnection((db) =>
        deps.runRepo.getRunById(db, input.runId),
      )!;
    },

    async reapExpiredLeases() {
      const nowIso = deps.nowIso();
      const expired = deps.db.withReadConnection((db) =>
        deps.nodeRepo.listExpiredLeases(db, nowIso),
      );

      let reaped = 0;
      for (const node of expired) {
        const plan = activePlans.get(node.runId);
        const graphNode = plan?.nodeMap.get(node.nodeId);
        const retryPolicy = graphNode?.retryPolicy;

        const decision = deps.retryManager.evaluateRetry(
          node,
          retryPolicy,
          "NODE_TIMEOUT",
        );

        deps.db.withWriteTransaction((db) => {
          if (decision.shouldRetry) {
            deps.nodeRepo.updateNodeAttempt(db, node.id, {
              status: "failed",
              error: {
                code: "NODE_TIMEOUT",
                message: "Node lease expired",
                retryable: true,
              },
              finishedAt: nowIso,
              nowIso,
            });
          } else {
            deps.nodeRepo.updateNodeAttempt(db, node.id, {
              status: "failed",
              error: {
                code: "NODE_TIMEOUT",
                message: "Node lease expired, retries exhausted",
                retryable: false,
              },
              finishedAt: nowIso,
              nowIso,
            });
          }
        });

        reaped++;
      }

      return reaped;
    },

    async sweepTimedOutRuns(nowIso?: string) {
      const now = nowIso ?? deps.nowIso();
      // Find active runs that have exceeded their deadline
      const activeRuns = deps.db.withReadConnection((db) =>
        deps.runRepo.listActiveRuns(db),
      );

      let swept = 0;
      for (const run of activeRuns) {
        // Check if run has a deadline (set via version config runTimeoutMs)
        const version = deps.db.withReadConnection((db) =>
          deps.workflowRepo.getVersionById(db, run.workflowVersionId),
        );
        if (!version) continue;

        const compiledGraph = parseGraphJson(version.graphJson);

        // Run timeout from graph variables or default 1h
        const graphVars = compiledGraph.graph.variables ?? {};
        const runTimeoutMs =
          (typeof graphVars.runTimeoutMs === "number" ? graphVars.runTimeoutMs : null) ?? 3_600_000;

        const startedAtMs = new Date(run.startedAt).getTime();
        const nowMs = new Date(now).getTime();

        if (nowMs - startedAtMs >= runTimeoutMs) {
          deps.db.withWriteTransaction((db) => {
            deps.nodeRepo.cancelAllPendingNodes(db, run.id, now);
            deps.runRepo.finalizeRun(db, run.id, "failed", now, {
              code: "WORKFLOW_RUN_TIMEOUT",
              message: `Run exceeded timeout of ${runTimeoutMs}ms`,
            });
          });
          activePlans.delete(run.id);
          swept++;
        }
      }

      return swept;
    },

    async sweepTimedOutNodes(nowIso?: string) {
      const now = nowIso ?? deps.nowIso();
      const nowMs = new Date(now).getTime();

      // Find running nodes that have exceeded their timeout
      const activeRuns = deps.db.withReadConnection((db) =>
        deps.runRepo.listActiveRuns(db),
      );

      let swept = 0;
      for (const run of activeRuns) {
        const nodes = deps.db.withReadConnection((db) =>
          deps.nodeRepo.listNodesByRun(db, run.id, "running" as NodeAttemptStatus),
        );

        for (const node of nodes) {
          const plan = activePlans.get(run.id);
          const graphNode = plan?.nodeMap.get(node.nodeId);
          const nodeTimeoutMs = graphNode?.timeoutMs ?? 300_000; // 5min default

          const nodeStartedAt = node.startedAt ?? node.createdAt;
          const nodeStartMs = new Date(nodeStartedAt).getTime();

          if (nowMs - nodeStartMs >= nodeTimeoutMs) {
            deps.db.withWriteTransaction((db) => {
              deps.nodeRepo.updateNodeAttempt(db, node.id, {
                status: "failed",
                error: {
                  code: "NODE_TIMEOUT",
                  message: `Node exceeded timeout of ${nodeTimeoutMs}ms`,
                  retryable: false,
                },
                finishedAt: now,
                nowIso: now,
              });
            });
            swept++;
          }
        }
      }

      return swept;
    },
  };
}
