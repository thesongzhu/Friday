import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LIVE_ANTHROPIC_MODEL } from "../_helpers/live-anthropic.js";
import { apiFetch } from "./_helpers/api.js";
import {
  createFridayPluginLifecycleMutatingActionRequest,
} from "../../../src/autonomy/services/friday-plugin-upgrade-lifecycle-service.js";
import {
  createFridayMutatingActionDigest,
  signFridayCanonicalApproval,
  type FridayCanonicalApprovalResolution,
} from "../../../src/security/friday-mutating-action-gate.js";
import {
  cleanupFridayDeepProofHubEnv,
  createFridayDeepProofHubEnv,
  FRIDAY_DEEP_PROOF_GATED,
  type RealHubEnv,
} from "./_helpers/deep-proof-env.js";

const PLUGIN_LIFECYCLE_SIGNING_MATERIAL =
  "plugin-live-proof-signing-material"; // pragma: allowlist secret
const LOCAL_LIVE_PRINCIPAL_ID = "admin-001";

interface RuntimeVersionEnvelope {
  ok: boolean;
  data: {
    version: string;
    apiVersion: string;
  };
}

interface PluginEnvelope {
  ok: boolean;
  data: {
    plugin: {
      id: string;
      version: string;
      status: string;
      enabled: boolean;
      promotionChannel?: string;
      compatibilityStatus?: string;
      shadowVersionId?: string | null;
      canaryStats?: {
        sampleSize: number;
        successCount: number;
        failureCount: number;
        rollbackCount: number;
      };
    };
  };
}

interface UpgradeStatusEnvelope {
  ok: boolean;
  data: {
    items: Array<{
      kind: string;
      id: string;
      compatibilityStatus: string;
      promotionChannel: string;
      shadowVersionId?: string;
      canaryStats?: {
        sampleSize: number;
        successCount: number;
        failureCount: number;
        rollbackCount: number;
      };
      recordedCompatibilityStatus: string;
      derivedCompatibilityStatus: string;
      strategy: string;
      nextStage: string;
      findings: Array<{ id: string; passed: boolean; severity: string }>;
    }>;
  };
}

interface PluginActionEnvelope {
  ok: boolean;
  data: {
    plugin: {
      id: string;
      version: string;
      status: string;
      enabled: boolean;
      promotionChannel?: string;
      compatibilityStatus?: string;
      shadowVersionId?: string | null;
      canaryStats?: {
        sampleSize: number;
        successCount: number;
        failureCount: number;
        rollbackCount: number;
      };
    };
    status: UpgradeStatusEnvelope["data"]["items"][number] | null;
    evidence?: {
      pluginId?: string;
      shadowVersionId?: string;
      stage?: string;
      canarySuccessCount?: number;
      canaryFailureCount?: number;
      rollbackPointerAvailable?: boolean;
      planDigest?: string;
    };
  };
}

interface PluginRowReadback {
  status: string;
  enabled: number;
  compatibilityStatus: string;
  promotionChannel: string;
  shadowVersionId: string | null;
  canaryStatsJson: string;
  lastVerifiedRuntimeVersion: string | null;
  lastVerifiedProviderModel: string | null;
}

function openStateDb(stateDir: string): Database.Database {
  return new Database(path.join(stateDir, "friday.db"), { readonly: true, fileMustExist: true });
}

function readPluginRow(stateDir: string, pluginId: string): PluginRowReadback | null {
  const db = openStateDb(stateDir);
  try {
    return (
      db
        .prepare(
          `SELECT status,
                  enabled,
                  compatibility_status AS compatibilityStatus,
                  promotion_channel AS promotionChannel,
                  shadow_version_id AS shadowVersionId,
                  canary_stats_json AS canaryStatsJson,
                  last_verified_runtime_version AS lastVerifiedRuntimeVersion,
                  last_verified_provider_model AS lastVerifiedProviderModel
             FROM plugins
            WHERE id = ?`,
        )
        .get(pluginId) as PluginRowReadback | undefined
    ) ?? null;
  } finally {
    db.close();
  }
}

