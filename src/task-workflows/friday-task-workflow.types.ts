/**
 * Phase 13.5A core task workflow policy types.
 *
 * These types describe the thin product surface that productizes the
 * task workflow policy over existing Friday primitives (agent run events,
 * workflow evidence, provider route traces, context replay, self-heal,
 * channels). They intentionally do not duplicate raw evidence — only
 * refs and verdicts are persisted by this module.
 *
 * @module task-workflows/friday-task-workflow.types
 */

export type FridayTaskWorkflowSupervisorMode = "off" | "light" | "standard" | "strict";

export type FridayTaskWorkflowRisk = "low" | "medium" | "high";

export type FridayTaskWorkflowStage =
  | "intake"
  | "charter"
  | "plan"
  | "execute"
  | "verify"
  | "review"
  | "closeout"
  | "revised";

export type FridayTaskWorkflowClaimStatus = "draft" | "unverified" | "verified" | "blocked";

/**
 * Claim kinds tag the *source* of a claim. Only "evidence-bearing" kinds
 * (runtime/code/api/artifact) are allowed to reach the `verified` status.
 * Docs/spec intent, summary/context replay, CLI self-report, and provider
 * fallback are explicitly non-verifiable per Phase 13.5 module CSVs.
 */
export type FridayTaskWorkflowClaimKind =
  | "docs_intent"
  | "summary_replay"
  | "cli_self_report"
  | "provider_fallback"
  | "runtime_evidence"
  | "code_evidence"
  | "api_evidence"
  | "artifact_evidence";

/** Surfaces a Friday evidence ref originates from. The task workflow module
 *  references these by id/hash and never copies raw payloads. */
export type FridayTaskWorkflowEvidenceSource =
  | "agent_run_event"
  | "workflow_run_evidence"
  | "provider_route_trace"
  | "context_replay"
  | "self_heal_event"
  | "channel_event"
  | "session_event"
  | "observability_audit"
  | "manual_external"
  | "docs_intent_reference";

/** Read-only built-in boundary contract entry. */
export interface FridayTaskWorkflowBoundaryContract {
  readonly boundaryId: string;
  readonly label: string;
  readonly description: string;
  readonly allowedOperations: readonly string[];
  readonly hardBoundaries: readonly string[];
  readonly evidenceRefSources: readonly FridayTaskWorkflowEvidenceSource[];
  readonly requiredGateIds: readonly string[];
}

/** Built-in deterministic gate entry. */
export interface FridayTaskWorkflowGate {
  readonly gateId: string;
  readonly label: string;
  readonly description: string;
  /** Cannot be disabled by any supervisor mode or user config when true. */
  readonly required: boolean;
  /** Risk levels this gate is mandatory for; ignored when `required` is true. */
  readonly mandatoryForRisk: readonly FridayTaskWorkflowRisk[];
}

/** Per-workflow context package. Whole-repo source is explicitly refused. */
export interface FridayTaskWorkflowContextPackage {
  /** Project-relative paths or glob fragments. Must NOT include the
   *  whole-repo sentinel `**` (or equivalents). */
  readonly allowedFiles: readonly string[];
  /** Optional allowed tool IDs / API surfaces. Empty arrays mean "deny all". */
  readonly allowedTools: readonly string[];
  readonly allowedApis: readonly string[];
  /** Boundary contract IDs this context is scoped to. */
  readonly boundaryIds: readonly string[];
}

/** Required + additive gate plan persisted per workflow. */
export interface FridayTaskWorkflowGatePlanEntry {
  readonly gateId: string;
  readonly required: boolean;
  /** True if the user/supervisor mode added this gate on top of required gates. */
  readonly additiveUser: boolean;
}

