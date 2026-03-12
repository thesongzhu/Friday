import { describe, it, expect, beforeEach } from "vitest";
import { FridayPolicyBundleManager } from "../../../../src/rules/engine/policy-bundle-manager.js";
import { FridayRuleIndex } from "../../../../src/rules/engine/rule-index.js";
import {
  createParsedBundleSigningPayload,
  createPolicyBundleSignature,
} from "../../../../src/rules/engine/policy-bundle-signature.js";
import { parsePolicyBundleDocument } from "../../../../src/rules/engine/dsl-parser.js";
import type { FridayPolicyBundle, FridayRule } from "../../../../src/rules/model/friday-rules-engine.types.js";

// ─── Helpers ───

function makeBundle(overrides: Partial<FridayPolicyBundle> = {}): FridayPolicyBundle {
  return {
    id: "bundle-1",
    name: "Test Bundle",
    version: 1,
    priority: 100,
    enabled: true,
    tags: [],
    source: "user",
    etag: "etag-1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeRule(overrides: Partial<FridayRule> = {}): FridayRule {
  return {
    id: "rule-1",
    policyBundleId: "bundle-1",
    name: "Test Rule",
    enabled: true,
    resource: "shell",
    action: "execute",
    conditions: {},
    decision: "deny",
    priority: 100,
    version: 1,
    etag: "etag-r1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const VALID_YAML = `
apiVersion: friday/rules/v1
kind: PolicyBundle
metadata:
  id: yaml-bundle
  name: YAML Bundle
  version: 1
  priority: 50
rules:
  - id: deny-rm
    name: Block rm
    resource: shell
    action: execute
    decision: deny
    message: Blocked rm
    conditions:
      all:
        - field: args.command
          operator: contains
          value: "rm"
`;

const VALID_JSON_DOC = JSON.stringify({
  apiVersion: "friday/rules/v1",
  kind: "PolicyBundle",
  metadata: {
    id: "json-bundle",
    name: "JSON Bundle",
    version: 1,
  },
  rules: [
    {
      id: "audit-all",
      name: "Audit all",
      resource: "filesystem",
      action: "write",
      decision: "audit",
    },
  ],
});

function makeSignedObjectDoc(
  overrides: {
    id?: string;
    keyId?: string;
    secret?: string;
  } = {},
) {
  const keyId = overrides.keyId ?? "bundle-key";
  const secret = overrides.secret ?? "test-secret";
  const doc = {
    apiVersion: "friday/rules/v1",
    kind: "PolicyBundle",
    metadata: {
      id: overrides.id ?? "signed-bundle",
      name: "Signed Bundle",
      version: 1,
      priority: 20,
    },
    rules: [
      {
        id: "deny-danger",
        name: "Deny danger",
        resource: "shell",
        action: "execute",
        decision: "deny",
        conditions: {
          all: [{ field: "args.command", operator: "contains", value: "danger" }],
        },
      },
    ],
  };

  const parsed = parsePolicyBundleDocument(doc);
  const signature = createPolicyBundleSignature(
    createParsedBundleSigningPayload(parsed),
    secret,
  );

  (doc.metadata as Record<string, unknown>).signature = {
    algorithm: "hmac-sha256",
    keyId,
    value: signature,
  };

  return doc;
}

// ─── Tests ───

describe("FridayPolicyBundleManager", () => {
  let index: FridayRuleIndex;
  let manager: FridayPolicyBundleManager;

  beforeEach(() => {
    index = new FridayRuleIndex();
    manager = new FridayPolicyBundleManager(index);
  });

  describe("loadFromYaml", () => {
    it("loads a valid YAML bundle", async () => {
      const loaded = await manager.loadFromYaml(VALID_YAML);

      expect(loaded.bundle.id).toBe("yaml-bundle");
      expect(loaded.bundle.name).toBe("YAML Bundle");
      expect(loaded.bundle.priority).toBe(50);
      expect(loaded.bundle.source).toBe("import");
      expect(loaded.rules).toHaveLength(1);
      expect(loaded.rules[0].id).toBe("deny-rm");
      expect(loaded.rules[0].decision).toBe("deny");
    });

    it("rebuilds the index after loading", async () => {
      await manager.loadFromYaml(VALID_YAML);
      expect(index.size).toBe(1);
      expect(index.findRules("shell", "execute")).toHaveLength(1);
    });
  });

  describe("loadFromJson", () => {
    it("loads a valid JSON bundle", () => {
      const loaded = manager.loadFromJson(VALID_JSON_DOC);

      expect(loaded.bundle.id).toBe("json-bundle");
      expect(loaded.rules).toHaveLength(1);
      expect(loaded.rules[0].id).toBe("audit-all");
    });
  });

  describe("loadDomainBundle", () => {
    it("loads pre-constructed domain entities", () => {
      const bundle = makeBundle();
      const rules = [makeRule()];

      const loaded = manager.loadDomainBundle(bundle, rules);

      expect(loaded.bundle.id).toBe("bundle-1");
      expect(loaded.rules).toHaveLength(1);
      expect(index.size).toBe(1);
    });

    it("stores immutable snapshots and returns safe clones", () => {
      manager.loadDomainBundle(makeBundle(), [makeRule()]);

      const loaded = manager.getBundle("bundle-1");
      expect(loaded).toBeDefined();
      loaded!.bundle.name = "mutated-name";
      loaded!.rules[0].name = "mutated-rule";

      const reread = manager.getBundle("bundle-1");
      expect(reread!.bundle.name).toBe("Test Bundle");
      expect(reread!.rules[0].name).toBe("Test Rule");
    });

    it("rolls back cache state when index rebuild fails mid-load", async () => {
      class ThrowingRuleIndex extends FridayRuleIndex {
        throwOnNextRebuild = false;

        override rebuild(
          entries: ReadonlyArray<{ bundle: FridayPolicyBundle; rules: FridayRule[] }>,
        ): void {
          if (this.throwOnNextRebuild) {
            this.throwOnNextRebuild = false;
            throw new Error("forced rebuild failure");
          }
          super.rebuild(entries);
        }
      }

      const throwingIndex = new ThrowingRuleIndex();
      const rollbackManager = new FridayPolicyBundleManager(throwingIndex);
      await rollbackManager.loadFromYaml(VALID_YAML);

      throwingIndex.throwOnNextRebuild = true;
      expect(() => rollbackManager.loadFromJson(VALID_JSON_DOC)).toThrow("forced rebuild failure");

      expect(rollbackManager.getAllBundles()).toHaveLength(1);
      expect(rollbackManager.getBundle("yaml-bundle")).toBeDefined();
      expect(rollbackManager.getBundle("json-bundle")).toBeUndefined();
      expect(throwingIndex.size).toBe(1);
    });
  });

  describe("removeBundle", () => {
    it("removes a bundle and rebuilds the index", async () => {
      await manager.loadFromYaml(VALID_YAML);
      expect(index.size).toBe(1);

      const removed = manager.removeBundle("yaml-bundle");
      expect(removed).toBe(true);
      expect(index.size).toBe(0);
    });

    it("returns false for non-existent bundle", () => {
      expect(manager.removeBundle("nonexistent")).toBe(false);
    });
  });

  describe("getBundle", () => {
    it("returns a loaded bundle", async () => {
      await manager.loadFromYaml(VALID_YAML);
      const loaded = manager.getBundle("yaml-bundle");
      expect(loaded).toBeDefined();
      expect(loaded!.bundle.id).toBe("yaml-bundle");
    });

    it("returns undefined for non-existent bundle", () => {
      expect(manager.getBundle("nonexistent")).toBeUndefined();
    });
  });

  describe("getAllBundles", () => {
    it("returns all loaded bundles", async () => {
      await manager.loadFromYaml(VALID_YAML);
      manager.loadFromJson(VALID_JSON_DOC);

      const all = manager.getAllBundles();
      expect(all).toHaveLength(2);
    });
  });

  describe("getStats", () => {
    it("returns correct statistics", async () => {
      await manager.loadFromYaml(VALID_YAML);
      manager.loadFromJson(VALID_JSON_DOC);

      const stats = manager.getStats();
      expect(stats.bundleCount).toBe(2);
      expect(stats.ruleCount).toBe(2);
      expect(stats.enabledBundleCount).toBe(2);
      expect(stats.enabledRuleCount).toBe(2);
    });
  });

  describe("clear", () => {
    it("clears all bundles and the index", async () => {
      await manager.loadFromYaml(VALID_YAML);
      expect(manager.getAllBundles()).toHaveLength(1);
      expect(index.size).toBe(1);

      manager.clear();
      expect(manager.getAllBundles()).toHaveLength(0);
      expect(index.size).toBe(0);
    });
  });

  describe("signature verification", () => {
    it("loads a valid signed bundle when signatures are enforced", () => {
      manager = new FridayPolicyBundleManager(index, {
        signatureSecrets: { "bundle-key": "test-secret" },
        enforceBundleSignature: true,
      });

      const loaded = manager.loadFromObject(makeSignedObjectDoc());
      expect(loaded.bundle.id).toBe("signed-bundle");
      expect(loaded.rules).toHaveLength(1);
      expect(index.size).toBe(1);
    });

    it("rejects unsigned bundles when signatures are enforced", () => {
      manager = new FridayPolicyBundleManager(index, {
        signatureSecrets: { "bundle-key": "test-secret" },
        enforceBundleSignature: true,
      });

      expect(() => manager.loadFromJson(VALID_JSON_DOC)).toThrow("signature is required");
      expect(manager.getAllBundles()).toHaveLength(0);
      expect(index.size).toBe(0);
    });

    it("rejects invalid signatures and preserves prior cache/index state", () => {
      manager = new FridayPolicyBundleManager(index, {
        signatureSecrets: { "bundle-key": "test-secret" },
        enforceBundleSignature: true,
      });

      manager.loadFromObject(makeSignedObjectDoc({ id: "signed-valid" }));
      const beforeStats = manager.getStats();
      const beforeIndexSize = index.size;

      const tampered = makeSignedObjectDoc({ id: "signed-invalid" });
      (tampered.rules[0] as Record<string, unknown>).decision = "allow";

      expect(() => manager.loadFromObject(tampered)).toThrow("signature verification failed");

      const afterStats = manager.getStats();
      expect(afterStats).toEqual(beforeStats);
      expect(index.size).toBe(beforeIndexSize);
      expect(manager.getBundle("signed-invalid")).toBeUndefined();
      expect(manager.getBundle("signed-valid")).toBeDefined();
    });
  });
});
