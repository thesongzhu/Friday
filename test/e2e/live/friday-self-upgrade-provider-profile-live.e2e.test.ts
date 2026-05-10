import Database from "better-sqlite3";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apiFetch } from "./_helpers/api.js";
import {
  createFridayProviderProfileLifecycleMutatingActionRequest,
} from "../../../src/autonomy/services/friday-provider-profile-upgrade-lifecycle-service.js";
import {
  createFridayMutatingActionDigest,
  signFridayCanonicalApproval,
  type FridayCanonicalApprovalResolution,
} from "../../../src/security/friday-mutating-action-gate.js";
import {
  cleanupFridayDeepProofHubEnv,
  createFridayDeepProofHubEnv,
  createFridayDeepProofProvider,
  FRIDAY_DEEP_PROOF_GATED,
  FRIDAY_DEEP_PROOF_PROVIDER_LABEL,
  type RealHubEnv,
} from "./_helpers/deep-proof-env.js";
const PROVIDER_LIFECYCLE_PLAN_DIGEST = "provider-profile-live-proof-plan";
const PROVIDER_LIFECYCLE_SIGNING_MATERIAL =
  "provider-profile-live-proof-signing-material"; // pragma: allowlist secret
const LOCAL_LIVE_PRINCIPAL_ID = "admin-001";

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

function makeProviderLifecycleApproval(input: {
  action: "shadow" | "canary" | "promote" | "rollback";
  providerId: string;
  shadowVersionId?: string;
  runtimeVersion: string;
  providerModel: string;
}): FridayCanonicalApprovalResolution {
  const rollback = input.action === "rollback"
    ? { planned: true, planDigest: PROVIDER_LIFECYCLE_PLAN_DIGEST, actions: ["providers.lifecycle.promote"] }
    : undefined;
  const request = createFridayProviderProfileLifecycleMutatingActionRequest({
    action: input.action,
    providerId: input.providerId,
    shadowVersionId: input.shadowVersionId,
    runtimeVersion: input.runtimeVersion,
    providerModel: input.providerModel,
    actor: {
      kind: "user",
      id: LOCAL_LIVE_PRINCIPAL_ID,
      principalId: LOCAL_LIVE_PRINCIPAL_ID,
    },
    surface: `api:/v1/autonomy/providers/${input.action}`,
    planDigest: PROVIDER_LIFECYCLE_PLAN_DIGEST,
    rollback,
  });
  return signFridayCanonicalApproval({
    decision: "approved",
    approvalId: `provider-profile-live-${input.action}`,
    decidedByPrincipalId: LOCAL_LIVE_PRINCIPAL_ID,
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2027-05-07T00:00:00.000Z",
  }, PROVIDER_LIFECYCLE_SIGNING_MATERIAL);
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

describe.skipIf(!FRIDAY_DEEP_PROOF_GATED)(`Friday Provider Profile Self Upgrade Live (${FRIDAY_DEEP_PROOF_PROVIDER_LABEL} active provider)`, () => {
  let env: RealHubEnv;

  beforeAll(async () => {
    env = await createFridayDeepProofHubEnv({
      hubConfig: {
        tokenSecret: PROVIDER_LIFECYCLE_SIGNING_MATERIAL,
      },
    });
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
      const runtimeVersion = await getRuntimeVersion(env);
      // Active-provider proof: a DeepSeek run proves DeepSeek provider-profile
      // upgrade lifecycle, an Anthropic run proves Anthropic. Lane is fixed
      // by the deep-proof env gate, not by this test body.
      const providerCreation = await createFridayDeepProofProvider(env, {
        name: `Provider Self Upgrade ${Date.now().toString(36)}`,
      });
      const providerId = providerCreation.providerId;
      const providerModel = providerCreation.model;

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
          providerModel,
          planDigest: PROVIDER_LIFECYCLE_PLAN_DIGEST,
          canonicalApproval: makeProviderLifecycleApproval({
            providerModel,
            action: "shadow",
            providerId,
            shadowVersionId: firstShadowId,
            runtimeVersion,
          }),
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
          runtimeVersion,
          providerModel,
          planDigest: PROVIDER_LIFECYCLE_PLAN_DIGEST,
          canonicalApproval: makeProviderLifecycleApproval({
            providerModel,
            action: "canary",
            providerId,
            shadowVersionId: firstShadowId,
            runtimeVersion,
          }),
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
          providerModel,
          planDigest: PROVIDER_LIFECYCLE_PLAN_DIGEST,
          canonicalApproval: makeProviderLifecycleApproval({
            providerModel,
            action: "promote",
            providerId,
            shadowVersionId: firstShadowId,
            runtimeVersion,
          }),
        },
      );
      expect(promoteRes.status).toBe(200);
      expect(promoteRes.json.ok).toBe(true);
      expect(promoteRes.json.data.provider.promotionChannel).toBe("active");
      expect(promoteRes.json.data.status?.promotionChannel).toBe("active");
      expect(promoteRes.json.data.status?.derivedCompatibilityStatus).toBe("compatible");

      const rollbackRes = await apiFetch<ProviderActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/providers/${encodeURIComponent(providerId)}/rollback`,
        {
          runtimeVersion,
          providerModel,
          planDigest: PROVIDER_LIFECYCLE_PLAN_DIGEST,
          reason: "live provider lifecycle rollback proof",
          canonicalApproval: makeProviderLifecycleApproval({
            providerModel,
            action: "rollback",
            providerId,
            shadowVersionId: firstShadowId,
            runtimeVersion,
          }),
        },
      );
      expect(rollbackRes.status).toBe(200);
      expect(rollbackRes.json.ok).toBe(true);
      expect(rollbackRes.json.data.provider.promotionChannel).toBe("none");
      expect(rollbackRes.json.data.status?.promotionChannel).toBe("none");

      const providerRow = readProviderRow(env.stateDir!, providerId);
      expect(providerRow).not.toBeNull();
      expect(providerRow?.promotionChannel).toBe("none");
      expect(providerRow?.shadowVersionId).toBeNull();
      expect(providerRow?.lastVerifiedRuntimeVersion).toBeNull();
      expect(providerRow?.lastVerifiedProviderModel).toBeNull();
      const canaryStats = JSON.parse(providerRow?.canaryStatsJson ?? "{}") as {
        sampleSize?: number;
        successCount?: number;
        failureCount?: number;
        rollbackCount?: number;
      };
      expect(canaryStats.sampleSize).toBe(0);
      expect(canaryStats.successCount).toBe(0);
      expect(canaryStats.failureCount).toBe(0);
      expect(canaryStats.rollbackCount).toBe(1);
      const config = JSON.parse(providerRow?.configJson ?? "{}") as {
        validation?: { status?: string };
      };
      expect(config.validation?.status).toBe("ok");

      const finalStatus = await getUpgradeStatus(env, providerId);
      expect(finalStatus.promotionChannel).toBe("none");
      expect(finalStatus.recordedCompatibilityStatus).toBe("unknown");
    },
  );
});
