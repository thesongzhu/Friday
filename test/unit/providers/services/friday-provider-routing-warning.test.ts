import { describe, expect, it } from "vitest";

import { resolveFridayRoutingStabilityWarning } from "#providers";
import type { FridayModelRoutingConfig, FridayProviderProfile } from "#providers";

const NOW = "2026-03-16T18:00:00.000Z";

function makeProvider(overrides: Partial<FridayProviderProfile>): FridayProviderProfile {
  return {
    id: overrides.id ?? "provider-1",
    kind: overrides.kind ?? "anthropic",
    name: overrides.name ?? "Provider 1",
    baseUrl: overrides.baseUrl ?? "https://example.com",
    enabled: overrides.enabled ?? true,
    defaultModel: overrides.defaultModel ?? "model-1",
    config: overrides.config ?? {
      api: "anthropic-messages",
      authMode: "api-key",
      keySource: { kind: "env-ref", envVar: "TEST_API_KEY" },
      supportedModels: ["model-1"],
      validation: { status: "ok" },
    },
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

describe("resolveFridayRoutingStabilityWarning", () => {
  it("returns a warning when the default provider has no fallback and another validated provider exists", () => {
    const routing: FridayModelRoutingConfig = {
      defaultProviderId: "anthropic-default",
      fallbackProviderIds: [],
    };

    const warning = resolveFridayRoutingStabilityWarning({
      routing,
      providers: [
        makeProvider({
          id: "anthropic-default",
          name: "Anthropic",
        }),
        makeProvider({
          id: "openai-fallback",
          kind: "openai",
          name: "OpenAI ChatGPT",
          config: {
            api: "openai-responses",
            authMode: "api-key",
            keySource: { kind: "env-ref", envVar: "OPENAI_API_KEY" },
            supportedModels: ["gpt-4.1"],
            validation: { status: "ok" },
          },
        }),
      ],
    });

    expect(warning).toContain('Default provider "anthropic-default" has no fallback providers configured.');
    expect(warning).toContain("OpenAI ChatGPT (openai-fallback)");
  });

  it("returns null when a fallback is already configured", () => {
    const warning = resolveFridayRoutingStabilityWarning({
      routing: {
        defaultProviderId: "anthropic-default",
        fallbackProviderIds: ["openai-fallback"],
      },
      providers: [
        makeProvider({ id: "anthropic-default", name: "Anthropic" }),
        makeProvider({ id: "openai-fallback", kind: "openai", name: "OpenAI ChatGPT" }),
      ],
    });

    expect(warning).toBeNull();
  });
});
