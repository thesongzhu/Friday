import type {
  FridayConversationTurnKind,
  FridayEvidenceBlock,
  FridaySessionConversationFocusState,
} from "#sessions";

import type { FridayAgentCapabilitiesSnapshot } from "../tools/friday-agent-capabilities-tool.js";
import type { FridayAgentTaskStatusSnapshot } from "../tools/friday-agent-task-status-tool.js";

const STATUS_HINTS =
  /\b(status|progress|running|waiting|completed|failed|blocked|doing|doing right now|latest result|eta|done yet|finished yet|what are you doing|what happened|what was the issue|why failed)\b/i;
const CHINESE_STATUS_HINTS =
  /(状态|进度|还在|等待|完成了吗|失败|为什么failed|为什么失败|现在在做什么|那个任务结果呢|结果呢|怎么了|发生了什么)/;
const STATUS_QUESTION_PREFIX_HINTS =
  /^(?:what(?:'s| is)?|why|how|when|did|does|is|are|where|status|progress|result|results|latest result|what are you doing|what happened|what was the issue|why failed)\b/i;
const CHINESE_STATUS_QUESTION_PREFIX_HINTS =
  /^(?:状态|进度|还在|等待|完成了吗|失败|为什么failed|为什么失败|现在在做什么|那个任务结果呢|结果呢|怎么了|发生了什么)/;
const STATUS_REFERENCE_HINTS =
  /^(?:that task|that run|that result|that one|the result|what is the final result now|what's the final result now|what is the result now|what's the result now)$/i;
const CHINESE_STATUS_REFERENCE_HINTS =
  /^(?:那个任务结果呢|结果呢|这里|那个|同一个问题)$/;
const STATUS_FALSE_POSITIVES =
  /\bgit status\b|\breport the result\b|\bworkflow response\b|\brepo-health-check\b/i;
const CAPABILITY_HINTS =
  /\b(capabilities?|what can\b|can (?:friday|you)\b.*\bdo\b|enabled|disabled|deployment|runtime facts?|messaging|discord|mcp|desktop companion|provider mutations?|read[- ]?only)\b/i;
const CHINESE_CAPABILITY_HINTS =
  /(能力|能做什么|启用|禁用|部署|运行时|discord|mcp|桌面伴侣|提供者修改|只读)/i;
const HARNESS_RESUME_HINTS =
  /\b(continue|resume|keep going|pick up|carry on|stuck|where .*stuck|that (?:skill|workflow)|the (?:skill|workflow)|that generator|that draft)\b/i;
const CHINESE_HARNESS_RESUME_HINTS =
  /(继续|恢复|接着|接上|卡在哪|卡住了|那个(?:skill|workflow|技能|工作流)|那个草稿|那个生成器)/;

export interface BuildFridayEvidenceBlocksInput {
  task: string;
  turnKind: FridayConversationTurnKind;
  focusState?: FridaySessionConversationFocusState | null;
  capabilitiesSnapshot?: FridayAgentCapabilitiesSnapshot;
  taskStatusSnapshot?: FridayAgentTaskStatusSnapshot;
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function formatElapsed(elapsedMs: number | undefined): string {
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return "unknown";
  }
  if (elapsedMs < 1000) {
    return `${String(elapsedMs)}ms`;
  }
  const seconds = Math.round(elapsedMs / 1000);
  if (seconds < 90) {
    return `${String(seconds)}s`;
  }
  return `${String(Math.round(seconds / 60))}m`;
}

function formatCapabilitiesSummary(snapshot: FridayAgentCapabilitiesSnapshot): string {
  const messagingSummary = snapshot.messaging.enabled
    ? `messaging enabled (${snapshot.messaging.kinds.join(", ")})`
    : "messaging disabled";
  const mcpSummary = snapshot.mcp.enabled
    ? `MCP enabled (${String(snapshot.mcp.serverCount)} server${snapshot.mcp.serverCount === 1 ? "" : "s"})`
    : "MCP disabled";
  const providerSummary = snapshot.provider.available
    ? `provider mutations ${snapshot.provider.mutationBlockedByReadOnly ? "blocked by readOnly" : "available"}`
    : "provider unavailable";
  const browserSummary = snapshot.browser.activeMode || snapshot.browser.targetBrowser
    ? `browser ${snapshot.browser.activeMode ?? "unknown"}${snapshot.browser.targetBrowser ? ` (${snapshot.browser.targetBrowser})` : ""}`
    : "browser mode unavailable";
  const desktopSummary = snapshot.desktop.connected
    ? "desktop connected"
    : "desktop disconnected";
  const companionSummary = snapshot.companion.connected
    ? "desktop companion connected"
    : "desktop companion disconnected";
  return normalizeText(
    [
      messagingSummary,
      mcpSummary,
      providerSummary,
      browserSummary,
      snapshot.system.enabled ? "system enabled" : "system disabled",
      desktopSummary,
      companionSummary,
    ].join("; "),
  );
}

function formatTaskStatusSummary(snapshot: FridayAgentTaskStatusSnapshot): string {
  const parts: string[] = [];
  if (snapshot.trackedRunId) {
    parts.push(`run ${snapshot.trackedRunId}`);
  } else if (snapshot.pendingPlanRunId) {
    parts.push(`pending plan ${snapshot.pendingPlanRunId}`);
  } else {
    parts.push("no tracked run");
  }
  if (snapshot.runStatus) {
    parts.push(`status ${snapshot.runStatus}`);
  }
  if (snapshot.phase) {
    parts.push(`phase ${snapshot.phase}`);
  }
  if (snapshot.elapsedMs !== undefined) {
    parts.push(`elapsed ${formatElapsed(snapshot.elapsedMs)}`);
  }
  if (snapshot.latestTool) {
    parts.push(`latest tool ${snapshot.latestTool}`);
  }
  if (snapshot.blockers.length > 0) {
    parts.push(`blockers ${snapshot.blockers.join(" | ")}`);
  }
  if (snapshot.terminalOutcome?.summary) {
    parts.push(`summary ${snapshot.terminalOutcome.summary}`);
  } else if (snapshot.terminalOutcome?.responseText) {
    parts.push(`response ${snapshot.terminalOutcome.responseText}`);
  }
  const latestCompletedSubagent = snapshot.recentCompletedSubagents?.[0];
  if (latestCompletedSubagent?.outcomeResponse) {
    parts.push(`latest completed subagent ${latestCompletedSubagent.id} response ${latestCompletedSubagent.outcomeResponse}`);
  }
  return normalizeText(parts.join("; "));
}

function shouldIncludeStatusEvidence(input: BuildFridayEvidenceBlocksInput): boolean {
  if (input.turnKind === "status_check") {
    return true;
  }

  const task = normalizeText(input.task);
  if (task.length === 0) {
    return false;
  }

  if (STATUS_FALSE_POSITIVES.test(task)) {
    return false;
  }

  if (STATUS_QUESTION_PREFIX_HINTS.test(task) || CHINESE_STATUS_QUESTION_PREFIX_HINTS.test(task)) {
    return true;
  }

  if (/[?？]/.test(task) && (STATUS_HINTS.test(task) || CHINESE_STATUS_HINTS.test(task))) {
    return true;
  }

  if (
    (input.focusState?.pendingPlanRunId || input.focusState?.activeRunId || input.focusState?.activeSubagentIds?.length)
    && (STATUS_REFERENCE_HINTS.test(task) || CHINESE_STATUS_REFERENCE_HINTS.test(task))
  ) {
    return true;
  }

  return false;
}

function shouldIncludeCapabilitiesEvidence(input: BuildFridayEvidenceBlocksInput): boolean {
  return CAPABILITY_HINTS.test(input.task) || CHINESE_CAPABILITY_HINTS.test(input.task);
}

function shouldIncludeHarnessEvidence(input: BuildFridayEvidenceBlocksInput): boolean {
  if (!input.focusState?.lastHarnessSummary) {
    return false;
  }
  if (input.turnKind === "status_check" || input.turnKind === "continue_active_task") {
    return true;
  }
  if (input.turnKind !== "follow_up") {
    return false;
  }
  return HARNESS_RESUME_HINTS.test(input.task) || CHINESE_HARNESS_RESUME_HINTS.test(input.task);
}

function formatHarnessSummary(focusState: FridaySessionConversationFocusState): string {
  return normalizeText([
    focusState.lastHarnessStage ? `stage ${focusState.lastHarnessStage}` : undefined,
    focusState.lastHarnessSummary ? `summary ${focusState.lastHarnessSummary}` : undefined,
    focusState.lastHandoffArtifactId ? `handoff artifact ${focusState.lastHandoffArtifactId}` : undefined,
  ].filter((value): value is string => Boolean(value)).join("; "));
}

export function buildFridayEvidenceBlocks(
  input: BuildFridayEvidenceBlocksInput,
): FridayEvidenceBlock[] {
  const blocks: FridayEvidenceBlock[] = [];

  if (input.capabilitiesSnapshot && shouldIncludeCapabilitiesEvidence(input)) {
    blocks.push({
      id: "evidence:capabilities",
      source: "capabilities_block",
      summary: formatCapabilitiesSummary(input.capabilitiesSnapshot),
      score: 120,
      reason: "Deterministic runtime capability facts selected for a deployment/capabilities question.",
    });
  }

  if (input.taskStatusSnapshot && shouldIncludeStatusEvidence(input)) {
    blocks.push({
      id: "evidence:task-status",
      source: "task_status_block",
      summary: formatTaskStatusSummary(input.taskStatusSnapshot),
      score: input.turnKind === "status_check" ? 125 : 92,
      reason: "Deterministic task status snapshot selected for a status/progress/result question.",
    });

    if (input.taskStatusSnapshot.phase || input.taskStatusSnapshot.latestTool) {
      blocks.push({
        id: "evidence:run-activity",
        source: "run_event_block",
        summary: normalizeText([
          input.taskStatusSnapshot.phase ? `latest phase ${input.taskStatusSnapshot.phase}` : undefined,
          input.taskStatusSnapshot.latestTool ? `latest tool ${input.taskStatusSnapshot.latestTool}` : undefined,
          input.taskStatusSnapshot.elapsedMs !== undefined
            ? `elapsed ${formatElapsed(input.taskStatusSnapshot.elapsedMs)}`
            : undefined,
        ].filter((value): value is string => Boolean(value)).join("; ")),
        score: input.turnKind === "status_check" ? 114 : 84,
        reason: "Latest run activity derived from deterministic run-event-backed task status.",
      });
    }

    for (const subagent of input.taskStatusSnapshot.activeSubagents.slice(0, 2)) {
      blocks.push({
        id: `evidence:subagent:${subagent.id}`,
        source: "delegated_task_block",
        summary: normalizeText([
          `subagent ${subagent.id}`,
          subagent.label ? `label ${subagent.label}` : undefined,
          `status ${subagent.status}`,
          `task ${subagent.task}`,
          subagent.childRunId ? `child run ${subagent.childRunId}` : undefined,
        ].filter((value): value is string => Boolean(value)).join("; ")),
        score: input.turnKind === "status_check" ? 112 : 82,
        reason: "Active delegated subagent selected as deterministic status evidence.",
      });
    }

    for (const subagent of (input.taskStatusSnapshot.recentCompletedSubagents ?? []).slice(0, 2)) {
      blocks.push({
        id: `evidence:completed-subagent:${subagent.id}`,
        source: "delegated_task_block",
        summary: normalizeText([
          `subagent ${subagent.id}`,
          subagent.label ? `label ${subagent.label}` : undefined,
          `status ${subagent.status}`,
          `task ${subagent.task}`,
          subagent.childRunId ? `child run ${subagent.childRunId}` : undefined,
          subagent.outcomeResponse ? `response ${subagent.outcomeResponse}` : undefined,
        ].filter((value): value is string => Boolean(value)).join("; ")),
        score: input.turnKind === "status_check" ? 111 : 81,
        reason: "Latest completed delegated subagent selected as deterministic result evidence.",
      });
    }

    if (
      input.taskStatusSnapshot.pendingPlanRunId
      || input.taskStatusSnapshot.runStatus === "awaiting_clarification"
      || input.taskStatusSnapshot.runStatus === "awaiting_plan_approval"
    ) {
      blocks.push({
        id: "evidence:planning-gate",
        source: "plan_block",
        summary: normalizeText([
          input.taskStatusSnapshot.pendingPlanRunId
            ? `pending plan run ${input.taskStatusSnapshot.pendingPlanRunId}`
            : undefined,
          input.taskStatusSnapshot.runStatus
            ? `planning state ${input.taskStatusSnapshot.runStatus}`
            : undefined,
          input.taskStatusSnapshot.blockers.length > 0
            ? `blockers ${input.taskStatusSnapshot.blockers.join(" | ")}`
            : undefined,
        ].filter((value): value is string => Boolean(value)).join("; ")),
        score: 118,
        reason: "Planning gate state selected as deterministic evidence for approval/clarification follow-ups.",
      });
    }
  }

  if (input.focusState && shouldIncludeHarnessEvidence(input)) {
    blocks.push({
      id: "evidence:harness",
      source: "harness_block",
      summary: formatHarnessSummary(input.focusState),
      score: input.turnKind === "continue_active_task" ? 93 : 89,
      reason: "Persisted harness handoff selected to resume a generated skill/workflow without reconstructing it from chat history.",
    });
  }

  return blocks
    .filter((block) => block.summary.length > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}
