import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  createPackageInstaller,
  isValidInstallTransition,
  type PackageInstaller,
} from "../../../../src/packaging/engine/package-installer.js";
import { createRegistryManager } from "../../../../src/packaging/engine/registry-manager.js";
import type { RegistryManager } from "../../../../src/packaging/engine/registry-manager.js";
import {
  FRIDAY_PACKAGE_INSTALL_STATES,
  FRIDAY_PACKAGE_STATE_TRANSITIONS,
  type FridayPackageManifest,
  type FridayPackageSignature,
  type FridayPackageTrustedKey,
  type FridayPackageVerificationOutcome,
} from "../../../../src/packaging/model/friday-packaging.types.js";

// ─── Fixtures ───

const NOW = "2026-02-24T12:00:00.000Z";
const PLATFORM_VERSION = "0.5.0";
const TEST_KEY_PAIR = generateKeyPairSync("ed25519");
const TRUSTED_KEY_B64 = TEST_KEY_PAIR.publicKey.export({ format: "der", type: "spki" }).toString("base64");
let idCounter = 0;

function buildSignaturePayload(archiveDigest: string, manifestDigest: string): Buffer {
  return Buffer.from(JSON.stringify({ digest: archiveDigest, manifestDigest }), "utf8");
}

function makeConfig() {
  return {
    generateId: () => `id-${++idCounter}`,
    nowIso: () => NOW,
    trustedKeys: [makeTrustedKey()],
  };
}

function makeSignature(overrides: Partial<FridayPackageSignature> = {}): FridayPackageSignature {
  const digest = overrides.digest ?? "sha256:abc";
  const publicKey = overrides.publicKey ?? TRUSTED_KEY_B64;
  const manifestDigest = overrides.manifestDigest ?? "sha256:def";
  const signature = overrides.signature
    ?? sign(null, buildSignaturePayload(digest, manifestDigest), TEST_KEY_PAIR.privateKey)
      .toString("base64");

  return {
    algorithm: "Ed25519",
    publicKey,
    signature,
    digest,
    manifestDigest,
    timestamp: NOW,
    expiresAt: "2027-01-01T00:00:00.000Z",
    keyId: "key-1",
    ...overrides,
  };
}

