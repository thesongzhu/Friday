import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFridayAuthProfileRepository } from "#providers";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";

describe("FridayAuthProfileRepository", () => {
  let db: FridaySqliteLayer;
  const repo = createFridayAuthProfileRepository();

  beforeEach(() => {
    db = createTestDb();
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO provider_profiles
           (id, kind, display_name, endpoint_url, enabled, default_model, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "provider-1",
        "anthropic",
        "Claude",
        "https://api.anthropic.com",
        1,
        "claude-sonnet-4-20250514",
        JSON.stringify({
          api: "anthropic-messages",
          authMode: "token",
          keySource: { kind: "secret-ref", refKey: "provider:provider-1:apiKey" },
          supportedModels: ["claude-sonnet-4-20250514"],
        }),
        "2026-03-31T00:00:00.000Z",
        "2026-03-31T00:00:00.000Z",
      );
    });
  });

  afterEach(() => {
    db.close();
  });

  it("upserts and reads the active auth profile", () => {
    db.withWriteTransaction((conn) => {
      repo.upsert(conn, {
        id: "auth-1",
        providerProfileId: "provider-1",
        providerKind: "anthropic",
        profileKey: "default",
        label: "Claude Default",
        authMode: "token",
        keySource: { kind: "secret-ref", refKey: "provider:provider-1:apiKey" },
        oauthProvider: undefined,
        isActive: true,
        metadata: { source: "test" },
        createdAt: "2026-03-31T00:00:00.000Z",
        updatedAt: "2026-03-31T00:00:00.000Z",
      });
    });

    const active = db.withReadConnection((conn) =>
      repo.getActiveByProviderProfileId(conn, "provider-1"),
    );

    expect(active).toMatchObject({
      id: "auth-1",
      providerProfileId: "provider-1",
      profileKey: "default",
      authMode: "token",
      isActive: true,
      metadata: { source: "test" },
    });
  });

  it("updates the same profile key in place", () => {
    db.withWriteTransaction((conn) => {
      repo.upsert(conn, {
        id: "auth-1",
        providerProfileId: "provider-1",
        providerKind: "anthropic",
        profileKey: "default",
        label: "Claude Default",
        authMode: "oauth",
        keySource: { kind: "none" },
        oauthProvider: "anthropic",
        isActive: true,
        metadata: { source: "oauth" },
        createdAt: "2026-03-31T00:00:00.000Z",
        updatedAt: "2026-03-31T00:00:00.000Z",
      });
      repo.upsert(conn, {
        id: "auth-2",
        providerProfileId: "provider-1",
        providerKind: "anthropic",
        profileKey: "default",
        label: "Claude Default",
        authMode: "token",
        keySource: { kind: "secret-ref", refKey: "provider:provider-1:apiKey" },
        oauthProvider: undefined,
        isActive: true,
        metadata: { source: "token" },
        createdAt: "2026-03-31T00:00:00.000Z",
        updatedAt: "2026-03-31T01:00:00.000Z",
      });
    });

    const profiles = db.withReadConnection((conn) =>
      repo.listByProviderProfileId(conn, "provider-1"),
    );

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      id: "auth-1",
      authMode: "token",
      metadata: { source: "token" },
    });
  });

  it("deletes all auth profiles for a provider", () => {
    db.withWriteTransaction((conn) => {
      repo.upsert(conn, {
        id: "auth-1",
        providerProfileId: "provider-1",
        providerKind: "anthropic",
        profileKey: "default",
        label: "Claude Default",
        authMode: "token",
        keySource: { kind: "secret-ref", refKey: "provider:provider-1:apiKey" },
        oauthProvider: undefined,
        isActive: true,
        metadata: {},
        createdAt: "2026-03-31T00:00:00.000Z",
        updatedAt: "2026-03-31T00:00:00.000Z",
      });
    });

    const deleted = db.withWriteTransaction((conn) =>
      repo.deleteByProviderProfileId(conn, "provider-1"),
    );

    expect(deleted).toBe(1);
    expect(
      db.withReadConnection((conn) => repo.listByProviderProfileId(conn, "provider-1")),
    ).toHaveLength(0);
  });
});
