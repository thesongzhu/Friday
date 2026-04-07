import type {
  FridayCompiledWorkflowGraphV2,
  FridayNodeRetryPolicy,
  FridayWorkflowEdge,
  FridayWorkflowNode,
  FridayWorkflowTest,
} from "../model/friday-workflow-graph.types.js";
import type { JsonValue, WorkflowFailurePolicyV2 } from "../model/friday-workflow.types.js";
import { FridayDomainError } from "#errors";
import { createFridayWorkflowValidator } from "./friday-workflow-validator.js";
import type { FridayWorkflowValidationResult } from "./friday-workflow-validator.js";
import {
  getFridayWorkflowStepIdFormatMessage,
  isFridayWorkflowStepIdExpressionSafe,
} from "../utils/friday-workflow-step-id.js";

// ─── WorkflowSpecV1: the authoring DSL input ───

export interface FridayWorkflowSpecV1 {
  schemaVersion: "1.0";
  workflowId: string;
  name: string;
  description: string;
  startStepId: string;
  trigger:
    | { type: "manual" }
    | { type: "schedule"; cron: string; timezone: string }
    | { type: "event"; source: string; event: string };
  inputs: Array<{
    key: string;
    type: "string" | "number" | "boolean" | "object" | "array";
    required: boolean;
    defaultValue?: unknown;
  }>;
  steps: Array<{
    id: string;
    type: "skill_call" | "tool_call" | "condition" | "transform" | "human_approval";
    ref?: string;
    args?: Record<string, unknown>;
    condition?: string;
    timeoutSec?: number;
    retry?: { maxAttempts: number; backoffMs: number };
  }>;
  edges: Array<{
    from: string;
    to: string;
    when?: "success" | "failure" | "true" | "false";
  }>;
  outputs: Array<{
    key: string;
    fromStep: string;
    path: string;
  }>;
  errorPolicy: WorkflowFailurePolicyV2;
  tests: Array<{
    name: string;
    description?: string;
    inputs: Record<string, unknown>;
    mocks?: Record<
      string,
      { output: Record<string, unknown>; status?: "completed" | "failed" }
    >;
    assertions: Array<{
      path: string;
      operator: "==" | "!=" | ">" | "<" | "contains" | "matches";
      expected: unknown;
    }>;
  }>;
}

// ─── Interface ───

export interface FridayWorkflowCompiler {
  compile(
    spec: FridayWorkflowSpecV1,
    workflowVersionId: string,
  ): FridayCompiledWorkflowGraphV2;

  validateSpec(spec: FridayWorkflowSpecV1): FridayWorkflowValidationResult;
}

// ─── Step type → Node type mapping ───

const STEP_TYPE_MAP: Record<string, FridayWorkflowNode["type"]> = {
  skill_call: "action",
  tool_call: "action",
  condition: "condition",
  transform: "data",
  human_approval: "approval",
};

// ─── Dependencies ───

export interface CreateWorkflowCompilerDeps {
  computeChecksum: (content: string) => string;
  idGenerator: () => string;
}

// ─── Factory ───

