import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayMarketplaceSourceRepository } from "#skills";
import { createFridayMarketplaceCacheRepository } from "#skills";
import { createFridaySkillRepository } from "#skills";
import { createFridaySkillVersionRepository } from "#skills";
import { createFridayMarketplaceSyncService } from "#skills";
import { createFridaySkillSignatureVerifier } from "#skills";
import { createFridaySkillTrustScoringService } from "#skills";
import type { FridayMarketplaceHttpClient } from "#skills";
import type { FridayMarketplaceIndexDocument } from "#skills";
import { createTestDb, createTestIdGenerator, NOW } from "./marketplace.helper.js";

describe("FridayMarketplaceSyncService", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
  });

  afterEach(() => {
    db.close();
  });

  function makeIndexDoc(skills: FridayMarketplaceIndexDocument["skills"]): FridayMarketplaceIndexDocument {
    return { generatedAt: NOW, skills };
  }

  function createMockHttpClient(indexDoc: FridayMarketplaceIndexDocument): FridayMarketplaceHttpClient {
    return {
      async fetchIndex() { return indexDoc; },
      async fetchManifest() { return {}; },
      async fetchSignature() { return { skillId: "", version: "", keyId: "", algorithm: "ed25519" as const, value: "" }; },
      async fetchPublisherKey() { return { keyId: "", algorithm: "ed25519" as const }; },
      async fetchPackage() { return Buffer.alloc(0); },
    };
  }

  function createFailingHttpClient(): FridayMarketplaceHttpClient {
    return {
      async fetchIndex() { throw new Error("Network error"); },
      async fetchManifest() { throw new Error("Network error"); },
      async fetchSignature() { throw new Error("Network error"); },
      async fetchPublisherKey() { throw new Error("Network error"); },
      async fetchPackage() { throw new Error("Network error"); },
    };
  }

  it("syncs enabled sources successfully", async () => {
    const sourceRepo = createFridayMarketplaceSourceRepository();
    db.withWriteTransaction((conn) => {
      sourceRepo.insertSource(conn, "src-1", { name: "Test", baseUrl: "https://test.dev", trustPolicy: "warn", pinnedKeyIds: [] }, NOW);
    });

    const indexDoc = makeIndexDoc([
      {
        id: "weather-skill",
        name: "Weather",
        publisher: "Friday Labs",
        latestVersion: "1.2.0",
        versions: [
          { version: "1.0.0", checksum: "aaa", releasedAt: "2025-01-01T00:00:00.000Z", manifestUrl: "/m", packageUrl: "/p", signatureUrl: "/s" },
          { version: "1.2.0", checksum: "bbb", releasedAt: "2025-06-01T00:00:00.000Z", manifestUrl: "/m", packageUrl: "/p", signatureUrl: "/s" },
        ],
      },
    ]);

    const service = createFridayMarketplaceSyncService({
      db,
      sourceRepo,
      cacheRepo: createFridayMarketplaceCacheRepository(),
      skillRepo: createFridaySkillRepository(),
      versionRepo: createFridaySkillVersionRepository(),
      httpClient: createMockHttpClient(indexDoc),
      trustScoring: createFridaySkillTrustScoringService(),
      signatureVerifier: createFridaySkillSignatureVerifier(),
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    const results = await service.syncAllSources();
    expect(results).toHaveLength(1);
    expect(results[0].skillsSynced).toBe(1);
    expect(results[0].versionsSynced).toBe(2);
    expect(results[0].errors).toHaveLength(0);

    // Verify skill was inserted
    const skill = db.withReadConnection((conn) =>
      createFridaySkillRepository().getSkillById(conn, "weather-skill"),
    );
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("Weather");
    expect(skill!.latestVersion).toBe("1.2.0");
  });

  it("handles partial source failure gracefully", async () => {
    const sourceRepo = createFridayMarketplaceSourceRepository();
    db.withWriteTransaction((conn) => {
      sourceRepo.insertSource(conn, "src-fail", { name: "Failing", baseUrl: "https://fail.dev", trustPolicy: "warn", pinnedKeyIds: [] }, NOW);
    });

    const service = createFridayMarketplaceSyncService({
      db,
      sourceRepo,
      cacheRepo: createFridayMarketplaceCacheRepository(),
      skillRepo: createFridaySkillRepository(),
      versionRepo: createFridaySkillVersionRepository(),
      httpClient: createFailingHttpClient(),
      trustScoring: createFridaySkillTrustScoringService(),
      signatureVerifier: createFridaySkillSignatureVerifier(),
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    const results = await service.syncAllSources();
    expect(results).toHaveLength(1);
    expect(results[0].errors.length).toBeGreaterThan(0);
    expect(results[0].errors[0]).toContain("Network error");
  });

  it("skips disabled sources", async () => {
    const sourceRepo = createFridayMarketplaceSourceRepository();
    db.withWriteTransaction((conn) => {
      sourceRepo.insertSource(conn, "src-disabled", { name: "Disabled", baseUrl: "https://d.dev", trustPolicy: "warn", pinnedKeyIds: [] }, NOW);
      sourceRepo.setEnabled(conn, "src-disabled", false, NOW);
    });

    const service = createFridayMarketplaceSyncService({
      db,
      sourceRepo,
      cacheRepo: createFridayMarketplaceCacheRepository(),
      skillRepo: createFridaySkillRepository(),
      versionRepo: createFridaySkillVersionRepository(),
      httpClient: createFailingHttpClient(), // Would fail if called
      trustScoring: createFridaySkillTrustScoringService(),
      signatureVerifier: createFridaySkillSignatureVerifier(),
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    const results = await service.syncAllSources();
    expect(results).toHaveLength(0); // Disabled sources not attempted
  });

  it("syncs single source by ID", async () => {
    const sourceRepo = createFridayMarketplaceSourceRepository();
    db.withWriteTransaction((conn) => {
      sourceRepo.insertSource(conn, "src-1", { name: "Test", baseUrl: "https://test.dev", trustPolicy: "permissive", pinnedKeyIds: [] }, NOW);
    });

    const indexDoc = makeIndexDoc([
      { id: "s1", name: "Skill 1", latestVersion: "1.0.0", versions: [{ version: "1.0.0", checksum: "x", releasedAt: NOW, manifestUrl: "/m", packageUrl: "/p", signatureUrl: "/s" }] },
    ]);

    const service = createFridayMarketplaceSyncService({
      db,
      sourceRepo,
      cacheRepo: createFridayMarketplaceCacheRepository(),
      skillRepo: createFridaySkillRepository(),
      versionRepo: createFridaySkillVersionRepository(),
      httpClient: createMockHttpClient(indexDoc),
      trustScoring: createFridaySkillTrustScoringService(),
      signatureVerifier: createFridaySkillSignatureVerifier(),
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    const result = await service.syncSource("src-1");
    expect(result.skillsSynced).toBe(1);
    expect(result.sourceName).toBe("Test");
  });

  it("throws for non-existent source", async () => {
    const service = createFridayMarketplaceSyncService({
      db,
      sourceRepo: createFridayMarketplaceSourceRepository(),
      cacheRepo: createFridayMarketplaceCacheRepository(),
      skillRepo: createFridaySkillRepository(),
      versionRepo: createFridaySkillVersionRepository(),
      httpClient: createFailingHttpClient(),
      trustScoring: createFridaySkillTrustScoringService(),
      signatureVerifier: createFridaySkillSignatureVerifier(),
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    await expect(service.syncSource("nonexistent")).rejects.toThrow("not found");
  });
});
