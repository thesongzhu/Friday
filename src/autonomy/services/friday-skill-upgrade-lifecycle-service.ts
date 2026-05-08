import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import { resolveSafePath, safeDirName } from "#utilities";
import {
  createFridayMutatingActionDigest,
  type FridayCanonicalApprovalResolution,
  type FridayMutatingActionActor,
  type FridayMutatingActionGate,
  type FridayMutatingActionRequest,
  type FridayMutatingActionRollbackScope,
  type FridayMutatingActionTicket,
} from "../../security/friday-mutating-action-gate.js";
import { redactContext } from "../../rules/engine/context-redactor.js";
import type { JsonObject } from "../../rules/model/friday-rules-engine.types.js";
import type { FridaySkillExecutor, SkillLifecycleStatus } from "#skills";
import { loadFridaySkillPackage } from "../../skills/manifest/friday-skill-package-loader.js";
import { validateFridaySkillPackage } from "../../skills/validation/friday-skill-validation-pipeline.js";
import type { FridayExternalSkillCandidate } from "../../skills/converter/services/friday-skill-candidate-store.js";
import type { FridaySkillRepository } from "../../skills/persistence/friday-skill-repository.js";
import type { FridayAutonomyCanaryStats } from "../model/friday-autonomy-upgrade.types.js";
import type { FridaySkillEntity } from "../../skills/model/friday-skill-catalog.types.js";
import type { SkillManifestV2 } from "../../skills/model/friday-skill-manifest-v2.types.js";

type FridaySkillLifecycleAction = "shadow" | "canary" | "promote" | "rollback";

export interface FridaySkillLifecycleApprovalRequestInput {
  action: FridaySkillLifecycleAction;
  skillId: string;
  candidateId?: string;
  shadowVersionId?: string;
  runtimeVersion: string;
  providerModel?: string;
  actor: FridayMutatingActionActor;
  surface: string;
  planDigest?: string;
  idempotencyKey?: string;
  rollback?: FridayMutatingActionRollbackScope;
  canaryInputDigest?: string;
}

export interface FridaySkillLifecycleEvidenceSummary {
  candidateId: string;
  artifactDigest?: string;
  stage: "shadow" | "canary" | "active" | "rolled_back";
  lastEventAt: string;
  canarySuccessCount: number;
  canaryFailureCount: number;
  rollbackPointerAvailable: boolean;
}

