/**
 * A-003 NodeRunner Facade — bridges workflow node execution to the
 * NodeRunner 6-step deterministic pipeline.
 *
 * Maps workflow node types to NodeRunner adapters and delegates execution
 * through load → pre-validate → pre-rules → execute → post-validate → post-rules.
 *
 * Production runtimes should enable the deterministic pipeline. The
 * `useNodeRunner=false` path remains available only as an explicit
 * compatibility/test mode; it is not controlled by the steady-state runtime
 * env path anymore.
 *
 * @module workflows/engine
 */

import { FridayDomainError } from "#errors";
import type {
  FridayNodeExecutionContext,
  FridayNodeExecutionResult,
  FridayNodeRunnerPipeline,
} from "../../node-runner/model/friday-node-runner.types.js";
import type {
  FridayNodeExecutionInput,
  FridayNodeExecutionOutput,
  FridayWorkflowNodeExecutor,
} from "./friday-workflow-node-executor.js";
import type { JsonValue } from "../model/friday-workflow.types.js";
import type { JsonObject } from "../../rules/model/friday-rules-engine.types.js";

// ─── Config ───

export interface FridayNodeRunnerFacadeConfig {
  /** When true, route execution through NodeRunner pipeline. When false, use explicit compatibility mode. */
  useNodeRunner: boolean;
}

// ─── Dependencies ───

export interface FridayNodeRunnerFacadeDeps {
  /** The 6-step NodeRunner pipeline instance. */
  pipeline: FridayNodeRunnerPipeline;
  /** Legacy workflow node executor for explicit compatibility/test mode. */
  legacyExecutor: FridayWorkflowNodeExecutor;
  /** Configuration controlling feature flag. */
  config: FridayNodeRunnerFacadeConfig;
  /** Clock function for timestamps. */
  nowIso?: () => string;
}

// ─── Supported node type mapping ───

/** Standard workflow node types that must route through NodeRunner when enabled. */
const NODE_RUNNER_SUPPORTED_TYPES = new Set([
  "trigger",
  "action",
  "condition",
  "data",
  "ai",
  "approval",
]);

// ─── Interface ───

export interface FridayWorkflowNodeRunnerFacade {
  executeNode(input: FridayNodeExecutionInput): Promise<FridayNodeExecutionOutput>;
  isNodeRunnerEnabled(): boolean;
}

// ─── Factory ───

export function createFridayWorkflowNodeRunnerFacade(
  deps: FridayNodeRunnerFacadeDeps,
): FridayWorkflowNodeRunnerFacade {
  const { pipeline, legacyExecutor, config } = deps;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());

  return {
    isNodeRunnerEnabled() {
      return config.useNodeRunner;
    },

    async executeNode(input: FridayNodeExecutionInput): Promise<FridayNodeExecutionOutput> {
      const { node } = input;

      // Explicit compatibility mode: route all nodes through the legacy executor.
      if (!config.useNodeRunner) {
        return legacyExecutor.executeNode(input);
      }

      if (!NODE_RUNNER_SUPPORTED_TYPES.has(node.type)) {
        throw new FridayDomainError(
          "NODE_RUNNER_UNSUPPORTED_NODE_TYPE",
          `NODE_RUNNER_UNSUPPORTED_NODE_TYPE: unsupported workflow node type '${node.type}'`,
          { httpStatus: 500 },
        );
      }

      // Build NodeRunner execution context from workflow input
      const executionContext: FridayNodeExecutionContext = {
        executionId: input.attemptId,
        runId: input.runId,
        workflowId: input.workflowId ?? input.runId,
        nodeId: input.nodeId,
        attemptNumber: 1,
        node,
        inputData: input.inputData,
        startedAt: nowIso(),
        timeoutMs: 30_000,
        signal: input.signal,
        metadata: {
          workflowNodeType: node.type,
          workflowAttemptId: input.attemptId,
          workflowExpressionContext: input.expressionContext as unknown as JsonObject,
        } as JsonObject,
      };

      // Execute through the 6-step pipeline
      const result: FridayNodeExecutionResult = await pipeline.execute(executionContext);

      // Map result back to workflow output format
      if (result.status === "completed") {
        return {
          output: (result.output ?? null) as JsonValue,
          artifacts: result.artifacts?.map((a) => ({
            artifactType: a.artifactType,
            uri: a.uri,
            checksum: a.checksum,
            metadata: a.metadata,
          })),
        };
      }

      // Pipeline failed — throw with details
      const errorCode = result.errorCode ?? "NODE_EXECUTION_FAILED";
      const errorMsg = result.errorMessage ?? `NodeRunner pipeline failed with status '${result.status}'`;
      throw new FridayDomainError(
        errorCode,
        `${errorCode}: ${errorMsg}`,
        { httpStatus: 500, retryable: errorCode.includes("TIMEOUT") || errorCode.includes("TOOL") || errorCode.includes("NETWORK") },
      );
    },
  };
}
