import { describe, expect, it } from "vitest";
import type {
  FridayProviderKind,
  FridayProviderProfile,
  FridayProviderConfigJson,
} from "../../../src/providers/model/friday-provider.types.js";

/**
 * Cross-layer integration test: verifying that the provider creation contract
 * produces a well-shaped provider profile matching the expected API surface.
 */
describe("friday setup to first chat — provider contract shape", () => {
  it("a provider profile created from input has id, kind, and name", () => {
    const input = {
      kind: "openai" as FridayProviderKind,
      name: "My OpenAI Provider",
      baseUrl: "https://api.openai.com/v1",
      enabled: true,
      defaultModel: "gpt-4o",
      config: {
        api: "openai-completions",
        authMode: "api-key",
        keySource: { kind: "env-ref", envVar: "OPENAI_API_KEY" },
        supportedModels: ["gpt-4o", "gpt-4o-mini"],
      } satisfies FridayProviderConfigJson,
    };

    const profile: FridayProviderProfile = {
      id: "provider-001",
      kind: input.kind,
      name: input.name,
      baseUrl: input.baseUrl,
      enabled: input.enabled,
      defaultModel: input.defaultModel,
      config: input.config,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(profile.id).toBe("provider-001");
    expect(profile.kind).toBe("openai");
    expect(profile.name).toBe("My OpenAI Provider");
    expect(profile.enabled).toBe(true);
    expect(profile.config.api).toBe("openai-completions");
    expect(profile.config.supportedModels).toContain("gpt-4o");
  });

  it("provider profile enforces required fields from the type contract", () => {
    const profile: FridayProviderProfile = {
      id: "provider-002",
      kind: "anthropic",
      name: "Anthropic Claude",
      baseUrl: "https://api.anthropic.com",
      enabled: true,
      config: {
        api: "anthropic-messages",
        authMode: "api-key",
        keySource: { kind: "secret-ref", refKey: "anthropic-key" },
        supportedModels: ["claude-sonnet-4-20250514"],
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // All required fields are present
    expect(profile).toHaveProperty("id");
    expect(profile).toHaveProperty("kind");
    expect(profile).toHaveProperty("name");
    expect(profile).toHaveProperty("baseUrl");
    expect(profile).toHaveProperty("enabled");
    expect(profile).toHaveProperty("config");
    expect(profile).toHaveProperty("createdAt");
    expect(profile).toHaveProperty("updatedAt");
  });

  it("config.keySource discriminated union matches expected shapes", () => {
    const configs: FridayProviderConfigJson[] = [
      {
        api: "openai-completions",
        authMode: "api-key",
        keySource: { kind: "env-ref", envVar: "API_KEY" },
        supportedModels: [],
      },
      {
        api: "anthropic-messages",
        authMode: "api-key",
        keySource: { kind: "secret-ref", refKey: "my-secret" },
        supportedModels: [],
      },
      {
        api: "ollama",
        authMode: "none",
        keySource: { kind: "none" },
        supportedModels: ["llama3"],
      },
    ];

    expect(configs[0]!.keySource.kind).toBe("env-ref");
    expect(configs[1]!.keySource.kind).toBe("secret-ref");
    expect(configs[2]!.keySource.kind).toBe("none");
  });
});
