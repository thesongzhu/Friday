import type { FridayWorkflowExecutionService } from "#workflows";

import type { FridayExecutionClassification } from "./friday-execution-classifier.js";

export interface FridayManagedAsyncDispatchResult {
  readonly handled: boolean;
  readonly response?: string;
}

export interface FridayManagedAsyncDispatchDeps {
  readonly workflowExecutionService?: FridayWorkflowExecutionService;
}

export interface DispatchManagedAsyncInput {
  readonly classification: FridayExecutionClassification;
}

export async function dispatchManagedAsync(
  input: DispatchManagedAsyncInput,
  deps: FridayManagedAsyncDispatchDeps,
): Promise<FridayManagedAsyncDispatchResult> {
  if (input.classification.handler !== "workflow_control") {
    return { handled: false };
  }
  if (!deps.workflowExecutionService) {
    return { handled: false };
  }

  const controlAction = input.classification.extractedParams?.controlAction;
  const runId = input.classification.extractedParams?.runId;
  if (!controlAction) {
    return { handled: false };
  }
  if (!runId) {
    return {
      handled: true,
      response: `Please specify a workflow run id to ${controlAction}.`,
    };
  }

  try {
    switch (controlAction) {
      case "cancel": {
        const run = await deps.workflowExecutionService.cancelRun(runId);
        return {
          handled: true,
          response: `Workflow run ${run.id} cancelled. Current status: ${run.status}.`,
        };
      }
      case "retry": {
        const run = await deps.workflowExecutionService.retryRun(runId);
        return {
          handled: true,
          response: `Workflow run ${run.id} retried. Current status: ${run.status}.`,
        };
      }
      case "resume": {
        const run = await deps.workflowExecutionService.resumeRun(runId);
        return {
          handled: true,
          response: `Workflow run ${run.id} resumed. Current status: ${run.status}.`,
        };
      }
      default:
        return { handled: false };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      handled: true,
      response: `Unable to ${controlAction} workflow run ${runId}: ${message}`,
    };
  }
}
