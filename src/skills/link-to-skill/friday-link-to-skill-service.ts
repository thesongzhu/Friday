import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import { FridayDomainError } from "#errors";
import type {
  FridayLinkSummary,
  FridayLinkUnderstandingService,
} from "#link-understanding";
import {
  createFridayAgentSsrfGuard,
  FridaySsrfBlockedError,
} from "../../agent/security/friday-agent-ssrf-guard.js";
import type {
  FridayCanonicalApprovalResolution,
  FridayMutatingActionActor,
  FridayMutatingActionGate,
  FridayMutatingActionTicket,
} from "../../security/friday-mutating-action-gate.js";
import type {
  FridaySkillConversionSource,
  FridaySkillConverterService,
  FridaySkillImportOutput,
} from "../converter/index.js";
import {
  createFridaySkillStageMutatingActionRequest,
  FRIDAY_LINK_EVIDENCE_SKILL_PAYLOAD_SCHEMA,
  type FridayLinkEvidenceSkillPayload,
  redactFridaySkillCandidateSourceUri,
} from "../converter/index.js";

export interface FridayLinkToSkillSourceBuildInput {
  readonly evidence: FridayLinkSummary;
  readonly skillId?: string;
  readonly skillName?: string;
  readonly skillDescription?: string;
  readonly skillVersion?: string;
}

export interface FridayLinkToSkillSourceBuildResult {
  readonly source: FridaySkillConversionSource;
  readonly payload: FridayLinkEvidenceSkillPayload;
}

export interface FridayLinkToSkillStageInput {
  readonly text: string;
  readonly canonicalApprovalTicket?: FridayMutatingActionTicket;
  readonly actor?: FridayMutatingActionActor;
  readonly surface?: string;
  readonly idempotencyKey?: string;
  readonly planDigest?: string;
  readonly canonicalApproval?: FridayCanonicalApprovalResolution;
  readonly skillId?: string;
  readonly skillName?: string;
  readonly skillDescription?: string;
  readonly skillVersion?: string;
}

export interface FridayLinkToSkillStageResult {
  readonly evidence: FridayLinkSummary;
  readonly source: FridaySkillConversionSource;
  readonly importResult: FridaySkillImportOutput;
}

export interface FridayLinkToSkillService {
  stageFromText(input: FridayLinkToSkillStageInput): Promise<FridayLinkToSkillStageResult>;
}

export interface CreateFridayLinkToSkillServiceDeps {
  readonly linkUnderstanding: Pick<FridayLinkUnderstandingService, "processText">;
  readonly converterService: FridaySkillConverterService;
  readonly canonicalMutationGate?: FridayMutatingActionGate;
}

const linkToSkillSsrfGuard = createFridayAgentSsrfGuard();

export function createFridayLinkToSkillService(
  deps: CreateFridayLinkToSkillServiceDeps,
): FridayLinkToSkillService {
  return {
    async stageFromText(input) {
      const summaries = await deps.linkUnderstanding.processText(input.text);
      const evidence = summaries[0];
      if (!evidence) {
        throw new FridayDomainError(
          "LINK_TO_SKILL_NO_LINK_EVIDENCE",
          "No fetchable link evidence was found to generate a skill candidate.",
          { httpStatus: 422 },
        );
      }

      const built = buildFridayLinkToSkillCandidateSource({
        evidence,
        skillId: input.skillId,
        skillName: input.skillName,
        skillDescription: input.skillDescription,
        skillVersion: input.skillVersion,
      });
      const canonicalApprovalTicket = input.canonicalApprovalTicket ?? assertCanonicalStageTicket({
        deps,
        source: built.source,
        actor: input.actor,
        surface: input.surface,
        idempotencyKey: input.idempotencyKey,
        planDigest: input.planDigest,
        canonicalApproval: input.canonicalApproval,
      });
      const importResult = await deps.converterService.import({
        source: built.source,
        formatHint: "auto",
        canonicalApprovalTicket,
      });

      return {
        evidence,
        source: built.source,
        importResult,
      };
    },
  };
}

