/**
 * Phase 13.5A built-in product capability / API boundary catalog.
 *
 * The boundary registry is intentionally read-only in v1. There is no
 * BoundaryContract CRUD API. Boundaries describe product capability and
 * API surfaces (allowed operations, hard boundaries, the evidence ref
 * sources scoped to that surface, and the required gates that apply).
 *
 * Boundary IDs are stable strings; the catalog seeds the surface that
 * later subphases (13.5B/C/D) will consume read-only.
 *
 * @module task-workflows/friday-task-workflow-boundaries
 */

import type { FridayTaskWorkflowBoundaryContract } from "./friday-task-workflow.types.js";

export const FRIDAY_TASK_WORKFLOW_BUILTIN_BOUNDARIES: readonly FridayTaskWorkflowBoundaryContract[] = [
  {
    boundaryId: "api.task_workflows.core",
    label: "Task workflow API surface",
    description:
      "Read/preview/create/revise/claim/evidence/verify/closeout routes for the task workflow policy. Does not mutate /v1/agent/runs state.",
    allowedOperations: [
      "preview",
      "create",
      "read",
      "list",
      "revise",
      "draft_claim",
      "attach_evidence_ref",
      "verify_claim",
      "block_claim",
      "closeout",
      "read_catalog",
    ],
    hardBoundaries: [
      "no_agent_run_mutation",
      "no_provider_fallback_as_audit",
      "no_summary_replay_as_proof",
      "no_docs_intent_as_proof",
      "no_cli_self_report_as_proof",
      "no_whole_repo_context_package",
      "no_required_gate_disable",
      "no_runtime_evidence_with_docs_intent_reference",
      "no_runtime_evidence_with_context_replay",
      "no_runtime_evidence_with_provider_route_trace",
      "no_api_evidence_with_provider_route_trace",
      "no_code_evidence_with_provider_route_trace",
      "no_artifact_evidence_with_provider_route_trace",
      "no_evidence_claim_with_docs_intent_reference",
      "no_evidence_claim_with_context_replay",
    ],
    evidenceRefSources: [],
    requiredGateIds: [
      "claim_evidence_required",
      "verifier_fresh_read",
      "docs_intent_not_proof",
      "summary_replay_unconfirmed",
      "cli_self_report_unconfirmed",
      "provider_fallback_not_audit",
      "context_package_scope_limit",
    ],
  },
  {
    boundaryId: "evidence.refs.agent_run",
    label: "Agent run events evidence reference",
    description:
      "Reference agent run event records (run id + event id) without copying raw payloads into task workflow tables.",
    allowedOperations: ["reference_evidence_ref"],
    hardBoundaries: ["no_raw_payload_copy"],
    evidenceRefSources: ["agent_run_event"],
    requiredGateIds: ["claim_evidence_required", "verifier_fresh_read"],
  },
  {
    boundaryId: "evidence.refs.workflow_run",
    label: "Workflow run evidence reference",
    description:
      "Reference workflow run evidence exports by id/hash without copying raw payloads.",
    allowedOperations: ["reference_evidence_ref"],
    hardBoundaries: ["no_raw_payload_copy"],
    evidenceRefSources: ["workflow_run_evidence"],
    requiredGateIds: ["claim_evidence_required", "verifier_fresh_read"],
  },
  {
    boundaryId: "evidence.refs.provider_route_trace",
    label: "Provider route trace evidence reference",
    description:
      "Reference provider routing/fallback traces. Fallback availability is recorded but does not satisfy verifier verdicts. Provider route traces are NOT compatible with runtime/api/code/artifact evidence claim kinds.",
    allowedOperations: ["reference_evidence_ref"],
    hardBoundaries: [
      "no_raw_payload_copy",
      "no_provider_fallback_as_audit",
      "no_runtime_evidence_with_provider_route_trace",
      "no_api_evidence_with_provider_route_trace",
      "no_code_evidence_with_provider_route_trace",
      "no_artifact_evidence_with_provider_route_trace",
    ],
    evidenceRefSources: ["provider_route_trace"],
    requiredGateIds: ["provider_fallback_not_audit"],
  },
  {
    boundaryId: "evidence.refs.context_replay",
    label: "Context replay evidence reference",
    description:
      "Reference compaction / context replay records. Replay output remains `unverified` until separate fresh evidence is attached. Context replay is NOT compatible with evidence-bearing claim kinds (runtime / api / code / artifact).",
    allowedOperations: ["reference_evidence_ref"],
    hardBoundaries: [
      "no_raw_payload_copy",
      "no_summary_replay_as_proof",
      "no_evidence_claim_with_context_replay",
    ],
    evidenceRefSources: ["context_replay"],
    requiredGateIds: ["summary_replay_unconfirmed"],
  },
  {
    boundaryId: "evidence.refs.channel_event",
    label: "Channel / session event evidence reference",
    description:
      "Reference channel/session event records. Raw channel payloads are not copied into task workflow tables.",
    allowedOperations: ["reference_evidence_ref"],
    hardBoundaries: ["no_raw_payload_copy"],
    evidenceRefSources: ["channel_event", "session_event"],
    requiredGateIds: ["claim_evidence_required"],
  },
  {
    boundaryId: "evidence.refs.docs_intent",
    label: "Docs/spec/intent evidence reference",
    description:
      "Reference docs/spec/START_HERE intent records. Docs intent is NOT proof of behavior; it cannot back evidence-bearing claim kinds (runtime / api / code / artifact) and cannot satisfy a verified claim.",
    allowedOperations: ["reference_evidence_ref"],
    hardBoundaries: [
      "no_docs_intent_as_proof",
      "no_evidence_claim_with_docs_intent_reference",
    ],
    evidenceRefSources: ["docs_intent_reference"],
    requiredGateIds: ["docs_intent_not_proof"],
  },
  {
    boundaryId: "api.task_workflows.lanes",
    label: "Task workflow executor/verifier lane surface",
    description:
      "Open and complete executor and verifier lanes, submit verifier verdicts, and read lane state. Executor lanes are bound to a frozen context snapshot hash. Verifier lanes are read-only with respect to task state: verdicts are promoted only through the service-mediated submitVerifierVerdict path. Provider fallback availability is recorded as a label and never counts as a verifier verdict. High-risk workflows refuse non-independent verifier lanes. CLI lanes (laneRole='cli') are bounded text executor/reviewer surfaces only — they are never accepted as verifier verdict producers for any risk level.",
    allowedOperations: [
      "open_executor_lane",
      "complete_executor_lane",
      "open_verifier_lane",
      "complete_verifier_lane",
      "submit_verifier_verdict",
      "list_lanes",
      "read_lane",
    ],
    hardBoundaries: [
      "no_verifier_lane_mutation_of_task_state",
      "no_provider_fallback_as_verifier_proof",
      "no_executor_lane_without_context_snapshot",
      "no_verifier_lane_without_executor_parent",
      "no_high_risk_self_verification",
      "no_lane_context_drift_after_revision",
      "no_cli_verifier_promotion",
    ],
    evidenceRefSources: [],
    requiredGateIds: [
      "claim_evidence_required",
      "verifier_fresh_read",
      "executor_lane_context_bound",
      "provider_fallback_not_audit",
    ],
  },
  {
    boundaryId: "api.task_workflows.cli_adapter",
    label: "Task workflow CLI backend adapter surface",
    description:
      "Bounded text executor / reviewer adapter that wraps Friday's existing CLI completion primitive (runFridayCliBackendTextCompletion) and emits a normalized draft / unverified handoff with a machine-readable capability label. The adapter never copies whole-repo source into CLI prompts, never depends on local Codex/Claude conveyor bridge implementation details, and never satisfies a verified claim on its own. CLI summaries remain `unverified` until Friday's native or provider verifier lanes fresh-read the referenced evidence. The adapter applies bounded timeout, one bounded malformed-output repair attempt, and fail-closed handoff for CLI unavailability / auth missing.",
    allowedOperations: [
      "produce_cli_handoff",
      "compute_capability_label",
    ],
    hardBoundaries: [
      "no_cli_native_tool_proof",
      "no_cli_verifier_promotion",
      "no_whole_repo_context_for_cli",
      "no_local_conveyor_dependency",
      "no_unbounded_cli_repair_loop",
      "cli_summary_unconfirmed_until_fresh_read",
    ],
    evidenceRefSources: ["manual_external"],
    requiredGateIds: [
      "cli_self_report_unconfirmed",
      "claim_evidence_required",
      "verifier_fresh_read",
      "context_package_scope_limit",
    ],
  },
];

const BOUNDARY_IDS: ReadonlySet<string> = new Set(
  FRIDAY_TASK_WORKFLOW_BUILTIN_BOUNDARIES.map((b) => b.boundaryId),
);

export function isFridayKnownBoundary(boundaryId: string): boolean {
  return BOUNDARY_IDS.has(boundaryId);
}

/** Default boundary refs for a fresh task workflow. */
export function defaultFridayTaskWorkflowBoundaryRefs(): readonly string[] {
  return ["api.task_workflows.core"];
}
