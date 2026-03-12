import { describe, it, expect, beforeEach } from "vitest";
import { resolveDependencies, checkInstallConflicts } from "../../../../src/packaging/engine/dependency-resolver.js";
import { createRegistryManager } from "../../../../src/packaging/engine/registry-manager.js";
import type { RegistryManager, PublishOptions } from "../../../../src/packaging/engine/registry-manager.js";
import type {
  FridayPackageManifest,
  FridayPackageSignature,
} from "../../../../src/packaging/model/friday-packaging.types.js";

// ─── Fixtures ───

const NOW = "2026-02-24T12:00:00.000Z";
const PLATFORM_VERSION = "0.5.0";
let idCounter = 0;

function makeConfig() {
  return {
    generateId: () => `id-${++idCounter}`,
    nowIso: () => NOW,
  };
}

function makeSignature(): FridayPackageSignature {
  return {
    algorithm: "Ed25519",
    publicKey: "key",
    signature: "sig",
    digest: "sha256:abc",
    manifestDigest: "sha256:def",
    timestamp: NOW,
    expiresAt: "2027-01-01T00:00:00.000Z",
    keyId: "key-1",
  };
}

function publishPkg(
  registry: RegistryManager,
  name: string,
  version: string,
  deps: Record<string, string> = {},
  peerDeps: Record<string, string> = {},
  fridayVersionRange: string = ">=0.1.0",
): void {
  const manifest: FridayPackageManifest = {
    name,
    version,
    description: `Package ${name}`,
    author: { name: "Test" },
    capabilities: ["skill:test"],
    dependencies: deps,
    peerDependencies: Object.keys(peerDeps).length > 0 ? peerDeps : undefined,
    fridayVersionRange,
    assets: {},
  };
  registry.publish({
    manifest,
    signature: makeSignature(),
    archiveDigest: `sha256:${name}-${version}`,
    manifestDigest: `sha256:${name}-${version}-m`,
    sizeBytes: 1024,
    publishedBy: "user-1",
  });
}

// ─── Tests ───

