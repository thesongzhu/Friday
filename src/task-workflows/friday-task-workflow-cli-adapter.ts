/**
 * Phase 13.5C task workflow CLI backend adapter.
 *
 * Normalizes Friday's existing CLI text completion primitive
 * (runFridayCliBackendTextCompletion) into a draft / unverified handoff
 * with a machine-readable capability label that explicitly states:
 *
 *  - CLI output is never native-tool proof.
 *  - CLI summaries remain `draft_unverified` until a Friday native or
 *    provider verifier lane fresh-reads the referenced evidence.
 *  - CLI lanes can never directly promote a claim to `verified`; that
 *    refusal lives in `friday-task-workflow-service.ts`.
 *  - ContextPackage scope binding is required; whole-repo context is
 *    refused via the existing context-package validator.
 *
 * The adapter applies one bounded malformed-output repair attempt, a
 * bounded adapter-level timeout, and fail-closed handoff conversion for
 * CLI unavailability / auth missing. It NEVER throws on CLI failure —
 * the caller always receives a handoff object whose `status` describes
 * the terminal state.
 *
 * The adapter intentionally does NOT depend on the local Codex/Claude
 * conveyor bridge, Stop-hook relay, or SDK app-server implementation
 * details. The only Friday primitive it consumes is the CLI text
 * completion call.
 *
 * @module task-workflows/friday-task-workflow-cli-adapter
 */

import { FridayDomainError } from "#errors";

import { validateFridayTaskWorkflowContextPackage } from "./friday-task-workflow-context-package.js";
import type {
  FridayTaskWorkflowCliBackendId,
  FridayTaskWorkflowCliCapabilityLabel,
  FridayTaskWorkflowCliHandoff,
  FridayTaskWorkflowCliHandoffStatus,
  FridayTaskWorkflowCliInvokeInput,
} from "./friday-task-workflow.types.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MIN_SUMMARY_CHARS = 8;
const MAX_REPAIR_ATTEMPTS = 1;

const CAPABILITY_DISCLOSURE =
  "CLI backend output is bounded text only; it is never native-tool proof and never promotes claims to verified. Friday verifier (native or provider) must fresh-read referenced evidence before a claim can become verified.";

const CAPABILITY_REQUIRED_GATE_IDS = [
  "cli_self_report_unconfirmed",
  "claim_evidence_required",
  "verifier_fresh_read",
  "context_package_scope_limit",
] as const;

const REPAIR_PREFACE =
  "Your previous response was empty or unusable. Please respond with a single concise paragraph (at least one sentence) summarizing the requested task review using only the provided context.";

/**
 * Injected CLI text completion. The adapter accepts the function as a
 * dep so tests can deterministically drive timeout / malformed /
 * unavailable / auth-missing paths without spawning real CLI processes.
 *
 * The injected function may reject with a `FridayDomainError`. The
 * adapter maps:
 *   - `PROVIDER_UNREACHABLE`     → status="unavailable"
 *   - `LLM_ERROR` + auth hint    → status="auth_missing"
 *   - timeout (adapter-side)     → status="timeout"
 *   - empty / below-threshold    → one bounded repair, then "repair_failed"
 *   - successful, usable output  → status="handoff_ready"
 */
export type FridayTaskWorkflowCliTextCompletion = (input: {
  backendId: FridayTaskWorkflowCliBackendId;
  systemPrompt: string;
  conversation: string;
  model?: string;
}) => Promise<string>;

export interface CreateFridayTaskWorkflowCliAdapterDeps {
  readonly cliTextCompletion: FridayTaskWorkflowCliTextCompletion;
  readonly nowIso: () => string;
  /** Optional clock used to compute elapsed time; defaults to performance.now()-style monotonic via Date.now. */
  readonly elapsedMs?: () => number;
}

export interface FridayTaskWorkflowCliAdapter {
  produceHandoff(
    input: FridayTaskWorkflowCliInvokeInput,
  ): Promise<FridayTaskWorkflowCliHandoff>;
  capabilityLabelFor(
    input: Pick<FridayTaskWorkflowCliInvokeInput, "boundaryRefs">,
  ): FridayTaskWorkflowCliCapabilityLabel;
}

/** Compute the canonical Phase 13.5C CLI capability label. */
export function buildFridayTaskWorkflowCliCapabilityLabel(
  boundaryRefs: readonly string[],
): FridayTaskWorkflowCliCapabilityLabel {
  return {
    nativeToolProof: false,
    summaryStatus: "draft_unverified",
    verifierPromotionAllowed: false,
    evidenceRefFreshReadRequired: true,
    contextPackageBound: true,
    laneRole: "cli",
    boundaryRefs: [...boundaryRefs],
    requiredGateIds: [...CAPABILITY_REQUIRED_GATE_IDS],
    disclosure: CAPABILITY_DISCLOSURE,
  };
}

