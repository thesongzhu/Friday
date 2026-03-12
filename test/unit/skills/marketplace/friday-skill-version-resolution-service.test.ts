import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridaySkillVersionRepository } from "#skills";
import { createFridaySkillInstallationRepository } from "#skills";
import { createFridayMarketplaceCacheRepository } from "#skills";
import { createFridaySkillVersionResolutionService } from "#skills";
import { createTestDb, NOW, createTestManifest } from "./marketplace.helper.js";

describe("FridaySkillVersionResolutionService", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
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

  function setupVersions() {
    const versionRepo = createFridaySkillVersionRepository();
    db.withWriteTransaction((conn) => {
      versionRepo.upsertVersion(conn, { id: "v-1", skillId: "skill-1", version: "1.0.0", checksum: "aaa", packageUrl: "https://pkg/1.0.0.tgz", manifest: createTestManifest({ version: "1.0.0" }), releasedAt: "2025-01-01T00:00:00.000Z", nowIso: NOW });
      versionRepo.upsertVersion(conn, { id: "v-2", skillId: "skill-1", version: "1.5.0", checksum: "bbb", packageUrl: "https://pkg/1.5.0.tgz", manifest: createTestManifest({ version: "1.5.0" }), releasedAt: "2025-03-01T00:00:00.000Z", nowIso: NOW });
      versionRepo.upsertVersion(conn, { id: "v-3", skillId: "skill-1", version: "2.0.0", checksum: "ccc", packageUrl: "https://pkg/2.0.0.tgz", manifest: createTestManifest({ version: "2.0.0" }), releasedAt: "2025-06-01T00:00:00.000Z", nowIso: NOW });
    });
    return versionRepo;
  }

  function createService() {
    return createFridaySkillVersionResolutionService({
      db,
      versionRepo: createFridaySkillVersionRepository(),
      installationRepo: createFridaySkillInstallationRepository(),
      cacheRepo: createFridayMarketplaceCacheRepository(),
    });
  }

  it("resolves exact version for install", () => {
    setupVersions();
    const service = createService();
    const result = service.resolve({
      skillId: "skill-1",
      requestedVersion: "1.5.0",
      strategy: "install",
    });
    expect(result.version).toBe("1.5.0");
    expect(result.checksum).toBe("bbb");
    expect(result.reason).toContain("1.5.0");
  });

  it("resolves latest version when no version requested", () => {
    setupVersions();
    const service = createService();
    const result = service.resolve({
      skillId: "skill-1",
      strategy: "install",
    });
    expect(result.version).toBe("2.0.0");
  });

  it("resolves semver range", () => {
    setupVersions();
    const service = createService();
    const result = service.resolve({
      skillId: "skill-1",
      requestedVersion: "^1.0.0",
      strategy: "install",
    });
    expect(result.version).toBe("1.5.0"); // Highest matching ^1.0.0
  });

  it("upgrade selects latest version", () => {
    setupVersions();
    const service = createService();
    const result = service.resolve({
      skillId: "skill-1",
      strategy: "upgrade",
    });
    expect(result.version).toBe("2.0.0");
    expect(result.reason).toContain("Upgrade");
  });

  it("excludes yanked versions by default", () => {
    const versionRepo = setupVersions();
    db.withWriteTransaction((conn) => {
      versionRepo.markYanked(conn, "skill-1", "2.0.0", NOW);
    });

    const service = createService();
    const result = service.resolve({
      skillId: "skill-1",
      strategy: "install",
    });
    expect(result.version).toBe("1.5.0"); // 2.0.0 yanked
  });

  it("includes yanked versions when allowed", () => {
    const versionRepo = setupVersions();
    db.withWriteTransaction((conn) => {
      versionRepo.markYanked(conn, "skill-1", "2.0.0", NOW);
    });

    const service = createService();
    const result = service.resolve({
      skillId: "skill-1",
      strategy: "install",
      allowYanked: true,
    });
    expect(result.version).toBe("2.0.0");
  });

  it("throws when no matching version found", () => {
    setupVersions();
    const service = createService();
    expect(() =>
      service.resolve({
        skillId: "skill-1",
        requestedVersion: "9.9.9",
        strategy: "install",
      }),
    ).toThrow("No matching version");
  });

  it("rollback resolves previous installed version", () => {
    setupVersions();
    const installationRepo = createFridaySkillInstallationRepository();
    db.withWriteTransaction((conn) => {
      installationRepo.insertInstallation(conn, { id: "i-1", skillId: "skill-1", version: "1.0.0", status: "installed", permissionsGranted: [], nowIso: "2025-01-01T00:00:00.000Z" });
      installationRepo.insertInstallation(conn, { id: "i-2", skillId: "skill-1", version: "2.0.0", status: "installed", permissionsGranted: [], nowIso: "2025-06-01T00:00:00.000Z" });
    });

    const service = createFridaySkillVersionResolutionService({
      db,
      versionRepo: createFridaySkillVersionRepository(),
      installationRepo,
      cacheRepo: createFridayMarketplaceCacheRepository(),
    });

    const result = service.resolve({
      skillId: "skill-1",
      strategy: "rollback",
    });
    expect(result.version).toBe("1.0.0");
    expect(result.reason).toContain("Rollback");
  });

  it("rollback throws when no previous version exists", () => {
    setupVersions();
    const installationRepo = createFridaySkillInstallationRepository();
    db.withWriteTransaction((conn) => {
      installationRepo.insertInstallation(conn, { id: "i-1", skillId: "skill-1", version: "1.0.0", status: "installed", permissionsGranted: [], nowIso: NOW });
    });

    const service = createFridaySkillVersionResolutionService({
      db,
      versionRepo: createFridaySkillVersionRepository(),
      installationRepo,
      cacheRepo: createFridayMarketplaceCacheRepository(),
    });

    expect(() =>
      service.resolve({ skillId: "skill-1", strategy: "rollback" }),
    ).toThrow("No previous installed version");
  });
});
