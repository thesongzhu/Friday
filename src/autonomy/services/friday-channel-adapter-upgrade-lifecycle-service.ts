import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import { resolveSafePath, safeDirName } from "#utilities";
import type { FridayChannelRegistry, FridayChannelRegistryView } from "../../channels/friday-channel-registry.js";
import type { FridayAutonomyCanaryStats } from "../model/friday-autonomy-upgrade.types.js";
import type { FridayAutonomySubjectUpgradeStateRepository } from "../persistence/friday-autonomy-subject-upgrade-state-repository.js";
import type { FridayAutonomySubjectUpgradeState } from "../persistence/friday-autonomy-subject-upgrade-state-repository.js";
import {
  createFridayMutatingActionDigest,
  type FridayCanonicalApprovalResolution,
  type FridayMutatingActionActor,
  type FridayMutatingActionGate,
  type FridayMutatingActionRequest,
  type FridayMutatingActionRollbackScope,
  type FridayMutatingActionTicket,
} from "../../security/friday-mutating-action-gate.js";

type FridayChannelAdapterLifecycleAction = "shadow" | "canary" | "promote" | "rollback";

export interface FridayChannelAdapterLifecycleApprovalRequestInput {
  action: FridayChannelAdapterLifecycleAction;
  channelKind: string;
  shadowVersionId?: string;
  runtimeVersion: string;
  providerModel?: string;
  actor: FridayMutatingActionActor;
  surface: string;
  planDigest: string;
  idempotencyKey?: string;
  rollback?: FridayMutatingActionRollbackScope;
}

export interface FridayChannelAdapterLifecycleEvidenceSummary {
  channelKind: string;
  shadowVersionId?: string;
  stage: "shadow" | "canary" | "active" | "rolled_back";
  lastEventAt: string;
  canarySuccessCount: number;
  canaryFailureCount: number;
  rollbackPointerAvailable: boolean;
  runtimeStatus?: string;
  credentialStatus?: string;
}

