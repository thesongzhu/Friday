import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import { createFridaySkillPermissionCheckService } from "#skills";
import { createFridaySkillPackageInstaller } from "#skills";
import { createFridaySkillTrustScoringService } from "#skills";
import { createFridaySkillSignatureVerifier } from "#skills";
import { createFridaySkillInstallationService } from "#skills";
import { createFridaySkillVersionResolutionService } from "#skills";
import { createFridaySkillRepository } from "#skills";
import { createFridaySkillVersionRepository } from "#skills";
import { createFridaySkillInstallationRepository } from "#skills";
import { createFridayMarketplaceSourceRepository } from "#skills";
import { createFridayMarketplaceCacheRepository } from "#skills";
import { createFridayMarketplaceSyncService } from "#skills";
import type { FridaySkillPackageInstaller } from "#skills";
import type { FridayMarketplaceHttpClient } from "#skills";
import type { FridaySignatureVerificationResult } from "#skills";
import type { SkillManifestV2 } from "#skills";
import { createTestDb, createTestIdGenerator, NOW, createTestManifest } from "./marketplace.helper.js";
import { tmpdir } from "node:os";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";

// ────────────────────────────────────────────────
// Issue 1: Invalid/missing manifest doesn't crash
// ────────────────────────────────────────────────
describe("Issue 1: Permission check handles invalid/missing manifest", () => {
  const service = createFridaySkillPermissionCheckService();

  it("handles manifest with no permissions property", () => {
    const badManifest = { schemaVersion: "2.0", id: "x", name: "X" } as unknown as SkillManifestV2;
    const result = service.checkPermissions(badManifest, []);
    expect(result.allowed).toBe(true);
    expect(result.missingRequired).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("handles manifest with null permissions", () => {
    const badManifest = {
      schemaVersion: "2.0",
      id: "x",
      name: "X",
      permissions: null,
    } as unknown as SkillManifestV2;
    const result = service.checkPermissions(badManifest, []);
    expect(result.allowed).toBe(true);
    expect(result.missingRequired).toEqual([]);
  });

  it("handles manifest with permissions but no grants", () => {
    const badManifest = {
      schemaVersion: "2.0",
      id: "x",
      name: "X",
      permissions: { promptOn: [] },
    } as unknown as SkillManifestV2;
    const result = service.checkPermissions(badManifest, []);
    expect(result.allowed).toBe(true);
  });

  it("handles manifest with permissions but no promptOn", () => {
    const badManifest = {
      schemaVersion: "2.0",
      id: "x",
      name: "X",
      permissions: { grants: [] },
    } as unknown as SkillManifestV2;
    const result = service.checkPermissions(badManifest, []);
    expect(result.allowed).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("still correctly detects missing required permissions for valid manifest", () => {
    const manifest = createTestManifest({
      permissions: {
        grants: [
          { id: "fs", resource: "filesystem", action: "write", required: true, reason: "Need FS" },
        ],
        promptOn: ["filesystem.write"],
      },
    });
    const result = service.checkPermissions(manifest, []);
    expect(result.allowed).toBe(false);
    expect(result.missingRequired).toContain("filesystem.write");
  });
});

describe("Issue 1: Sync service stores valid manifests", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
  });

  afterEach(() => {
    db.close();
  });

  it("synced version has a valid SkillManifestV2 with permissions", async () => {
    const sourceRepo = createFridayMarketplaceSourceRepository();
    const versionRepo = createFridaySkillVersionRepository();

    db.withWriteTransaction((conn) => {
      sourceRepo.insertSource(conn, "src-1", {
        name: "Test",
        baseUrl: "https://test.dev",
        trustPolicy: "warn",
        pinnedKeyIds: [],
      }, NOW);
    });

    const mockHttp: FridayMarketplaceHttpClient = {
      async fetchIndex() {
        return {
          generatedAt: NOW,
          skills: [{
            id: "my-skill",
            name: "My Skill",
            publisher: "Test Publisher",
            latestVersion: "1.0.0",
            versions: [{
              version: "1.0.0",
              checksum: "abc",
              releasedAt: NOW,
              manifestUrl: "/m",
              packageUrl: "/p",
              signatureUrl: "/s",
            }],
          }],
        };
      },
      async fetchManifest() { return {}; },
      async fetchSignature() { return { skillId: "", version: "", keyId: "", algorithm: "ed25519" as const, value: "" }; },
      async fetchPublisherKey() { return { keyId: "", algorithm: "ed25519" as const }; },
      async fetchPackage() { return Buffer.alloc(0); },
    };

    const service = createFridayMarketplaceSyncService({
      db,
      sourceRepo,
      cacheRepo: createFridayMarketplaceCacheRepository(),
      skillRepo: createFridaySkillRepository(),
      versionRepo,
      httpClient: mockHttp,
      trustScoring: createFridaySkillTrustScoringService(),
      signatureVerifier: createFridaySkillSignatureVerifier(),
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    await service.syncSource("src-1");

    // Verify the stored manifest is a valid SkillManifestV2
    const versions = db.withReadConnection((conn) =>
      versionRepo.listVersionsForResolution(conn, "my-skill", false),
    );
    expect(versions).toHaveLength(1);
    const manifest = versions[0].manifest;
    expect(manifest.schemaVersion).toBe("2.0");
    expect(manifest.id).toBe("my-skill");
    expect(manifest.permissions).toBeDefined();
    expect(manifest.permissions.grants).toEqual([]);
    expect(manifest.permissions.promptOn).toEqual([]);
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.author.name).toBe("Test Publisher");

    // Verify permission check doesn't crash
    const permService = createFridaySkillPermissionCheckService();
    const permResult = permService.checkPermissions(manifest, []);
    expect(permResult.allowed).toBe(true);
  });
});

// ────────────────────────────────────────────────
// Issue 2: Path traversal rejected
// ────────────────────────────────────────────────
describe("Issue 2: Package installer rejects path traversal", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "friday-pkg-test-"));
  });

  it("rejects skillId with path traversal characters", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    expect(() => installer.stage("../../etc", "1.0.0", Buffer.from("x"))).toThrow(
      /Invalid skillId.*disallowed/,
    );
  });

  it("rejects version with path traversal characters", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    expect(() => installer.stage("safe-skill", "../../../etc/passwd", Buffer.from("x"))).toThrow(
      /Invalid version.*disallowed/,
    );
  });

  it("rejects skillId with dots", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    expect(() => installer.stage("..", "1.0.0", Buffer.from("x"))).toThrow(/Invalid skillId/);
  });

  it("rejects version with slashes", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    expect(() => installer.stage("good-skill", "1.0.0/../../bad", Buffer.from("x"))).toThrow(
      /Invalid version/,
    );
  });

  it("rejects skillId with spaces", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    expect(() => installer.stage("skill name", "1.0.0", Buffer.from("x"))).toThrow(
      /Invalid skillId/,
    );
  });

  it("allows valid skillId and semver version", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    const result = installer.stage("my-skill_123", "1.0.0", Buffer.from("pkg"));
    expect(result).toContain("my-skill_123");
    expect(existsSync(join(result, "package.tgz"))).toBe(true);
  });

  it("accepts standard semver versions", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });

    const r1 = installer.stage("skill-a", "1.0.0", Buffer.from("a"));
    expect(existsSync(join(r1, "package.tgz"))).toBe(true);

    const r2 = installer.stage("skill-a", "2.3.1-beta.1", Buffer.from("b"));
    expect(existsSync(join(r2, "package.tgz"))).toBe(true);

    const r3 = installer.stage("skill-a", "0.0.1", Buffer.from("c"));
    expect(existsSync(join(r3, "package.tgz"))).toBe(true);
  });

  it("rejects version with leading dot-dot path traversal", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    expect(() => installer.stage("good-skill", "../1.0.0", Buffer.from("x"))).toThrow(
      /Invalid version/,
    );
  });

  it("rejects version with embedded path traversal sequences", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    expect(() => installer.stage("good-skill", "1.0.0/../../etc", Buffer.from("x"))).toThrow(
      /Invalid version/,
    );
  });

  it("rejects version that is just '..'", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    expect(() => installer.stage("good-skill", "..", Buffer.from("x"))).toThrow(
      /Invalid version/,
    );
  });

  it("rejects path traversal in activate", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    expect(() => installer.activate("../../etc", "1.0.0")).toThrow(/Invalid skillId/);
  });

  it("rejects path traversal in remove", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    expect(() => installer.remove("../../etc", "1.0.0")).toThrow(/Invalid skillId/);
  });
});