export function createFridayTaskWorkflowCliAdapter(
  deps: CreateFridayTaskWorkflowCliAdapterDeps,
): FridayTaskWorkflowCliAdapter {
  const clock = deps.elapsedMs ?? (() => Date.now());

  function capabilityLabelFor(
    input: Pick<FridayTaskWorkflowCliInvokeInput, "boundaryRefs">,
  ): FridayTaskWorkflowCliCapabilityLabel {
    return buildFridayTaskWorkflowCliCapabilityLabel(input.boundaryRefs);
  }

  async function produceHandoff(
    input: FridayTaskWorkflowCliInvokeInput,
  ): Promise<FridayTaskWorkflowCliHandoff> {
    validateBackend(input.backendId);
    const safeContext = validateFridayTaskWorkflowContextPackage(input.contextPackage);
    const capabilityLabel = capabilityLabelFor({ boundaryRefs: input.boundaryRefs });
    const timeoutMs = clampPositive(input.timeoutMs, DEFAULT_TIMEOUT_MS);
    const minSummaryChars = clampPositive(
      input.minSummaryChars,
      DEFAULT_MIN_SUMMARY_CHARS,
    );

    const start = clock();

    const promptConversation = buildScopedConversation({
      conversation: input.conversation,
      contextPackage: safeContext,
      boundaryRefs: input.boundaryRefs,
    });

    let repairAttempts = 0;
    let lastSummary = "";

    const initialAttempt = await runBoundedCliAttempt({
      backendId: input.backendId,
      systemPrompt: input.systemPrompt,
      conversation: promptConversation,
      model: input.model,
      timeoutMs,
      runCli: deps.cliTextCompletion,
    });

    if (initialAttempt.terminal !== null) {
      return buildHandoff({
        backendId: input.backendId,
        status: initialAttempt.terminal,
        summaryDraft: initialAttempt.summary ?? "",
        capabilityLabel,
        repairAttempts,
        elapsedMs: clock() - start,
        failureReason: initialAttempt.failureReason,
        producedAt: deps.nowIso(),
      });
    }

    lastSummary = initialAttempt.summary ?? "";
    if (isSummaryUsable(lastSummary, minSummaryChars)) {
      return buildHandoff({
        backendId: input.backendId,
        status: "handoff_ready",
        summaryDraft: lastSummary.trim(),
        capabilityLabel,
        repairAttempts,
        elapsedMs: clock() - start,
        failureReason: null,
        producedAt: deps.nowIso(),
      });
    }

    repairAttempts += 1;
    if (repairAttempts > MAX_REPAIR_ATTEMPTS) {
      return buildHandoff({
        backendId: input.backendId,
        status: "repair_failed",
        summaryDraft: lastSummary,
        capabilityLabel,
        repairAttempts: repairAttempts - 1,
        elapsedMs: clock() - start,
        failureReason: "CLI output was empty or below the minimum length and repair budget is exhausted.",
        producedAt: deps.nowIso(),
      });
    }

    const repairAttempt = await runBoundedCliAttempt({
      backendId: input.backendId,
      systemPrompt: input.systemPrompt,
      conversation: `${REPAIR_PREFACE}\n\n${promptConversation}`,
      model: input.model,
      timeoutMs,
      runCli: deps.cliTextCompletion,
    });

    if (repairAttempt.terminal !== null) {
      return buildHandoff({
        backendId: input.backendId,
        status: repairAttempt.terminal,
        summaryDraft: repairAttempt.summary ?? lastSummary,
        capabilityLabel,
        repairAttempts,
        elapsedMs: clock() - start,
        failureReason: repairAttempt.failureReason,
        producedAt: deps.nowIso(),
      });
    }

    lastSummary = repairAttempt.summary ?? lastSummary;
    if (isSummaryUsable(lastSummary, minSummaryChars)) {
      return buildHandoff({
        backendId: input.backendId,
        status: "handoff_ready",
        summaryDraft: lastSummary.trim(),
        capabilityLabel,
        repairAttempts,
        elapsedMs: clock() - start,
        failureReason: null,
        producedAt: deps.nowIso(),
      });
    }

    return buildHandoff({
      backendId: input.backendId,
      status: "repair_failed",
      summaryDraft: lastSummary,
      capabilityLabel,
      repairAttempts,
      elapsedMs: clock() - start,
      failureReason:
        "CLI repair attempt also returned an empty or below-threshold summary; stopping with a handoff.",
      producedAt: deps.nowIso(),
    });
  }

  return {
    produceHandoff,
    capabilityLabelFor,
  };
}

interface BoundedCliAttemptResult {
  /** Non-null terminal status that should be returned to the caller. */
  readonly terminal: Exclude<FridayTaskWorkflowCliHandoffStatus, "handoff_ready" | "repair_failed"> | null;
  readonly summary: string | null;
  readonly failureReason: string | null;
}

