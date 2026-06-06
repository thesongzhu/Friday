/**
 * Phase 02b — Social Import HTTP route.
 *
 * Exposes a single public route for the partial Phase 02b slice:
 *   POST /v1/skills/social-import (operationId: skills.social.import)
 *
 * The route is always registered. When bootstrap could not enable the
 * social-import service (XHS deps absent), or when the api-runtime cannot
 * inject the converter service / canonical mutation gate (test fixture etc.),
 * the deps fields are null and the handler returns
 * `503 SOCIAL_IMPORT_DISABLED` with a structured `disabledReason` that never
 * echoes env values, cookies, session strings, or credentials.
 *
 * Closure scope is intentionally PARTIAL — see plan + service module.
 *
 * @module api/http/routes/friday-social-import-routes
 */

import { FridayDomainError } from "#errors";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";

import type {
  FridaySocialImportRequest,
  FridaySocialImportService,
  FridaySocialImportSuccessResponse,
} from "#skills/social-import";
import { FRIDAY_SOCIAL_IMPORT_DEFAULT_NEXT_STEPS } from "#skills/social-import";
import {
  createFridaySkillStageMutatingActionRequest,
  type FridaySkillConverterService,
} from "#skills/converter";
import {
  type FridayCanonicalApprovalResolution,
  type FridayMutatingActionGate,
} from "../../../security/friday-mutating-action-gate.js";

// ─── Deps ───

export interface FridaySocialImportRoutesDeps {
  /** Active social-import service when enabled; null when disabled. */
  readonly service: FridaySocialImportService | null;
  /**
   * Structured short reason from bootstrap explaining why social-import is
   * disabled. Must never include env values, cookies, session strings, or
   * partial credentials.
   */
  readonly disabledReason: string | null;
}

// ─── Internal route-side deps wired by createFridayApiRuntime ───

export interface FridaySocialImportRoutesRegistrationDeps extends FridaySocialImportRoutesDeps {
  /** Converter service used to stage the candidate after gate approval. */
  readonly converterService: FridaySkillConverterService | null;
  /** Canonical mutation gate used to evaluate the stage-candidate request. */
  readonly canonicalMutationGate: FridayMutatingActionGate | null;
  /**
   * Test-oracle only: allow the legacy TypeScript social-import mutation
   * (prepareStageContext XHS browser extraction -> canonical approval ->
   * converterService.import candidate staging). Production/runtime callers must
   * leave this unset so the route fail-closes (503 TS_RUNTIME_SOCIAL_IMPORT_RETIRED)
   * until Rust owns social import. The guard is HOISTED above prepareStageContext
   * so NO XHS browser extraction / egress occurs when retired.
   */
  readonly allowTestOnlySocialImportExecution?: boolean;
}

/**
 * TS-runtime retirement guard for the social-import mutation. Placed AFTER the
 * availability check + body parse and IMMEDIATELY BEFORE prepareStageContext
 * (the XHS browser extraction / egress) so that when retired NOTHING is
 * extracted or staged. Tradeoff (accepted): an unapproved request gets this
 * 503 rather than the downstream canonical-approval 403 — but "retired" is the
 * correct response for a retired route regardless of approval state, and this
 * keeps the egress from running.
 */
function assertSocialImportTestOracleAllowed(deps: { allowTestOnlySocialImportExecution?: boolean }): void {
  if (deps.allowTestOnlySocialImportExecution === true) {
    return;
  }
  throw new FridayDomainError(
    "TS_RUNTIME_SOCIAL_IMPORT_RETIRED",
    "Social skill import is fail-closed in the default/live runtime; the Rust-owned social-import entrypoint is required.",
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_social_import_entrypoint_required",
      },
    },
  );
}

// ─── Defaults ───

const DEFAULT_DISABLED_MESSAGE =
  "Social-import is disabled in this runtime; XHS browser deps, the converter service, or the canonical mutation gate are unavailable.";
const SURFACE = "api:/v1/skills/social-import";

// ─── Factory ───

