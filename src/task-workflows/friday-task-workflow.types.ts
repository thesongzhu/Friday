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

/**
 * Phase 14.5C: durability label projected from the upstream workflow run
 * evidence persistence status. `available` is the only value that can back
 * a proof claim; `degraded` and `unavailable` always force `proofClaimable`
 * to `false` regardless of the other gate outcomes.
 */
export type FridayTaskWorkflowWorkflowRunEvidenceStatus =
  | "available"
  | "degraded"
  | "unavailable";

/**
 * Audit C: completion-verification truth of an upstream workflow run,
 * ORTHOGONAL to its evidence-persistence durability above. Mirrors the
 * workflow runtime's `FridayNodeCompletionVerification` (kept as a local
 * string union so the task-workflow layer does not depend on the workflows
 * module). Only `verified` can back a proof claim; any other value means the
 * run was not a clean/verified completion (e.g. a side-effect node lacked
 * deterministic evidence → `proof_pending`) and `verifyClaim` refuses it for
 * a reason DISTINCT from persistence durability.
 */
export type FridayTaskWorkflowWorkflowRunCompletionVerification =
  | "verified"
  | "model_assessed_unverified"
  | "proof_pending"
  | "recovery_needed"
  | "blocked";

/**
 * Phase 14.5D module_28d: deterministic per-operation rollback class
 * surfaced on the task-workflow closeout receipt.
 *
 *  - `reversible_local`: every referenced evidence ref maps to an
 *    operation that Friday can undo locally (agent run event,
 *    self-heal event, session event).
 *  - `compensating_action_required`: the workflow references at least
 *    one operation whose reversal requires a compensating action
 *    (workflow_run_evidence — checkpoint/plugin/skill upgrade lifecycle
 *    where the rollback path is a separate compensating step).
 *  - `non_reversible_external`: the workflow touched at least one
 *    external system (channel send, provider call, manual external
 *    action). Those operations cannot be truly undone, so closeout
 *    must disclose the non-reversible reason instead of claiming
 *    reversibility.
 *  - `not_applicable`: only read-only / docs / replay / observability
 *    audit refs are present. Nothing to roll back.
 *
 * The union is `Readonly` by construction. The worst-case order used by
 * the closeout receipt is
 * `non_reversible_external` > `compensating_action_required` >
 * `reversible_local` > `not_applicable`.
 */
export type FridayTaskWorkflowOperationRollbackClass =
  | "reversible_local"
  | "compensating_action_required"
  | "non_reversible_external"
  | "not_applicable";

/**
 * Phase 14.5D module_28d: exhaustive read-only registry mapping each
 * `FridayTaskWorkflowEvidenceSource` to its rollback class. Adding a
 * new evidence ref source forces the compiler to assign a class here
 * via the `Record<Enum, Class>` constraint, so module_28d's universal
 * audit closure ("file/config/db/plugin/channel/external/GitHub/
 * provider classes have current status") cannot regress silently.
 *
 * The mapping covers:
 *  - file/config/db/session local operations:
 *      `agent_run_event`, `self_heal_event`, `session_event` →
 *      `reversible_local`.
 *  - workflow run / plugin / skill upgrade lifecycle:
 *      `workflow_run_evidence` → `compensating_action_required`.
 *  - external/channel/provider/manual external (incl. GitHub-style
 *    third-party side effects):
 *      `provider_route_trace`, `channel_event`, `manual_external` →
 *      `non_reversible_external`.
 *  - read-only docs / replay / audit references that perform no
 *    mutation themselves:
 *      `context_replay`, `observability_audit`,
 *      `docs_intent_reference` → `not_applicable`.
 */
export const FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE: Readonly<
  Record<
    FridayTaskWorkflowEvidenceSource,
    FridayTaskWorkflowOperationRollbackClass
  >
> = Object.freeze({
  agent_run_event: "reversible_local",
  workflow_run_evidence: "compensating_action_required",
  provider_route_trace: "non_reversible_external",
  context_replay: "not_applicable",
  self_heal_event: "reversible_local",
  channel_event: "non_reversible_external",
  session_event: "reversible_local",
  observability_audit: "not_applicable",
  manual_external: "non_reversible_external",
  docs_intent_reference: "not_applicable",
});

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
  /**
   * Phase 14.5C: worst-case evidence persistence status across every
   * workflow_run_evidence ref attached to a verified claim in this
   * workflow. `unavailable` > `degraded` > `available`. Defaults to
   * `available` when no workflow_run_evidence refs are referenced.
   */
  readonly evidenceDurability: FridayTaskWorkflowWorkflowRunEvidenceStatus;
  /**
   * Phase 14.5C: deterministic proof-claim eligibility. `true` iff
   * `evidenceDurability === "available"` AND every required gate
   * (including `workflow_run_evidence_durable`) passed. A `true` value
   * is the only situation in which a downstream consumer may render
   * "release-proof eligible" wording for this workflow.
   */
  readonly proofClaimable: boolean;
  /**
   * Phase 14.5D module_28d: deterministic worst-case rollback class
   * across every evidence ref attached to a verified or blocked claim
   * in this workflow. Legacy rows (closeout receipts written before
   * v087-rollback-matrix-closeout-receipt) rehydrate as
   * `not_applicable`. Rollback proof itself is not release proof; this
   * field is honest disclosure for users and reviewers.
   */
  readonly rollbackClass: FridayTaskWorkflowOperationRollbackClass;
  /**
   * Phase 14.5D module_28d: required non-empty summary when
   * `rollbackClass === "compensating_action_required"`. Lists the
   * evidence ref sources whose reversal needs a compensating action.
   * `null` for every other class.
   */
  readonly compensatingAction: string | null;
  /**
   * Phase 14.5D module_28d: required non-empty summary when
   * `rollbackClass === "non_reversible_external"`. Names the
   * external/channel/provider sources that cannot be truly undone.
   * `null` for every other class.
   */
  readonly nonReversibleReason: string | null;
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
export type FridayTaskWorkflowCliBackendId = "codex-cli";

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