async function runBoundedCliAttempt(input: {
  backendId: FridayTaskWorkflowCliBackendId;
  systemPrompt: string;
  conversation: string;
  model?: string;
  timeoutMs: number;
  runCli: FridayTaskWorkflowCliTextCompletion;
}): Promise<BoundedCliAttemptResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<BoundedCliAttemptResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        terminal: "timeout",
        summary: null,
        failureReason: `CLI adapter timed out after ${input.timeoutMs}ms.`,
      });
    }, input.timeoutMs);
  });
  const cliPromise = input
    .runCli({
      backendId: input.backendId,
      systemPrompt: input.systemPrompt,
      conversation: input.conversation,
      model: input.model,
    })
    .then(
      (text): BoundedCliAttemptResult => ({
        terminal: null,
        summary: typeof text === "string" ? text : "",
        failureReason: null,
      }),
      (error): BoundedCliAttemptResult => mapCliError(error),
    );
  try {
    const result = await Promise.race([cliPromise, timeoutPromise]);
    return result;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function mapCliError(error: unknown): BoundedCliAttemptResult {
  if (error instanceof FridayDomainError) {
    if (error.code === "PROVIDER_UNREACHABLE") {
      return {
        terminal: "unavailable",
        summary: null,
        failureReason: `CLI backend is unavailable: ${error.message}`,
      };
    }
    if (error.code === "LLM_ERROR") {
      if (isAuthMissingMessage(error.message)) {
        return {
          terminal: "auth_missing",
          summary: null,
          failureReason: `CLI backend authentication required: ${error.message}`,
        };
      }
      return {
        terminal: "unavailable",
        summary: null,
        failureReason: `CLI backend returned an error: ${error.message}`,
      };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    terminal: "unavailable",
    summary: null,
    failureReason: `CLI backend failed: ${message}`,
  };
}

function isAuthMissingMessage(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("auth") &&
    (lowered.includes("missing") ||
      lowered.includes("required") ||
      lowered.includes("not logged in") ||
      lowered.includes("login required") ||
      lowered.includes("unauthorized"))
  );
}

function buildScopedConversation(input: {
  conversation: string;
  contextPackage: FridayTaskWorkflowCliInvokeInput["contextPackage"];
  boundaryRefs: readonly string[];
}): string {
  const allowedFilesLine =
    input.contextPackage.allowedFiles.length === 0
      ? "<none>"
      : input.contextPackage.allowedFiles.join(", ");
  const allowedToolsLine =
    input.contextPackage.allowedTools.length === 0
      ? "<none>"
      : input.contextPackage.allowedTools.join(", ");
  const allowedApisLine =
    input.contextPackage.allowedApis.length === 0
      ? "<none>"
      : input.contextPackage.allowedApis.join(", ");
  const boundaryRefsLine =
    input.boundaryRefs.length === 0 ? "<none>" : input.boundaryRefs.join(", ");
  return [
    "Friday CLI bounded text task (Phase 13.5C):",
    "- Your output is a DRAFT and is NOT verified evidence.",
    "- Do NOT reference files outside the allowed scope.",
    "- Do NOT claim native tool execution; CLI output cannot satisfy a verified claim.",
    `- Allowed files: ${allowedFilesLine}`,
    `- Allowed tools: ${allowedToolsLine}`,
    `- Allowed APIs: ${allowedApisLine}`,
    `- Boundary refs: ${boundaryRefsLine}`,
    "",
    input.conversation.trim(),
  ].join("\n");
}

function buildHandoff(input: {
  backendId: FridayTaskWorkflowCliBackendId;
  status: FridayTaskWorkflowCliHandoffStatus;
  summaryDraft: string;
  capabilityLabel: FridayTaskWorkflowCliCapabilityLabel;
  repairAttempts: number;
  elapsedMs: number;
  failureReason: string | null;
  producedAt: string;
}): FridayTaskWorkflowCliHandoff {
  return {
    status: input.status,
    backendId: input.backendId,
    summaryDraft: input.summaryDraft,
    verified: false,
    capabilityLabel: input.capabilityLabel,
    repairAttempts: input.repairAttempts,
    elapsedMs: input.elapsedMs,
    failureReason: input.failureReason,
    producedAt: input.producedAt,
  };
}

function isSummaryUsable(text: string, minSummaryChars: number): boolean {
  if (typeof text !== "string") return false;
  return text.trim().length >= minSummaryChars;
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function validateBackend(backendId: unknown): asserts backendId is FridayTaskWorkflowCliBackendId {
  if (backendId !== "codex-cli" && backendId !== "claude-cli") {
    throw new FridayDomainError(
      "TASK_WORKFLOW_INVALID",
      "backendId must be one of 'codex-cli', 'claude-cli'.",
      { httpStatus: 400 },
    );
  }
}
