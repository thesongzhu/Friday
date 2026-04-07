import type { AgentRunRecord } from "@/lib/api/types";
import { localize, resolveLocalizedText, type AppLocale } from "@/lib/i18n/localized-text";
import {
  describeRunHealth,
  labelForRunHealth,
  summarizeRunContext,
  toneForRunHealth,
  type RunHealthLike,
} from "@/lib/runs/run-health";
import type { FridayPackDefinition } from "./pack-registry";

const ACTIVE_RUN_STATUSES = new Set([
  "pending",
  "planning",
  "awaiting_clarification",
  "awaiting_plan_approval",
  "awaiting_tool_approval",
  "executing",
  "testing",
  "fixing",
]);

export interface FridayPackRunMatch {
  activeRun: AgentRunRecord | null;
  recentRun: AgentRunRecord | null;
  currentRun: AgentRunRecord | null;
}

export type FridayPackReceiptState =
  | "not_started"
  | "in_progress"
  | "ready"
  | "needs_approval"
  | "degraded"
  | "retryable"
  | "failed";

export interface FridayPackReceiptAction {
  id:
    | "use_prompt"
    | "continue_chat"
    | "open_assistant"
    | "review_approvals"
    | "open_observability";
  label: string;
  tone: "primary" | "secondary";
  promptId?: string;
}

export interface FridayPackReceiptDeliverable {
  title: string;
  detail: string;
  statusLabel: string;
  tone: "neutral" | "success" | "warning" | "danger";
}

export interface FridayPackAssistantReceiptModel {
  state: FridayPackReceiptState;
  stateLabel: string;
  stateTone: "neutral" | "success" | "warning" | "danger";
  headline: string;
  latestTask: string | null;
  evidence: string;
  contextNotes: string[];
  deliverables: FridayPackReceiptDeliverable[];
  nextActions: FridayPackReceiptAction[];
  currentRun: AgentRunRecord | null;
}

function readRunPackId(run: AgentRunRecord): string | null {
  const packId = run.metadata?.packContext?.packId;
  return typeof packId === "string" && packId.trim().length > 0
    ? packId.trim()
    : null;
}