/* ──────────────────────────────────────────────────────────────────────
 * Phase 13.5D: Supervisor surfaces / configured-channel commands /
 *              Global Evidence Explorer v1
 * ──────────────────────────────────────────────────────────────────────
 *
 * Phase 13.5D productizes the read-side supervisor surfaces, the
 * configured-channel task workflow command flow, and a global evidence
 * metadata index over the existing evidence ref store. These types
 * intentionally do NOT define a parallel raw evidence store: the
 * supervisor view assembles existing primitives, the channel command
 * surface stores hashed identifiers only, and the evidence explorer
 * indexes the same task_workflow_evidence_refs rows that Phase 13.5A
 * already persists.
 */

/** Compact summary of a workflow's context package surface. Whole-repo
 *  inclusion is refused at create/revise time, so this summary is only a
 *  cardinality + boundary identity view — it never echoes file lists. */
export interface FridayTaskWorkflowContextPackageSummary {
  readonly boundaryIds: readonly string[];
  readonly allowedFilesCount: number;
  readonly allowedToolsCount: number;
  readonly allowedApisCount: number;
}

/** Lane counts grouped by kind / status / independence. */
export interface FridayTaskWorkflowLaneSummary {
  readonly executor: {
    readonly count: number;
    readonly open: number;
    readonly completed: number;
    readonly blocked: number;
  };
  readonly verifier: {
    readonly count: number;
    readonly open: number;
    readonly completed: number;
    readonly blocked: number;
    readonly independent: number;
    readonly degraded: number;
  };
}

/** Aggregate counts of channel command records for a workflow. */
export interface FridayTaskWorkflowChannelCommandSummary {
  readonly total: number;
  readonly issued: number;
  readonly confirmed: number;
  readonly dispatched: number;
  readonly declined: number;
  readonly expired: number;
}

/**
 * Unified read-only supervisor view assembled by
 * `friday-task-workflow-supervisor-view.ts`. The view is read-only by
 * construction: it touches only task workflow tables (additive Phase
 * 13.5A/B/C/D), never `/v1/agent/runs` and never the channel registry's
 * raw inbound buffers.
 */
export interface FridayTaskWorkflowSupervisorOverview {
  readonly workflow: FridayTaskWorkflowRecord;
  readonly supervisorCursor: FridayTaskWorkflowSupervisorCursorRecord | null;
  readonly boundaryRefs: readonly string[];
  readonly contextPackageSummary: FridayTaskWorkflowContextPackageSummary;
  readonly gatePlan: readonly FridayTaskWorkflowGatePlanEntry[];
  /** Subset of gatePlan gate ids that are required; mirrors the gate
   *  registry truth. Required gates remain immutable in the UI; surfaces
   *  must render them as non-disableable, regardless of supervisor mode. */
  readonly immutableRequiredGateIds: readonly string[];
  readonly claimMatrix: {
    readonly counts: Readonly<{
      draft: number;
      unverified: number;
      verified: number;
      blocked: number;
    }>;
    readonly unverifiedClaims: readonly FridayTaskWorkflowClaimRecord[];
    readonly blockedClaims: readonly FridayTaskWorkflowClaimRecord[];
  };
  readonly laneSummary: FridayTaskWorkflowLaneSummary;
  readonly channelCommandSummary: FridayTaskWorkflowChannelCommandSummary;
  readonly blockers: readonly string[];
  readonly closeoutReceipt: FridayTaskWorkflowCloseoutReceipt | null;
}

/** Canonical task-workflow intents reachable through configured channels. */
export type FridayTaskWorkflowChannelIntentKind =
  | "progress_query"
  | "closeout_request"
  | "supervisor_mode_preview"
  | "confirm_token";

export type FridayTaskWorkflowChannelCommandStatus =
  | "issued"
  | "confirmed"
  | "dispatched"
  | "declined"
  | "expired";

/**
 * Typed channel command record. Stored fields are intentionally
 * privacy-preserving:
 *
 *   * `channelChatHash`, `channelMessageHash`, `senderHash` are SHA-256
 *     hex digests over the channel's canonical chat / message / sender
 *     identifiers — never the raw message text or body.
 *   * `confirmationToken` is a Friday-issued opaque token used to gate
 *     dispatch. It never embeds raw user content.
 *   * `dispatchedAction` records the canonical task-workflow service
 *     method invoked on dispatch (e.g. "task.workflows.get"), not the
 *     raw user message that triggered the action.
 */
