/**
 * Discovery Integration HTTP route.
 *
 * POST /v1/discovery/integrate - takes a program recommendation,
 * builds a contentBase64 source via the discovery integration bridge,
 * requires canonical approval, and stages a candidate through the
 * converter service. Does not auto-install or promote.
 *
 * Always registered. When discovery deps are absent the handler
 * returns 503 DISCOVERY_INTEGRATION_DISABLED.
 */

import { createHash } from "node:crypto";

import { FridayDomainError } from "#errors";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import {
  createFridaySkillStageMutatingActionRequest,
  type FridaySkillConverterService,
} from "#skills/converter";
import type {
  FridayCanonicalApprovalResolution,
  FridayMutatingActionGate,
} from "../../../security/friday-mutating-action-gate.js";
import type { FridayDiscoveryRoutesDeps } from "./friday-discovery-routes.js";
import { buildDiscoveryIntegrationSource } from "../../../skills/converter/discovery/friday-discovery-integration-bridge.js";

export interface FridayDiscoveryIntegrationRoutesDeps {
  readonly discovery: FridayDiscoveryRoutesDeps["discovery"] | null;
  readonly converterService: FridaySkillConverterService | null;
  readonly canonicalMutationGate: FridayMutatingActionGate | null;
  readonly disabledReason: string | null;
}

const SURFACE = "api:/v1/discovery/integrate";
const DEFAULT_DISABLED_MESSAGE =
  "Discovery integration is disabled; discovery service, converter service, or canonical mutation gate are unavailable.";

const LIFECYCLE_NEXT_STEPS = [
  { action: "shadow", method: "POST", path: "/v1/autonomy/skills/:skillId/shadow" },
  { action: "canary", method: "POST", path: "/v1/autonomy/skills/:skillId/canary" },
  { action: "promote", method: "POST", path: "/v1/autonomy/skills/:skillId/promote" },
  { action: "rollback", method: "POST", path: "/v1/autonomy/skills/:skillId/rollback" },
];

export function createFridayDiscoveryIntegrationRoutes(
  deps: FridayDiscoveryIntegrationRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  function throwDisabled(): never {
    throw new FridayDomainError(
      "DISCOVERY_INTEGRATION_DISABLED",
      deps.disabledReason && deps.disabledReason.trim().length > 0
        ? deps.disabledReason
        : DEFAULT_DISABLED_MESSAGE,
      { httpStatus: 503 },
    );
  }

  return [
    {
      operationId: "discovery.integrate",
      method: "POST",
      path: "/v1/discovery/integrate",
      auth: { public: true },
      async handler(ctx) {
        if (!deps.discovery || !deps.converterService || !deps.canonicalMutationGate) {
          throwDisabled();
        }

        const body = parseIntegrationBody(ctx.body);
        const actorPrincipalId = ctx.principal?.principalId ?? "public:default";
        const actorPrincipalKind = ctx.principal?.principalType ?? "api";

        const catalog = deps.discovery.getCachedCatalog();
        if (!catalog) {
          throw new FridayDomainError(
            "CATALOG_NOT_AVAILABLE",
            "No catalog available - run POST /v1/discovery/scan first.",
            { httpStatus: 404 },
          );
        }

        const program = catalog.programs.find((p) => p.id === body.programId);
        if (!program) {
          throw new FridayDomainError(
            "PROGRAM_NOT_FOUND",
            `Program not found in catalog: ${redactRequestProgramId(body.programId)}`,
            { httpStatus: 404 },
          );
        }

        const recommendations = await deps.discovery.recommend({ category: program.category });
        const recommendation = recommendations.recommendations.find(
          (r) => r.programId === body.programId,
        );
        if (!recommendation) {
          throw new FridayDomainError(
            "RECOMMENDATION_NOT_FOUND",
            `No recommendation available for program: ${redactRequestProgramId(body.programId)}`,
            { httpStatus: 404 },
          );
        }

        const bridgeResult = buildDiscoveryIntegrationSource({ program, recommendation });

        const stageRequest = createFridaySkillStageMutatingActionRequest({
          source: bridgeResult.source,
          formatHint: "friday-package",
          actor: {
            kind: actorPrincipalKind,
            id: actorPrincipalId,
            principalId: actorPrincipalId,
          },
          surface: SURFACE,
          idempotencyKey: body.idempotencyKey,
          planDigest: body.planDigest,
          canonicalApproval: body.canonicalApproval,
        });

        const gateResult = deps.canonicalMutationGate.evaluate(stageRequest);
        if (gateResult.decision !== "allow" || !gateResult.ticket) {
          const code =
            gateResult.decision === "requires_approval"
              ? "CANONICAL_APPROVAL_REQUIRED"
              : "CANONICAL_APPROVAL_DENIED";
          const message =
            gateResult.decision === "requires_approval"
              ? "Discovery integration candidate staging requires canonical approval."
              : `Discovery integration candidate staging was blocked: ${gateResult.reason}`;
          throw new FridayDomainError(code, message, {
            httpStatus: 403,
            details: {
              canonicalGate: gateResult.evidenceRecord,
              programId: redactRequestProgramId(body.programId),
              integrationPath: recommendation.integrationPath,
            },
          });
        }

        const importResult = await deps.converterService.import({
          source: bridgeResult.source,
          formatHint: "friday-package",
          canonicalApprovalTicket: gateResult.ticket,
        });

        const candidate = importResult.candidates[0];
        if (!candidate) {
          throw new FridayDomainError(
            "DISCOVERY_INTEGRATION_CANDIDATE_MISSING",
            "Converter import did not produce a candidate.",
            { httpStatus: 500 },
          );
        }

        return {
          ok: true,
          candidateId: candidate.candidateId,
          skillId: candidate.skillId,
          programId: bridgeResult.redactedProgramId,
          programName: bridgeResult.redactedProgramName,
          integrationPath: recommendation.integrationPath,
          sourceProvenanceDigest: candidate.sourceProvenance.sourceDigest,
          ticketId: gateResult.ticket.ticketId,
          stagedAt: candidate.stagedAt,
          nextSteps: LIFECYCLE_NEXT_STEPS,
        };
      },
    },
  ];
}

interface DiscoveryIntegrationRequestBody {
  programId: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
  idempotencyKey?: string;
  planDigest?: string;
}

function parseIntegrationBody(raw: unknown): DiscoveryIntegrationRequestBody {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Request body must be a JSON object.",
      { httpStatus: 400 },
    );
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.programId !== "string" || obj.programId.trim().length === 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "`programId` is required and must be a non-empty string.",
      { httpStatus: 400 },
    );
  }

  return {
    programId: obj.programId,
    canonicalApproval: obj.canonicalApproval as FridayCanonicalApprovalResolution | undefined,
    idempotencyKey: typeof obj.idempotencyKey === "string" ? obj.idempotencyKey : undefined,
    planDigest: typeof obj.planDigest === "string" ? obj.planDigest : undefined,
  };
}

function redactRequestProgramId(programId: string): string {
  if (programId.includes("/") || programId.includes("\\")) {
    return `local-${createHash("sha256").update(programId).digest("hex").slice(0, 16)}`;
  }
  return programId;
}