export function createFridayWorkflowCompiler(
  deps: CreateWorkflowCompilerDeps,
): FridayWorkflowCompiler {
  const validator = createFridayWorkflowValidator();

  function mapRetryPolicy(
    retry: { maxAttempts: number; backoffMs: number } | undefined,
  ): FridayNodeRetryPolicy | undefined {
    if (!retry) return undefined;
    return {
      maxAttempts: retry.maxAttempts,
      backoff: "exponential",
      baseDelayMs: retry.backoffMs,
      maxDelayMs: retry.backoffMs * 8,
      retryOn: ["NODE_EXECUTION_FAILED", "NODE_TIMEOUT"],
    };
  }

  return {
    compile(spec, workflowVersionId) {
      if (!isFridayWorkflowStepIdExpressionSafe(spec.startStepId)) {
        throw new FridayDomainError(
          "WORKFLOW_COMPILATION_ERROR",
          `WORKFLOW_COMPILATION_ERROR: invalid startStepId '${spec.startStepId}'. ${getFridayWorkflowStepIdFormatMessage()}`,
          { httpStatus: 400 },
        );
      }

      // Build trigger node
      const triggerNodeId = `__trigger__`;
      const triggerConfig: Record<string, JsonValue> = {
        triggerType: spec.trigger.type,
      };
      if (spec.trigger.type === "schedule") {
        triggerConfig.cron = spec.trigger.cron;
        triggerConfig.timezone = spec.trigger.timezone;
      } else if (spec.trigger.type === "event") {
        triggerConfig.source = spec.trigger.source;
        triggerConfig.event = spec.trigger.event;
      }

      const triggerNode: FridayWorkflowNode = {
        id: triggerNodeId,
        type: "trigger",
        label: `Trigger (${spec.trigger.type})`,
        config: triggerConfig,
      };

      // Map steps to nodes
      const nodes: FridayWorkflowNode[] = [triggerNode];
      for (const step of spec.steps) {
        if (!isFridayWorkflowStepIdExpressionSafe(step.id)) {
          throw new FridayDomainError(
            "WORKFLOW_COMPILATION_ERROR",
            `WORKFLOW_COMPILATION_ERROR: invalid step id '${step.id}'. ${getFridayWorkflowStepIdFormatMessage()}`,
            { httpStatus: 400 },
          );
        }
        const nodeType = STEP_TYPE_MAP[step.type];
        if (!nodeType) {
          throw new FridayDomainError(
            "WORKFLOW_COMPILATION_ERROR",
            `WORKFLOW_COMPILATION_ERROR: unknown step type '${step.type}'`,
            { httpStatus: 400 },
          );
        }

        const config: Record<string, JsonValue> = {};
        if (step.ref) config.skillId = step.ref;
        // Transform steps need special config shape for the data node executor
        if (step.type === "transform" && step.args) {
          const { transform, mapping, ...rest } = step.args as Record<string, unknown>;
          if (transform !== undefined) config.transform = transform as JsonValue;
          if (mapping !== undefined) config.mapping = mapping as JsonValue;
          if (Object.keys(rest).length > 0) config.args = rest as unknown as JsonValue;
        } else if (step.args) {
          // SAFETY: step.args is Record<string, unknown> from spec DSL; runtime values are always JSON-serializable
          config.args = step.args as unknown as JsonValue;
        }
        if (step.condition) config.condition = step.condition;

        nodes.push({
          id: step.id,
          type: nodeType,
          label: step.id,
          config,
          retryPolicy: mapRetryPolicy(step.retry),
          timeoutMs: step.timeoutSec ? step.timeoutSec * 1000 : undefined,
        });
      }

      // Build edges: trigger → startStepId + spec edges
      const edges: FridayWorkflowEdge[] = [];

      edges.push({
        id: deps.idGenerator(),
        sourceNodeId: triggerNodeId,
        targetNodeId: spec.startStepId,
      });

      for (const specEdge of spec.edges) {
        const edge: FridayWorkflowEdge = {
          id: deps.idGenerator(),
          sourceNodeId: specEdge.from,
          targetNodeId: specEdge.to,
        };

        // Map 'when' to condition expressions
        if (specEdge.when === "success") {
          edge.condition = `$steps.${specEdge.from}.output.status != "failed"`;
        } else if (specEdge.when === "failure") {
          edge.condition = `$steps.${specEdge.from}.output.status == "failed"`;
        } else if (specEdge.when === "true") {
          edge.condition = `$steps.${specEdge.from}.output.result == true`;
        } else if (specEdge.when === "false") {
          edge.condition = `$steps.${specEdge.from}.output.result == false`;
        }
        // undefined → unconditional (no condition)

        edges.push(edge);
      }

      // Map tests
      const tests: FridayWorkflowTest[] = spec.tests.map((t) => ({
        name: t.name,
        description: t.description,
        inputs: t.inputs,
        mocks: t.mocks,
        assertions: t.assertions,
      }));

      // Build compiled graph (without checksum first, compute after)
      const graphObj: Omit<FridayCompiledWorkflowGraphV2, "checksum"> = {
        schemaVersion: "2.0",
        workflowId: spec.workflowId,
        workflowVersionId,
        sourceSpecSchemaVersion: "1.0",
        graph: { nodes, edges },
        failurePolicy: spec.errorPolicy,
        tests,
      };

      const checksum = deps.computeChecksum(JSON.stringify(graphObj));
      const compiled: FridayCompiledWorkflowGraphV2 = {
        ...graphObj,
        checksum,
      };

      // Validate the compiled graph
      const validation = validator.validate(compiled);
      if (!validation.valid) {
        const firstError = validation.errors[0]!;
        throw new FridayDomainError("WORKFLOW_COMPILATION_ERROR", `${firstError.code}: ${firstError.message}`, { httpStatus: 400 });
      }

      return compiled;
    },

    validateSpec(spec) {
      // Compile to validate, catching errors
      try {
        const dummyVersionId = "validate-only";
        this.compile(spec, dummyVersionId);
        return { valid: true, errors: [] };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        // Extract code from "CODE: message" format
        const colonIdx = message.indexOf(": ");
        const code =
          colonIdx > 0 ? message.slice(0, colonIdx) : "WORKFLOW_GRAPH_INVALID";
        const msg = colonIdx > 0 ? message.slice(colonIdx + 2) : message;
        return {
          valid: false,
          errors: [{ code, message: msg }],
        };
      }
    },
  };
}
