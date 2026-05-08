import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import { resolveSafePath, safeDirName } from "#utilities";
import type { FridayProviderProfileRepository } from "../../providers/persistence/friday-provider-profile-repository.js";
import type { FridayAutonomyCanaryStats } from "../model/friday-autonomy-upgrade.types.js";
import type {
  FridayProviderProfile,
  FridayProviderValidationState,
} from "../../providers/model/friday-provider.types.js";
import type { FridayProviderTenantContext } from "../../providers/services/friday-provider-service.types.js";
import {
  createFridayMutatingActionDigest,
  type FridayCanonicalApprovalResolution,
  type FridayMutatingActionActor,
  type FridayMutatingActionGate,
  type FridayMutatingActionRequest,
  type FridayMutatingActionRollbackScope,
  type FridayMutatingActionTicket,
} from "../../security/friday-mutating-action-gate.js";

type FridayProviderProfileLifecycleAction = "shadow" | "canary" | "promote" | "rollback";

export interface FridayProviderProfileLifecycleApprovalRequestInput {
  action: FridayProviderProfileLifecycleAction;
  providerId: string;
  shadowVersionId?: string;
  runtimeVersion: string;
  providerModel?: string;
  actor: FridayMutatingActionActor;
  surface: string;
  planDigest: string;
  idempotencyKey?: string;
  rollback?: FridayMutatingActionRollbackScope;
}

export interface FridayProviderProfileLifecycleEvidenceSummary {
  providerId: string;
  shadowVersionId?: string;
  stage: "shadow" | "canary" | "active" | "rolled_back";
  lastEventAt: string;
  canarySuccessCount: number;
  canaryFailureCount: number;
  rollbackPointerAvailable: boolean;
  validationStatus?: FridayProviderValidationState["status"];
}

