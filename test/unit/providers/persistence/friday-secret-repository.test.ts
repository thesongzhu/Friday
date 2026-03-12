import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridaySecretRepository } from "#providers";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

describe("FridaySecretRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2026-02-17T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridaySecretRepository();
  }

  it("upsert and getByRef roundtrip", () => {
    const repo = createRepo();
    db.withWriteTransaction((d) =>
      repo.upsert(d, {
        id: "secret-001",
        scope: "provider",
        refKey: "provider:prov-001:apiKey",
        encryptedValue: '{"ciphertext":"abc","iv":"def","tag":"ghi"}',
        keyId: "master-v1",
        nowIso: NOW,
      }),
    );

    const retrieved = db.withReadConnection((d) =>
      repo.getByRef(d, "provider", "provider:prov-001:apiKey"),
    );
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe("secret-001");
    expect(retrieved!.scope).toBe("provider");
    expect(retrieved!.refKey).toBe("provider:prov-001:apiKey");
    expect(retrieved!.encryptedValue).toBe(
      '{"ciphertext":"abc","iv":"def","tag":"ghi"}',
    );
    expect(retrieved!.keyId).toBe("master-v1");
    expect(retrieved!.createdAt).toBe(NOW);
    expect(retrieved!.updatedAt).toBe(NOW);
  });

  it("returns null for non-existent ref", () => {
    const repo = createRepo();
    const result = db.withReadConnection((d) =>
      repo.getByRef(d, "provider", "non-existent"),
    );
    expect(result).toBeNull();
  });

  it("upsert updates existing secret", () => {
    const repo = createRepo();
    db.withWriteTransaction((d) =>
      repo.upsert(d, {
        id: "secret-001",
        scope: "provider",
        refKey: "provider:prov-001:apiKey",
        encryptedValue: '{"ciphertext":"old"}',
        keyId: "master-v1",
        nowIso: NOW,
      }),
    );

    const later = "2026-02-17T12:00:00.000Z";
    db.withWriteTransaction((d) =>
      repo.upsert(d, {
        id: "secret-002", // different id but same scope+ref
        scope: "provider",
        refKey: "provider:prov-001:apiKey",
        encryptedValue: '{"ciphertext":"new"}',
        keyId: "master-v2",
        nowIso: later,
      }),
    );

    const retrieved = db.withReadConnection((d) =>
      repo.getByRef(d, "provider", "provider:prov-001:apiKey"),
    );
    expect(retrieved).not.toBeNull();
    // Updated values
    expect(retrieved!.encryptedValue).toBe('{"ciphertext":"new"}');
    expect(retrieved!.keyId).toBe("master-v2");
    expect(retrieved!.updatedAt).toBe(later);
    expect(retrieved!.rotatedAt).toBe(later);
    // Original id preserved
    expect(retrieved!.id).toBe("secret-001");
  });

  it("deleteByRef removes the secret", () => {
    const repo = createRepo();
    db.withWriteTransaction((d) =>
      repo.upsert(d, {
        id: "secret-001",
        scope: "provider",
        refKey: "provider:prov-001:apiKey",
        encryptedValue: "encrypted",
        keyId: "master-v1",
        nowIso: NOW,
      }),
    );

    const deleted = db.withWriteTransaction((d) =>
      repo.deleteByRef(d, "provider", "provider:prov-001:apiKey"),
    );
    expect(deleted).toBe(true);

    const result = db.withReadConnection((d) =>
      repo.getByRef(d, "provider", "provider:prov-001:apiKey"),
    );
    expect(result).toBeNull();
  });

  it("deleteByRef returns false for non-existent", () => {
    const repo = createRepo();
    const deleted = db.withWriteTransaction((d) =>
      repo.deleteByRef(d, "provider", "non-existent"),
    );
    expect(deleted).toBe(false);
  });

  it("getById and updateById roundtrip", () => {
    const repo = createRepo();
    db.withWriteTransaction((d) =>
      repo.upsert(d, {
        id: "secret-001",
        scope: "provider",
        refKey: "provider:prov-001:apiKey",
        encryptedValue: '{"ciphertext":"old"}',
        keyId: "master-v1",
        nowIso: NOW,
      }),
    );

    const updated = db.withWriteTransaction((d) =>
      repo.updateById(d, {
        secretId: "secret-001", // pragma: allowlist secret
        refKey: "provider:prov-001:rotated",
        encryptedValue: '{"ciphertext":"new"}',
        keyId: "master-v2",
        expiresAt: "2026-03-01T00:00:00.000Z",
        nowIso: "2026-02-18T00:00:00.000Z",
      }),
    );
    expect(updated).not.toBeNull();
    expect(updated!.refKey).toBe("provider:prov-001:rotated");
    expect(updated!.keyId).toBe("master-v2");
    expect(updated!.expiresAt).toBe("2026-03-01T00:00:00.000Z");

    const byId = db.withReadConnection((d) => repo.getById(d, "secret-001"));
    expect(byId?.refKey).toBe("provider:prov-001:rotated");
  });

  it("list returns secrets ordered by updatedAt descending", () => {
    const repo = createRepo();
    db.withWriteTransaction((d) => {
      repo.upsert(d, {
        id: "secret-001",
        scope: "provider",
        refKey: "provider:openai:key",
        encryptedValue: "one",
        keyId: "master-v1",
        nowIso: NOW,
      });
      repo.upsert(d, {
        id: "secret-002",
        scope: "provider",
        refKey: "provider:anthropic:key",
        encryptedValue: "two",
        keyId: "master-v1",
        nowIso: "2026-02-17T11:00:00.000Z",
      });
    });

    const listed = db.withReadConnection((d) =>
      repo.list(d, { scope: "provider", limit: 10 }),
    );
    expect(listed.map((item) => item.id)).toEqual(["secret-002", "secret-001"]);
  });

  it("deleteById removes the secret", () => {
    const repo = createRepo();
    db.withWriteTransaction((d) =>
      repo.upsert(d, {
        id: "secret-001",
        scope: "provider",
        refKey: "provider:prov-001:apiKey",
        encryptedValue: "encrypted",
        keyId: "master-v1",
        nowIso: NOW,
      }),
    );

    const deleted = db.withWriteTransaction((d) => repo.deleteById(d, "secret-001"));
    expect(deleted).toBe(true);
    expect(db.withReadConnection((d) => repo.getById(d, "secret-001"))).toBeNull();
  });

  it("different scopes are independent", () => {
    const repo = createRepo();
    db.withWriteTransaction((d) => {
      repo.upsert(d, {
        id: "s1",
        scope: "provider",
        refKey: "shared-key",
        encryptedValue: "from-provider",
        keyId: "k1",
        nowIso: NOW,
      });
      repo.upsert(d, {
        id: "s2",
        scope: "other",
        refKey: "shared-key",
        encryptedValue: "from-other",
        keyId: "k1",
        nowIso: NOW,
      });
    });

    const p = db.withReadConnection((d) =>
      repo.getByRef(d, "provider", "shared-key"),
    );
    const o = db.withReadConnection((d) =>
      repo.getByRef(d, "other", "shared-key"),
    );
    expect(p!.encryptedValue).toBe("from-provider");
    expect(o!.encryptedValue).toBe("from-other");
  });
});
