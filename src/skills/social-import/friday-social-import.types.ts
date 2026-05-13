/**
 * Phase 02b — Social link to capability loop, partial slice types.
 *
 * This slice covers the FIRST half of the module_01 loop:
 *   social URL input -> real-browser XHS extraction (or honest human-blocked
 *   record) -> entity/source mapping (user-provided target GitHub repo URL,
 *   Mode A) -> candidate creation through the existing converter service ->
 *   canonical approval ticket for `skills.import.stage_candidate` with social
 *   provenance encoded in `planDigest`.
 *
 * The slice does NOT call the autonomy `shadow / canary / promote / verify /
 * rollback` chain, does NOT call `FridaySkillImportInstaller`, and does NOT
 * emit any learning event. Those transitions are driven by the user/operator
 * through the existing `/v1/autonomy/skills/:skillId/{shadow,canary,promote,
 * rollback}` and `/v1/skills/:skillId/verify` routes after this slice lands;
 * the response carries a `nextSteps` array listing the exact route sequence.
 *
 * Redaction discipline: payloads, response bodies, candidate metadata, and the
 * planDigest input MUST NOT contain raw social URL with query params, raw
 * GitHub URL with credentials, cookies, session strings, or extracted post
 * text values. Only redacted URIs (via redactFridaySkillCandidateSourceUri)
 * and provenance digests are permitted.
 *
 * @module skills/social-import
 */

import type { FridayCanonicalApprovalResolution } from "../../security/friday-mutating-action-gate.js";
import type { FridaySkillConversionSource } from "#skills/converter";

// ─── Social domain allowlist ───

/** Domains accepted for `socialUrl` validation (host must match exactly). */
export const FRIDAY_SOCIAL_IMPORT_ACCEPTED_HOSTS = [
  "www.xiaohongshu.com",
  "xiaohongshu.com",
  "xhslink.com",
] as const;

export type FridaySocialImportAcceptedHost =
  (typeof FRIDAY_SOCIAL_IMPORT_ACCEPTED_HOSTS)[number];

/** Plan version for the social-aware planDigest body. Bump on shape change. */
export const FRIDAY_SOCIAL_IMPORT_PLAN_VERSION =
  "friday.phase_02b.social-import.v1";

// ─── Request / response shapes ───

export interface FridaySocialImportRequest {
  /** Public XHS post URL. Allowlist enforced at route boundary. */
  readonly socialUrl: string;
  /** Mode-A user-provided target GitHub repo URL. */
  readonly targetGithubRepoUrl: string;
  /**
   * XHS session id used by the existing session/page primitives. Defaults to
   * `"xhs-default"` (the same default the agent tool uses). The userId for the
   * canonical actor is read from `ctx.principal.principalId`, not from the
   * body.
   */
  readonly sessionId?: string;
  /**
   * Pre-approved canonical approval resolution for the candidate-staging
   * mutation. When absent, the route returns `403 CANONICAL_APPROVAL_REQUIRED`
   * with the approval-request shape so the caller can drive the approval flow
   * separately and retry.
   */
  readonly canonicalApproval?: FridayCanonicalApprovalResolution;
  /** Optional idempotency key threaded into the staging mutation request. */
  readonly idempotencyKey?: string;
}

/**
 * Extraction-shape evidence the slice records to prove real-browser navigation
 * happened. `fieldsPresent` contains FIELD NAMES from the XHS comment shape
 * (`["author","content","likes"]`) — NEVER any field VALUES. `commentCount`
 * is a non-negative integer (0 is honest if the page has no comments).
 */
export interface FridaySocialImportExtractionShape {
  /** Social domain (constant per slice scope). */
  readonly socialDomain: "xiaohongshu.com";
  /** Field names from XhsComment present in the extraction. No values. */
  readonly fieldsPresent: readonly string[];
  /** Count of comments returned by `extractComments(postUrl)`. May be 0. */
  readonly commentCount: number;
  /** Real-browser extraction wall-clock duration. Proof of navigation. */
  readonly extractionDurationMs: number;
}

/**
 * Body shape fed into `createFridayMutatingActionDigest` as the `planDigest`.
 * Contains ONLY redacted URIs and provenance digests; no raw URLs, no
 * extracted text, no cookies. Reviewer B verifies this invariant.
 */
export interface FridaySocialImportPlanDigestInput {
  readonly planVersion: typeof FRIDAY_SOCIAL_IMPORT_PLAN_VERSION;
  readonly socialDomain: "xiaohongshu.com";
  readonly redactedSocialUri: string;
  readonly redactedTargetUri: string;
  readonly sourceProvenanceDigest: string;
  readonly extraction: FridaySocialImportExtractionShape;
}

/** Success response — the candidate has been staged. */
export interface FridaySocialImportSuccessResponse {
  readonly ok: true;
  readonly candidateId: string;
  readonly skillId: string;
  readonly socialDomain: "xiaohongshu.com";
  readonly redactedSocialUri: string;
  readonly redactedTargetUri: string;
  readonly sourceProvenanceDigest: string;
  readonly extraction: FridaySocialImportExtractionShape;
  readonly ticketId: string;
  readonly planDigest: string;
  readonly stagedAt: string;
  /**
   * Exact route sequence the user/operator should run next to finish closing
   * the module_01 loop. The slice itself does NOT call these routes.
   */
  readonly nextSteps: readonly string[];
}

// ─── Service interface ───

/**
 * Service produces the pre-staging context (URL allowlist, XHS session
 * check, real-browser extraction proof, source provenance, social-aware
 * planDigest). The route handler owns the canonical mutation gate call and
 * the converter `import(...)` invocation that actually stages the candidate.
 *
 * Throws structured `FridayDomainError`:
 *  - `400 VALIDATION_ERROR` for URL allowlist failures.
 *  - `503 SOCIAL_IMPORT_QR_LOGIN_REQUIRED` for the human-blocked branch.
 *  - `502 SOCIAL_IMPORT_EXTRACTION_FAILED` for real-browser extraction errors.
 */
export interface FridaySocialImportService {
  prepareStageContext(input: {
    request: FridaySocialImportRequest;
    actorPrincipalId: string;
    actorPrincipalKind: string;
    surface: string;
  }): Promise<FridaySocialImportStageContext>;
}

/**
 * Pre-staging context produced by the service. The route handler folds this
 * into the canonical mutation gate request and the converter import call.
 */
export interface FridaySocialImportStageContext {
  readonly request: FridaySocialImportRequest;
  readonly sessionId: string;
  readonly source: FridaySkillConversionSource;
  readonly sourceProvenanceDigest: string;
  readonly redactedSocialUri: string;
  readonly redactedTargetUri: string;
  readonly extraction: FridaySocialImportExtractionShape;
  readonly planDigest: string;
}

// ─── Default canonical next-step route sequence ───

export const FRIDAY_SOCIAL_IMPORT_DEFAULT_NEXT_STEPS = [
  "POST /v1/autonomy/skills/:skillId/shadow",
  "POST /v1/autonomy/skills/:skillId/canary",
  "POST /v1/autonomy/skills/:skillId/promote",
  "POST /v1/skills/:skillId/verify",
] as const;