// ────────────────────────────────────────────────
// Issue 3: Unknown source fails closed
// ────────────────────────────────────────────────
describe("Issue 3: Unknown source fails closed (not permissive)", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();

    const skillRepo = createFridaySkillRepository();
    const versionRepo = createFridaySkillVersionRepository();

    db.withWriteTransaction((conn) => {
      // Create skill WITHOUT a source in marketplace_sources
      skillRepo.upsertSkillFromMarketplace(conn, {
        id: "orphan-skill",
        name: "Orphan Skill",
        source: "marketplace",
        origin: "managed",
        latestVersion: "1.0.0",
        status: "not_installed",
        nowIso: NOW,
      });

      const manifest = createTestManifest({
        id: "orphan-skill",
        version: "1.0.0",
        permissions: { grants: [], promptOn: [] },
      });

      versionRepo.upsertVersion(conn, {
        id: "v-orphan",
        skillId: "orphan-skill",
        version: "1.0.0",
        checksum: "aaa",
        packageUrl: "https://test.dev/pkg.tgz",
        manifest,
        releasedAt: NOW,
        nowIso: NOW,
      });
    });
  });

  afterEach(() => {
    db.close();
  });

  it("rejects installation when source cannot be resolved", async () => {
    const verifier = createFridaySkillSignatureVerifier();
    const mockBuf = Buffer.from("test package bytes");
    const correctChecksum = verifier.computeChecksum(mockBuf);

    db.withWriteTransaction((conn) => {
      conn.prepare(
        "UPDATE skill_versions SET checksum = ? WHERE skill_id = 'orphan-skill'",
      ).run(correctChecksum);
    });

    const service = createFridaySkillInstallationService({
      db,
      skillRepo: createFridaySkillRepository(),
      installationRepo: createFridaySkillInstallationRepository(),
      sourceRepo: createFridayMarketplaceSourceRepository(),
      versionResolver: createFridaySkillVersionResolutionService({
        db,
        versionRepo: createFridaySkillVersionRepository(),
        installationRepo: createFridaySkillInstallationRepository(),
        cacheRepo: createFridayMarketplaceCacheRepository(),
      }),
      signatureVerifier: verifier,
      trustScoring: createFridaySkillTrustScoringService(),
      permissionCheck: createFridaySkillPermissionCheckService(),
      packageInstaller: {
        stage: vi.fn().mockReturnValue("/tmp/staging"),
        activate: vi.fn().mockReturnValue("/tmp/final"),
        remove: vi.fn(),
      },
      httpClient: {
        fetchIndex: vi.fn().mockResolvedValue({ generatedAt: NOW, skills: [] }),
        fetchManifest: vi.fn().mockResolvedValue({}),
        fetchSignature: vi.fn().mockRejectedValue(new Error("no sig")),
        fetchPublisherKey: vi.fn().mockRejectedValue(new Error("no key")),
        fetchPackage: vi.fn().mockResolvedValue(mockBuf),
      },
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    await expect(
      service.install({ skillId: "orphan-skill", version: "1.0.0" }),
    ).rejects.toThrow(/Source not resolved/);
  });
});

