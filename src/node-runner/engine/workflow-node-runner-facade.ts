/**
 * Workflow NodeRunner Facade — bridges the workflow node executor interface
 * to the NodeRunner 6-step deterministic pipeline.
 *
 * This facade implements `FridayWorkflowNodeExecutor` so it can be used
 * as a drop-in replacement in the workflow execution service. Under the hood
 * it routes execution through the NodeRunner pipeline with all 6 steps:
 * load → pre-validate → pre-rules → execute → post-validate → post-rules.
 *
 * For node types without a registered adapter (e.g. unknown future types),
 * the facade falls back to the legacy direct executor if one is provided.
 *
 * **B4 truth-labeling note (proof_pending; NOT wired into production):**
 * `createWorkflowNodeRunnerFacade` has zero production call sites as of
 * the B4 capability inventory. The actual workflow runtime imports
 * `createFridayWorkflowNodeRunnerFacade` from
 * `src/workflows/engine/friday-workflow-node-runner-facade.ts` — a
 * different file with similar shape. The only caller of this module is
 * the existing integration test at
 * `test/integration/node-runner/friday-node-runner-pipeline-integration.test.ts`.
 *
 * Known contract gap (preserved, not fixed in this slice): the facade
 * builds a `FridayNodeExecutionContext` with `workflowId: "" as UUID`
 * (around line 203) because `FridayNodeExecutionInput` does not carry
 * the workflow id. A future "wire-node-runner-into-production" slice
 * must thread the workflow id through the input shape before this
 * facade can replace the production path.
 *
 * The export is preserved via the parent barrel so the future wiring
 * slice can hook it without a contract break. A one-time `console.info`
 * advisory fires at first construction so anyone wiring it in
 * production sees the proof_pending state in logs.
 *
 * @module node-runner/engine
 */

import { FridayDomainError } from "#errors";
import * as crypto from "node:crypto";

import type {
  FridayNodeAdapterRegistry,
  FridayNodeExecutionContext,
  FridayNodeRunnerPipeline,
  FridayNodeRunnerPipelineConfig,
} from "../model/friday-node-runner.types.js";

import type {
  FridayEvaluationContext,
  FridayEvaluationResult,
  ISODateTime,
  JsonObject,
  UUID,
} from "../../rules/model/friday-rules-engine.types.js";

import type {
  FridayNodeExecutionInput,
  FridayNodeExecutionOutput,
  FridayWorkflowNodeExecutor,
} from "../../workflows/engine/friday-workflow-node-executor.js";

import { createNodeRunnerPipeline } from "./node-runner-pipeline.js";
import { NodeAdapterRegistry } from "./adapter-registry.js";

import { WorkflowTriggerAdapter } from "./workflow-trigger-adapter.js";
import { WorkflowActionAdapter } from "./workflow-action-adapter.js";
import { WorkflowConditionAdapter } from "./workflow-condition-adapter.js";
import { WorkflowDataAdapter } from "./workflow-data-adapter.js";
import { WorkflowAiAdapter } from "./workflow-ai-adapter.js";
import { WorkflowApprovalAdapter } from "./workflow-approval-adapter.js";

import type { AcceptanceGate } from "../../acceptance/engine/acceptance-gate.js";
import type { FridayAcceptancePipelineContext } from "../../acceptance/model/friday-acceptance.types.js";
import type { FridayNodeArtifact } from "../model/friday-node-runner.types.js";

// ─── Dependencies ───

