/**
 * Phase 11 Module 16 integration test:
 *
 *  - SQLite-backed package registry persists across "restarts" (close + reopen).
 *  - SQLite-backed install lifecycle survives restart.
 *  - Trusted-key revocation flows through SQLite.
 *  - Invalid signature is rejected via verifySignatureLogical().
 *  - Install/uninstall/rollback/remove all leave durable audit traces.
 *
 * Uses an on-disk SQLite file so a second layer can reopen the same db
 * to prove that state persists.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFridaySqliteLayer } from "#state";
import type { FridaySqliteLayer } from "#state";
import {
  createSqliteRegistryManager,
  createSqlitePackageInstaller,
  createSqliteTrustedKeyStore,
} from "../../../src/packaging/persistence/friday-package-sqlite-store.js";
import { verifySignatureLogical } from "../../../src/packaging/engine/package-validator.js";
import type { PackageVerifier } from "../../../src/packaging/engine/package-installer.js";
import type {
  FridayPackageManifest,
  FridayPackageSignature,
  FridayPackageTrustedKey,
} from "../../../src/packaging/model/friday-packaging.types.js";

function buildLayer(dbPath: string): FridaySqliteLayer {
  return createFridaySqliteLayer({
    dbPath,
    readPoolSize: 1,
    pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
  });
}

function manifest(version = "1.0.0"): FridayPackageManifest {
  return {
    name: "@friday/test-package",
    version,
    description: "Phase 11 packaging persistence regression",
    author: { name: "Friday Tests" },
    capabilities: ["skill:probe"],
    dependencies: {},
    fridayVersionRange: ">=0.0.0",
    assets: {},
  };
}

function digest(content: string): string {
  return "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
}

function makeKeyMaterial(): { publicKey: Buffer; privateKey: Buffer } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }),
  };
}

function buildSignature(opts: {
  manifestObj: FridayPackageManifest;
  archive: string;
  keyId: string;
  publicKeyBase64: string;
  privateKeyDer: Buffer;
  expiresAt?: string;
}): { signature: FridayPackageSignature; manifestDigest: string; archiveDigest: string } {
  const manifestJson = JSON.stringify(opts.manifestObj);
  const manifestDigest = digest(manifestJson);
  const archiveDigest = digest(opts.archive);
  const canonicalPayload = JSON.stringify({ digest: archiveDigest, manifestDigest });
  const privateKey = crypto.createPrivateKey({
    key: opts.privateKeyDer,
    format: "der",
    type: "pkcs8",
  });
  const sigBytes = crypto.sign(null, Buffer.from(canonicalPayload, "utf8"), privateKey);
  return {
    signature: {
      algorithm: "Ed25519",
      publicKey: opts.publicKeyBase64,
      signature: sigBytes.toString("base64"),
      digest: archiveDigest,
      manifestDigest,
      timestamp: new Date().toISOString(),
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      keyId: opts.keyId,
    },
    manifestDigest,
    archiveDigest,
  };
}

function trustedVerifier(trustedKeys: () => readonly FridayPackageTrustedKey[]): PackageVerifier {
  return (context) =>
    verifySignatureLogical(
      context.entry.signature,
      context.entry.manifestDigest,
      context.entry.archiveDigest,
      trustedKeys(),
      context.verifiedAt,
    );
}

let tmpdir: string;
let dbPath: string;
let layer: FridaySqliteLayer;

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-packaging-persistence-"));
  dbPath = path.join(tmpdir, "friday.sqlite");
  layer = buildLayer(dbPath);
});

afterEach(() => {
  try { layer.close(); } catch { /* ignore */ }
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

