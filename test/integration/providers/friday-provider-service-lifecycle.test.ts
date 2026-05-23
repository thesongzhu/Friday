import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayProviderService, resetMasterKeyCache } from "#providers";
import type { FridayProviderService } from "#providers";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";

const TEST_MASTER_KEY = "23".repeat(32);

async function withTestMasterKey<T>(fn: () => Promise<T>): Promise<T> {
  const previousMasterKey = process.env.FRIDAY_MASTER_KEY;
  const previousMasterKeySource = process.env.FRIDAY_MASTER_KEY_SOURCE;
  process.env.FRIDAY_MASTER_KEY = TEST_MASTER_KEY;
  delete process.env.FRIDAY_MASTER_KEY_SOURCE;
  resetMasterKeyCache();
  try {
    return await fn();
  } finally {
    if (previousMasterKey === undefined) {
      delete process.env.FRIDAY_MASTER_KEY;
    } else {
      process.env.FRIDAY_MASTER_KEY = previousMasterKey;
    }
    if (previousMasterKeySource === undefined) {
      delete process.env.FRIDAY_MASTER_KEY_SOURCE;
    } else {
      process.env.FRIDAY_MASTER_KEY_SOURCE = previousMasterKeySource;
    }
    resetMasterKeyCache();
  }
}

describe("FridayProviderService Lifecycle (Integration)", () => {
  let db: FridaySqliteLayer;
  let service: FridayProviderService;
  const NOW = "2026-02-18T10:00:00.000Z";
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    db = createTestDb();
    resetMasterKeyCache();
    service = createFridayProviderService({
      db,
      idGenerator: createTestIdGenerator(),
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

  // ─── Register provider key ───

  describe("create provider", () => {
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

      expect(profile.id).toBeTruthy();
      expect(profile.kind).toBe("openai");
      expect(profile.name).toBe("OpenAI");
      expect(profile.config.keySource).toEqual({
        kind: "env-ref",
        envVar: "OPENAI_API_KEY",
      });
    });

    it("creates a provider with raw key (encrypted secret)", async () => {
      const profile = await withTestMasterKey(() =>
        service.createProvider({
          kind: "openai",
          name: "OpenAI Raw",
          baseUrl: "https://api.openai.com",
          authMode: "api-key",
          api: "openai-completions",
          apiKey: "sk-real-key-123",
          supportedModels: ["gpt-4o"],
          validateOnSave: false,
        }),
      );

      expect(profile.config.keySource.kind).toBe("secret-ref");
    });

    it("creates a provider with no auth (ollama)", async () => {
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
  });

  // ─── List providers ───

  describe("list providers", () => {
    it("lists all registered providers", async () => {
      await service.createProvider({
        kind: "openai",
        name: "Provider A",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "$KEY_A",
        supportedModels: ["gpt-4o"],
        validateOnSave: false,
      });
      await service.createProvider({
        kind: "anthropic",
        name: "Provider B",
        baseUrl: "https://api.anthropic.com",
        authMode: "api-key",
        api: "anthropic-messages",
        apiKey: "$KEY_B",
        supportedModels: ["claude-3-opus"],
        validateOnSave: false,
      });

      const providers = await service.listProviders();
      expect(providers).toHaveLength(2);
    });

    it("returns empty array when no providers exist", async () => {
      const providers = await service.listProviders();
      expect(providers).toHaveLength(0);
    });
  });

  // ─── Get provider by ID ───

  describe("get provider by ID", () => {
    it("gets an existing provider", async () => {
      const created = await service.createProvider({
        kind: "openai",
        name: "Get Test",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "$OPENAI_KEY",
        supportedModels: ["gpt-4o"],
        validateOnSave: false,
      });

      const fetched = await service.getProvider(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.name).toBe("Get Test");
    });

    it("returns null for non-existent provider", async () => {
      const fetched = await service.getProvider("nonexistent-id");
      expect(fetched).toBeNull();
    });
  });

  // ─── Update provider ───

  describe("update provider", () => {
    it("updates provider name", async () => {
      const created = await service.createProvider({
        kind: "openai",
        name: "Original Name",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "$OPENAI_KEY",
        supportedModels: ["gpt-4o"],
        validateOnSave: false,
      });

      const updated = await service.updateProvider(created.id, {
        name: "Updated Name",
        validateOnSave: false,
      });

      expect(updated.name).toBe("Updated Name");
      expect(updated.id).toBe(created.id);
    });

    it("updates supported models", async () => {
      const created = await service.createProvider({
        kind: "openai",
        name: "Model Update",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "$OPENAI_KEY",
        supportedModels: ["gpt-4o"],
        validateOnSave: false,
      });

      const updated = await service.updateProvider(created.id, {
        supportedModels: ["gpt-4o", "gpt-4o-mini"],
        validateOnSave: false,
      });

      expect(updated.config.supportedModels).toEqual(["gpt-4o", "gpt-4o-mini"]);
    });
  });

  // ─── Delete provider ───

  describe("delete provider", () => {
    it("deletes an existing provider", async () => {
      const created = await service.createProvider({
        kind: "openai",
        name: "Delete Me",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "$OPENAI_KEY",
        supportedModels: ["gpt-4o"],
        validateOnSave: false,
      });

      await service.deleteProvider(created.id);

      const fetched = await service.getProvider(created.id);
      expect(fetched).toBeNull();
    });
  });
});