// ────────────────────────────────────────────────
// Issue 4: Trust threshold boundary at 55
// ────────────────────────────────────────────────
describe("Issue 4: Permissive trust threshold is 55", () => {
  const service = createFridaySkillTrustScoringService();

  function noSigVerification(): FridaySignatureVerificationResult {
    return {
      integrityValid: true,
      signatureValid: false,
      checks: ["integrity:pass", "signature:missing"],
    };
  }

  it("rejects score=54 under permissive policy", () => {
    const breakdown = {
      total: 54,
      signature: 0,
      integrity: 15,
      keyPinning: 10,
      sourcePolicy: 5,
      publisher: 14,
      freshness: 10,
      reasons: [],
    };
    const decision = service.evaluatePolicy("permissive", breakdown, noSigVerification());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("below permissive threshold");
    expect(decision.reason).toContain("55");
  });

  it("accepts score=55 under permissive policy", () => {
    const breakdown = {
      total: 55,
      signature: 0,
      integrity: 15,
      keyPinning: 10,
      sourcePolicy: 5,
      publisher: 15,
      freshness: 10,
      reasons: [],
    };
    const decision = service.evaluatePolicy("permissive", breakdown, noSigVerification());
    expect(decision.allowed).toBe(true);
  });

  it("accepts score=56 under permissive policy", () => {
    const breakdown = {
      total: 56,
      signature: 0,
      integrity: 15,
      keyPinning: 10,
      sourcePolicy: 5,
      publisher: 16,
      freshness: 10,
      reasons: [],
    };
    const decision = service.evaluatePolicy("permissive", breakdown, noSigVerification());
    expect(decision.allowed).toBe(true);
  });
});

