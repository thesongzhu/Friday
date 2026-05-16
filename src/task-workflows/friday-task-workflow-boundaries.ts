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
