import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { createFridayPluginRepository } from "#plugins";
import {
  createFridayPluginLifecycleMutatingActionRequest,
  createFridayPluginUpgradeLifecycleService,
} from "../../../src/autonomy/services/friday-plugin-upgrade-lifecycle-service.js";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  type FridayCanonicalApprovalResolution,
} from "../../../src/security/friday-mutating-action-gate.js";

import { createTestDb } from "../satellites/_helpers/create-test-db.helper.js";

const PLAN_DIGEST = "plugin-plan-1";
const NOW = "2026-04-17T21:15:00.000Z";

function makeApproval(input: {
  action: "shadow" | "canary" | "promote" | "rollback";
  planDigest?: string;
  shadowVersionId?: string;
  childOfLifecycleTicketId?: string;
}): FridayCanonicalApprovalResolution {
  const planDigest = input.planDigest ?? PLAN_DIGEST;
  const request = createFridayPluginLifecycleMutatingActionRequest({
    action: input.action,
    pluginId: "friday.test.plugin",
    shadowVersionId: input.shadowVersionId ?? "friday.test.plugin@shadow",
    runtimeVersion: "runtime-v1",
    actor: {
      kind: "user",
      id: "user-1",
      principalId: "user-1",
    },
    surface: `api:/v1/autonomy/plugins/${input.action}`,
    planDigest,
    rollback: input.action === "rollback"
      ? { planned: true, planDigest, actions: ["plugins.lifecycle.promote"] }
      : undefined,
  });
  return {
    decision: "approved",
    approvalId: `plugin-${input.action}-approval`,
    decidedByPrincipalId: "user-1",
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2026-04-17T22:15:00.000Z",
    childOfLifecycleTicketId: input.childOfLifecycleTicketId,
  };
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

function pluginArtifactDigest(input: {
  id: string;
  version: string;
  installPath: string;
  manifest: unknown;
  signatureVerified: boolean;
  trustedFingerprintSha256: string | null;
}): string {
  return createHash("sha256").update(stableStringify({
    id: input.id,
    version: input.version,
    installPath: input.installPath,
    manifest: input.manifest,
    signatureVerified: input.signatureVerified,
    trustedFingerprintSha256: input.trustedFingerprintSha256,
  })).digest("hex");
}

describe("createFridayPluginUpgradeLifecycleService", () => {
  let db: FridaySqliteLayer;
  let stateDir: string;
  const pluginRepo = createFridayPluginRepository();

  beforeEach(() => {
    db = createTestDb();
    stateDir = mkdtempSync(join(tmpdir(), "friday-plugin-lifecycle-"));
    db.withWriteTransaction((conn) => {
      pluginRepo.upsertPlugin(conn, {
        id: "friday.test.plugin",
        name: "Test Plugin",
        description: "Plugin upgrade lifecycle test fixture",
        version: "1.0.0",
        source: "local",
        status: "installed",
        enabled: false,
        trustMode: "trust_on_install",
        installPath: "/tmp/friday-test-plugin",
        kinds: ["skill"],
        manifest: {
          schemaVersion: "1.0",
          id: "friday.test.plugin",
          version: "1.0.0",
          name: "Test Plugin",
          description: "Plugin upgrade lifecycle test fixture",
          kinds: ["skill"],
          entrypoints: { skill: "./dist/index.js" },
          permissions: { grants: [], promptOn: [] },
          compatibility: { minHubVersion: "0.1.0", apiVersion: "1" },
        },
        config: {
          sensitiveValue: "fixture-sensitive-config-value",
        },
        signatureAlgorithm: "ed25519",
        signatureKeyId: "fixture-key",
        signatureValue: "fixture-sensitive-signature-value",
        signatureVerified: true,
        trustedFingerprintSha256: "fixture-fingerprint",
        nowIso: "2026-04-17T20:00:00.000Z",
      });
    });
  });

  afterEach(() => {
    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function createRuntime() {
    const loaded = new Set<string>();
    return {
      enablePlugin: vi.fn(async (pluginId: string) => db.withWriteTransaction((conn) => {
        loaded.add(pluginId);
        pluginRepo.setStatus(conn, pluginId, "running", NOW);
        pluginRepo.setEnabled(conn, pluginId, true, NOW);
        return pluginRepo.getById(conn, pluginId)!;
      })),
      disablePlugin: vi.fn(async (pluginId: string) => db.withWriteTransaction((conn) => {
        loaded.delete(pluginId);
        pluginRepo.setStatus(conn, pluginId, "disabled", NOW);
        pluginRepo.setEnabled(conn, pluginId, false, NOW);
        return pluginRepo.getById(conn, pluginId)!;
      })),
      isPluginRuntimeLoaded: vi.fn((pluginId: string) => loaded.has(pluginId)),
    };
  }

  function createService(runtime = createRuntime()) {
    return {
      runtime,
      service: createFridayPluginUpgradeLifecycleService({
        db,
        pluginRepo,
        nowIso: () => NOW,
        stateDir,
        pluginRuntime: runtime,
        canonicalMutationGate: createFridayMutatingActionGate({
          nowIso: () => NOW,
          ticketIdGenerator: () => "ticket-1",
        }),
        rollbackSnapshotSecret: "fixture-rollback-snapshot-key",
      }),
    };
  }

  it("requires canonical approval before shadow can mutate", () => {
    const { service, runtime } = createService();

    expect(() => service.registerShadowVersion({
      pluginId: "friday.test.plugin",
      shadowVersionId: "friday.test.plugin@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: PLAN_DIGEST,
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/shadow",
    })).toThrow("requires canonical approval");

    expect(runtime.enablePlugin).not.toHaveBeenCalled();
  });

  it("tracks shadow, real canary, promote, rollback, and evidence for plugins", async () => {
    const { service, runtime } = createService();

    const shadowed = service.registerShadowVersion({
      pluginId: "friday.test.plugin",
      shadowVersionId: "friday.test.plugin@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "shadow" }),
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/shadow",
    });
    expect(shadowed.promotionChannel).toBe("shadow");
    expect(shadowed.shadowVersionId).toBe("friday.test.plugin@shadow");
    const publicEvidencePath = join(stateDir, "plugin-lifecycle", "friday.test.plugin.json");
    const privateSnapshotPath = join(stateDir, "plugin-lifecycle-private", "friday.test.plugin.rollback.json");
    const publicEvidenceRaw = readFileSync(publicEvidencePath, "utf8");
    const privateSnapshotRaw = readFileSync(privateSnapshotPath, "utf8");
    expect(publicEvidenceRaw).not.toContain("fixture-sensitive-config-value");
    expect(publicEvidenceRaw).not.toContain("fixture-sensitive-signature-value");
    expect(privateSnapshotRaw).not.toContain("fixture-sensitive-config-value");
    expect(privateSnapshotRaw).not.toContain("fixture-sensitive-signature-value");

    const canary = await service.recordCanaryResult({
      pluginId: "friday.test.plugin",
      runtimeVersion: "runtime-v1",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "canary" }),
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/canary",
    });
    expect(canary.promotionChannel).toBe("canary");
    expect(canary.canaryStats?.successCount).toBe(1);
    expect(runtime.enablePlugin).toHaveBeenCalledWith("friday.test.plugin", { lifecycleBypass: "canary" });
    expect(runtime.disablePlugin).toHaveBeenCalledWith("friday.test.plugin");

    const promoted = await service.promote({
      pluginId: "friday.test.plugin",
      runtimeVersion: "runtime-v1",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "promote" }),
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/promote",
    });
    expect(promoted.promotionChannel).toBe("active");
    expect(promoted.status).toBe("running");
    expect(promoted.enabled).toBe(true);
    expect(runtime.enablePlugin).toHaveBeenLastCalledWith("friday.test.plugin", { lifecycleBypass: "promote" });

    const promotedManifest = {
      ...promoted.manifest,
      version: "2.0.0",
      entrypoints: { skill: "./dist/v2.js" },
    };
    const promotedArtifactDigest = pluginArtifactDigest({
      id: "friday.test.plugin",
      version: "2.0.0",
      installPath: "/tmp/friday-test-plugin-v2",
      manifest: promotedManifest,
      signatureVerified: true,
      trustedFingerprintSha256: "fixture-fingerprint-v2",
    });
    db.withWriteTransaction((conn) => {
      pluginRepo.upsertPlugin(conn, {
        id: "friday.test.plugin",
        name: promoted.name,
        description: promoted.description,
        version: "2.0.0",
        source: promoted.source,
        status: promoted.status,
        enabled: promoted.enabled,
        trustMode: promoted.trustMode,
        installPath: "/tmp/friday-test-plugin-v2",
        kinds: promoted.kinds,
        manifest: promotedManifest,
        config: promoted.config,
        signatureAlgorithm: promoted.signatureAlgorithm ?? undefined,
        signatureKeyId: promoted.signatureKeyId ?? undefined,
        signatureValue: promoted.signatureValue ?? undefined,
        signatureVerified: promoted.signatureVerified,
        trustedFingerprintSha256: "fixture-fingerprint-v2",
        lastVerifiedAt: promoted.lastVerifiedAt ?? undefined,
        lastVerifiedRuntimeVersion: promoted.lastVerifiedRuntimeVersion ?? undefined,
        lastVerifiedProviderModel: promoted.lastVerifiedProviderModel ?? undefined,
        compatibilityStatus: promoted.compatibilityStatus,
        promotionChannel: promoted.promotionChannel,
        shadowVersionId: promoted.shadowVersionId ?? undefined,
        canaryStats: promoted.canaryStats,
        nowIso: NOW,
      });
    });
    const evidence = JSON.parse(readFileSync(publicEvidencePath, "utf8")) as { shadow?: { pluginArtifactDigest?: string } };
    expect(evidence.shadow).toBeDefined();
    evidence.shadow!.pluginArtifactDigest = promotedArtifactDigest;
    writeFileSync(publicEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

    const rolledBack = await service.rollback({
      pluginId: "friday.test.plugin",
      runtimeVersion: "runtime-v1",
      reason: "test rollback",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "rollback" }),
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/rollback",
    });
    expect(rolledBack.promotionChannel).toBe("none");
    expect(rolledBack.compatibilityStatus).toBe("unknown");
    expect(rolledBack.status).toBe("installed");
    expect(rolledBack.enabled).toBe(false);
    expect(rolledBack.version).toBe("1.0.0");
    expect(rolledBack.installPath).toBe("/tmp/friday-test-plugin");
    expect(rolledBack.manifest.entrypoints).toEqual({ skill: "./dist/index.js" });
    expect(rolledBack.trustedFingerprintSha256).toBe("fixture-fingerprint");

    expect(service.getLifecycleEvidence({ pluginId: "friday.test.plugin" })).toMatchObject({
      pluginId: "friday.test.plugin",
      stage: "rolled_back",
      canarySuccessCount: 1,
      rollbackPointerAvailable: true,
      restoredPluginArtifactDigest: expect.any(String),
    });
  });

  it("records redacted canary failure evidence and blocks promote", async () => {
    const runtime = createRuntime();
    runtime.enablePlugin.mockRejectedValueOnce(new Error("token=fixture-secret-value"));
    const { service } = createService(runtime);

    service.registerShadowVersion({
      pluginId: "friday.test.plugin",
      shadowVersionId: "friday.test.plugin@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "shadow" }),
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/shadow",
    });

    await expect(service.recordCanaryResult({
      pluginId: "friday.test.plugin",
      runtimeVersion: "runtime-v1",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "canary" }),
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/canary",
    })).rejects.toMatchObject({ code: "PLUGIN_CANARY_RUNTIME_PROOF_FAILED" });

    const evidence = service.getLifecycleEvidence({ pluginId: "friday.test.plugin" });
    expect(evidence).toMatchObject({
      stage: "canary",
      canaryFailureCount: 1,
    });
    expect(JSON.stringify(evidence)).not.toContain("fixture-secret-value");
    const plugin = db.withReadConnection((conn) => pluginRepo.getById(conn, "friday.test.plugin"))!;
    expect(plugin.status).toBe("installed");
    expect(plugin.enabled).toBe(false);
    expect(plugin.lastErrorMessage).not.toContain("fixture-secret-value");

    await expect(service.promote({
      pluginId: "friday.test.plugin",
      runtimeVersion: "runtime-v1",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "promote" }),
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/promote",
    })).rejects.toMatchObject({ code: "PLUGIN_PROMOTE_REQUIRES_GREEN_CANARY" });
  });

  it("refuses rollback when active artifact digest no longer matches promoted evidence", async () => {
    const { service } = createService();

    service.registerShadowVersion({
      pluginId: "friday.test.plugin",
      shadowVersionId: "friday.test.plugin@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "shadow" }),
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/shadow",
    });
    await service.recordCanaryResult({
      pluginId: "friday.test.plugin",
      runtimeVersion: "runtime-v1",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "canary" }),
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/canary",
    });
    const promoted = await service.promote({
      pluginId: "friday.test.plugin",
      runtimeVersion: "runtime-v1",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "promote" }),
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/promote",
    });

    db.withWriteTransaction((conn) => {
      pluginRepo.upsertPlugin(conn, {
        id: "friday.test.plugin",
        name: promoted.name,
        description: promoted.description,
        version: "2.0.0",
        source: promoted.source,
        status: promoted.status,
        enabled: promoted.enabled,
        trustMode: promoted.trustMode,
        installPath: "/tmp/friday-test-plugin-v2",
        kinds: promoted.kinds,
        manifest: { ...promoted.manifest, version: "2.0.0" },
        config: promoted.config,
        signatureVerified: promoted.signatureVerified,
        trustedFingerprintSha256: "fixture-fingerprint-v2",
        compatibilityStatus: promoted.compatibilityStatus,
        promotionChannel: promoted.promotionChannel,
        shadowVersionId: promoted.shadowVersionId ?? undefined,
        canaryStats: promoted.canaryStats,
        nowIso: NOW,
      });
    });

    await expect(service.rollback({
      pluginId: "friday.test.plugin",
      runtimeVersion: "runtime-v1",
      reason: "digest mismatch",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "rollback" }),
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/rollback",
    })).rejects.toMatchObject({ code: "PLUGIN_ROLLBACK_CURRENT_ARTIFACT_DIGEST_MISMATCH" });
  });

  it("fails closed when canary cleanup fails after enable succeeds", async () => {
    const runtime = createRuntime();
    runtime.disablePlugin.mockRejectedValueOnce(new Error("token=fixture-secret-value"));
    const { service } = createService(runtime);

    service.registerShadowVersion({
      pluginId: "friday.test.plugin",
      shadowVersionId: "friday.test.plugin@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "shadow" }),
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/shadow",
    });

    await expect(service.recordCanaryResult({
      pluginId: "friday.test.plugin",
      runtimeVersion: "runtime-v1",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "canary" }),
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/canary",
    })).rejects.toMatchObject({ code: "PLUGIN_CANARY_RUNTIME_CLEANUP_FAILED" });

    const evidence = service.getLifecycleEvidence({ pluginId: "friday.test.plugin" });
    expect(evidence).toMatchObject({
      stage: "canary",
      canaryFailureCount: 1,
    });
    expect(JSON.stringify(evidence)).not.toContain("fixture-secret-value");
    const plugin = db.withReadConnection((conn) => pluginRepo.getById(conn, "friday.test.plugin"))!;
    expect(plugin.status).toBe("error");
    expect(plugin.enabled).toBe(true);
    expect(plugin.lastErrorCode).toBe("PLUGIN_LIFECYCLE_CANARY_CLEANUP_UNVERIFIED");
    expect(runtime.isPluginRuntimeLoaded).toHaveBeenCalledWith("friday.test.plugin");

    await expect(service.promote({
      pluginId: "friday.test.plugin",
      runtimeVersion: "runtime-v1",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "promote" }),
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/promote",
    })).rejects.toMatchObject({ code: "PLUGIN_PROMOTE_REQUIRES_GREEN_CANARY" });
  });

  it("new shadow resets stale canary evidence and stale failure counts", async () => {
    const runtime = createRuntime();
    runtime.enablePlugin.mockRejectedValueOnce(new Error("first canary failed"));
    const { service } = createService(runtime);

    service.registerShadowVersion({
      pluginId: "friday.test.plugin",
      shadowVersionId: "friday.test.plugin@shadow-1",
      runtimeVersion: "runtime-v1",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "shadow", shadowVersionId: "friday.test.plugin@shadow-1" }),
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/shadow",
    });
    await expect(service.recordCanaryResult({
      pluginId: "friday.test.plugin",
      runtimeVersion: "runtime-v1",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "canary", shadowVersionId: "friday.test.plugin@shadow-1" }),
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/canary",
    })).rejects.toMatchObject({ code: "PLUGIN_CANARY_RUNTIME_PROOF_FAILED" });
    expect(service.getLifecycleEvidence({ pluginId: "friday.test.plugin" })).toMatchObject({
      canaryFailureCount: 1,
    });

    service.registerShadowVersion({
      pluginId: "friday.test.plugin",
      shadowVersionId: "friday.test.plugin@shadow-2",
      runtimeVersion: "runtime-v1",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "shadow", shadowVersionId: "friday.test.plugin@shadow-2" }),
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/shadow",
    });

    expect(service.getLifecycleEvidence({ pluginId: "friday.test.plugin" })).toMatchObject({
      shadowVersionId: "friday.test.plugin@shadow-2",
      stage: "shadow",
      canarySuccessCount: 0,
      canaryFailureCount: 0,
    });
    const plugin = db.withReadConnection((conn) => pluginRepo.getById(conn, "friday.test.plugin"))!;
    expect(plugin.canaryStats?.failureCount).toBe(0);
  });

  it("fails closed when shadow is attempted for an already running plugin", () => {
    db.withWriteTransaction((conn) => {
      pluginRepo.setStatus(conn, "friday.test.plugin", "running", NOW);
      pluginRepo.setEnabled(conn, "friday.test.plugin", true, NOW);
    });
    const { service } = createService();

    expect(() => service.registerShadowVersion({
      pluginId: "friday.test.plugin",
      shadowVersionId: "friday.test.plugin@shadow",
      runtimeVersion: "runtime-v1",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "shadow" }),
      actor: { kind: "user", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/autonomy/plugins/shadow",
    })).toThrow("requires the plugin to be disabled");
  });
});