describe("packaging SQLite persistence (Phase 11 Module 16)", () => {
  it("persists publish/install lifecycle across simulated hub restart", () => {
    const keys = makeKeyMaterial();
    const publicKeyBase64 = keys.publicKey.toString("base64");
    const trusted = createSqliteTrustedKeyStore({ sqlite: layer });
    trusted.add({
      keyId: "test-key-1",
      publicKey: publicKeyBase64,
      owner: "Friday Tests",
    });

    const registry = createSqliteRegistryManager({ sqlite: layer });
    const archive = "archive-bytes-1";
    const m = manifest();
    const { signature, manifestDigest, archiveDigest } = buildSignature({
      manifestObj: m,
      archive,
      keyId: "test-key-1",
      publicKeyBase64,
      privateKeyDer: keys.privateKey,
    });

    const verification = verifySignatureLogical(
      signature,
      manifestDigest,
      archiveDigest,
      trusted.listAll(),
      new Date().toISOString(),
    );
    expect(verification.valid, verification.message).toBe(true);

    const published = registry.publish({
      manifest: m,
      signature,
      archiveDigest,
      manifestDigest,
      sizeBytes: archive.length,
      publishedBy: "tester",
      tenantId: "tenant-a",
    });
    expect(published.name).toBe("@friday/test-package");

    const installer = createSqlitePackageInstaller({
      sqlite: layer,
      registry,
      verifyPackage: trustedVerifier(() => trusted.listAll()),
    });
    const installResult = installer.install({
      packageName: m.name,
      tenantId: "tenant-a",
      installedBy: "tester",
      platformVersion: "1.0.0",
    });
    expect(installResult.success).toBe(true);
    expect(installResult.install?.state).toBe("active");

    layer.close();
    layer = buildLayer(dbPath);

    const registry2 = createSqliteRegistryManager({ sqlite: layer });
    const trusted2 = createSqliteTrustedKeyStore({ sqlite: layer });
    const installer2 = createSqlitePackageInstaller({
      sqlite: layer,
      registry: registry2,
      verifyPackage: trustedVerifier(() => trusted2.listAll()),
    });

    expect(registry2.count()).toBe(1);
    const survived = registry2.getByNameVersion(m.name, m.version, "tenant-a");
    expect(survived?.id).toBe(published.id);

    const active = installer2.getActiveInstall(m.name, "tenant-a");
    expect(active?.state).toBe("active");
    expect(trusted2.findByKeyId("test-key-1")?.owner).toBe("Friday Tests");
  });

  it("rejects packages signed with an unknown or revoked key", () => {
    const keys = makeKeyMaterial();
    const publicKeyBase64 = keys.publicKey.toString("base64");
    const trusted = createSqliteTrustedKeyStore({ sqlite: layer });
    trusted.add({ keyId: "alice", publicKey: publicKeyBase64, owner: "Alice" });

    const m = manifest();
    const archive = "archive-bytes-2";

    // Unknown key path
    const { signature: bogusSig, manifestDigest: bogusManifestDigest, archiveDigest: bogusArchiveDigest } = buildSignature({
      manifestObj: m,
      archive,
      keyId: "unknown-key",
      publicKeyBase64,
      privateKeyDer: keys.privateKey,
    });
    const unknownResult = verifySignatureLogical(
      bogusSig,
      bogusManifestDigest,
      bogusArchiveDigest,
      trusted.listAll(),
      new Date().toISOString(),
    );
    expect(unknownResult.valid).toBe(false);
    expect(unknownResult.outcome).toBe("untrusted_key");

    // Revoke alice and verify a fresh valid-looking signature still fails
    trusted.revoke("alice", "key compromised in test");
    const { signature: aliceSig, manifestDigest: aliceManifestDigest, archiveDigest: aliceArchiveDigest } = buildSignature({
      manifestObj: m,
      archive,
      keyId: "alice",
      publicKeyBase64,
      privateKeyDer: keys.privateKey,
    });
    const revokedResult = verifySignatureLogical(
      aliceSig,
      aliceManifestDigest,
      aliceArchiveDigest,
      trusted.listAll(),
      new Date().toISOString(),
    );
    expect(revokedResult.valid).toBe(false);
    expect(revokedResult.outcome).toBe("key_revoked");
  });

  it("supports install -> uninstall -> rollback and records lifecycle audit events", () => {
    const keys = makeKeyMaterial();
    const publicKeyBase64 = keys.publicKey.toString("base64");
    const trusted = createSqliteTrustedKeyStore({ sqlite: layer });
    trusted.add({ keyId: "test-key-2", publicKey: publicKeyBase64, owner: "Friday Tests" });

    const registry = createSqliteRegistryManager({ sqlite: layer });

    function publish(version: string): { archive: string } {
      const archive = `archive-bytes-${version}`;
      const m = manifest(version);
      const { signature, manifestDigest, archiveDigest } = buildSignature({
        manifestObj: m,
        archive,
        keyId: "test-key-2",
        publicKeyBase64,
        privateKeyDer: keys.privateKey,
      });
      registry.publish({
        manifest: m,
        signature,
        archiveDigest,
        manifestDigest,
        sizeBytes: archive.length,
        publishedBy: "tester",
        tenantId: "tenant-z",
      });
      return { archive };
    }

    publish("1.0.0");
    publish("1.1.0");

    const installer = createSqlitePackageInstaller({
      sqlite: layer,
      registry,
      verifyPackage: trustedVerifier(() => trusted.listAll()),
    });
    const installResult = installer.install({
      packageName: "@friday/test-package",
      tenantId: "tenant-z",
      installedBy: "tester",
      platformVersion: "1.0.0",
    });
    expect(installResult.success).toBe(true);

    const active = installer.getActiveInstall("@friday/test-package", "tenant-z");
    expect(active?.packageVersion).toBe("1.1.0");

    // Uninstall
    const uninstall = installer.uninstall({
      packageName: "@friday/test-package",
      tenantId: "tenant-z",
      etag: active!.etag,
      uninstalledBy: "tester",
      reason: "test cleanup",
    });
    expect(uninstall.success).toBe(true);
    expect(uninstall.install?.state).toBe("uninstalled");
    expect(installer.getActiveInstall("@friday/test-package", "tenant-z")).toBeNull();

    // Install again then rollback to 1.0.0
    const reinstall = installer.install({
      packageName: "@friday/test-package",
      version: "1.1.0",
      tenantId: "tenant-z",
      installedBy: "tester",
      platformVersion: "1.0.0",
    });
    expect(reinstall.success).toBe(true);

    const rollback = installer.rollback({
      packageName: "@friday/test-package",
      targetVersion: "1.0.0",
      tenantId: "tenant-z",
      etag: reinstall.install!.etag,
      reason: "regression test",
      initiatedBy: "tester",
    });
    expect(rollback.success).toBe(true);
    expect(rollback.install?.packageVersion).toBe("1.0.0");

    const events = installer.listLifecycleEvents({ packageName: "@friday/test-package", tenantId: "tenant-z" });
    const ops = new Set(events.map((e) => e.operation));
    expect(ops.has("install")).toBe(true);
    expect(ops.has("uninstall")).toBe(true);
    expect(ops.has("rollback")).toBe(true);
  });

  it("fails closed when a SQLite installer is created without a package verifier", () => {
    const keys = makeKeyMaterial();
    const publicKeyBase64 = keys.publicKey.toString("base64");
    const trusted = createSqliteTrustedKeyStore({ sqlite: layer });
    trusted.add({ keyId: "test-key-3", publicKey: publicKeyBase64, owner: "Friday Tests" });

    const registry = createSqliteRegistryManager({ sqlite: layer });
    const archive = "archive-bytes-no-verifier";
    const m = manifest();
    const { signature, manifestDigest, archiveDigest } = buildSignature({
      manifestObj: m,
      archive,
      keyId: "test-key-3",
      publicKeyBase64,
      privateKeyDer: keys.privateKey,
    });
    registry.publish({
      manifest: m,
      signature,
      archiveDigest,
      manifestDigest,
      sizeBytes: archive.length,
      publishedBy: "tester",
      tenantId: "tenant-no-verifier",
    });

    const installer = createSqlitePackageInstaller({ sqlite: layer, registry });
    const installResult = installer.install({
      packageName: m.name,
      tenantId: "tenant-no-verifier",
      installedBy: "tester",
      platformVersion: "1.0.0",
    });

    expect(installResult.success).toBe(false);
    expect(installResult.install?.state).toBe("verification_failed");
    expect(installResult.errorCode).toBe("PACKAGING_SIGNATURE_INVALID");
    expect(installResult.verification).toMatchObject({
      valid: false,
      outcome: "signature_invalid",
    });
  });
});
