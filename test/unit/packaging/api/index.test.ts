import { describe, expect, it, vi } from "vitest";
import {
  createFridayPackagingApiHandlers,
  FridayPackagingApiError,
  runFridayPackagingCliCommand,
  type FridayPackagingApiHandlers,
} from "../../../../src/packaging/api/index.js";
import type {
  PackageInstaller,
  RegistryManager,
} from "../../../../src/packaging/engine/index.js";
import type {
  FridayDependencyResolutionResult,
  FridayPackageInstall,
  FridayPackageLifecycleEvent,
  FridayPackageRegistryEntry,
  FridayPackageRollback,
  FridayPackageVerificationResult,
} from "../../../../src/packaging/model/friday-packaging.types.js";

const NOW = "2026-02-25T12:00:00.000Z";

function makeRegistryEntry(): FridayPackageRegistryEntry {
  return {
    id: "pkg-1",
    name: "@friday/core",
    version: "1.0.0",
    description: "Core package",
    author: { name: "Friday Team" },
    license: "MIT",
    capabilities: ["skill:test"],
    dependencies: {},
    peerDependencies: {},
    fridayVersionRange: ">=0.1.0",
    assets: {},
    hooks: {},
    metadata: {},
    sizeBytes: 1024,
    archiveDigest: "sha256:archive",
    manifestDigest: "sha256:manifest",
    signature: {
      algorithm: "Ed25519",
      publicKey: "dGVzdC1rZXk=",
      signature: "dGVzdC1zaWduYXR1cmU=",
      digest: "sha256:archive",
      manifestDigest: "sha256:manifest",
      timestamp: NOW,
      expiresAt: "2027-01-01T00:00:00.000Z",
      keyId: "key-1",
    },
    publishedBy: "publisher-1",
    etag: "etag-pkg-1",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeInstall(): FridayPackageInstall {
  return {
    id: "install-1",
    packageId: "pkg-1",
    packageName: "@friday/core",
    packageVersion: "1.0.0",
    tenantId: "tenant-1",
    state: "active",
    etag: "etag-install-1",
    version: 2,
    installedBy: "principal-1",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeVerification(): FridayPackageVerificationResult {
  return {
    valid: true,
    outcome: "valid",
    message: "verified",
    keyId: "key-1",
    verifiedAt: NOW,
    durationMs: 1,
  };
}

function makeDependencyResult(): FridayDependencyResolutionResult {
  return {
    success: true,
    resolved: [
      {
        name: "@friday/core",
        requestedRange: "^1.0.0",
        resolvedVersion: "1.0.0",
        registryEntryId: "pkg-1",
        direct: true,
        requestedBy: "@friday/consumer",
      },
    ],
    conflicts: [],
  };
}

function makeRollback(): FridayPackageRollback {
  return {
    id: "rollback-1",
    installId: "install-1",
    packageName: "@friday/core",
    fromVersion: "2.0.0",
    toVersion: "1.0.0",
    reason: "rollback",
    initiatedBy: "principal-1",
    state: "completed",
    startedAt: NOW,
    completedAt: NOW,
  };
}

function makeLifecycleEvent(): FridayPackageLifecycleEvent {
  return {
    id: "event-1",
    packageName: "@friday/core",
    packageVersion: "1.0.0",
    operation: "install",
    stateFrom: "verifying",
    stateTo: "active",
    principalId: "principal-1",
    tenantId: "tenant-1",
    details: {
      reason: "ok",
      stateFrom: "verifying",
      stateTo: "active",
    },
    createdAt: NOW,
  };
}

function makeRegistryMock(overrides: Partial<RegistryManager> = {}): RegistryManager {
  const entry = makeRegistryEntry();
  const registry: RegistryManager = {
    publish: vi.fn(() => entry),
    checkDuplicate: vi.fn(() => ({ isDuplicate: false, isSameContent: false })),
    checkDuplicateForTenant: vi.fn(() => ({ isDuplicate: false, isSameContent: false })),
    getById: vi.fn(() => entry),
    getByNameVersion: vi.fn(() => entry),
    getByNameVersionForTenant: vi.fn(() => entry),
    getLatest: vi.fn(() => entry),
    getLatestForTenant: vi.fn(() => entry),
    getVersions: vi.fn(() => [entry]),
    getVersionsForTenant: vi.fn(() => [entry]),
    getVersionCount: vi.fn(() => 1),
    getVersionCountForTenant: vi.fn(() => 1),
    resolveVersion: vi.fn(() => entry),
    resolveVersionForTenant: vi.fn(() => entry),
    search: vi.fn(() => ({ items: [entry] })),
    remove: vi.fn(() => false),
    count: vi.fn(() => 1),
  };
  return {
    ...registry,
    ...overrides,
  };
}

function makeInstallerMock(overrides: Partial<PackageInstaller> = {}): PackageInstaller {
  const install = makeInstall();
  const dependencyResult = makeDependencyResult();
  const verification = makeVerification();
  const rollback = makeRollback();
  const lifecycle = makeLifecycleEvent();
  const installer: PackageInstaller = {
    install: vi.fn(() => ({
      success: true,
      install,
      dependencies: dependencyResult,
      verification,
    })),
    upgrade: vi.fn(() => ({
      success: true,
      install,
      previousVersion: "0.9.0",
      dependencies: dependencyResult,
      verification,
    })),
    uninstall: vi.fn(() => ({
      success: true,
      install,
    })),
    rollback: vi.fn(() => ({
      success: true,
      rollback,
      install,
    })),
    getInstall: vi.fn(() => install),
    getVerification: vi.fn(() => verification),
    getActiveInstall: vi.fn(() => install),
    listInstalls: vi.fn(() => [install]),
    listRollbacks: vi.fn(() => [rollback]),
    listLifecycleEvents: vi.fn(() => [lifecycle]),
    activeInstallCount: vi.fn(() => 0),
    transitionState: vi.fn(() => install),
  };
  return {
    ...installer,
    ...overrides,
  };
}

describe("createFridayPackagingApiHandlers", () => {
  it("maps install request/response through installer", () => {
    const registry = makeRegistryMock();
    const installer = makeInstallerMock();
    const handlers = createFridayPackagingApiHandlers({
      registry,
      installer,
      principalId: "principal-1",
      platformVersion: "0.5.0",
    });

    const response = handlers.installPackage("@friday/core", {
      version: "1.0.0",
      tenantId: "tenant-1",
      idempotencyKey: "idem-1",
    });

    expect(response.install.packageName).toBe("@friday/core");
    expect(response.dependencies).toHaveLength(1);
    expect(response.verification.valid).toBe(true);
    expect(installer.install).toHaveBeenCalledWith({
      packageName: "@friday/core",
      version: "1.0.0",
      tenantId: "tenant-1",
      installedBy: "principal-1",
      idempotencyKey: "idem-1",
      platformVersion: "0.5.0",
    });
  });

  it("throws FridayPackagingApiError when install fails", () => {
    const registry = makeRegistryMock();
    const installer = makeInstallerMock({
      install: vi.fn(() => ({
        success: false,
        install: null,
        dependencies: null,
        verification: null,
        error: "not installable",
        errorCode: "PACKAGING_NOT_INSTALLABLE",
      })),
    });
    const handlers = createFridayPackagingApiHandlers({
      registry,
      installer,
      principalId: "principal-1",
      platformVersion: "0.5.0",
    });

    try {
      handlers.installPackage("@friday/core", {
        tenantId: "tenant-1",
        idempotencyKey: "idem-1",
      });
      throw new Error("Expected installPackage to throw");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(FridayPackagingApiError);
      if (error instanceof FridayPackagingApiError) {
        expect(error.code).toBe("PACKAGING_NOT_INSTALLABLE");
      }
    }
  });

  it("throws not-found error for checkDependencies when package is missing", () => {
    const registry = makeRegistryMock({
      getLatest: vi.fn(() => null),
      getByNameVersion: vi.fn(() => null),
    });
    const installer = makeInstallerMock();
    const handlers = createFridayPackagingApiHandlers({
      registry,
      installer,
      principalId: "principal-1",
      platformVersion: "0.5.0",
    });

    try {
      handlers.checkDependencies("@friday/missing", { tenantId: "tenant-1" });
      throw new Error("Expected checkDependencies to throw");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(FridayPackagingApiError);
      if (error instanceof FridayPackagingApiError) {
        expect(error.code).toBe("PACKAGING_PACKAGE_NOT_FOUND");
        expect(error.status).toBe(404);
      }
    }
  });
});

describe("runFridayPackagingCliCommand", () => {
  it("routes each command to the matching handler", () => {
    const handlers: FridayPackagingApiHandlers = {
      installPackage: vi.fn(() => ({ install: makeInstall(), dependencies: [], verification: makeVerification() })),
      upgradePackage: vi.fn(() => ({
        install: makeInstall(),
        previousVersion: "0.9.0",
        dependencies: [],
        verification: makeVerification(),
      })),
      rollbackPackage: vi.fn(() => ({ rollback: makeRollback(), install: makeInstall() })),
      uninstallPackage: vi.fn(() => ({ install: makeInstall() })),
      checkDependencies: vi.fn(() => ({ success: true, resolved: [], conflicts: [] })),
      listInstalls: vi.fn(() => ({ items: [] })),
      getInstall: vi.fn(() => ({
        install: makeInstall(),
        package: makeRegistryEntry(),
        rollbacks: [],
      })),
      listLifecycleEvents: vi.fn(() => ({ items: [] })),
    };

    runFridayPackagingCliCommand(handlers, {
      command: "install",
      packageName: "@friday/core",
      request: { tenantId: "tenant-1", idempotencyKey: "id-1" },
    });
    runFridayPackagingCliCommand(handlers, {
      command: "upgrade",
      packageName: "@friday/core",
      request: { tenantId: "tenant-1", etag: "etag-1", idempotencyKey: "id-2" },
    });
    runFridayPackagingCliCommand(handlers, {
      command: "rollback",
      packageName: "@friday/core",
      request: {
        tenantId: "tenant-1",
        targetVersion: "1.0.0",
        etag: "etag-1",
        reason: "rollback",
        idempotencyKey: "id-3",
      },
    });
    runFridayPackagingCliCommand(handlers, {
      command: "uninstall",
      packageName: "@friday/core",
      request: { tenantId: "tenant-1", etag: "etag-1", idempotencyKey: "id-4" },
    });
    runFridayPackagingCliCommand(handlers, {
      command: "check-dependencies",
      packageName: "@friday/core",
      request: { tenantId: "tenant-1" },
    });

    expect(handlers.installPackage).toHaveBeenCalledOnce();
    expect(handlers.upgradePackage).toHaveBeenCalledOnce();
    expect(handlers.rollbackPackage).toHaveBeenCalledOnce();
    expect(handlers.uninstallPackage).toHaveBeenCalledOnce();
    expect(handlers.checkDependencies).toHaveBeenCalledOnce();
  });
});