export interface FridayProviderProfileUpgradeLifecycleService {
  registerShadowVersion(input: {
    providerId: string;
    shadowVersionId: string;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): FridayProviderProfile;
  recordCanaryResult(input: {
    providerId: string;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    tenantContext?: FridayProviderTenantContext;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): Promise<FridayProviderProfile>;
  promote(input: {
    providerId: string;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): FridayProviderProfile;
  rollback(input: {
    providerId: string;
    runtimeVersion: string;
    providerModel?: string;
    reason?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): FridayProviderProfile;
  getLifecycleEvidence(input: { providerId: string }): FridayProviderProfileLifecycleEvidenceSummary | null;
}

export interface CreateFridayProviderProfileUpgradeLifecycleServiceDeps {
  db: FridaySqliteLayer;
  providerProfileRepo: FridayProviderProfileRepository;
  nowIso: () => string;
  stateDir?: string;
  validateProvider?: (
    providerId: string,
    options?: { tenantContext?: FridayProviderTenantContext },
  ) => Promise<FridayProviderValidationState>;
  canonicalMutationGate?: FridayMutatingActionGate;
}

interface ProviderLifecycleSnapshot {
  lastVerifiedAt?: string;
  lastVerifiedRuntimeVersion?: string;
  lastVerifiedProviderModel?: string;
  compatibilityStatus: FridayProviderProfile["compatibilityStatus"];
  promotionChannel: FridayProviderProfile["promotionChannel"];
  shadowVersionId?: string;
  canaryStats?: FridayAutonomyCanaryStats;
  validation?: FridayProviderValidationState;
}

interface ProviderLifecycleEvidenceRecord {
  schemaVersion: "friday.provider_profile.lifecycle.phase3.2B.v1";
  providerId: string;
  events: Array<Record<string, unknown>>;
  shadow?: {
    shadowVersionId: string;
    providerSnapshotDigest: string;
    shadowedAt: string;
    ticketId: string;
    actionDigest: string;
    planDigest?: string;
    previous: ProviderLifecycleSnapshot;
  };
  canaryRuns: Array<{
    runId: string;
    shadowVersionId?: string;
    success: boolean;
    validationStatus: FridayProviderValidationState["status"];
    checkedAt?: string;
    errorCode?: string;
    errorMessage?: string;
    ticketId: string;
    actionDigest: string;
    planDigest?: string;
    startedAt: string;
    endedAt: string;
  }>;
  promotion?: {
    promotedAt: string;
    shadowVersionId?: string;
    ticketId: string;
    actionDigest: string;
    planDigest: string;
  };
  rollback?: {
    rolledBackAt: string;
    reason?: string;
    result: "restored_previous_profile_lifecycle";
    ticketId: string;
    actionDigest: string;
    planDigest: string;
  };
}

export function createFridayProviderProfileLifecycleMutatingActionRequest(
  input: FridayProviderProfileLifecycleApprovalRequestInput,
): FridayMutatingActionRequest {
  const parameters = {
    providerId: input.providerId,
    shadowVersionId: input.shadowVersionId,
    runtimeVersion: input.runtimeVersion,
    providerModel: input.providerModel,
  };
  return {
    action: `providers.lifecycle.${input.action}`,
    actor: input.actor,
    surface: input.surface,
    resource: {
      type: "provider_profile_lifecycle",
      id: input.providerId,
      digest: hashStableJson(parameters),
      attributes: {
        providerId: input.providerId,
        shadowVersionId: input.shadowVersionId,
        lifecycleAction: input.action,
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
        guardId: "provider_profile_lifecycle_guard",
        decision: "requires_approval",
        risk: "high",
        reason: `provider_profile_${input.action}_requires_canonical_approval`,
      },
    ],
  };
}

export function createFridayProviderProfileUpgradeLifecycleService(
  deps: CreateFridayProviderProfileUpgradeLifecycleServiceDeps,
): FridayProviderProfileUpgradeLifecycleService {
  function getProvider(providerId: string): FridayProviderProfile {
    const provider = deps.db.withReadConnection((db) => deps.providerProfileRepo.getById(db, providerId));
    if (!provider) {
      throw new FridayDomainError("PROVIDER_NOT_FOUND", `Provider ${providerId} not found`, { httpStatus: 404 });
    }
    return provider;
  }

  function updateProvider(
    providerId: string,
    patch: Parameters<FridayProviderProfileRepository["setUpgradeMetadata"]>[2],
  ): FridayProviderProfile {
    return deps.db.withWriteTransaction((db) => {
      const updated = deps.providerProfileRepo.setUpgradeMetadata(db, providerId, patch, deps.nowIso());
      if (!updated) {
        throw new FridayDomainError("PROVIDER_NOT_FOUND", `Provider ${providerId} not found`, { httpStatus: 404 });
      }
      return updated;
    });
  }

  function requireCanonicalLifecycleTicket(input: {
    action: FridayProviderProfileLifecycleAction;
    providerId: string;
    shadowVersionId?: string;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest?: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
    rollback?: FridayMutatingActionRollbackScope;
  }): FridayMutatingActionTicket {
    if (!deps.canonicalMutationGate) {
      throw new FridayDomainError(
        "PROVIDER_LIFECYCLE_CANONICAL_GATE_UNAVAILABLE",
        "Provider lifecycle actions require the canonical approval gate.",
        { httpStatus: 503 },
      );
    }
    const planDigest = input.planDigest;
    if (!planDigest) {
      throw new FridayDomainError(
        "PROVIDER_LIFECYCLE_PLAN_DIGEST_REQUIRED",
        "Provider lifecycle actions require an approved plan digest.",
        { httpStatus: 403, details: { providerId: input.providerId } },
      );
    }

    const request = createFridayProviderProfileLifecycleMutatingActionRequest({
      ...input,
      planDigest,
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
          ? `Provider lifecycle ${input.action} requires canonical approval before any mutation.`
          : `Provider lifecycle ${input.action} was blocked by the canonical approval gate: ${gateResult.reason}`,
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

  function evidencePath(providerId: string): string {
    const stateDir = deps.stateDir ?? ".";
    return resolveSafePath(
      stateDir,
      join("autonomy", "provider-lifecycle", `${safeDirName(providerId)}.json`),
    );
  }

  function readEvidence(providerId: string): ProviderLifecycleEvidenceRecord {
    const path = evidencePath(providerId);
    if (!existsSync(path)) {
      return {
        schemaVersion: "friday.provider_profile.lifecycle.phase3.2B.v1",
        providerId,
        events: [],
        canaryRuns: [],
      };
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ProviderLifecycleEvidenceRecord;
    return {
      ...parsed,
      events: Array.isArray(parsed.events) ? parsed.events : [],
      canaryRuns: Array.isArray(parsed.canaryRuns) ? parsed.canaryRuns : [],
    };
  }

  function writeEvidence(record: ProviderLifecycleEvidenceRecord): void {
    const path = evidencePath(record.providerId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  function snapshotProvider(provider: FridayProviderProfile): ProviderLifecycleSnapshot {
    return {
      lastVerifiedAt: provider.lastVerifiedAt,
      lastVerifiedRuntimeVersion: provider.lastVerifiedRuntimeVersion,
      lastVerifiedProviderModel: provider.lastVerifiedProviderModel,
      compatibilityStatus: provider.compatibilityStatus,
      promotionChannel: provider.promotionChannel,
      shadowVersionId: provider.shadowVersionId,
      canaryStats: provider.canaryStats,
      validation: provider.config.validation,
    };
  }

  function restoreProviderSnapshot(providerId: string, snapshot: ProviderLifecycleSnapshot): FridayProviderProfile {
    return deps.db.withWriteTransaction((db) => {
      const current = deps.providerProfileRepo.getById(db, providerId);
      if (!current) {
        throw new FridayDomainError("PROVIDER_NOT_FOUND", `Provider ${providerId} not found`, { httpStatus: 404 });
      }
      deps.providerProfileRepo.update(db, {
        ...current,
        config: {
          ...current.config,
          validation: snapshot.validation,
        },
        updatedAt: deps.nowIso(),
      });
      const restored = deps.providerProfileRepo.setUpgradeMetadata(db, providerId, {
        lastVerifiedAt: snapshot.lastVerifiedAt ?? null,
        lastVerifiedRuntimeVersion: snapshot.lastVerifiedRuntimeVersion ?? null,
        lastVerifiedProviderModel: snapshot.lastVerifiedProviderModel ?? null,
        compatibilityStatus: snapshot.compatibilityStatus,
        promotionChannel: snapshot.promotionChannel,
        shadowVersionId: snapshot.shadowVersionId ?? null,
        canaryStats: {
          sampleSize: snapshot.canaryStats?.sampleSize ?? 0,
          successCount: snapshot.canaryStats?.successCount ?? 0,
          failureCount: snapshot.canaryStats?.failureCount ?? 0,
          rollbackCount: (snapshot.canaryStats?.rollbackCount ?? 0) + 1,
          lastEvaluatedAt: deps.nowIso(),
        },
      }, deps.nowIso());
      if (!restored) {
        throw new FridayDomainError("PROVIDER_NOT_FOUND", `Provider ${providerId} not found`, { httpStatus: 404 });
      }
      return restored;
    });
  }

  function updateCanaryStats(input: {
    providerId: string;
    success: boolean;
    validation: FridayProviderValidationState;
    evaluatedAt: string;
  }): FridayProviderProfile {
    const provider = getProvider(input.providerId);
    const current = provider.canaryStats ?? emptyCanaryStats();
    return updateProvider(input.providerId, {
      compatibilityStatus: input.success ? "compatible" : "adaptation_required",
      promotionChannel: "canary",
      canaryStats: {
        sampleSize: current.sampleSize + 1,
        successCount: current.successCount + (input.success ? 1 : 0),
        failureCount: current.failureCount + (input.success ? 0 : 1),
        rollbackCount: current.rollbackCount,
        lastEvaluatedAt: input.validation.checkedAt ?? input.evaluatedAt,
      },
      ...(input.success
        ? {
            lastVerifiedAt: input.validation.checkedAt ?? input.evaluatedAt,
          }
        : {}),
    });
  }

  function requireShadowRecord(input: {
    providerId: string;
    evidence: ProviderLifecycleEvidenceRecord;
  }): NonNullable<ProviderLifecycleEvidenceRecord["shadow"]> {
    const shadow = input.evidence.shadow;
    if (!shadow) {
      throw new FridayDomainError(
        "PROVIDER_LIFECYCLE_SHADOW_REQUIRED",
        "Provider lifecycle action requires a shadow profile first.",
        { httpStatus: 409, details: { providerId: input.providerId } },
      );
    }
    return shadow;
  }

  function requireRollbackPointer(input: {
    providerId: string;
    shadow: NonNullable<ProviderLifecycleEvidenceRecord["shadow"]>;
  }): ProviderLifecycleSnapshot {
    const previous = input.shadow.previous as ProviderLifecycleSnapshot | undefined;
    if (!previous || !previous.compatibilityStatus || !previous.promotionChannel) {
      throw new FridayDomainError(
        "PROVIDER_LIFECYCLE_ROLLBACK_POINTER_REQUIRED",
        "Provider lifecycle action requires a restorable rollback pointer before promotion.",
        {
          httpStatus: 409,
          details: {
            providerId: input.providerId,
            shadowVersionId: input.shadow.shadowVersionId,
          },
        },
      );
    }
    return previous;
  }

  return {
    registerShadowVersion(input) {
      const provider = getProvider(input.providerId);
      if ((provider.config.validation?.status ?? "never") !== "ok") {
        throw new FridayDomainError(
          "PROVIDER_LIFECYCLE_VALIDATION_REQUIRED",
          "Provider lifecycle shadow requires provider validation to be ok.",
          {
            httpStatus: 409,
            details: {
              providerId: input.providerId,
              validationStatus: provider.config.validation?.status ?? "never",
            },
          },
        );
      }
      const ticket = requireCanonicalLifecycleTicket({
        action: "shadow",
        providerId: input.providerId,
        shadowVersionId: input.shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
      });
      const shadowedAt = deps.nowIso();
      const record = readEvidence(input.providerId);
      record.canaryRuns = [];
      delete record.promotion;
      delete record.rollback;
      record.shadow = {
        shadowVersionId: input.shadowVersionId,
        providerSnapshotDigest: hashStableJson(snapshotProvider(provider)),
        shadowedAt,
        ticketId: ticket.ticketId,
        actionDigest: ticket.actionDigest,
        planDigest: ticket.planDigest,
        previous: snapshotProvider(provider),
      };
      record.events.push({
        type: "shadow",
        at: shadowedAt,
        shadowVersionId: input.shadowVersionId,
        ticketId: ticket.ticketId,
        planDigest: ticket.planDigest,
      });
      writeEvidence(record);

      return updateProvider(input.providerId, {
        compatibilityStatus: "adaptation_required",
        promotionChannel: "shadow",
        shadowVersionId: input.shadowVersionId,
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
    },

    async recordCanaryResult(input) {
      if (!deps.validateProvider) {
        throw new FridayDomainError(
          "PROVIDER_LIFECYCLE_VALIDATOR_UNAVAILABLE",
          "Provider lifecycle canary requires provider validation.",
          { httpStatus: 503 },
        );
      }
      const record = readEvidence(input.providerId);
      const shadow = requireShadowRecord({ providerId: input.providerId, evidence: record });
      const provider = getProvider(input.providerId);
      if (provider.shadowVersionId !== shadow.shadowVersionId || provider.promotionChannel !== "shadow") {
        throw new FridayDomainError(
          "PROVIDER_LIFECYCLE_SHADOW_STALE",
          "Provider lifecycle canary requires the current shadow profile to match the lifecycle evidence.",
          {
            httpStatus: 409,
            details: {
              providerId: input.providerId,
              currentShadowVersionId: provider.shadowVersionId,
              evidenceShadowVersionId: shadow.shadowVersionId,
            },
          },
        );
      }
      const ticket = requireCanonicalLifecycleTicket({
        action: "canary",
        providerId: input.providerId,
        shadowVersionId: shadow.shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
      });
      const startedAt = deps.nowIso();
      const validation = await deps.validateProvider(input.providerId, {
        tenantContext: input.tenantContext,
      });
      const endedAt = deps.nowIso();
      const success = validation.status === "ok";
      const runId = `provider-canary:${hashStableJson({
        providerId: input.providerId,
        shadowVersionId: shadow.shadowVersionId,
        ticketId: ticket.ticketId,
        startedAt,
      }).slice(0, 24)}`;
      record.canaryRuns.push({
        runId,
        shadowVersionId: shadow.shadowVersionId,
        success,
        validationStatus: validation.status,
        checkedAt: validation.checkedAt,
        errorCode: validation.errorCode,
        errorMessage: validation.errorMessage,
        ticketId: ticket.ticketId,
        actionDigest: ticket.actionDigest,
        planDigest: ticket.planDigest,
        startedAt,
        endedAt,
      });
      record.events.push({
        type: "canary",
        at: endedAt,
        runId,
        shadowVersionId: shadow.shadowVersionId,
        success,
        validationStatus: validation.status,
        ticketId: ticket.ticketId,
        planDigest: ticket.planDigest,
      });
      writeEvidence(record);

      return updateCanaryStats({
        providerId: input.providerId,
        success,
        validation,
        evaluatedAt: endedAt,
      });
    },

    promote(input) {
      const provider = getProvider(input.providerId);
      const record = readEvidence(input.providerId);
      const shadow = requireShadowRecord({ providerId: input.providerId, evidence: record });
      const ticket = requireCanonicalLifecycleTicket({
        action: "promote",
        providerId: input.providerId,
        shadowVersionId: shadow.shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
      });
      requireRollbackPointer({ providerId: input.providerId, shadow });
      if ((provider.config.validation?.status ?? "never") !== "ok") {
        throw new FridayDomainError(
          "PROVIDER_LIFECYCLE_VALIDATION_REQUIRED",
          "Provider lifecycle promote requires provider validation to be ok.",
          { httpStatus: 409, details: { providerId: input.providerId, validationStatus: provider.config.validation?.status ?? "never" } },
        );
      }
      if (provider.shadowVersionId !== shadow.shadowVersionId) {
        throw new FridayDomainError(
          "PROVIDER_LIFECYCLE_SHADOW_STALE",
          "Provider lifecycle promote requires the current shadow profile to match lifecycle evidence.",
          { httpStatus: 409, details: { providerId: input.providerId } },
        );
      }
      const canaryRuns = record.canaryRuns.filter((run) => run.shadowVersionId === shadow.shadowVersionId);
      const canarySuccessCount = canaryRuns.filter((run) => run.success).length;
      const canaryFailureCount = canaryRuns.filter((run) => !run.success).length;
      if (canarySuccessCount < 1 || canaryFailureCount > 0) {
        throw new FridayDomainError(
          "PROVIDER_LIFECYCLE_CANARY_NOT_GREEN",
          "Provider lifecycle promote requires at least one successful canary and no canary failures.",
          { httpStatus: 409, details: { providerId: input.providerId, canarySuccessCount, canaryFailureCount } },
        );
      }

      const promotedAt = deps.nowIso();
      const promoted = updateProvider(input.providerId, {
        compatibilityStatus: "compatible",
        promotionChannel: "active",
        shadowVersionId: provider.shadowVersionId,
        canaryStats: provider.canaryStats,
        lastVerifiedAt: promotedAt,
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
      record.promotion = {
        promotedAt,
        shadowVersionId: shadow.shadowVersionId,
        ticketId: ticket.ticketId,
        actionDigest: ticket.actionDigest,
        planDigest: ticket.planDigest!,
      };
      record.events.push({
        type: "promote",
        at: promotedAt,
        shadowVersionId: shadow.shadowVersionId,
        ticketId: ticket.ticketId,
        planDigest: ticket.planDigest,
      });
      writeEvidence(record);
      return promoted;
    },

    rollback(input) {
      const rollbackScope: FridayMutatingActionRollbackScope = {
        planned: true,
        planDigest: input.planDigest,
        actions: ["providers.lifecycle.promote"],
      };
      const record = readEvidence(input.providerId);
      const shadow = requireShadowRecord({ providerId: input.providerId, evidence: record });
      const previous = requireRollbackPointer({ providerId: input.providerId, shadow });
      if (!record.promotion || record.promotion.shadowVersionId !== shadow.shadowVersionId) {
        throw new FridayDomainError(
          "PROVIDER_LIFECYCLE_PROMOTION_REQUIRED",
          "Provider lifecycle rollback requires a promoted provider lifecycle version.",
          {
            httpStatus: 409,
            details: {
              providerId: input.providerId,
              shadowVersionId: shadow.shadowVersionId,
            },
          },
        );
      }
      const provider = getProvider(input.providerId);
      if (provider.promotionChannel !== "active" || provider.shadowVersionId !== shadow.shadowVersionId) {
        throw new FridayDomainError(
          "PROVIDER_LIFECYCLE_ACTIVE_PROMOTION_REQUIRED",
          "Provider lifecycle rollback requires the current active provider to match lifecycle promotion evidence.",
          {
            httpStatus: 409,
            details: {
              providerId: input.providerId,
              currentPromotionChannel: provider.promotionChannel,
              currentShadowVersionId: provider.shadowVersionId,
              evidenceShadowVersionId: shadow.shadowVersionId,
            },
          },
        );
      }
      const ticket = requireCanonicalLifecycleTicket({
        action: "rollback",
        providerId: input.providerId,
        shadowVersionId: shadow.shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
        rollback: rollbackScope,
      });
      const rolledBackAt = deps.nowIso();
      const restored = restoreProviderSnapshot(input.providerId, previous);
      record.rollback = {
        rolledBackAt,
        reason: input.reason,
        result: "restored_previous_profile_lifecycle",
        ticketId: ticket.ticketId,
        actionDigest: ticket.actionDigest,
        planDigest: ticket.planDigest!,
      };
      record.events.push({
        type: "rollback",
        at: rolledBackAt,
        result: record.rollback.result,
        reason: input.reason,
        ticketId: ticket.ticketId,
        planDigest: ticket.planDigest,
      });
      writeEvidence(record);
      return restored;
    },

    getLifecycleEvidence(input) {
      const record = readEvidence(input.providerId);
      if (!record.shadow && record.canaryRuns.length === 0 && !record.promotion && !record.rollback) {
        return null;
      }
      const lastEvent = record.events[record.events.length - 1] as { at?: string } | undefined;
      const shadowVersionId = record.shadow?.shadowVersionId;
      const canaryRuns = shadowVersionId
        ? record.canaryRuns.filter((run) => run.shadowVersionId === shadowVersionId)
        : record.canaryRuns;
      const lastCanary = canaryRuns[canaryRuns.length - 1];
      return {
        providerId: input.providerId,
        shadowVersionId,
        stage: record.rollback ? "rolled_back" : record.promotion ? "active" : canaryRuns.length > 0 ? "canary" : "shadow",
        lastEventAt: lastEvent?.at ?? record.shadow?.shadowedAt ?? deps.nowIso(),
        canarySuccessCount: canaryRuns.filter((run) => run.success).length,
        canaryFailureCount: canaryRuns.filter((run) => !run.success).length,
        rollbackPointerAvailable: Boolean(record.shadow?.previous),
        validationStatus: lastCanary?.validationStatus,
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

function hashStableJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(normalizeForStableStringify(value))).digest("hex");
}

function normalizeForStableStringify(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeForStableStringify);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeForStableStringify(entry)]),
    );
  }
  return String(value);
}
