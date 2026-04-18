import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import type { FridayProviderProfile } from "#providers";
import { createFridayProviderProfileRepository } from "#providers";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

describe("FridayProviderProfileRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2026-02-17T10:00:00.000Z";

  const sampleProfile: FridayProviderProfile = {
    id: "prov-001",
    kind: "openai",
    name: "OpenAI Production",
    baseUrl: "https://api.openai.com",
    enabled: true,
    defaultModel: "gpt-4o",
    config: {
      api: "openai-completions",
      authMode: "api-key",
      keySource: { kind: "env-ref", envVar: "OPENAI_API_KEY" },
      supportedModels: ["gpt-4o", "gpt-4o-mini"],
      headers: { "X-Custom": "value" },
      validation: { status: "never" },
    },
    createdAt: NOW,
    updatedAt: NOW,
  };

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayProviderProfileRepository();
  }

  it("insert and getById roundtrip", () => {
    const repo = createRepo();
    db.withWriteTransaction((d) => repo.insert(d, sampleProfile));

    const retrieved = db.withReadConnection((d) =>
      repo.getById(d, "prov-001"),
    );
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe("prov-001");
    expect(retrieved!.kind).toBe("openai");
    expect(retrieved!.name).toBe("OpenAI Production");
    expect(retrieved!.baseUrl).toBe("https://api.openai.com");
    expect(retrieved!.enabled).toBe(true);
    expect(retrieved!.defaultModel).toBe("gpt-4o");
    expect(retrieved!.config.api).toBe("openai-completions");
    expect(retrieved!.config.keySource).toEqual({
      kind: "env-ref",
      envVar: "OPENAI_API_KEY",
    });
    expect(retrieved!.config.supportedModels).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(retrieved!.config.headers).toEqual({ "X-Custom": "value" });
  });

  it("returns null for non-existent provider", () => {
    const repo = createRepo();
    const result = db.withReadConnection((d) =>
      repo.getById(d, "non-existent"),
    );
    expect(result).toBeNull();
  });

  it("list returns all providers ordered by created_at", () => {
    const repo = createRepo();
    const second: FridayProviderProfile = {
      ...sampleProfile,
      id: "prov-002",
      kind: "anthropic",
      name: "Anthropic",
      createdAt: "2026-02-17T11:00:00.000Z",
      updatedAt: "2026-02-17T11:00:00.000Z",
    };

    db.withWriteTransaction((d) => {
      repo.insert(d, sampleProfile);
      repo.insert(d, second);
    });

    const all = db.withReadConnection((d) => repo.list(d));
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe("prov-001");
    expect(all[1].id).toBe("prov-002");
  });

  it("update modifies existing profile", () => {
    const repo = createRepo();
    db.withWriteTransaction((d) => repo.insert(d, sampleProfile));

    const updated: FridayProviderProfile = {
      ...sampleProfile,
      name: "OpenAI Updated",
      enabled: false,
      updatedAt: "2026-02-17T12:00:00.000Z",
    };

    db.withWriteTransaction((d) => repo.update(d, updated));

    const retrieved = db.withReadConnection((d) =>
      repo.getById(d, "prov-001"),
    );
    expect(retrieved!.name).toBe("OpenAI Updated");
    expect(retrieved!.enabled).toBe(false);
    expect(retrieved!.updatedAt).toBe("2026-02-17T12:00:00.000Z");
  });

  it("deleteById removes the profile", () => {
    const repo = createRepo();
    db.withWriteTransaction((d) => repo.insert(d, sampleProfile));

    const deleted = db.withWriteTransaction((d) =>
      repo.deleteById(d, "prov-001"),
    );
    expect(deleted).toBe(true);

    const result = db.withReadConnection((d) =>
      repo.getById(d, "prov-001"),
    );
    expect(result).toBeNull();
  });

  it("deleteById returns false for non-existent", () => {
    const repo = createRepo();
    const deleted = db.withWriteTransaction((d) =>
      repo.deleteById(d, "non-existent"),
    );
    expect(deleted).toBe(false);
  });

  it("handles profile with no endpoint_url", () => {
    const repo = createRepo();
    const noUrl: FridayProviderProfile = {
      ...sampleProfile,
      id: "prov-local",
      kind: "ollama",
      baseUrl: "",
      config: {
        ...sampleProfile.config,
        authMode: "none",
        keySource: { kind: "none" },
      },
    };
    db.withWriteTransaction((d) => repo.insert(d, noUrl));

    const retrieved = db.withReadConnection((d) =>
      repo.getById(d, "prov-local"),
    );
    expect(retrieved!.baseUrl).toBe("");
  });

  it("handles profile with secret-ref keySource", () => {
    const repo = createRepo();
    const withSecret: FridayProviderProfile = {
      ...sampleProfile,
      id: "prov-secret",
      config: {
        ...sampleProfile.config,
        keySource: { kind: "secret-ref", refKey: "provider:prov-secret:apiKey" },
      },
    };
    db.withWriteTransaction((d) => repo.insert(d, withSecret));

    const retrieved = db.withReadConnection((d) =>
      repo.getById(d, "prov-secret"),
    );
    expect(retrieved!.config.keySource).toEqual({
      kind: "secret-ref",
      refKey: "provider:prov-secret:apiKey",
    });
  });

  it("stores autonomy upgrade metadata", () => {
    const repo = createRepo();
    db.withWriteTransaction((d) => repo.insert(d, sampleProfile));

    const updated = db.withWriteTransaction((d) =>
      repo.setUpgradeMetadata(
        d,
        "prov-001",
        {
          lastVerifiedAt: "2026-04-17T20:00:00.000Z",
          lastVerifiedRuntimeVersion: "f27377c",
          lastVerifiedProviderModel: "claude-sonnet-4-20250514",
          compatibilityStatus: "compatible",
          promotionChannel: "active",
          shadowVersionId: "prov-001-shadow",
          canaryStats: {
            sampleSize: 8,
            successCount: 8,
            failureCount: 0,
            rollbackCount: 0,
            lastEvaluatedAt: "2026-04-17T20:02:00.000Z",
          },
        },
        "2026-04-17T20:02:00.000Z",
      ),
    );

    expect(updated).not.toBeNull();
    expect(updated!.lastVerifiedRuntimeVersion).toBe("f27377c");
    expect(updated!.lastVerifiedProviderModel).toBe("claude-sonnet-4-20250514");
    expect(updated!.compatibilityStatus).toBe("compatible");
    expect(updated!.promotionChannel).toBe("active");
    expect(updated!.shadowVersionId).toBe("prov-001-shadow");
    expect(updated!.canaryStats?.sampleSize).toBe(8);
  });
});
