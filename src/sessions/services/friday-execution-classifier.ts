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
    readonly setupTargetService?: string;
  };
}

export interface ClassifyFridayExecutionInput {
  readonly task: string;
  readonly turnKind: FridayConversationTurnKind;
  readonly focusState?: FridaySessionConversationFocusState | null;
}

// ─── Hint patterns ───

const CAPABILITY_QUERY =
  /\b((?:what|which)\s+(?:capabilities?|features?)|show(?: me)? (?:the )?capabilities|what can\b|can (?:friday|you)\b.*\bdo\b|what(?:'s| is)? enabled|what(?:'s| is)? disabled|deployment status|runtime facts?)\b/i;
const CAPABILITY_STATE_QUERY =
  /^\s*(?:is|are)\s+[^?.!\n]{0,40}\b(?:enabled|disabled|available|connected)\b(?:\s+now)?\s*[?!.]?\s*$/i;
const CHINESE_CAPABILITY_QUERY =
  /(能力|能做什么|哪些功能|显示能力|当前启用|当前禁用|部署状态|运行时信息|是否可用|是否启用)/;

const APPROVE_REJECT =
  /^\s*(approve|reject|yes,?\s*approve|no,?\s*reject|通过|拒绝|批准|否决)(?:\s+([A-Za-z0-9:_-]+))?\s*[.!?]?\s*$/i;

const WORKFLOW_CONTROL =
  /^\s*(cancel|retry|resume|取消|重试|恢复)(?:\s+([A-Za-z0-9:_-]+))?\s*[.!?]?\s*$/i;

const DAEMON_STATUS =
  /\b(daemon status|daemon\b.*\brunning|is friday running|friday process|后台进程|守护进程状态)\b/i;

const MCP_LIST =
  /\b((?:list|show|which|what|query|inspect|describe)(?:\s+\w+){0,2}\s+(?:mcp(?:\s+servers?)?|servers?\s+for\s+mcp|mcp\s+server\s+info)|mcp\s+(?:server\s+list|list|server\s+info|info)|info\s+about\s+mcp(?:\s+servers?)?)\b/i;

const WORKFLOW_QUERY =
  /\b(list workflows?|workflow status|workflow runs?|show workflows?|工作流状态|工作流列表)\b/i;
const WORKFLOW_QUERY_WITH_RUN =
  /\b(?:workflow status|workflow run|workflow runs?|show workflow(?: run)? status)\s+([A-Za-z0-9:_-]+)\b/i;

const SETUP_INTENT =
  /\b(bind|connect|configure|set\s*up|setup|enable|register|add|link|onboard|install)\b/i;
const SETUP_INFO_INTENT =
  /\b(what\s+(?:do\s+)?(?:i|we)\s+need|what\s+should\s+(?:i|we)\s+provide|how\s+(?:do\s+)?(?:i|we)\s+(?:bind|connect|configure|set\s*up))\b/i;
const CHINESE_SETUP_INTENT =
  /(绑定|配置|接入|连接|启用|开启|注册|添加|设置|开通|安装|流程|需要提供|需要什么|要提供什么|怎么(?:绑定|配置|接入|连接)|帮我(?:绑定|配置|接入|连接)|直接(?:去)?操作|你(?:直接)?(?:去)?操作|开始(?:绑定|配置|接入|连接)?|执行(?:绑定|配置|接入|连接)?)/u;

