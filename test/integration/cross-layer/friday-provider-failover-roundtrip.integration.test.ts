import { describe, expect, it } from "vitest";
import { createFridayProviderFallback } from "../../../src/providers/routing/friday-provider-fallback.js";
import type {
  FridayModelRoutingConfig,
  FridayProviderProfile,
  FridayProviderConfigJson,
} from "../../../src/providers/model/friday-provider.types.js";

function createMockProvider(
  id: string,
  kind: "openai" | "anthropic",
  models: string[],
): FridayProviderProfile {
  return {
    id,
    kind,
    name: `${kind} provider ${id}`,
    baseUrl: `https://api.${kind}.com/v1`,
    enabled: true,
    defaultModel: models[0],
    config: {
      api: kind === "openai" ? "openai-completions" : "anthropic-messages",
      authMode: "api-key",
      keySource: { kind: "env-ref", envVar: `${kind.toUpperCase()}_API_KEY` },
      supportedModels: models,
    } satisfies FridayProviderConfigJson,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("friday provider failover roundtrip", () => {
  it("resolves candidates in order: default first, then fallbacks", () => {
    const fallback = createFridayProviderFallback();
    const providers = [
      createMockProvider("p1", "openai", ["gpt-4o"]),
      createMockProvider("p2", "anthropic", ["claude-sonnet-4-20250514"]),
      createMockProvider("p3", "openai", ["gpt-4o-mini"]),
    ];

    const routing: FridayModelRoutingConfig = {
      defaultProviderId: "p1",
      fallbackProviderIds: ["p2", "p3"],
    };

    const candidates = fallback.resolveCandidates({ routing, providers });

    expect(candidates).toHaveLength(3);
    expect(candidates[0]!.provider.id).toBe("p1");
    expect(candidates[1]!.provider.id).toBe("p2");
    expect(candidates[2]!.provider.id).toBe("p3");
  });

  it("deduplicates providers in the fallback chain", () => {
    const fallback = createFridayProviderFallback();
    const providers = [
      createMockProvider("p1", "openai", ["gpt-4o"]),
      createMockProvider("p2", "anthropic", ["claude-sonnet-4-20250514"]),
    ];

    const routing: FridayModelRoutingConfig = {
      defaultProviderId: "p1",
      fallbackProviderIds: ["p1", "p2", "p1"],
    };

    const candidates = fallback.resolveCandidates({ routing, providers });

    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.provider.id).toBe("p1");
    expect(candidates[1]!.provider.id).toBe("p2");
  });

  it("runWithFallback returns first success and tracks attempts", async () => {
    const fallback = createFridayProviderFallback();
    const providers = [
      createMockProvider("fail-1", "openai", ["gpt-4o"]),
      createMockProvider("success-1", "anthropic", ["claude-sonnet-4-20250514"]),
    ];

    const routing: FridayModelRoutingConfig = {
      defaultProviderId: "fail-1",
      fallbackProviderIds: ["success-1"],
    };

    const candidates = fallback.resolveCandidates({ routing, providers });

    const result = await fallback.runWithFallback({
      candidates,
      run: async (route) => {
        if (route.provider.id === "fail-1") {
          throw new Error("429 rate_limit_exceeded");
        }
        return `response from ${route.provider.id}`;
      },
    });

    expect(result.result).toBe("response from success-1");
    expect(result.route.provider.id).toBe("success-1");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.providerId).toBe("fail-1");
  });

  it("puts failed provider in cooldown after transient error", async () => {
    let clockMs = 1000;
    const fallback = createFridayProviderFallback({
      nowMs: () => clockMs,
      cooldownMs: 120_000,
    });

    const providers = [
      createMockProvider("p1", "openai", ["gpt-4o"]),
      createMockProvider("p2", "anthropic", ["claude-sonnet-4-20250514"]),
    ];

    const routing: FridayModelRoutingConfig = {
      defaultProviderId: "p1",
      fallbackProviderIds: ["p2"],
    };

    const candidates = fallback.resolveCandidates({ routing, providers });

    await fallback.runWithFallback({
      candidates,
      run: async (route) => {
        if (route.provider.id === "p1") {
          throw new Error("429 rate_limit");
        }
        return "ok";
      },
    });

    expect(fallback.isInCooldown("p1")).toBe(true);
    expect(fallback.isInCooldown("p2")).toBe(false);

    // Advance past cooldown
    clockMs += 130_000;
    expect(fallback.isInCooldown("p1")).toBe(false);
  });

  it("skips disabled providers", () => {
    const fallback = createFridayProviderFallback();
    const disabledProvider = createMockProvider("disabled-p", "openai", ["gpt-4o"]);
    disabledProvider.enabled = false;

    const providers = [
      disabledProvider,
      createMockProvider("active-p", "anthropic", ["claude-sonnet-4-20250514"]),
    ];

    const routing: FridayModelRoutingConfig = {
      defaultProviderId: "disabled-p",
      fallbackProviderIds: ["active-p"],
    };

    const candidates = fallback.resolveCandidates({ routing, providers });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.provider.id).toBe("active-p");
  });
});