export interface FridayChannelAdapterUpgradeLifecycleService {
  registerShadowVersion(input: {
    channelKind: string;
    shadowVersionId: string;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): void;
  recordCanaryResult(input: {
    channelKind: string;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): void;
  promote(input: {
    channelKind: string;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): void;
  rollback(input: {
    channelKind: string;
    runtimeVersion: string;
    providerModel?: string;
    reason?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): void;
  getLifecycleEvidence(input: { channelKind: string }): FridayChannelAdapterLifecycleEvidenceSummary | null;
}

export interface CreateFridayChannelAdapterUpgradeLifecycleServiceDeps {
  db: FridaySqliteLayer;
  stateRepo: FridayAutonomySubjectUpgradeStateRepository;
  channelRegistry: Pick<FridayChannelRegistry, "describe">;
  nowIso: () => string;
  stateDir?: string;
  canonicalMutationGate?: FridayMutatingActionGate;
}

interface ChannelAdapterLifecycleSnapshot {
  lastVerifiedAt?: string;
  lastVerifiedRuntimeVersion?: string;
  lastVerifiedProviderModel?: string;
  compatibilityStatus: FridayAutonomySubjectUpgradeState["compatibilityStatus"];
  promotionChannel: FridayAutonomySubjectUpgradeState["promotionChannel"];
  shadowVersionId?: string;
  canaryStats?: FridayAutonomyCanaryStats;
}

interface ChannelAdapterLifecycleEvidenceRecord {
  schemaVersion: "friday.channel_adapter.lifecycle.phase4A.1.v1";
  channelKind: string;
  events: Array<Record<string, unknown>>;
  shadow?: {
    shadowVersionId: string;
    channelConfigDigest: string;
    shadowedAt: string;
    ticketId: string;
    actionDigest: string;
    planDigest?: string;
    previous: ChannelAdapterLifecycleSnapshot;
  };
  canaryRuns: Array<{
    runId: string;
    shadowVersionId?: string;
    runtimeVersion: string;
    providerModel?: string;
    success: boolean;
    status: string;
    running: boolean;
    healthState?: string;
    credentialStatus?: string;
    blockedReason?: string;
    ticketId: string;
    actionDigest: string;
    planDigest?: string;
    startedAt: string;
    endedAt: string;
  }>;
  promotion?: {
    promotedAt: string;
    shadowVersionId?: string;
    runtimeVersion: string;
    providerModel?: string;
    ticketId: string;
    actionDigest: string;
    planDigest: string;
  };
  rollback?: {
    rolledBackAt: string;
    reason?: string;
    result: "restored_previous_channel_adapter_lifecycle_state";
    ticketId: string;
    actionDigest: string;
    planDigest: string;
  };
}

export function createFridayChannelAdapterLifecycleMutatingActionRequest(
  input: FridayChannelAdapterLifecycleApprovalRequestInput,
): FridayMutatingActionRequest {
  const parameters = {
    channelKind: input.channelKind,
    shadowVersionId: input.shadowVersionId,
    runtimeVersion: input.runtimeVersion,
    providerModel: input.providerModel,
  };
  return {
    action: `channel_adapters.lifecycle.${input.action}`,
    actor: input.actor,
    surface: input.surface,
    resource: {
      type: "channel_adapter_lifecycle",
      id: input.channelKind,
      digest: hashStableJson(parameters),
      attributes: {
        channelKind: input.channelKind,
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
        guardId: "channel_adapter_lifecycle_guard",
        decision: "requires_approval",
        risk: "high",
        reason: `channel_adapter_${input.action}_requires_canonical_approval`,
      },
    ],
  };
}

export function createFridayChannelAdapterUpgradeLifecycleService(
  deps: CreateFridayChannelAdapterUpgradeLifecycleServiceDeps,
): FridayChannelAdapterUpgradeLifecycleService {
  function requireChannel(channelKind: string): FridayChannelRegistryView {
    const channel = deps.channelRegistry.describe(channelKind);
    if (!channel) {
      throw new FridayDomainError(
        "CHANNEL_ADAPTER_NOT_FOUND",
        `Channel adapter ${channelKind} not found`,
        { httpStatus: 404 },
      );
    }
    return channel;
  }

  function getCanaryStats(channelKind: string): FridayAutonomyCanaryStats {
    const state = deps.db.withReadConnection((db) => deps.stateRepo.get(db, "channel_adapter", channelKind));
    return state?.canaryStats ?? {
      sampleSize: 0,
      successCount: 0,
      failureCount: 0,
      rollbackCount: 0,
    };
  }

  function update(
    channelKind: string,
    patch: Parameters<FridayAutonomySubjectUpgradeStateRepository["setUpgradeMetadata"]>[3],
  ): void {
    requireChannel(channelKind);
    deps.db.withWriteTransaction((db) => {
      deps.stateRepo.setUpgradeMetadata(db, "channel_adapter", channelKind, patch, deps.nowIso());
    });
  }

  function getState(channelKind: string): FridayAutonomySubjectUpgradeState | null {
    return deps.db.withReadConnection((db) => deps.stateRepo.get(db, "channel_adapter", channelKind));
  }

  function snapshotState(channelKind: string): ChannelAdapterLifecycleSnapshot {
    const state = getState(channelKind);
    return {
      lastVerifiedAt: state?.lastVerifiedAt,
      lastVerifiedRuntimeVersion: state?.lastVerifiedRuntimeVersion,
      lastVerifiedProviderModel: state?.lastVerifiedProviderModel,
      compatibilityStatus: state?.compatibilityStatus ?? "unknown",
      promotionChannel: state?.promotionChannel ?? "none",
      shadowVersionId: state?.shadowVersionId,
      canaryStats: state?.canaryStats,
    };
  }

  function requireCanonicalLifecycleTicket(input: {
    action: FridayChannelAdapterLifecycleAction;
    channelKind: string;
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
        "CHANNEL_ADAPTER_LIFECYCLE_CANONICAL_GATE_UNAVAILABLE",
        "Channel adapter lifecycle actions require the canonical approval gate.",
        { httpStatus: 503 },
      );
    }
    const planDigest = input.planDigest;
    if (!planDigest) {
      throw new FridayDomainError(
        "CHANNEL_ADAPTER_LIFECYCLE_PLAN_DIGEST_REQUIRED",
        "Channel adapter lifecycle actions require an approved plan digest.",
        { httpStatus: 403, details: { channelKind: input.channelKind } },
      );
    }
    const request = createFridayChannelAdapterLifecycleMutatingActionRequest({
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
          ? "CHANNEL_ADAPTER_LIFECYCLE_CANONICAL_APPROVAL_REQUIRED"
          : "CHANNEL_ADAPTER_LIFECYCLE_CANONICAL_APPROVAL_DENIED",
        gateResult.decision === "requires_approval"
          ? `Channel adapter lifecycle ${input.action} requires canonical approval before any mutation.`
          : `Channel adapter lifecycle ${input.action} was blocked by the canonical approval gate: ${gateResult.reason}`,
        {
          httpStatus: gateResult.decision === "requires_approval" ? 403 : 409,
          details: {
            channelKind: input.channelKind,
            action: input.action,
            actionDigest: gateResult.actionDigest,
            reason: gateResult.reason,
          },
        },
      );
    }
    return gateResult.ticket;
  }

  function evidencePath(channelKind: string): string {
    if (!deps.stateDir) {
      throw new FridayDomainError(
        "CHANNEL_ADAPTER_LIFECYCLE_EVIDENCE_STATE_DIR_REQUIRED",
        "Channel adapter lifecycle mutations require durable evidence storage.",
        { httpStatus: 503, details: { channelKind } },
      );
    }
    const root = resolveSafePath(deps.stateDir, "channel-adapter-lifecycle");
    return resolveSafePath(root, `${safeDirName(channelKind)}.json`);
  }

  function readEvidence(channelKind: string): ChannelAdapterLifecycleEvidenceRecord {
    const file = evidencePath(channelKind);
    if (file && existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as ChannelAdapterLifecycleEvidenceRecord;
      return {
        ...parsed,
        events: Array.isArray(parsed.events) ? parsed.events : [],
        canaryRuns: Array.isArray(parsed.canaryRuns) ? parsed.canaryRuns : [],
      };
    }
    return {
      schemaVersion: "friday.channel_adapter.lifecycle.phase4A.1.v1",
      channelKind,
      events: [],
      canaryRuns: [],
    };
  }

  function writeEvidence(record: ChannelAdapterLifecycleEvidenceRecord): void {
    const file = evidencePath(record.channelKind);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  function updateEvidence(
    channelKind: string,
    updateRecord: (record: ChannelAdapterLifecycleEvidenceRecord) => void,
  ): ChannelAdapterLifecycleEvidenceRecord {
    const record = readEvidence(channelKind);
    updateRecord(record);
    writeEvidence(record);
    return record;
  }

  function channelConfigDigest(channelKind: string): string {
    const channel = requireChannel(channelKind);
    return hashStableJson({
      kind: channel.kind,
      status: channel.status,
      running: channel.running,
      health: {
        state: channel.health.state,
        credentialStatus: channel.health.credentialStatus,
        blockedReason: channel.health.blockedReason,
      },
      authMode: typeof channel.diagnostics?.authMode === "string" ? channel.diagnostics.authMode : undefined,
      allowlist: channel.allowlist,
      contract: channel.contract,
    });
  }

  function runChannelCanaryProbe(channelKind: string): {
    success: boolean;
    status: string;
    running: boolean;
    healthState?: string;
    credentialStatus?: string;
    blockedReason?: string;
  } {
    const channel = requireChannel(channelKind);
    const credentialStatus = channel.health.credentialStatus;
    const success = channel.running
      && channel.status === "connected"
      && channel.health.state === "connected"
      && credentialStatus !== "missing"
      && credentialStatus !== "invalid"
      && !channel.health.blockedReason;
    return {
      success,
      status: channel.status,
      running: channel.running,
      healthState: channel.health.state,
      credentialStatus,
      blockedReason: channel.health.blockedReason,
    };
  }

  return {
    registerShadowVersion(input) {
      const ticket = requireCanonicalLifecycleTicket({
        action: "shadow",
        channelKind: input.channelKind,
        shadowVersionId: input.shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
      });
      const previous = snapshotState(input.channelKind);
      const digest = channelConfigDigest(input.channelKind);
      updateEvidence(input.channelKind, (record) => {
        record.events.push({
          type: "shadow",
          at: deps.nowIso(),
          shadowVersionId: input.shadowVersionId,
          ticketId: ticket.ticketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
        });
        record.shadow = {
          shadowVersionId: input.shadowVersionId,
          channelConfigDigest: digest,
          shadowedAt: deps.nowIso(),
          ticketId: ticket.ticketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
          previous,
        };
        record.canaryRuns = [];
        delete record.promotion;
        delete record.rollback;
      });
      update(input.channelKind, {
        compatibilityStatus: "adaptation_required",
        promotionChannel: "shadow",
        shadowVersionId: input.shadowVersionId,
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
    },

    recordCanaryResult(input) {
      const state = getState(input.channelKind);
      const shadowVersionId = state?.shadowVersionId;
      if (state?.promotionChannel !== "shadow" && state?.promotionChannel !== "canary") {
        throw new FridayDomainError(
          "CHANNEL_ADAPTER_CANARY_REQUIRES_SHADOW",
          "Channel adapter canary requires a shadow lifecycle state first.",
          { httpStatus: 409, details: { channelKind: input.channelKind } },
        );
      }
      const ticket = requireCanonicalLifecycleTicket({
        action: "canary",
        channelKind: input.channelKind,
        shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
      });
      const current = getCanaryStats(input.channelKind);
      const startedAt = deps.nowIso();
      const runId = `channel_canary_${createHash("sha256")
        .update(`${input.channelKind}:${startedAt}:${ticket.actionDigest}`)
        .digest("hex")
        .slice(0, 16)}`;
      const probe = runChannelCanaryProbe(input.channelKind);
      const endedAt = deps.nowIso();
      updateEvidence(input.channelKind, (record) => {
        record.events.push({
          type: "canary",
          at: endedAt,
          success: probe.success,
          runId,
          runtimeVersion: input.runtimeVersion,
          providerModel: input.providerModel,
          ticketId: ticket.ticketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
        });
        record.canaryRuns.push({
          runId,
          shadowVersionId,
          runtimeVersion: input.runtimeVersion,
          providerModel: input.providerModel,
          success: probe.success,
          status: probe.status,
          running: probe.running,
          healthState: probe.healthState,
          credentialStatus: probe.credentialStatus,
          blockedReason: probe.blockedReason,
          ticketId: ticket.ticketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
          startedAt,
          endedAt,
        });
      });
      update(input.channelKind, {
        compatibilityStatus: probe.success ? "compatible" : "adaptation_required",
        promotionChannel: "canary",
        canaryStats: {
          sampleSize: current.sampleSize + 1,
          successCount: current.successCount + (probe.success ? 1 : 0),
          failureCount: current.failureCount + (probe.success ? 0 : 1),
          rollbackCount: current.rollbackCount,
          lastEvaluatedAt: endedAt,
        },
      });
      if (!probe.success) {
        throw new FridayDomainError(
          "CHANNEL_ADAPTER_CANARY_RUNTIME_PROOF_FAILED",
          `Channel adapter ${input.channelKind} failed lifecycle canary smoke.`,
          { httpStatus: 424, details: { channelKind: input.channelKind, runId, probe } },
        );
      }
    },

    promote(input) {
      const current = getState(input.channelKind);
      const evidence = readEvidence(input.channelKind);
      if (current?.promotionChannel !== "canary") {
        throw new FridayDomainError(
          "CHANNEL_ADAPTER_PROMOTE_REQUIRES_CANARY",
          "Channel adapter promote requires a canary lifecycle state first.",
          { httpStatus: 409, details: { channelKind: input.channelKind } },
        );
      }
      if (!current.shadowVersionId || !evidence.shadow) {
        throw new FridayDomainError(
          "CHANNEL_ADAPTER_PROMOTE_REQUIRES_ROLLBACK_POINTER",
          "Channel adapter promote requires a shadow rollback pointer.",
          { httpStatus: 409, details: { channelKind: input.channelKind } },
        );
      }
      const canaryRuns = evidence.canaryRuns.filter((run) =>
        run.shadowVersionId === current.shadowVersionId
          && run.runtimeVersion === input.runtimeVersion
          && run.providerModel === input.providerModel,
      );
      const canarySuccessCount = canaryRuns.filter((run) => run.success).length;
      const canaryFailureCount = canaryRuns.filter((run) => !run.success).length;
      if (canarySuccessCount < 1 || canaryFailureCount > 0) {
        throw new FridayDomainError(
          "CHANNEL_ADAPTER_PROMOTE_REQUIRES_GREEN_CANARY",
          "Channel adapter promote requires at least one successful canary and zero failed canaries for the same shadow/runtime/provider tuple.",
          {
            httpStatus: 409,
            details: {
              channelKind: input.channelKind,
              shadowVersionId: current.shadowVersionId,
              runtimeVersion: input.runtimeVersion,
              providerModel: input.providerModel,
              canarySuccessCount,
              canaryFailureCount,
            },
          },
        );
      }
      const ticket = requireCanonicalLifecycleTicket({
        action: "promote",
        channelKind: input.channelKind,
        shadowVersionId: current.shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
      });
      const promotedAt = deps.nowIso();
      updateEvidence(input.channelKind, (record) => {
        record.events.push({
          type: "promote",
          at: promotedAt,
          runtimeVersion: input.runtimeVersion,
          providerModel: input.providerModel,
          ticketId: ticket.ticketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
        });
        record.promotion = {
          promotedAt,
          shadowVersionId: current.shadowVersionId,
          runtimeVersion: input.runtimeVersion,
          providerModel: input.providerModel,
          ticketId: ticket.ticketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest!,
        };
      });
      update(input.channelKind, {
        compatibilityStatus: "compatible",
        promotionChannel: "active",
        shadowVersionId: current?.shadowVersionId ?? null,
        canaryStats: current?.canaryStats ?? null,
        lastVerifiedAt: promotedAt,
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
    },

    rollback(input) {
      const evidence = readEvidence(input.channelKind);
      const rollbackTarget = evidence.shadow?.previous;
      if (!evidence.promotion || !rollbackTarget) {
        throw new FridayDomainError(
          "CHANNEL_ADAPTER_ROLLBACK_REQUIRES_PROMOTION_EVIDENCE",
          "Channel adapter rollback requires promotion evidence and a rollback pointer.",
          { httpStatus: 409, details: { channelKind: input.channelKind } },
        );
      }
      const ticket = requireCanonicalLifecycleTicket({
        action: "rollback",
        channelKind: input.channelKind,
        shadowVersionId: evidence.promotion.shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
        rollback: { planned: true, planDigest: input.planDigest, actions: ["channel_adapters.lifecycle.promote"] },
      });
      const rolledBackAt = deps.nowIso();
      updateEvidence(input.channelKind, (record) => {
        record.events.push({
          type: "rollback",
          at: rolledBackAt,
          ticketId: ticket.ticketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
          reason: input.reason,
        });
        record.rollback = {
          rolledBackAt,
          reason: input.reason,
          result: "restored_previous_channel_adapter_lifecycle_state",
          ticketId: ticket.ticketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest!,
        };
      });
      update(input.channelKind, {
        compatibilityStatus: rollbackTarget.compatibilityStatus === "compatible" && rollbackTarget.promotionChannel === "active"
          ? "compatible"
          : "adaptation_required",
        promotionChannel: rollbackTarget.promotionChannel === "active" ? "active" : "rolled_back",
        shadowVersionId: rollbackTarget.shadowVersionId ?? null,
        canaryStats: {
          sampleSize: rollbackTarget.canaryStats?.sampleSize ?? 0,
          successCount: rollbackTarget.canaryStats?.successCount ?? 0,
          failureCount: rollbackTarget.canaryStats?.failureCount ?? 0,
          rollbackCount: (rollbackTarget.canaryStats?.rollbackCount ?? 0) + 1,
          lastEvaluatedAt: rolledBackAt,
        },
        lastVerifiedAt: rollbackTarget.lastVerifiedAt ?? null,
        lastVerifiedRuntimeVersion: rollbackTarget.lastVerifiedRuntimeVersion ?? null,
        lastVerifiedProviderModel: rollbackTarget.lastVerifiedProviderModel ?? null,
      });
    },

    getLifecycleEvidence(input) {
      const state = getState(input.channelKind);
      if (!state) {
        return null;
      }
      const record = readEvidence(input.channelKind);
      const lastEvent = record.events.at(-1);
      return {
        channelKind: input.channelKind,
        shadowVersionId: state.shadowVersionId,
        stage: state.promotionChannel === "active"
          ? "active"
          : state.promotionChannel === "rolled_back"
            ? "rolled_back"
            : state.promotionChannel === "canary"
              ? "canary"
              : "shadow",
        lastEventAt: typeof lastEvent?.at === "string" ? lastEvent.at : state.updatedAt,
        canarySuccessCount: state.canaryStats?.successCount ?? 0,
        canaryFailureCount: state.canaryStats?.failureCount ?? 0,
        rollbackPointerAvailable: Boolean(record.shadow?.previous),
        runtimeStatus: record.canaryRuns.at(-1)?.status,
        credentialStatus: record.canaryRuns.at(-1)?.credentialStatus,
      };
    },
  };
}

function hashStableJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
