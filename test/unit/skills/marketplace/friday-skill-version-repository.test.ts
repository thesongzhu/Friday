import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridaySkillVersionRepository } from "#skills";
import { createTestDb, NOW, createTestManifest } from "./marketplace.helper.js";

describe("FridaySkillVersionRepository", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
    // Insert a skill for FK
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO skills (id, name, source, origin, status, created_at, updated_at)
         VALUES ('skill-1', 'Test Skill', 'marketplace', 'managed', 'not_installed', ?, ?)`,
      ).run(NOW, NOW);
    });
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridaySkillVersionRepository();
  }

  it("upserts and retrieves a version", () => {
    const repo = createRepo();
    const manifest = createTestManifest({ id: "skill-1", version: "1.0.0" });
    const entity = db.withWriteTransaction((conn) =>
      repo.upsertVersion(conn, {
        id: "v-1",
        skillId: "skill-1",
        version: "1.0.0",
        checksum: "abc123",
        packageUrl: "https://pkg.dev/skill-1-1.0.0.tgz",
        signature: { keyId: "key-1", algorithm: "ed25519", value: "sig-base64" },
        manifest,
        releasedAt: NOW,
        nowIso: NOW,
      }),
    );

    expect(entity.skillId).toBe("skill-1");
    expect(entity.version).toBe("1.0.0");
    expect(entity.checksum).toBe("abc123");
    expect(entity.packageUrl).toBe("https://pkg.dev/skill-1-1.0.0.tgz");
    expect(entity.signature).toEqual({ keyId: "key-1", algorithm: "ed25519", value: "sig-base64" });
    expect(entity.manifest.id).toBe("skill-1");
  });

  it("upsert updates on conflict", () => {
    const repo = createRepo();
    const manifest = createTestManifest({ id: "skill-1", version: "1.0.0" });
    db.withWriteTransaction((conn) => {
      repo.upsertVersion(conn, { id: "v-1", skillId: "skill-1", version: "1.0.0", checksum: "old", manifest, releasedAt: NOW, nowIso: NOW });
      repo.upsertVersion(conn, { id: "v-2", skillId: "skill-1", version: "1.0.0", checksum: "new", manifest, releasedAt: NOW, nowIso: NOW });
    });

    const fetched = db.withReadConnection((conn) => repo.getVersion(conn, "skill-1", "1.0.0"));
    expect(fetched!.checksum).toBe("new");
  });

  it("lists versions sorted by release date", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertVersion(conn, { id: "v-1", skillId: "skill-1", version: "1.0.0", checksum: "a", manifest: createTestManifest({ version: "1.0.0" }), releasedAt: "2025-01-01T00:00:00.000Z", nowIso: NOW });
      repo.upsertVersion(conn, { id: "v-2", skillId: "skill-1", version: "2.0.0", checksum: "b", manifest: createTestManifest({ version: "2.0.0" }), releasedAt: "2025-06-01T00:00:00.000Z", nowIso: NOW });
      repo.upsertVersion(conn, { id: "v-3", skillId: "skill-1", version: "1.5.0", checksum: "c", manifest: createTestManifest({ version: "1.5.0" }), releasedAt: "2025-03-01T00:00:00.000Z", nowIso: NOW });
    });

    const versions = db.withReadConnection((conn) => repo.listVersions(conn, "skill-1"));
    expect(versions).toHaveLength(3);
    expect(versions[0].version).toBe("2.0.0");
    expect(versions[1].version).toBe("1.5.0");
    expect(versions[2].version).toBe("1.0.0");
  });

  it("marks and clears yanked status", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertVersion(conn, { id: "v-1", skillId: "skill-1", version: "1.0.0", checksum: "a", manifest: createTestManifest(), releasedAt: NOW, nowIso: NOW });
      repo.markYanked(conn, "skill-1", "1.0.0", NOW);
    });

    let fetched = db.withReadConnection((conn) => repo.getVersion(conn, "skill-1", "1.0.0"));
    expect(fetched!.yankedAt).toBe(NOW);

    db.withWriteTransaction((conn) => repo.clearYanked(conn, "skill-1", "1.0.0", NOW));
    fetched = db.withReadConnection((conn) => repo.getVersion(conn, "skill-1", "1.0.0"));
    expect(fetched!.yankedAt).toBeUndefined();
  });

  it("listVersionsForResolution excludes yanked by default", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertVersion(conn, { id: "v-1", skillId: "skill-1", version: "1.0.0", checksum: "a", manifest: createTestManifest(), releasedAt: NOW, nowIso: NOW });
      repo.upsertVersion(conn, { id: "v-2", skillId: "skill-1", version: "2.0.0", checksum: "b", manifest: createTestManifest(), releasedAt: NOW, nowIso: NOW });
      repo.markYanked(conn, "skill-1", "1.0.0", NOW);
    });

    const versions = db.withReadConnection((conn) =>
      repo.listVersionsForResolution(conn, "skill-1"),
    );
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe("2.0.0");

    // Including yanked
    const allVersions = db.withReadConnection((conn) =>
      repo.listVersionsForResolution(conn, "skill-1", true),
    );
    expect(allVersions).toHaveLength(2);
  });

  it("sets signature fields", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertVersion(conn, { id: "v-1", skillId: "skill-1", version: "1.0.0", checksum: "a", manifest: createTestManifest(), releasedAt: NOW, nowIso: NOW });
    });

    // Initially no signature
    let fetched = db.withReadConnection((conn) => repo.getVersion(conn, "skill-1", "1.0.0"));
    expect(fetched!.signature).toBeUndefined();

    db.withWriteTransaction((conn) =>
      repo.setSignatureFields(conn, "skill-1", "1.0.0", { keyId: "k1", algorithm: "rsa-sha256", value: "sig" }, NOW),
    );

    fetched = db.withReadConnection((conn) => repo.getVersion(conn, "skill-1", "1.0.0"));
    expect(fetched!.signature).toEqual({ keyId: "k1", algorithm: "rsa-sha256", value: "sig" });
  });

  it("returns null for non-existent version", () => {
    const repo = createRepo();
    const result = db.withReadConnection((conn) => repo.getVersion(conn, "skill-1", "9.9.9"));
    expect(result).toBeNull();
  });
});
