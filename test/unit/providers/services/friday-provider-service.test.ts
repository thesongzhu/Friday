import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayProviderService } from "#providers";
import { resetMasterKeyCache } from "#providers";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";

import type { FridayProviderService } from "#providers";

describe("FridayProviderService", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;
  let service: FridayProviderService;
  const NOW = "2026-02-17T10:00:00.000Z";
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
    resetMasterKeyCache();
    service = createFridayProviderService({
      db,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
    // Mock fetch for validation calls
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })),
    ) as typeof fetch;
  });

  afterEach(() => {
    db.close();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    resetMasterKeyCache();
  });

  describe("createProvider", () => {
    it("creates a provider with env-ref key", async () => {
      const profile = await service.createProvider({
        kind: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "$OPENAI_API_KEY",
        supportedModels: ["gpt-4o"],
        defaultModel: "gpt-4o",
        validateOnSave: false,
      });

      expect(profile.id).toBe("test-id-0001");
      expect(profile.kind).toBe("openai");
      expect(profile.name).toBe("OpenAI");
      expect(profile.config.keySource).toEqual({
        kind: "env-ref",
        envVar: "OPENAI_API_KEY",
      });
    });

    it("creates a provider with raw key (encrypted)", async () => {
      const profile = await service.createProvider({
        kind: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "sk-real-key-123",
        supportedModels: ["gpt-4o"],
        validateOnSave: false,
      });

      expect(profile.config.keySource.kind).toBe("secret-ref");
    });

    it("creates a provider with no key (ollama)", async () => {
      const profile = await service.createProvider({
        kind: "ollama",
        name: "Ollama Local",
        baseUrl: "http://localhost:11434",
        authMode: "none",
        api: "ollama",
        supportedModels: ["llama3"],
        validateOnSave: false,
      });

      expect(profile.config.keySource).toEqual({ kind: "none" });
    });

    it("validates on save by default", async () => {
      process.env.OPENAI_API_KEY = "sk-test";
      try {
        const profile = await service.createProvider({
          kind: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com",
          authMode: "api-key",
          api: "openai-completions",
          apiKey: "$OPENAI_API_KEY",
          supportedModels: ["gpt-4o"],
        });

        expect(profile.config.validation?.status).toBe("ok");
      } finally {
        delete process.env.OPENAI_API_KEY;
      }
    });

    it("rejects unsupported auth mode for kind", async () => {
      await expect(
        service.createProvider({
          kind: "openai",
          name: "OpenAI OAuth",
          baseUrl: "https://api.openai.com",
          authMode: "oauth",
          api: "openai-responses",
          supportedModels: ["gpt-4o"],
          validateOnSave: false,
        }),
      ).rejects.toThrow("does not support authMode");
    });

    it("rejects unsupported api for kind", async () => {
      await expect(
        service.createProvider({
          kind: "anthropic",
          name: "Anthropic with wrong api",
          baseUrl: "https://api.anthropic.com",
          authMode: "api-key",
          api: "openai-responses",
          supportedModels: ["claude-sonnet-4"],
          validateOnSave: false,
        }),
      ).rejects.toThrow("does not support api");
    });
  });

  describe("listProviders", () => {
    it("returns empty list initially", async () => {
      const list = await service.listProviders();
      expect(list).toHaveLength(0);
    });

    it("returns created providers", async () => {
      await service.createProvider({
        kind: "openai",
        name: "P1",
        baseUrl: "https://p1.com",
        authMode: "api-key",
        api: "openai-completions",
        supportedModels: ["m1"],
        validateOnSave: false,
      });
      await service.createProvider({
        kind: "anthropic",
        name: "P2",
        baseUrl: "https://p2.com",
        authMode: "api-key",
        api: "anthropic-messages",
        supportedModels: ["m2"],
        validateOnSave: false,
      });

      const list = await service.listProviders();
      expect(list).toHaveLength(2);
    });
  });

  describe("getProvider", () => {
    it("returns null for non-existent", async () => {
      const result = await service.getProvider("non-existent");
      expect(result).toBeNull();
    });

    it("returns existing provider", async () => {
      await service.createProvider({
        kind: "openai",
        name: "Test",
        baseUrl: "https://test.com",
        authMode: "api-key",
        api: "openai-completions",
        supportedModels: ["m1"],
        validateOnSave: false,
      });

      const result = await service.getProvider("test-id-0001");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("Test");
    });
  });

  describe("updateProvider", () => {
    it("updates provider name", async () => {
      await service.createProvider({
        kind: "openai",
        name: "Original",
        baseUrl: "https://test.com",
        authMode: "api-key",
        api: "openai-completions",
        supportedModels: ["m1"],
        validateOnSave: false,
      });

      const updated = await service.updateProvider("test-id-0001", {
        name: "Updated",
        validateOnSave: false,
      });

      expect(updated.name).toBe("Updated");
    });

    it("throws on non-existent provider", async () => {
      await expect(
        service.updateProvider("non-existent", { name: "X" }),
      ).rejects.toThrow("Provider not found");
    });

    it("updates apiKey from env-ref to raw", async () => {
      await service.createProvider({
        kind: "openai",
        name: "Test",
        baseUrl: "https://test.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "$OPENAI_API_KEY",
        supportedModels: ["m1"],
        validateOnSave: false,
      });

      const updated = await service.updateProvider("test-id-0001", {
        apiKey: "sk-new-key",
        validateOnSave: false,
      });

      expect(updated.config.keySource.kind).toBe("secret-ref");
    });

    it("rejects unsupported auth mode change", async () => {
      await service.createProvider({
        kind: "openai",
        name: "Test",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-responses",
        supportedModels: ["gpt-4o"],
        validateOnSave: false,
      });

      await expect(
        service.updateProvider("test-id-0001", {
          authMode: "oauth",
          validateOnSave: false,
        }),
      ).rejects.toThrow("does not support authMode");
    });
  });

  describe("deleteProvider", () => {
    it("deletes existing provider", async () => {
      await service.createProvider({
        kind: "openai",
        name: "To Delete",
        baseUrl: "https://test.com",
        authMode: "api-key",
        api: "openai-completions",
        supportedModels: ["m1"],
        validateOnSave: false,
      });

      await service.deleteProvider("test-id-0001");

      const result = await service.getProvider("test-id-0001");
      expect(result).toBeNull();
    });

    it("throws on non-existent provider", async () => {
      await expect(service.deleteProvider("non-existent")).rejects.toThrow(
        "Provider not found",
      );
    });

    it("cleans up routing config on delete", async () => {
      await service.createProvider({
        kind: "openai",
        name: "P1",
        baseUrl: "https://test.com",
        authMode: "api-key",
        api: "openai-completions",
        supportedModels: ["m1"],
        validateOnSave: false,
      });

      await service.setRoutingConfig({
        defaultProviderId: "test-id-0001",
        fallbackProviderIds: ["test-id-0001"],
      });

      await service.deleteProvider("test-id-0001");

      const routing = await service.getRoutingConfig();
      expect(routing.defaultProviderId).toBe("");
      expect(routing.fallbackProviderIds).toEqual([]);
    });
  });

  describe("routing config", () => {
    it("returns default empty config when not set", async () => {
      const config = await service.getRoutingConfig();
      expect(config.defaultProviderId).toBe("");
      expect(config.fallbackProviderIds).toEqual([]);
    });

    it("set and get roundtrip", async () => {
      await service.createProvider({
        kind: "openai",
        name: "P1",
        baseUrl: "https://p1.test",
        authMode: "api-key",
        api: "openai-completions",
        supportedModels: ["gpt-4o"],
        defaultModel: "gpt-4o",
        validateOnSave: false,
      });
      await service.createProvider({
        kind: "openai",
        name: "P2",
        baseUrl: "https://p2.test",
        authMode: "api-key",
        api: "openai-completions",
        supportedModels: ["gpt-4.1"],
        defaultModel: "gpt-4.1",
        validateOnSave: false,
      });
      await service.createProvider({
        kind: "openai",
        name: "P3",
        baseUrl: "https://p3.test",
        authMode: "api-key",
        api: "openai-completions",
        supportedModels: ["gpt-4.1-mini"],
        defaultModel: "gpt-4.1-mini",
        validateOnSave: false,
      });

      const input = {
        defaultProviderId: "test-id-0001",
        defaultModel: "gpt-4o",
        fallbackProviderIds: ["test-id-0002", "test-id-0003"],
      };

      const result = await service.setRoutingConfig(input);
      expect(result).toEqual(input);

      const retrieved = await service.getRoutingConfig();
      expect(retrieved).toEqual(input);
    });

    it("overwrites existing config", async () => {
      await service.createProvider({
        kind: "openai",
        name: "P1",
        baseUrl: "https://p1.test",
        authMode: "api-key",
        api: "openai-completions",
        supportedModels: ["gpt-4o"],
        defaultModel: "gpt-4o",
        validateOnSave: false,
      });
      await service.createProvider({
        kind: "openai",
        name: "P2",
        baseUrl: "https://p2.test",
        authMode: "api-key",
        api: "openai-completions",
        supportedModels: ["gpt-4.1"],
        defaultModel: "gpt-4.1",
        validateOnSave: false,
      });
      await service.createProvider({
        kind: "anthropic",
        name: "P3",
        baseUrl: "https://api.anthropic.com",
        authMode: "api-key",
        api: "anthropic-messages",
        supportedModels: ["claude-3"],
        defaultModel: "claude-3",
        validateOnSave: false,
      });

      await service.setRoutingConfig({
        defaultProviderId: "test-id-0001",
        fallbackProviderIds: ["test-id-0002"],
      });

      await service.setRoutingConfig({
        defaultProviderId: "test-id-0003",
        defaultModel: "claude-3",
        fallbackProviderIds: [],
      });

      const config = await service.getRoutingConfig();
      expect(config.defaultProviderId).toBe("test-id-0003");
      expect(config.defaultModel).toBe("claude-3");
    });

    it("rejects an unknown defaultProviderId", async () => {
      await expect(
        service.setRoutingConfig({
          defaultProviderId: "claude",
          fallbackProviderIds: [],
        }),
      ).rejects.toThrow('defaultProviderId "claude" does not match an existing provider');
    });

    it("rejects a defaultModel not supported by the target provider", async () => {
      await service.createProvider({
        kind: "anthropic",
        name: "Claude OAuth",
        baseUrl: "https://api.anthropic.com",
        authMode: "oauth",
        api: "anthropic-messages",
        supportedModels: ["claude-sonnet-4-20250514"],
        defaultModel: "claude-sonnet-4-20250514",
        validateOnSave: false,
      });

      await expect(
        service.setRoutingConfig({
          defaultProviderId: "test-id-0001",
          defaultModel: "claude-opus-4-20250514",
          fallbackProviderIds: [],
        }),
      ).rejects.toThrow(
        'defaultModel "claude-opus-4-20250514" is not supported by provider "test-id-0001"',
      );
    });
  });

  describe("resolveRoute", () => {
    it("throws when no routing configured", async () => {
      await expect(service.resolveRoute()).rejects.toThrow(
        "No model routing configured",
      );
    });

    it("resolves the default provider", async () => {
      await service.createProvider({
        kind: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        supportedModels: ["gpt-4o"],
        defaultModel: "gpt-4o",
        validateOnSave: false,
      });

      await service.setRoutingConfig({
        defaultProviderId: "test-id-0001",
        fallbackProviderIds: [],
      });

      const route = await service.resolveRoute();
      expect(route.provider.id).toBe("test-id-0001");
      expect(route.model).toBe("gpt-4o");
    });

    it("uses requested model override", async () => {
      await service.createProvider({
        kind: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        supportedModels: ["gpt-4o", "gpt-4o-mini"],
        defaultModel: "gpt-4o",
        validateOnSave: false,
      });

      await service.setRoutingConfig({
        defaultProviderId: "test-id-0001",
        fallbackProviderIds: [],
      });

      const route = await service.resolveRoute("gpt-4o-mini");
      expect(route.model).toBe("gpt-4o-mini");
    });
  });

  describe("runWithFallback", () => {
    it("throws when no routing configured", async () => {
      await expect(
        service.runWithFallback({
          run: async () => "test",
        }),
      ).rejects.toThrow("No model routing configured");
    });

    it("runs with credential from env-ref", async () => {
      process.env.TEST_KEY = "sk-env-key";
      try {
        await service.createProvider({
          kind: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com",
          authMode: "api-key",
          api: "openai-completions",
          apiKey: "$TEST_KEY",
          supportedModels: ["gpt-4o"],
          defaultModel: "gpt-4o",
          validateOnSave: false,
        });

        await service.setRoutingConfig({
          defaultProviderId: "test-id-0001",
          fallbackProviderIds: [],
        });

        const { result, route, attempts } = await service.runWithFallback({
          run: async (_r, credential) => credential,
        });

        expect(result).toBe("sk-env-key");
        expect(route.provider.kind).toBe("openai");
        expect(attempts).toHaveLength(0);
      } finally {
        delete process.env.TEST_KEY;
      }
    });

    it("reports the broken routing reference when zero candidates are available", async () => {
      db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO hub_settings (key, value_json, revision, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?)`,
        ).run(
          "llm.routing.v1",
          JSON.stringify({
            defaultProviderId: "claude",
            fallbackProviderIds: [],
          }),
          NOW,
          NOW,
        );
      });

      await expect(
        service.runWithFallback({
          run: async () => "test",
        }),
      ).rejects.toThrow(
        'No enabled providers available for routing: defaultProviderId "claude" not found',
      );
    });
  });

  describe("OAuth provider lifecycle", () => {
    it("creates an OAuth provider with validation skipped", async () => {
      const profile = await service.createProvider({
        kind: "anthropic",
        name: "Anthropic OAuth",
        baseUrl: "https://api.anthropic.com",
        authMode: "oauth",
        api: "anthropic-messages",
        supportedModels: ["claude-sonnet-4-20250514"],
        defaultModel: "claude-sonnet-4-20250514",
      });

      expect(profile.config.authMode).toBe("oauth");
      expect(profile.config.oauthProvider).toBe("anthropic");
      expect(profile.config.keySource).toEqual({ kind: "none" });
      expect(profile.config.validation?.status).toBe("never");
      expect(profile.config.validation?.errorMessage).toBe("OAuth login required");
      // Validation fetch should NOT have been called for OAuth creation
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("preserves oauthProvider when updating an OAuth provider", async () => {
      await service.createProvider({
        kind: "anthropic",
        name: "Anthropic OAuth",
        baseUrl: "https://api.anthropic.com",
        authMode: "oauth",
        api: "anthropic-messages",
        supportedModels: ["claude-sonnet-4-20250514"],
      });

      const updated = await service.updateProvider("test-id-0001", {
        name: "Anthropic OAuth Updated",
        validateOnSave: false,
      });

      expect(updated.name).toBe("Anthropic OAuth Updated");
      expect(updated.config.authMode).toBe("oauth");
      expect(updated.config.oauthProvider).toBe("anthropic");
      expect(updated.config.keySource).toEqual({ kind: "none" });
    });

    it("clears OAuth when switching authMode from oauth to api-key", async () => {
      await service.createProvider({
        kind: "anthropic",
        name: "Anthropic OAuth",
        baseUrl: "https://api.anthropic.com",
        authMode: "oauth",
        api: "anthropic-messages",
        supportedModels: ["claude-sonnet-4-20250514"],
      });

      const updated = await service.updateProvider("test-id-0001", {
        authMode: "api-key",
        apiKey: "$ANTHROPIC_API_KEY",
        validateOnSave: false,
      });

      expect(updated.config.authMode).toBe("api-key");
      expect(updated.config.oauthProvider).toBeUndefined();
      expect(updated.config.keySource.kind).toBe("env-ref");
    });

    it("forces keySource to none when switching to oauth via update", async () => {
      await service.createProvider({
        kind: "anthropic",
        name: "Anthropic API Key",
        baseUrl: "https://api.anthropic.com",
        authMode: "api-key",
        api: "anthropic-messages",
        apiKey: "$ANTHROPIC_API_KEY",
        supportedModels: ["claude-sonnet-4-20250514"],
        validateOnSave: false,
      });

      const updated = await service.updateProvider("test-id-0001", {
        authMode: "oauth",
        validateOnSave: false,
      });

      expect(updated.config.authMode).toBe("oauth");
      expect(updated.config.oauthProvider).toBe("anthropic");
      expect(updated.config.keySource).toEqual({ kind: "none" });
      expect(updated.config.validation?.status).toBe("never");
    });

    it("deletes OAuth provider and clears credentials", async () => {
      await service.createProvider({
        kind: "anthropic",
        name: "Anthropic OAuth",
        baseUrl: "https://api.anthropic.com",
        authMode: "oauth",
        api: "anthropic-messages",
        supportedModels: ["claude-sonnet-4-20250514"],
      });

      await service.deleteProvider("test-id-0001");

      const result = await service.getProvider("test-id-0001");
      expect(result).toBeNull();
    });
  });
});
