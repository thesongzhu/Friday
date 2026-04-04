import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import {
  FRIDAY_AGENT_ERROR_CODES,
} from "../friday-agent.constants.js";
import type {
  FridayAgentToolCallRecord,
  FridayAgentToolDefinition,
} from "../model/friday-agent.types.js";

// ─── Constants ───

export const FRIDAY_DESKTOP_UNAVAILABLE_MESSAGE =
  'Tool "desktop" is unavailable because desktop runtime is not enabled. Set FRIDAY_DESKTOP_ENABLED=true and restart Friday.';

export const FRIDAY_SYSTEM_UNAVAILABLE_MESSAGE =
  'Tool "system" is unavailable because Friday Agent OS system orchestration is not enabled. Set FRIDAY_SYSTEM_ENABLED=true and restart Friday.';

// ─── Types ───

export interface OutputClosureGap {
  errorCode: string;
  userMessage: string;
  developerMessage: string;
  attemptedImageToolCalls: number;
  failedImageToolCalls: number;
}

const READ_ONLY_DIAGNOSTIC_SKILL_IDS = new Set([
  "repo-health-check",
  "workspace-change-risk-review",
  "release-readiness-check",
  "log-error-triage",
  "local-service-diagnose",
  "incident-brief-generator",
  "system-health-snapshot",
  "review-open-issues",
  "autofix-readiness-review",
  "failed-deploy-recovery-brief",
  "idea-clarifier",
  "implementation-plan-review",
  "browser-qa-report",
  "workspace-diff-review",
  "page-benchmark-report",
  "release-canary-check",
  "engineering-retro",
  "product-scope-review",
  "design-plan-review",
  "security-review",
]);

export function normalizeDefaultRouteSentinel(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized === "default") {
    return undefined;
  }
  return normalized;
}

export function hasSafeDiagnosticCompletionEvidence(params: {
  task: string;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
}): boolean {
  if (params.responseText.trim().length === 0) {
    return false;
  }

  return params.toolCalls.some((call) => {
    if (call.result.isError) {
      return false;
    }
    if (call.toolName === "skill_run") {
      const skillId = typeof call.args.skillId === "string" ? call.args.skillId : "";
      return READ_ONLY_DIAGNOSTIC_SKILL_IDS.has(skillId);
    }
    if (call.toolName === "system") {
      return call.args.action === "snapshot";
    }
    if (call.toolName === "skills_list") {
      return true;
    }
    return false;
  });
}

export function detectOutputClosureGap(params: {
  task: string;
  toolCalls: FridayAgentToolCallRecord[];
  images: string[];
}): OutputClosureGap | null {
  if (params.images.length > 0) return null;

  const imageArtifactCalls = params.toolCalls.filter(isImageArtifactCall);
  if (imageArtifactCalls.length === 0) return null;

  const failedImageCalls = imageArtifactCalls.filter((call) => call.result.isError);
  const failedCount = failedImageCalls.length;
  const attemptedCount = imageArtifactCalls.length;

  // Only enforce hard failure for explicit screenshot artifact routes.
  const requestedScreenshot = imageArtifactCalls.some((call) => isBrowserScreenshotCall(call.args));
  if (!requestedScreenshot) return null;

  const latestFailure = failedImageCalls[failedImageCalls.length - 1];
  const failureDetail = latestFailure?.result.content
    ? latestFailure.result.content.replace(/\s+/g, " ").trim()
    : "unknown screenshot tool failure";

  return {
    errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
    userMessage:
      "Output delivery failed: screenshot artifact was not produced. " +
      "Please retry after browser runtime is available.",
    developerMessage:
      `Screenshot closure failed for task "${params.task.slice(0, 120)}": ` +
      `${String(attemptedCount)} screenshot tool call(s), ${String(failedCount)} failed, ` +
      "0 image artifact paths extracted. " +
      `Last failure: ${failureDetail}`,
    attemptedImageToolCalls: attemptedCount,
    failedImageToolCalls: failedCount,
  };
}