export interface FridayTaskWorkflowChannelCommandRecord {
  readonly id: string;
  readonly workflowId: string;
  readonly channelKind: string;
  readonly channelChatHash: string;
  readonly channelMessageHash: string;
  readonly senderHash: string;
  readonly intentKind: FridayTaskWorkflowChannelIntentKind;
  readonly confirmationToken: string;
  readonly status: FridayTaskWorkflowChannelCommandStatus;
  readonly dispatchedAction: string | null;
  readonly declinedReason: string | null;
  readonly issuedAt: string;
  readonly confirmedAt: string | null;
  readonly dispatchedAt: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

/**
 * Issued channel command + canonical outbound disclosure text. The
 * outbound text is composed by the service so callers do not paste raw
 * user content back into the channel notifier. The disclosure makes the
 * confirmation token, intent, and expiry visible to the user via the
 * existing channel send path.
 */
export interface FridayTaskWorkflowIssueChannelCommandResult {
  readonly command: FridayTaskWorkflowChannelCommandRecord;
  /** Friday-composed outbound text the caller can pass to the channel
   *  registry's send adapter. Never echoes raw inbound text. */
  readonly outboundDisclosure: string;
}

export interface FridayTaskWorkflowIssueChannelCommandInput {
  readonly channelKind: string;
  /** Canonical chat identifier from the channel adapter. Will be hashed
   *  before persistence; never stored raw. */
  readonly channelChatId: string;
  /** Canonical message identifier from the channel adapter. Will be
   *  hashed before persistence; never stored raw. */
  readonly channelMessageId: string;
  /** Canonical sender identifier from the channel adapter. Will be
   *  hashed before persistence; never stored raw. */
  readonly senderId: string;
  readonly intentKind: FridayTaskWorkflowChannelIntentKind;
  /** Bounded lifetime for the issued confirmation token. Defaults to
   *  10 minutes when omitted. */
  readonly ttlMs?: number;
}

/**
 * Result of `confirmChannelCommand`. The command is moved to
 * `dispatched` after the canonical task-workflow action runs; the
 * returned `disclosure` is the Friday-composed outbound notification
 * text the caller can pipe back to the channel adapter.
 */
export interface FridayTaskWorkflowConfirmChannelCommandResult {
  readonly command: FridayTaskWorkflowChannelCommandRecord;
  readonly dispatchedAction: string;
  /** Friday-composed outbound text. Never echoes raw inbound text. */
  readonly outboundDisclosure: string;
}

export interface FridayTaskWorkflowConfirmChannelCommandInput {
  readonly confirmationToken: string;
}

/**
 * Compact metadata entry surfaced by the Global Evidence Explorer.
 * The explorer indexes the existing `task_workflow_evidence_refs` rows
 * — it does NOT duplicate raw payloads. Raw drilldown is a separate
 * gated route that returns server-redacted ref fields only.
 */
export interface FridayTaskWorkflowEvidenceExplorerEntry {
  readonly evidenceRefId: string;
  readonly workflowId: string;
  readonly claimId: string;
  readonly refKind: string;
  readonly refSource: FridayTaskWorkflowEvidenceSource;
  readonly refHash: string | null;
  /** Cardinality / source verdict context: the claim's current status
   *  at index time. Verdict drilldown still requires the gated raw
   *  route. */
  readonly claimStatus: FridayTaskWorkflowClaimStatus;
  readonly claimKind: FridayTaskWorkflowClaimKind;
  readonly createdAt: string;
}

/**
 * Server-redacted raw evidence drilldown payload. The route that emits
 * this record requires an explicit `gateConfirmed=true` query parameter
 * and always applies secret-pattern redaction to text fields before
 * returning. Per module_26d the unredacted raw ref id is never surfaced
 * over the API — only `refIdRedacted` is exposed, even after the gate
 * confirmation. Tests must fail if the gate, the redaction, or the
 * no-raw-refId boundary is bypassed.
 */
export interface FridayTaskWorkflowEvidenceRawDrilldown {
  readonly evidenceRefId: string;
  readonly workflowId: string;
  readonly claimId: string;
  readonly refKind: string;
  readonly refSource: FridayTaskWorkflowEvidenceSource;
  readonly refIdRedacted: string;
  readonly refHash: string | null;
  readonly redactionApplied: boolean;
  readonly createdAt: string;
}

/**
 * Input filter for the Global Evidence Explorer index.
 *
 * The explorer is intentionally lightweight: filter by workflow id,
 * claim id, ref source, ref kind, or claim kind; bounded result limit.
 * Raw payload fields are never exposed by this surface.
 */
export interface FridayTaskWorkflowEvidenceExplorerQuery {
  readonly workflowId?: string;
  readonly claimId?: string;
  readonly refSource?: FridayTaskWorkflowEvidenceSource;
  readonly refKind?: string;
  readonly claimKind?: FridayTaskWorkflowClaimKind;
  readonly limit?: number;
}