const SETUP_TARGET_ALIASES: ReadonlyArray<readonly [string, readonly RegExp[]]> = [
  ["discord", [/\bdiscord\b/i, /\bdc\b/i]],
  ["telegram", [/\btelegram\b/i, /\btg\b/i]],
  ["slack", [/\bslack\b/i]],
  ["whatsapp", [/\bwhats\s*app\b/i, /\bwhatsapp\b/i]],
  ["qq", [/\bqq\b/i]],
  ["lark", [/\blark\b/i, /飞书国际版/u]],
  ["feishu", [/\bfeishu\b/i, /飞书/u]],
  ["line", [/\bline\b/i]],
  ["signal", [/\bsignal\b/i]],
  ["irc", [/\birc\b/i]],
  ["openai", [/\bopenai\b/i]],
  ["anthropic", [/\banthropic\b/i, /\bclaude\b/i]],
  ["qwen", [/\bqwen\b/i, /通义|千问/u]],
  ["deepseek", [/\bdeepseek\b/i, /深度求索/u]],
  ["google", [/\bgoogle\b/i, /\bgemini\b/i]],
  ["text", [/\btext\b/i, /\bllm\b/i, /\bchat\s+model\b/i, /\blanguage\s+model\b/i, /文本|对话模型|语言模型/u]],
  ["vision", [/\bvision\b/i, /\bimage\s+understanding\b/i, /\bmultimodal\b/i, /看图|读图|视觉|多模态|图片理解/u]],
  ["ocr", [/\bocr\b/i, /\btext\s+recognition\b/i, /识别文字|提取文字|图片文字|截图文字|扫描件/u]],
  ["embedding", [/\bembeddings?\b/i, /\bsemantic\s+memory\b/i, /\bvector\s+search\b/i, /向量|嵌入|语义记忆|相似搜索/u]],
  ["web_search", [/\bweb\s+search\b/i, /\binternet\s+search\b/i, /\bserper\b/i, /\btavily\b/i, /联网搜索|网络搜索|全网搜索|网页搜索/u]],
  ["pdf_parse", [/\bpdf\b/i, /PDF|文档解析|解析文档/u]],
  ["tts", [/\btts\b/i, /\btext\s+to\s+speech\b/i, /\bspeech\s+synthesis\b/i, /语音合成|文字转语音|文本转语音/u]],
  ["browser", [/\bbrowser\b/i, /\bplaywright\b/i, /浏览器|打开网页/u]],
  ["mcp", [/\bmcp\b/i]],
  ["skills", [/\bskills?\b/i, /技能/u]],
  ["custom", [/\bcustom\b/i, /\bgenerate\s+(?:tool|skill)\b/i, /自定义|生成工具|生成skill|自定义能力/u]],
];

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

function extractSetupTargetService(text: string): string | undefined {
  for (const [service, aliases] of SETUP_TARGET_ALIASES) {
    if (aliases.some((pattern) => pattern.test(text))) {
      return service;
    }
  }
  return undefined;
}

function looksLikeSetupIntent(text: string): boolean {
  return SETUP_INTENT.test(text)
    || SETUP_INFO_INTENT.test(text)
    || CHINESE_SETUP_INTENT.test(text);
}

function resolveSetupTargetFromFocus(
  focusState?: FridaySessionConversationFocusState | null,
): string | undefined {
  if (!focusState) {
    return undefined;
  }
  return extractSetupTargetService([
    focusState.currentTopicSummary,
    focusState.assistantAnchorSummary,
    focusState.lastAnsweredQuestion,
  ].filter((value): value is string => Boolean(value)).join("\n"));
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

  // 7. Setup / binding / configuration intents
  if (looksLikeSetupIntent(normalized)) {
    const setupTargetService = extractSetupTargetService(normalized) ?? resolveSetupTargetFromFocus(focusState);
    if (setupTargetService) {
      return {
        category: "sync_immediate",
        handler: "setup_guidance",
        extractedParams: { setupTargetService },
      };
    }
  }

  // 8. Capability queries
  if (
    CAPABILITY_QUERY.test(normalized)
    || CAPABILITY_STATE_QUERY.test(normalized)
    || CHINESE_CAPABILITY_QUERY.test(normalized)
  ) {
    return { category: "sync_immediate", handler: "capabilities" };
  }

  // Default: agent handles it
  return { category: "agent_exception_path" };
}
