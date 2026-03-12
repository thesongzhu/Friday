import { describe, it, expect, beforeEach } from "vitest";
import { createRegistryManager } from "../../../../src/packaging/engine/registry-manager.js";
import type { RegistryManager, PublishOptions } from "../../../../src/packaging/engine/registry-manager.js";
import type {
  FridayPackageManifest,
  FridayPackageSignature,
} from "../../../../src/packaging/model/friday-packaging.types.js";

// ─── Fixtures ───

const NOW = "2026-02-24T12:00:00.000Z";
let idCounter = 0;

function makeConfig() {
  return {
    generateId: () => `id-${++idCounter}`,
    nowIso: () => NOW,
  };
}

function makeManifest(overrides: Partial<FridayPackageManifest> = {}): FridayPackageManifest {
  return {
    name: "@friday/test-pkg",
    version: "1.0.0",
    description: "Test package",
    author: { name: "Test Author" },
    capabilities: ["skill:test"],
    dependencies: {},
    fridayVersionRange: ">=0.1.0",
    assets: {},
    ...overrides,
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

function makePublishOptions(overrides: Partial<PublishOptions> = {}): PublishOptions {
  return {
    manifest: makeManifest(),
    signature: makeSignature(),
    archiveDigest: "sha256:abc",
    manifestDigest: "sha256:def",
    sizeBytes: 1024,
    publishedBy: "user-1",
    ...overrides,
  };
}

// ─── Tests ───

describe("RegistryManager", () => {
  let registry: RegistryManager;

  beforeEach(() => {
    idCounter = 0;
    registry = createRegistryManager(makeConfig());
  });

  describe("publish", () => {
    it("publishes a package and returns a registry entry", () => {
      const entry = registry.publish(makePublishOptions());
      expect(entry.id).toBe("id-1");
      expect(entry.name).toBe("@friday/test-pkg");
      expect(entry.version).toBe("1.0.0");
      expect(entry.publishedBy).toBe("user-1");
      expect(entry.createdAt).toBe(NOW);
    });

    it("assigns unique IDs to different entries", () => {
      const e1 = registry.publish(makePublishOptions());
      const e2 = registry.publish(
        makePublishOptions({
          manifest: makeManifest({ version: "2.0.0" }),
        }),
      );
      expect(e1.id).not.toBe(e2.id);
    });

    it("stores tenant ID when provided", () => {
      const entry = registry.publish(makePublishOptions({ tenantId: "tenant-1" }));
      expect(entry.tenantId).toBe("tenant-1");
    });

    it("is idempotent for same scoped package content", () => {
      const first = registry.publish(makePublishOptions());
      const second = registry.publish(makePublishOptions());

      expect(second.id).toBe(first.id);
      expect(registry.count()).toBe(1);
    });

    it("throws for duplicate scoped version with different content", () => {
      registry.publish(makePublishOptions());
      expect(() =>
        registry.publish(makePublishOptions({ archiveDigest: "sha256:other" })),
      ).toThrow(/different content/i);
    });

    it("allows same name+version for different tenants", () => {
      const globalEntry = registry.publish(makePublishOptions());
      const tenantEntry = registry.publish(makePublishOptions({ tenantId: "tenant-1" }));

      expect(globalEntry.id).not.toBe(tenantEntry.id);
      expect(registry.count()).toBe(2);
    });
  });

  describe("getById", () => {
    it("retrieves a published package by ID", () => {
      const entry = registry.publish(makePublishOptions());
      expect(registry.getById(entry.id)).toEqual(entry);
    });

    it("returns null for non-existent ID", () => {
      expect(registry.getById("nonexistent")).toBeNull();
    });
  });

  describe("getByNameVersion", () => {
    it("retrieves by name and version", () => {
      registry.publish(makePublishOptions());
      const result = registry.getByNameVersion("@friday/test-pkg", "1.0.0");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("@friday/test-pkg");
    });

    it("returns null for unknown name/version", () => {
      expect(registry.getByNameVersion("@friday/unknown", "1.0.0")).toBeNull();
    });

    it("supports tenant-aware lookup with global fallback", () => {
      const globalEntry = registry.publish(makePublishOptions());
      const tenantEntry = registry.publish(makePublishOptions({ tenantId: "tenant-1" }));

      const tenantResult = registry.getByNameVersion("@friday/test-pkg", "1.0.0", "tenant-1");
      const fallbackResult = registry.getByNameVersion("@friday/test-pkg", "1.0.0", "tenant-2");

      expect(tenantResult!.id).toBe(tenantEntry.id);
      expect(fallbackResult!.id).toBe(globalEntry.id);
    });
  });

  describe("getLatest", () => {
    it("returns the highest version", () => {
      registry.publish(makePublishOptions({ manifest: makeManifest({ version: "1.0.0" }) }));
      registry.publish(makePublishOptions({ manifest: makeManifest({ version: "2.0.0" }) }));
      registry.publish(makePublishOptions({ manifest: makeManifest({ version: "1.5.0" }) }));

      const latest = registry.getLatest("@friday/test-pkg");
      expect(latest).not.toBeNull();
      expect(latest!.version).toBe("2.0.0");
    });

    it("returns null for unknown package", () => {
      expect(registry.getLatest("@friday/unknown")).toBeNull();
    });

    it("returns tenant latest when tenant-specific versions exist", () => {
      registry.publish(makePublishOptions({ manifest: makeManifest({ version: "1.0.0" }) }));
      registry.publish(makePublishOptions({
        tenantId: "tenant-1",
        manifest: makeManifest({ version: "2.0.0" }),
      }));

      expect(registry.getLatest("@friday/test-pkg", "tenant-1")!.version).toBe("2.0.0");
      expect(registry.getLatest("@friday/test-pkg", "tenant-2")!.version).toBe("1.0.0");
    });
  });

  describe("getVersions", () => {
    it("returns all versions sorted descending", () => {
      registry.publish(makePublishOptions({ manifest: makeManifest({ version: "1.0.0" }) }));
      registry.publish(makePublishOptions({ manifest: makeManifest({ version: "3.0.0" }) }));
      registry.publish(makePublishOptions({ manifest: makeManifest({ version: "2.0.0" }) }));

      const versions = registry.getVersions("@friday/test-pkg");
      expect(versions.map((v) => v.version)).toEqual(["3.0.0", "2.0.0", "1.0.0"]);
    });

    it("returns empty array for unknown package", () => {
      expect(registry.getVersions("@friday/unknown")).toHaveLength(0);
    });
  });

  describe("getVersionCount", () => {
    it("returns correct count", () => {
      registry.publish(makePublishOptions({ manifest: makeManifest({ version: "1.0.0" }) }));
      registry.publish(makePublishOptions({ manifest: makeManifest({ version: "2.0.0" }) }));
      expect(registry.getVersionCount("@friday/test-pkg")).toBe(2);
    });
  });

  describe("resolveVersion", () => {
    it("resolves highest version matching a range", () => {
      registry.publish(makePublishOptions({ manifest: makeManifest({ version: "1.0.0" }) }));
      registry.publish(makePublishOptions({ manifest: makeManifest({ version: "1.5.0" }) }));
      registry.publish(makePublishOptions({ manifest: makeManifest({ version: "2.0.0" }) }));

      const result = registry.resolveVersion("@friday/test-pkg", "^1.0.0");
      expect(result).not.toBeNull();
      expect(result!.version).toBe("1.5.0");
    });

    it("returns null when no version satisfies the range", () => {
      registry.publish(makePublishOptions({ manifest: makeManifest({ version: "1.0.0" }) }));
      const result = registry.resolveVersion("@friday/test-pkg", "^5.0.0");
      expect(result).toBeNull();
    });
  });

  describe("search", () => {
    beforeEach(() => {
      registry.publish(
        makePublishOptions({
          manifest: makeManifest({
            name: "@friday/skill-web",
            version: "1.0.0",
            capabilities: ["skill:web-search"],
            metadata: { keywords: ["web", "search"] },
          }),
        }),
      );
      registry.publish(
        makePublishOptions({
          manifest: makeManifest({
            name: "@friday/skill-code",
            version: "2.0.0",
            capabilities: ["skill:code-analysis"],
            metadata: { keywords: ["code", "analysis"] },
          }),
        }),
      );
      registry.publish(
        makePublishOptions({
          manifest: makeManifest({
            name: "@friday/provider-openai",
            version: "1.0.0",
            capabilities: ["provider:openai"],
            metadata: { keywords: ["ai", "provider"] },
          }),
        }),
      );
    });

    it("lists all packages without filters", () => {
      const result = registry.search({});
      expect(result.items.length).toBe(3);
    });

    it("filters by name prefix", () => {
      const result = registry.search({ name: "@friday/skill" });
      expect(result.items.length).toBe(2);
    });

    it("filters by capability", () => {
      const result = registry.search({ capability: "skill:web-search" });
      expect(result.items.length).toBe(1);
      expect(result.items[0].name).toBe("@friday/skill-web");
    });

    it("filters by keyword", () => {
      const result = registry.search({ keyword: "code" });
      expect(result.items.length).toBe(1);
      expect(result.items[0].name).toBe("@friday/skill-code");
    });

    it("paginates with limit", () => {
      const page1 = registry.search({}, { limit: 2 });
      expect(page1.items.length).toBe(2);
      expect(page1.nextCursor).toBeDefined();

      const page2 = registry.search({}, { cursor: page1.nextCursor, limit: 2 });
      expect(page2.items.length).toBe(1);
      expect(page2.nextCursor).toBeUndefined();
    });

    it("sorts by name ascending", () => {
      const result = registry.search({ sortBy: "name", sortDir: "asc" });
      const names = result.items.map((i) => i.name);
      expect(names).toEqual([...names].sort());
    });

    it("sorts by name descending", () => {
      const result = registry.search({ sortBy: "name", sortDir: "desc" });
      const names = result.items.map((i) => i.name);
      expect(names).toEqual([...names].sort().reverse());
    });

    it("de-duplicates multiple versions of same package", () => {
      // Publish another version of @friday/skill-web
      registry.publish(
        makePublishOptions({
          manifest: makeManifest({
            name: "@friday/skill-web",
            version: "2.0.0",
            capabilities: ["skill:web-search"],
            metadata: { keywords: ["web", "search"] },
          }),
        }),
      );
      const result = registry.search({ name: "@friday/skill-web" });
      expect(result.items.length).toBe(1);
      expect(result.items[0].version).toBe("2.0.0"); // latest
    });
  });

  describe("remove", () => {
    it("soft-deletes a package", () => {
      const entry = registry.publish(makePublishOptions());
      expect(registry.remove(entry.id)).toBe(true);
      expect(registry.getById(entry.id)).toBeNull();
      expect(registry.count()).toBe(0);
    });

    it("returns false for non-existent ID", () => {
      expect(registry.remove("nonexistent")).toBe(false);
    });

    it("returns false for already-deleted entry", () => {
      const entry = registry.publish(makePublishOptions());
      registry.remove(entry.id);
      expect(registry.remove(entry.id)).toBe(false);
    });
  });

  describe("count", () => {
    it("returns 0 for empty registry", () => {
      expect(registry.count()).toBe(0);
    });

    it("returns correct count after publishes", () => {
      registry.publish(makePublishOptions({ manifest: makeManifest({ version: "1.0.0" }) }));
      registry.publish(makePublishOptions({ manifest: makeManifest({ version: "2.0.0" }) }));
      expect(registry.count()).toBe(2);
    });
  });

  describe("checkDuplicate", () => {
    it("returns not duplicate for new package", () => {
      const result = registry.checkDuplicate("@friday/test", "1.0.0");
      expect(result.isDuplicate).toBe(false);
    });

    it("returns duplicate for existing package", () => {
      registry.publish(makePublishOptions());
      const result = registry.checkDuplicate("@friday/test-pkg", "1.0.0");
      expect(result.isDuplicate).toBe(true);
      expect(result.existingEntry).toBeDefined();
    });

    it("reports same-content duplicates when digests match", () => {
      registry.publish(makePublishOptions());
      const result = registry.checkDuplicate(
        "@friday/test-pkg",
        "1.0.0",
        undefined,
        "sha256:abc",
        "sha256:def",
      );

      expect(result.isDuplicate).toBe(true);
      expect(result.isSameContent).toBe(true);
    });

    it("scopes duplicate checks by tenant", () => {
      registry.publish(makePublishOptions({ tenantId: "tenant-1" }));

      const tenantDuplicate = registry.checkDuplicate("@friday/test-pkg", "1.0.0", "tenant-1");
      const globalDuplicate = registry.checkDuplicate("@friday/test-pkg", "1.0.0");

      expect(tenantDuplicate.isDuplicate).toBe(true);
      expect(globalDuplicate.isDuplicate).toBe(false);
    });
  });

  describe("immutability", () => {
    it("returns frozen snapshots from getters", () => {
      const entry = registry.publish(makePublishOptions());
      const fetched = registry.getById(entry.id)!;

      expect(Object.isFrozen(fetched)).toBe(true);
      expect(() => {
        (fetched as unknown as { name: string }).name = "mutated";
      }).toThrow(TypeError);
      expect(() => {
        (fetched.author as unknown as { name: string }).name = "mutated";
      }).toThrow(TypeError);
    });

    it("returns frozen snapshots from search results", () => {
      registry.publish(makePublishOptions());
      const result = registry.search({});

      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.items)).toBe(true);
      expect(() => {
        (result.items[0] as unknown as { version: string }).version = "9.9.9";
      }).toThrow(TypeError);
    });
  });
});