export function detectEvidenceClosureGap(params: {
  task: string;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
  toolMap: Map<string, FridayAgentToolDefinition>;
  disabledToolNames?: ReadonlySet<string>;
}): OutputClosureGap | null {
  const normalizedTask = params.task.trim();
  if (normalizedTask.length === 0) return null;

  const category = classifyEvidenceTask(normalizedTask);
  if (!category) return null;

  const hasAttemptedEvidenceTool = params.toolCalls.some((call) => {
    if (category === "desktop") {
      return call.toolName === "system"
        || call.toolName === "desktop"
        || call.toolName === "exec"
        || call.toolName === "read"
        || call.toolName === "browser";
    }
    return call.toolName === "web_fetch"
      || call.toolName === "web_search"
      || call.toolName === "browser";
  });

  if (
    !hasAttemptedEvidenceTool
    && !hasEvidenceCapableTools(params.toolMap, params.disabledToolNames, category)
  ) {
    return null;
  }

  if (hasSuccessfulToolEvidence(params.toolCalls)) return null;

  if (category === "web" && !taskLooksLikeExternalAction(normalizedTask)) {
    return null;
  }

  const failedCalls = params.toolCalls.filter((call) => call.result.isError);
  const latestFailure = failedCalls[failedCalls.length - 1];
  const failureDetail = latestFailure?.result.content
    ? latestFailure.result.content.replace(/\s+/g, " ").trim()
    : "LLM produced no successful evidence-capable tool result";
  const attemptedCount = params.toolCalls.length;
  const failedCount = failedCalls.length;
  const responseSummary = params.responseText.trim().slice(0, 200);

  if (category === "desktop") {
    const desktopUnavailable = hasDesktopRuntimeUnavailableFailure(params.toolCalls);
    const userMessage = desktopUnavailable
      ? "Desktop or system orchestration runtime is not enabled. Set FRIDAY_SYSTEM_ENABLED=true and/or FRIDAY_DESKTOP_ENABLED=true, then restart Friday."
      : "Desktop action could not be completed with verifiable output. " +
        "Retry after checking desktop permissions, then provide selector details only if needed.";

    return {
      errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
      userMessage,
      developerMessage:
        `Desktop evidence closure failed for task "${normalizedTask.slice(0, 120)}": ` +
        `${String(attemptedCount)} tool call(s), ${String(failedCount)} failed, no successful evidence. ` +
        `Last failure: ${failureDetail}. Final response: ${responseSummary}`,
      attemptedImageToolCalls: attemptedCount,
      failedImageToolCalls: failedCount,
    };
  }

  return {
    errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
    userMessage:
      "External task could not be completed with verifiable tool output. " +
      "Please retry after checking network/tool availability.",
    developerMessage:
      `Evidence closure failed for web task "${normalizedTask.slice(0, 120)}": ` +
      `${String(attemptedCount)} tool call(s), ${String(failedCount)} failed, no successful evidence. ` +
      `Last failure: ${failureDetail}. Final response: ${responseSummary}`,
    attemptedImageToolCalls: attemptedCount,
    failedImageToolCalls: failedCount,
  };
}

export function detectArtifactTruthGap(params: {
  task: string;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
}): OutputClosureGap | null {
  return detectRequiredBlockerArtifactGap(params)
    ?? detectApprovalBoundaryArtifactGap(params)
    ?? detectSourceArtifactCompletionGap(params);
}

function detectRequiredBlockerArtifactGap(params: {
  task: string;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
}): OutputClosureGap | null {
  if (!taskRequiresExplicitBlockerRecord(params.task)) {
    return null;
  }

  const writtenArtifacts = listSuccessfulWrittenTextArtifacts(params.toolCalls);
  if (writtenArtifacts.length === 0) {
    return null;
  }

  const missingFiles = extractMissingFileMentions(params.task);
  const hasRecordedBlocker = writtenArtifacts.some((artifact) =>
    contentHasExplicitBlockerRecord(artifact.content, missingFiles)
  );
  if (hasRecordedBlocker) {
    return null;
  }

  return {
    errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
    userMessage:
      "Artifact truth check failed: the required blocker was not recorded in the written artifact.",
    developerMessage:
      `Task "${params.task.slice(0, 160)}" required a recorded blocker, but written artifacts ` +
      `(${writtenArtifacts.map((artifact) => artifact.path).join(", ")}) did not contain a clear blocker section.`,
    attemptedImageToolCalls: 0,
    failedImageToolCalls: 0,
  };
}

function detectApprovalBoundaryArtifactGap(params: {
  task: string;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
}): OutputClosureGap | null {
  if (
    !taskRequiresApprovalBoundary(params.task)
    || !taskRequestsDecisionArtifact(params.task)
    || !hasBlockedApprovalAttempt(params.toolCalls)
  ) {
    return null;
  }

  const writtenArtifacts = listSuccessfulWrittenTextArtifacts(params.toolCalls);
  const decisionArtifacts = writtenArtifacts.filter((artifact) => /decision|plan/i.test(basename(artifact.path)));

  if (decisionArtifacts.length === 0) {
    return {
      errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
      userMessage:
        "Artifact truth check failed: approval-boundary reasoning was required but no decision artifact was written.",
      developerMessage:
        `Task "${params.task.slice(0, 160)}" triggered approval-boundary blocking, but no decision/plan artifact was written after blocked attempts.`,
      attemptedImageToolCalls: 0,
      failedImageToolCalls: 0,
    };
  }

  const honestDecision = decisionArtifacts.some((artifact) =>
    contentHonestlyStatesApprovalBoundary(artifact.content)
  );
  const responseClaimsExecution = appearsToClaimDestructiveCompletion(params.responseText);
  if (honestDecision && !responseClaimsExecution) {
    return null;
  }

  return {
    errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
    userMessage:
      "Artifact truth check failed: approval-boundary output must say the action was stopped pending approval and not executed.",
    developerMessage:
      `Approval-boundary task "${params.task.slice(0, 160)}" had blocked destructive attempts, but decision artifacts ` +
      `(${decisionArtifacts.map((artifact) => artifact.path).join(", ")}) or the final response still implied execution.`,
    attemptedImageToolCalls: 0,
    failedImageToolCalls: 0,
  };
}

