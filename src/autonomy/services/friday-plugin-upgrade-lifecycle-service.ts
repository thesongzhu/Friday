import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import { resolveSafePath, safeDirName } from "#utilities";
import { redactContext } from "../../rules/engine/context-redactor.js";
import type { JsonObject } from "../../rules/model/friday-rules-engine.types.js";
import type { FridayPluginRepository } from "../../plugins/persistence/friday-plugin-repository.js";
import type { FridayAutonomyCanaryStats } from "../model/friday-autonomy-upgrade.types.js";
import type { FridayPluginEntity } from "../../plugins/model/friday-plugin.types.js";
import type { FridayPluginService } from "../../plugins/services/friday-plugin-service.types.js";
import {
  type FridayCanonicalApprovalResolution,
  type FridayMutatingActionActor,
  type FridayMutatingActionGate,
  type FridayMutatingActionRequest,
  type FridayMutatingActionRollbackScope,
  type FridayMutatingActionTicket,
} from "../../security/friday-mutating-action-gate.js";

type FridayPluginLifecycleAction = "shadow" | "canary" | "promote" | "rollback";

export interface FridayPluginLifecycleApprovalRequestInput {
  action: FridayPluginLifecycleAction;
  pluginId: string;
  shadowVersionId?: string;
  runtimeVersion: string;
  providerModel?: string;
  actor: FridayMutatingActionActor;
  surface: string;
  planDigest: string;
  idempotencyKey?: string;
  rollback?: FridayMutatingActionRollbackScope;
}

export interface FridayPluginLifecycleEvidenceSummary {
  pluginId: string;
  shadowVersionId?: string;
  stage: "shadow" | "canary" | "active" | "rolled_back";
  lastEventAt: string;
  canarySuccessCount: number;
  canaryFailureCount: number;
  rollbackPointerAvailable: boolean;
  pluginArtifactDigest?: string;
  previousPluginArtifactDigest?: string;
  parentLifecycleTicketId?: string;
  restoredPluginArtifactDigest?: string;
  planDigest?: string;
}