function createPluginFixture(rootDir: string, pluginId: string): string {
  const installPath = path.join(rootDir, pluginId);
  const distDir = path.join(installPath, "dist");
  fs.mkdirSync(distDir, { recursive: true });

  fs.writeFileSync(
    path.join(installPath, "friday.plugin.json"),
    JSON.stringify(
      {
        schemaVersion: "1.0",
        id: pluginId,
        version: "1.0.0",
        name: "Self Upgrade Test Plugin",
        description: "Plugin fixture for self-upgrade proof.",
        kinds: ["skill"],
        entrypoints: { skill: "./dist/index.mjs" },
        permissions: { grants: [], promptOn: [] },
        compatibility: { minHubVersion: "0.1.0", apiVersion: "1" },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(distDir, "index.mjs"),
    `import fs from "node:fs";
const activatedPath = new URL("../activated.json", import.meta.url);
const deactivatedPath = new URL("../deactivated.json", import.meta.url);
export async function activate(context) {
  fs.writeFileSync(activatedPath, JSON.stringify({ pluginId: context.pluginId, activated: true }));
}
export async function deactivate() {
  fs.writeFileSync(deactivatedPath, JSON.stringify({ deactivated: true }));
}`,
  );

  return installPath;
}

async function getRuntimeVersion(env: RealHubEnv): Promise<string> {
  const response = await apiFetch<RuntimeVersionEnvelope>(
    env.baseUrl,
    env.accessToken,
    "GET",
    "/v1/version",
  );
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  return response.json.data.version;
}

async function getUpgradeStatus(env: RealHubEnv, pluginId: string): Promise<UpgradeStatusEnvelope["data"]["items"][number]> {
  const response = await apiFetch<UpgradeStatusEnvelope>(
    env.baseUrl,
    env.accessToken,
    "GET",
    `/v1/autonomy/upgrade-status?kind=plugin&id=${encodeURIComponent(pluginId)}`,
  );
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  expect(response.json.data.items).toHaveLength(1);
  return response.json.data.items[0]!;
}

function makePluginLifecycleApproval(input: {
  action: "shadow" | "canary" | "promote" | "rollback";
  pluginId: string;
  shadowVersionId?: string;
  runtimeVersion: string;
  planDigest: string;
}): FridayCanonicalApprovalResolution {
  const rollback = input.action === "rollback"
    ? { planned: true, planDigest: input.planDigest, actions: ["plugins.lifecycle.promote"] }
    : undefined;
  const request = createFridayPluginLifecycleMutatingActionRequest({
    action: input.action,
    pluginId: input.pluginId,
    shadowVersionId: input.shadowVersionId,
    runtimeVersion: input.runtimeVersion,
    providerModel: LIVE_ANTHROPIC_MODEL,
    actor: {
      kind: "user",
      id: LOCAL_LIVE_PRINCIPAL_ID,
      principalId: LOCAL_LIVE_PRINCIPAL_ID,
    },
    surface: `api:/v1/autonomy/plugins/${input.action}`,
    planDigest: input.planDigest,
    rollback,
  });
  return signFridayCanonicalApproval({
    decision: "approved",
    approvalId: `plugin-live-${input.action}`,
    decidedByPrincipalId: LOCAL_LIVE_PRINCIPAL_ID,
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2027-05-07T00:00:00.000Z",
  }, PLUGIN_LIFECYCLE_SIGNING_MATERIAL);
}

describe.skipIf(!FRIDAY_DEEP_PROOF_GATED)("Friday Plugin Self Upgrade Live (Anthropic API key lane)", () => {
  let env: RealHubEnv;
  let pluginRootDir: string;

  beforeAll(async () => {
    env = await createFridayDeepProofHubEnv({
      hubConfig: {
        tokenSecret: PLUGIN_LIFECYCLE_SIGNING_MATERIAL,
      },
    });
    pluginRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-plugin-self-upgrade-"));
  }, 120_000);

  afterAll(async () => {
    if (env) {
      await cleanupFridayDeepProofHubEnv(env);
    }
    if (pluginRootDir) {
      fs.rmSync(pluginRootDir, { recursive: true, force: true });
    }
  }, 30_000);

  it(
    "proves plugin detect-adapt-replay-shadow-canary-promote-rollback with API and SQLite readback",
    { timeout: 240_000, retry: 1 },
    async () => {
      const runtimeVersion = await getRuntimeVersion(env);
      const pluginId = `friday.test.plugin.${Date.now().toString(36)}`;
      const installPath = createPluginFixture(pluginRootDir, pluginId);

      const installRes = await apiFetch<PluginEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/plugins/${encodeURIComponent(pluginId)}/install`,
        {
          installPath,
          userApproved: true,
        },
      );
      expect(installRes.status).toBe(200);
      expect(installRes.json.ok).toBe(true);
      expect(installRes.json.data.plugin.enabled).toBe(false);
      expect(installRes.json.data.plugin.status).toBe("installed");

      const detectStatus = await getUpgradeStatus(env, pluginId);
      expect(detectStatus.derivedCompatibilityStatus).toBe("adaptation_required");
      expect(detectStatus.strategy).toBe("patch");
      expect(
        detectStatus.findings.some((finding) => finding.id === "plugin_enabled" && !finding.passed),
      ).toBe(true);

      const enableRes = await apiFetch<{ ok: boolean; error?: { code?: string } }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/plugins/${encodeURIComponent(pluginId)}/enable`,
      );
      expect(enableRes.status).toBe(403);
      expect(enableRes.json.ok).toBe(false);
      expect(enableRes.json.error?.code).toBe("PLUGIN_LIFECYCLE_PROMOTION_REQUIRED");

      const reviewEnableRes = await apiFetch<PluginActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/plugins/${encodeURIComponent(pluginId)}/review-enable`,
        {
          runtimeVersion,
          providerModel: LIVE_ANTHROPIC_MODEL,
        },
      );
      expect(reviewEnableRes.status).toBe(200);
      expect(reviewEnableRes.json.ok).toBe(true);
      expect(reviewEnableRes.json.data.plugin.enabled).toBe(true);
      expect(reviewEnableRes.json.data.plugin.status).toBe("running");
      expect(reviewEnableRes.json.data.plugin.promotionChannel).toBe("active");
      expect(reviewEnableRes.json.data.plugin.compatibilityStatus).toBe("compatible");
      expect(reviewEnableRes.json.data.plugin.canaryStats?.successCount).toBe(1);
      expect(reviewEnableRes.json.data.plugin.canaryStats?.failureCount).toBe(0);
      expect(reviewEnableRes.json.data.evidence?.stage).toBe("active");
      expect(reviewEnableRes.json.data.evidence?.rollbackPointerAvailable).toBe(true);
      expect(reviewEnableRes.json.data.evidence?.planDigest).toBeTruthy();

      const activatedMarker = path.join(installPath, "activated.json");
      expect(fs.existsSync(activatedMarker)).toBe(true);
      const activatedPayload = JSON.parse(fs.readFileSync(activatedMarker, "utf8")) as { pluginId: string };
      expect(activatedPayload.pluginId).toBe(pluginId);

      const replayRes = await apiFetch<PluginEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/plugins/${encodeURIComponent(pluginId)}`,
      );
      expect(replayRes.status).toBe(200);
      expect(replayRes.json.ok).toBe(true);
      expect(replayRes.json.data.plugin.status).toBe("running");

      const postAdaptStatus = await getUpgradeStatus(env, pluginId);
      expect(postAdaptStatus.derivedCompatibilityStatus).toBe("compatible");
      expect(postAdaptStatus.strategy).toBe("noop");

      const planDigest = reviewEnableRes.json.data.evidence?.planDigest;
      const shadowVersionId = reviewEnableRes.json.data.plugin.shadowVersionId ?? undefined;
      expect(planDigest).toBeTruthy();
      expect(shadowVersionId).toBeTruthy();

      const rollbackRes = await apiFetch<PluginActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/plugins/${encodeURIComponent(pluginId)}/rollback`,
        {
          runtimeVersion,
          providerModel: LIVE_ANTHROPIC_MODEL,
          planDigest,
          reason: "live plugin lifecycle rollback proof",
          canonicalApproval: makePluginLifecycleApproval({
            action: "rollback",
            pluginId,
            shadowVersionId,
            runtimeVersion,
            planDigest: planDigest!,
          }),
        },
      );
      expect(rollbackRes.status).toBe(200);
      expect(rollbackRes.json.ok).toBe(true);
      expect(rollbackRes.json.data.plugin.promotionChannel).toBe("none");
      expect(rollbackRes.json.data.plugin.enabled).toBe(false);
      expect(rollbackRes.json.data.status?.promotionChannel).toBe("none");

      const pluginRow = readPluginRow(env.stateDir!, pluginId);
      expect(pluginRow).not.toBeNull();
      expect(pluginRow?.status).toBe("installed");
      expect(pluginRow?.enabled).toBe(0);
      expect(pluginRow?.promotionChannel).toBe("none");
      expect(pluginRow?.shadowVersionId).toBeNull();
      expect(pluginRow?.lastVerifiedRuntimeVersion).toBeNull();
      expect(pluginRow?.lastVerifiedProviderModel).toBeNull();
      const canaryStats = JSON.parse(pluginRow?.canaryStatsJson ?? "{}") as {
        sampleSize?: number;
        successCount?: number;
        failureCount?: number;
        rollbackCount?: number;
      };
      expect(canaryStats.sampleSize).toBe(1);
      expect(canaryStats.successCount).toBe(1);
      expect(canaryStats.failureCount).toBe(0);
      expect(canaryStats.rollbackCount).toBe(1);

      const finalStatus = await getUpgradeStatus(env, pluginId);
      expect(finalStatus.promotionChannel).toBe("none");
      expect(finalStatus.recordedCompatibilityStatus).toBe("unknown");
    },
  );
});