function detectSourceArtifactCompletionGap(params: {
  task: string;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
}): OutputClosureGap | null {
  const requirement = extractSourceBackedArtifactRequirement(params.task);
  if (!requirement || !appearsToClaimArtifactCompletion(params.responseText)) {
    return null;
  }

  const writtenArtifacts = listSuccessfulWrittenTextArtifacts(params.toolCalls);
  if (writtenArtifacts.length === 0) {
    return null;
  }

  const outputArtifact = matchArtifactByTaskPath(writtenArtifacts, requirement.outputPath)
    ?? writtenArtifacts.find((artifact) => basename(artifact.path) !== basename(requirement.sourcePath));
  if (!outputArtifact) {
    return null;
  }

  const sourcePath = resolveTaskFilePath(requirement.sourcePath, outputArtifact.path);
  if (!existsSync(sourcePath)) {
    return null;
  }

  // P1-04: Sync read is acceptable — reading artifacts the agent just wrote locally.
  let sourceText = "";
  try {
    sourceText = readFileSync(sourcePath, "utf8");
  } catch (err) {
    console.warn("[friday][agent-runtime] read-source-file:", err instanceof Error ? err.message : String(err));
    return null;
  }

  if (contentCarriesSourceEvidence(sourceText, outputArtifact.content)) {
    return null;
  }

  return {
    errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
    userMessage:
      "Artifact truth check failed: the completion claim does not match the actual content written to the required artifact.",
    developerMessage:
      `Task "${params.task.slice(0, 160)}" required ${requirement.outputPath} to use ${requirement.sourcePath}, ` +
      `but artifact "${outputArtifact.path}" did not contain meaningful source-derived content.`,
    attemptedImageToolCalls: 0,
    failedImageToolCalls: 0,
  };
}

function listSuccessfulWrittenTextArtifacts(
  toolCalls: FridayAgentToolCallRecord[],
): Array<{ path: string; content: string }> {
  const artifacts: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();

  for (const call of toolCalls) {
    if (call.result.isError || (call.toolName !== "write" && call.toolName !== "edit")) {
      continue;
    }
    const filePath = typeof call.args.path === "string" ? call.args.path.trim() : "";
    if (!filePath || seen.has(filePath) || !existsSync(filePath)) {
      continue;
    }
    try {
      // P1-04: Sync read is acceptable — reading artifacts the agent just wrote locally.
      const content = readFileSync(filePath, "utf8");
      seen.add(filePath);
      artifacts.push({ path: filePath, content });
    } catch (err) {
      // Best-effort read: skip binary/unavailable artifacts.
      console.warn("[friday][agent-runtime] read-artifact:", err instanceof Error ? err.message : String(err));
    }
  }

  return artifacts;
}

function taskRequiresExplicitBlockerRecord(task: string): boolean {
  return /\b(record|explicitly record|document|include)\b[\s\S]{0,32}\bblocker\b/i.test(task)
    || /(记录|写明|注明).{0,10}(阻塞|卡点)/.test(task);
}

function extractMissingFileMentions(task: string): string[] {
  const matches = task.match(/\b[\w./-]+\.[A-Za-z0-9]+\b/g) ?? [];
  return [...new Set(matches.filter((match) => {
    const escaped = match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`${escaped}[\\s\\S]{0,24}\\bmissing\\b|\\bmissing\\b[\\s\\S]{0,24}${escaped}`, "i");
    return regex.test(task);
  }))];
}

function contentHasExplicitBlockerRecord(content: string, missingFiles: string[]): boolean {
  const normalized = content.toLowerCase();
  const hasBlockerLabel = /\b(blocker|blocked|missing dependency)\b/i.test(content) || /(阻塞|卡点|缺少)/.test(content);
  if (!hasBlockerLabel) {
    return false;
  }

  if (missingFiles.length === 0) {
    return /\bmissing\b/i.test(content) || /(缺失|缺少|不存在)/.test(content);
  }

  return missingFiles.some((fileName) => normalized.includes(fileName.toLowerCase()))
    && (/\bmissing\b/i.test(content) || /(缺失|缺少|不存在)/.test(content));
}

function taskRequiresApprovalBoundary(task: string): boolean {
  return (
    /\b(risky|destructive|approval|approve|confirm)\b/i.test(task)
    && /\b(stop|ask|instead of making changes|before making changes)\b/i.test(task)
  ) || /(高风险|危险|审批|批准).{0,20}(停止|先问|不要直接执行)/.test(task);
}

function taskRequestsDecisionArtifact(task: string): boolean {
  return /\b(decision|plan)\.[A-Za-z0-9]+\b/i.test(task)
    || /\bwrite\b[\s\S]{0,24}\b(decision|plan)\b/i.test(task)
    || /(写|生成).{0,10}(decision|plan)\.[A-Za-z0-9]+/i.test(task);
}

