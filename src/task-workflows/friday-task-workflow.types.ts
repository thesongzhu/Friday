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
}

export interface FridayTaskWorkflowBlockClaimInput {
  readonly reason: string;
}
