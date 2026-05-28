import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  apiFetch,
  createDeepSeekProvider,
  createOpenAiProvider,
  verifyProviderTextCapability,
} from "./_helpers/api.js";
import {
  cleanupRealHubEnv,
  createRealHubEnv,
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_BASE_URL,
  OPENAI_API_KEY_ENV,
  OPENAI_BASE_URL,
  type RealHubEnv,
} from "./_helpers/real-env.js";

const C3C4_GATED = process.env.FRIDAY_E2E_LIVE_DEEPSEEK === "1"
  && hasEnvValue(DEEPSEEK_API_KEY_ENV)
  && hasEnvValue(OPENAI_API_KEY_ENV);
const DEEPSEEK_MODEL = process.env.FRIDAY_C3C4_DEEPSEEK_MODEL ?? "deepseek-v4-pro";
const OPENAI_MODEL = process.env.FRIDAY_C3C4_OPENAI_MODEL ?? "gpt-4o-mini";
const REPORT_ROOT = process.env.FRIDAY_C3C4_PROVIDER_REPORT_ROOT;

interface RoutingSnapshot {
  defaultProviderId: string;
  defaultModel?: string;
  fallbackProviderIds: string[];
}

interface AgentRun {
  id: string;
  status: string;
  responseText?: string;
  actualExecution?: {
    actualProviderId?: string;
    actualProviderKind?: string;
    actualModel?: string;
    totalCostUsd?: number;
    fallbackAttempts?: Array<{
      providerId: string;
      providerKind: string;
      model: string;
      reason?: string;
      status?: string;
      code?: string;
      error?: string;
    }>;
    turns: Array<{
      providerId?: string;
      model?: string;
      inputTokens: number;
      outputTokens: number;
      costUsd?: number;
    }>;
  };
}

interface ProofReport {
  schemaVersion: 1;
  generatedAt?: string;
  gated: boolean;
  noSensitiveDataStatement: string;
  expectedSpendUsdCap: number;
  models: {
    deepseek: string;
    openai: string;
  };
  providerProof: {
    deepseekPrimary: Record<string, unknown> | null;
    openaiFallback: Record<string, unknown> | null;
    budgetLabels: Record<string, unknown> | null;
    invalidPrimaryDidNotBecomeAvailable: Record<string, unknown> | null;
    disabledProviderDidNotBecomeAvailable: Record<string, unknown> | null;
  };
  companionProof: {
    selfHealingLiveSuite: string;
    expectedCoverage: string[];
  };
  notes: string[];
}

function hasEnvValue(name: string): boolean {
  return typeof process.env[name] === "string" && process.env[name]!.trim().length > 0;
}