function hasBlockedApprovalAttempt(toolCalls: FridayAgentToolCallRecord[]): boolean {
  return toolCalls.some((call) =>
    Boolean(call.result.isError)
    && /\bapproval\b/i.test(call.result.content)
    && /\b(blocked|require|pending)\b/i.test(call.result.content)
  );
}

function contentHonestlyStatesApprovalBoundary(content: string): boolean {
  const hasApprovalMarker = /\b(approval|approve|confirm|risky|destructive)\b/i.test(content)
    || /(审批|批准|确认|高风险|危险)/.test(content);
  const hasStoppedMarker = /\b(stopped|pending approval|awaiting approval|not executed|did not execute|not run)\b/i.test(content)
    || /(已停止|待审批|待批准|未执行|没有执行|未运行)/.test(content);
  return hasApprovalMarker && hasStoppedMarker;
}

function appearsToClaimDestructiveCompletion(text: string): boolean {
  return /\b(i|we)\s+(deleted|rotated|reset|updated|executed|completed)\b/i.test(text)
    || /\b(successfully|completed)\b[\s\S]{0,24}\b(delete|rotate|reset|update)\b/i.test(text)
    || /(已|已经|成功|完成).{0,10}(删除|轮换|重置|更新|执行)/.test(text);
}

function extractSourceBackedArtifactRequirement(
  task: string,
): { outputPath: string; sourcePath: string } | null {
  const sourceMatch = task.match(/\b(?:using|use|based on)\s+([^\s:]+?\.[A-Za-z0-9]+)\b/i)
    ?? task.match(/使用\s*([^\s:]+?\.[A-Za-z0-9]+)\b/i);
  if (!sourceMatch?.[1]) {
    return null;
  }

  const outputMatch = task.match(/\b(?:create|write|generate|update)\s+([^\s:]+?\.[A-Za-z0-9]+)\b/i)
    ?? task.match(/(?:创建|写入|生成|更新)\s*([^\s:]+?\.[A-Za-z0-9]+)\b/i);
  if (!outputMatch?.[1]) {
    return null;
  }

  return {
    outputPath: stripTrailingPunctuation(outputMatch[1]),
    sourcePath: stripTrailingPunctuation(sourceMatch[1]),
  };
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[),.;:]+$/g, "");
}

function matchArtifactByTaskPath(
  artifacts: Array<{ path: string; content: string }>,
  taskPath: string,
): { path: string; content: string } | undefined {
  return artifacts.find((artifact) => {
    const artifactBase = basename(artifact.path).toLowerCase();
    return artifact.path === taskPath || artifactBase === basename(taskPath).toLowerCase();
  });
}

function resolveTaskFilePath(taskPath: string, relativeToArtifactPath: string): string {
  if (isAbsolute(taskPath)) {
    return taskPath;
  }
  return resolve(dirname(relativeToArtifactPath), taskPath);
}

function contentCarriesSourceEvidence(sourceText: string, artifactText: string): boolean {
  const sourceTokens = tokenizeEvidenceWords(sourceText);
  if (sourceTokens.length === 0) {
    return false;
  }

  const artifactLower = artifactText.toLowerCase();
  const overlappingTokens = sourceTokens.filter((token) => artifactLower.includes(token));
  if (overlappingTokens.length >= Math.min(2, sourceTokens.length)) {
    return true;
  }

  const sourceLine = sourceText
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length >= 12);
  return Boolean(sourceLine && artifactText.toLowerCase().includes(sourceLine.toLowerCase().slice(0, 24)));
}

function tokenizeEvidenceWords(text: string): string[] {
  return [...new Set(
    text.toLowerCase().match(/\b[a-z][a-z0-9_-]{3,}\b/g) ?? [],
  )];
}

function appearsToClaimArtifactCompletion(text: string): boolean {
  return /\b(i|we)\s+(created|wrote|updated|documented|completed|finished)\b/i.test(text)
    || /\b(created|wrote|updated|documented|completed|finished)\b[\s\S]{0,24}\b(result|decision|file|artifact)\b/i.test(text)
    || /(已|已经|成功|完成).{0,10}(创建|写入|更新|记录|完成)/.test(text);
}

function isImageArtifactCall(call: FridayAgentToolCallRecord): boolean {
  if (call.toolName === "browser") {
    return isBrowserScreenshotCall(call.args);
  }
  // Canvas may emit images too; keep this broad for future closure coverage.
  if (call.toolName === "canvas") {
    return true;
  }
  return false;
}

function isBrowserScreenshotCall(args: Record<string, unknown>): boolean {
  const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
  return action === "screenshot";
}

export function enforceToolEvidenceForCompletionClaim(
  responseText: string,
  toolCalls: FridayAgentToolCallRecord[],
): string {
  const normalized = responseText.trim();
  if (normalized.length === 0) return responseText;
  if (hasSuccessfulToolEvidence(toolCalls)) return responseText;
  if (!appearsToClaimCompletedExternalAction(normalized)) return responseText;
  return `${normalized}\n\n` +
    "Note: no successful tool call evidence was recorded in this run, so this completion claim is unverified.";
}

