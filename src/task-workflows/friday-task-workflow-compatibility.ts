/**
 * Phase 13.5A claim-kind × evidence-ref-source compatibility policy (B.2.1).
 *
 * Defines which `FridayTaskWorkflowEvidenceSource` values are allowed to back
 * a claim of a given `FridayTaskWorkflowClaimKind`. The policy enforces the
 * Phase 13.5 module CSV requirements that:
 *
 *  - docs/spec/intent references describe intended behavior only and cannot
 *    back evidence-bearing behavior claims (runtime / code / api / artifact),
 *  - summary/context replay output remains unconfirmed and cannot back a
 *    verified behavior claim,
 *  - CLI self-report is unconfirmed until Friday fresh-reads referenced
 *    evidence — provider_route_trace is therefore not accepted as code or
 *    api-level audit, and CLI-shaped sources are bounded to the cli_self_report
 *    claim kind via the `manual_external` ref source,
 *  - provider fallback records availability, not independent fact audit, and
 *    therefore cannot back code or api evidence claims.
 *
 * Non-evidence claim kinds may attach their natural ref source (e.g.
 * `summary_replay` may reference `context_replay`); the kind still cannot
 * reach `verified` because the service rejects verification for
 * non-evidence-bearing claim kinds.
 *
 * @module task-workflows/friday-task-workflow-compatibility
 */

import type {
  FridayTaskWorkflowClaimKind,
  FridayTaskWorkflowEvidenceSource,
} from "./friday-task-workflow.types.js";

const NON_EVIDENCE_CLAIM_KINDS: ReadonlySet<FridayTaskWorkflowClaimKind> = new Set([
  "docs_intent",
  "summary_replay",
  "cli_self_report",
  "provider_fallback",
]);

/**
 * Allowed `refSource` values per `claimKind`.
 *
 * Each entry is the COMPLETE allow-list. Any source not present in the set
 * for a given claim kind is rejected by attachEvidenceRef and verifyClaim.
 */
const CLAIM_KIND_ALLOWED_REF_SOURCES: Readonly<
  Record<FridayTaskWorkflowClaimKind, ReadonlySet<FridayTaskWorkflowEvidenceSource>>
> = {
  // Non-evidence claim kinds: their natural ref source is allowed (so that
  // operators can still record the reference trail), but verifyClaim will
  // refuse the kind itself with TASK_WORKFLOW_CLAIM_KIND_NOT_VERIFIABLE.
  docs_intent: new Set<FridayTaskWorkflowEvidenceSource>([
    "docs_intent_reference",
    "manual_external",
  ]),
  summary_replay: new Set<FridayTaskWorkflowEvidenceSource>([
    "context_replay",
    "manual_external",
  ]),
  cli_self_report: new Set<FridayTaskWorkflowEvidenceSource>([
    "manual_external",
  ]),
  provider_fallback: new Set<FridayTaskWorkflowEvidenceSource>([
    "provider_route_trace",
    "manual_external",
  ]),
  // Evidence-bearing claim kinds. Explicitly EXCLUDE:
  //   - docs_intent_reference  (docs/spec intent is not behavior proof)
  //   - context_replay         (replay output stays unconfirmed)
  //   - provider_route_trace   (fallback availability is not an audit) for
  //                              code_evidence / api_evidence / artifact_evidence
  // `runtime_evidence` additionally excludes provider_route_trace because the
  // runtime claim must reach a real runtime artifact (agent run event,
  // workflow evidence, self-heal, observability) or a manual external proof.
  runtime_evidence: new Set<FridayTaskWorkflowEvidenceSource>([
    "agent_run_event",
    "workflow_run_evidence",
    "self_heal_event",
    "observability_audit",
    "manual_external",
  ]),
  code_evidence: new Set<FridayTaskWorkflowEvidenceSource>([
    "workflow_run_evidence",
    "observability_audit",
    "manual_external",
  ]),
  api_evidence: new Set<FridayTaskWorkflowEvidenceSource>([
    "agent_run_event",
    "workflow_run_evidence",
    "observability_audit",
    "manual_external",
  ]),
  artifact_evidence: new Set<FridayTaskWorkflowEvidenceSource>([
    "workflow_run_evidence",
    "observability_audit",
    "manual_external",
  ]),
};

/** Returns true when `claimKind` is one of the non-evidence-bearing kinds. */
export function isFridayTaskWorkflowNonEvidenceClaimKind(
  claimKind: FridayTaskWorkflowClaimKind,
): boolean {
  return NON_EVIDENCE_CLAIM_KINDS.has(claimKind);
}

/**
 * Returns true if `refSource` is allowed to back a claim of kind `claimKind`
 * per the B.2.1 compatibility policy.
 */
export function isFridayTaskWorkflowRefSourceCompatible(
  claimKind: FridayTaskWorkflowClaimKind,
  refSource: FridayTaskWorkflowEvidenceSource,
): boolean {
  const allowed = CLAIM_KIND_ALLOWED_REF_SOURCES[claimKind];
  return allowed !== undefined && allowed.has(refSource);
}

/** Returns the allow-list of evidence-ref sources for a claim kind. */
export function getFridayTaskWorkflowAllowedRefSources(
  claimKind: FridayTaskWorkflowClaimKind,
): readonly FridayTaskWorkflowEvidenceSource[] {
  const allowed = CLAIM_KIND_ALLOWED_REF_SOURCES[claimKind];
  return allowed ? [...allowed] : [];
}

/**
 * Returns true when `refKind` identifies a CLI-namespaced evidence ref
 * (e.g. `cli.handoff`, `cli.codex`, bare `cli`). Per module_26c the CLI
 * surface is bounded text only with `nativeToolProof=false`; a CLI
 * handoff / self-report ref therefore cannot itself satisfy a verified
 * evidence-bearing claim (`runtime_evidence`, `code_evidence`,
 * `api_evidence`, `artifact_evidence`) — only the natural pairing with
 * the non-verifiable `cli_self_report` claim kind is allowed. Trimming
 * and case-folding catch the trivially-shaped variants (`CLI.Handoff`,
 * ` cli.handoff `).
 */
export function isFridayTaskWorkflowCliShapedRefKind(refKind: string): boolean {
  const normalized = refKind.trim().toLowerCase();
  return normalized === "cli" || normalized.startsWith("cli.");
}