export function createFridaySocialImportRoutes(
  deps: FridaySocialImportRoutesRegistrationDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  function disabledMessage(): string {
    return deps.disabledReason && deps.disabledReason.trim().length > 0
      ? deps.disabledReason
      : DEFAULT_DISABLED_MESSAGE;
  }

  function throwDisabled(): never {
    throw new FridayDomainError(
      "SOCIAL_IMPORT_DISABLED",
      disabledMessage(),
      { httpStatus: 503 },
    );
  }

  return [
    {
      operationId: "skills.social.import",
      method: "POST",
      path: "/v1/skills/social-import",
      auth: { public: true },
      async handler(ctx): Promise<FridaySocialImportSuccessResponse> {
        if (!deps.service || !deps.converterService || !deps.canonicalMutationGate) {
          throwDisabled();
        }
        const request = parseSocialImportBody(ctx.body);
        const actorPrincipalId = ctx.principal?.principalId ?? "public:default";
        const actorPrincipalKind = ctx.principal?.principalType ?? "api";

        // TS-runtime retirement: fail-close BEFORE prepareStageContext so the XHS
        // browser extraction / egress never runs in default/live.
        assertSocialImportTestOracleAllowed(deps);

        // 1. Pre-staging: URL allowlist, session check, real-browser
        //    extraction, source provenance, social-aware planDigest.
        const context = await deps.service.prepareStageContext({
          request,
          actorPrincipalId,
          actorPrincipalKind,
          surface: SURFACE,
        });

        // 2. Build the canonical stage-candidate mutation request and
        //    evaluate the gate. The caller's `canonicalApproval` resolution
        //    must clear the gate; otherwise the gate returns
        //    `requires_approval` and we throw 403 with the standard shape.
        const stageRequest = createFridaySkillStageMutatingActionRequest({
          source: context.source,
          formatHint: "code-repo",
          actor: {
            kind: actorPrincipalKind,
            id: actorPrincipalId,
            principalId: actorPrincipalId,
          },
          surface: SURFACE,
          idempotencyKey: request.idempotencyKey,
          planDigest: context.planDigest,
          canonicalApproval: request.canonicalApproval,
        });
        const gateResult = deps.canonicalMutationGate.evaluate(stageRequest);
        if (gateResult.decision !== "allow" || !gateResult.ticket) {
          const code =
            gateResult.decision === "requires_approval"
              ? "CANONICAL_APPROVAL_REQUIRED"
              : "CANONICAL_APPROVAL_DENIED";
          const message =
            gateResult.decision === "requires_approval"
              ? "Social-import candidate staging requires canonical approval before any candidate is written."
              : `Social-import candidate staging was blocked by the canonical approval gate: ${gateResult.reason}`;
          throw new FridayDomainError(code, message, {
            httpStatus: 403,
            details: {
              canonicalGate: gateResult.evidenceRecord,
              planDigest: context.planDigest,
              redactedSocialUri: context.redactedSocialUri,
              redactedTargetUri: context.redactedTargetUri,
              socialDomain: "xiaohongshu.com" as const,
              extraction: context.extraction,
            },
          });
        }
        const ticket = gateResult.ticket;

        // 3. Stage the candidate through the existing converter service. The
        //    converter handles validation, file writes, redacted source
        //    provenance, and the candidate approval proof.
        const importResult = await deps.converterService.import({
          source: context.source,
          formatHint: "code-repo",
          canonicalApprovalTicket: ticket,
        });
        const candidate = importResult.candidates[0];
        if (!candidate) {
          throw new FridayDomainError(
            "SOCIAL_IMPORT_CANDIDATE_MISSING",
            "Converter import did not produce a candidate; the slice cannot complete.",
            { httpStatus: 500 },
          );
        }

        // 4. Build the response. NextSteps lists the existing routes the user
        //    (or operator) drives separately to finish the module_01 loop —
        //    autonomy shadow / canary / promote / verify. The slice does NOT
        //    call those routes itself; it also does NOT emit a learning
        //    event (Stage 2 option 4b).
        return {
          ok: true,
          candidateId: candidate.candidateId,
          skillId: candidate.skillId,
          socialDomain: "xiaohongshu.com",
          redactedSocialUri: context.redactedSocialUri,
          redactedTargetUri: context.redactedTargetUri,
          sourceProvenanceDigest: context.sourceProvenanceDigest,
          extraction: context.extraction,
          ticketId: ticket.ticketId,
          planDigest: context.planDigest,
          stagedAt: candidate.stagedAt,
          nextSteps: [...FRIDAY_SOCIAL_IMPORT_DEFAULT_NEXT_STEPS],
        };
      },
    },
  ];
}

// ─── Body parsing ───

function parseSocialImportBody(raw: unknown): FridaySocialImportRequest {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Request body must be a JSON object.",
      { httpStatus: 400 },
    );
  }
  const obj = raw as Record<string, unknown>;
  const socialUrl = obj.socialUrl;
  if (typeof socialUrl !== "string" || socialUrl.trim().length === 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "`socialUrl` is required and must be a non-empty string.",
      { httpStatus: 400 },
    );
  }
  const targetGithubRepoUrl = obj.targetGithubRepoUrl;
  if (typeof targetGithubRepoUrl !== "string" || targetGithubRepoUrl.trim().length === 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "`targetGithubRepoUrl` is required and must be a non-empty string.",
      { httpStatus: 400 },
    );
  }
  const out: { -readonly [K in keyof FridaySocialImportRequest]?: FridaySocialImportRequest[K] } = {
    socialUrl,
    targetGithubRepoUrl,
  };
  if (obj.sessionId !== undefined) {
    if (typeof obj.sessionId !== "string" || obj.sessionId.trim().length === 0) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        "`sessionId` must be a non-empty string when provided.",
        { httpStatus: 400 },
      );
    }
    out.sessionId = obj.sessionId;
  }
  if (obj.idempotencyKey !== undefined) {
    if (typeof obj.idempotencyKey !== "string") {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        "`idempotencyKey` must be a string when provided.",
        { httpStatus: 400 },
      );
    }
    out.idempotencyKey = obj.idempotencyKey;
  }
  if (obj.canonicalApproval !== undefined) {
    if (typeof obj.canonicalApproval !== "object" || obj.canonicalApproval === null) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        "`canonicalApproval` must be an object when provided.",
        { httpStatus: 400 },
      );
    }
    out.canonicalApproval = obj.canonicalApproval as FridayCanonicalApprovalResolution;
  }
  // The route DOES NOT accept a `userId` field from the body. The actor
  // principal is read from `ctx.principal.principalId` in the handler.
  return out as FridaySocialImportRequest;
}
