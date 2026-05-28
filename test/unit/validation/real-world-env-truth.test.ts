import { describe, expect, it } from "vitest";

import {
  PHASE24_CHANNEL_ENV_REQUIREMENTS,
  chooseFallbackLane,
  collectEnvironmentTruth,
  resolveFallbackLaneRequirement,
  resolveScenarioLanes,
} from "../../../validation/real-world/lib/env-truth.mjs";

const NOW = "2026-04-19T00:00:00.000Z";

function makeProvider(overrides = {}) {
  return {
    id: "provider-1",
    kind: "anthropic",
    name: "Provider 1",
    enabled: true,
    defaultModel: "model-1",
    config: {
      backendKind: "http",
      authMode: "api-key",
      supportedModels: ["model-1"],
      validation: { status: "ok" },
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createClient() {
  return {
    authMode: "local",
    authSource: "test",
    authDetails: null,
    user: { id: "test-user" },
    async initialize() {
      return {
        authMode: "local",
        authSource: "test",
        authDetails: null,
        user: { id: "test-user" },
      };
    },
    async request(_method: string, routePath: string) {
      if (routePath === "/v1/health") {
        return { ok: true, status: 200, json: { ok: true, data: { status: "ok" } }, durationMs: 1 };
      }
      if (routePath === "/v1/version") {
        return { ok: true, status: 200, json: { ok: true, data: { version: "test" } }, durationMs: 1 };
      }
      if (routePath === "/v1/auth/bootstrap/status") {
        return { ok: true, status: 200, json: { ok: true, data: { bootstrapRequired: false } }, durationMs: 1 };
      }
      if (routePath === "/v1/setup/status") {
        return { ok: true, status: 200, json: { ok: true, data: { needsSetup: false } }, durationMs: 1 };
      }
      if (routePath === "/v1/providers") {
        return { ok: true, status: 200, json: { ok: true, data: { items: [] } }, durationMs: 1 };
      }
      if (routePath === "/v1/providers/health") {
        return { ok: true, status: 200, json: { ok: true, data: { items: [] } }, durationMs: 1 };
      }
      if (routePath === "/v1/model-routing") {
        return { ok: true, status: 200, json: { ok: true, data: { routing: {} } }, durationMs: 1 };
      }
      if (routePath === "/v1/uix/persona") {
        return { ok: true, status: 200, json: { ok: true, data: {} }, durationMs: 1 };
      }
      if (routePath === "/v1/uix/user-profile") {
        return {
          ok: true,
          status: 200,
          json: {
            ok: true,
            data: {
              profileType: "owner",
              onboardedAt: "2026-05-21T00:00:00.000Z",
            },
          },
          durationMs: 1,
        };
      }
      throw new Error(`unexpected route ${routePath}`);
    },
  };
}

function allPhase24Env(valuePrefix: string) {
  return Object.fromEntries(
    Object.values(PHASE24_CHANNEL_ENV_REQUIREMENTS)
      .flat()
      .map((envName, index) => [envName, `${valuePrefix}-${String(index)}`]),
  );
}

describe("real-world env truth fallback requirements", () => {
  it("does NOT require a fallback lane when only one eligible provider exists", () => {
    // A one-provider deployment truthfully has no fallback. Requiring one (the
    // old default_lane_requires_fallback behavior) would force re-introducing a
    // second provider such as OpenAI just to satisfy the gate. This run proves
    // the single-provider DEFAULT lane only — not fallback resilience.
    const providers = [
      makeProvider({ id: "default-provider", name: "Default Provider" }),
      makeProvider({
        id: "oauth-provider",
        name: "OAuth Provider",
        config: {
          backendKind: "http",
          authMode: "oauth",
          supportedModels: ["model-1"],
          validation: { status: "never" },
        },
      }),
    ];
    const providerHealthById = new Map([
      ["default-provider", { providerId: "default-provider", routingEligible: true, validationStatus: "ok" }],
      ["oauth-provider", { providerId: "oauth-provider", routingEligible: false, validationStatus: "never" }],
    ]);

    const result = resolveFallbackLaneRequirement(
      providers,
      { defaultProviderId: "default-provider", fallbackProviderIds: [] },
      { providerId: "default-provider", providerKind: "anthropic", backendKind: "http" },
      providerHealthById,
    );

    expect(result).toEqual({
      fallbackRequired: false,
      source: "single_provider_no_fallback_required",
    });
  });

  it("requires a fallback lane when a validated alternative exists", () => {
    const providers = [
      makeProvider({ id: "default-provider", name: "Default Provider" }),
      makeProvider({
        id: "validated-openai",
        kind: "openai",
        name: "Validated OpenAI",
        config: {
          backendKind: "http",
          authMode: "api-key",
          supportedModels: ["gpt-4.1"],
          validation: { status: "ok" },
        },
      }),
    ];
    const providerHealthById = new Map([
      ["default-provider", { providerId: "default-provider", routingEligible: true, validationStatus: "ok" }],
      ["validated-openai", { providerId: "validated-openai", routingEligible: true, validationStatus: "ok" }],
    ]);

    const result = resolveFallbackLaneRequirement(
      providers,
      { defaultProviderId: "default-provider", fallbackProviderIds: [] },
      { providerId: "default-provider", providerKind: "anthropic", backendKind: "http" },
      providerHealthById,
    );

    expect(result).toEqual({
      fallbackRequired: true,
      source: "validated_alternative_available",
    });
  });

  it("never synthesizes an OpenAI fallback when OpenAI is not a registered provider", () => {
    // Only DeepSeek + Anthropic exist (no OpenAI). The chosen fallback must be a
    // real registered non-default provider — never a fabricated OpenAI lane.
    const providers = [
      makeProvider({ id: "deepseek-default", kind: "deepseek", name: "DeepSeek" }),
      makeProvider({ id: "anthropic-alt", kind: "anthropic", name: "Anthropic Alt" }),
    ];
    const providerHealthById = new Map([
      ["deepseek-default", { providerId: "deepseek-default", routingEligible: true, validationStatus: "ok" }],
      ["anthropic-alt", { providerId: "anthropic-alt", routingEligible: true, validationStatus: "ok" }],
    ]);

    const fallback = chooseFallbackLane(
      providers,
      { defaultProviderId: "deepseek-default", fallbackProviderIds: [] },
      { providerId: "deepseek-default", providerKind: "deepseek", backendKind: "http" },
      providerHealthById,
    );

    expect(fallback).not.toBeNull();
    expect(fallback?.providerKind).not.toBe("openai");
    expect(fallback?.providerKind).toBe("anthropic");
  });

  it("returns no fallback lane (never an OpenAI guess) when only one provider exists", () => {
    const providers = [
      makeProvider({ id: "deepseek-only", kind: "deepseek", name: "DeepSeek" }),
    ];
    const providerHealthById = new Map([
      ["deepseek-only", { providerId: "deepseek-only", routingEligible: true, validationStatus: "ok" }],
    ]);

    const fallback = chooseFallbackLane(
      providers,
      { defaultProviderId: "deepseek-only", fallbackProviderIds: [] },
      { providerId: "deepseek-only", providerKind: "deepseek", backendKind: "http" },
      providerHealthById,
    );

    expect(fallback).toBeNull();
  });
});

describe("resolveScenarioLanes", () => {
  it("skips the synthetic fallback-missing lane when fallback proof is not required", () => {
    const scenario = {
      providerLane: "default_and_fallback",
    };
    const envTruth = {
      providerLanes: {
        default: { id: "default-lane", laneKey: "default", source: "routing.default" },
        fallback: null,
      },
      providerLaneRequirements: {
        fallbackRequired: false,
      },
    };

    const lanes = resolveScenarioLanes(scenario, envTruth);

    expect(lanes).toEqual([
      { id: "default-lane", laneKey: "default", source: "routing.default" },
    ]);
  });
});

describe("real-world Phase24 environment truth", () => {
  it("records redacted Phase24 channel/provider env readiness when every name is present", async () => {
    const envTruth = await collectEnvironmentTruth({
      client: createClient(),
      baseUrl: "http://127.0.0.1:3141",
      uiBaseUrl: "http://127.0.0.1:3141",
      processEnv: allPhase24Env("sensitive-ready-value"),
    });

    const phase24 = envTruth.prerequisites.phase24Channels;

    expect(phase24.status).toBe("ready");
    expect(phase24.valuesRedacted).toBe(true);
    expect(phase24.requiredEnvByGroup).toMatchObject({
      discord: [...PHASE24_CHANNEL_ENV_REQUIREMENTS.discord],
      telegram: [...PHASE24_CHANNEL_ENV_REQUIREMENTS.telegram],
      lark: [...PHASE24_CHANNEL_ENV_REQUIREMENTS.lark],
      providers: [...PHASE24_CHANNEL_ENV_REQUIREMENTS.providers],
    });
    expect(phase24.missingEnv).toEqual([]);
    expect(JSON.stringify(phase24)).not.toContain("sensitive-ready-value");
  });

  it("lists missing Phase24 env names without exposing present values", async () => {
    const processEnv = allPhase24Env("sensitive-partial-value");
    delete processEnv.FRIDAY_LARK_GROUP_CHAT_ID;
    delete processEnv.FRIDAY_TELEGRAM_BOT_TOKEN;

    const envTruth = await collectEnvironmentTruth({
      client: createClient(),
      baseUrl: "http://127.0.0.1:3141",
      uiBaseUrl: "http://127.0.0.1:3141",
      processEnv,
    });

    const phase24 = envTruth.prerequisites.phase24Channels;

    expect(phase24.status).toBe("missing");
    expect(phase24.missingEnv).toEqual([
      "FRIDAY_TELEGRAM_BOT_TOKEN",
      "FRIDAY_LARK_GROUP_CHAT_ID",
    ]);
    expect(phase24.missingEnvByGroup.telegram).toEqual(["FRIDAY_TELEGRAM_BOT_TOKEN"]);
    expect(phase24.missingEnvByGroup.lark).toEqual(["FRIDAY_LARK_GROUP_CHAT_ID"]);
    expect(JSON.stringify(phase24)).not.toContain("sensitive-partial-value");
  });
});
