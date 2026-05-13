/**
 * Phase 02b — Social Import orchestrator service (pre-staging only).
 *
 * The service handles the parts of the partial slice that DO NOT need access
 * to the api-runtime-internal canonical mutation gate or converter service:
 *
 *   1. URL allowlist enforcement (socialUrl host + targetGithubRepoUrl host).
 *   2. XHS session validity check via the existing session manager.
 *   3. Real-browser comment extraction via the existing `extractComments`
 *      primitive (read-only; records count + field names only, never values).
 *   4. Source provenance + redacted URIs via the existing converter helpers.
 *   5. Social-aware `planDigest` derived from the redacted-URI plan body.
 *
 * The route handler is responsible for calling the canonical mutation gate
 * and the converter service `import(...)` (with the returned ticket) — see
 * `src/api/http/routes/friday-social-import-routes.ts`. The slice does NOT
 * call autonomy shadow/canary/promote/rollback, does NOT call the installer,
 * does NOT call doctor verify, and does NOT emit a learning event.
 */

import { FridayDomainError } from "#errors";
import {
  createFridaySkillCandidateSourceProvenance,
  redactFridaySkillCandidateSourceUri,
  type FridaySkillConversionSource,
} from "#skills/converter";
import {
  createFridayMutatingActionDigest,
  type FridayMutatingActionRequest,
} from "../../security/friday-mutating-action-gate.js";
import type {
  XhsPageInteractions,
  XhsSessionManager,
} from "#xhs";

import {
  FRIDAY_SOCIAL_IMPORT_ACCEPTED_HOSTS,
  FRIDAY_SOCIAL_IMPORT_PLAN_VERSION,
  type FridaySocialImportExtractionShape,
  type FridaySocialImportPlanDigestInput,
  type FridaySocialImportRequest,
  type FridaySocialImportService,
  type FridaySocialImportStageContext,
} from "./friday-social-import.types.js";

// ─── Constants ───

const DEFAULT_SESSION_ID = "xhs-default";
const XHS_COMMENT_FIELDS_PRESENT = ["author", "content", "likes"] as const;

// ─── Dependencies ───

export interface CreateFridaySocialImportServiceDeps {
  readonly xhsPageInteractions: XhsPageInteractions;
  readonly xhsSessionManager: XhsSessionManager;
}

// ─── Factory ───

export function createFridaySocialImportService(
  deps: CreateFridaySocialImportServiceDeps,
): FridaySocialImportService {
  return {
    async prepareStageContext(input) {
      const { request, actorPrincipalId, actorPrincipalKind, surface } = input;
      const sessionId = request.sessionId ?? DEFAULT_SESSION_ID;

      // Step 1: URL allowlist enforcement.
      assertSocialUrlAllowed(request.socialUrl);
      assertTargetGithubUrlAllowed(request.targetGithubRepoUrl);

      // Step 2: XHS session validity.
      if (!deps.xhsSessionManager.isSessionValid(sessionId)) {
        throw new FridayDomainError(
          "SOCIAL_IMPORT_QR_LOGIN_REQUIRED",
          "XHS session is not valid; complete QR login via the existing `xhs.login` agent-tool action and retry.",
          {
            httpStatus: 503,
            details: {
              blockedBy: "xhs.qr_login",
              remediation: "agent_tool:xhs.login",
              sessionId,
            },
          },
        );
      }

      // Step 3: Real-browser extraction proof — read-only comment extraction.
      // Only count + field names are recorded, never values.
      const extractionStart = Date.now();
      let commentCount = 0;
      try {
        const comments = await deps.xhsPageInteractions.extractComments(
          sessionId,
          request.socialUrl,
        );
        commentCount = Array.isArray(comments) ? comments.length : 0;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new FridayDomainError(
          "SOCIAL_IMPORT_EXTRACTION_FAILED",
          `XHS extraction failed: ${redactErrorMessage(message, request)}`,
          {
            httpStatus: 502,
            details: { sessionId },
          },
        );
      }
      const extractionDurationMs = Math.max(0, Date.now() - extractionStart);
      const extraction: FridaySocialImportExtractionShape = {
        socialDomain: "xiaohongshu.com",
        fieldsPresent: [...XHS_COMMENT_FIELDS_PRESENT],
        commentCount,
        extractionDurationMs,
      };

      // Step 4: Source provenance + redacted URIs.
      const source: FridaySkillConversionSource = {
        uri: request.targetGithubRepoUrl,
        formatHint: "code-repo",
      };
      const sourceProvenance = createFridaySkillCandidateSourceProvenance(source);
      const redactedSocialUri = redactFridaySkillCandidateSourceUri(
        request.socialUrl,
      );
      const redactedTargetUri = redactFridaySkillCandidateSourceUri(
        request.targetGithubRepoUrl,
      );

      // Step 5: Social-aware planDigest. The digest input contains ONLY
      // redacted URIs and provenance digests — never raw URLs, never
      // extracted text values. extractionDurationMs is excluded to keep the
      // digest deterministic across runs; the response still carries the
      // real duration as proof of navigation.
      const planDigestInput: FridaySocialImportPlanDigestInput = {
        planVersion: FRIDAY_SOCIAL_IMPORT_PLAN_VERSION,
        socialDomain: "xiaohongshu.com",
        redactedSocialUri,
        redactedTargetUri,
        sourceProvenanceDigest: sourceProvenance.sourceDigest,
        extraction: {
          ...extraction,
          extractionDurationMs: 0,
        },
      };
      const planDigestRequest: FridayMutatingActionRequest = {
        action: "skills.import.stage_candidate.social",
        actor: {
          kind: actorPrincipalKind,
          id: actorPrincipalId,
          principalId: actorPrincipalId,
        },
        surface,
        resource: {
          type: "external_skill_candidate_social_plan",
          digest: stablePlanDigestResourceFingerprint(planDigestInput),
        },
        mutating: false,
        parameters: planDigestInput as unknown as Record<string, unknown>,
      };
      const planDigest = createFridayMutatingActionDigest(planDigestRequest);

      return {
        request,
        sessionId,
        source,
        sourceProvenanceDigest: sourceProvenance.sourceDigest,
        redactedSocialUri,
        redactedTargetUri,
        extraction,
        planDigest,
      };
    },
  };
}

