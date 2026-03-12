import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayPluginRepository } from "#plugins";
import type { FridayPluginRepository, FridayPluginManifest, FridayUpsertPluginInput } from "#plugins";
import { FridayDomainError } from "#errors";

function makeManifest(overrides?: Partial<FridayPluginManifest>): FridayPluginManifest {
  return {
    schemaVersion: "1.0",
    id: "friday.test.plugin",
    version: "1.0.0",
    name: "Test Plugin",
    description: "A test plugin",
    kinds: ["skill"],
    entrypoints: { skill: "./dist/skill.js" },
    permissions: { grants: [], promptOn: [] },
    compatibility: { minHubVersion: "0.1.0", apiVersion: "1" },
    ...overrides,
  };
}

function makeInput(overrides?: Partial<FridayUpsertPluginInput>): FridayUpsertPluginInput {
  const manifest = makeManifest(overrides?.manifest ? overrides.manifest : undefined);
  return {
    id: "friday.test.plugin",
    name: "Test Plugin",
    description: "A test plugin",
    version: "1.0.0",
    source: "local",
    status: "installed",
    enabled: false,
    trustMode: "trust_on_install",
    installPath: "/plugins/test",
    kinds: ["skill"],
    manifest,
    nowIso: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("FridayPluginRepository", () => {
  let db: FridaySqliteLayer;
  let repo: FridayPluginRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayPluginRepository();
  });

  afterEach(() => {
    db.close();
  });

  // ─── Upsert + Get ───

  it("inserts and retrieves a plugin", () => {
    const entity = db.withWriteTransaction((d) => repo.upsertPlugin(d, makeInput()));
    expect(entity.id).toBe("friday.test.plugin");
    expect(entity.version).toBe("1.0.0");
    expect(entity.source).toBe("local");
    expect(entity.status).toBe("installed");
    expect(entity.enabled).toBe(false);
    expect(entity.trustMode).toBe("trust_on_install");
    expect(entity.kinds).toEqual(["skill"]);
    expect(entity.manifest.id).toBe("friday.test.plugin");
    expect(entity.config).toEqual({});
  });

  it("upsert updates existing plugin", () => {
    db.withWriteTransaction((d) => repo.upsertPlugin(d, makeInput()));
    const updated = db.withWriteTransaction((d) =>
      repo.upsertPlugin(d, makeInput({ version: "2.0.0", nowIso: "2026-02-01T00:00:00.000Z" })),
    );
    expect(updated.version).toBe("2.0.0");
  });

  it("getById returns null for missing plugin", () => {
    const result = db.withReadConnection((d) => repo.getById(d, "nonexistent"));
    expect(result).toBeNull();
  });

  // ─── List ───

  it("lists all plugins", () => {
    db.withWriteTransaction((d) => {
      repo.upsertPlugin(d, makeInput({ id: "friday.test.alpha" }));
      repo.upsertPlugin(d, makeInput({ id: "friday.test.beta" }));
    });
    const plugins = db.withReadConnection((d) => repo.list(d));
    expect(plugins).toHaveLength(2);
    expect(plugins[0].id).toBe("friday.test.alpha");
    expect(plugins[1].id).toBe("friday.test.beta");
  });

  it("filters by source", () => {
    db.withWriteTransaction((d) => {
      repo.upsertPlugin(d, makeInput({ id: "friday.test.local", source: "local" }));
      repo.upsertPlugin(d, makeInput({ id: "friday.test.bundled", source: "bundled" }));
    });
    const local = db.withReadConnection((d) => repo.list(d, { source: "local" }));
    expect(local).toHaveLength(1);
    expect(local[0].source).toBe("local");
  });

  it("filters by status", () => {
    db.withWriteTransaction((d) => {
      repo.upsertPlugin(d, makeInput({ id: "friday.test.installed", status: "installed" }));
      repo.upsertPlugin(d, makeInput({ id: "friday.test.enabled", status: "enabled" }));
    });
    const enabled = db.withReadConnection((d) => repo.list(d, { status: "enabled" }));
    expect(enabled).toHaveLength(1);
    expect(enabled[0].id).toBe("friday.test.enabled");
  });

  it("filters by kind", () => {
    db.withWriteTransaction((d) => {
      repo.upsertPlugin(d, makeInput({ id: "friday.test.skill", kinds: ["skill"] }));
      repo.upsertPlugin(d, makeInput({ id: "friday.test.channel", kinds: ["channel"], manifest: makeManifest({ id: "friday.test.channel", kinds: ["channel"], entrypoints: { channel: "./dist/channel.js" } }) }));
    });
    const channels = db.withReadConnection((d) => repo.list(d, { kind: "channel" }));
    expect(channels).toHaveLength(1);
    expect(channels[0].id).toBe("friday.test.channel");
  });

  it("filters by enabled", () => {
    db.withWriteTransaction((d) => {
      repo.upsertPlugin(d, makeInput({ id: "friday.test.on", enabled: true }));
      repo.upsertPlugin(d, makeInput({ id: "friday.test.off", enabled: false }));
    });
    const enabledPlugins = db.withReadConnection((d) => repo.list(d, { enabled: true }));
    expect(enabledPlugins).toHaveLength(1);
    expect(enabledPlugins[0].id).toBe("friday.test.on");
  });

  // ─── setStatus ───

  it("updates plugin status", () => {
    db.withWriteTransaction((d) => repo.upsertPlugin(d, makeInput()));
    db.withWriteTransaction((d) => repo.setStatus(d, "friday.test.plugin", "configured", "2026-01-02T00:00:00.000Z"));
    const entity = db.withReadConnection((d) => repo.getById(d, "friday.test.plugin"));
    expect(entity!.status).toBe("configured");
  });

  it("setStatus throws for missing plugin", () => {
    expect(() =>
      db.withWriteTransaction((d) => repo.setStatus(d, "nonexistent", "enabled", "2026-01-01T00:00:00.000Z")),
    ).toThrow(FridayDomainError);
  });

  // ─── setEnabled ───

  it("updates plugin enabled flag", () => {
    db.withWriteTransaction((d) => repo.upsertPlugin(d, makeInput()));
    db.withWriteTransaction((d) => repo.setEnabled(d, "friday.test.plugin", true, "2026-01-02T00:00:00.000Z"));
    const entity = db.withReadConnection((d) => repo.getById(d, "friday.test.plugin"));
    expect(entity!.enabled).toBe(true);
  });

  it("setEnabled throws for missing plugin", () => {
    expect(() =>
      db.withWriteTransaction((d) => repo.setEnabled(d, "nonexistent", true, "2026-01-01T00:00:00.000Z")),
    ).toThrow(FridayDomainError);
  });

  // ─── setError ───

  it("records error on plugin", () => {
    db.withWriteTransaction((d) => repo.upsertPlugin(d, makeInput()));
    db.withWriteTransaction((d) => repo.setError(d, "friday.test.plugin", "PLUGIN_LOAD_FAILED", "kaboom", "2026-01-02T00:00:00.000Z"));
    const entity = db.withReadConnection((d) => repo.getById(d, "friday.test.plugin"));
    expect(entity!.status).toBe("error");
    expect(entity!.lastErrorCode).toBe("PLUGIN_LOAD_FAILED");
    expect(entity!.lastErrorMessage).toBe("kaboom");
  });

  // ─── delete ───

  it("deletes a plugin", () => {
    db.withWriteTransaction((d) => repo.upsertPlugin(d, makeInput()));
    db.withWriteTransaction((d) => repo.deletePlugin(d, "friday.test.plugin"));
    const entity = db.withReadConnection((d) => repo.getById(d, "friday.test.plugin"));
    expect(entity).toBeNull();
  });

  it("deletePlugin throws for missing plugin", () => {
    expect(() =>
      db.withWriteTransaction((d) => repo.deletePlugin(d, "nonexistent")),
    ).toThrow(FridayDomainError);
  });

  // ─── Signature fields ───

  it("stores and retrieves signature fields", () => {
    const entity = db.withWriteTransaction((d) =>
      repo.upsertPlugin(d, makeInput({
        signatureAlgorithm: "ed25519",
        signatureKeyId: "key-001",
        signatureValue: "c2lnbmF0dXJl",
        signatureVerified: true,
        trustedFingerprintSha256: "abc123",
        lastVerifiedAt: "2026-01-01T12:00:00.000Z",
      })),
    );
    expect(entity.signatureAlgorithm).toBe("ed25519");
    expect(entity.signatureKeyId).toBe("key-001");
    expect(entity.signatureValue).toBe("c2lnbmF0dXJl");
    expect(entity.signatureVerified).toBe(true);
    expect(entity.trustedFingerprintSha256).toBe("abc123");
    expect(entity.lastVerifiedAt).toBe("2026-01-01T12:00:00.000Z");
  });
});