function writeReport(report: ProofReport): void {
  if (!REPORT_ROOT) {
    return;
  }
  fs.mkdirSync(REPORT_ROOT, { recursive: true });
  fs.writeFileSync(
    path.join(REPORT_ROOT, "c3c4-provider-routing-proof.json"),
    `${JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

async function putRouting(
  env: RealHubEnv,
  input: { defaultProviderId: string; defaultModel?: string; fallbackProviderIds?: string[] },
): Promise<RoutingSnapshot> {
  const { status, json } = await apiFetch<{
    ok: boolean;
    data: { routing: RoutingSnapshot };
  }>(env.baseUrl, env.accessToken, "PUT", "/v1/model-routing", input);
  if (status !== 200 || !json.ok) {
    throw new Error(`Failed to update routing: ${JSON.stringify(json)}`);
  }
  return json.data.routing;
}

async function readAgentRun(env: RealHubEnv, runId: string): Promise<AgentRun> {
  const get = await apiFetch<{
    ok: boolean;
    data: { run: AgentRun };
  }>(env.baseUrl, env.accessToken, "GET", `/v1/agent/runs/${encodeURIComponent(runId)}`);
  if (get.status !== 200 || !get.json.ok) {
    throw new Error(`Failed to read agent run ${runId}: ${JSON.stringify(get.json)}`);
  }
  return get.json.data.run;
}

async function startAgentRun(env: RealHubEnv, task: string): Promise<AgentRun> {
  const start = await apiFetch<{
    ok: boolean;
    data?: { runId?: string };
    runId?: string;
    error?: { code?: string; message?: string };
  }>(
    env.baseUrl,
    env.accessToken,
    "POST",
    "/v1/agent/runs",
    {
      task,
      timeoutMs: 180_000,
      constraints: { readOnly: true, operationalMode: "restricted" },
      taskProfile: { id: "deterministic", temperature: 0 },
      executionContext: { surface: "c3c4-provider-routing-live-proof" },
    },
    { timeoutMs: 240_000 },
  );
  if (start.status !== 200 || start.json.ok === false) {
    throw new Error(`Agent run failed to start: ${JSON.stringify(start.json)}`);
  }
  const runId = start.json.data?.runId ?? start.json.runId;
  if (!runId) {
    throw new Error(`Agent run response did not include runId: ${JSON.stringify(start.json)}`);
  }

  const terminal = new Set(["completed", "failed", "cancelled"]);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 180_000) {
    const run = await readAgentRun(env, runId);
    if (terminal.has(run.status)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return readAgentRun(env, runId);
}

async function getProvider(env: RealHubEnv, providerId: string): Promise<{
  enabled?: boolean;
  config?: {
    validation?: { status?: string; errorCode?: string | null };
    runtimeCapabilities?: Array<{ capability?: string; status?: string; verified?: boolean }>;
  };
}> {
  const res = await apiFetch<{
    ok: boolean;
    data?: {
      provider?: {
        enabled?: boolean;
        config?: {
          validation?: { status?: string; errorCode?: string | null };
          runtimeCapabilities?: Array<{ capability?: string; status?: string; verified?: boolean }>;
        };
      };
    };
  }>(env.baseUrl, env.accessToken, "GET", `/v1/providers/${encodeURIComponent(providerId)}`);
  if (res.status !== 200 || !res.json.ok || !res.json.data?.provider) {
    throw new Error(`Failed to read provider ${providerId}: ${JSON.stringify(res.json)}`);
  }
  return res.json.data.provider;
}

async function getUsageSummary(env: RealHubEnv): Promise<{
  totals: { callCount: number; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
}> {
  const today = new Date().toISOString().slice(0, 10);
  const res = await apiFetch<{
    ok: boolean;
    data: { summary: { totals: { callCount: number; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number } } };
  }>(
    env.baseUrl,
    env.accessToken,
    "GET",
    `/v1/providers/usage?from=${today}&to=${today}&groupBy=provider`,
  );
  if (res.status !== 200 || !res.json.ok) {
    throw new Error(`Failed to read provider usage: ${JSON.stringify(res.json)}`);
  }
  return res.json.data.summary;
}

async function setBudget(env: RealHubEnv, monthlyLimitUsd: number): Promise<{
  state: "ok" | "near_limit" | "over_limit";
  spentUsd: number;
  remainingUsd: number | null;
  config: { monthlyLimitUsd: number } | null;
}> {
  const set = await apiFetch<{ ok: boolean }>(
    env.baseUrl,
    env.accessToken,
    "PUT",
    "/v1/providers/budget",
    { monthlyLimitUsd },
  );
  if (set.status !== 200 || !set.json.ok) {
    throw new Error(`Failed to set provider budget: ${JSON.stringify(set.json)}`);
  }

  const get = await apiFetch<{
    ok: boolean;
    data: {
      budget: {
        state: "ok" | "near_limit" | "over_limit";
        spentUsd: number;
        remainingUsd: number | null;
        config: { monthlyLimitUsd: number } | null;
      };
    };
  }>(env.baseUrl, env.accessToken, "GET", "/v1/providers/budget");
  if (get.status !== 200 || !get.json.ok) {
    throw new Error(`Failed to read provider budget: ${JSON.stringify(get.json)}`);
  }
  return get.json.data.budget;
}

async function createDisabledOpenAiProvider(env: RealHubEnv): Promise<string> {
  const { status, json } = await apiFetch<{
    ok: boolean;
    data: { provider: { id: string } };
  }>(env.baseUrl, env.accessToken, "POST", "/v1/providers", {
    kind: "openai",
    name: "C3C4 Disabled OpenAI Capability Truth",
    baseUrl: OPENAI_BASE_URL,
    authMode: "bearer-token",
    api: "openai-completions",
    apiKey: `$${OPENAI_API_KEY_ENV}`,
    supportedModels: [OPENAI_MODEL],
    defaultModel: OPENAI_MODEL,
    enabled: false,
    validateOnSave: false,
    runtimeCapabilities: [{
      capability: "text",
      model: OPENAI_MODEL,
      status: "declared",
      verified: false,
      notes: "C3/C4 proof disabled-provider lane; must not appear available.",
    }],
  });
  if (status !== 200 || !json.ok) {
    throw new Error(`Failed to create disabled OpenAI provider: ${JSON.stringify(json)}`);
  }
  return json.data.provider.id;
}

async function getCapabilityHealthForProvider(env: RealHubEnv, providerId: string): Promise<{
  enabled: boolean;
  capabilities: Array<{ capability: string; state: string; message: string }>;
}> {
  const res = await apiFetch<{
    ok: boolean;
    data: {
      items: Array<{
        providerId: string;
        enabled: boolean;
        capabilities: Array<{ capability: string; state: string; message: string }>;
      }>;
    };
  }>(env.baseUrl, env.accessToken, "GET", "/v1/providers/capability-health");
  if (res.status !== 200 || !res.json.ok) {
    throw new Error(`Failed to read provider capability health: ${JSON.stringify(res.json)}`);
  }
  const item = res.json.data.items.find((candidate) => candidate.providerId === providerId);
  if (!item) {
    throw new Error(`Capability health did not include provider ${providerId}`);
  }
  return item;
}

describe.skipIf(!C3C4_GATED)("C3/C4 live provider routing proof (DeepSeek primary, OpenAI fallback)", () => {
  let env: RealHubEnv;
  let deepseekProviderId: string;
  let openaiProviderId: string;
  let brokenDeepseekProviderId: string;
  let disabledOpenaiProviderId: string;
  const report: ProofReport = {
    schemaVersion: 1,
    gated: C3C4_GATED,
    noSensitiveDataStatement: "No provider secret values are printed, asserted, or persisted by this proof.",
    expectedSpendUsdCap: 50,
    models: {
      deepseek: DEEPSEEK_MODEL,
      openai: OPENAI_MODEL,
    },
    providerProof: {
      deepseekPrimary: null,
      openaiFallback: null,
      budgetLabels: null,
      invalidPrimaryDidNotBecomeAvailable: null,
      disabledProviderDidNotBecomeAvailable: null,
    },
    companionProof: {
      selfHealingLiveSuite: "test/e2e/live/friday-self-healing-live.e2e.test.ts",
      expectedCoverage: [
        "live provider self-repair",
        "model fallback self-healing recovery",
        "real HTTP execute and rollback evidence",
        "workflow failure incident and loop run",
        "skill-drift repair requiring approval before execution",
      ],
    },
    notes: [
      "DeepSeek primary success and OpenAI fallback success are recorded separately; OpenAI fallback is not counted as DeepSeek success.",
      "The companion live self-healing suite is run by the C3/C4 RGG job after this provider-routing proof.",
      "All state is temporary local Friday state created by the live E2E harness.",
    ],
  };

  beforeAll(async () => {
    env = await createRealHubEnv();
    deepseekProviderId = await createDeepSeekProvider(env.baseUrl, env.accessToken, {
      name: "C3C4 DeepSeek Primary Live Proof",
      deepSeekBaseUrl: DEEPSEEK_BASE_URL,
      models: [DEEPSEEK_MODEL],
      defaultModel: DEEPSEEK_MODEL,
      apiKeyEnvRef: `$${DEEPSEEK_API_KEY_ENV}`,
    });
    openaiProviderId = await createOpenAiProvider(env.baseUrl, env.accessToken, {
      name: "C3C4 OpenAI Fallback Live Proof",
      openAiBaseUrl: OPENAI_BASE_URL,
      models: [OPENAI_MODEL],
      defaultModel: OPENAI_MODEL,
      apiKeyEnvRef: `$${OPENAI_API_KEY_ENV}`,
    });
    brokenDeepseekProviderId = await createDeepSeekProvider(env.baseUrl, env.accessToken, {
      name: "C3C4 Broken DeepSeek Primary Live Proof",
      deepSeekBaseUrl: DEEPSEEK_BASE_URL,
      models: [DEEPSEEK_MODEL],
      defaultModel: DEEPSEEK_MODEL,
      apiKeyEnvRef: "$FRIDAY_C3C4_INTENTIONALLY_MISSING_DEEPSEEK_KEY",
    });
    disabledOpenaiProviderId = await createDisabledOpenAiProvider(env);

    await verifyProviderTextCapability(env.baseUrl, env.accessToken, deepseekProviderId, DEEPSEEK_MODEL, {
      doctorProviderIds: [deepseekProviderId, openaiProviderId],
    });
    await verifyProviderTextCapability(env.baseUrl, env.accessToken, openaiProviderId, OPENAI_MODEL, {
      runDoctor: false,
    });
  }, 180_000);

  afterAll(async () => {
    try {
      writeReport(report);
    } finally {
      if (env) {
        await cleanupRealHubEnv(env);
      }
    }
  }, 30_000);

  it("routes a live agent turn through DeepSeek as the configured primary provider", async () => {
    const routing = await putRouting(env, {
      defaultProviderId: deepseekProviderId,
      defaultModel: DEEPSEEK_MODEL,
      fallbackProviderIds: [openaiProviderId],
    });
    expect(routing.defaultProviderId).toBe(deepseekProviderId);
    expect(routing.fallbackProviderIds).toEqual([openaiProviderId]);

    const run = await startAgentRun(
      env,
      "Reply with exactly this token and no other text: C3C4_DEEPSEEK_PRIMARY_OK",
    );
    expect(run.status).toBe("completed");
    expect(run.actualExecution?.actualProviderId).toBe(deepseekProviderId);
    expect(run.actualExecution?.actualProviderKind).toBe("deepseek");
    expect(run.actualExecution?.actualModel).toBe(DEEPSEEK_MODEL);
    expect(run.actualExecution?.fallbackAttempts ?? []).toEqual([]);
    expect((run.actualExecution?.turns ?? []).length).toBeGreaterThan(0);

    report.providerProof.deepseekPrimary = {
      runId: run.id,
      status: run.status,
      actualProviderKind: run.actualExecution?.actualProviderKind,
      actualModel: run.actualExecution?.actualModel,
      totalCostUsd: run.actualExecution?.totalCostUsd ?? null,
      turnCount: run.actualExecution?.turns.length ?? 0,
    };
  }, 240_000);

  it("falls back to OpenAI when the DeepSeek primary route has an invalid credential reference", async () => {
    const routing = await putRouting(env, {
      defaultProviderId: brokenDeepseekProviderId,
      defaultModel: DEEPSEEK_MODEL,
      fallbackProviderIds: [openaiProviderId],
    });
    expect(routing.defaultProviderId).toBe(brokenDeepseekProviderId);
    expect(routing.fallbackProviderIds).toEqual([openaiProviderId]);

    const run = await startAgentRun(
      env,
      "Reply with exactly this token and no other text: C3C4_OPENAI_FALLBACK_OK",
    );
    expect(run.status).toBe("completed");
    expect(run.actualExecution?.actualProviderId).toBe(openaiProviderId);
    expect(run.actualExecution?.actualProviderKind).toBe("openai");
    expect(run.actualExecution?.actualModel).toBe(OPENAI_MODEL);

    const attempts = run.actualExecution?.fallbackAttempts ?? [];
    expect(attempts.every((attempt) => !JSON.stringify(attempt).includes(process.env[OPENAI_API_KEY_ENV] ?? "__missing__"))).toBe(true);
    expect(attempts.every((attempt) => !JSON.stringify(attempt).includes(process.env[DEEPSEEK_API_KEY_ENV] ?? "__missing__"))).toBe(true);

    const brokenPrimaryAfterRun = await getProvider(env, brokenDeepseekProviderId);
    expect(brokenPrimaryAfterRun.config?.validation?.status).toBe("failed");
    expect(brokenPrimaryAfterRun.config?.validation?.errorCode).toBeTruthy();

    report.providerProof.openaiFallback = {
      runId: run.id,
      status: run.status,
      brokenPrimaryProviderKind: "deepseek",
      brokenPrimaryValidationStatus: brokenPrimaryAfterRun.config?.validation?.status,
      brokenPrimaryValidationErrorCode: brokenPrimaryAfterRun.config?.validation?.errorCode ?? null,
      actualProviderKind: run.actualExecution?.actualProviderKind,
      actualModel: run.actualExecution?.actualModel,
      fallbackSelectedOpenAi: run.actualExecution?.actualProviderId === openaiProviderId,
      fallbackAttemptCount: attempts.length,
      brokenPrimaryRejectedBeforeGeneration: true,
      fallbackAttemptReasons: attempts.map((attempt) => ({
        providerKind: attempt.providerKind,
        reason: attempt.reason,
        status: attempt.status,
        code: attempt.code,
      })),
      totalCostUsd: run.actualExecution?.totalCostUsd ?? null,
    };
  }, 240_000);

  it("records spend and reports near-limit and over-limit budget labels", async () => {
    const usage = await getUsageSummary(env);
    expect(usage.totals.callCount).toBeGreaterThanOrEqual(2);
    expect(usage.totals.inputTokens + usage.totals.outputTokens).toBeGreaterThan(0);
    expect(usage.totals.costUsd).toBeGreaterThan(0);
    expect(usage.totals.costUsd).toBeLessThan(50);

    const nearLimit = await setBudget(env, usage.totals.costUsd / 0.9);
    expect(nearLimit.state).toBe("near_limit");
    const overLimit = await setBudget(env, usage.totals.costUsd / 2);
    expect(overLimit.state).toBe("over_limit");

    report.providerProof.budgetLabels = {
      usageTotals: usage.totals,
      nearLimit: {
        state: nearLimit.state,
        spentUsd: nearLimit.spentUsd,
        remainingUsd: nearLimit.remainingUsd,
        monthlyLimitUsd: nearLimit.config?.monthlyLimitUsd ?? null,
      },
      overLimit: {
        state: overLimit.state,
        spentUsd: overLimit.spentUsd,
        remainingUsd: overLimit.remainingUsd,
        monthlyLimitUsd: overLimit.config?.monthlyLimitUsd ?? null,
      },
    };
  }, 60_000);

  it("keeps invalid and disabled provider lanes unavailable", async () => {
    const invalidProvider = await getProvider(env, brokenDeepseekProviderId);
    const invalidCapabilities = invalidProvider.config?.runtimeCapabilities ?? [];
    const invalidVerifiedText = invalidCapabilities.some((capability) =>
      capability.capability === "text"
      && (capability.status === "verified" || capability.verified === true)
    );
    expect(invalidVerifiedText).toBe(false);

    const invalidHealth = await getCapabilityHealthForProvider(env, brokenDeepseekProviderId);
    expect(invalidHealth.enabled).toBe(true);
    expect(invalidHealth.capabilities.some((capability) =>
      capability.capability === "text" && capability.state === "available"
    )).toBe(false);

    const disabledHealth = await getCapabilityHealthForProvider(env, disabledOpenaiProviderId);
    expect(disabledHealth.enabled).toBe(false);
    expect(disabledHealth.capabilities.some((capability) =>
      capability.capability === "text" && capability.state === "available"
    )).toBe(false);
    expect(disabledHealth.capabilities.some((capability) =>
      capability.capability === "text" && capability.state === "disabled"
    )).toBe(true);

    report.providerProof.invalidPrimaryDidNotBecomeAvailable = {
      providerKind: "deepseek",
      textCapabilityVerified: invalidVerifiedText,
      runtimeCapabilityCount: invalidCapabilities.length,
      validationStatus: invalidProvider.config?.validation?.status ?? null,
      validationErrorCode: invalidProvider.config?.validation?.errorCode ?? null,
      capabilityHealthEnabled: invalidHealth.enabled,
      textCapabilityStates: invalidHealth.capabilities
        .filter((capability) => capability.capability === "text")
        .map((capability) => capability.state),
    };
    report.providerProof.disabledProviderDidNotBecomeAvailable = {
      providerKind: "openai",
      enabled: disabledHealth.enabled,
      textCapabilityStates: disabledHealth.capabilities
        .filter((capability) => capability.capability === "text")
        .map((capability) => capability.state),
    };
  }, 60_000);
});