export function findPackRuns(pack: FridayPackDefinition, runs: AgentRunRecord[]): FridayPackRunMatch {
  const relatedRuns = runs.filter((run) => readRunPackId(run) === pack.id);
  const activeRun = relatedRuns.find((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? null;
  const recentRun = relatedRuns.find((run) => !ACTIVE_RUN_STATUSES.has(run.status)) ?? null;
  return {
    activeRun,
    recentRun,
    currentRun: activeRun ?? recentRun,
  };
}

function resolveReceiptState(run: AgentRunRecord | null): FridayPackReceiptState {
  if (!run) {
    return "not_started";
  }

  switch (run.health?.state) {
    case "needs_approval":
      return "needs_approval";
    case "degraded":
      return "degraded";
    case "retryable":
      return "retryable";
    case "failed":
      return "failed";
    case "healthy":
    case "rollback_available":
      return "ready";
    default:
      if (ACTIVE_RUN_STATUSES.has(run.status)) {
        return "in_progress";
      }
      if (run.status === "completed") {
        return "ready";
      }
      if (run.status === "failed" || run.status === "failed_tests" || run.status === "cancelled") {
        return "failed";
      }
      return "not_started";
  }
}

function clampText(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatPackHeadline(state: FridayPackReceiptState, locale: AppLocale): string {
  switch (state) {
    case "in_progress":
      return localize(locale, "Assistant 正在把这个包整理成可交付结果。", "Assistant is actively turning this pack into a usable result.");
    case "needs_approval":
      return localize(locale, "结果已经接近完成，但当前停在你的确认步骤。", "The result is nearly ready, but it is paused on your approval step.");
    case "degraded":
      return localize(locale, "已有结果草稿，但在交付前需要你先复查风险。", "There is a draft result, but it needs a quick review before you hand it off.");
    case "retryable":
      return localize(locale, "这是可重试的临时问题，通常再跑一次就能恢复。", "This looks retryable and usually recovers on another pass.");
    case "failed":
      return localize(locale, "当前结果被阻塞了，需要先处理问题再继续交付。", "The current result is blocked and needs recovery before it can be handed off.");
    case "ready":
      return localize(locale, "这包内容已经收成了一个可以继续推进的结果版本。", "This pack already has a result version that is ready for the next step.");
    default:
      return localize(locale, "还没有开始生成结果，Assistant 先帮你把结构和下一步准备好。", "No result has started yet, so Assistant is preparing the structure and next move.");
  }
}

function resolveStatePresentation(
  run: AgentRunRecord | null,
  state: FridayPackReceiptState,
  locale: AppLocale,
): Pick<FridayPackAssistantReceiptModel, "stateLabel" | "stateTone"> {
  if (run?.health) {
    return {
      stateLabel: labelForRunHealth(run, locale),
      stateTone: toneForRunHealth(run),
    };
  }

  switch (state) {
    case "in_progress":
      return { stateLabel: localize(locale, "进行中", "In Progress"), stateTone: "warning" };
    case "needs_approval":
      return { stateLabel: localize(locale, "待确认", "Needs Approval"), stateTone: "warning" };
    case "degraded":
      return { stateLabel: localize(locale, "已降级", "Degraded"), stateTone: "warning" };
    case "retryable":
      return { stateLabel: localize(locale, "可重试", "Retryable"), stateTone: "warning" };
    case "failed":
      return { stateLabel: localize(locale, "失败", "Failed"), stateTone: "danger" };
    case "ready":
      return { stateLabel: localize(locale, "可交付", "Ready"), stateTone: "success" };
    default:
      break;
  }

  return {
    stateLabel: localize(locale, "未开始", "Not Started"),
    stateTone: "neutral",
  };
}

function resolveEvidence(pack: FridayPackDefinition, run: AgentRunRecord | null, locale: AppLocale): string {
  if (!run) {
    return resolveLocalizedText(pack.productCopy?.resultSummary ?? pack.summary, locale);
  }

  return clampText(
    run.summary
      ?? run.responseText
      ?? run.errorMessage
      ?? describeRunHealth(run, locale)
      ?? resolveLocalizedText(pack.productCopy?.resultSummary ?? pack.summary, locale),
  );
}

function buildContextNotes(
  pack: FridayPackDefinition,
  run: AgentRunRecord | null,
  locale: AppLocale,
  approvalsCount: number,
  alertCount: number,
): string[] {
  const notes: string[] = [];
  if (run?.task) {
    notes.push(localize(locale, `最近处理：${run.task}`, `Latest task: ${run.task}`));
  }

  const contextSummary = run ? summarizeRunContext(run as RunHealthLike, locale) : null;
  if (contextSummary) {
    notes.push(contextSummary);
  }

  if (run?.rollbackAvailable) {
    notes.push(localize(locale, "这次运行保留了回退检查点。", "This run still has a rollback checkpoint."));
  }

  if (approvalsCount > 0) {
    notes.push(localize(locale, `当前还有 ${approvalsCount} 个待确认动作。`, `${approvalsCount} approval items still need review.`));
  }

  if (alertCount > 0) {
    notes.push(localize(locale, `当前有 ${alertCount} 个系统告警。`, `${alertCount} active system alerts are still open.`));
  }

  if (notes.length === 0) {
    notes.push(resolveLocalizedText(pack.productCopy?.audience ?? pack.summary, locale));
  }

  return notes.slice(0, 3);
}

function buildDeliverables(
  pack: FridayPackDefinition,
  locale: AppLocale,
  state: FridayPackReceiptState,
): FridayPackReceiptDeliverable[] {
  const deliverables = pack.productCopy?.deliverables ?? [];
  return deliverables.map((deliverable, index) => {
    const title = resolveLocalizedText(deliverable.title, locale);
    const detail = resolveLocalizedText(deliverable.detail, locale);

    if (state === "ready") {
      return { title, detail, statusLabel: localize(locale, "已就绪", "Ready"), tone: "success" };
    }
    if (state === "in_progress") {
      return {
        title,
        detail,
        statusLabel: index === 0 ? localize(locale, "生成中", "In Progress") : localize(locale, "下一步", "Up Next"),
        tone: index === 0 ? "warning" : "neutral",
      };
    }
    if (state === "needs_approval") {
      return {
        title,
        detail,
        statusLabel: index === 0 ? localize(locale, "等你确认", "Waiting For Approval") : localize(locale, "确认后继续", "Unlocks After Review"),
        tone: "warning",
      };
    }
    if (state === "degraded") {
      return { title, detail, statusLabel: localize(locale, "交付前复查", "Review Before Handoff"), tone: "warning" };
    }
    if (state === "retryable") {
      return { title, detail, statusLabel: localize(locale, "建议重试", "Retry Recommended"), tone: "warning" };
    }
    if (state === "failed") {
      return { title, detail, statusLabel: localize(locale, "已阻塞", "Blocked"), tone: "danger" };
    }
    return { title, detail, statusLabel: localize(locale, "待生成", "Waiting"), tone: "neutral" };
  });
}

function buildNextActions(
  pack: FridayPackDefinition,
  locale: AppLocale,
  state: FridayPackReceiptState,
  approvalsCount: number,
  alertCount: number,
): FridayPackReceiptAction[] {
  const prompts = pack.productCopy?.entryPrompts ?? [];
  const primaryPrompt = prompts[0];
  const secondaryPrompt = prompts[1];
  const actions: FridayPackReceiptAction[] = [];

  const addPromptAction = (promptId: string | undefined, label: string, tone: "primary" | "secondary") => {
    if (!promptId) {
      return;
    }
    actions.push({ id: "use_prompt", promptId, label, tone });
  };

  switch (state) {
    case "in_progress":
      actions.push({
        id: "continue_chat",
        label: localize(locale, "去聊天看实时进展", "Open live progress in chat"),
        tone: "primary",
      });
      break;
    case "needs_approval":
      actions.push({
        id: "review_approvals",
        label: localize(locale, "先看待确认动作", "Review approval items"),
        tone: "primary",
      });
      actions.push({
        id: "continue_chat",
        label: localize(locale, "回到聊天继续上下文", "Continue in chat"),
        tone: "secondary",
      });
      break;
    case "degraded":
      actions.push({
        id: "open_observability",
        label: localize(locale, "先看风险与告警", "Review risk and alerts"),
        tone: "primary",
      });
      actions.push({
        id: "continue_chat",
        label: localize(locale, "回到聊天补全结果", "Continue the result in chat"),
        tone: "secondary",
      });
      addPromptAction(primaryPrompt?.id, localize(locale, "用推荐开场重跑", "Retry with the suggested start"), "secondary");
      break;
    case "retryable":
      addPromptAction(primaryPrompt?.id, localize(locale, "重新试一次", "Retry now"), "primary");
      actions.push({
        id: "continue_chat",
        label: localize(locale, "回到聊天保留上下文", "Keep context in chat"),
        tone: "secondary",
      });
      actions.push({
        id: "open_observability",
        label: localize(locale, "看系统侧原因", "Inspect the system-side issue"),
        tone: "secondary",
      });
      break;
    case "failed":
      actions.push({
        id: "open_observability",
        label: localize(locale, "先做恢复检查", "Start with recovery checks"),
        tone: "primary",
      });
      addPromptAction(primaryPrompt?.id, localize(locale, "换推荐开场重做", "Retry from the suggested start"), "secondary");
      actions.push({
        id: "continue_chat",
        label: localize(locale, "回到聊天整理修复路径", "Use chat to plan the recovery"),
        tone: "secondary",
      });
      break;
    case "ready":
      actions.push({
        id: "continue_chat",
        label: localize(locale, "在聊天里继续细化结果", "Refine the result in chat"),
        tone: "primary",
      });
      addPromptAction(
        secondaryPrompt?.id ?? primaryPrompt?.id,
        localize(locale, "基于这个结果继续下一步", "Use this result for the next step"),
        "secondary",
      );
      break;
    default:
      addPromptAction(primaryPrompt?.id, localize(locale, "用推荐开场开始", "Start with the suggested prompt"), "primary");
      addPromptAction(
        secondaryPrompt?.id,
        localize(locale, "换另一种开始方式", "Try a different start"),
        "secondary",
      );
      break;
  }

  if (approvalsCount > 0 && state !== "needs_approval") {
    actions.push({
      id: "review_approvals",
      label: localize(locale, "顺手看待确认动作", "Check approval items"),
      tone: "secondary",
    });
  }

  if (alertCount > 0 && state !== "degraded" && state !== "retryable" && state !== "failed") {
    actions.push({
      id: "open_observability",
      label: localize(locale, "看系统风险", "Review system alerts"),
      tone: "secondary",
    });
  }

  if (pack.productCopy?.assistantHandoff) {
    actions.push({
      id: "open_assistant",
      label: resolveLocalizedText(pack.productCopy.assistantHandoff.actionLabel, locale),
      tone: state === "not_started" ? "secondary" : "secondary",
    });
  }

  return actions.slice(0, 4);
}

export function buildPackAssistantReceiptModel(input: {
  pack: FridayPackDefinition;
  runs: AgentRunRecord[];
  locale: AppLocale;
  approvalsCount?: number;
  alertCount?: number;
}): FridayPackAssistantReceiptModel | null {
  const { pack, runs, locale, approvalsCount = 0, alertCount = 0 } = input;
  if (!pack.productCopy) {
    return null;
  }

  const { currentRun } = findPackRuns(pack, runs);
  const state = resolveReceiptState(currentRun);
  const statePresentation = resolveStatePresentation(currentRun, state, locale);

  return {
    state,
    stateLabel: statePresentation.stateLabel,
    stateTone: statePresentation.stateTone,
    headline: formatPackHeadline(state, locale),
    latestTask: currentRun?.task ?? null,
    evidence: resolveEvidence(pack, currentRun, locale),
    contextNotes: buildContextNotes(pack, currentRun, locale, approvalsCount, alertCount),
    deliverables: buildDeliverables(pack, locale, state),
    nextActions: buildNextActions(pack, locale, state, approvalsCount, alertCount),
    currentRun,
  };
}