describe("resolveDependencies", () => {
  let registry: RegistryManager;

  beforeEach(() => {
    idCounter = 0;
    registry = createRegistryManager(makeConfig());
  });

  it("resolves a package with no dependencies", () => {
    publishPkg(registry, "@friday/core", "1.0.0");
    const result = resolveDependencies("@friday/core", "1.0.0", {
      registry,
      platformVersion: PLATFORM_VERSION,
    });
    expect(result.success).toBe(true);
    expect(result.resolved).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it("resolves direct dependencies", () => {
    publishPkg(registry, "@friday/utils", "2.0.0");
    publishPkg(registry, "@friday/utils", "2.1.0");
    publishPkg(registry, "@friday/core", "1.0.0", {
      "@friday/utils": "^2.0.0",
    });

    const result = resolveDependencies("@friday/core", "1.0.0", {
      registry,
      platformVersion: PLATFORM_VERSION,
    });

    expect(result.success).toBe(true);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].name).toBe("@friday/utils");
    expect(result.resolved[0].resolvedVersion).toBe("2.1.0");
    expect(result.resolved[0].direct).toBe(true);
  });

  it("resolves transitive dependencies", () => {
    publishPkg(registry, "@friday/logger", "1.0.0");
    publishPkg(registry, "@friday/utils", "2.0.0", {
      "@friday/logger": "^1.0.0",
    });
    publishPkg(registry, "@friday/core", "1.0.0", {
      "@friday/utils": "^2.0.0",
    });

    const result = resolveDependencies("@friday/core", "1.0.0", {
      registry,
      platformVersion: PLATFORM_VERSION,
    });

    expect(result.success).toBe(true);
    expect(result.resolved).toHaveLength(2);
    const names = result.resolved.map((r) => r.name);
    expect(names).toContain("@friday/utils");
    expect(names).toContain("@friday/logger");
  });

  it("detects not-found root package", () => {
    const result = resolveDependencies("@friday/nonexistent", "1.0.0", {
      registry,
      platformVersion: PLATFORM_VERSION,
    });
    expect(result.success).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].type).toBe("not_found");
  });

  it("detects not-found dependency", () => {
    publishPkg(registry, "@friday/core", "1.0.0", {
      "@friday/missing": "^1.0.0",
    });

    const result = resolveDependencies("@friday/core", "1.0.0", {
      registry,
      platformVersion: PLATFORM_VERSION,
    });

    expect(result.success).toBe(false);
    expect(result.conflicts.some((c) => c.type === "not_found" && c.dependencyName === "@friday/missing")).toBe(true);
  });

  it("detects version incompatibility", () => {
    publishPkg(registry, "@friday/shared", "1.0.0");
    publishPkg(registry, "@friday/shared", "3.0.0");
    publishPkg(registry, "@friday/a", "1.0.0", { "@friday/shared": "^1.0.0" });
    publishPkg(registry, "@friday/b", "1.0.0", { "@friday/shared": "^3.0.0" });
    publishPkg(registry, "@friday/core", "1.0.0", {
      "@friday/a": "^1.0.0",
      "@friday/b": "^1.0.0",
    });

    const result = resolveDependencies("@friday/core", "1.0.0", {
      registry,
      platformVersion: PLATFORM_VERSION,
    });

    expect(result.success).toBe(false);
    expect(result.conflicts.some((c) => c.type === "version_incompatible")).toBe(true);
  });

  it("detects circular dependencies", () => {
    // A depends on B, B depends on A
    publishPkg(registry, "@friday/a", "1.0.0", { "@friday/b": "^1.0.0" });
    publishPkg(registry, "@friday/b", "1.0.0", { "@friday/a": "^1.0.0" });
    publishPkg(registry, "@friday/root", "1.0.0", { "@friday/a": "^1.0.0" });

    const result = resolveDependencies("@friday/root", "1.0.0", {
      registry,
      platformVersion: PLATFORM_VERSION,
    });

    expect(result.success).toBe(false);
    expect(result.conflicts.some((c) => c.type === "circular")).toBe(true);
  });

  it("detects platform incompatibility on root", () => {
    publishPkg(registry, "@friday/core", "1.0.0", {}, {}, ">=1.0.0");

    const result = resolveDependencies("@friday/core", "1.0.0", {
      registry,
      platformVersion: "0.5.0",
    });

    expect(result.success).toBe(false);
    expect(result.conflicts.some((c) => c.type === "platform_incompatible")).toBe(true);
  });

  it("detects platform incompatibility on dependency", () => {
    publishPkg(registry, "@friday/dep", "1.0.0", {}, {}, ">=1.0.0");
    publishPkg(registry, "@friday/core", "1.0.0", {
      "@friday/dep": "^1.0.0",
    });

    const result = resolveDependencies("@friday/core", "1.0.0", {
      registry,
      platformVersion: "0.5.0",
    });

    expect(result.success).toBe(false);
    expect(result.conflicts.some((c) => c.type === "platform_incompatible")).toBe(true);
  });

  it("validates peer dependencies", () => {
    publishPkg(registry, "@friday/peer", "1.0.0");
    publishPkg(registry, "@friday/core", "1.0.0", {}, {
      "@friday/peer": "^2.0.0",
    });

    const result = resolveDependencies("@friday/core", "1.0.0", {
      registry,
      platformVersion: PLATFORM_VERSION,
    });

    expect(result.success).toBe(false);
    expect(result.conflicts.some((c) => c.type === "peer_unsatisfied")).toBe(true);
  });

  it("resolves compatible versions across multiple requesters", () => {
    publishPkg(registry, "@friday/shared", "1.5.0");
    publishPkg(registry, "@friday/a", "1.0.0", { "@friday/shared": ">=1.0.0 <2.0.0" });
    publishPkg(registry, "@friday/b", "1.0.0", { "@friday/shared": "^1.2.0" });
    publishPkg(registry, "@friday/core", "1.0.0", {
      "@friday/a": "^1.0.0",
      "@friday/b": "^1.0.0",
    });

    const result = resolveDependencies("@friday/core", "1.0.0", {
      registry,
      platformVersion: PLATFORM_VERSION,
    });

    expect(result.success).toBe(true);
    const shared = result.resolved.find((r) => r.name === "@friday/shared");
    expect(shared).toBeDefined();
    expect(shared!.resolvedVersion).toBe("1.5.0");
  });

  it("chooses semver-highest dependency version (10.x over 2.x)", () => {
    publishPkg(registry, "@friday/shared", "2.9.0");
    publishPkg(registry, "@friday/shared", "10.1.0");
    publishPkg(registry, "@friday/core", "1.0.0", {
      "@friday/shared": ">=2.0.0 <11.0.0",
    });

    const result = resolveDependencies("@friday/core", "1.0.0", {
      registry,
      platformVersion: PLATFORM_VERSION,
    });

    expect(result.success).toBe(true);
    const shared = result.resolved.find((r) => r.name === "@friday/shared");
    expect(shared).toBeDefined();
    expect(shared!.resolvedVersion).toBe("10.1.0");
  });
});

// ─── checkInstallConflicts ───

describe("checkInstallConflicts", () => {
  it("returns empty for no conflicts", () => {
    const resolved = [
      {
        name: "@friday/utils",
        requestedRange: "^2.0.0",
        resolvedVersion: "2.1.0",
        registryEntryId: "id-1",
        direct: true,
        requestedBy: "@friday/core",
      },
    ];
    const installed = new Map([["@friday/utils", "2.1.0"]]);
    const conflicts = checkInstallConflicts(resolved, installed);
    expect(conflicts).toHaveLength(0);
  });

  it("detects conflict with installed version", () => {
    const resolved = [
      {
        name: "@friday/utils",
        requestedRange: "^3.0.0",
        resolvedVersion: "3.0.0",
        registryEntryId: "id-1",
        direct: true,
        requestedBy: "@friday/core",
      },
    ];
    const installed = new Map([["@friday/utils", "2.0.0"]]);
    const conflicts = checkInstallConflicts(resolved, installed);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].type).toBe("version_incompatible");
  });

  it("no conflict when installed version satisfies the range", () => {
    const resolved = [
      {
        name: "@friday/utils",
        requestedRange: "^2.0.0",
        resolvedVersion: "2.5.0",
        registryEntryId: "id-1",
        direct: true,
        requestedBy: "@friday/core",
      },
    ];
    const installed = new Map([["@friday/utils", "2.3.0"]]);
    const conflicts = checkInstallConflicts(resolved, installed);
    expect(conflicts).toHaveLength(0);
  });
});
