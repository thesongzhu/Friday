import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import { createFridaySkillRepository } from "#skills";
import { createFridaySkillInstallationRepository } from "#skills";
import { createFridaySkillVersionRepository } from "#skills";
import { createFridayMarketplaceSourceRepository } from "#skills";
import { createFridayMarketplaceCacheRepository } from "#skills";
import { createFridaySkillVersionResolutionService } from "#skills";
import { createFridaySkillSignatureVerifier } from "#skills";
import { createFridaySkillTrustScoringService } from "#skills";
import { createFridaySkillPermissionCheckService } from "#skills";
import { createFridaySkillInstallationService } from "#skills";
import type { FridaySkillPackageInstaller } from "#skills";
import type { FridayMarketplaceHttpClient } from "#skills";
import { createTestDb, createTestIdGenerator, NOW, createTestManifest } from "./marketplace.helper.js";

// Generate a stable Ed25519 keypair for signed package tests
const testKeyPair = generateKeyPairSync("ed25519");
const TEST_PUB_PEM = testKeyPair.publicKey.export({ type: "spki", format: "pem" }) as string;

describe("FridaySkillInstallationService", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();

    // Set up a skill and versions
    const skillRepo = createFridaySkillRepository();
    const versionRepo = createFridaySkillVersionRepository();
    const sourceRepo = createFridayMarketplaceSourceRepository();

    const cacheRepo = createFridayMarketplaceCacheRepository();

    db.withWriteTransaction((conn) => {
      sourceRepo.insertSource(conn, "src-1", {
        name: "Test",
        baseUrl: "https://test.dev",
        trustPolicy: "permissive",
        pinnedKeyIds: [],
      }, NOW);

      skillRepo.upsertSkillFromMarketplace(conn, {
        id: "skill-1",
        name: "Test Skill",
        source: "marketplace",
        origin: "managed",
        latestVersion: "1.0.0",
        status: "not_installed",
        nowIso: NOW,
      });

      const manifest = createTestManifest({
        id: "skill-1",
        version: "1.0.0",
        permissions: { grants: [], promptOn: [] },
      });

      versionRepo.upsertVersion(conn, {
        id: "v-1",
        skillId: "skill-1",
        version: "1.0.0",
        checksum: "", // Will be computed from package bytes
        packageUrl: "https://test.dev/packages/skill-1-1.0.0.tgz",
        manifest,
        releasedAt: NOW,
        nowIso: NOW,
      });

      // Add cache entry so version resolution can find the source
      cacheRepo.upsertCacheEntry(conn, {
        id: "cache-1",
        sourceId: "src-1",
        skillId: "skill-1",
        version: "1.0.0",
        manifestJson: JSON.stringify(manifest),
        signatureValid: false,
        indexedAt: NOW,
        trustScore: 60,
        nowIso: NOW,
      });
    });
  });

  afterEach(() => {
    db.close();
  });

  function createMockPackageInstaller(): FridaySkillPackageInstaller {
    return {
      stage: vi.fn().mockReturnValue("/tmp/staging"),
      activate: vi.fn().mockReturnValue("/tmp/final"),
      remove: vi.fn(),
    };
  }

  function createMockHttpClient(packageContent: string = "test package bytes"): FridayMarketplaceHttpClient {
    const buf = Buffer.from(packageContent);
    const verifier = createFridaySkillSignatureVerifier();
    const checksum = verifier.computeChecksum(buf);
    const payload = Buffer.from(`friday-skill-signature-v1\nskill-1\n1.0.0\n${checksum}`);
    const sig = cryptoSign(null, payload, testKeyPair.privateKey);

    return {
      fetchIndex: vi.fn().mockResolvedValue({ generatedAt: NOW, skills: [] }),
      fetchManifest: vi.fn().mockResolvedValue({}),
      fetchSignature: vi.fn().mockResolvedValue({
        skillId: "skill-1",
        version: "1.0.0",
        keyId: "test-key-1",
        algorithm: "ed25519",
        value: sig.toString("base64"),
      }),
      fetchPublisherKey: vi.fn().mockResolvedValue({
        keyId: "test-key-1",
        algorithm: "ed25519",
        publicKeyPem: TEST_PUB_PEM,
      }),
      fetchPackage: vi.fn().mockResolvedValue(buf),
    };
  }

  function createService(
    httpClient?: FridayMarketplaceHttpClient,
    packageInstaller?: FridaySkillPackageInstaller,
  ) {
    const versionRepo = createFridaySkillVersionRepository();
    const installationRepo = createFridaySkillInstallationRepository();
    const cacheRepo = createFridayMarketplaceCacheRepository();

    // We need to fix the checksum to match the mock package
    const verifier = createFridaySkillSignatureVerifier();
    const mockBuf = Buffer.from("test package bytes");
    const correctChecksum = verifier.computeChecksum(mockBuf);

    // Update the version checksum in DB
    db.withWriteTransaction((conn) => {
      conn.prepare(
        "UPDATE skill_versions SET checksum = ? WHERE skill_id = 'skill-1' AND version = '1.0.0'",
      ).run(correctChecksum);
    });

    return createFridaySkillInstallationService({
      db,
      skillRepo: createFridaySkillRepository(),
      installationRepo,
      sourceRepo: createFridayMarketplaceSourceRepository(),
      versionResolver: createFridaySkillVersionResolutionService({
        db,
        versionRepo,
        installationRepo,
        cacheRepo,
      }),
      signatureVerifier: verifier,
      trustScoring: createFridaySkillTrustScoringService(),
      permissionCheck: createFridaySkillPermissionCheckService(),
      packageInstaller: packageInstaller ?? createMockPackageInstaller(),
      httpClient: httpClient ?? createMockHttpClient(),
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  }

  it("installs a skill successfully", async () => {
    const service = createService();
    const result = await service.install({
      skillId: "skill-1",
      version: "1.0.0",
      grantPermissions: [],
    });

    expect(result.resolvedVersion).toBe("1.0.0");
    expect(result.installationIds).toHaveLength(1);
    expect(result.verification.integrityValid).toBe(true);
    expect(result.trust.total).toBeGreaterThan(0);

    // Check skill is now installed
    const skill = db.withReadConnection((conn) =>
      createFridaySkillRepository().getSkillById(conn, "skill-1"),
    );
    expect(skill!.installedVersion).toBe("1.0.0");
    expect(skill!.status).toBe("installed");
  });

  it("fails when download fails", async () => {
    const failingClient: FridayMarketplaceHttpClient = {
      fetchIndex: vi.fn().mockResolvedValue({ generatedAt: NOW, skills: [] }),
      fetchManifest: vi.fn().mockResolvedValue({}),
      fetchSignature: vi.fn().mockRejectedValue(new Error("no sig")),
      fetchPublisherKey: vi.fn().mockRejectedValue(new Error("no key")),
      fetchPackage: vi.fn().mockRejectedValue(new Error("Connection refused")),
    };

    const service = createService(failingClient);
    await expect(
      service.install({ skillId: "skill-1", version: "1.0.0" }),
    ).rejects.toThrow("Download failed");
  });

  it("fails when checksum mismatches", async () => {
    // Create http client with different content than expected
    const tamperClient: FridayMarketplaceHttpClient = {
      fetchIndex: vi.fn().mockResolvedValue({ generatedAt: NOW, skills: [] }),
      fetchManifest: vi.fn().mockResolvedValue({}),
      fetchSignature: vi.fn().mockRejectedValue(new Error("no sig")),
      fetchPublisherKey: vi.fn().mockRejectedValue(new Error("no key")),
      fetchPackage: vi.fn().mockResolvedValue(Buffer.from("tampered content")),
    };

    const service = createService(tamperClient);
    await expect(
      service.install({ skillId: "skill-1", version: "1.0.0" }),
    ).rejects.toThrow("Trust policy rejected");
  });

  it("fails when required permissions missing", async () => {
    // Update the manifest to have required permissions
    db.withWriteTransaction((conn) => {
      const manifest = createTestManifest({
        id: "skill-1",
        version: "1.0.0",
        permissions: {
          grants: [
            { id: "fs", resource: "filesystem", action: "write", required: true, reason: "Need FS" },
          ],
          promptOn: ["filesystem.write"],
        },
      });
      conn.prepare(
        "UPDATE skill_versions SET manifest_json = ? WHERE skill_id = 'skill-1' AND version = '1.0.0'",
      ).run(JSON.stringify(manifest));
    });

    const service = createService();
    await expect(
      service.install({ skillId: "skill-1", version: "1.0.0", grantPermissions: [] }),
    ).rejects.toThrow("Missing required permissions");
  });

  it("uninstalls a skill", async () => {
    const packageInstaller = createMockPackageInstaller();
    const service = createService(undefined, packageInstaller);

    // Install first
    await service.install({ skillId: "skill-1", version: "1.0.0" });

    // Then uninstall
    service.uninstall("skill-1");

    const skill = db.withReadConnection((conn) =>
      createFridaySkillRepository().getSkillById(conn, "skill-1"),
    );
    expect(skill!.installedVersion).toBeUndefined();
    expect(skill!.status).toBe("not_installed");
    expect(packageInstaller.remove).toHaveBeenCalledWith("skill-1", "1.0.0");
  });

  it("publishes event on successful install", async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const versionRepo = createFridaySkillVersionRepository();
    const installationRepo = createFridaySkillInstallationRepository();
    const cacheRepo = createFridayMarketplaceCacheRepository();
    const verifier = createFridaySkillSignatureVerifier();
    const mockBuf = Buffer.from("test package bytes");
    const correctChecksum = verifier.computeChecksum(mockBuf);

    db.withWriteTransaction((conn) => {
      conn.prepare(
        "UPDATE skill_versions SET checksum = ? WHERE skill_id = 'skill-1' AND version = '1.0.0'",
      ).run(correctChecksum);
    });

    const service = createFridaySkillInstallationService({
      db,
      skillRepo: createFridaySkillRepository(),
      installationRepo,
      sourceRepo: createFridayMarketplaceSourceRepository(),
      versionResolver: createFridaySkillVersionResolutionService({ db, versionRepo, installationRepo, cacheRepo }),
      signatureVerifier: verifier,
      trustScoring: createFridaySkillTrustScoringService(),
      permissionCheck: createFridaySkillPermissionCheckService(),
      packageInstaller: createMockPackageInstaller(),
      httpClient: createMockHttpClient(),
      idGenerator: idGen,
      nowIso: () => NOW,
      publishEvent: async (event, payload) => {
        events.push({ event, payload });
      },
    });

    await service.install({ skillId: "skill-1", version: "1.0.0" });
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("skill.installed");
  });
});
