import type {
  AgentContextCostSummary,
  AgentRunContextSummarySnapshot,
  AgentRunHealthSnapshot,
  AgentRunStatus,
  ResolvedAgentTaskProfile,
} from "@/lib/api/types";
import type { AppLocale } from "@/lib/i18n/localized-text";

export interface RunHealthLike {
  status: AgentRunStatus;
  summary?: string;
  responseText?: string;
  errorMessage?: string;
  taskProfile?: ResolvedAgentTaskProfile;
  contextCostSummary?: AgentContextCostSummary;
  contextSummary?: AgentRunContextSummarySnapshot;
  health?: AgentRunHealthSnapshot;
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
      return run.summary ?? run.responseText ?? run.errorMessage ?? "";
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