export interface FridayPluginUpgradeLifecycleService {
  registerShadowVersion(input: {
    pluginId: string;
    shadowVersionId: string;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): FridayPluginEntity;
  recordCanaryResult(input: {
    pluginId: string;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): Promise<FridayPluginEntity>;
  promote(input: {
    pluginId: string;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): Promise<FridayPluginEntity>;
  rollback(input: {
    pluginId: string;
    runtimeVersion: string;
    providerModel?: string;
    reason?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): Promise<FridayPluginEntity>;
  getLifecycleEvidence(input: { pluginId: string }): FridayPluginLifecycleEvidenceSummary | null;
}

export interface CreateFridayPluginUpgradeLifecycleServiceDeps {
  db: FridaySqliteLayer;
  pluginRepo: FridayPluginRepository;
  nowIso: () => string;
  stateDir?: string;
  pluginRuntime?: Pick<FridayPluginService, "enablePlugin" | "disablePlugin" | "isPluginRuntimeLoaded">;
  canonicalMutationGate?: FridayMutatingActionGate;
  rollbackSnapshotSecret?: string;
}

interface PluginArtifactSnapshot {
  id: FridayPluginEntity["id"];
  name: FridayPluginEntity["name"];
  description: FridayPluginEntity["description"];
  version: FridayPluginEntity["version"];
  source: FridayPluginEntity["source"];
  trustMode: FridayPluginEntity["trustMode"];
  installPath: FridayPluginEntity["installPath"];
  kinds: FridayPluginEntity["kinds"];
  manifest: FridayPluginEntity["manifest"];
  config: FridayPluginEntity["config"];
  signatureAlgorithm: FridayPluginEntity["signatureAlgorithm"];
  signatureKeyId: FridayPluginEntity["signatureKeyId"];
  signatureValue: FridayPluginEntity["signatureValue"];
  signatureVerified: FridayPluginEntity["signatureVerified"];
  trustedFingerprintSha256: FridayPluginEntity["trustedFingerprintSha256"];
}

interface PluginLifecycleSnapshot {
  artifact: PluginArtifactSnapshot;
  artifactDigest: string;
  status: FridayPluginEntity["status"];
  enabled: boolean;
  lastVerifiedAt?: string | null;
  lastVerifiedRuntimeVersion?: string | null;
  lastVerifiedProviderModel?: string | null;
  compatibilityStatus: FridayPluginEntity["compatibilityStatus"];
  promotionChannel: FridayPluginEntity["promotionChannel"];
  shadowVersionId?: string | null;
  canaryStats?: FridayAutonomyCanaryStats;
}

interface PluginPublicArtifactSnapshot extends Omit<PluginArtifactSnapshot, "config" | "signatureValue"> {
  configDigest: string;
  configRedacted: true;
  signatureValueDigest: string | null;
  signatureValueRedacted: boolean;
}

interface PluginLifecyclePublicSnapshot extends Omit<PluginLifecycleSnapshot, "artifact"> {
  artifact: PluginPublicArtifactSnapshot;
}

interface EncryptedRollbackSnapshotRecord {
  schemaVersion: "friday.plugin.lifecycle.rollback_snapshot.v1";
  pluginId: string;
  snapshotDigest: string;
  envelope: {
    ciphertext: string;
    iv: string;
    tag: string;
  };
}

interface PluginLifecycleEvidenceRecord {
  schemaVersion: "friday.plugin.lifecycle.phase3.2D.v1";
  pluginId: string;
  events: Array<Record<string, unknown>>;
  shadow?: {
    shadowVersionId: string;
    pluginArtifactDigest: string;
    previousPluginArtifactDigest: string;
    shadowedAt: string;
    ticketId: string;
    parentLifecycleTicketId?: string;
    actionDigest: string;
    planDigest?: string;
    previous: PluginLifecyclePublicSnapshot;
  };
  canaryRuns: Array<{
    runId: string;
    shadowVersionId?: string;
    success: boolean;
    errorCode?: string;
    errorMessage?: string;
    ticketId: string;
    parentLifecycleTicketId?: string;
    actionDigest: string;
    planDigest?: string;
    cleanupVerified?: boolean;
    cleanupRequiresManualAction?: boolean;
    startedAt: string;
    endedAt: string;
  }>;
  promotion?: {
    promotedAt: string;
    shadowVersionId?: string;
    ticketId: string;
    parentLifecycleTicketId?: string;
    actionDigest: string;
    planDigest: string;
  };
  rollback?: {
    rolledBackAt: string;
    reason?: string;
    result: "restored_previous_plugin_lifecycle_state";
    ticketId: string;
    parentLifecycleTicketId?: string;
    actionDigest: string;
    planDigest: string;
    fromPluginArtifactDigest: string;
    toPluginArtifactDigest: string;
    restoredPluginArtifactDigest: string;
  };
}

export function createFridayPluginLifecycleMutatingActionRequest(
  input: FridayPluginLifecycleApprovalRequestInput,
): FridayMutatingActionRequest {
  const parameters = {
    pluginId: input.pluginId,
    shadowVersionId: input.shadowVersionId,
    runtimeVersion: input.runtimeVersion,
    providerModel: input.providerModel,
  };
  return {
    action: `plugins.lifecycle.${input.action}`,
    actor: input.actor,
    surface: input.surface,
    resource: {
      type: "external_plugin_lifecycle",
      id: input.pluginId,
      digest: hashStableJson(parameters),
      attributes: {
        pluginId: input.pluginId,
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
        guardId: "plugin_lifecycle_guard",
        decision: "requires_approval",
        risk: "high",
        reason: `plugin_${input.action}_requires_canonical_approval`,
      },
    ],
  };
}

export function createFridayPluginUpgradeLifecycleService(
  deps: CreateFridayPluginUpgradeLifecycleServiceDeps,
): FridayPluginUpgradeLifecycleService {
  function getPlugin(pluginId: string): FridayPluginEntity {
    const plugin = deps.db.withReadConnection((db) => deps.pluginRepo.getById(db, pluginId));
    if (!plugin) {
      throw new FridayDomainError("PLUGIN_NOT_FOUND", `Plugin ${pluginId} not found`, { httpStatus: 404 });
    }
    return plugin;
  }

  function updatePlugin(
    pluginId: string,
    patch: Parameters<FridayPluginRepository["setUpgradeMetadata"]>[2],
  ): FridayPluginEntity {
    return deps.db.withWriteTransaction((db) => deps.pluginRepo.setUpgradeMetadata(db, pluginId, patch, deps.nowIso()));
  }

  function restorePluginSnapshot(
    pluginId: string,
    snapshot: PluginLifecycleSnapshot,
    canaryStats: FridayAutonomyCanaryStats,
  ): FridayPluginEntity {
    return deps.db.withWriteTransaction((db) => {
      const restored = deps.pluginRepo.upsertPlugin(db, {
        id: snapshot.artifact.id,
        name: snapshot.artifact.name,
        description: snapshot.artifact.description,
        version: snapshot.artifact.version,
        source: snapshot.artifact.source,
        status: snapshot.status,
        enabled: snapshot.enabled,
        trustMode: snapshot.artifact.trustMode,
        installPath: snapshot.artifact.installPath,
        kinds: snapshot.artifact.kinds,
        manifest: snapshot.artifact.manifest,
        config: snapshot.artifact.config,
        signatureAlgorithm: snapshot.artifact.signatureAlgorithm ?? undefined,
        signatureKeyId: snapshot.artifact.signatureKeyId ?? undefined,
        signatureValue: snapshot.artifact.signatureValue ?? undefined,
        signatureVerified: snapshot.artifact.signatureVerified,
        trustedFingerprintSha256: snapshot.artifact.trustedFingerprintSha256 ?? undefined,
        lastVerifiedAt: snapshot.lastVerifiedAt ?? undefined,
        lastVerifiedRuntimeVersion: snapshot.lastVerifiedRuntimeVersion ?? undefined,
        lastVerifiedProviderModel: snapshot.lastVerifiedProviderModel ?? undefined,
        compatibilityStatus: snapshot.compatibilityStatus,
        promotionChannel: snapshot.promotionChannel,
        shadowVersionId: snapshot.shadowVersionId ?? undefined,
        canaryStats,
        nowIso: deps.nowIso(),
      });
      deps.pluginRepo.setUpgradeMetadata(db, pluginId, {
        compatibilityStatus: snapshot.compatibilityStatus,
        promotionChannel: snapshot.promotionChannel,
        shadowVersionId: snapshot.shadowVersionId ?? null,
        canaryStats,
        lastVerifiedRuntimeVersion: snapshot.lastVerifiedRuntimeVersion ?? null,
        lastVerifiedProviderModel: snapshot.lastVerifiedProviderModel ?? null,
      }, deps.nowIso());
      return restored;
    });
  }

  function forceRestorePluginRuntimeState(
    pluginId: string,
    snapshot: PluginLifecycleSnapshot,
  ): FridayPluginEntity {
    return deps.db.withWriteTransaction((db) => {
      deps.pluginRepo.setStatus(db, pluginId, snapshot.status, deps.nowIso());
      deps.pluginRepo.setEnabled(db, pluginId, snapshot.enabled, deps.nowIso());
      deps.pluginRepo.setError(
        db,
        pluginId,
        "PLUGIN_LIFECYCLE_CANARY_FAILED",
        "Plugin lifecycle canary failed; runtime state was restored.",
        deps.nowIso(),
      );
      deps.pluginRepo.setStatus(db, pluginId, snapshot.status, deps.nowIso());
      deps.pluginRepo.setEnabled(db, pluginId, snapshot.enabled, deps.nowIso());
      return deps.pluginRepo.getById(db, pluginId)!;
    });
  }

  function markCanaryCleanupUnverified(pluginId: string, error: unknown): FridayPluginEntity {
    return deps.db.withWriteTransaction((db) => {
      deps.pluginRepo.setError(
        db,
        pluginId,
        "PLUGIN_LIFECYCLE_CANARY_CLEANUP_UNVERIFIED",
        `Plugin lifecycle canary cleanup could not verify the runtime is unloaded: ${redactPluginLifecycleErrorMessage(error)}`,
        deps.nowIso(),
      );
      deps.pluginRepo.setEnabled(db, pluginId, true, deps.nowIso());
      return deps.pluginRepo.getById(db, pluginId)!;
    });
  }

  function requireCanonicalLifecycleTicket(input: {
    action: FridayPluginLifecycleAction;
    pluginId: string;
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
        "PLUGIN_LIFECYCLE_CANONICAL_GATE_UNAVAILABLE",
        "Plugin lifecycle actions require the canonical approval gate.",
        { httpStatus: 503 },
      );
    }
    const planDigest = input.planDigest;
    if (!planDigest) {
      throw new FridayDomainError(
        "PLUGIN_LIFECYCLE_PLAN_DIGEST_REQUIRED",
        "Plugin lifecycle actions require an approved plan digest.",
        { httpStatus: 403, details: { pluginId: input.pluginId } },
      );
    }

    const request = createFridayPluginLifecycleMutatingActionRequest({
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
          ? "PLUGIN_LIFECYCLE_CANONICAL_APPROVAL_REQUIRED"
          : "PLUGIN_LIFECYCLE_CANONICAL_APPROVAL_DENIED",
        gateResult.decision === "requires_approval"
          ? `Plugin lifecycle ${input.action} requires canonical approval before any mutation.`
          : `Plugin lifecycle ${input.action} was blocked by the canonical approval gate: ${gateResult.reason}`,
        {
          httpStatus: gateResult.decision === "requires_approval" ? 403 : 409,
          details: {
            pluginId: input.pluginId,
            action: input.action,
            actionDigest: gateResult.actionDigest,
            reason: gateResult.reason,
          },
        },
      );
    }
    return gateResult.ticket;
  }

  function snapshotPluginArtifact(plugin: FridayPluginEntity): PluginArtifactSnapshot {
    return {
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      version: plugin.version,
      source: plugin.source,
      trustMode: plugin.trustMode,
      installPath: plugin.installPath,
      kinds: plugin.kinds,
      manifest: plugin.manifest,
      config: plugin.config,
      signatureAlgorithm: plugin.signatureAlgorithm,
      signatureKeyId: plugin.signatureKeyId,
      signatureValue: plugin.signatureValue,
      signatureVerified: plugin.signatureVerified,
      trustedFingerprintSha256: plugin.trustedFingerprintSha256,
    };
  }

  function snapshotPlugin(pluginId: string): PluginLifecycleSnapshot {
    const plugin = getPlugin(pluginId);
    const artifact = snapshotPluginArtifact(plugin);
    return {
      artifact,
      artifactDigest: pluginArtifactDigestFromSnapshot(artifact),
      status: plugin.status,
      enabled: plugin.enabled,
      lastVerifiedAt: plugin.lastVerifiedAt,
      lastVerifiedRuntimeVersion: plugin.lastVerifiedRuntimeVersion,
      lastVerifiedProviderModel: plugin.lastVerifiedProviderModel,
      compatibilityStatus: plugin.compatibilityStatus,
      promotionChannel: plugin.promotionChannel,
      shadowVersionId: plugin.shadowVersionId,
      canaryStats: plugin.canaryStats,
    };
  }

  function redactPluginLifecycleSnapshot(snapshot: PluginLifecycleSnapshot): PluginLifecyclePublicSnapshot {
    const {
      config,
      signatureValue,
      ...publicArtifact
    } = snapshot.artifact;
    return {
      ...snapshot,
      artifact: {
        ...publicArtifact,
        configDigest: hashStableJson(config),
        configRedacted: true,
        signatureValueDigest: signatureValue ? hashStableJson(signatureValue) : null,
        signatureValueRedacted: signatureValue !== null,
      },
    };
  }

  function evidencePath(pluginId: string): string | null {
    if (!deps.stateDir) return null;
    const root = resolveSafePath(deps.stateDir, "plugin-lifecycle");
    return resolveSafePath(root, `${safeDirName(pluginId)}.json`);
  }

  function readEvidence(pluginId: string): PluginLifecycleEvidenceRecord {
    const file = evidencePath(pluginId);
    if (file && existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as PluginLifecycleEvidenceRecord;
      return {
        ...parsed,
        events: Array.isArray(parsed.events) ? parsed.events : [],
        canaryRuns: Array.isArray(parsed.canaryRuns) ? parsed.canaryRuns : [],
      };
    }
    return {
      schemaVersion: "friday.plugin.lifecycle.phase3.2D.v1",
      pluginId,
      events: [],
      canaryRuns: [],
    };
  }

  function writeEvidence(record: PluginLifecycleEvidenceRecord): void {
    const file = evidencePath(record.pluginId);
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  function updateEvidence(
    pluginId: string,
    updateRecord: (record: PluginLifecycleEvidenceRecord) => void,
  ): PluginLifecycleEvidenceRecord {
    const record = readEvidence(pluginId);
    updateRecord(record);
    writeEvidence(record);
    return record;
  }

  function pluginArtifactDigestFromSnapshot(snapshot: PluginArtifactSnapshot): string {
    return hashStableJson({
      id: snapshot.id,
      version: snapshot.version,
      installPath: snapshot.installPath,
      manifest: snapshot.manifest,
      signatureVerified: snapshot.signatureVerified,
      trustedFingerprintSha256: snapshot.trustedFingerprintSha256,
    });
  }

  function pluginArtifactDigest(pluginId: string): string {
    return pluginArtifactDigestFromSnapshot(snapshotPluginArtifact(getPlugin(pluginId)));
  }

  function requirePluginInactiveForShadow(plugin: FridayPluginEntity): void {
    if (plugin.enabled || plugin.status === "enabled" || plugin.status === "running") {
      throw new FridayDomainError(
        "PLUGIN_LIFECYCLE_SHADOW_REQUIRES_INACTIVE_PLUGIN",
        "Plugin shadow lifecycle requires the plugin to be disabled or not running before staging.",
        {
          httpStatus: 409,
          details: { pluginId: plugin.id, status: plugin.status, enabled: plugin.enabled },
        },
      );
    }
  }

  function requireRuntime(): Pick<FridayPluginService, "enablePlugin" | "disablePlugin" | "isPluginRuntimeLoaded"> {
    if (!deps.pluginRuntime) {
      throw new FridayDomainError(
        "PLUGIN_LIFECYCLE_RUNTIME_UNAVAILABLE",
        "Plugin lifecycle canary and promote require the plugin runtime service.",
        { httpStatus: 503 },
      );
    }
    return deps.pluginRuntime;
  }

  function rollbackSnapshotPath(pluginId: string): string | null {
    if (!deps.stateDir) return null;
    const root = resolveSafePath(deps.stateDir, "plugin-lifecycle-private");
    return resolveSafePath(root, `${safeDirName(pluginId)}.rollback.json`);
  }

  function requireRollbackSnapshotSecret(pluginId: string): string {
    if (!deps.rollbackSnapshotSecret) {
      throw new FridayDomainError(
        "PLUGIN_ROLLBACK_SNAPSHOT_SECRET_REQUIRED",
        "Plugin lifecycle rollback snapshots require an encryption secret.",
        { httpStatus: 503, details: { pluginId } },
      );
    }
    return deps.rollbackSnapshotSecret;
  }

  function deriveRollbackSnapshotKey(secret: string): Buffer {
    return createHash("sha256").update(`friday-plugin-lifecycle-rollback:${secret}`).digest();
  }

  function encryptRollbackSnapshot(pluginId: string, snapshot: PluginLifecycleSnapshot): EncryptedRollbackSnapshotRecord {
    const plaintext = JSON.stringify(snapshot);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", deriveRollbackSnapshotKey(requireRollbackSnapshotSecret(pluginId)), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      schemaVersion: "friday.plugin.lifecycle.rollback_snapshot.v1",
      pluginId,
      snapshotDigest: snapshot.artifactDigest,
      envelope: {
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      },
    };
  }

  function decryptRollbackSnapshot(record: EncryptedRollbackSnapshotRecord): PluginLifecycleSnapshot {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveRollbackSnapshotKey(requireRollbackSnapshotSecret(record.pluginId)),
      Buffer.from(record.envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(record.envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as PluginLifecycleSnapshot;
  }

  function writeRollbackSnapshot(pluginId: string, snapshot: PluginLifecycleSnapshot): void {
    const file = rollbackSnapshotPath(pluginId);
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(encryptRollbackSnapshot(pluginId, snapshot), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(file, 0o600);
  }

  function readRollbackSnapshot(pluginId: string): PluginLifecycleSnapshot | null {
    const file = rollbackSnapshotPath(pluginId);
    if (!file || !existsSync(file)) return null;
    const record = JSON.parse(readFileSync(file, "utf8")) as EncryptedRollbackSnapshotRecord;
    const snapshot = decryptRollbackSnapshot(record);
    if (snapshot.artifactDigest !== record.snapshotDigest) {
      throw new FridayDomainError(
        "PLUGIN_ROLLBACK_PRIVATE_SNAPSHOT_DIGEST_MISMATCH",
        "Plugin rollback private snapshot digest does not match its envelope metadata.",
        { httpStatus: 409, details: { pluginId } },
      );
    }
    return snapshot;
  }

  function baseCanaryStats(pluginId: string): FridayAutonomyCanaryStats {
    return getPlugin(pluginId).canaryStats ?? {
      sampleSize: 0,
      successCount: 0,
      failureCount: 0,
      rollbackCount: 0,
    };
  }

  function assertCanaryState(pluginId: string): FridayPluginEntity {
    const plugin = getPlugin(pluginId);
    if (plugin.promotionChannel !== "shadow" && plugin.promotionChannel !== "canary") {
      throw new FridayDomainError(
        "PLUGIN_CANARY_REQUIRES_SHADOW",
        "Plugin canary requires a shadow lifecycle state first.",
        { httpStatus: 409, details: { pluginId } },
      );
    }
    requirePluginInactiveForShadow(plugin);
    return plugin;
  }

  function recordCanaryFailure(input: {
    pluginId: string;
    shadowVersionId?: string;
    ticket: FridayMutatingActionTicket;
    runId: string;
    startedAt: string;
    error: unknown;
    cleanupVerified?: boolean;
    cleanupRequiresManualAction?: boolean;
  }): FridayPluginEntity {
    const endedAt = deps.nowIso();
    const current = baseCanaryStats(input.pluginId);
    const plugin = updatePlugin(input.pluginId, {
      compatibilityStatus: "adaptation_required",
      promotionChannel: "canary",
      canaryStats: {
        sampleSize: current.sampleSize + 1,
        successCount: current.successCount,
        failureCount: current.failureCount + 1,
        rollbackCount: current.rollbackCount,
        lastEvaluatedAt: endedAt,
      },
    });
    updateEvidence(input.pluginId, (record) => {
      record.events.push({
        type: "canary",
        at: endedAt,
        success: false,
        runId: input.runId,
        ticketId: input.ticket.ticketId,
        parentLifecycleTicketId: input.ticket.childOfLifecycleTicketId,
        actionDigest: input.ticket.actionDigest,
        planDigest: input.ticket.planDigest,
        cleanupVerified: input.cleanupVerified,
        cleanupRequiresManualAction: input.cleanupRequiresManualAction,
      });
      record.canaryRuns.push({
        runId: input.runId,
        shadowVersionId: input.shadowVersionId,
        success: false,
        errorCode: input.error instanceof FridayDomainError ? input.error.code : "PLUGIN_CANARY_RUNTIME_ERROR",
        errorMessage: redactPluginLifecycleErrorMessage(input.error),
        ticketId: input.ticket.ticketId,
        parentLifecycleTicketId: input.ticket.childOfLifecycleTicketId,
        actionDigest: input.ticket.actionDigest,
        planDigest: input.ticket.planDigest,
        cleanupVerified: input.cleanupVerified,
        cleanupRequiresManualAction: input.cleanupRequiresManualAction,
        startedAt: input.startedAt,
        endedAt,
      });
    });
    return plugin;
  }

  return {
    registerShadowVersion(input) {
      const plugin = getPlugin(input.pluginId);
      requirePluginInactiveForShadow(plugin);
      const ticket = requireCanonicalLifecycleTicket({
        action: "shadow",
        pluginId: input.pluginId,
        shadowVersionId: input.shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
      });
      const previous = snapshotPlugin(input.pluginId);
      const digest = pluginArtifactDigest(input.pluginId);
      writeRollbackSnapshot(input.pluginId, previous);
      const shadowed = updatePlugin(input.pluginId, {
        compatibilityStatus: "adaptation_required",
        promotionChannel: "shadow",
        shadowVersionId: input.shadowVersionId,
        canaryStats: {
          sampleSize: 0,
          successCount: 0,
          failureCount: 0,
          rollbackCount: previous.canaryStats?.rollbackCount ?? 0,
        },
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
      updateEvidence(input.pluginId, (record) => {
        record.events = [];
        record.canaryRuns = [];
        delete record.promotion;
        delete record.rollback;
        record.events.push({
          type: "shadow",
          at: deps.nowIso(),
          shadowVersionId: input.shadowVersionId,
          ticketId: ticket.ticketId,
          parentLifecycleTicketId: ticket.childOfLifecycleTicketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
        });
        record.shadow = {
          shadowVersionId: input.shadowVersionId,
          pluginArtifactDigest: digest,
          previousPluginArtifactDigest: previous.artifactDigest,
          shadowedAt: deps.nowIso(),
          ticketId: ticket.ticketId,
          parentLifecycleTicketId: ticket.childOfLifecycleTicketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
          previous: redactPluginLifecycleSnapshot(previous),
        };
      });
      return shadowed;
    },

    async recordCanaryResult(input) {
      const plugin = assertCanaryState(input.pluginId);
      const shadowVersionId = plugin.shadowVersionId ?? undefined;
      const ticket = requireCanonicalLifecycleTicket({
        action: "canary",
        pluginId: input.pluginId,
        shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
      });
      const runtime = requireRuntime();
      const startedAt = deps.nowIso();
      const beforeCanary = snapshotPlugin(input.pluginId);
      const runId = `plugin_canary_${createHash("sha256")
        .update(`${input.pluginId}:${startedAt}:${ticket.actionDigest}`)
        .digest("hex")
        .slice(0, 16)}`;
      let canaryRuntimeStarted = false;
      try {
        await runtime.enablePlugin(input.pluginId, { lifecycleBypass: "canary" });
        canaryRuntimeStarted = true;
        await runtime.disablePlugin(input.pluginId);
      } catch (error) {
        const cleanupVerified = canaryRuntimeStarted
          ? runtime.isPluginRuntimeLoaded?.(input.pluginId) === false
          : true;
        recordCanaryFailure({
          pluginId: input.pluginId,
          shadowVersionId,
          ticket,
          runId,
          startedAt,
          error,
          cleanupVerified,
          cleanupRequiresManualAction: canaryRuntimeStarted && !cleanupVerified,
        });
        if (!canaryRuntimeStarted || cleanupVerified) {
          forceRestorePluginRuntimeState(input.pluginId, beforeCanary);
        } else {
          markCanaryCleanupUnverified(input.pluginId, error);
        }
        throw new FridayDomainError(
          canaryRuntimeStarted ? "PLUGIN_CANARY_RUNTIME_CLEANUP_FAILED" : "PLUGIN_CANARY_RUNTIME_PROOF_FAILED",
          canaryRuntimeStarted
            ? `Plugin ${input.pluginId} enabled during lifecycle canary but failed cleanup; manual disable is required: ${redactPluginLifecycleErrorMessage(error)}`
            : `Plugin ${input.pluginId} failed lifecycle canary smoke: ${redactPluginLifecycleErrorMessage(error)}`,
          { httpStatus: 424, details: { pluginId: input.pluginId, runId } },
        );
      }
      const endedAt = deps.nowIso();
      const current = baseCanaryStats(input.pluginId);
      const canary = updatePlugin(input.pluginId, {
        compatibilityStatus: "compatible",
        promotionChannel: "canary",
        canaryStats: {
          sampleSize: current.sampleSize + 1,
          successCount: current.successCount + 1,
          failureCount: current.failureCount,
          rollbackCount: current.rollbackCount,
          lastEvaluatedAt: endedAt,
        },
      });
      updateEvidence(input.pluginId, (record) => {
        record.events.push({
          type: "canary",
          at: endedAt,
          success: true,
          runId,
          ticketId: ticket.ticketId,
          parentLifecycleTicketId: ticket.childOfLifecycleTicketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
        });
        record.canaryRuns.push({
          runId,
          shadowVersionId,
          success: true,
          ticketId: ticket.ticketId,
          parentLifecycleTicketId: ticket.childOfLifecycleTicketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
          startedAt,
          endedAt,
        });
      });
      return canary;
    },

    async promote(input) {
      const current = getPlugin(input.pluginId);
      const evidence = readEvidence(input.pluginId);
      if (current.promotionChannel !== "canary") {
        throw new FridayDomainError(
          "PLUGIN_PROMOTE_REQUIRES_CANARY",
          "Plugin promote requires a canary lifecycle state first.",
          { httpStatus: 409, details: { pluginId: input.pluginId } },
        );
      }
      if (!current.shadowVersionId || !evidence.shadow) {
        throw new FridayDomainError(
          "PLUGIN_PROMOTE_REQUIRES_ROLLBACK_POINTER",
          "Plugin promote requires a shadow rollback pointer.",
          { httpStatus: 409, details: { pluginId: input.pluginId } },
        );
      }
      if (!current.canaryStats || current.canaryStats.successCount < 1 || current.canaryStats.failureCount > 0) {
        throw new FridayDomainError(
          "PLUGIN_PROMOTE_REQUIRES_GREEN_CANARY",
          "Plugin promote requires at least one successful canary and zero failed canaries.",
          { httpStatus: 409, details: { pluginId: input.pluginId, canaryStats: current.canaryStats } },
        );
      }
      const ticket = requireCanonicalLifecycleTicket({
        action: "promote",
        pluginId: input.pluginId,
        shadowVersionId: current.shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
      });
      const runtime = requireRuntime();
      try {
        await runtime.enablePlugin(input.pluginId, { lifecycleBypass: "promote" });
      } catch (error) {
        throw new FridayDomainError(
          "PLUGIN_PROMOTE_RUNTIME_ENABLE_FAILED",
          `Plugin ${input.pluginId} passed canary but failed promote enable: ${redactPluginLifecycleErrorMessage(error)}`,
          { httpStatus: 424, details: { pluginId: input.pluginId } },
        );
      }
      const promoted = updatePlugin(input.pluginId, {
        compatibilityStatus: "compatible",
        promotionChannel: "active",
        shadowVersionId: current.shadowVersionId,
        canaryStats: current.canaryStats,
        lastVerifiedAt: deps.nowIso(),
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
      updateEvidence(input.pluginId, (record) => {
        record.events.push({
          type: "promote",
          at: deps.nowIso(),
          ticketId: ticket.ticketId,
          parentLifecycleTicketId: ticket.childOfLifecycleTicketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
        });
        record.promotion = {
          promotedAt: deps.nowIso(),
          shadowVersionId: current.shadowVersionId ?? undefined,
          ticketId: ticket.ticketId,
          parentLifecycleTicketId: ticket.childOfLifecycleTicketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest!,
        };
      });
      return promoted;
    },

    async rollback(input) {
      const evidence = readEvidence(input.pluginId);
      const rollbackTarget = readRollbackSnapshot(input.pluginId);
      if (!evidence.promotion || !rollbackTarget) {
        throw new FridayDomainError(
          "PLUGIN_ROLLBACK_REQUIRES_PROMOTION_EVIDENCE",
          "Plugin rollback requires promotion evidence and a rollback pointer.",
          { httpStatus: 409, details: { pluginId: input.pluginId } },
        );
      }
      const ticket = requireCanonicalLifecycleTicket({
        action: "rollback",
        pluginId: input.pluginId,
        shadowVersionId: evidence.promotion.shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
        rollback: { planned: true, planDigest: input.planDigest, actions: ["plugins.lifecycle.promote"] },
      });
      const runtime = requireRuntime();
      const current = getPlugin(input.pluginId);
      const currentArtifactDigest = pluginArtifactDigestFromSnapshot(snapshotPluginArtifact(current));
      const expectedCurrentArtifactDigest = evidence.shadow?.pluginArtifactDigest;
      const targetArtifactDigest = pluginArtifactDigestFromSnapshot(rollbackTarget.artifact);
      if (targetArtifactDigest !== rollbackTarget.artifactDigest) {
        throw new FridayDomainError(
          "PLUGIN_ROLLBACK_TARGET_ARTIFACT_DIGEST_MISMATCH",
          "Plugin rollback pointer artifact metadata no longer matches its recorded digest.",
          {
            httpStatus: 409,
            details: {
              pluginId: input.pluginId,
              expectedArtifactDigest: rollbackTarget.artifactDigest,
              actualArtifactDigest: targetArtifactDigest,
            },
          },
        );
      }
      if (evidence.shadow?.previousPluginArtifactDigest && rollbackTarget.artifactDigest !== evidence.shadow.previousPluginArtifactDigest) {
        throw new FridayDomainError(
          "PLUGIN_ROLLBACK_PRIVATE_SNAPSHOT_DIGEST_MISMATCH",
          "Plugin rollback private snapshot does not match the public rollback pointer digest.",
          {
            httpStatus: 409,
            details: {
              pluginId: input.pluginId,
              expectedArtifactDigest: evidence.shadow.previousPluginArtifactDigest,
              actualArtifactDigest: rollbackTarget.artifactDigest,
            },
          },
        );
      }
      if (expectedCurrentArtifactDigest && currentArtifactDigest !== expectedCurrentArtifactDigest) {
        throw new FridayDomainError(
          "PLUGIN_ROLLBACK_CURRENT_ARTIFACT_DIGEST_MISMATCH",
          "Plugin rollback refused because the active plugin artifact does not match the promoted lifecycle evidence.",
          {
            httpStatus: 409,
            details: {
              pluginId: input.pluginId,
              expectedArtifactDigest: expectedCurrentArtifactDigest,
              actualArtifactDigest: currentArtifactDigest,
            },
          },
        );
      }
      if (current.enabled || current.status === "enabled" || current.status === "running") {
        await runtime.disablePlugin(input.pluginId);
      }
      const stats = current.canaryStats ?? baseCanaryStats(input.pluginId);
      const rolledBack = restorePluginSnapshot(input.pluginId, rollbackTarget, {
        sampleSize: stats.sampleSize,
        successCount: stats.successCount,
        failureCount: stats.failureCount,
        rollbackCount: stats.rollbackCount + 1,
        lastEvaluatedAt: deps.nowIso(),
      });
      const restoredArtifactDigest = pluginArtifactDigestFromSnapshot(snapshotPluginArtifact(rolledBack));
      if (restoredArtifactDigest !== rollbackTarget.artifactDigest) {
        throw new FridayDomainError(
          "PLUGIN_ROLLBACK_RESTORED_ARTIFACT_DIGEST_MISMATCH",
          "Plugin rollback restored artifact metadata did not match the rollback pointer digest.",
          {
            httpStatus: 500,
            details: {
              pluginId: input.pluginId,
              expectedArtifactDigest: rollbackTarget.artifactDigest,
              actualArtifactDigest: restoredArtifactDigest,
            },
          },
        );
      }
      updateEvidence(input.pluginId, (record) => {
        record.events.push({
          type: "rollback",
          at: deps.nowIso(),
          reason: input.reason,
          ticketId: ticket.ticketId,
          parentLifecycleTicketId: ticket.childOfLifecycleTicketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
          fromPluginArtifactDigest: currentArtifactDigest,
          toPluginArtifactDigest: rollbackTarget.artifactDigest,
          restoredPluginArtifactDigest: restoredArtifactDigest,
        });
        record.rollback = {
          rolledBackAt: deps.nowIso(),
          reason: input.reason,
          result: "restored_previous_plugin_lifecycle_state",
          ticketId: ticket.ticketId,
          parentLifecycleTicketId: ticket.childOfLifecycleTicketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest!,
          fromPluginArtifactDigest: currentArtifactDigest,
          toPluginArtifactDigest: rollbackTarget.artifactDigest,
          restoredPluginArtifactDigest: restoredArtifactDigest,
        };
      });
      return rolledBack;
    },

    getLifecycleEvidence(input) {
      const evidence = readEvidence(input.pluginId);
      const lastEvent = evidence.events.at(-1);
      if (!lastEvent) return null;
      return {
        pluginId: input.pluginId,
        shadowVersionId: evidence.shadow?.shadowVersionId,
        stage: evidence.rollback ? "rolled_back" : evidence.promotion ? "active" : evidence.canaryRuns.length > 0 ? "canary" : "shadow",
        lastEventAt: typeof lastEvent.at === "string" ? lastEvent.at : deps.nowIso(),
        canarySuccessCount: evidence.canaryRuns.filter((run) => run.success).length,
        canaryFailureCount: evidence.canaryRuns.filter((run) => !run.success).length,
        rollbackPointerAvailable: evidence.shadow !== undefined,
        pluginArtifactDigest: evidence.shadow?.pluginArtifactDigest,
        previousPluginArtifactDigest: evidence.shadow?.previousPluginArtifactDigest,
        parentLifecycleTicketId:
          evidence.promotion?.parentLifecycleTicketId
          ?? evidence.canaryRuns.at(-1)?.parentLifecycleTicketId
          ?? evidence.shadow?.parentLifecycleTicketId
          ?? evidence.rollback?.parentLifecycleTicketId,
        restoredPluginArtifactDigest: evidence.rollback?.restoredPluginArtifactDigest,
        planDigest: evidence.promotion?.planDigest ?? evidence.shadow?.planDigest,
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
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function redactPluginLifecycleErrorMessage(error: unknown): string {
  const message = sanitizePluginLifecycleErrorMessage(error instanceof Error ? error.message : String(error));
  const redacted = redactContext({
    errorMessage: message,
  } satisfies JsonObject, {
    maxStringLength: 512,
  }).redacted;
  const value = redacted.errorMessage;
  return typeof value === "string" ? value : "[redacted]";
}

function sanitizePluginLifecycleErrorMessage(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [redacted]")
    .replace(/([?&](?:token|api[_-]?key|secret|password|credential)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(token|api[_-]?key|secret|password|credential)\s*[:=]\s*[^,\s)]+/gi, "$1=[redacted]");
}
