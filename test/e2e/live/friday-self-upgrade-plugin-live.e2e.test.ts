import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LIVE_ANTHROPIC_MODEL } from "../_helpers/live-anthropic.js";
import { apiFetch } from "./_helpers/api.js";
import {
  cleanupFridayDeepProofHubEnv,
  createFridayDeepProofHubEnv,
  FRIDAY_DEEP_PROOF_GATED,
  type RealHubEnv,
} from "./_helpers/deep-proof-env.js";

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

describe.skipIf(!FRIDAY_DEEP_PROOF_GATED)("Friday Plugin Self Upgrade Live (Anthropic API key lane)", () => {
  let env: RealHubEnv;
  let pluginRootDir: string;

  beforeAll(async () => {
    env = await createFridayDeepProofHubEnv();
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

      const enableRes = await apiFetch<PluginEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/plugins/${encodeURIComponent(pluginId)}/enable`,
      );
      expect(enableRes.status).toBe(200);
      expect(enableRes.json.ok).toBe(true);
      expect(enableRes.json.data.plugin.enabled).toBe(true);
      expect(enableRes.json.data.plugin.status).toBe("running");

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

      const firstShadowId = `${pluginId}@shadow`;
      const shadowRes = await apiFetch<PluginActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/plugins/${encodeURIComponent(pluginId)}/shadow`,
        {
          shadowVersionId: firstShadowId,
          runtimeVersion,
          providerModel: LIVE_ANTHROPIC_MODEL,
        },
      );
      expect(shadowRes.status).toBe(200);
      expect(shadowRes.json.ok).toBe(true);
      expect(shadowRes.json.data.plugin.promotionChannel).toBe("shadow");
      expect(shadowRes.json.data.status?.promotionChannel).toBe("shadow");
      expect(shadowRes.json.data.status?.shadowVersionId).toBe(firstShadowId);

      const canaryRes = await apiFetch<PluginActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/plugins/${encodeURIComponent(pluginId)}/canary`,
        { success: true },
      );
      expect(canaryRes.status).toBe(200);
      expect(canaryRes.json.ok).toBe(true);
      expect(canaryRes.json.data.plugin.promotionChannel).toBe("canary");
      expect(canaryRes.json.data.plugin.canaryStats?.sampleSize).toBe(1);
      expect(canaryRes.json.data.plugin.canaryStats?.successCount).toBe(1);

      const promoteRes = await apiFetch<PluginActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/plugins/${encodeURIComponent(pluginId)}/promote`,
        {
          runtimeVersion,
          providerModel: LIVE_ANTHROPIC_MODEL,
        },
      );
      expect(promoteRes.status).toBe(200);
      expect(promoteRes.json.ok).toBe(true);
      expect(promoteRes.json.data.plugin.promotionChannel).toBe("active");
      expect(promoteRes.json.data.status?.promotionChannel).toBe("active");
      expect(promoteRes.json.data.status?.derivedCompatibilityStatus).toBe("compatible");

      const secondShadowId = `${pluginId}@shadow-rollback`;
      const secondShadowRes = await apiFetch<PluginActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/plugins/${encodeURIComponent(pluginId)}/shadow`,
        {
          shadowVersionId: secondShadowId,
          runtimeVersion,
          providerModel: LIVE_ANTHROPIC_MODEL,
        },
      );
      expect(secondShadowRes.status).toBe(200);
      expect(secondShadowRes.json.ok).toBe(true);

      const failedCanaryRes = await apiFetch<PluginActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/plugins/${encodeURIComponent(pluginId)}/canary`,
        { success: false },
      );
      expect(failedCanaryRes.status).toBe(200);
      expect(failedCanaryRes.json.ok).toBe(true);
      expect(failedCanaryRes.json.data.plugin.canaryStats?.sampleSize).toBe(2);
      expect(failedCanaryRes.json.data.plugin.canaryStats?.failureCount).toBe(1);

      const rollbackRes = await apiFetch<PluginActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/plugins/${encodeURIComponent(pluginId)}/rollback`,
        {
          runtimeVersion,
          providerModel: LIVE_ANTHROPIC_MODEL,
        },
      );
      expect(rollbackRes.status).toBe(200);
      expect(rollbackRes.json.ok).toBe(true);
      expect(rollbackRes.json.data.plugin.promotionChannel).toBe("rolled_back");
      expect(rollbackRes.json.data.status?.promotionChannel).toBe("rolled_back");

      const pluginRow = readPluginRow(env.stateDir!, pluginId);
      expect(pluginRow).not.toBeNull();
      expect(pluginRow?.status).toBe("running");
      expect(pluginRow?.enabled).toBe(1);
      expect(pluginRow?.promotionChannel).toBe("rolled_back");
      expect(pluginRow?.shadowVersionId).toBeNull();
      expect(pluginRow?.lastVerifiedRuntimeVersion).toBe(runtimeVersion);
      expect(pluginRow?.lastVerifiedProviderModel).toBe(LIVE_ANTHROPIC_MODEL);
      const canaryStats = JSON.parse(pluginRow?.canaryStatsJson ?? "{}") as {
        sampleSize?: number;
        successCount?: number;
        failureCount?: number;
        rollbackCount?: number;
      };
      expect(canaryStats.sampleSize).toBe(2);
      expect(canaryStats.successCount).toBe(1);
      expect(canaryStats.failureCount).toBe(1);
      expect(canaryStats.rollbackCount).toBe(1);

      const finalStatus = await getUpgradeStatus(env, pluginId);
      expect(finalStatus.promotionChannel).toBe("rolled_back");
      expect(finalStatus.recordedCompatibilityStatus).toBe("adaptation_required");
    },
  );
});
