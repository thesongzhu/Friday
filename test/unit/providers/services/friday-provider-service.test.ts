import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FridaySqliteLayer } from "#state";
import { createFridayProviderService } from "#providers";
import { resetMasterKeyCache } from "#providers";
import { createFridayPreferenceFactRepository } from "#learning";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";

import type { FridayProviderService } from "#providers";
import type { FridayModelRoutingConfig } from "#providers";

describe("FridayProviderService", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;
  let service: FridayProviderService;
  const NOW = "2026-02-17T10:00:00.000Z";
  const NOW_MS = Date.parse(NOW);
  const originalFetch = globalThis.fetch;

  function listAuthProfiles() {
    return db.withReadConnection((conn) =>
      conn.prepare(
        `SELECT provider_profile_id, profile_key, display_label, auth_mode, key_source_json, oauth_provider, is_active
         FROM auth_profiles
         ORDER BY provider_profile_id ASC, profile_key ASC`,
      ).all() as Array<{
        provider_profile_id: string;
        profile_key: string;
        display_label: string;
        auth_mode: string;
        key_source_json: string | null;
        oauth_provider: string | null;
        is_active: number;
      }>,
    );
  }

  function installCapabilityDoctorFetchMock() {
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (href.endsWith("/v1/embeddings")) {
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
      }
      if (href.endsWith("/v1/audio/speech")) {
        return new Response(Buffer.from("fake-audio"), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }
      const body = typeof init?.body === "string" ? init.body : "";
      const output = body.includes("Read the text in this image") ? "FRIDAY" : "OK";
      if (href.endsWith("/v1/chat/completions")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: output } }] }), { status: 200 });
      }
      if (href.endsWith("/v1/responses")) {
        return new Response(JSON.stringify({ output_text: output }), { status: 200 });
      }
      if (href.endsWith("/v1/messages")) {
        return new Response(JSON.stringify({ content: [{ type: "text", text: output }] }), { status: 200 });
      }
      if (href.endsWith("/api/generate")) {
        return new Response(JSON.stringify({ response: output }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
  }

  function markProviderValidated(providerId: string): void {
    const row = db.withReadConnection((conn) =>
      conn.prepare(
        `SELECT config_json FROM provider_profiles WHERE id = ?`,
      ).get(providerId) as { config_json: string } | undefined,
    );
    expect(row).toBeTruthy();
    const config = JSON.parse(row!.config_json) as Record<string, unknown>;
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `UPDATE provider_profiles
            SET config_json = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        JSON.stringify({
          ...config,
          validation: { status: "ok", checkedAt: NOW },
        }),
        NOW,
        providerId,
      );
    });
  }

  function setProviderLifecycle(providerId: string, promotionChannel: string): void {
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `UPDATE provider_profiles
            SET promotion_channel = ?, shadow_version_id = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        promotionChannel,
        promotionChannel === "none" ? null : `${providerId}@shadow`,
        NOW,
        providerId,
      );
    });
  }

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
        apiKey: "test-real-key-123", // pragma: allowlist secret
        supportedModels: ["gpt-4o"],
        validateOnSave: false,
      });

      expect(profile.config.keySource.kind).toBe("secret-ref");
    });

    it("creates a provider with a file-ref key source", async () => {
      const profile = await service.createProvider({
        kind: "openai",
        name: "OpenAI File Ref",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "file:/tmp/provider.key",
        supportedModels: ["gpt-4o"],
        validateOnSave: false,
      });

      expect(profile.config.keySource).toEqual({
        kind: "file-ref",
        path: "/tmp/provider.key",
      });
    });

    it("creates a provider with a command-ref key source", async () => {
      const profile = await service.createProvider({
        kind: "openai",
        name: "OpenAI Command Ref",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "command:printf test-command-key",
        supportedModels: ["gpt-4o"],
        validateOnSave: false,
      });

      expect(profile.config.keySource).toEqual({
        kind: "command-ref",
        command: "printf test-command-key",
      });
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
      process.env.OPENAI_API_KEY = "test-openai-key"; // pragma: allowlist secret
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

    it("creates an anthropic token provider with encrypted token storage", async () => {
      const profile = await service.createProvider({
        kind: "anthropic",
        name: "Claude Setup Token",
        baseUrl: "https://api.anthropic.com",
        authMode: "token",
        api: "anthropic-messages",
        apiKey: "test-ant-token-real", // pragma: allowlist secret
        supportedModels: ["claude-sonnet-4-20250514"],
        validateOnSave: false,
      });

      expect(profile.config.authMode).toBe("token");
      expect(profile.config.keySource.kind).toBe("secret-ref");
    });

    it("syncs a default auth profile row on create", async () => {
      const hosted = await service.createProvider({
        kind: "anthropic",
        name: "Claude Setup Token",
        baseUrl: "https://api.anthropic.com",
        authMode: "token",
        api: "anthropic-messages",
        apiKey: "test-ant-token-real", // pragma: allowlist secret
        supportedModels: ["claude-sonnet-4-20250514"],
        validateOnSave: false,
      });

      expect(listAuthProfiles()).toEqual([
        expect.objectContaining({
          provider_profile_id: "test-id-0001",
          profile_key: "default",
          display_label: "Claude Setup Token Default",
          auth_mode: "token",
          oauth_provider: null,
          is_active: 1,
        }),
      ]);
    });

    it("creates a cli-backed external-session provider without persisting secrets", async () => {
      const profile = await service.createProvider({
        kind: "openai",
        name: "Codex CLI",
        baseUrl: "",
        authMode: "external-session",
        backendKind: "cli",
        cliConfig: {
          backendId: "codex-cli",
          binaryPath: "/usr/local/bin/codex",
        },
        api: "openai-responses",
        supportedModels: ["gpt-5.4"],
        validateOnSave: false,
      });

      expect(profile.config.backendKind).toBe("cli");
      expect(profile.config.authMode).toBe("external-session");
      expect(profile.config.keySource).toEqual({ kind: "none" });
      expect(profile.config.cliConfig).toEqual({
        backendId: "codex-cli",
        binaryPath: "/usr/local/bin/codex",
      });
    });
  });

  describe("listProviders", () => {
    it("returns empty list initially", async () => {
      const list = await service.listProviders();
      expect(list).toHaveLength(0);
    });

    it("returns created providers", async () => {
      const local = await service.createProvider({
        kind: "openai",
        name: "P1",
        baseUrl: "https://p1.com",
        authMode: "api-key",
        api: "openai-completions",
        supportedModels: ["m1"],
        validateOnSave: false,
      });
      const cli = await service.createProvider({
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

    it("normalizes legacy provider configs missing supportedModels", async () => {
      db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO provider_profiles
           (id, kind, display_name, endpoint_url, enabled, default_model, config_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "legacy-provider",
          "openai",
          "Legacy Provider",
          "https://legacy.test",
          1,
          "gpt-4o",
          JSON.stringify({
            api: "openai-completions",
            authMode: "api-key",
          }),
          NOW,
          NOW,
        );
      });

      const [provider] = await service.listProviders();
      expect(provider.config.supportedModels).toEqual([]);
      expect(provider.config.keySource).toEqual({ kind: "none" });
    });
  });

  describe("getProvider", () => {
    it("returns null for non-existent", async () => {
      const result = await service.getProvider("non-existent");
      expect(result).toBeNull();
    });

    it("returns existing provider", async () => {
      const hosted = await service.createProvider({
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
      const local = await service.createProvider({
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
      const cli = await service.createProvider({
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
        apiKey: "test-new-key", // pragma: allowlist secret
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

    it("syncs the default auth profile when auth mode changes", async () => {
      await service.createProvider({
        kind: "anthropic",
        name: "Anthropic OAuth",
        baseUrl: "https://api.anthropic.com",
        authMode: "oauth",
        api: "anthropic-messages",
        supportedModels: ["claude-sonnet-4-20250514"],
      });

      await service.updateProvider("test-id-0001", {
        authMode: "token",
        apiKey: "test-ant-token-switch", // pragma: allowlist secret
      });

      expect(listAuthProfiles()).toEqual([
        expect.objectContaining({
          provider_profile_id: "test-id-0001",
          profile_key: "default",
          auth_mode: "token",
          oauth_provider: null,
          is_active: 1,
        }),
      ]);
    });

    it("downgrades update-time user verified runtime capabilities to declared", async () => {
      await service.createProvider({
        kind: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        supportedModels: ["gpt-4o"],
        validateOnSave: false,
      });

      const updated = await service.updateProvider("test-id-0001", {
        runtimeCapabilities: [
          {
            capability: "text",
            model: "gpt-4o",
            status: "verified",
            verified: true,
            verifiedAt: NOW,
          },
        ],
        validateOnSave: false,
      });

      expect(updated.config.runtimeCapabilities).toEqual([
        {
          capability: "text",
          model: "gpt-4o",
          status: "declared",
          verified: undefined,
          verifiedAt: undefined,
        },
      ]);
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

    it("deletes synced auth profiles with the provider", async () => {
      await service.createProvider({
        kind: "openai",
        name: "Delete Me",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "test-delete-me", // pragma: allowlist secret
        supportedModels: ["gpt-4o"],
        validateOnSave: false,
      });

      expect(listAuthProfiles()).toHaveLength(1);

      await service.deleteProvider("test-id-0001");

      expect(listAuthProfiles()).toHaveLength(0);
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

  describe("auth profile management", () => {
    it("lists auth profiles for a provider", async () => {
      await service.createProvider({
        kind: "anthropic",
        name: "Claude Setup Token",
        baseUrl: "https://api.anthropic.com",
        authMode: "token",
        api: "anthropic-messages",
        apiKey: "test-ant-token-real", // pragma: allowlist secret
        supportedModels: ["claude-sonnet-4-20250514"],
        validateOnSave: false,
      });

      const profiles = await service.listAuthProfiles("test-id-0001");
      expect(profiles).toEqual([
        expect.objectContaining({
          profileKey: "default",
          authMode: "token",
          isActive: true,
        }),
      ]);
    });

    it("activates a secondary auth profile", async () => {
      await service.createProvider({
        kind: "anthropic",
        name: "Claude Setup Token",
        baseUrl: "https://api.anthropic.com",
        authMode: "token",
        api: "anthropic-messages",
        apiKey: "test-ant-token-real", // pragma: allowlist secret
        supportedModels: ["claude-sonnet-4-20250514"],
        validateOnSave: false,
      });

      db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO auth_profiles
             (id, provider_profile_id, provider_kind, profile_key, display_label,
              auth_mode, key_source_json, oauth_provider, is_active, metadata_json,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "auth-2",
          "test-id-0001",
          "anthropic",
          "cli-session",
          "Claude CLI",
          "external-session",
          JSON.stringify({ kind: "none" }),
          null,
          0,
          JSON.stringify({ backendId: "claude-cli" }),
          NOW,
          NOW,
        );
      });

      const active = await service.activateAuthProfile("test-id-0001", "cli-session");
      expect(active).toMatchObject({
        profileKey: "cli-session",
        authMode: "external-session",
        isActive: true,
      });

      expect(listAuthProfiles()).toEqual([
        expect.objectContaining({ profile_key: "cli-session", is_active: 1 }),
        expect.objectContaining({ profile_key: "default", is_active: 0 }),
      ]);
    });

    it("returns a doctor report for an http provider", async () => {
      await service.createProvider({
        kind: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "$OPENAI_API_KEY",
        supportedModels: ["gpt-4o"],
        validateOnSave: false,
      });

      const report = await service.doctorProvider("test-id-0001");
      expect(report).toMatchObject({
        providerId: "test-id-0001",
        providerKind: "openai",
        backendKind: "http",
        authMode: "api-key",
        activeProfileKey: "default",
      });
    });

    it("surfaces failed validation state in doctor reports", async () => {
      const profile = await service.createProvider({
        kind: "openai",
        name: "OpenAI Missing Env",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "$OPENAI_API_KEY",
        supportedModels: ["gpt-4o"],
        validateOnSave: false,
      });

      db.withWriteTransaction((conn) => {
        conn.prepare(
          `UPDATE provider_profiles
              SET config_json = ?, updated_at = ?
            WHERE id = ?`,
        ).run(
          JSON.stringify({
            ...profile.config,
            validation: {
              status: "failed",
              checkedAt: NOW,
              errorCode: "PROVIDER_ENV_VAR_MISSING",
              errorMessage: "Environment variable is missing",
            },
          }),
          NOW,
          profile.id,
        );
      });

      const report = await service.doctorProvider(profile.id);
      expect(report.authHealth).toBe("missing");
      expect(report.routingEligible).toBe(false);
      expect(report.reasons).toContain("validation_failed");
    });
  });

  describe("routing config", () => {
    it("returns default empty config when not set", async () => {
      const config = await service.getRoutingConfig();
      expect(config.defaultProviderId).toBe("");
      expect(config.fallbackProviderIds).toEqual([]);
    });

    it("normalizes legacy routing rows missing fallbackProviderIds", async () => {
      db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO hub_settings (key, value_json, revision, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?)`,
        ).run(
          "llm.routing.v1",
          JSON.stringify({
            defaultProviderId: "legacy-provider",
            defaultModel: "gpt-4o",
          }),
          NOW,
          NOW,
        );
      });

      const config = await service.getRoutingConfig();
      expect(config).toEqual({
        defaultProviderId: "legacy-provider",
        defaultModel: "gpt-4o",
        fallbackProviderIds: [],
      });
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

    it("normalizes routing input when fallbackProviderIds is omitted", async () => {
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

      const config = await service.setRoutingConfig({
        defaultProviderId: "test-id-0001",
        defaultModel: "gpt-4o",
      } as FridayModelRoutingConfig);

      expect(config).toEqual({
        defaultProviderId: "test-id-0001",
        defaultModel: "gpt-4o",
        fallbackProviderIds: [],
      });
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

    it("resolves legacy providers missing supportedModels without crashing", async () => {
      db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO provider_profiles
           (id, kind, display_name, endpoint_url, enabled, default_model, config_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "legacy-provider",
          "openai",
          "Legacy Provider",
          "https://legacy.test",
          1,
          "gpt-4o",
          JSON.stringify({
            api: "openai-completions",
            authMode: "api-key",
            keySource: { kind: "none" },
          }),
          NOW,
          NOW,
        );

        conn.prepare(
          `INSERT INTO hub_settings (key, value_json, revision, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?)`,
        ).run(
          "llm.routing.v1",
          JSON.stringify({
            defaultProviderId: "legacy-provider",
            defaultModel: "gpt-4o",
          }),
          NOW,
          NOW,
        );
      });

      const route = await service.resolveRoute();
      expect(route.provider.id).toBe("legacy-provider");
      expect(route.model).toBe("gpt-4o");
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
      await expect(service.getProvider("test-id-0001")).resolves.toMatchObject({
        config: {
          validation: { status: "ok" },
        },
      });
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

    it("resolves requested model aliases to the provider supported model", async () => {
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
      await service.createProvider({
        kind: "anthropic",
        name: "Claude",
        baseUrl: "https://api.anthropic.com",
        authMode: "api-key",
        api: "anthropic-messages",
        supportedModels: ["claude-opus-4-20250514"],
        defaultModel: "claude-opus-4-20250514",
        validateOnSave: false,
      });

      await service.setRoutingConfig({
        defaultProviderId: "test-id-0001",
        fallbackProviderIds: ["test-id-0002"],
      });

      const route = await service.resolveRoute("claude-opus-4");
      expect(route.provider.id).toBe("test-id-0002");
      expect(route.model).toBe("claude-opus-4-20250514");
    });

    it("throws when no provider supports the requested model", async () => {
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
      await service.createProvider({
        kind: "anthropic",
        name: "Claude",
        baseUrl: "https://api.anthropic.com",
        authMode: "api-key",
        api: "anthropic-messages",
        supportedModels: ["claude-sonnet-4-20250514"],
        defaultModel: "claude-sonnet-4-20250514",
        validateOnSave: false,
      });

      await service.setRoutingConfig({
        defaultProviderId: "test-id-0001",
        fallbackProviderIds: ["test-id-0002"],
      });

      await expect(service.resolveRoute("claude-opus-4-6")).rejects.toMatchObject({
        code: "PROVIDER_NO_CANDIDATES",
      });
    });

    it("does not downgrade a requested sibling model to a broader supported model", async () => {
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

      await expect(service.resolveRoute("gpt-4o-mini")).rejects.toMatchObject({
        code: "PROVIDER_NO_CANDIDATES",
      });
    });

    it("honors a requestedProviderId pin for route resolution", async () => {
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
      await service.createProvider({
        kind: "anthropic",
        name: "Claude",
        baseUrl: "https://api.anthropic.com",
        authMode: "api-key",
        api: "anthropic-messages",
        supportedModels: ["claude-sonnet-4-20250514"],
        defaultModel: "claude-sonnet-4-20250514",
        validateOnSave: false,
      });

      await service.setRoutingConfig({
        defaultProviderId: "test-id-0001",
        fallbackProviderIds: ["test-id-0002"],
      });

      const route = await service.resolveRoute(undefined, "test-id-0002");
      expect(route.provider.id).toBe("test-id-0002");
      expect(route.model).toBe("claude-sonnet-4-20250514");
    });

    it("rejects a pinned route when the provider is disabled", async () => {
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
      await service.createProvider({
        kind: "anthropic",
        name: "Claude",
        baseUrl: "https://api.anthropic.com",
        authMode: "api-key",
        api: "anthropic-messages",
        supportedModels: ["claude-sonnet-4-20250514"],
        defaultModel: "claude-sonnet-4-20250514",
        validateOnSave: false,
      });

      await service.setRoutingConfig({
        defaultProviderId: "test-id-0001",
        fallbackProviderIds: ["test-id-0002"],
      });

      await service.updateProvider("test-id-0002", {
        enabled: false,
        validateOnSave: false,
      });

      await expect(service.resolveRoute(undefined, "test-id-0002")).rejects.toMatchObject({
        code: "PROVIDER_DISABLED",
      });
    });

    it("rejects normal routing for providers still in shadow or canary lifecycle", async () => {
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
      await service.resolveRoute();
      setProviderLifecycle("test-id-0001", "shadow");

      await expect(service.resolveRoute(undefined, "test-id-0001")).rejects.toMatchObject({
        code: "PROVIDER_LIFECYCLE_UNPROMOTED",
      });
      await expect(service.resolveRoute()).rejects.toMatchObject({
        code: "PROVIDER_NO_CANDIDATES",
      });

      setProviderLifecycle("test-id-0001", "active");
      await expect(service.resolveRoute(undefined, "test-id-0001")).resolves.toMatchObject({
        provider: { id: "test-id-0001" },
      });
    });

    it("rejects a pinned route when the provider does not exist", async () => {
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

      await expect(service.resolveRoute(undefined, "missing-provider")).rejects.toMatchObject({
        code: "PROVIDER_NOT_FOUND",
      });
    });

    it("rejects a pinned route when the provider does not support the requested model", async () => {
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
      await service.createProvider({
        kind: "anthropic",
        name: "Claude",
        baseUrl: "https://api.anthropic.com",
        authMode: "api-key",
        api: "anthropic-messages",
        supportedModels: ["claude-sonnet-4-20250514"],
        defaultModel: "claude-sonnet-4-20250514",
        validateOnSave: false,
      });

      await service.setRoutingConfig({
        defaultProviderId: "test-id-0001",
        fallbackProviderIds: ["test-id-0002"],
      });

      await expect(
        service.resolveRoute("claude-opus-4-20250514", "test-id-0002"),
      ).rejects.toMatchObject({
        code: "PROVIDER_NO_CANDIDATES",
      });
    });
  });

  describe("routing explain and operator overrides", () => {
    it("excludes CLI backends from explainRouting when native tools are required", async () => {
      await service.createProvider({
        kind: "openai",
        name: "Codex CLI",
        baseUrl: "",
        authMode: "external-session",
        backendKind: "cli",
        cliConfig: {
          backendId: "codex-cli",
          binaryPath: "/usr/local/bin/codex",
        },
        api: "openai-responses",
        supportedModels: ["gpt-5.4"],
        defaultModel: "gpt-5.4",
        validateOnSave: false,
      });
      await service.createProvider({
        kind: "openai",
        name: "OpenAI HTTP",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-responses",
        apiKey: "test-http-key", // pragma: allowlist secret
        supportedModels: ["gpt-5.4"],
        defaultModel: "gpt-5.4",
        validateOnSave: false,
      });
      await service.setRoutingConfig({
        defaultProviderId: "test-id-0001",
        fallbackProviderIds: ["test-id-0002"],
      });
      markProviderValidated("test-id-0001");
      markProviderValidated("test-id-0002");

      const explain = await service.explainRouting({
        requestedModel: "gpt-5.4",
        routingContext: {
          estimatedInputTokens: 1024,
          complexity: "medium",
          requiresNativeTools: true,
          taskProfileId: "debug",
        },
      });

      expect(explain.selected.providerId).toBe("test-id-0002");
      expect(explain.reasonCode).toBe("requested_model");
      expect(explain.candidates.some((candidate) => candidate.backendKind === "cli")).toBe(true);
      expect(
        explain.candidates.find((candidate) => candidate.backendKind === "cli"),
      ).toMatchObject({
        eligible: false,
        ineligibilityReasons: expect.arrayContaining(["requires_native_tools"]),
      });
    });

    it("routes with context size, sensitivity, latency, and satellite availability constraints", async () => {
      const hosted = await service.createProvider({
        kind: "openai",
        name: "Hosted Tiny",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-responses",
        apiKey: "test-hosted-key", // pragma: allowlist secret
        supportedModels: ["tiny-8k"],
        defaultModel: "tiny-8k",
        deploymentKind: "hosted",
        validateOnSave: false,
      });
      const local = await service.createProvider({
        kind: "ollama",
        name: "Local Long",
        baseUrl: "http://127.0.0.1:11434",
        authMode: "none",
        api: "ollama",
        supportedModels: ["llama3-128k"],
        defaultModel: "llama3-128k",
        deploymentKind: "local",
        validateOnSave: false,
      });
      const cli = await service.createProvider({
        kind: "openai",
        name: "Codex CLI",
        baseUrl: "",
        authMode: "external-session",
        backendKind: "cli",
        cliConfig: {
          backendId: "codex-cli",
          binaryPath: "/usr/local/bin/codex",
        },
        api: "openai-responses",
        supportedModels: ["gpt-5.4"],
        defaultModel: "gpt-5.4",
        deploymentKind: "consumer-cli",
        validateOnSave: false,
      });
      await service.setRoutingConfig({
        defaultProviderId: hosted.id,
        fallbackProviderIds: [local.id, cli.id],
      });
      markProviderValidated(hosted.id);
      markProviderValidated(local.id);
      markProviderValidated(cli.id);

      const confidentialLongContext = await service.explainRouting({
        routingContext: {
          estimatedInputTokens: 20_000,
          complexity: "complex",
          dataSensitivity: "secret",
          latencyBudgetMs: 1_000,
          satelliteAvailable: true,
        },
      });

      expect(confidentialLongContext.selected.providerId).toBe(local.id);
      expect(
        confidentialLongContext.candidates.find((candidate) => candidate.providerId === hosted.id),
      ).toMatchObject({
        eligible: false,
        ineligibilityReasons: expect.arrayContaining([
          "context_window_exceeded",
          "data_sensitivity_requires_local",
        ]),
      });
      expect(
        confidentialLongContext.candidates.find((candidate) => candidate.providerId === cli.id),
      ).toMatchObject({
        eligible: false,
        ineligibilityReasons: expect.arrayContaining(["latency_budget_excludes_cli"]),
      });

      const satelliteUnavailable = await service.explainRouting({
        routingContext: {
          estimatedInputTokens: 2_000,
          complexity: "medium",
          satelliteAvailable: false,
        },
      });

      expect(
        satelliteUnavailable.candidates.find((candidate) => candidate.providerId === local.id),
      ).toMatchObject({
        eligible: false,
        ineligibilityReasons: expect.arrayContaining(["satellite_unavailable_for_local_route"]),
      });
    });

    it("honors operator-pinned routes in explainRouting", async () => {
      const primary = await service.createProvider({
        kind: "openai",
        name: "Primary",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "test-primary-key", // pragma: allowlist secret
        supportedModels: ["gpt-4o"],
        defaultModel: "gpt-4o",
        validateOnSave: false,
      });
      const pinned = await service.createProvider({
        kind: "openai",
        name: "Pinned",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "test-pinned-key", // pragma: allowlist secret
        supportedModels: ["gpt-4o"],
        defaultModel: "gpt-4o",
        validateOnSave: false,
      });
      await service.setRoutingConfig({
        defaultProviderId: primary.id,
        fallbackProviderIds: [pinned.id],
      });
      markProviderValidated(primary.id);
      markProviderValidated(pinned.id);
      await service.pinRoute({
        userId: "test-user",
        taskProfileId: "review",
        providerId: pinned.id,
        model: "gpt-4o",
        backendKind: "http",
        reason: "operator pin",
      });

      const explain = await service.explainRouting({
        tenantContext: {
          hubId: "tenant-a",
          userId: "test-user",
        },
        routingContext: {
          estimatedInputTokens: 600,
          complexity: "medium",
          requiresNativeTools: true,
          taskProfileId: "review",
        },
      });

      expect(explain.selected.providerId).toBe(pinned.id);
      expect(explain.learningAdjusted).toBe(true);
      expect(explain.reason).toContain("Operator pinned");
      expect(explain.reasonText).toContain("Operator pinned");
      expect(explain.candidates[0]).toMatchObject({
        providerId: pinned.id,
        pinned: true,
      });
    });

    it("clears stored route penalties", async () => {
      const factRepo = createFridayPreferenceFactRepository();
      db.withWriteTransaction((conn) => {
        factRepo.upsert(conn, {
          factId: "fact-001",
          userId: "test-user",
          key: "route_penalty:review:prov_001:http:gpt_4o",
          value: {
            providerId: "prov-001",
            model: "gpt-4o",
            backendKind: "http",
          },
          confidence: 0.8,
          evidenceCountDelta: 1,
          lastConfirmedAt: NOW,
          sourceEventId: "test:event",
          nowIso: NOW,
        });
      });

      const cleared = await service.clearRoutePenalty({
        userId: "test-user",
        taskProfileId: "review",
        providerId: "prov-001",
        model: "gpt-4o",
        backendKind: "http",
      });

      expect(cleared).toBe(true);
      const remaining = db.withReadConnection((conn) =>
        factRepo.getByUserAndKey(conn, "test-user", "route_penalty:review:prov_001:http:gpt_4o"),
      );
      expect(remaining).toBeNull();
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

    it("fails closed before execution when automatic provider validation fails", async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response("{}", { status: 401 })),
      ) as typeof fetch;
      await service.createProvider({
        kind: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "test-invalid-key", // pragma: allowlist secret
        supportedModels: ["gpt-4o"],
        defaultModel: "gpt-4o",
        validateOnSave: false,
      });
      await service.setRoutingConfig({
        defaultProviderId: "test-id-0001",
        fallbackProviderIds: [],
      });
      const run = vi.fn(async () => "should-not-run");

      await expect(service.runWithFallback({ run })).rejects.toMatchObject({
        code: "PROVIDER_NO_CANDIDATES",
      });
      expect(run).not.toHaveBeenCalled();
      await expect(service.getProvider("test-id-0001")).resolves.toMatchObject({
        config: {
          validation: { status: "failed" },
        },
      });
    });

    it("runs with credential from env-ref", async () => {
      process.env.TEST_KEY = "test-env-key";
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

        expect(result).toBe("test-env-key");
        expect(route.provider.kind).toBe("openai");
        expect(attempts).toHaveLength(0);
      } finally {
        delete process.env.TEST_KEY;
      }
    });

    it("runs capability doctor and retries routing when a required capability is unverified", async () => {
      process.env.TEST_KEY = "test-env-key";
      installCapabilityDoctorFetchMock();
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

        const { result, route } = await service.runWithFallback({
          routingContext: {
            estimatedInputTokens: 10,
            complexity: "simple",
            requiredCapabilities: ["text"],
          },
          run: async () => "ok",
        });
        const updated = await service.getProvider("test-id-0001");

        expect(result).toBe("ok");
        expect(route.model).toBe("gpt-4o");
        expect(updated?.config.runtimeCapabilities).toEqual(expect.arrayContaining([
          expect.objectContaining({
            capability: "text",
            model: "gpt-4o",
            status: "verified",
          }),
        ]));
      } finally {
        delete process.env.TEST_KEY;
      }
    });

    it("prefers the active auth profile over provider config when resolving credentials", async () => {
      process.env.AUTH_PROFILE_ENV = "profile-secret";
      try {
        await service.createProvider({
          kind: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com",
          authMode: "api-key",
          api: "openai-completions",
          apiKey: "global-secret", // pragma: allowlist secret
          supportedModels: ["gpt-4o"],
          defaultModel: "gpt-4o",
          validateOnSave: false,
        });

        await service.setRoutingConfig({
          defaultProviderId: "test-id-0001",
          fallbackProviderIds: [],
        });

        db.withWriteTransaction((conn) => {
          conn.prepare(
            `UPDATE auth_profiles
             SET auth_mode = ?, key_source_json = ?, updated_at = ?
             WHERE provider_profile_id = ? AND profile_key = ?`,
          ).run(
            "api-key",
            JSON.stringify({ kind: "env-ref", envVar: "AUTH_PROFILE_ENV" }),
            NOW,
            "test-id-0001",
            "default",
          );
        });

        const { result } = await service.runWithFallback({
          run: async (_route, credential) => credential,
        });

        expect(result).toBe("profile-secret");
      } finally {
        delete process.env.AUTH_PROFILE_ENV;
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

    it("pins execution to the requested provider without falling back", async () => {
      process.env.OPENAI_KEY = "test-openai-key";
      process.env.ANTHROPIC_KEY = "test-anthropic-key";
      try {
        await service.createProvider({
          kind: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com",
          authMode: "api-key",
          api: "openai-completions",
          apiKey: "$OPENAI_KEY",
          supportedModels: ["gpt-4o"],
          defaultModel: "gpt-4o",
          validateOnSave: false,
        });
        await service.createProvider({
          kind: "anthropic",
          name: "Claude",
          baseUrl: "https://api.anthropic.com",
          authMode: "api-key",
          api: "anthropic-messages",
          apiKey: "$ANTHROPIC_KEY",
          supportedModels: ["claude-sonnet-4-20250514"],
          defaultModel: "claude-sonnet-4-20250514",
          validateOnSave: false,
        });

        await service.setRoutingConfig({
          defaultProviderId: "test-id-0001",
          fallbackProviderIds: ["test-id-0002"],
        });

        const run = vi.fn(async (_route, credential) => credential);
        const { result, route, attempts } = await service.runWithFallback({
          requestedProviderId: "test-id-0002",
          run,
        });

        expect(result).toBe("test-anthropic-key");
        expect(route.provider.id).toBe("test-id-0002");
        expect(attempts).toHaveLength(0);
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        delete process.env.OPENAI_KEY;
        delete process.env.ANTHROPIC_KEY;
      }
    });

    it("does not fall back to the default provider when a pinned provider run fails", async () => {
      process.env.OPENAI_KEY = "test-openai-key";
      process.env.ANTHROPIC_KEY = "test-anthropic-key";
      try {
        await service.createProvider({
          kind: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com",
          authMode: "api-key",
          api: "openai-completions",
          apiKey: "$OPENAI_KEY",
          supportedModels: ["gpt-4o"],
          defaultModel: "gpt-4o",
          validateOnSave: false,
        });
        await service.createProvider({
          kind: "anthropic",
          name: "Claude",
          baseUrl: "https://api.anthropic.com",
          authMode: "api-key",
          api: "anthropic-messages",
          apiKey: "$ANTHROPIC_KEY",
          supportedModels: ["claude-sonnet-4-20250514"],
          defaultModel: "claude-sonnet-4-20250514",
          validateOnSave: false,
        });

        await service.setRoutingConfig({
          defaultProviderId: "test-id-0001",
          fallbackProviderIds: ["test-id-0002"],
        });

        const run = vi.fn(async (route: { provider: { id: string } }) => {
          throw new Error(`forced failure for ${route.provider.id}`);
        });

        await expect(
          service.runWithFallback({
            requestedProviderId: "test-id-0002",
            run,
          }),
        ).rejects.toThrow("forced failure for test-id-0002");

        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: expect.objectContaining({ id: "test-id-0002" }),
          }),
          "test-anthropic-key",
        );
      } finally {
        delete process.env.OPENAI_KEY;
        delete process.env.ANTHROPIC_KEY;
      }
    });

    it("skips OAuth fallback providers that do not have an active login", async () => {
      process.env.OPENAI_KEY = "test-openai-key";
      try {
        await service.createProvider({
          kind: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com",
          authMode: "api-key",
          api: "openai-completions",
          apiKey: "$OPENAI_KEY",
          supportedModels: ["gpt-4o"],
          defaultModel: "gpt-4o",
          validateOnSave: false,
        });
        await service.createProvider({
          kind: "anthropic",
          name: "Anthropic OAuth",
          baseUrl: "https://api.anthropic.com",
          authMode: "oauth",
          api: "anthropic-messages",
          supportedModels: ["claude-sonnet-4-20250514"],
          defaultModel: "claude-sonnet-4-20250514",
          validateOnSave: false,
        });

        await service.setRoutingConfig({
          defaultProviderId: "test-id-0001",
          fallbackProviderIds: ["test-id-0002"],
        });

        const run = vi.fn(async (route: { provider: { id: string } }) => {
          throw new Error(`forced failure for ${route.provider.id}`);
        });

        let error: {
          code?: string;
          cause?: { message?: string };
          details?: { attempts?: Array<{ providerId: string }> };
        } | null = null;
        try {
          await service.runWithFallback({ run });
        } catch (caught) {
          error = caught as typeof error;
        }

        expect(error).not.toBeNull();
        expect(error).toMatchObject({
          code: "PROVIDER_ERROR",
          cause: { message: "forced failure for test-id-0001" },
          details: {
            attempts: [
              expect.objectContaining({
                providerId: "test-id-0001",
              }),
            ],
          },
        });
        expect(error?.details?.attempts).toHaveLength(1);
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        delete process.env.OPENAI_KEY;
      }
    });

    it("preserves the configured default provider while budget is healthy", async () => {
      process.env.OPENAI_KEY = "test-openai-key";
      try {
        await service.createProvider({
          kind: "openai",
          name: "Primary OpenAI",
          baseUrl: "https://api.openai.com",
          authMode: "api-key",
          api: "openai-responses",
          apiKey: "$OPENAI_KEY",
          supportedModels: ["gpt-4o"],
          defaultModel: "gpt-4o",
          validateOnSave: false,
        });
        await service.createProvider({
          kind: "openai",
          name: "Cheaper OpenAI fallback",
          baseUrl: "https://api.openai.com",
          authMode: "api-key",
          api: "openai-responses",
          apiKey: "$OPENAI_KEY",
          supportedModels: ["gpt-4o-mini"],
          defaultModel: "gpt-4o-mini",
          validateOnSave: false,
        });

        await service.setRoutingConfig({
          defaultProviderId: "test-id-0001",
          fallbackProviderIds: ["test-id-0002"],
        });

        const { route, routingDecision } = await service.runWithFallback({
          routingContext: {
            estimatedInputTokens: 4096,
            complexity: "simple",
          },
          run: async (candidate) => candidate.provider.id,
        });

        expect(route.provider.id).toBe("test-id-0001");
        expect(route.model).toBe("gpt-4o");
        expect(routingDecision.strategy).toBe("configured");
        expect(routingDecision.routeDecisionTrace?.selectedBeforeLearning).toMatchObject({
          providerId: "test-id-0001",
          model: "gpt-4o",
        });
        expect(routingDecision.routeDecisionTrace?.selectedAfterLearning).toMatchObject({
          providerId: "test-id-0001",
          model: "gpt-4o",
        });
      } finally {
        delete process.env.OPENAI_KEY;
      }
    });

    it("does not let learning history override a requestedProviderId pin", async () => {
      process.env.OPENAI_KEY = "test-openai-key";
      process.env.ANTHROPIC_KEY = "test-anthropic-key";
      try {
        await service.createProvider({
          kind: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com",
          authMode: "api-key",
          api: "openai-responses",
          apiKey: "$OPENAI_KEY",
          supportedModels: ["gpt-4o"],
          defaultModel: "gpt-4o",
          validateOnSave: false,
        });
        await service.createProvider({
          kind: "anthropic",
          name: "Claude",
          baseUrl: "https://api.anthropic.com",
          authMode: "api-key",
          api: "anthropic-messages",
          apiKey: "$ANTHROPIC_KEY",
          supportedModels: ["claude-sonnet-4-20250514"],
          defaultModel: "claude-sonnet-4-20250514",
          validateOnSave: false,
        });

        await service.setRoutingConfig({
          defaultProviderId: "test-id-0001",
          fallbackProviderIds: ["test-id-0002"],
        });

        db.withWriteTransaction((conn) => {
          const insertRun = conn.prepare(
            `INSERT INTO friday_agent_runs (
              id, task, status, session_key, provider_id, model, attempt, max_attempts, created_at,
              completed_at, task_profile_json, actual_execution_json
            ) VALUES (?, ?, ?, ?, ?, ?, 1, 3, ?, ?, ?, ?)`,
          );

          insertRun.run(
            "hist-pin-001",
            "reply with only ok",
            "completed",
            "sess-pin-001",
            "test-id-0002",
            "claude-sonnet-4-20250514",
            NOW,
            NOW,
            JSON.stringify({ id: "default", label: "Default", description: "Default", reasoningEffort: "medium", temperature: 0.2 }),
            JSON.stringify({
              actualProviderId: "test-id-0002",
              actualModel: "claude-sonnet-4-20250514",
              backendKind: "http",
            }),
          );
        });

        const { route, routingDecision } = await service.runWithFallback({
          requestedProviderId: "test-id-0001",
          requestedModel: "gpt-4o",
          routingContext: {
            estimatedInputTokens: 128,
            complexity: "simple",
            taskProfileId: "default",
          },
          run: async (candidate) => candidate.provider.id,
        });

        expect(route.provider.id).toBe("test-id-0001");
        expect(route.model).toBe("gpt-4o");
        expect(routingDecision.routeDecisionTrace?.selectedBeforeLearning).toMatchObject({
          providerId: "test-id-0001",
          model: "gpt-4o",
        });
        expect(routingDecision.routeDecisionTrace?.selectedAfterLearning).toMatchObject({
          providerId: "test-id-0001",
          model: "gpt-4o",
        });
        expect(routingDecision.selectedAdjusted).toBe(false);
      } finally {
        delete process.env.OPENAI_KEY;
        delete process.env.ANTHROPIC_KEY;
      }
    });

    it("filters text-only CLI backends out when the task requires Friday native tools", async () => {
      process.env.OPENAI_KEY = "test-openai-key";
      try {
        await service.createProvider({
          kind: "openai",
          name: "Codex CLI",
          baseUrl: "",
          backendKind: "cli",
          authMode: "external-session",
          api: "openai-responses",
          cliConfig: { backendId: "codex-cli" },
          supportedModels: ["gpt-5.4"],
          defaultModel: "gpt-5.4",
          validateOnSave: false,
        });
        await service.createProvider({
          kind: "openai",
          name: "OpenAI HTTP",
          baseUrl: "https://api.openai.com",
          authMode: "api-key",
          api: "openai-responses",
          apiKey: "$OPENAI_KEY",
          supportedModels: ["gpt-5.4"],
          defaultModel: "gpt-5.4",
          validateOnSave: false,
        });

        await service.setRoutingConfig({
          defaultProviderId: "test-id-0001",
          fallbackProviderIds: ["test-id-0002"],
        });

        const { route } = await service.runWithFallback({
          requestedModel: "gpt-5.4",
          routingContext: {
            estimatedInputTokens: 2000,
            complexity: "medium",
            requiresNativeTools: true,
          },
          run: async (_route, credential) => credential,
        });

        expect(route.provider.id).toBe("test-id-0002");
        expect(route.provider.config.backendKind).toBe("http");
      } finally {
        delete process.env.OPENAI_KEY;
      }
    });

    it("fails cleanly when only text-only CLI backends remain for a tool-using task", async () => {
      await service.createProvider({
        kind: "openai",
        name: "Codex CLI",
        baseUrl: "",
        backendKind: "cli",
        authMode: "external-session",
        api: "openai-responses",
        cliConfig: { backendId: "codex-cli" },
        supportedModels: ["gpt-5.4"],
        defaultModel: "gpt-5.4",
        validateOnSave: false,
      });

      await service.setRoutingConfig({
        defaultProviderId: "test-id-0001",
        fallbackProviderIds: [],
      });

      await expect(
        service.runWithFallback({
          requestedModel: "gpt-5.4",
          routingContext: {
            estimatedInputTokens: 2000,
            complexity: "medium",
            requiresNativeTools: true,
          },
          run: async () => "unreachable",
        }),
      ).rejects.toMatchObject({
        code: "PROVIDER_NO_CANDIDATES",
      });
    });

    it("re-orders candidates using historical outcomes for the active task profile", async () => {
      process.env.OPENAI_KEY = "test-openai-key";
      process.env.ANTHROPIC_KEY = "test-anthropic-key";
      try {
        await service.createProvider({
          kind: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com",
          authMode: "api-key",
          api: "openai-responses",
          apiKey: "$OPENAI_KEY",
          supportedModels: ["gpt-4o-mini"],
          defaultModel: "gpt-4o-mini",
          validateOnSave: false,
        });
        await service.createProvider({
          kind: "anthropic",
          name: "Claude",
          baseUrl: "https://api.anthropic.com",
          authMode: "api-key",
          api: "anthropic-messages",
          apiKey: "$ANTHROPIC_KEY",
          supportedModels: ["claude-sonnet-4-20250514"],
          defaultModel: "claude-sonnet-4-20250514",
          validateOnSave: false,
        });

        await service.setRoutingConfig({
          defaultProviderId: "test-id-0001",
          fallbackProviderIds: ["test-id-0002"],
        });

        db.withWriteTransaction((conn) => {
          const insertSession = conn.prepare(
            `INSERT INTO sessions (
              id, session_key, agent_id, channel, chat_kind, status,
              metadata_json, created_at, updated_at, account_id, chat_id, user_id
            ) VALUES (?, ?, 'agent', 'chat', 'dm', 'active', '{}', ?, ?, ?, ?, ?)`,
          );
          for (const sessionKey of ["sess-001", "sess-002", "sess-003"]) {
            insertSession.run(
              `session-${sessionKey}`,
              sessionKey,
              NOW,
              NOW,
              "tenant-review",
              sessionKey,
              "user-review",
            );
          }

          const insertRun = conn.prepare(
            `INSERT INTO friday_agent_runs (
              id, task, status, session_key, provider_id, model, attempt, max_attempts, created_at,
              completed_at, task_profile_json, actual_execution_json
            ) VALUES (?, ?, ?, ?, ?, ?, 1, 3, ?, ?, ?, ?)`,
          );

          insertRun.run(
            "hist-run-001",
            "review the architecture",
            "completed",
            "sess-001",
            "test-id-0002",
            "claude-sonnet-4-20250514",
            NOW,
            NOW,
            JSON.stringify({ id: "review", label: "Review", description: "Review", reasoningEffort: "high", temperature: 0.1 }),
            JSON.stringify({
              actualProviderId: "test-id-0002",
              actualModel: "claude-sonnet-4-20250514",
              backendKind: "http",
            }),
          );
          insertRun.run(
            "hist-run-002",
            "review the architecture",
            "completed",
            "sess-002",
            "test-id-0002",
            "claude-sonnet-4-20250514",
            NOW,
            NOW,
            JSON.stringify({ id: "review", label: "Review", description: "Review", reasoningEffort: "high", temperature: 0.1 }),
            JSON.stringify({
              actualProviderId: "test-id-0002",
              actualModel: "claude-sonnet-4-20250514",
              backendKind: "http",
            }),
          );
          insertRun.run(
            "hist-run-003",
            "review the architecture",
            "failed",
            "sess-003",
            "test-id-0001",
            "gpt-4o-mini",
            NOW,
            NOW,
            JSON.stringify({ id: "review", label: "Review", description: "Review", reasoningEffort: "high", temperature: 0.1 }),
            JSON.stringify({
              actualProviderId: "test-id-0001",
              actualModel: "gpt-4o-mini",
              backendKind: "http",
            }),
          );
        });

        const { route, routingDecision } = await service.runWithFallback({
          routingContext: {
            estimatedInputTokens: 1800,
            complexity: "medium",
            taskProfileId: "review",
          },
          tenantContext: {
            hubId: "tenant-review",
            userId: "user-review",
          },
          run: async (candidate) => candidate.provider.id,
        });

        expect(route.provider.id).toBe("test-id-0002");
        expect(routingDecision.learningAdjusted).toBe(true);
        expect(routingDecision.reason).toContain("Historical route outcomes influenced candidate scoring.");

        const explain = await service.explainRouting({
          tenantContext: {
            hubId: "tenant-review",
            userId: "user-review",
          },
          routingContext: {
            estimatedInputTokens: 1800,
            complexity: "medium",
            taskProfileId: "review",
          },
        });

        expect(explain.reasonText).toContain("Historical route outcomes influenced candidate scoring.");
        expect(
          explain.candidateScores.find((candidate) => candidate.providerId === "test-id-0002")?.historyStats,
        ).toMatchObject({
          sampleCount: 2,
          successRate: 1,
          failureRate: 0,
        });

        const otherTenantRun = await service.runWithFallback({
          routingContext: {
            estimatedInputTokens: 1800,
            complexity: "medium",
            taskProfileId: "review",
          },
          tenantContext: {
            hubId: "tenant-other",
            userId: "user-other",
          },
          run: async (candidate) => candidate.provider.id,
        });

        expect(otherTenantRun.route.provider.id).toBe("test-id-0001");
        expect(otherTenantRun.routingDecision.learningSignalsPresent).toBe(false);
      } finally {
        delete process.env.OPENAI_KEY;
        delete process.env.ANTHROPIC_KEY;
      }
    });

    it("penalizes routes that operators explicitly rejected for the same task profile", async () => {
      process.env.OPENAI_KEY = "test-openai-key";
      process.env.ANTHROPIC_KEY = "test-anthropic-key";
      try {
        await service.createProvider({
          kind: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com",
          authMode: "api-key",
          api: "openai-completions",
          apiKey: "$OPENAI_KEY",
          supportedModels: ["gpt-4o-mini"],
          defaultModel: "gpt-4o-mini",
          validateOnSave: false,
        });
        await service.createProvider({
          kind: "anthropic",
          name: "Anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "api-key",
          api: "anthropic-messages",
          apiKey: "$ANTHROPIC_KEY",
          supportedModels: ["claude-sonnet-4-20250514"],
          defaultModel: "claude-sonnet-4-20250514",
          validateOnSave: false,
        });

        await service.setRoutingConfig({
          defaultProviderId: "test-id-0001",
          fallbackProviderIds: ["test-id-0002"],
        });

        db.withWriteTransaction((conn) => {
          conn.prepare(
            `INSERT INTO preference_facts (
              fact_id, user_id, key, value_json, confidence, evidence_count,
              last_confirmed_at, source_event_ids_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            "fact-001",
            "test-user",
            "route_penalty:review:test_id_0001:http:gpt_4o_mini",
            JSON.stringify({ reasonCode: "too_risky" }),
            0.95,
            1,
            NOW,
            JSON.stringify(["evt-1"]),
            NOW,
            NOW,
          );
        });

        const { route, routingDecision } = await service.runWithFallback({
          tenantContext: {
            hubId: "test-hub",
            userId: "test-user",
          },
          routingContext: {
            estimatedInputTokens: 900,
            complexity: "medium",
            taskProfileId: "review",
          },
          run: async (candidate) => candidate.provider.id,
        });

        expect(route.provider.id).toBe("test-id-0002");
        expect(routingDecision.learningAdjusted).toBe(true);
        expect(routingDecision.reason).toContain("Operator route penalties influenced candidate scoring.");
      } finally {
        delete process.env.OPENAI_KEY;
        delete process.env.ANTHROPIC_KEY;
      }
    });

    it("uses each fallback provider's own supported model when routing.defaultModel is provider-specific", async () => {
      process.env.OPENAI_KEY = "test-openai-key";
      process.env.ANTHROPIC_KEY = "test-anthropic-key";
      try {
        await service.createProvider({
          kind: "anthropic",
          name: "Claude",
          baseUrl: "https://api.anthropic.com",
          authMode: "api-key",
          api: "anthropic-messages",
          apiKey: "$ANTHROPIC_KEY",
          supportedModels: ["claude-opus-4-20250514"],
          defaultModel: "claude-opus-4-20250514",
          validateOnSave: false,
        });
        await service.createProvider({
          kind: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com",
          authMode: "api-key",
          api: "openai-completions",
          apiKey: "$OPENAI_KEY",
          supportedModels: ["gpt-4.1-mini", "gpt-4o-mini"],
          defaultModel: "gpt-4.1-mini",
          validateOnSave: false,
        });

        await service.setRoutingConfig({
          defaultProviderId: "test-id-0001",
          defaultModel: "claude-opus-4-20250514",
          fallbackProviderIds: ["test-id-0002"],
        });

        const seenRoutes: string[] = [];
        const { result, route, attempts } = await service.runWithFallback({
          run: async (candidate) => {
            seenRoutes.push(`${candidate.provider.id}:${candidate.model}`);
            if (candidate.provider.id === "test-id-0001") {
              throw Object.assign(new Error("Internal server error"), { status: 500 });
            }
            return candidate.model;
          },
        });

        expect(result).toBe("gpt-4.1-mini");
        expect(route.provider.id).toBe("test-id-0002");
        expect(route.model).toBe("gpt-4.1-mini");
        expect(seenRoutes.every((entry) => !entry.endsWith(":claude-opus-4-20250514") || entry.startsWith("test-id-0001:"))).toBe(true);
        expect(seenRoutes).toContain("test-id-0002:gpt-4.1-mini");
        if (attempts.length > 0) {
          expect(attempts[0]).toMatchObject({
            providerId: "test-id-0001",
            model: "claude-opus-4-20250514",
          });
        }
      } finally {
        delete process.env.OPENAI_KEY;
        delete process.env.ANTHROPIC_KEY;
      }
    });

    it("prefers tenant-scoped credentials when tenantContext is provided", async () => {
      const credentialResolver = {
        resolve: vi.fn(async () => ({
          tenantContext: { hubId: "tenant-ops", userId: "user-1" },
          credential: "tenant-secret",
          providerId: "test-id-0001",
          isTenantOverride: true,
        })),
        setTenantCredential: vi.fn(),
        removeTenantCredential: vi.fn(),
        listTenantScopes: vi.fn(async () => []),
      };
      const scopedService = createFridayProviderService({
        db,
        idGenerator: idGen,
        nowIso: () => NOW,
        nowMs: () => NOW_MS,
        fetchImpl: globalThis.fetch as typeof fetch,
        credentialResolver,
      });

      await scopedService.createProvider({
        kind: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "global-secret",
        supportedModels: ["gpt-4o"],
        defaultModel: "gpt-4o",
        validateOnSave: false,
      });

      await scopedService.setRoutingConfig({
        defaultProviderId: "test-id-0001",
        fallbackProviderIds: [],
      });

      const { result } = await scopedService.runWithFallback({
        tenantContext: {
          hubId: "tenant-ops",
          userId: "user-1",
        },
        run: async (_route, credential) => credential,
      });

      expect(result).toBe("tenant-secret");
      expect(credentialResolver.resolve).toHaveBeenCalledWith("test-id-0001", {
        hubId: "tenant-ops",
        userId: "user-1",
      });
    });

    it("keeps tenant-scoped credentials isolated across different tenants in one service instance", async () => {
      const credentialResolver = {
        resolve: vi.fn(async (_providerId: string, tenantContext: { hubId: string; userId?: string }) => ({
          tenantContext,
          credential: `${tenantContext.hubId}:${tenantContext.userId ?? "anon"}:secret`,
          providerId: "test-id-0001",
          isTenantOverride: true,
        })),
        setTenantCredential: vi.fn(),
        removeTenantCredential: vi.fn(),
        listTenantScopes: vi.fn(async () => []),
      };
      const scopedService = createFridayProviderService({
        db,
        idGenerator: idGen,
        nowIso: () => NOW,
        nowMs: () => NOW_MS,
        fetchImpl: globalThis.fetch as typeof fetch,
        credentialResolver,
      });

      await scopedService.createProvider({
        kind: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "global-secret",
        supportedModels: ["gpt-4o"],
        defaultModel: "gpt-4o",
        validateOnSave: false,
      });

      await scopedService.setRoutingConfig({
        defaultProviderId: "test-id-0001",
        fallbackProviderIds: [],
      });

      const tenantA = await scopedService.runWithFallback({
        tenantContext: {
          hubId: "tenant-a",
          userId: "alice",
        },
        run: async (_route, credential) => credential,
      });
      const tenantB = await scopedService.runWithFallback({
        tenantContext: {
          hubId: "tenant-b",
          userId: "bob",
        },
        run: async (_route, credential) => credential,
      });

      expect(tenantA.result).toBe("tenant-a:alice:secret");
      expect(tenantB.result).toBe("tenant-b:bob:secret");
      expect(tenantA.result).not.toBe(tenantB.result);
      expect(credentialResolver.resolve).toHaveBeenCalledTimes(3);
      expect(credentialResolver.resolve).toHaveBeenNthCalledWith(1, "test-id-0001", {
        hubId: "tenant-a",
        userId: "alice",
      });
      expect(credentialResolver.resolve).toHaveBeenNthCalledWith(2, "test-id-0001", {
        hubId: "tenant-a",
        userId: "alice",
      });
      expect(credentialResolver.resolve).toHaveBeenNthCalledWith(3, "test-id-0001", {
        hubId: "tenant-b",
        userId: "bob",
      });
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

    it("creates an OpenAI Codex OAuth provider with the Codex OAuth adapter selected", async () => {
      const profile = await service.createProvider({
        kind: "openai-codex",
        name: "OpenAI Codex OAuth",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "oauth",
        api: "openai-codex-responses",
        supportedModels: ["gpt-5.4-mini"],
        defaultModel: "gpt-5.4-mini",
      });

      expect(profile.config.authMode).toBe("oauth");
      expect(profile.config.oauthProvider).toBe("openai-codex");
      expect(profile.config.keySource).toEqual({ kind: "none" });
      expect(profile.config.validation?.status).toBe("never");
      expect(profile.config.validation?.errorMessage).toBe("OAuth login required");
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

    it("switches from oauth to token and validates with Bearer auth", async () => {
      let capturedHeaders: Record<string, string> = {};
      globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response("{}", { status: 200 });
      }) as typeof fetch;

      await service.createProvider({
        kind: "anthropic",
        name: "Anthropic OAuth",
        baseUrl: "https://api.anthropic.com",
        authMode: "oauth",
        api: "anthropic-messages",
        supportedModels: ["claude-sonnet-4-20250514"],
      });

      const updated = await service.updateProvider("test-id-0001", {
        authMode: "token",
        apiKey: "test-ant-token-switch", // pragma: allowlist secret
      });

      expect(updated.config.authMode).toBe("token");
      expect(updated.config.oauthProvider).toBeUndefined();
      expect(updated.config.validation?.status).toBe("ok");
      expect(capturedHeaders["Authorization"]).toBe("Bearer test-ant-token-switch");
      expect(capturedHeaders["x-api-key"]).toBeUndefined();
    });

    it("validates file-ref credentials during provider revalidation", async () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "friday-provider-"));
      const keyPath = path.join(tempDir, "openai.key");
      writeFileSync(keyPath, "file-key-123\n", "utf8");

      try {
        await service.createProvider({
          kind: "openai",
          name: "OpenAI File Ref",
          baseUrl: "https://api.openai.com",
          authMode: "api-key",
          api: "openai-completions",
          apiKey: `file:${keyPath}`,
          supportedModels: ["gpt-4o"],
          validateOnSave: false,
        });

        const state = await service.validateProvider("test-id-0001");
        expect(state.status).toBe("ok");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("validates command-ref credentials during provider revalidation", async () => {
      await service.createProvider({
        kind: "openai",
        name: "OpenAI Command Ref",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        apiKey: "command:printf command-key-123",
        supportedModels: ["gpt-4o"],
        validateOnSave: false,
      });

      const state = await service.validateProvider("test-id-0001");
      expect(state.status).toBe("ok");
    });
  });

  describe("runCapabilityDoctor", () => {
    it("downgrades create-time user verified runtime capabilities to declared", async () => {
      await service.createProvider({
        kind: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com",
        authMode: "api-key",
        api: "openai-completions",
        supportedModels: ["gpt-4o"],
        defaultModel: "gpt-4o",
        runtimeCapabilities: [
          {
            capability: "text",
            model: "gpt-4o",
            status: "verified",
            verified: true,
            verifiedAt: NOW,
          },
        ],
        validateOnSave: false,
      });

      const created = await service.getProvider("test-id-0001");
      expect(created?.config.runtimeCapabilities).toEqual([
        {
          capability: "text",
          model: "gpt-4o",
          status: "declared",
          verified: undefined,
          verifiedAt: undefined,
        },
      ]);
    });

    it("runs live capability probes and persists verified runtime capabilities", async () => {
      process.env.OPENAI_API_KEY = "doctor-key"; // pragma: allowlist secret
      installCapabilityDoctorFetchMock();
      try {
        await service.createProvider({
          kind: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com",
          authMode: "api-key",
          api: "openai-completions",
          apiKey: "$OPENAI_API_KEY",
          supportedModels: ["gpt-4o"],
          defaultModel: "gpt-4o",
          runtimeCapabilities: [
            { capability: "vision", model: "gpt-4o", status: "declared" },
            { capability: "tts", model: "gpt-4o", status: "declared" },
          ],
          validateOnSave: false,
        });

        const report = await service.runCapabilityDoctor();
        const updated = await service.getProvider("test-id-0001");

        expect(report.checkedAt).toBe(NOW);
        expect(report.providerValidations[0]?.validation.status).toBe("ok");
        expect(report.capabilityResults).toEqual(expect.arrayContaining([
          expect.objectContaining({
            providerId: "test-id-0001",
            capability: "text",
            model: "gpt-4o",
            status: "verified",
          }),
          expect.objectContaining({
            providerId: "test-id-0001",
            capability: "vision",
            model: "gpt-4o",
            status: "verified",
          }),
          expect.objectContaining({
            providerId: "test-id-0001",
            capability: "ocr",
            model: "gpt-4o",
            status: "verified",
          }),
          expect.objectContaining({
            providerId: "test-id-0001",
            capability: "tts",
            model: "gpt-4o",
            status: "verified",
          }),
        ]));
        expect(updated?.config.runtimeCapabilities).toEqual(expect.arrayContaining([
          expect.objectContaining({
            capability: "text",
            model: "gpt-4o",
            status: "verified",
            verified: true,
            verifiedAt: NOW,
          }),
          expect.objectContaining({
            capability: "vision",
            model: "gpt-4o",
            status: "verified",
            verified: true,
            verifiedAt: NOW,
          }),
          expect.objectContaining({
            capability: "ocr",
            model: "gpt-4o",
            status: "verified",
            verified: true,
            verifiedAt: NOW,
          }),
          expect.objectContaining({
            capability: "tts",
            model: "gpt-4o",
            status: "verified",
            verified: true,
            verifiedAt: NOW,
          }),
        ]));
      } finally {
        delete process.env.OPENAI_API_KEY;
      }
    });

    it("limits capability doctor writes to requested provider ids", async () => {
      process.env.OPENAI_API_KEY = "doctor-key"; // pragma: allowlist secret
      installCapabilityDoctorFetchMock();
      try {
        await service.createProvider({
          kind: "openai",
          name: "OpenAI Scoped",
          baseUrl: "https://api.openai.com",
          authMode: "api-key",
          api: "openai-completions",
          apiKey: "$OPENAI_API_KEY",
          supportedModels: ["gpt-4o-mini"],
          defaultModel: "gpt-4o-mini",
          validateOnSave: false,
        });
        await service.createProvider({
          kind: "openai",
          name: "OpenAI Untouched",
          baseUrl: "https://api.openai.com",
          authMode: "api-key",
          api: "openai-completions",
          apiKey: "$OPENAI_API_KEY",
          supportedModels: ["gpt-4o"],
          defaultModel: "gpt-4o",
          validateOnSave: false,
        });

        const report = await service.runCapabilityDoctor({ providerIds: ["test-id-0001"] });
        const scoped = await service.getProvider("test-id-0001");
        const untouched = await service.getProvider("test-id-0002");

        expect(report.providerValidations.map((entry) => entry.providerId)).toEqual(["test-id-0001"]);
        expect(report.capabilityResults.every((entry) => entry.providerId === "test-id-0001")).toBe(true);
        expect(scoped?.config.runtimeCapabilities).toEqual(expect.arrayContaining([
          expect.objectContaining({
            capability: "text",
            model: "gpt-4o-mini",
            status: "verified",
            verified: true,
          }),
        ]));
        expect(untouched?.config.runtimeCapabilities ?? []).toEqual([]);
      } finally {
        delete process.env.OPENAI_API_KEY;
      }
    });

    it("persists failed capability probes instead of treating provider validation as enough", async () => {
      process.env.OPENAI_API_KEY = "doctor-key"; // pragma: allowlist secret
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (href.endsWith("/v1/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response("model cannot generate", { status: 404 });
      }) as typeof fetch;
      globalThis.fetch = fetchMock;

      try {
        await service.createProvider({
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

        const report = await service.runCapabilityDoctor();
        const updated = await service.getProvider("test-id-0001");

        expect(report.providerValidations[0]?.validation.status).toBe("ok");
        expect(report.capabilityResults).toEqual(expect.arrayContaining([
          expect.objectContaining({
            capability: "text",
            model: "gpt-4o",
            status: "failed",
            errorCode: "PROVIDER_MODEL_UNAVAILABLE",
            httpStatus: 404,
          }),
        ]));
        expect(updated?.config.runtimeCapabilities).toEqual(expect.arrayContaining([
          expect.objectContaining({
            capability: "text",
            model: "gpt-4o",
            status: "failed",
            verified: false,
          }),
        ]));
      } finally {
        delete process.env.OPENAI_API_KEY;
      }
    });
  });
});