// ────────────────────────────────────────────────
// Issue 5: Signature metadata mismatch rejection
// ────────────────────────────────────────────────
describe("Issue 5: Signature metadata cross-validation", () => {
  const verifier = createFridaySkillSignatureVerifier();

  function makeValidSig() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    const buf = Buffer.from("test-package");
    const checksum = verifier.computeChecksum(buf);
    const payload = Buffer.from(`friday-skill-signature-v1\nskill-a\n1.0.0\n${checksum}`);
    const sig = sign(null, payload, privateKey);
    return { buf, checksum, sig, pubPem };
  }

  it("rejects when signatureDoc.skillId mismatches requested skillId", () => {
    const { buf, checksum, sig, pubPem } = makeValidSig();
    const result = verifier.verifySignature({
      packageBytes: buf,
      expectedChecksum: checksum,
      skillId: "skill-a",
      version: "1.0.0",
      signatureDoc: {
        skillId: "skill-WRONG",
        version: "1.0.0",
        keyId: "k1",
        algorithm: "ed25519",
        value: sig.toString("base64"),
      },
      publisherKey: {
        keyId: "k1",
        algorithm: "ed25519",
        publicKeyPem: pubPem,
      },
    });
    expect(result.signatureValid).toBe(false);
    expect(result.checks).toContain("metadata:skill-mismatch");
    expect(result.reason).toContain("skill-WRONG");
  });

  it("rejects when signatureDoc.version mismatches requested version", () => {
    const { buf, checksum, sig, pubPem } = makeValidSig();
    const result = verifier.verifySignature({
      packageBytes: buf,
      expectedChecksum: checksum,
      skillId: "skill-a",
      version: "1.0.0",
      signatureDoc: {
        skillId: "skill-a",
        version: "9.9.9",
        keyId: "k1",
        algorithm: "ed25519",
        value: sig.toString("base64"),
      },
      publisherKey: {
        keyId: "k1",
        algorithm: "ed25519",
        publicKeyPem: pubPem,
      },
    });
    expect(result.signatureValid).toBe(false);
    expect(result.checks).toContain("metadata:version-mismatch");
    expect(result.reason).toContain("9.9.9");
  });

  it("rejects when publisherKey.keyId mismatches signatureDoc.keyId", () => {
    const { buf, checksum, sig, pubPem } = makeValidSig();
    const result = verifier.verifySignature({
      packageBytes: buf,
      expectedChecksum: checksum,
      skillId: "skill-a",
      version: "1.0.0",
      signatureDoc: {
        skillId: "skill-a",
        version: "1.0.0",
        keyId: "expected-key",
        algorithm: "ed25519",
        value: sig.toString("base64"),
      },
      publisherKey: {
        keyId: "different-key",
        algorithm: "ed25519",
        publicKeyPem: pubPem,
      },
    });
    expect(result.signatureValid).toBe(false);
    expect(result.checks).toContain("metadata:keyId-mismatch");
    expect(result.reason).toContain("different-key");
    expect(result.reason).toContain("expected-key");
  });

  it("rejects when publisherKey.algorithm mismatches signatureDoc.algorithm", () => {
    const { buf, checksum, sig, pubPem } = makeValidSig();
    const result = verifier.verifySignature({
      packageBytes: buf,
      expectedChecksum: checksum,
      skillId: "skill-a",
      version: "1.0.0",
      signatureDoc: {
        skillId: "skill-a",
        version: "1.0.0",
        keyId: "k1",
        algorithm: "ed25519",
        value: sig.toString("base64"),
      },
      publisherKey: {
        keyId: "k1",
        algorithm: "rsa-sha256",
        publicKeyPem: pubPem,
      },
    });
    expect(result.signatureValid).toBe(false);
    expect(result.checks).toContain("metadata:algorithm-mismatch");
    expect(result.reason).toContain("rsa-sha256");
    expect(result.reason).toContain("ed25519");
  });

  it("passes when all metadata matches", () => {
    const { buf, checksum, sig, pubPem } = makeValidSig();
    const result = verifier.verifySignature({
      packageBytes: buf,
      expectedChecksum: checksum,
      skillId: "skill-a",
      version: "1.0.0",
      signatureDoc: {
        skillId: "skill-a",
        version: "1.0.0",
        keyId: "k1",
        algorithm: "ed25519",
        value: sig.toString("base64"),
      },
      publisherKey: {
        keyId: "k1",
        algorithm: "ed25519",
        publicKeyPem: pubPem,
      },
    });
    expect(result.signatureValid).toBe(true);
    expect(result.integrityValid).toBe(true);
    expect(result.checks).toContain("signature:pass");
  });
});