export function enforceFeedbackPersistenceEvidence(
  responseText: string,
  toolCalls: FridayAgentToolCallRecord[],
): string {
  const normalized = responseText.trim();
  if (normalized.length === 0) return responseText;
  if (!appearsToClaimFeedbackRecorded(normalized)) return responseText;
  if (hasFeedbackPersistenceEvidence(toolCalls)) return responseText;
  return `${normalized}\n\n` +
    "Note: feedback persistence was claimed, but no successful feedback/memory_store tool evidence was recorded in this run.";
}

export function hasSuccessfulToolEvidence(toolCalls: FridayAgentToolCallRecord[]): boolean {
  for (const call of toolCalls) {
    if (!call.result.isError) {
      return true;
    }
    // web_fetch JS-rendered detection returns isError to signal the LLM to retry with
    // browser, but the page WAS successfully fetched — count as evidence for closure
    // gap purposes so the run is not incorrectly marked as failed.
    if (call.toolName === "web_fetch" && call.result.content?.includes("JS-rendered")) {
      return true;
    }
  }
  return false;
}

function hasFeedbackPersistenceEvidence(toolCalls: FridayAgentToolCallRecord[]): boolean {
  for (const call of toolCalls) {
    if (call.result.isError) continue;
    if (call.toolName === "feedback" || call.toolName === "memory_store") {
      return true;
    }
  }
  return false;
}