export interface CreateWorkflowNodeRunnerFacadeDeps {
  /**
   * Expression evaluator for resolving $-prefixed expressions.
   * The `exec` call signature uses `Record<string, unknown>` to decouple
   * adapters from the workflow-specific FridayExpressionContext shape.
   * The facade passes the full expressionContext object as the context arg.
   */
  expressionEvaluator: {
    exec: (expr: string, context: Record<string, unknown>) => unknown;
  };
  /** Resolve a skill by ID (returns truthy if found, null if not). */
  resolveSkill: (skillId: string) => unknown | null;
  /** Invoke a skill and return its result. */
  invokeSkill: (
    skillId: string,
    runId: string,
    nodeId: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  /** Rules Engine evaluation function (required; fail-closed). */
  evaluateRules: (
    context: FridayEvaluationContext,
    signal?: AbortSignal,
  ) => Promise<FridayEvaluationResult>;
  /** Generate a new UUID. */
  generateId?: () => UUID;
  /** Get current ISO timestamp. */
  nowIso: () => string;
  /** Default execution timeout in milliseconds. */
  defaultTimeoutMs?: number;
  /** Optional legacy executor for backward compatibility fallback. */
  legacyExecutor?: FridayWorkflowNodeExecutor;
  /** Optional acceptance gate for mandatory post-execution validation. */
  acceptanceGate?: AcceptanceGate;
}

// ─── Facade Interface ───

export interface WorkflowNodeRunnerFacade extends FridayWorkflowNodeExecutor {
  /** Expose the underlying pipeline for direct access if needed. */
  readonly pipeline: FridayNodeRunnerPipeline;
  /** Expose the adapter registry for dynamic registration. */
  readonly adapterRegistry: FridayNodeAdapterRegistry;
}

/**
 * Metadata key used to pass the workflow expression context through the
 * NodeRunner execution context so adapters can evaluate expressions.
 */
const EXPRESSION_CONTEXT_KEY = "_expressionContext";

// ─── Factory ───

/**
 * Create a `WorkflowNodeRunnerFacade` that implements `FridayWorkflowNodeExecutor`
 * by routing through the NodeRunner 6-step pipeline.
 *
 * Registers adapters for all standard workflow node types (trigger, action,
 * condition, data, ai, approval). Unknown node types fall back to the legacy
 * executor if provided.
 */
let workflowNodeRunnerFacadeAdvisoryEmitted = false;

/** Warn-once advisory at first construction. See module header. */
function emitWorkflowNodeRunnerFacadeAdvisoryOnce(): void {
  if (workflowNodeRunnerFacadeAdvisoryEmitted) return;
  workflowNodeRunnerFacadeAdvisoryEmitted = true;
  console.info(
    "[friday][node-runner][workflow-facade] advisory: createWorkflowNodeRunnerFacade is constructed but has zero production callers in the workflow runtime as of the B4 capability inventory; the runtime uses createFridayWorkflowNodeRunnerFacade from src/workflows/engine/. Wiring this facade is proof_pending — see module header. Note: FridayNodeExecutionContext.workflowId is currently hardcoded as '' until FridayNodeExecutionInput threads workflowId through.",
  );
}

export function createWorkflowNodeRunnerFacade(
  deps: CreateWorkflowNodeRunnerFacadeDeps,
): WorkflowNodeRunnerFacade {
  emitWorkflowNodeRunnerFacadeAdvisoryOnce();
  // Create an expression evaluator wrapper that pulls the expression context
  // from the adapter's `input` parameter (where we stash it during facade bridging)
  const adaptedExpressionEvaluator = {
    exec: (expr: string, context: Record<string, unknown>): unknown => {
      // The context passed to adapters is the inputData, which contains
      // the expression context under EXPRESSION_CONTEXT_KEY
      const exprCtx = context[EXPRESSION_CONTEXT_KEY] ?? context;
      return deps.expressionEvaluator.exec(expr, exprCtx as Record<string, unknown>);
    },
  };

  // Build adapter registry with all workflow node type adapters
  const adapterRegistry = new NodeAdapterRegistry();

  adapterRegistry.register(new WorkflowTriggerAdapter());
  adapterRegistry.register(
    new WorkflowActionAdapter({
      resolveSkill: deps.resolveSkill,
      invokeSkill: deps.invokeSkill,
      expressionEvaluator: adaptedExpressionEvaluator,
    }),
  );
  adapterRegistry.register(
    new WorkflowConditionAdapter({
      expressionEvaluator: adaptedExpressionEvaluator,
    }),
  );
  adapterRegistry.register(
    new WorkflowDataAdapter({
      expressionEvaluator: adaptedExpressionEvaluator,
    }),
  );
  adapterRegistry.register(
    new WorkflowAiAdapter({
      expressionEvaluator: adaptedExpressionEvaluator,
      invokeSkill: deps.invokeSkill,
    }),
  );
  adapterRegistry.register(new WorkflowApprovalAdapter());

  // Build the pipeline
  const generateId = deps.generateId ?? (() => crypto.randomUUID() as UUID);
  const pipelineConfig: FridayNodeRunnerPipelineConfig = {
    adapterRegistry,
    defaultTimeoutMs: deps.defaultTimeoutMs ?? 300_000,
    evaluateRules: deps.evaluateRules,
    generateId,
    nowIso: deps.nowIso as () => ISODateTime,
  };

  const pipeline = createNodeRunnerPipeline(pipelineConfig);

  return {
    pipeline,
    adapterRegistry,

    async executeNode(input: FridayNodeExecutionInput): Promise<FridayNodeExecutionOutput> {
      // Check if the adapter registry can resolve this node type
      const canResolve = adapterRegistry.resolve({
        type: input.node.type,
        config: input.node.config as Record<string, unknown>,
      });

      // Fallback to legacy executor for unsupported node types
      if (!canResolve && deps.legacyExecutor) {
        return deps.legacyExecutor.executeNode(input);
      }

      // Build the NodeRunner execution context from the workflow input.
      // Stash the expressionContext into inputData so adapters can access it
      // for expression resolution.
      const executionId = generateId();
      const nowIso = deps.nowIso() as ISODateTime;

      const inputData: Record<string, unknown> = {
        ...input.inputData,
        [EXPRESSION_CONTEXT_KEY]: input.expressionContext,
      };

      const context: FridayNodeExecutionContext = {
        executionId,
        runId: input.runId as UUID,
        workflowId: "" as UUID, // Not available in FridayNodeExecutionInput
        nodeId: input.nodeId,
        attemptNumber: 1,
        node: input.node,
        inputData,
        startedAt: nowIso,
        metadata: {} as JsonObject,
        signal: input.signal,
        timeoutMs: input.node.timeoutMs,
      };

      // Execute through the 6-step pipeline
      const result = await pipeline.execute(context);

      // Map the pipeline result back to FridayNodeExecutionOutput
      if (result.status === "completed") {
        const outputArtifacts = result.artifacts?.map((a) => ({
          artifactType: a.artifactType,
          uri: a.uri,
          checksum: a.checksum,
          metadata: a.metadata,
        }));

        // Run acceptance gate if configured (mandatory post-execution validation)
        if (deps.acceptanceGate) {
          const acceptanceContext: FridayAcceptancePipelineContext = {
            executionId: context.executionId,
            runId: context.runId,
            workflowId: context.workflowId,
            nodeId: context.nodeId,
            validatedOutput: result.output ?? null,
            artifacts: (result.artifacts ?? []) as FridayNodeArtifact[],
            signal: input.signal,
          };

          const gateResult = await deps.acceptanceGate.evaluate(acceptanceContext);
          if (!gateResult.passed) {
            throw new FridayDomainError("VALIDATION_ERROR", `ACCEPTANCE_FAILED: ${gateResult.errorMessage ?? "Acceptance gate rejected output"}`, { httpStatus: 400 });
          }
        }

        return {
          output: result.output ?? null,
          artifacts: outputArtifacts,
        };
      }

      // Pipeline failed — throw with the error info so the execution service
      // can handle retries and error recording as before
      const errorMsg = result.errorMessage ?? `Node execution failed with status: ${result.status}`;
      const errorCode = result.errorCode ?? "NODE_EXECUTION_FAILED";
      throw new FridayDomainError("INTERNAL_ERROR", `${errorCode}: ${errorMsg}`, { httpStatus: 500 });
    },
  };
}
