import type {
  AgentContextCostSummary,
  AgentRunContextSummarySnapshot,
  AgentRunHealthSnapshot,
  AgentRunMetadata,
  AgentRunStatus,
  ResolvedAgentTaskProfile,
} from "@/lib/api/types";
import type { AppLocale } from "@/lib/i18n/localized-text";

export interface RunHealthLike {
  task?: string;
  status: AgentRunStatus;
  summary?: string;
  responseText?: string;
  errorMessage?: string;
  taskProfile?: ResolvedAgentTaskProfile;
  contextCostSummary?: AgentContextCostSummary;
  contextSummary?: AgentRunContextSummarySnapshot;
  health?: AgentRunHealthSnapshot;
  metadata?: AgentRunMetadata;
}

const CUSTOM_PACK_INTERNAL_LINE_PATTERNS = [
  /[（(]?\s*ID\s*[:：]/iu,
  /(?:任务包\s*id|pack(?:\s|_)?id)\s*[:：=]/iu,
  /\b(?:run(?:\s|_)?id|session(?:\s|_)?id|session(?:\s|_)?key)\b/iu,
  /\b(?:readOnly|readonly)\b/iu,
  /\b(?:skills_list|memory_search|agents_list)\b/iu,
  /\b(?:sub-agent|subagent|tool call)\b/iu,
  /(?:只读模式|内存(?:系统|持久化|记录)|记忆(?:系统|条目|检索)|子代理|会话键|父子会话|运行深度|元数据)/iu,
];

const UUID_INLINE_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const UUID_GLOBAL_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const CUSTOM_PACK_PROMPT_TITLE_ZH_RE = /执行用户自创任务包[「"](.+?)[」"]。?/u;
const CUSTOM_PACK_PROMPT_TITLE_EN_RE = /Execute the user's custom pack "(.+?)"\./iu;
const CUSTOM_PACK_PROMPT_BRIEF_ZH_RE = /任务说明[:：]\s*(.+?)(?:\n|$)/u;
const CUSTOM_PACK_PROMPT_BRIEF_EN_RE = /Pack brief:\s*(.+?)(?:\n|$)/iu;

function isCustomPackRun(run: Pick<RunHealthLike, "metadata"> | null | undefined): boolean {
  const packId = run?.metadata?.packContext?.packId;
  return typeof packId === "string" && packId.trim().startsWith("custom-");
}

function extractCustomPackPromptDisplay(value: string): string | null {
  const zhTitle = value.match(CUSTOM_PACK_PROMPT_TITLE_ZH_RE)?.[1]?.trim();
  const zhBrief = value.match(CUSTOM_PACK_PROMPT_BRIEF_ZH_RE)?.[1]?.trim();
  if (zhTitle && zhBrief) {
    return `执行自创任务「${zhTitle}」。${zhBrief}`;
  }

  const enTitle = value.match(CUSTOM_PACK_PROMPT_TITLE_EN_RE)?.[1]?.trim();
  const enBrief = value.match(CUSTOM_PACK_PROMPT_BRIEF_EN_RE)?.[1]?.trim();
  if (enTitle && enBrief) {
    return `Run the custom task "${enTitle}". ${enBrief}`;
  }

  return null;
}

function looksLikeInternalRuntimeLeak(value: string): boolean {
  return CUSTOM_PACK_INTERNAL_LINE_PATTERNS.some((pattern) => pattern.test(value))
    || UUID_INLINE_RE.test(value)
    || value.includes("skills_list")
    || value.includes("memory_search")
    || value.includes("agents_list");
}

function stripInlineInternalFragments(value: string): string {
  return value
    .replace(/(?:任务包\s*id|pack(?:\s|_)?id)\s*[:：=]\s*[^\s,，;；)]+/giu, "")
    .replace(/(?:run(?:\s|_)?id|session(?:\s|_)?id|session(?:\s|_)?key)\s*[:：=]\s*[^\s,，;；)]+/giu, "")
    .replace(/\b(?:readOnly|readonly)\b\s*(?:[:=]\s*(?:true|false))?/giu, "")
    .replace(/\b(?:skills_list|memory_search|agents_list|sub-agent|subagent|tool call)\b/giu, "")
    .replace(UUID_GLOBAL_RE, "")
    .replace(/[（(]\s*ID\s*[:：]\s*[）)]/giu, "")
    .replace(/\bID\s*[:：]\s*/giu, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function sanitizeLooseRunDisplayText(value?: string | null): string {
  if (!value) {
    return "";
  }

  const normalized = value.trim();
  const customPackPromptDisplay = extractCustomPackPromptDisplay(normalized);
  if (customPackPromptDisplay) {
    return customPackPromptDisplay;
  }
  if (!looksLikeInternalRuntimeLeak(normalized)) {
    return normalized;
  }

  const filteredLines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !CUSTOM_PACK_INTERNAL_LINE_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => !(UUID_INLINE_RE.test(line) && /\b(?:run|session|pack|id|任务)\b/iu.test(line)));

  return stripInlineInternalFragments(filteredLines.join("\n"));
}

