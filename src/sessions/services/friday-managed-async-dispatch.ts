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
  readonly task?: string;
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
  const isChinese = containsChinese(input.task ?? "");
  if (!controlAction) {
    return { handled: false };
  }
  if (!runId) {
    return {
      handled: true,
      response: isChinese
        ? `请提供要${localizeControlActionZh(controlAction)}的 workflow run id。`
        : `Please specify a workflow run id to ${controlAction}.`,
    };
  }

  try {
    switch (controlAction) {
      case "cancel": {
        const run = await deps.workflowExecutionService.cancelRun(runId);
        return {
          handled: true,
          response: isChinese
            ? `Workflow run ${run.id} 已取消。当前状态：${run.status}。`
            : `Workflow run ${run.id} cancelled. Current status: ${run.status}.`,
        };
      }
      case "retry": {
        const run = await deps.workflowExecutionService.retryRun(runId);
        return {
          handled: true,
          response: isChinese
            ? `Workflow run ${run.id} 已重试。当前状态：${run.status}。`
            : `Workflow run ${run.id} retried. Current status: ${run.status}.`,
        };
      }
      case "resume": {
        const run = await deps.workflowExecutionService.resumeRun(runId);
        return {
          handled: true,
          response: isChinese
            ? `Workflow run ${run.id} 已恢复。当前状态：${run.status}。`
            : `Workflow run ${run.id} resumed. Current status: ${run.status}.`,
        };
      }
      default:
        return { handled: false };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      handled: true,
      response: isChinese
        ? `无法${localizeControlActionZh(controlAction)} workflow run ${runId}：${message}`
        : `Unable to ${controlAction} workflow run ${runId}: ${message}`,
    };
  }
}

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/u.test(text);
}

function localizeControlActionZh(action: string): string {
  switch (action) {
    case "cancel":
      return "取消";
    case "retry":
      return "重试";
    case "resume":
      return "恢复";
    default:
      return action;
  }
}
