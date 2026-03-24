/**
 * Execution Classifier — Categorizes incoming requests into deterministic,
 * managed-async, or agent-exception paths.
 *
 * Sits between conversation turn classification and the planning gate / agent
 * runtime.  When a request is classified as `sync_immediate`, the hub can
 * serve it deterministically without invoking the LLM.
 *
 * @module sessions/services/friday-execution-classifier
 */

import type {
  FridayConversationTurnKind,
  FridaySessionConversationFocusState,
} from "../model/friday-session.types.js";

// ─── Types ───

export type FridayExecutionCategory =
  | "sync_immediate"
  | "managed_async"
  | "agent_exception_path";

export interface FridayExecutionClassification {
  readonly category: FridayExecutionCategory;
  readonly handler?: string;
  readonly extractedParams?: {
    readonly approvalId?: string;
    readonly runId?: string;
    readonly decision?: "approve" | "reject";
    readonly controlAction?: "cancel" | "retry" | "resume";
  };
}

export interface ClassifyFridayExecutionInput {
  readonly task: string;
  readonly turnKind: FridayConversationTurnKind;
  readonly focusState?: FridaySessionConversationFocusState | null;
}

// ─── Hint patterns ───

const CAPABILITY_QUERY =
  /\b(capabilities?|what can\b|can (?:friday|you)\b.*\bdo\b|enabled|disabled|deployment|runtime facts?)\b/i;
const CHINESE_CAPABILITY_QUERY =
  /(能力|能做什么|启用|禁用|部署|运行时|是否可用|是否启用)/;

const APPROVE_REJECT =
  /^\s*(approve|reject|yes,?\s*approve|no,?\s*reject|通过|拒绝|批准|否决)(?:\s+([A-Za-z0-9:_-]+))?\s*[.!?]?\s*$/i;

const WORKFLOW_CONTROL =
  /^\s*(cancel|retry|resume|取消|重试|恢复)(?:\s+([A-Za-z0-9:_-]+))?\s*[.!?]?\s*$/i;

const DAEMON_STATUS =
  /\b(daemon status|daemon\b.*\brunning|is friday running|friday process|后台进程|守护进程状态)\b/i;

const MCP_LIST =
  /\b(list mcp|mcp servers?|show mcp|what mcp|哪些mcp|mcp列表|mcp服务)\b/i;

const WORKFLOW_QUERY =
  /\b(list workflows?|workflow status|workflow runs?|show workflows?|工作流状态|工作流列表)\b/i;
const WORKFLOW_QUERY_WITH_RUN =
  /\b(?:workflow status|workflow run|workflow runs?|show workflow(?: run)? status)\s+([A-Za-z0-9:_-]+)\b/i;

function normalizeDecision(raw: string): "approve" | "reject" {
  if (/^(reject|no,?\s*reject|拒绝|否决)$/i.test(raw)) {
    return "reject";
  }
  return "approve";
}

function normalizeControlAction(raw: string): "cancel" | "retry" | "resume" {
  if (/^(cancel|取消)$/i.test(raw)) {
    return "cancel";
  }
  if (/^(retry|重试)$/i.test(raw)) {
    return "retry";
  }
  return "resume";
}

// ─── Classifier ───

export function classifyFridayExecution(
  input: ClassifyFridayExecutionInput,
): FridayExecutionClassification {
  const { task, turnKind, focusState } = input;
  const normalized = task.trim();

  // If the planning gate has a pending plan, approval / rejection commands
  // must go through the planning gate (existing path), not deterministic dispatch.
  const hasPendingPlan = !!focusState?.pendingPlanRunId;

  // 1. Status checks (already classified by turn classifier)
  if (turnKind === "status_check" && !hasPendingPlan) {
    return { category: "sync_immediate", handler: "task_status" };
  }

  // 2. Workflow control commands
  const workflowControlMatch = normalized.match(WORKFLOW_CONTROL);
  if (workflowControlMatch) {
    return {
      category: "managed_async",
      handler: "workflow_control",
      extractedParams: {
        controlAction: normalizeControlAction(workflowControlMatch[1]!),
        ...(workflowControlMatch[2] ? { runId: workflowControlMatch[2] } : {}),
      },
    };
  }

  // 3. Approval / rejection commands
  const approvalMatch = normalized.match(APPROVE_REJECT);
  if (approvalMatch) {
    if (hasPendingPlan && !approvalMatch[2]) {
      // Defer to planning gate
      return { category: "agent_exception_path" };
    }
    return {
      category: "sync_immediate",
      handler: "approval_decision",
      extractedParams: {
        decision: normalizeDecision(approvalMatch[1]!),
        ...(approvalMatch[2] ? { approvalId: approvalMatch[2] } : {}),
      },
    };
  }

  // 4. Daemon status
  if (DAEMON_STATUS.test(normalized)) {
    return { category: "sync_immediate", handler: "daemon_status" };
  }

  // 5. MCP server queries
  if (MCP_LIST.test(normalized)) {
    return { category: "sync_immediate", handler: "mcp_list" };
  }

  // 6. Workflow queries
  if (WORKFLOW_QUERY.test(normalized)) {
    const runMatch = normalized.match(WORKFLOW_QUERY_WITH_RUN);
    return {
      category: "sync_immediate",
      handler: "workflow_query",
      extractedParams: runMatch?.[1]
        ? { runId: runMatch[1] }
        : undefined,
    };
  }

  // 7. Capability queries
  if (CAPABILITY_QUERY.test(normalized) || CHINESE_CAPABILITY_QUERY.test(normalized)) {
    return { category: "sync_immediate", handler: "capabilities" };
  }

  // Default: agent handles it
  return { category: "agent_exception_path" };
}
