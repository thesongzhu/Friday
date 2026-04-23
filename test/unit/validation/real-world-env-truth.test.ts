import { describe, expect, it } from "vitest";

import {
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

describe("real-world env truth fallback requirements", () => {
  it("requires a fallback lane whenever a default lane exists", () => {
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
      fallbackRequired: true,
      source: "default_lane_requires_fallback",
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
