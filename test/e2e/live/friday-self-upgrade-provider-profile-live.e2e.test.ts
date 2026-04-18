import Database from "better-sqlite3";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LIVE_ANTHROPIC_MODEL, liveAnthropicCredentialMessage } from "../_helpers/live-anthropic.js";
import { apiFetch, createAnthropicProvider } from "./_helpers/api.js";
import {
  cleanupFridayDeepProofHubEnv,
  createFridayDeepProofHubEnv,
  FRIDAY_DEEP_PROOF_ANTHROPIC_API_KEY_ENV_REF,
  FRIDAY_DEEP_PROOF_GATED,
  type RealHubEnv,
} from "./_helpers/deep-proof-env.js";

const ANTHROPIC_BASE_URL = process.env.E2E_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";

interface RuntimeVersionEnvelope {
  ok: boolean;
  data: {
    version: string;
    apiVersion: string;
  };
}

interface ProviderEnvelope {
  ok: boolean;
  data: {
    provider: {
      id: string;
      name: string;
      defaultModel?: string;
      enabled: boolean;
      promotionChannel?: string;
      compatibilityStatus?: string;
      shadowVersionId?: string;
      canaryStats?: {
        sampleSize: number;
        successCount: number;
        failureCount: number;
        rollbackCount: number;
      };
      config: {
        validation?: {
          status?: string;
        };
      };
    };
    validation?: {
      status?: string;
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

interface ProviderActionEnvelope {
  ok: boolean;
  data: {
    provider: {
      id: string;
      enabled: boolean;
      promotionChannel?: string;
      compatibilityStatus?: string;
      shadowVersionId?: string;
      canaryStats?: {
        sampleSize: number;
        successCount: number;
        failureCount: number;
        rollbackCount: number;
      };
      validationStatus?: string;
    };
    status: UpgradeStatusEnvelope["data"]["items"][number] | null;
  };
}

interface ProviderRowReadback {
  compatibilityStatus: string;
  promotionChannel: string;
  shadowVersionId: string | null;
  canaryStatsJson: string;
  configJson: string;
  lastVerifiedRuntimeVersion: string | null;
  lastVerifiedProviderModel: string | null;
}

function openStateDb(stateDir: string): Database.Database {
  return new Database(path.join(stateDir, "friday.db"), { readonly: true, fileMustExist: true });
}

function readProviderRow(stateDir: string, providerId: string): ProviderRowReadback | null {
  const db = openStateDb(stateDir);
  try {
    return (
      db
        .prepare(
          `SELECT compatibility_status AS compatibilityStatus,
                  promotion_channel AS promotionChannel,
                  shadow_version_id AS shadowVersionId,
                  canary_stats_json AS canaryStatsJson,
                  config_json AS configJson,
                  last_verified_runtime_version AS lastVerifiedRuntimeVersion,
                  last_verified_provider_model AS lastVerifiedProviderModel
             FROM provider_profiles
            WHERE id = ?`,
        )
        .get(providerId) as ProviderRowReadback | undefined
    ) ?? null;
  } finally {
    db.close();
  }
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

async function getProvider(env: RealHubEnv, providerId: string): Promise<ProviderEnvelope["data"]> {
  const response = await apiFetch<ProviderEnvelope>(
    env.baseUrl,
    env.accessToken,
    "GET",
    `/v1/providers/${encodeURIComponent(providerId)}`,
  );
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  return response.json.data;
}

async function getUpgradeStatus(env: RealHubEnv, providerId: string): Promise<UpgradeStatusEnvelope["data"]["items"][number]> {
  const response = await apiFetch<UpgradeStatusEnvelope>(
    env.baseUrl,
    env.accessToken,
    "GET",
    `/v1/autonomy/upgrade-status?kind=provider_profile&id=${encodeURIComponent(providerId)}`,
  );
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  expect(response.json.data.items).toHaveLength(1);
  return response.json.data.items[0]!;
}

describe.skipIf(!FRIDAY_DEEP_PROOF_GATED)("Friday Provider Profile Self Upgrade Live (Anthropic API key)", () => {
  let env: RealHubEnv;

  beforeAll(async () => {
    env = await createFridayDeepProofHubEnv();
  }, 120_000);

  afterAll(async () => {
    if (env) {
      await cleanupFridayDeepProofHubEnv(env);
    }
  }, 30_000);

  it(
    "proves provider_profile detect-adapt-replay-shadow-canary-promote-rollback with API and SQLite readback",
    { timeout: 300_000, retry: 1 },
    async () => {
      const apiKeyEnvRef = FRIDAY_DEEP_PROOF_ANTHROPIC_API_KEY_ENV_REF
        ?? (() => {
          throw new Error(liveAnthropicCredentialMessage());
        })();
      const runtimeVersion = await getRuntimeVersion(env);
      const providerId = await createAnthropicProvider(env.baseUrl, env.accessToken, {
        name: `Provider Self Upgrade ${Date.now().toString(36)}`,
        anthropicBaseUrl: ANTHROPIC_BASE_URL,
        models: [LIVE_ANTHROPIC_MODEL],
        defaultModel: LIVE_ANTHROPIC_MODEL,
        apiKeyEnvRef,
      });

      const detectStatus = await getUpgradeStatus(env, providerId);
      expect(detectStatus.derivedCompatibilityStatus).toBe("adaptation_required");
      expect(detectStatus.strategy).toBe("patch");
      expect(
        detectStatus.findings.some((finding) => finding.id === "provider_validation_status" && !finding.passed),
      ).toBe(true);

      const validateRes = await apiFetch<ProviderEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/providers/${encodeURIComponent(providerId)}/validate`,
      );
      expect(validateRes.status).toBe(200);
      expect(validateRes.json.ok).toBe(true);
      expect(validateRes.json.data.validation?.status).toBe("ok");

      const replayProvider = await getProvider(env, providerId);
      expect(replayProvider.provider.config.validation?.status).toBe("ok");

      const postAdaptStatus = await getUpgradeStatus(env, providerId);
      expect(postAdaptStatus.derivedCompatibilityStatus).toBe("compatible");
      expect(postAdaptStatus.strategy).toBe("noop");

      const firstShadowId = `${providerId}@shadow`;
      const shadowRes = await apiFetch<ProviderActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/providers/${encodeURIComponent(providerId)}/shadow`,
        {
          shadowVersionId: firstShadowId,
          runtimeVersion,
          providerModel: LIVE_ANTHROPIC_MODEL,
        },
      );
      expect(shadowRes.status).toBe(200);
      expect(shadowRes.json.ok).toBe(true);
      expect(shadowRes.json.data.provider.promotionChannel).toBe("shadow");
      expect(shadowRes.json.data.status?.promotionChannel).toBe("shadow");
      expect(shadowRes.json.data.status?.shadowVersionId).toBe(firstShadowId);

      const canaryRes = await apiFetch<ProviderActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/providers/${encodeURIComponent(providerId)}/canary`,
        {
          success: true,
        },
      );
      expect(canaryRes.status).toBe(200);
      expect(canaryRes.json.ok).toBe(true);
      expect(canaryRes.json.data.provider.promotionChannel).toBe("canary");
      expect(canaryRes.json.data.provider.canaryStats?.sampleSize).toBe(1);
      expect(canaryRes.json.data.provider.canaryStats?.successCount).toBe(1);

      const promoteRes = await apiFetch<ProviderActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/providers/${encodeURIComponent(providerId)}/promote`,
        {
          runtimeVersion,
          providerModel: LIVE_ANTHROPIC_MODEL,
        },
      );
      expect(promoteRes.status).toBe(200);
      expect(promoteRes.json.ok).toBe(true);
      expect(promoteRes.json.data.provider.promotionChannel).toBe("active");
      expect(promoteRes.json.data.status?.promotionChannel).toBe("active");
      expect(promoteRes.json.data.status?.derivedCompatibilityStatus).toBe("compatible");

      const secondShadowId = `${providerId}@shadow-rollback`;
      const shadowRollbackRes = await apiFetch<ProviderActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/providers/${encodeURIComponent(providerId)}/shadow`,
        {
          shadowVersionId: secondShadowId,
          runtimeVersion,
          providerModel: LIVE_ANTHROPIC_MODEL,
        },
      );
      expect(shadowRollbackRes.status).toBe(200);
      expect(shadowRollbackRes.json.ok).toBe(true);

      const failedCanaryRes = await apiFetch<ProviderActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/providers/${encodeURIComponent(providerId)}/canary`,
        {
          success: false,
        },
      );
      expect(failedCanaryRes.status).toBe(200);
      expect(failedCanaryRes.json.ok).toBe(true);
      expect(failedCanaryRes.json.data.provider.canaryStats?.sampleSize).toBe(2);
      expect(failedCanaryRes.json.data.provider.canaryStats?.failureCount).toBe(1);

      const rollbackRes = await apiFetch<ProviderActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/providers/${encodeURIComponent(providerId)}/rollback`,
        {
          runtimeVersion,
          providerModel: LIVE_ANTHROPIC_MODEL,
        },
      );
      expect(rollbackRes.status).toBe(200);
      expect(rollbackRes.json.ok).toBe(true);
      expect(rollbackRes.json.data.provider.promotionChannel).toBe("rolled_back");
      expect(rollbackRes.json.data.status?.promotionChannel).toBe("rolled_back");

      const providerRow = readProviderRow(env.stateDir!, providerId);
      expect(providerRow).not.toBeNull();
      expect(providerRow?.promotionChannel).toBe("rolled_back");
      expect(providerRow?.shadowVersionId).toBeNull();
      expect(providerRow?.lastVerifiedRuntimeVersion).toBe(runtimeVersion);
      expect(providerRow?.lastVerifiedProviderModel).toBe(LIVE_ANTHROPIC_MODEL);
      const canaryStats = JSON.parse(providerRow?.canaryStatsJson ?? "{}") as {
        sampleSize?: number;
        successCount?: number;
        failureCount?: number;
        rollbackCount?: number;
      };
      expect(canaryStats.sampleSize).toBe(2);
      expect(canaryStats.successCount).toBe(1);
      expect(canaryStats.failureCount).toBe(1);
      expect(canaryStats.rollbackCount).toBe(1);
      const config = JSON.parse(providerRow?.configJson ?? "{}") as {
        validation?: { status?: string };
      };
      expect(config.validation?.status).toBe("ok");

      const finalStatus = await getUpgradeStatus(env, providerId);
      expect(finalStatus.promotionChannel).toBe("rolled_back");
      expect(finalStatus.recordedCompatibilityStatus).toBe("adaptation_required");
    },
  );
});