export interface FridayTaskWorkflowRecord {
  readonly id: string;
  readonly charter: string;
  readonly specHash: string;
  readonly parentSpecHash: string | null;
  readonly taskKind: string;
  readonly risk: FridayTaskWorkflowRisk;
  readonly supervisorMode: FridayTaskWorkflowSupervisorMode;
  readonly budget: number;
  readonly stage: FridayTaskWorkflowStage;
  readonly contextPackage: FridayTaskWorkflowContextPackage;
  readonly gatePlan: readonly FridayTaskWorkflowGatePlanEntry[];
  readonly boundaryRefs: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FridayTaskWorkflowRevisionRecord {
  readonly id: string;
  readonly workflowId: string;
  readonly specHash: string;
  readonly parentSpecHash: string | null;
  readonly charter: string;
  readonly reason: string;
  readonly createdAt: string;
}

export interface FridayTaskWorkflowClaimRecord {
  readonly id: string;
  readonly workflowId: string;
  readonly specHash: string;
  readonly claimText: string;
  readonly claimKind: FridayTaskWorkflowClaimKind;
  readonly status: FridayTaskWorkflowClaimStatus;
  readonly reason: string | null;
  readonly verifierVerdict: string | null;
  /**
   * Verifier lane that produced the verdict (Phase 13.5B). Null when the
   * claim was verified through the backward-compatible single-lane path
   * (allowed only for low/medium-risk workflows) or never verified.
   */
  readonly verifierLaneId: string | null;
  readonly evidenceRefCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FridayTaskWorkflowEvidenceRefRecord {
  readonly id: string;
  readonly workflowId: string;
  readonly claimId: string;
  readonly refKind: string;
  readonly refId: string;
  readonly refHash: string | null;
  readonly refSource: FridayTaskWorkflowEvidenceSource;
  readonly createdAt: string;
}

export interface FridayTaskWorkflowSupervisorCursorRecord {
  readonly workflowId: string;
  readonly currentStage: FridayTaskWorkflowStage;
  readonly blockers: readonly string[];
  readonly lastEventRef: string | null;
  readonly updatedAt: string;
}

/**
 * Per-gate outcome emitted inside the closeout receipt (B.2.2).
 *
 * Required gates must always evaluate to `pass` or `block`. Optional gates
 * may evaluate to `not_applicable` when the gate is not in the workflow's
 * gate plan or when the gate's evaluation predicate has no applicable data.
 */
export interface FridayTaskWorkflowCloseoutGateOutcome {
  readonly gateId: string;
  readonly required: boolean;
  readonly status: "pass" | "block" | "not_applicable";
  readonly reason: string | null;
}

export interface FridayTaskWorkflowCloseoutReceipt {
  readonly id: string;
  readonly workflowId: string;
  readonly specHash: string;
  readonly status: "complete" | "partial" | "blocked";
  readonly claimSummary: Readonly<{
    draft: number;
    unverified: number;
    verified: number;
    blocked: number;
  }>;
  readonly blockers: readonly string[];
  readonly gateOutcomes: readonly FridayTaskWorkflowCloseoutGateOutcome[];
  readonly createdAt: string;
}

/** Input for creating or previewing a workflow. */
export interface FridayTaskWorkflowCreateInput {
  readonly charter: string;
  readonly taskKind: string;
  readonly risk?: FridayTaskWorkflowRisk;
  readonly supervisorMode?: FridayTaskWorkflowSupervisorMode;
  readonly contextPackage: FridayTaskWorkflowContextPackage;
  /** User-added optional gates layered on top of required gates. */
  readonly additionalGateIds?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Preview result. Never persisted. */
export interface FridayTaskWorkflowPreview {
  readonly specHash: string;
  readonly risk: FridayTaskWorkflowRisk;
  readonly supervisorMode: FridayTaskWorkflowSupervisorMode;
  readonly budget: number;
  readonly contextPackage: FridayTaskWorkflowContextPackage;
  readonly gatePlan: readonly FridayTaskWorkflowGatePlanEntry[];
  readonly boundaryRefs: readonly string[];
}

export interface FridayTaskWorkflowReviseInput {
  readonly charter: string;
  readonly reason: string;
  readonly supervisorMode?: FridayTaskWorkflowSupervisorMode;
  readonly contextPackage?: FridayTaskWorkflowContextPackage;
  readonly additionalGateIds?: readonly string[];
}

export interface FridayTaskWorkflowDraftClaimInput {
  readonly claimText: string;
  readonly claimKind: FridayTaskWorkflowClaimKind;
}

export interface FridayTaskWorkflowAttachEvidenceRefInput {
  readonly refKind: string;
  readonly refId: string;
  readonly refSource: FridayTaskWorkflowEvidenceSource;
  readonly refHash?: string;
}

export interface FridayTaskWorkflowVerifyClaimInput {
  /** Verdict text written by an independent verifier after fresh-reading
   *  evidence refs. Cannot satisfy verified for non-evidence-bearing kinds. */
  readonly verifierVerdict: string;
  /**
   * Phase 13.5B: verifier lane that produced this verdict via Friday's
   * fresh-read path. REQUIRED for `high` risk workflows; optional for
   * `low`/`medium` risk (omit to allow single-lane self-verification).
   * Refused when the lane does not belong to this workflow, is not a
   * verifier lane, or is closed/blocked.
   */
  readonly verifierLaneId?: string;
}

export interface FridayTaskWorkflowBlockClaimInput {
  readonly reason: string;
}

/* ──────────────────────────────────────────────────────────────────────
 * Phase 13.5B: Executor / Verifier Lanes
 * ──────────────────────────────────────────────────────────────────────
 *
 * Lane records track who executed task work (executor lanes) and who
 * verified the resulting claims (verifier lanes). Each lane carries a
 * deterministic context snapshot hash bound to the workflow's spec hash
 * at lane open so closeout can block honestly when the lane context is
 * missing or out of sync. Provider fallback availability is recorded as
 * a label only — fallback success never substitutes for a verifier
 * verdict.
 */

export type FridayTaskWorkflowLaneKind = "executor" | "verifier";

/**
 * Lane role identifies the execution surface. `native` lanes are Friday
 * agent-runtime executions; `provider` lanes are direct provider-routed
 * runs. `cli` lanes are Phase 13.5C bounded text executor / reviewer
 * lanes — CLI self-report can never satisfy a verified claim, so service
 * verifier-promotion paths refuse `cli` verifier lanes for all risk
 * levels with a clear fail-closed error.
 */
export type FridayTaskWorkflowLaneRole = "native" | "provider" | "cli";

export type FridayTaskWorkflowLaneStatus =
  | "open"
  | "in_progress"
  | "completed"
  | "blocked";

/**
 * Honest independence label between a verifier lane and the executor
 * lane it audits.
 *  - `independent`: distinct lane role/provider from the executor lane.
 *  - `degraded_same_provider`: verifier shares provider with executor
 *    (e.g. same provider id); cannot satisfy the high-risk independence
 *    requirement.
 *  - `degraded_unavailable`: no separate verifier surface was available;
 *    recorded honestly so closeout can block, not silently pass.
 *  - `not_applicable`: used for executor lanes (no audit relationship).
 */
export type FridayTaskWorkflowLaneIndependence =
  | "independent"
  | "degraded_unavailable"
  | "degraded_same_provider"
  | "not_applicable";

/**
 * Fallback availability label recorded on executor lanes. Records whether
 * the provider service had to fall back to an alternate route; this is
 * availability information only and never counts as verifier proof.
 */
export type FridayTaskWorkflowFallbackAvailability =
  | "not_used"
  | "used_same_provider"
  | "used_alternate_provider";

export interface FridayTaskWorkflowLaneRecord {
  readonly id: string;
  readonly workflowId: string;
  readonly laneKind: FridayTaskWorkflowLaneKind;
  readonly laneRole: FridayTaskWorkflowLaneRole;
  /** Parent executor lane id for verifier lanes; null for executor lanes. */
  readonly parentLaneId: string | null;
  readonly status: FridayTaskWorkflowLaneStatus;
  readonly independence: FridayTaskWorkflowLaneIndependence;
  /** FridayAgentRuntimeResult.runId reference; not a payload copy. */
  readonly executorRunRef: string | null;
  readonly providerId: string | null;
  /** Provider route trace id reference; not a payload copy. */
  readonly routeTraceRef: string | null;
  /** SHA-256 over the lane's frozen context package + boundary refs. */
  readonly contextSnapshotHash: string;
  /** Workflow spec_hash captured at lane open for cross-check at closeout. */
  readonly contextSnapshotSpecHash: string;
  readonly fallbackAvailability: FridayTaskWorkflowFallbackAvailability | null;
  readonly blocker: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FridayTaskWorkflowOpenExecutorLaneInput {
  readonly laneRole: FridayTaskWorkflowLaneRole;
  readonly providerId?: string;
}

export interface FridayTaskWorkflowOpenVerifierLaneInput {
  readonly parentLaneId: string;
  readonly laneRole: FridayTaskWorkflowLaneRole;
  readonly providerId?: string;
  /**
   * Honest independence claim from the caller. The service downgrades
   * to `degraded_same_provider` when the verifier shares lane role +
   * provider with the executor lane it audits, and refuses high-risk
   * workflows when the resulting independence is not `independent`.
   */
  readonly independenceClaim: FridayTaskWorkflowLaneIndependence;
}

export interface FridayTaskWorkflowCompleteLaneInput {
  readonly status: "completed" | "blocked";
  readonly executorRunRef?: string | null;
  readonly routeTraceRef?: string | null;
  readonly fallbackAvailability?: FridayTaskWorkflowFallbackAvailability;
  readonly blocker?: string | null;
}

export interface FridayTaskWorkflowSubmitVerifierVerdictInput {
  readonly claimId: string;
  readonly verifierVerdict: string;
}

/* ──────────────────────────────────────────────────────────────────────
 * Phase 13.5C: CLI Backend Adapter
 * ──────────────────────────────────────────────────────────────────────
 *
 * CLI lanes are bounded text executor / reviewer surfaces. The adapter
 * normalizes CLI output into a draft / unverified handoff and never
 * promotes a claim to `verified` on its own. Friday verifier lanes
 * (native or provider) must fresh-read the referenced evidence before
 * a claim becomes verified. High-risk verifier independence remains
 * non-CLI per Phase 13.5B.
 */

/** Backend identifier the adapter speaks to. Matches provider CLI IDs. */
export type FridayTaskWorkflowCliBackendId = "codex-cli" | "claude-cli";

/** Normalized terminal state of a single CLI invocation. */
export type FridayTaskWorkflowCliHandoffStatus =
  | "handoff_ready"
  | "repair_failed"
  | "timeout"
  | "unavailable"
  | "auth_missing";

/**
 * Machine-readable capability label emitted with every CLI handoff. The
 * label is the contract Phase 13.5C exposes to consumers: CLI is bounded
 * text only, never native-tool proof, summary remains unverified until a
 * Friday verifier fresh-reads referenced evidence, and the CLI lane can
 * never directly promote a claim to `verified`.
 */
export interface FridayTaskWorkflowCliCapabilityLabel {
  /** CLI is never native-tool proof. Always `false`. */
  readonly nativeToolProof: false;
  /** CLI summary is always draft / unverified until Friday verifier fresh-read. */
  readonly summaryStatus: "draft_unverified";
  /** CLI lanes can never directly promote a claim to verified. Always `false`. */
  readonly verifierPromotionAllowed: false;
  /** Verified claims require non-CLI evidence refs after fresh-read. Always `true`. */
  readonly evidenceRefFreshReadRequired: true;
  /** ContextPackage scope binding is mandatory. Always `true`. */
  readonly contextPackageBound: true;
  /** Lane role this label is bound to. Always `"cli"` for adapter output. */
  readonly laneRole: "cli";
  /** Boundary contract refs scoped to the CLI handoff. */
  readonly boundaryRefs: readonly string[];
  /** Required gate IDs that must still pass to close out a workflow that referenced CLI output. */
  readonly requiredGateIds: readonly string[];
  /** Stable human-readable wording for surfaces that show the label. */
  readonly disclosure: string;
}

/**
 * Normalized result of a single CLI adapter invocation. The handoff is
 * persistence-shaped (no service-managed claims/refs are mutated by the
 * adapter itself); callers store or render it as needed and may draft a
 * `cli_self_report` claim with `unverified` status against it. The
 * adapter never throws on CLI failure; it returns a handoff with a
 * `status` that is not `handoff_ready` and a non-null `failureReason`.
 */
export interface FridayTaskWorkflowCliHandoff {
  readonly status: FridayTaskWorkflowCliHandoffStatus;
  readonly backendId: FridayTaskWorkflowCliBackendId;
  /** Draft summary text returned by CLI (or "" if not produced). */
  readonly summaryDraft: string;
  /** Always `false` — the adapter cannot self-attest verified. */
  readonly verified: false;
  readonly capabilityLabel: FridayTaskWorkflowCliCapabilityLabel;
  /** Number of bounded repair attempts performed (0 or 1). */
  readonly repairAttempts: number;
  /** Total milliseconds the adapter waited for CLI output. */
  readonly elapsedMs: number;
  /** Non-null when `status !== "handoff_ready"`. */
  readonly failureReason: string | null;
  readonly producedAt: string;
}

/** Input for `produceFridayTaskWorkflowCliHandoff`. */
export interface FridayTaskWorkflowCliInvokeInput {
  readonly backendId: FridayTaskWorkflowCliBackendId;
  readonly systemPrompt: string;
  readonly conversation: string;
  readonly contextPackage: FridayTaskWorkflowContextPackage;
  readonly boundaryRefs: readonly string[];
  /** Optional CLI model identifier passed to the underlying CLI binary. */
  readonly model?: string;
  /** Bounded adapter-level timeout in milliseconds (defaults to 60_000ms). */
  readonly timeoutMs?: number;
  /** Minimum non-whitespace summary length before the adapter accepts the
   *  raw CLI text. Below this triggers exactly one bounded repair attempt. */
  readonly minSummaryChars?: number;
}

/**
 * Persistent CLI handoff record. Stored alongside the originating CLI
 * lane (laneRole='cli') by the task workflow service whenever the live
 * adapter is invoked. Persistence here is the "stored unconfirmed" step
 * required by module_26c CSV: the handoff is durable evidence of the
 * CLI invocation outcome, but is always `verified: false`. Promotion to
 * a verified claim still requires a Friday native or provider verifier
 * lane to fresh-read referenced evidence; CLI verifier verdict
 * promotion remains refused.
 */
export interface FridayTaskWorkflowCliHandoffRecord {
  readonly id: string;
  readonly workflowId: string;
  readonly laneId: string;
  readonly backendId: FridayTaskWorkflowCliBackendId;
  readonly status: FridayTaskWorkflowCliHandoffStatus;
  readonly summaryDraft: string;
  readonly capabilityLabel: FridayTaskWorkflowCliCapabilityLabel;
  readonly repairAttempts: number;
  readonly elapsedMs: number;
  readonly failureReason: string | null;
  readonly producedAt: string;
  readonly createdAt: string;
}

/**
 * Service-level input for `recordCliHandoff`. The service derives the
 * boundary refs and context package from the workflow itself; callers
 * only supply the prompt + conversation and optional overrides. The
 * service refuses lanes that are not `laneRole='cli'`, not open, or do
 * not belong to the named workflow.
 */
export interface FridayTaskWorkflowRecordCliHandoffInput {
  readonly backendId: FridayTaskWorkflowCliBackendId;
  readonly systemPrompt: string;
  readonly conversation: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly minSummaryChars?: number;
}