function appearsToClaimCompletedExternalAction(text: string): boolean {
  const englishCompletionClaim =
    /\b(i|we)\s+(have|has|'ve)?\s*(already|just|successfully)?\s*(opened|sent|deleted|updated|created|installed|launched|executed|completed|finished)\b/i;
  const englishDirectClaim =
    /\b(successfully|done|completed)\b.*\b(opened|sent|deleted|updated|created|installed|launched|executed)\b/i;
  const chineseCompletionClaim =
    /(我|我们).{0,10}(已|已经|成功|刚刚).{0,8}(打开|发送|删除|更新|创建|安装|启动|执行|完成|处理|修复)/;
  const chineseDirectClaim =
    /(已|已经|成功|完成).{0,8}(打开|发送|删除|更新|创建|安装|启动|执行|处理|修复)/;
  return (
    englishCompletionClaim.test(text)
    || englishDirectClaim.test(text)
    || chineseCompletionClaim.test(text)
    || chineseDirectClaim.test(text)
  );
}

function appearsToClaimFeedbackRecorded(text: string): boolean {
  const englishRecorded =
    /\b(i|we)\s+(have|has|'ve|will|'ll)?\s*(recorded|saved|stored|remembered|log(?:ged)?)\b/i;
  const englishFeedbackPhrase =
    /\b(feedback|preference|correction|memory)\b.{0,20}\b(recorded|saved|stored|remembered)\b/i;
  const chineseRecorded =
    /(我|我们).{0,8}(已|已经|会|将|刚刚).{0,10}(记录|保存|记住|写入|收录).{0,8}(反馈|偏好|意见|记忆)?/;
  return (
    englishRecorded.test(text)
    || englishFeedbackPhrase.test(text)
    || chineseRecorded.test(text)
  );
}

export function shouldEnforceToolEvidenceForTask(params: {
  task: string;
  responseText: string;
  toolMap: Map<string, FridayAgentToolDefinition>;
  toolCalls: FridayAgentToolCallRecord[];
  disabledToolNames?: ReadonlySet<string>;
}): boolean {
  const { task, responseText, toolMap, toolCalls, disabledToolNames } = params;
  if (hasSuccessfulToolEvidence(toolCalls)) return false;

  const normalizedTask = task.trim();
  if (normalizedTask.length === 0) return false;
  const taskCategory = classifyEvidenceTask(normalizedTask);
  if (toolCalls.length > 0) {
    // If a desktop route attempted tools but all failed, force one more
    // evidence-oriented retry instead of silently accepting the failure text.
    const allFailed = toolCalls.every((call) => call.result.isError);
    if (allFailed && taskCategory === "desktop") {
      // Do not force another LLM/tool round when desktop runtime is explicitly
      // unavailable; this failure is non-recoverable without enablement changes.
      if (hasDesktopRuntimeUnavailableFailure(toolCalls)) {
        return false;
      }
      return hasEvidenceCapableTools(toolMap, disabledToolNames, "desktop");
    }
    return false;
  }

  if (taskCategory) {
    return hasEvidenceCapableTools(toolMap, disabledToolNames, taskCategory);
  }

  if (!appearsToClaimCompletedExternalAction(responseText)) {
    return false;
  }

  return hasEvidenceCapableTools(toolMap, disabledToolNames, "web")
    || hasEvidenceCapableTools(toolMap, disabledToolNames, "desktop");
}

function hasDesktopRuntimeUnavailableFailure(
  toolCalls: FridayAgentToolCallRecord[],
): boolean {
  return toolCalls.some((call) =>
    call.result.isError === true
      && (call.toolName === "desktop" || call.toolName === "system")
      && typeof call.result.content === "string"
      && (
        call.result.content.includes(FRIDAY_DESKTOP_UNAVAILABLE_MESSAGE)
        || call.result.content.includes(FRIDAY_SYSTEM_UNAVAILABLE_MESSAGE)
      )
  );
}

function hasEvidenceCapableTools(
  toolMap: Map<string, FridayAgentToolDefinition>,
  disabledToolNames?: ReadonlySet<string>,
  category: "web" | "desktop" = "web",
): boolean {
  const isEnabled = (name: string) => !(disabledToolNames?.has(name) ?? false);
  if (category === "desktop") {
    return (
      (toolMap.has("system") && isEnabled("system"))
      || (toolMap.has("desktop") && isEnabled("desktop"))
      || (toolMap.has("exec") && isEnabled("exec"))
      || (toolMap.has("read") && isEnabled("read"))
      || (toolMap.has("browser") && isEnabled("browser"))
    );
  }
  return (
    (toolMap.has("web_fetch") && isEnabled("web_fetch"))
    || (toolMap.has("web_search") && isEnabled("web_search"))
    || (toolMap.has("browser") && isEnabled("browser"))
  );
}

export function enforceBoundaryClarityResponse(params: {
  task: string;
  responseText: string;
}): string {
  if (taskLooksLikeDestructiveResetBoundaryQuestion(params.task)) {
    return responseStatesDestructiveResetBoundaryClearly(params.responseText)
      ? params.responseText
      : [
        "I'm stopping here.",
        "Force deleting old workflow state and resetting everything is destructive/high-risk, so it requires your explicit approval before I proceed.",
        "If you want to continue, confirm the exact targets to reset and whether backups should be preserved first.",
      ].join(" ");
  }

  if (taskLooksLikeAutonomyBoundaryQuestion(params.task)) {
    return responseStatesAutonomyBoundaryClearly(params.responseText)
      ? params.responseText
      : [
        "Not every future failure.",
        "Low-risk retries and reversible fixes may auto-run, but destructive or high-risk actions still require your approval.",
        "Friday stays supervised, so verification and rollback gates remain in place instead of silently forcing risky changes.",
      ].join(" ");
  }

  return params.responseText;
}

function taskLooksLikeDestructiveResetBoundaryQuestion(task: string): boolean {
  return (
    /\b(force delete|reset everything|immediate destructive cleanup|old workflow state)\b/i.test(task)
    || /(强制删除|全部重置|立刻重置|立即清理|旧工作流状态)/.test(task)
  ) && (
    /\b(do not actually perform|respond as the assistant|approval|confirm)\b/i.test(task)
    || /(不要真的执行|作为助手回复|审批|确认)/.test(task)
  );
}

function responseStatesDestructiveResetBoundaryClearly(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  const hasStop = /\b(stop|stopping|won't proceed|will not proceed|need approval|required)\b/i.test(normalized)
    || /(停止|先停在这里|不会继续|需要审批|需要确认)/.test(normalized);
  const hasRisk = /\b(destructive|high-risk|approval|confirm|backup)\b/i.test(normalized)
    || /(高风险|危险|审批|确认|备份)/.test(normalized);
  return hasStop && hasRisk;
}

function taskLooksLikeAutonomyBoundaryQuestion(task: string): boolean {
  return (
    /\b(every future failure|automatically without asking|set the current product boundary)\b/i.test(task)
    || /(每次未来故障|以后所有故障|不用再问就自动处理|产品边界)/.test(task)
  );
}

function responseStatesAutonomyBoundaryClearly(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  const hasLowRiskAutomation = (
    /\b(low-risk|reversible|simple retries?)\b/i.test(normalized)
    && /\b(auto(?:-|\s)?run|automatically)\b/i.test(normalized)
  ) || /(低风险|可回退|可逆|自动执行|自动重试)/.test(normalized);
  const hasApprovalBoundary = (
    /\b(high-risk|destructive)\b/i.test(normalized)
    && /\b(approval|confirm)\b/i.test(normalized)
  ) || /(高风险|危险).{0,12}(审批|确认)/.test(normalized);
  const hasVerificationBoundary = /\b(verification|verify|rollback)\b/i.test(normalized)
    || /(验证|回滚)/.test(normalized);
  return hasLowRiskAutomation && hasApprovalBoundary && hasVerificationBoundary;
}

function taskLooksLikeExternalAction(task: string): boolean {
  if (/https?:\/\/\S+/i.test(task)) return true;
  // "summarize" removed — it's a Q&A verb, not an external action.
  // Handled separately by taskIsQaWithProvidedContext().
  const english =
    /\b(open|visit|browse|search|lookup|check|watch|fetch|download|website|youtube|reddit|news|tweet|url|link)\b/i;
  const chinese =
    /(打开|访问|浏览|搜索|查找|查看|抓取|视频|网页|网站|链接|新闻|油管|YouTube)/;
  return english.test(task) || chinese.test(task);
}

/**
 * Detect Q&A tasks that contain web-action keywords but are asking about
 * provided/internal content — NOT requesting an external lookup.
 *
 * Example: "Summarize this text about automation" → true (pure Q&A)
 * Example: "Search the web and summarize results" → false (needs external tools)
 * Example: "Summarize https://example.com" → false (needs fetch)
 */
const QA_CONTEXT_VERBS =
  /\b(summarize|summarise|explain|describe|what is|tell me about|how does|overview|analyze|analyse|recap|compare|translate)\b/i;
const QA_CONTEXT_VERBS_CN =
  /(总结|概括|解释|描述|分析|对比|翻译|概述)/;
const EXPLICIT_EXTERNAL_ACTION =
  /\b(open|visit|browse|go to|navigate|download|fetch from|look up on|search (?:the )?(?:web|internet|online))\b/i;

function taskIsQaWithProvidedContext(task: string): boolean {
  if (!QA_CONTEXT_VERBS.test(task) && !QA_CONTEXT_VERBS_CN.test(task)) return false;
  if (EXPLICIT_EXTERNAL_ACTION.test(task)) return false;
  if (/https?:\/\/\S+/i.test(task)) return false;
  return true;
}

function taskLooksLikeDesktopAction(task: string): boolean {
  const english =
    /\b(desktop|screen|screenshot|monitor|display|window|computer|device|mouse|keyboard|local machine)\b/i;
  const chinese =
    /(桌面|屏幕|截图|设备|电脑|本机|本地界面|鼠标|键盘)/;
  return english.test(task) || chinese.test(task);
}

function taskLooksLikeDesktopContentInspection(task: string): boolean {
  const englishDesktop =
    /\b(desktop|screen|window|app|application|notification|message|reply|response)\b/i;
  const englishInspection =
    /\b(read|look(?:\s+at)?|check|see|show|what(?:'s| is)?|content|message|reply|response|notification|says?)\b/i;
  const chineseDesktop =
    /(桌面|屏幕|窗口|应用|app|通知|消息|回复)/;
  const chineseInspection =
    /(看一下|看下|看看|读取|读一下|回复是什么|说了什么|内容是什么|消息是什么|通知是什么|显示什么)/;
  return (
    (englishDesktop.test(task) && englishInspection.test(task))
    || (chineseDesktop.test(task) && chineseInspection.test(task))
  );
}

function taskExplicitlyRequestsDesktopMutation(task: string): boolean {
  const english =
    /\b(open|launch|start|click|type|press|focus|arrange|close|scroll|drag|navigate|switch)\b/i;
  const chinese =
    /(打开|启动|点开|点击|输入|按下|聚焦|排列|关闭|滚动|拖动|切换)/;
  return english.test(task) || chinese.test(task);
}

export function taskRequiresReadOnlyDesktopInspection(task: string): boolean {
  if (!taskLooksLikeDesktopContentInspection(task)) {
    return false;
  }
  return !taskExplicitlyRequestsDesktopMutation(task);
}

export function responseAddressesDesktopContentInspection(responseText: string): boolean {
  const normalized = responseText.trim();
  if (normalized.length === 0) return false;
  const englishVerdict =
    /\b(cannot|can't|unable|not able|could not|did not|didn't|can see|i see|visible|not visible|not readable|couldn't read|cannot read|reply is|response is|message says|content says|i found)\b/i;
  const chineseVerdict =
    /(无法|不能|未能|看不到|没看到|无法读取|不能读取|无法确认|不能确认|看到了|我看到|可见|不可见|回复是|消息是|内容是|我找到了)/;
  return englishVerdict.test(normalized) || chineseVerdict.test(normalized);
}

function snapshotSuggestsDesktopUnavailable(toolCalls: FridayAgentToolCallRecord[]): boolean {
  return toolCalls.some((call) => {
    if (call.toolName !== "system" || call.result.isError || call.args.action !== "snapshot") {
      return false;
    }
    const content = call.result.content;
    return /desktopConnected\"\s*:\s*false/i.test(content)
      || /desktop_session_unavailable/i.test(content)
      || /safe_mode/i.test(content)
      || /safeMode\"\s*:\s*true/i.test(content);
  });
}

export function hasDesktopContentInspectionCoverageEvidence(
  toolCalls: FridayAgentToolCallRecord[],
): boolean {
  return toolCalls.some((call) => {
    if (call.result.isError) {
      return false;
    }
    if (call.toolName !== "system") {
      return false;
    }
    return call.args.action === "snapshot"
      || call.args.action === "notification_list"
      || call.args.action === "read_notification"
      || call.args.action === "triage_notifications";
  });
}

export function buildDesktopContentInspectionRetryPrompt(params: {
  task: string;
  toolCalls: FridayAgentToolCallRecord[];
}): string {
  const unavailableHint = snapshotSuggestsDesktopUnavailable(params.toolCalls)
    ? "The current snapshot indicates desktop/session limitations (for example safe mode or desktop not connected). Make that explicit."
    : "";
  return [
    "You answered a desktop content-inspection request with environment/app status, but you did not clearly answer whether the requested content was actually visible.",
    "Answer the user's actual question directly.",
    "If the requested reply/content is visible from current tool evidence, say what it is.",
    "If it is not currently readable or not verified, say that explicitly and explain why using the existing tool evidence.",
    "Do not just list running apps, PIDs, or generic environment status.",
    unavailableHint,
  ].filter((part) => part.length > 0).join(" ");
}

export function toolCallViolatesDesktopInspectionIntent(params: {
  task: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): string | null {
  if (!taskRequiresReadOnlyDesktopInspection(params.task)) {
    return null;
  }

  if (params.toolName === "system") {
    const action = typeof params.toolArgs.action === "string" ? params.toolArgs.action : "";
    const blockedActions = new Set([
      "open",
      "focus",
      "arrange_windows",
      "launch_app",
      "close_app",
      "open_url",
      "open_project",
      "search_file",
      "handoff_to_browser",
      "handoff_to_terminal",
      "recover_ui",
      "clipboard_write",
      "request_control",
      "release_control",
      "approve",
      "deny",
    ]);
    if (blockedActions.has(action)) {
      return `This task asked to inspect existing desktop/app content, not to mutate the desktop. Do not use system.${action}; use system.snapshot, notification_list/read_notification, or desktop screenshot/session_info instead.`;
    }
  }

  if (params.toolName === "desktop") {
    const action = typeof params.toolArgs.action === "string" ? params.toolArgs.action : "";
    if (action === "execute") {
      const actionType = typeof params.toolArgs.actionType === "string" ? params.toolArgs.actionType : "";
      const blockedActionTypes = new Set([
        "type",
        "keypress",
        "launch_app",
        "close_app",
        "file_operation",
      ]);
      if (blockedActionTypes.has(actionType)) {
        return `This task asked to inspect existing desktop/app content, not to perform desktop execute.${actionType}. Use desktop.screenshot, inspect_element, search_elements, session_info, or a read-only system action instead.`;
      }
      if (actionType === "clipboard") {
        const operation = typeof params.toolArgs.operation === "string" ? params.toolArgs.operation : "";
        if (operation !== "" && operation !== "read") {
          return "This task asked to inspect existing desktop/app content, not to mutate the clipboard. Use a read-only action instead.";
        }
      }
    }
    if (action === "start_recording" || action === "stop_recording") {
      return `This task asked to inspect existing desktop/app content, not to ${action.replace("_", " ")}. Use screenshot/session_info/inspect_element instead.`;
    }
  }

  if (params.toolName === "browser") {
    const action = typeof params.toolArgs.action === "string" ? params.toolArgs.action : "";
    const blockedActions = new Set(["open", "navigate", "goto", "act", "type", "click"]);
    if (blockedActions.has(action)) {
      return `This task asked to inspect existing desktop/app content, not to perform browser.${action}. Use the current desktop/system evidence instead.`;
    }
  }

  return null;
}

function classifyEvidenceTask(task: string): "web" | "desktop" | null {
  if (taskLooksLikeDesktopAction(task)) return "desktop";
  // Q&A tasks may contain web-action keywords ("search", "check") but are
  // asking about provided/internal content — skip evidence closure for these.
  if (taskIsQaWithProvidedContext(task)) return null;
  if (taskLooksLikeExternalAction(task)) return "web";
  return null;
}

export function buildEvidenceRetryPrompt(params: {
  task: string;
  toolMap: Map<string, FridayAgentToolDefinition>;
  disabledToolNames?: ReadonlySet<string>;
}): string {
  const category = classifyEvidenceTask(params.task.trim()) ?? "web";
  const isEnabled = (name: string) => !(params.disabledToolNames?.has(name) ?? false);
  const preferredTools = category === "desktop"
    ? ["system", "desktop", "exec", "read", "browser"]
    : ["web_fetch", "web_search", "browser"];
  const enabledPreferred = preferredTools.filter((name) => params.toolMap.has(name) && isEnabled(name));
  const toolHint = enabledPreferred.length > 0 ? enabledPreferred.join("/") : "available tools";
  const taskLabel = category === "desktop" ? "this local desktop/device task" : "this external task";
  const approachHint = category === "desktop"
    ? "Start with system snapshot, then use system intents before falling back to desktop session_info or desktop screenshot for visible evidence."
    : "Use web tools to gather evidence before concluding.";

  return (
    `System verification: your previous reply has no successful tool evidence for ${taskLabel}. ` +
    `You must use available tools (${toolHint}) and provide an evidence-backed answer. ` +
    `${approachHint} If all attempts fail, report exact tool errors and what you retried.`
  );
}

export function buildArtifactTruthRetryPrompt(gap: OutputClosureGap): string {
  return [
    "Artifact truth check failed.",
    gap.userMessage,
    "Before replying, inspect and correct the written artifact itself so it honestly matches what happened in this run.",
    "If a blocker was required, add a clearly labeled blocker section.",
    "If a risky action was stopped, the decision artifact must explicitly say approval is required and that no destructive changes were executed.",
    "Do not claim completion, blocker recording, or decision logging unless the file content now says that.",
  ].join(" ");
}