// ─── URL validation ───

function assertSocialUrlAllowed(socialUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(socialUrl);
  } catch {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "socialUrl must be a valid URL.",
      { httpStatus: 400 },
    );
  }
  if (parsed.protocol !== "https:") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "socialUrl must use the https:// scheme.",
      { httpStatus: 400 },
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!FRIDAY_SOCIAL_IMPORT_ACCEPTED_HOSTS.includes(host as never)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `socialUrl host must be one of: ${FRIDAY_SOCIAL_IMPORT_ACCEPTED_HOSTS.join(", ")}.`,
      { httpStatus: 400 },
    );
  }
}

function assertTargetGithubUrlAllowed(targetUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "targetGithubRepoUrl must be a valid URL.",
      { httpStatus: 400 },
    );
  }
  if (parsed.protocol !== "https:") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "targetGithubRepoUrl must use the https:// scheme.",
      { httpStatus: 400 },
    );
  }
  if (parsed.hostname.toLowerCase() !== "github.com") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "targetGithubRepoUrl host must be github.com.",
      { httpStatus: 400 },
    );
  }
  // Path must shape like /<owner>/<repo>[/...]. We accept additional path
  // segments (release tag, subpath) since the existing code-repo converter
  // handles them; only reject obviously malformed shapes here.
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "targetGithubRepoUrl path must be `/owner/repo` at minimum.",
      { httpStatus: 400 },
    );
  }
}

// ─── Helpers ───

function redactErrorMessage(
  message: string,
  request: FridaySocialImportRequest,
): string {
  // Strip raw URLs from any nested error message before surfacing to the
  // route response. Keeps the message useful for debugging while preventing
  // raw-URL leakage into logs / responses.
  let out = message;
  if (request.socialUrl.length > 0) {
    out = out.split(request.socialUrl).join("<redacted-social-uri>");
  }
  if (request.targetGithubRepoUrl.length > 0) {
    out = out.split(request.targetGithubRepoUrl).join("<redacted-target-uri>");
  }
  return out;
}

function stablePlanDigestResourceFingerprint(value: unknown): string {
  // Local lightweight stable JSON fingerprint for the inner resource.digest.
  // The authoritative cryptographic hash for the overall planDigest is
  // createFridayMutatingActionDigest (sha256 over a stable payload).
  const text = JSON.stringify(normalize(value));
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return `social-plan-fingerprint:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item !== undefined) {
      sorted[key] = normalize(item);
    }
  }
  return sorted;
}