export function sanitizeRunDisplayText(
  run: Pick<RunHealthLike, "metadata"> | null | undefined,
  value?: string | null,
): string {
  if (!value) {
    return "";
  }

  const normalized = value.trim();
  if (!isCustomPackRun(run)) {
    return sanitizeLooseRunDisplayText(normalized);
  }

  return sanitizeLooseRunDisplayText(normalized);
}

export function displayRunTask(run: Pick<RunHealthLike, "task" | "metadata">): string {
  return sanitizeRunDisplayText(run, run.task) || run.task?.trim() || "";
}

export function displayRunPreview(
  run: Pick<RunHealthLike, "task" | "summary" | "responseText" | "errorMessage" | "metadata">,
): string {
  return sanitizeRunDisplayText(run, run.summary)
    || sanitizeRunDisplayText(run, run.responseText)
    || sanitizeRunDisplayText(run, run.errorMessage)
    || sanitizeRunDisplayText(run, run.task);
}

export function toneForRunHealth(run: RunHealthLike): "neutral" | "success" | "warning" | "danger" {
  switch (run.health?.state) {
    case "healthy":
      return "success";
    case "needs_approval":
    case "degraded":
    case "retryable":
    case "rollback_available":
      return "warning";
    case "failed":
      return "danger";
    default:
      if (run.status === "completed") return "success";
      if (run.status === "failed" || run.status === "failed_tests" || run.status === "cancelled") return "danger";
      return "neutral";
  }
}

export function labelForRunHealth(run: RunHealthLike, locale: AppLocale): string {
  switch (run.health?.state) {
    case "healthy":
      return locale === "zh" ? "正常" : "Healthy";
    case "needs_approval":
      return locale === "zh" ? "待确认" : "Needs Approval";
    case "degraded":
      return locale === "zh" ? "已降级" : "Degraded";
    case "retryable":
      return locale === "zh" ? "可重试" : "Retryable";
    case "failed":
      return locale === "zh" ? "失败" : "Failed";
    case "rollback_available":
      return locale === "zh" ? "可回退" : "Rollback Ready";
    default:
      return run.status;
  }
}

export function describeRunHealth(run: RunHealthLike, locale: AppLocale): string {
  switch (run.health?.state) {
    case "rollback_available":
      return locale === "zh"
        ? "这次运行改动过文件，仍然保留可回退检查点。"
        : "This run changed files and still has a rollback checkpoint.";
    case "needs_approval":
      return locale === "zh"
        ? "运行已经停在确认步骤，等你决定是否继续。"
        : "The run is paused and waiting for your approval to continue.";
    case "degraded":
      return locale === "zh"
        ? "系统做了降级处理，但仍然尽量给出了可用结果。"
        : "Friday degraded gracefully and still tried to deliver a usable result.";
    case "retryable":
      return locale === "zh"
        ? "这更像临时的 provider 或网络问题，重新执行通常能恢复。"
        : "This looks like a temporary provider or network issue and is usually safe to retry.";
    case "failed":
      return locale === "zh"
        ? "这是阻塞性失败，需要先处理问题再继续。"
        : "This is a blocking failure that needs attention before continuing.";
    case "healthy":
      return locale === "zh"
        ? "这次运行没有明显的恢复或风险信号。"
        : "This run completed without obvious recovery or risk signals.";
    default:
      return displayRunPreview(run);
  }
}

export function summarizeRunContext(run: RunHealthLike, locale: AppLocale): string | null {
  const context = run.contextSummary;
  if (!context) {
    return null;
  }

  const parts: string[] = [];
  if (context.taskProfileLabel) {
    parts.push(locale === "zh" ? `任务档位 ${context.taskProfileLabel}` : `Profile ${context.taskProfileLabel}`);
  }
  if (context.totalEstimatedChars != null) {
    parts.push(locale === "zh" ? `上下文约 ${context.totalEstimatedChars} 字符` : `Context ~${context.totalEstimatedChars} chars`);
  }
  if (context.learningAdjusted) {
    parts.push(locale === "zh" ? "已根据历史经验调整路由" : "Route adjusted from prior learning");
  }
  if (context.fallbackAttemptCount > 0) {
    parts.push(locale === "zh" ? `回退 ${context.fallbackAttemptCount} 次` : `${context.fallbackAttemptCount} fallback attempts`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