export interface FridaySkillUpgradeLifecycleService {
  registerShadowVersion(input: {
    skillId: string;
    candidateId: string;
    shadowVersionId?: string;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest?: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): Promise<FridaySkillEntity>;
  recordCanaryResult(input: {
    skillId: string;
    candidateId: string;
    runtimeVersion: string;
    providerModel?: string;
    canaryInput?: Record<string, unknown>;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest?: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): Promise<FridaySkillEntity>;
  promote(input: {
    skillId: string;
    candidateId: string;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): Promise<FridaySkillEntity>;
  rollback(input: {
    skillId: string;
    candidateId: string;
    runtimeVersion: string;
    providerModel?: string;
    reason?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): Promise<FridaySkillEntity>;
  getLifecycleEvidence(input: { skillId: string; candidateId: string }): FridaySkillLifecycleEvidenceSummary | null;
}

export interface CreateFridaySkillUpgradeLifecycleServiceDeps {
  db: FridaySqliteLayer;
  skillRepo: FridaySkillRepository;
  nowIso: () => string;
  managedSkillsDir?: string;
  resolveCandidate?: (input: { skillId: string; candidateId: string }) => FridayExternalSkillCandidate | null;
  skillExecutor?: FridaySkillExecutor;
  canonicalMutationGate?: FridayMutatingActionGate;
  refreshRegistry?: () => Promise<void> | void;
  updateSkillStatus?: (skillId: string, status: SkillLifecycleStatus) => Promise<void> | void;
}

interface SkillLifecycleEvidenceRecord {
  schemaVersion: "friday.skill.lifecycle.phase3.2A.v1";
  skillId: string;
  candidateId: string;
  events: Array<Record<string, unknown>>;
	  shadow?: {
	    candidateId: string;
	    shadowVersionId: string;
	    shadowWindowId: string;
	    shadowDir: string;
	    artifactDigest: string;
	    sourceProvenance: FridayExternalSkillCandidate["sourceProvenance"];
    stagedAt: string;
    shadowedAt: string;
    ticketId: string;
    actionDigest: string;
    planDigest?: string;
    previous: RollbackPointer;
  };
  canaryRuns: Array<{
    runId: string;
    status: string;
    success: boolean;
    artifactDigest: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    stdout: string;
	    stderr: string;
	    ticketId: string;
	    actionDigest: string;
	    planDigest?: string;
	    shadowWindowId?: string;
	  }>;
  promotion?: {
    promotedAt: string;
    artifactDigest: string;
    activeDir: string;
    rollbackDir: string;
    ticketId: string;
    actionDigest: string;
    planDigest: string;
  };
  rollback?: {
    rolledBackAt: string;
    fromDigest?: string;
    toDigest?: string;
    reason?: string;
    result: "restored_previous" | "cleared_active";
    ticketId: string;
    actionDigest: string;
    planDigest: string;
  };
}

interface RollbackPointer {
  activeDir: string;
  activeExists: boolean;
  activeDigest?: string;
  installedVersion?: string;
  status: SkillLifecycleStatus;
  currentManifest?: FridaySkillEntity["currentManifest"];
}

export function createFridaySkillLifecycleMutatingActionRequest(
  input: FridaySkillLifecycleApprovalRequestInput,
): FridayMutatingActionRequest {
  const candidateId = input.candidateId ?? input.shadowVersionId;
  const parameters = {
    skillId: input.skillId,
    candidateId,
    shadowVersionId: input.shadowVersionId,
    runtimeVersion: input.runtimeVersion,
    providerModel: input.providerModel,
    ...(input.action === "canary" ? { canaryInputDigest: input.canaryInputDigest } : {}),
  };
  return {
    action: `skills.lifecycle.${input.action}`,
    actor: input.actor,
    surface: input.surface,
    resource: {
      type: "external_skill_lifecycle",
      id: input.skillId,
      digest: hashStableJson(parameters),
      attributes: {
        skillId: input.skillId,
        candidateId,
        lifecycleAction: input.action,
        ...(input.action === "canary" ? { canaryInputDigest: input.canaryInputDigest } : {}),
      },
    },
    mutating: true,
    risk: "high",
    parameters,
    planDigest: input.planDigest,
    rollback: input.rollback,
    idempotencyKey: input.idempotencyKey,
    localClaims: [
      {
        guardId: "external_skill_lifecycle_guard",
        decision: "requires_approval",
        risk: "high",
        reason: `external_skill_${input.action}_requires_canonical_approval`,
      },
    ],
  };
}

export function createFridaySkillUpgradeLifecycleService(
  deps: CreateFridaySkillUpgradeLifecycleServiceDeps,
): FridaySkillUpgradeLifecycleService {
  function getSkill(skillId: string): FridaySkillEntity {
    const skill = deps.db.withReadConnection((db) => deps.skillRepo.getSkillById(db, skillId));
    if (!skill) {
      throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${skillId}" not found`, { httpStatus: 404 });
    }
    return skill;
  }

  function updateSkill(
    skillId: string,
    patch: Parameters<FridaySkillRepository["setUpgradeMetadata"]>[2],
  ): FridaySkillEntity {
    return deps.db.withWriteTransaction((db) => {
      const updated = deps.skillRepo.setUpgradeMetadata(db, skillId, patch, deps.nowIso());
      if (!updated) {
        throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${skillId}" not found`, { httpStatus: 404 });
      }
      return updated;
    });
  }

  function updateCanaryStats(skillId: string, success: boolean, evaluatedAt: string): FridaySkillEntity {
    const skill = getSkill(skillId);
    const current = skill.canaryStats ?? emptyCanaryStats();
    return updateSkill(skillId, {
      compatibilityStatus: success ? "compatible" : "adaptation_required",
      promotionChannel: "canary",
      canaryStats: {
        sampleSize: current.sampleSize + 1,
        successCount: current.successCount + (success ? 1 : 0),
        failureCount: current.failureCount + (success ? 0 : 1),
        rollbackCount: current.rollbackCount,
        lastEvaluatedAt: evaluatedAt,
      },
    });
  }

  function requireExternalLifecycleDeps(): { managedSkillsDir: string } {
    if (!deps.managedSkillsDir) {
      throw new FridayDomainError(
        "SKILL_LIFECYCLE_MANAGED_DIR_UNAVAILABLE",
        "External skill lifecycle requires a managed skills directory.",
        { httpStatus: 503 },
      );
    }
    if (!deps.resolveCandidate) {
      throw new FridayDomainError(
        "SKILL_LIFECYCLE_CANDIDATE_STORE_UNAVAILABLE",
        "External skill lifecycle requires the staged candidate store.",
        { httpStatus: 503 },
      );
    }
    return { managedSkillsDir: deps.managedSkillsDir };
  }

  function requireCandidate(skillId: string, candidateId: string): FridayExternalSkillCandidate {
    requireExternalLifecycleDeps();
    const candidate = deps.resolveCandidate!({ skillId, candidateId });
    if (!candidate) {
      throw new FridayDomainError(
        "SKILL_CANDIDATE_NOT_FOUND",
        `Skill candidate "${candidateId}" not found for skill "${skillId}".`,
        { httpStatus: 404, details: { skillId, candidateId } },
      );
    }
    if (!candidate.validation.ok) {
      throw new FridayDomainError(
        "SKILL_CANDIDATE_VALIDATION_FAILED",
        `Skill candidate "${candidateId}" cannot enter lifecycle because validation failed.`,
        { httpStatus: 422, details: { skillId, candidateId, issues: candidate.validation.issues } },
      );
    }
    return candidate;
  }

  function requireCanonicalLifecycleTicket(input: {
    action: FridaySkillLifecycleAction;
    skillId: string;
    candidateId: string;
    shadowVersionId?: string;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest?: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
    rollback?: FridayMutatingActionRollbackScope;
    requirePlanDigest?: boolean;
    canaryInputDigest?: string;
  }): FridayMutatingActionTicket {
    if (!deps.canonicalMutationGate) {
      throw new FridayDomainError(
        "SKILL_LIFECYCLE_CANONICAL_GATE_UNAVAILABLE",
        "Skill lifecycle actions require the canonical approval gate.",
        { httpStatus: 503 },
      );
    }
    if (input.requirePlanDigest && !input.planDigest) {
      throw new FridayDomainError(
        "SKILL_LIFECYCLE_PLAN_DIGEST_REQUIRED",
        "Skill lifecycle promote and rollback require an approved plan digest.",
        { httpStatus: 403, details: { skillId: input.skillId, candidateId: input.candidateId } },
      );
    }

    const request = createFridaySkillLifecycleMutatingActionRequest({
      action: input.action,
      skillId: input.skillId,
      candidateId: input.candidateId,
      shadowVersionId: input.shadowVersionId,
      runtimeVersion: input.runtimeVersion,
      providerModel: input.providerModel,
      actor: input.actor,
      surface: input.surface,
      planDigest: input.planDigest,
      idempotencyKey: input.idempotencyKey,
      rollback: input.rollback,
      canaryInputDigest: input.canaryInputDigest,
    });
    const gateResult = deps.canonicalMutationGate.evaluate({
      ...request,
      canonicalApproval: input.canonicalApproval,
    });
    if (gateResult.decision !== "allow" || !gateResult.ticket) {
      throw new FridayDomainError(
        gateResult.decision === "requires_approval"
          ? "CANONICAL_APPROVAL_REQUIRED"
          : "CANONICAL_APPROVAL_DENIED",
        gateResult.decision === "requires_approval"
          ? `Skill lifecycle ${input.action} requires canonical approval before any mutation.`
          : `Skill lifecycle ${input.action} was blocked by the canonical approval gate: ${gateResult.reason}`,
        {
          httpStatus: 403,
          details: {
            canonicalGate: gateResult.evidenceRecord,
            actionDigest: createFridayMutatingActionDigest(request),
          },
        },
      );
    }
    return gateResult.ticket;
  }

  function pathsFor(skillId: string, candidateId: string): {
    managedSkillsDir: string;
    activeDir: string;
    shadowDir: string;
    rollbackDir: string;
    evidencePath: string;
  } {
    const { managedSkillsDir } = requireExternalLifecycleDeps();
    const safeSkillId = safeDirName(skillId);
    const safeCandidateId = safeDirName(candidateId);
    return {
      managedSkillsDir,
      activeDir: resolveSafePath(managedSkillsDir, safeSkillId),
      shadowDir: resolveSafePath(managedSkillsDir, join(".shadow", safeSkillId, safeCandidateId)),
      rollbackDir: resolveSafePath(managedSkillsDir, join(".rollback", safeSkillId, safeCandidateId, "previous")),
      evidencePath: resolveSafePath(managedSkillsDir, join(".lifecycle", safeSkillId, `${safeCandidateId}.json`)),
    };
  }

  function readEvidence(skillId: string, candidateId: string): SkillLifecycleEvidenceRecord {
    const { evidencePath } = pathsFor(skillId, candidateId);
    if (!existsSync(evidencePath)) {
      return {
        schemaVersion: "friday.skill.lifecycle.phase3.2A.v1",
        skillId,
        candidateId,
        events: [],
        canaryRuns: [],
      };
    }
    const parsed = JSON.parse(readFileSync(evidencePath, "utf8")) as SkillLifecycleEvidenceRecord;
    return {
      ...parsed,
      events: Array.isArray(parsed.events) ? parsed.events : [],
      canaryRuns: Array.isArray(parsed.canaryRuns) ? parsed.canaryRuns : [],
    };
  }

  function writeEvidence(record: SkillLifecycleEvidenceRecord): void {
    const { evidencePath } = pathsFor(record.skillId, record.candidateId);
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  async function refreshRuntimeStatus(skillId: string, status: SkillLifecycleStatus): Promise<void> {
    await deps.updateSkillStatus?.(skillId, status);
    await deps.refreshRegistry?.();
  }

  function loadShadowManifest(skillId: string, candidateId: string): SkillManifestV2 {
    const { shadowDir } = pathsFor(skillId, candidateId);
    const loaded = loadFridaySkillPackage({ skillDir: shadowDir, workspaceDir: shadowDir });
    if (!loaded.ok) {
      throw new FridayDomainError(
        "SKILL_LIFECYCLE_SHADOW_LOAD_FAILED",
        loaded.error.message,
        { httpStatus: 422, details: { skillId, candidateId } },
      );
    }
    const validation = validateFridaySkillPackage({
      loaded: loaded.value,
      workspaceDir: shadowDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
    });
    if (!validation.ok) {
      throw new FridayDomainError(
        "SKILL_LIFECYCLE_SHADOW_VALIDATION_FAILED",
        "Shadow artifact validation failed.",
        { httpStatus: 422, details: { skillId, candidateId, issues: validation.issues } },
      );
    }
    return loaded.value.manifest;
  }

  return {
    async registerShadowVersion(input) {
      const candidate = requireCandidate(input.skillId, input.candidateId);
      const shadowVersionId = input.shadowVersionId ?? candidate.shadowVersionId;
      const ticket = requireCanonicalLifecycleTicket({
        action: "shadow",
        skillId: input.skillId,
        candidateId: candidate.candidateId,
        shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
      });
      const skill = getSkill(input.skillId);
      const { activeDir, shadowDir } = pathsFor(input.skillId, candidate.candidateId);

      rmSync(shadowDir, { recursive: true, force: true });
      mkdirSync(dirname(shadowDir), { recursive: true });
      cpSync(candidate.filesDir, shadowDir, { recursive: true });
      const artifactDigest = hashDirectory(shadowDir);
      const previous: RollbackPointer = {
        activeDir,
        activeExists: existsSync(activeDir),
        activeDigest: existsSync(activeDir) ? hashDirectory(activeDir) : undefined,
        installedVersion: skill.installedVersion,
        status: skill.status,
        currentManifest: skill.currentManifest,
      };

      const record = readEvidence(input.skillId, candidate.candidateId);
      record.canaryRuns = [];
      delete record.promotion;
      delete record.rollback;
	      const shadowEventIndex = record.events.length;
	      const shadowedAt = deps.nowIso();
	      const shadowWindowId = createShadowWindowId({
	        skillId: input.skillId,
	        candidateId: candidate.candidateId,
	        shadowVersionId,
	        artifactDigest,
	        ticketId: ticket.ticketId,
	        actionDigest: ticket.actionDigest,
	        eventIndex: shadowEventIndex,
	      });
	      record.shadow = {
	        candidateId: candidate.candidateId,
	        shadowVersionId,
	        shadowWindowId,
	        shadowDir,
	        artifactDigest,
	        sourceProvenance: candidate.sourceProvenance,
	        stagedAt: candidate.stagedAt,
	        shadowedAt,
	        ticketId: ticket.ticketId,
	        actionDigest: ticket.actionDigest,
	        planDigest: ticket.planDigest,
        previous,
      };
      record.events.push({
        type: "shadow",
	        at: record.shadow.shadowedAt,
	        artifactDigest,
	        shadowWindowId,
	        ticketId: ticket.ticketId,
	        planDigest: ticket.planDigest,
	      });
      writeEvidence(record);

      const updated = updateSkill(input.skillId, {
        compatibilityStatus: "adaptation_required",
        promotionChannel: "shadow",
        shadowVersionId,
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
      await refreshRuntimeStatus(input.skillId, "not_installed");
      return updated;
    },

    async recordCanaryResult(input) {
      if (!deps.skillExecutor) {
        throw new FridayDomainError(
          "SKILL_LIFECYCLE_CANARY_EXECUTOR_UNAVAILABLE",
          "Skill lifecycle canary requires the skill executor.",
          { httpStatus: 503 },
        );
      }
      const candidate = requireCandidate(input.skillId, input.candidateId);
      const record = readEvidence(input.skillId, candidate.candidateId);
      if (!record.shadow || !existsSync(record.shadow.shadowDir)) {
        throw new FridayDomainError(
          "SKILL_LIFECYCLE_SHADOW_REQUIRED",
          "Skill lifecycle canary requires a real shadow artifact first.",
          { httpStatus: 409, details: { skillId: input.skillId, candidateId: candidate.candidateId } },
        );
      }
      const canaryInput = input.canaryInput ?? {};
      const canaryInputDigest = createFridaySkillLifecycleCanaryInputDigest(canaryInput);
      const shadowDigestBefore = hashDirectory(record.shadow.shadowDir);
      if (shadowDigestBefore !== record.shadow.artifactDigest) {
        const ticket = requireCanonicalLifecycleTicket({
          action: "canary",
          skillId: input.skillId,
          candidateId: candidate.candidateId,
          shadowVersionId: candidate.shadowVersionId,
          runtimeVersion: input.runtimeVersion,
          providerModel: input.providerModel,
          actor: input.actor,
          surface: input.surface,
          planDigest: input.planDigest,
          idempotencyKey: input.idempotencyKey,
          canonicalApproval: input.canonicalApproval,
          canaryInputDigest,
        });
        const rejectedAt = deps.nowIso();
        record.canaryRuns.push({
          runId: `rejected:${ticket.ticketId}`,
          status: "artifact_digest_mismatch",
          success: false,
          artifactDigest: shadowDigestBefore,
          startedAt: rejectedAt,
          endedAt: rejectedAt,
          durationMs: 0,
          stdout: "",
          stderr: "",
          ticketId: ticket.ticketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
          shadowWindowId: record.shadow.shadowWindowId,
        });
        record.events.push({
          type: "canary_rejected",
          at: rejectedAt,
          reason: "shadow_artifact_digest_mismatch",
          expectedDigest: record.shadow.artifactDigest,
          actualDigest: shadowDigestBefore,
          shadowWindowId: record.shadow.shadowWindowId,
          ticketId: ticket.ticketId,
          planDigest: ticket.planDigest,
        });
        writeEvidence(record);
        updateCanaryStats(input.skillId, false, rejectedAt);
        throw new FridayDomainError(
          "SKILL_LIFECYCLE_SHADOW_DIGEST_MISMATCH",
          "Skill lifecycle canary refused to run because the shadow artifact digest changed.",
          { httpStatus: 409, details: { expected: record.shadow.artifactDigest, actual: shadowDigestBefore } },
        );
      }

      if (!input.canonicalApproval) {
        throw new FridayDomainError(
          "CANONICAL_APPROVAL_REQUIRED",
          "Skill lifecycle canary requires canonical approval before execution.",
          { httpStatus: 403, details: { skillId: input.skillId, candidateId: candidate.candidateId } },
        );
      }
      const canonicalApprovalRequest = createFridaySkillLifecycleMutatingActionRequest({
        action: "canary",
        skillId: input.skillId,
        candidateId: candidate.candidateId,
        shadowVersionId: candidate.shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canaryInputDigest,
      });
      const startedAt = deps.nowIso();
      const handle = deps.skillExecutor.executeLifecycleCanary({
        skillId: input.skillId,
        input: input.canaryInput ?? {},
        sessionId: `skill-lifecycle:${input.skillId}:${candidate.candidateId}`,
        userId: input.actor.principalId ?? input.actor.id,
        channel: "skill-lifecycle",
        timeoutMs: 5_000,
        lifecycleCanary: {
          skillDir: record.shadow.shadowDir,
          artifactDigest: record.shadow.artifactDigest,
          candidateId: candidate.candidateId,
          runtimeVersion: input.runtimeVersion,
          providerModel: input.providerModel,
          canaryInputDigest,
        },
        canonicalApproval: input.canonicalApproval,
        canonicalApprovalRequest,
      });
      const result = await handle.result;
      if (!result.canonicalTicket) {
        throw new FridayDomainError(
          "SKILL_LIFECYCLE_CANARY_CANONICAL_TICKET_MISSING",
          result.stderr || "Skill lifecycle canary did not receive a canonical ticket.",
          { httpStatus: 403, details: result.output },
        );
      }
      const ticket = result.canonicalTicket;
      const endedAt = deps.nowIso();
	      const latest = readEvidence(input.skillId, candidate.candidateId);
	      if (!latest.shadow || !isSameShadowWindow(latest.shadow, record.shadow)) {
	        const ignoredAt = deps.nowIso();
	        latest.events.push({
	          type: "canary_stale_ignored",
	          at: ignoredAt,
	          runId: result.runId,
	          status: result.status,
	          staleShadowWindowId: record.shadow.shadowWindowId,
	          currentShadowWindowId: latest.shadow?.shadowWindowId,
	          ticketId: ticket.ticketId,
	          planDigest: ticket.planDigest,
	        });
	        writeEvidence(latest);
	        throw new FridayDomainError(
	          "SKILL_LIFECYCLE_CANARY_STALE",
	          "Skill lifecycle canary result was ignored because the candidate was shadowed again before the run completed.",
	          {
	            httpStatus: 409,
	            details: {
	              skillId: input.skillId,
	              candidateId: candidate.candidateId,
	              staleShadowWindowId: record.shadow.shadowWindowId,
	              currentShadowWindowId: latest.shadow?.shadowWindowId,
	            },
	          },
	        );
	      }
	      const shadowDigestAfter = hashDirectory(latest.shadow.shadowDir);
	      const digestStillCurrent = shadowDigestAfter === latest.shadow.artifactDigest;
	      const success = result.status === "completed" && digestStillCurrent;
	      latest.canaryRuns.push({
	        runId: result.runId,
	        status: digestStillCurrent ? result.status : "artifact_digest_mismatch",
	        success,
	        artifactDigest: shadowDigestAfter,
        startedAt,
        endedAt,
        durationMs: result.durationMs,
        stdout: redactLifecycleText(result.stdout),
        stderr: redactLifecycleText(result.stderr),
	        ticketId: ticket.ticketId,
	        actionDigest: ticket.actionDigest,
	        planDigest: ticket.planDigest,
	        shadowWindowId: latest.shadow.shadowWindowId,
	      });
	      latest.events.push({
	        type: "canary",
	        at: endedAt,
	        runId: result.runId,
	        status: digestStillCurrent ? result.status : "artifact_digest_mismatch",
	        success,
	        expectedDigest: latest.shadow.artifactDigest,
	        actualDigest: shadowDigestAfter,
	        shadowWindowId: latest.shadow.shadowWindowId,
	        ticketId: ticket.ticketId,
	        planDigest: ticket.planDigest,
	      });
	      writeEvidence(latest);

      const updated = updateCanaryStats(input.skillId, success, endedAt);
      if (!digestStillCurrent) {
        throw new FridayDomainError(
          "SKILL_LIFECYCLE_SHADOW_DIGEST_MISMATCH",
          "Skill lifecycle canary failed because the shadow artifact digest changed during execution.",
	          { httpStatus: 409, details: { expected: latest.shadow.artifactDigest, actual: shadowDigestAfter } },
	        );
	      }
      return updated;
    },

    async promote(input) {
      const candidate = requireCandidate(input.skillId, input.candidateId);
      const ticket = requireCanonicalLifecycleTicket({
        action: "promote",
        skillId: input.skillId,
        candidateId: candidate.candidateId,
        shadowVersionId: candidate.shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
        requirePlanDigest: true,
      });
      const record = readEvidence(input.skillId, candidate.candidateId);
      if (!record.shadow || !existsSync(record.shadow.shadowDir)) {
        throw new FridayDomainError("SKILL_LIFECYCLE_SHADOW_REQUIRED", "Promote requires a shadow artifact.", {
          httpStatus: 409,
        });
      }
	      const currentCanaryRuns = record.shadow.shadowWindowId
	        ? record.canaryRuns.filter((run) => run.shadowWindowId === record.shadow!.shadowWindowId)
	        : record.canaryRuns;
	      const canarySuccessCount = currentCanaryRuns.filter((run) => run.success).length;
	      const canaryFailureCount = currentCanaryRuns.filter((run) => !run.success).length;
      if (canarySuccessCount < 1 || canaryFailureCount > 0) {
        throw new FridayDomainError(
          "SKILL_LIFECYCLE_CANARY_NOT_GREEN",
          "Promote requires at least one successful canary and no canary failures.",
          { httpStatus: 409, details: { canarySuccessCount, canaryFailureCount } },
        );
      }
      const currentShadowDigest = hashDirectory(record.shadow.shadowDir);
      if (currentShadowDigest !== record.shadow.artifactDigest) {
        throw new FridayDomainError(
          "SKILL_LIFECYCLE_SHADOW_DIGEST_MISMATCH",
          "Shadow artifact digest changed after canary.",
          { httpStatus: 409, details: { expected: record.shadow.artifactDigest, actual: currentShadowDigest } },
        );
      }

      const manifest = loadShadowManifest(input.skillId, candidate.candidateId);
      const { activeDir, rollbackDir } = pathsFor(input.skillId, candidate.candidateId);
      const previousMetadataExists = Boolean(
        record.shadow.previous.installedVersion
          || (record.shadow.previous.status === "installed" && record.shadow.previous.currentManifest),
      );
      if (previousMetadataExists && !record.shadow.previous.activeExists) {
        throw new FridayDomainError(
          "SKILL_LIFECYCLE_ROLLBACK_POINTER_REQUIRED",
          "Promote refused because the previous installed metadata has no active artifact to use as a rollback pointer.",
          { httpStatus: 409, details: { skillId: input.skillId, candidateId: candidate.candidateId } },
        );
      }
      if (record.shadow.previous.activeExists) {
        if (!existsSync(activeDir)) {
          throw new FridayDomainError(
            "SKILL_LIFECYCLE_PREVIOUS_ARTIFACT_MISSING",
            "Promote refused because the previous active artifact disappeared after shadow.",
            { httpStatus: 409, details: { skillId: input.skillId, candidateId: candidate.candidateId } },
          );
        }
        const currentPreviousDigest = hashDirectory(activeDir);
        if (record.shadow.previous.activeDigest && currentPreviousDigest !== record.shadow.previous.activeDigest) {
          throw new FridayDomainError(
            "SKILL_LIFECYCLE_PREVIOUS_ARTIFACT_CHANGED",
            "Promote refused because the previous active artifact changed after shadow.",
            {
              httpStatus: 409,
              details: {
                skillId: input.skillId,
                candidateId: candidate.candidateId,
                expected: record.shadow.previous.activeDigest,
                actual: currentPreviousDigest,
              },
            },
          );
        }
      }
      rmSync(rollbackDir, { recursive: true, force: true });
      mkdirSync(dirname(rollbackDir), { recursive: true });
      if (existsSync(activeDir)) {
        cpSync(activeDir, rollbackDir, { recursive: true });
      }
      rmSync(activeDir, { recursive: true, force: true });
      mkdirSync(dirname(activeDir), { recursive: true });
      cpSync(record.shadow.shadowDir, activeDir, { recursive: true });

      const promotedAt = deps.nowIso();
      const promoted = deps.db.withWriteTransaction((db) => {
        const current = deps.skillRepo.getSkillById(db, input.skillId)?.canaryStats ?? emptyCanaryStats();
        deps.skillRepo.setInstalledVersion(db, input.skillId, candidate.version, manifest, promotedAt);
        const updated = deps.skillRepo.setUpgradeMetadata(db, input.skillId, {
          compatibilityStatus: "compatible",
          promotionChannel: "active",
          shadowVersionId: candidate.candidateId,
          canaryStats: current,
          lastVerifiedAt: promotedAt,
          lastVerifiedRuntimeVersion: input.runtimeVersion,
          lastVerifiedProviderModel: input.providerModel,
        }, promotedAt);
        if (!updated) {
          throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${input.skillId}" not found`, { httpStatus: 404 });
        }
        return updated;
      });

      record.promotion = {
        promotedAt,
        artifactDigest: record.shadow.artifactDigest,
        activeDir,
        rollbackDir,
        ticketId: ticket.ticketId,
        actionDigest: ticket.actionDigest,
        planDigest: ticket.planDigest!,
      };
      record.events.push({
        type: "promote",
        at: promotedAt,
        artifactDigest: record.shadow.artifactDigest,
        ticketId: ticket.ticketId,
        planDigest: ticket.planDigest,
      });
      writeEvidence(record);
      await refreshRuntimeStatus(input.skillId, "installed");
      return promoted;
    },

    async rollback(input) {
      const candidate = requireCandidate(input.skillId, input.candidateId);
      const rollbackScope: FridayMutatingActionRollbackScope = {
        planned: true,
        planDigest: input.planDigest,
        actions: ["skills.lifecycle.promote"],
      };
      const ticket = requireCanonicalLifecycleTicket({
        action: "rollback",
        skillId: input.skillId,
        candidateId: candidate.candidateId,
        shadowVersionId: candidate.shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
        rollback: rollbackScope,
        requirePlanDigest: true,
      });
      const record = readEvidence(input.skillId, candidate.candidateId);
      if (!record.shadow) {
        throw new FridayDomainError("SKILL_LIFECYCLE_SHADOW_REQUIRED", "Rollback requires a lifecycle shadow record.", {
          httpStatus: 409,
        });
      }
      const previous = record.shadow.previous;
      const { activeDir, rollbackDir } = pathsFor(input.skillId, candidate.candidateId);
      let result: "restored_previous" | "cleared_active";
      let restoredDigest: string | undefined;
      const previousMetadataExists = Boolean(
        previous.installedVersion || (previous.status === "installed" && previous.currentManifest),
      );
      if (previousMetadataExists && !previous.activeExists) {
        throw new FridayDomainError(
          "SKILL_LIFECYCLE_ROLLBACK_METADATA_ONLY_REFUSED",
          "Rollback refused to restore previous installed metadata because the previous active artifact was missing when the lifecycle started.",
          { httpStatus: 409, details: { skillId: input.skillId, candidateId: candidate.candidateId } },
        );
      }
      if (previous.activeExists && !existsSync(rollbackDir)) {
        throw new FridayDomainError(
          "SKILL_LIFECYCLE_ROLLBACK_ARTIFACT_MISSING",
          "Rollback refused to restore metadata without the previous active artifact.",
          { httpStatus: 409, details: { skillId: input.skillId, candidateId: candidate.candidateId } },
        );
      }
      if (previous.activeExists && existsSync(rollbackDir)) {
        const rollbackDigest = hashDirectory(rollbackDir);
        if (previous.activeDigest && rollbackDigest !== previous.activeDigest) {
          throw new FridayDomainError(
            "SKILL_LIFECYCLE_ROLLBACK_ARTIFACT_MISMATCH",
            "Rollback refused because the previous active artifact backup no longer matches the lifecycle record.",
            {
              httpStatus: 409,
              details: {
                skillId: input.skillId,
                candidateId: candidate.candidateId,
                expected: previous.activeDigest,
                actual: rollbackDigest,
              },
            },
          );
        }
        rmSync(activeDir, { recursive: true, force: true });
        mkdirSync(dirname(activeDir), { recursive: true });
        cpSync(rollbackDir, activeDir, { recursive: true });
        restoredDigest = rollbackDigest;
        result = "restored_previous";
      } else {
        rmSync(activeDir, { recursive: true, force: true });
        result = "cleared_active";
      }

      const rolledBackAt = deps.nowIso();
      const restored = deps.db.withWriteTransaction((db) => {
        if (previous.installedVersion && previous.currentManifest) {
          deps.skillRepo.setInstalledVersion(
            db,
            input.skillId,
            previous.installedVersion,
            previous.currentManifest,
            rolledBackAt,
          );
        } else {
          deps.skillRepo.clearInstalledVersion(db, input.skillId, rolledBackAt);
        }
        deps.skillRepo.updateLifecycleStatus(db, input.skillId, previous.status, rolledBackAt);
        const current = deps.skillRepo.getSkillById(db, input.skillId)?.canaryStats ?? emptyCanaryStats();
        const updated = deps.skillRepo.setUpgradeMetadata(db, input.skillId, {
          compatibilityStatus: "adaptation_required",
          promotionChannel: "rolled_back",
          shadowVersionId: null,
          canaryStats: {
            sampleSize: current.sampleSize,
            successCount: current.successCount,
            failureCount: current.failureCount,
            rollbackCount: current.rollbackCount + 1,
            lastEvaluatedAt: rolledBackAt,
          },
          lastVerifiedRuntimeVersion: input.runtimeVersion,
          lastVerifiedProviderModel: input.providerModel,
        }, rolledBackAt);
        if (!updated) {
          throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${input.skillId}" not found`, { httpStatus: 404 });
        }
        return updated;
      });

      const redactedReason = input.reason ? redactLifecycleText(input.reason) : undefined;
      record.rollback = {
        rolledBackAt,
        fromDigest: record.promotion?.artifactDigest,
        toDigest: restoredDigest,
        reason: redactedReason,
        result,
        ticketId: ticket.ticketId,
        actionDigest: ticket.actionDigest,
        planDigest: ticket.planDigest!,
      };
      record.events.push({
        type: "rollback",
        at: rolledBackAt,
        result,
        reason: redactedReason,
        ticketId: ticket.ticketId,
        planDigest: ticket.planDigest,
      });
      writeEvidence(record);

      await refreshRuntimeStatus(input.skillId, previous.status);
      return restored;
    },

    getLifecycleEvidence(input) {
      const record = readEvidence(input.skillId, input.candidateId);
      if (!record.shadow && record.canaryRuns.length === 0 && !record.promotion && !record.rollback) {
        return null;
      }
      const lastEvent = record.events[record.events.length - 1] as { at?: string } | undefined;
      return {
        candidateId: input.candidateId,
        artifactDigest: record.shadow?.artifactDigest ?? record.promotion?.artifactDigest,
        stage: record.rollback ? "rolled_back" : record.promotion ? "active" : record.canaryRuns.length > 0 ? "canary" : "shadow",
        lastEventAt: lastEvent?.at ?? record.shadow?.shadowedAt ?? deps.nowIso(),
	        canarySuccessCount: record.shadow?.shadowWindowId
	          ? record.canaryRuns.filter((run) => run.shadowWindowId === record.shadow!.shadowWindowId && run.success).length
	          : record.canaryRuns.filter((run) => run.success).length,
	        canaryFailureCount: record.shadow?.shadowWindowId
	          ? record.canaryRuns.filter((run) => run.shadowWindowId === record.shadow!.shadowWindowId && !run.success).length
	          : record.canaryRuns.filter((run) => !run.success).length,
	        rollbackPointerAvailable: Boolean(record.shadow?.previous),
	      };
    },
  };
}

function emptyCanaryStats(): FridayAutonomyCanaryStats {
  return {
    sampleSize: 0,
    successCount: 0,
    failureCount: 0,
    rollbackCount: 0,
  };
}

function hashDirectory(dir: string): string {
  const root = resolve(dir);
  const hash = createHash("sha256");
  for (const filePath of listFiles(root)) {
    const rel = relative(root, filePath).split(sep).join("/");
    const stat = statSync(filePath);
    hash.update(rel);
    hash.update(String(stat.mode & 0o777));
    hash.update(readFileSync(filePath));
  }
  return hash.digest("hex");
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const entryPath = join(dir, entry);
    const stat = statSync(entryPath);
    if (stat.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else if (stat.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function redactLifecycleText(text: string): string {
  const truncated = text.length > 4096 ? `${text.slice(0, 4096)}...[truncated]` : text;
  const redacted = redactContext({ text: truncated } as JsonObject, {
    sensitivePaths: ["text"],
    replacement: truncated,
    maxStringLength: 4096,
  }).redacted.text;
  return String(redacted)
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[api-key:redacted]")
    .replace(/\b(set-cookie|cookie)(\s*:\s*)[^\r\n]+/gi, "$1$2[redacted]")
    .replace(/\b(authorization)(\s*:\s*)[^\r\n]+/gi, "$1$2[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [token:redacted]")
    .replace(
      /((?:"|')?(?:authorization|cookie|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|session)(?:"|')?\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s}]+)/gi,
      "$1[redacted]",
    )
    .replace(
      /\b(token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|session)(\s*[=:]\s*)[^\s,;]+/gi,
      "$1$2[redacted]",
    );
}

function hashStableJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function createShadowWindowId(input: {
  skillId: string;
  candidateId: string;
  shadowVersionId: string;
  artifactDigest: string;
  ticketId: string;
  actionDigest: string;
  eventIndex: number;
}): string {
  return hashStableJson(input);
}

function isSameShadowWindow(
  current: NonNullable<SkillLifecycleEvidenceRecord["shadow"]>,
  started: NonNullable<SkillLifecycleEvidenceRecord["shadow"]>,
): boolean {
  if (current.shadowWindowId && started.shadowWindowId) {
    return current.shadowWindowId === started.shadowWindowId;
  }
  return current.ticketId === started.ticketId
    && current.actionDigest === started.actionDigest
    && current.shadowedAt === started.shadowedAt
    && current.artifactDigest === started.artifactDigest
    && current.shadowDir === started.shadowDir;
}

export function createFridaySkillLifecycleCanaryInputDigest(input: Record<string, unknown> | undefined): string {
  return hashStableJson(input ?? {});
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableStringify(value));
}

function normalizeForStableStringify(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableStringify(item));
  }
  if (typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined && typeof item !== "function" && typeof item !== "symbol") {
        normalized[key] = normalizeForStableStringify(item);
      }
    }
    return normalized;
  }
  return null;
}
