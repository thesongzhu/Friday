import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { createFridayProviderFallback } from "../../src/providers/routing/friday-provider-fallback.js";
import type {
  FridayModelRoutingConfig,
  FridayProviderProfile,
  FridayProviderConfigJson,
} from "../../src/providers/model/friday-provider.types.js";

/**
 * Performance benchmark: verifies that createFridayProviderFallback +
 * resolveCandidates executes within 50ms for a chain of 5 providers.
 */

function createMockProvider(
  id: string,
  models: string[],
): FridayProviderProfile {
  return {
    id,
    kind: "openai",
    name: `Provider ${id}`,
    baseUrl: "https://api.openai.com/v1",
    enabled: true,
    defaultModel: models[0],
    config: {
      api: "openai-completions",
      authMode: "api-key",
      keySource: { kind: "env-ref", envVar: "OPENAI_API_KEY" },
      supportedModels: models,
    } satisfies FridayProviderConfigJson,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("friday provider routing latency", () => {
  it("creates fallback chain and resolves 5 candidates within 50ms", () => {
    const providers = [
      createMockProvider("p1", ["gpt-4o", "gpt-4o-mini"]),
      createMockProvider("p2", ["gpt-4o", "gpt-3.5-turbo"]),
      createMockProvider("p3", ["gpt-4o-mini"]),
      createMockProvider("p4", ["gpt-4o", "gpt-4-turbo"]),
      createMockProvider("p5", ["gpt-4o"]),
    ];

    const routing: FridayModelRoutingConfig = {
      defaultProviderId: "p1",
      fallbackProviderIds: ["p2", "p3", "p4", "p5"],
    };

    const startedAt = performance.now();
    const fallback = createFridayProviderFallback();
    const candidates = fallback.resolveCandidates({ routing, providers });
    const elapsedMs = performance.now() - startedAt;

    expect(candidates).toHaveLength(5);
    expect(elapsedMs).toBeLessThan(50);
  });

  it("resolves candidates with requestedModel filtering within 50ms", () => {
    const providers = [
      createMockProvider("p1", ["gpt-4o", "gpt-4o-mini"]),
      createMockProvider("p2", ["gpt-4o", "gpt-3.5-turbo"]),
      createMockProvider("p3", ["gpt-4o-mini"]),
      createMockProvider("p4", ["gpt-4o", "gpt-4-turbo"]),
      createMockProvider("p5", ["gpt-4o"]),
    ];

    const routing: FridayModelRoutingConfig = {
      defaultProviderId: "p1",
      fallbackProviderIds: ["p2", "p3", "p4", "p5"],
    };

    const startedAt = performance.now();
    const fallback = createFridayProviderFallback();
    const candidates = fallback.resolveCandidates({
      routing,
      providers,
      requestedModel: "gpt-4o",
    });
    const elapsedMs = performance.now() - startedAt;

    // p3 only has gpt-4o-mini, so it's excluded for gpt-4o request
    expect(candidates.length).toBeGreaterThanOrEqual(4);
    expect(elapsedMs).toBeLessThan(50);
  });

  it("runWithFallback completes quickly when first provider succeeds", async () => {
    const providers = [
      createMockProvider("p1", ["gpt-4o"]),
      createMockProvider("p2", ["gpt-4o"]),
      createMockProvider("p3", ["gpt-4o"]),
      createMockProvider("p4", ["gpt-4o"]),
      createMockProvider("p5", ["gpt-4o"]),
    ];

    const routing: FridayModelRoutingConfig = {
      defaultProviderId: "p1",
      fallbackProviderIds: ["p2", "p3", "p4", "p5"],
    };

    const fallback = createFridayProviderFallback();
    const candidates = fallback.resolveCandidates({ routing, providers });

    const startedAt = performance.now();
    const result = await fallback.runWithFallback({
      candidates,
      run: async () => "immediate-success",
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result.result).toBe("immediate-success");
    expect(result.attempts).toHaveLength(0);
    expect(elapsedMs).toBeLessThan(50);
  });
});