function makeTrustedKey(): FridayPackageTrustedKey {
  return {
    id: "trusted-key-id-1",
    keyId: "key-1",
    publicKey: TRUSTED_KEY_B64,
    algorithm: "Ed25519",
    owner: "Packaging QA",
    trustedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function publishPkg(
  registry: RegistryManager,
  name: string,
  version: string,
  deps: Record<string, string> = {},
  tenantId?: string,
  signatureOverrides?: Partial<FridayPackageSignature>,
): void {
  const manifest: FridayPackageManifest = {
    name,
    version,
    description: `Package ${name}`,
    author: { name: "Test" },
    capabilities: ["skill:test"],
    dependencies: deps,
    fridayVersionRange: ">=0.1.0",
    assets: {},
  };
  const archiveDigest = `sha256:${name}-${version}`;
  const manifestDigest = `sha256:${name}-${version}-m`;
  registry.publish({
    manifest,
    signature: makeSignature({
      digest: archiveDigest,
      manifestDigest,
      ...signatureOverrides,
    }),
    archiveDigest,
    manifestDigest,
    sizeBytes: 1024,
    publishedBy: "user-1",
    tenantId,
  });
}

function verificationResult(
  valid: boolean,
  outcome: FridayPackageVerificationOutcome,
  message: string,
) {
  return {
    valid,
    outcome,
    message,
    keyId: "key-1",
    verifiedAt: NOW,
    durationMs: 1,
  };
}

// ─── Tests ───

describe("PackageInstaller", () => {
  let registry: RegistryManager;
  let installer: PackageInstaller;

  beforeEach(() => {
    idCounter = 0;
    const config = makeConfig();
    registry = createRegistryManager(config);
    installer = createPackageInstaller(registry, config);
  });

  describe("install", () => {
    it("installs a package successfully and verifies before extraction", () => {
      let verifyCalls = 0;
      installer = createPackageInstaller(registry, {
        ...makeConfig(),
        verifyPackage: () => {
          verifyCalls++;
          return verificationResult(true, "valid", "ok");
        },
      });

      publishPkg(registry, "@friday/core", "1.0.0");

      const result = installer.install({
        packageName: "@friday/core",
        version: "1.0.0",
        tenantId: "tenant-1",
        installedBy: "user-1",
        platformVersion: PLATFORM_VERSION,
      });

      expect(result.success).toBe(true);
      expect(result.install).not.toBeNull();
      expect(result.install!.state).toBe("active");
      expect(result.verification).not.toBeNull();
      expect(result.verification!.valid).toBe(true);
      expect(verifyCalls).toBe(1);
    });

    it("fails verification to verification_failed then failed with mapped error code", () => {
      installer = createPackageInstaller(registry, {
        ...makeConfig(),
        verifyPackage: () => verificationResult(false, "untrusted_key", "key not trusted"),
      });

      publishPkg(registry, "@friday/core", "1.0.0");

      const result = installer.install({
        packageName: "@friday/core",
        version: "1.0.0",
        tenantId: "tenant-1",
        installedBy: "user-1",
        platformVersion: PLATFORM_VERSION,
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("PACKAGING_UNTRUSTED_KEY");
      expect(result.install).not.toBeNull();
      expect(result.install!.state).toBe("failed");

      const events = installer.listLifecycleEvents({
        packageName: "@friday/core",
        operation: "install",
        tenantId: "tenant-1",
      });
      expect(events.some((event) => event.stateTo === "verification_failed")).toBe(true);
      expect(events.some((event) => event.stateTo === "failed")).toBe(true);
      expect(events.every((event) => typeof event.createdAt === "string")).toBe(true);
    });

    it("fails when package not found", () => {
      const result = installer.install({
        packageName: "@friday/nonexistent",
        tenantId: "tenant-1",
        installedBy: "user-1",
        platformVersion: PLATFORM_VERSION,
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("PACKAGING_PACKAGE_NOT_FOUND");
    });

    it("fails when signature verification is cryptographically invalid", () => {
      publishPkg(
        registry,
        "@friday/core",
        "1.0.0",
        {},
        undefined,
        { signature: Buffer.from("invalid-signature", "utf8").toString("base64") },
      );

      const result = installer.install({
        packageName: "@friday/core",
        version: "1.0.0",
        tenantId: "tenant-1",
        installedBy: "user-1",
        platformVersion: PLATFORM_VERSION,
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("PACKAGING_VERIFICATION_FAILED");
      expect(result.verification?.outcome).toBe("signature_invalid");
    });

    it("fails when dependency resolution fails", () => {
      publishPkg(registry, "@friday/core", "1.0.0", {
        "@friday/missing": "^1.0.0",
      });

      const result = installer.install({
        packageName: "@friday/core",
        version: "1.0.0",
        tenantId: "tenant-1",
        installedBy: "user-1",
        platformVersion: PLATFORM_VERSION,
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("PACKAGING_DEPENDENCY_CONFLICT");
    });
  });

  describe("upgrade", () => {
    it("upgrades active install with rollback linkage", () => {
      publishPkg(registry, "@friday/core", "1.0.0");
      publishPkg(registry, "@friday/core", "2.0.0");

      const installResult = installer.install({
        packageName: "@friday/core",
        version: "1.0.0",
        tenantId: "tenant-1",
        installedBy: "user-1",
        platformVersion: PLATFORM_VERSION,
      });

      const upgradeResult = installer.upgrade({
        packageName: "@friday/core",
        targetVersion: "2.0.0",
        tenantId: "tenant-1",
        etag: installResult.install!.etag,
        upgradedBy: "user-1",
        idempotencyKey: "upgrade-1",
        platformVersion: PLATFORM_VERSION,
        reason: "feature upgrade",
      });

      expect(upgradeResult.success).toBe(true);
      expect(upgradeResult.install).not.toBeNull();
      expect(upgradeResult.install!.packageVersion).toBe("2.0.0");
      expect(upgradeResult.install!.state).toBe("active");
      expect(upgradeResult.install!.previousVersion).toBe("1.0.0");
      expect(upgradeResult.previousVersion).toBe("1.0.0");

      const installs = installer.listInstalls("tenant-1");
      expect(installs.some((record) => record.packageVersion === "1.0.0" && record.state === "rolled_back")).toBe(true);
      expect(installs.some((record) => record.packageVersion === "2.0.0" && record.state === "active")).toBe(true);

      const events = installer.listLifecycleEvents({ operation: "upgrade", tenantId: "tenant-1" });
      expect(events.some((event) => event.stateTo === "rolling_back")).toBe(true);
      expect(events.some((event) => event.stateTo === "rolled_back")).toBe(true);
      expect(events.some((event) => event.details.reason === "feature upgrade")).toBe(true);
    });

    it("guards upgrade by etag", () => {
      publishPkg(registry, "@friday/core", "1.0.0");
      publishPkg(registry, "@friday/core", "2.0.0");

      installer.install({
        packageName: "@friday/core",
        version: "1.0.0",
        tenantId: "tenant-1",
        installedBy: "user-1",
        platformVersion: PLATFORM_VERSION,
      });

      const upgradeResult = installer.upgrade({
        packageName: "@friday/core",
        targetVersion: "2.0.0",
        tenantId: "tenant-1",
        etag: "wrong-etag",
        upgradedBy: "user-1",
        idempotencyKey: "upgrade-1",
        platformVersion: PLATFORM_VERSION,
      });

      expect(upgradeResult.success).toBe(false);
      expect(upgradeResult.errorCode).toBe("PACKAGING_ETAG_MISMATCH");
    });
  });

  describe("uninstall", () => {
    it("uninstalls an active package and persists audit transitions", () => {
      publishPkg(registry, "@friday/core", "1.0.0");
      const installResult = installer.install({
        packageName: "@friday/core",
        version: "1.0.0",
        tenantId: "tenant-1",
        installedBy: "user-1",
        platformVersion: PLATFORM_VERSION,
      });

      const result = installer.uninstall({
        packageName: "@friday/core",
        tenantId: "tenant-1",
        etag: installResult.install!.etag,
        reason: "decommission",
        uninstalledBy: "admin-1",
      });

      expect(result.success).toBe(true);
      expect(result.install!.state).toBe("uninstalled");

      const events = installer.listLifecycleEvents({
        packageName: "@friday/core",
        operation: "uninstall",
        tenantId: "tenant-1",
      });
      expect(events.some((event) => event.stateFrom === "active" && event.stateTo === "uninstalling")).toBe(true);
      expect(events.some((event) => event.stateFrom === "uninstalling" && event.stateTo === "uninstalled")).toBe(true);
      expect(events.some((event) => event.details.reason === "decommission")).toBe(true);
    });
  });

  describe("rollback", () => {
    it("rolls back and persists audit details (reason/from/to/timestamp)", () => {
      publishPkg(registry, "@friday/core", "1.0.0");
      publishPkg(registry, "@friday/core", "2.0.0");

      const installResult = installer.install({
        packageName: "@friday/core",
        version: "2.0.0",
        tenantId: "tenant-1",
        installedBy: "user-1",
        platformVersion: PLATFORM_VERSION,
      });

      const result = installer.rollback({
        packageName: "@friday/core",
        targetVersion: "1.0.0",
        tenantId: "tenant-1",
        etag: installResult.install!.etag,
        reason: "critical incident",
        initiatedBy: "admin-1",
      });

      expect(result.success).toBe(true);
      expect(result.rollback).not.toBeNull();
      expect(result.rollback!.state).toBe("completed");
      expect(result.rollback!.reason).toBe("critical incident");
      expect(result.install!.state).toBe("rolled_back");

      const events = installer.listLifecycleEvents({
        packageName: "@friday/core",
        operation: "rollback",
        tenantId: "tenant-1",
      });
      expect(events.length).toBeGreaterThan(0);
      expect(events.some((event) => event.stateFrom === "active" && event.stateTo === "rolling_back")).toBe(true);
      expect(events.some((event) => event.stateFrom === "rolling_back" && event.stateTo === "rolled_back")).toBe(true);
      expect(events.some((event) => event.details.reason === "critical incident")).toBe(true);
      expect(events.every((event) => typeof event.createdAt === "string")).toBe(true);
    });
  });

  describe("immutability", () => {
    it("returns frozen install snapshots from getters", () => {
      publishPkg(registry, "@friday/core", "1.0.0");
      const result = installer.install({
        packageName: "@friday/core",
        version: "1.0.0",
        tenantId: "tenant-1",
        installedBy: "user-1",
        platformVersion: PLATFORM_VERSION,
      });

      const install = installer.getInstall(result.install!.id)!;
      expect(Object.isFrozen(install)).toBe(true);
      expect(() => {
        (install as unknown as { state: string }).state = "failed";
      }).toThrow(TypeError);
    });

    it("returns frozen rollback and lifecycle snapshots", () => {
      publishPkg(registry, "@friday/core", "1.0.0");
      publishPkg(registry, "@friday/core", "2.0.0");

      const install = installer.install({
        packageName: "@friday/core",
        version: "2.0.0",
        tenantId: "tenant-1",
        installedBy: "user-1",
        platformVersion: PLATFORM_VERSION,
      });

      installer.rollback({
        packageName: "@friday/core",
        targetVersion: "1.0.0",
        tenantId: "tenant-1",
        etag: install.install!.etag,
        reason: "test",
        initiatedBy: "user-1",
      });

      const rollbacks = installer.listRollbacks(install.install!.id);
      const events = installer.listLifecycleEvents({ tenantId: "tenant-1" });

      expect(Object.isFrozen(rollbacks)).toBe(true);
      expect(Object.isFrozen(events)).toBe(true);
      expect(() => {
        (rollbacks[0] as unknown as { reason: string }).reason = "mutated";
      }).toThrow(TypeError);
      expect(() => {
        (events[0] as unknown as { operation: string }).operation = "publish";
      }).toThrow(TypeError);
    });
  });

  describe("state machine", () => {
    it("matches transition table for all states", () => {
      for (const from of FRIDAY_PACKAGE_INSTALL_STATES) {
        for (const to of FRIDAY_PACKAGE_INSTALL_STATES) {
          const expected = FRIDAY_PACKAGE_STATE_TRANSITIONS[from].includes(to);
          expect(isValidInstallTransition(from, to)).toBe(expected);
        }
      }
    });

    it("rejects invalid transition through transitionState", () => {
      publishPkg(registry, "@friday/core", "1.0.0");
      const result = installer.install({
        packageName: "@friday/core",
        version: "1.0.0",
        tenantId: "tenant-1",
        installedBy: "user-1",
        platformVersion: PLATFORM_VERSION,
      });

      const invalid = installer.transitionState(result.install!.id, "extracting");
      expect(invalid).toBeNull();
    });

    it("supports valid transition through transitionState", () => {
      publishPkg(registry, "@friday/core", "1.0.0");
      const result = installer.install({
        packageName: "@friday/core",
        version: "1.0.0",
        tenantId: "tenant-1",
        installedBy: "user-1",
        platformVersion: PLATFORM_VERSION,
      });

      const transitioned = installer.transitionState(result.install!.id, "verification_failed", "key revoked");
      expect(transitioned).not.toBeNull();
      expect(transitioned!.state).toBe("verification_failed");
      expect(transitioned!.errorMessage).toBe("key revoked");
    });
  });

  describe("KPI thresholds", () => {
    it("install success rate is > 99%", () => {
      publishPkg(registry, "@friday/core", "1.0.0");

      const attempts = 200;
      const results = Array.from({ length: attempts }, (_, index) =>
        installer.install({
          packageName: "@friday/core",
          version: "1.0.0",
          tenantId: `tenant-${index}`,
          installedBy: "user-1",
          platformVersion: PLATFORM_VERSION,
        }),
      );

      const successRate = results.filter((result) => result.success).length / attempts;
      expect(successRate).toBeGreaterThan(0.99);
    });

    it("signature verification coverage is 100%", () => {
      let verifyCalls = 0;
      installer = createPackageInstaller(registry, {
        ...makeConfig(),
        verifyPackage: () => {
          verifyCalls++;
          return verificationResult(true, "valid", "ok");
        },
      });

      publishPkg(registry, "@friday/core", "1.0.0");

      const attempts = 120;
      const results = Array.from({ length: attempts }, (_, index) =>
        installer.install({
          packageName: "@friday/core",
          version: "1.0.0",
          tenantId: `tenant-${index}`,
          installedBy: "user-1",
          platformVersion: PLATFORM_VERSION,
        }),
      );

      const installSuccessRate = results.filter((result) => result.success).length / attempts;
      const verificationCoverage = verifyCalls / attempts;

      expect(installSuccessRate).toBeGreaterThan(0.99);
      expect(verificationCoverage).toBe(1);
    });

    it("rollback success rate is > 99%", () => {
      publishPkg(registry, "@friday/core", "1.0.0");
      publishPkg(registry, "@friday/core", "2.0.0");

      const attempts = 150;
      const rollbackResults = Array.from({ length: attempts }, (_, index) => {
        const tenantId = `tenant-${index}`;
        const installResult = installer.install({
          packageName: "@friday/core",
          version: "2.0.0",
          tenantId,
          installedBy: "user-1",
          platformVersion: PLATFORM_VERSION,
        });

        if (!installResult.success || !installResult.install) {
          return { success: false };
        }

        return installer.rollback({
          packageName: "@friday/core",
          targetVersion: "1.0.0",
          tenantId,
          etag: installResult.install.etag,
          reason: "rollback KPI",
          initiatedBy: "user-1",
        });
      });

      const rollbackSuccessRate = rollbackResults.filter((result) => result.success).length / attempts;
      expect(rollbackSuccessRate).toBeGreaterThan(0.99);
    });
  });
});
