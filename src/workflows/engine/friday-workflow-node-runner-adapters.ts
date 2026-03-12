import { FridayDomainError } from "#errors";

import type {
  FridayNodeAdapter,
  FridayNodeExecutionContext,
  FridayValidationResult,
} from "../../node-runner/model/friday-node-runner.types.js";
import type {
  JsonObject,
  JsonValue,
} from "../../rules/model/friday-rules-engine.types.js";
import type { FridayExpressionContext } from "../model/friday-workflow-expression.types.js";
import type {
  FridayNodeExecutionInput,
  FridayWorkflowNodeExecutor,
} from "./friday-workflow-node-executor.js";

interface DelegatingAdapterDeps {
  legacyExecutor: FridayWorkflowNodeExecutor;
}

function alwaysValid(): FridayValidationResult {
  return { valid: true, errors: [] };
}

function readExpressionContext(context: FridayNodeExecutionContext): FridayExpressionContext {
  const metadata = context.metadata as Record<string, unknown>;
  const raw = metadata.workflowExpressionContext;
  if (typeof raw === "object" && raw !== null) {
    return raw as FridayExpressionContext;
  }
  throw new FridayDomainError(
    "NODE_EXECUTION_FAILED",
    "NODE_EXECUTION_FAILED: missing workflow expression context for NodeRunner delegation",
    { httpStatus: 500 },
  );
}

abstract class WorkflowDelegatingNodeAdapter implements FridayNodeAdapter {
  readonly nodeType: string;
  protected readonly legacyExecutor: FridayWorkflowNodeExecutor;

  constructor(nodeType: string, deps: DelegatingAdapterDeps) {
    this.nodeType = nodeType;
    this.legacyExecutor = deps.legacyExecutor;
  }

  async load(context: FridayNodeExecutionContext): Promise<JsonObject> {
    return { ...(context.node.config as JsonObject) };
  }

  validateInput(): FridayValidationResult {
    return alwaysValid();
  }

  async execute(
    context: FridayNodeExecutionContext,
    _config: JsonObject,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const executionInput: FridayNodeExecutionInput = {
      runId: context.runId,
      workflowId: context.workflowId,
      nodeId: context.nodeId,
      attemptId: context.executionId,
      node: context.node,
      inputData: input,
      expressionContext: readExpressionContext(context),
      signal,
    };

    const output = await this.legacyExecutor.executeNode(executionInput);
    context.artifacts = output.artifacts;
    return output.output;
  }

  validateOutput(): FridayValidationResult {
    return alwaysValid();
  }
}

class ActionDelegatingAdapter extends WorkflowDelegatingNodeAdapter {
  constructor(deps: DelegatingAdapterDeps) {
    super("action", deps);
  }
}

class TriggerDelegatingAdapter extends WorkflowDelegatingNodeAdapter {
  constructor(deps: DelegatingAdapterDeps) {
    super("trigger", deps);
  }
}

class ConditionDelegatingAdapter extends WorkflowDelegatingNodeAdapter {
  constructor(deps: DelegatingAdapterDeps) {
    super("condition", deps);
  }
}

class AiDelegatingAdapter extends WorkflowDelegatingNodeAdapter {
  constructor(deps: DelegatingAdapterDeps) {
    super("ai", deps);
  }
}

class DataDelegatingAdapter extends WorkflowDelegatingNodeAdapter {
  constructor(deps: DelegatingAdapterDeps) {
    super("data", deps);
  }
}

class ApprovalDelegatingAdapter extends WorkflowDelegatingNodeAdapter {
  constructor(deps: DelegatingAdapterDeps) {
    super("approval", deps);
  }
}

export function createWorkflowNodeRunnerDelegatingAdapters(
  deps: DelegatingAdapterDeps,
): FridayNodeAdapter[] {
  return [
    new TriggerDelegatingAdapter(deps),
    new ActionDelegatingAdapter(deps),
    new ConditionDelegatingAdapter(deps),
    new AiDelegatingAdapter(deps),
    new DataDelegatingAdapter(deps),
    new ApprovalDelegatingAdapter(deps),
  ];
}
