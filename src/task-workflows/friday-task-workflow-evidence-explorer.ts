/**
 * Phase 13.5D Global Evidence Explorer v1 helpers.
 *
 * The explorer indexes existing `task_workflow_evidence_refs` rows by
 * metadata only. It does NOT create a parallel raw evidence store. Two
 * separate operations are exposed:
 *
 *   1. `projectFridayEvidenceExplorerEntry` — surfaces ref metadata
 *      (refKind, refSource, refHash, claim status / kind, createdAt)
 *      without exposing the raw ref id. This is the default surface.
 *   2. `redactFridayEvidenceRefForDrilldown` — server-redacted raw view
 *      of a single ref. Only invoked when the gated drilldown route has
 *      confirmed an explicit gate. The redactor masks anything that
 *      looks like an API key, OAuth token, JWT, or other secret-pattern
 *      identifier with `<REDACTED>` markers; tests must fail closed if
 *      the redactor is bypassed.
 *
 * @module task-workflows/friday-task-workflow-evidence-explorer
 */

import type {
  FridayTaskWorkflowClaimRecord,
  FridayTaskWorkflowEvidenceExplorerEntry,
  FridayTaskWorkflowEvidenceRawDrilldown,
  FridayTaskWorkflowEvidenceRefRecord,
} from "./friday-task-workflow.types.js";

/**
 * Project an evidence ref record + its parent claim into a compact
 * explorer entry. The entry is metadata only — `refId` and any other
 * potentially sensitive payload field is intentionally omitted. The
 * caller can pivot to `redactFridayEvidenceRefForDrilldown` through the
 * gated drilldown route when explicit access is approved.
 */
export function projectFridayEvidenceExplorerEntry(input: {
  readonly evidenceRef: FridayTaskWorkflowEvidenceRefRecord;
  readonly claim: FridayTaskWorkflowClaimRecord;
}): FridayTaskWorkflowEvidenceExplorerEntry {
  return {
    evidenceRefId: input.evidenceRef.id,
    workflowId: input.evidenceRef.workflowId,
    claimId: input.evidenceRef.claimId,
    refKind: input.evidenceRef.refKind,
    refSource: input.evidenceRef.refSource,
    refHash: input.evidenceRef.refHash,
    claimStatus: input.claim.status,
    claimKind: input.claim.claimKind,
    createdAt: input.evidenceRef.createdAt,
  };
}

/**
 * Server-side redaction for raw drilldown. The drilldown route MUST
 * call this helper before returning a payload — tests verify that the
 * `refIdRedacted` field never contains live secret patterns, that the
 * `redactionApplied` flag reflects whether masking modified the input,
 * and that the unredacted raw `refId` is NEVER included in the returned
 * drilldown shape (the only ref text exposed by the API is the redacted
 * form, even when the gate has been confirmed).
 */
export function redactFridayEvidenceRefForDrilldown(
  evidenceRef: FridayTaskWorkflowEvidenceRefRecord,
): FridayTaskWorkflowEvidenceRawDrilldown {
  const { redacted, applied } = redactSecretPatterns(evidenceRef.refId);
  return {
    evidenceRefId: evidenceRef.id,
    workflowId: evidenceRef.workflowId,
    claimId: evidenceRef.claimId,
    refKind: evidenceRef.refKind,
    refSource: evidenceRef.refSource,
    refIdRedacted: redacted,
    refHash: evidenceRef.refHash,
    redactionApplied: applied,
    createdAt: evidenceRef.createdAt,
  };
}

/**
 * Pattern-based secret redactor. Patterns are intentionally narrow and
 * conservative: they target well-known secret shapes (OpenAI sk-..., AWS
 * AKIA..., GitHub ghp_..., Slack xox*-..., generic bearer tokens, and
 * the common JWT shape). The redactor is content-blind beyond those
 * patterns; for unfamiliar payload kinds the caller still must NOT
 * surface the raw ref id without an explicit gate.
 */
function redactSecretPatterns(input: string): { redacted: string; applied: boolean } {
  if (typeof input !== "string" || input.length === 0) {
    return { redacted: input ?? "", applied: false };
  }
  const patterns: readonly RegExp[] = [
    /sk-[A-Za-z0-9_\-]{16,}/g,
    /AKIA[0-9A-Z]{16}/g,
    /gh[pousr]_[A-Za-z0-9]{16,}/g,
    /xox[abprs]-[A-Za-z0-9-]{10,}/g,
    /Bearer\s+[A-Za-z0-9._\-]{12,}/g,
    /eyJ[A-Za-z0-9._\-]{20,}\.[A-Za-z0-9._\-]{12,}\.[A-Za-z0-9._\-]{12,}/g,
  ];
  let redacted = input;
  let applied = false;
  for (const pattern of patterns) {
    const next = redacted.replace(pattern, "<REDACTED>");
    if (next !== redacted) {
      redacted = next;
      applied = true;
    }
  }
  return { redacted, applied };
}

/** Exposed for tests so we can assert the redaction pattern set is
 *  applied — never re-export raw secrets from tests. */
export const __testOnlyRedactSecretPatterns = redactSecretPatterns;