function assertCanonicalStageTicket(input: {
  deps: CreateFridayLinkToSkillServiceDeps;
  source: FridaySkillConversionSource;
  actor?: FridayMutatingActionActor;
  surface?: string;
  idempotencyKey?: string;
  planDigest?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}): FridayMutatingActionTicket {
  if (!input.deps.canonicalMutationGate) {
    throw new FridayDomainError(
      "LINK_TO_SKILL_CANONICAL_GATE_UNAVAILABLE",
      "Link-to-skill candidate generation requires the canonical approval gate.",
      { httpStatus: 503 },
    );
  }

  const actor = input.actor ?? {
    kind: "api",
    id: "api:link-to-skill",
    principalId: "api:link-to-skill",
  };
  const gateResult = input.deps.canonicalMutationGate.evaluate(
    createFridaySkillStageMutatingActionRequest({
      source: input.source,
      formatHint: "auto",
      actor,
      surface: input.surface ?? "api:link-to-skill",
      idempotencyKey: input.idempotencyKey,
      planDigest: input.planDigest,
      canonicalApproval: input.canonicalApproval,
    }),
  );

  if (gateResult.decision !== "allow" || !gateResult.ticket) {
    throw new FridayDomainError(
      gateResult.decision === "requires_approval"
        ? "CANONICAL_APPROVAL_REQUIRED"
        : "CANONICAL_APPROVAL_DENIED",
      gateResult.decision === "requires_approval"
        ? "Link-to-skill candidate generation requires canonical approval before any candidate is written."
        : `Link-to-skill candidate generation was blocked by the canonical approval gate: ${gateResult.reason}`,
      {
        httpStatus: 403,
        details: { canonicalGate: gateResult.evidenceRecord },
      },
    );
  }
  return gateResult.ticket;
}

export function buildFridayLinkToSkillCandidateSource(
  input: FridayLinkToSkillSourceBuildInput,
): FridayLinkToSkillSourceBuildResult {
  assertPublicLinkEvidenceUrl(input.evidence.url);
  const sourceDigest = hashString(input.evidence.url);
  const defaultSkillId = `link-skill-${sourceDigest.slice(0, 16)}`;
  const skillId = safePayloadIdentifier(input.skillId ?? defaultSkillId);
  const title = cleanOptionalText(input.evidence.title, 120);
  const skillName = cleanText(
    input.skillName ?? title ?? `Link skill ${sourceDigest.slice(0, 8)}`,
    96,
  );
  const summary = cleanText(input.evidence.summary, 2_000);
  const skillDescription = cleanText(
    input.skillDescription ?? `Generated from extracted link evidence: ${summary}`,
    240,
  );

  const payload: FridayLinkEvidenceSkillPayload = {
    $schema: FRIDAY_LINK_EVIDENCE_SKILL_PAYLOAD_SCHEMA,
    sourceDigest,
    redactedUrl: redactFridaySkillCandidateSourceUri(input.evidence.url),
    title,
    summary,
    contentType: cleanOptionalText(input.evidence.contentType, 120),
    skillId,
    skillName,
    skillDescription,
    skillVersion: input.skillVersion ?? "1.0.0",
  };

  return {
    source: {
      contentBase64: Buffer.from(JSON.stringify(payload)).toString("base64"),
      formatHint: "friday-package",
    },
    payload,
  };
}

function assertPublicLinkEvidenceUrl(url: string): void {
  try {
    linkToSkillSsrfGuard.validate(url);
  } catch (err) {
    if (err instanceof FridaySsrfBlockedError) {
      throw new FridayDomainError(
        "LINK_TO_SKILL_URL_BLOCKED",
        "Link-to-skill evidence URL points to a private/local address and cannot be used for skill candidate generation.",
        { httpStatus: 422 },
      );
    }
    throw err;
  }
}

function safePayloadIdentifier(value: string): string {
  const normalized = value.trim().toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (normalized.length === 0) {
    throw new FridayDomainError(
      "LINK_TO_SKILL_INVALID_SKILL_ID",
      "Link-to-skill generated an empty skill id.",
      { httpStatus: 422 },
    );
  }
  return normalized;
}

function cleanText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    throw new FridayDomainError(
      "LINK_TO_SKILL_EMPTY_EVIDENCE",
      "Link-to-skill evidence text is empty.",
      { httpStatus: 422 },
    );
  }
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function cleanOptionalText(value: string | null, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
