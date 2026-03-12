import { describe, it, expect, beforeEach } from "vitest";
import { FridayRuleIndex, buildIndexKey } from "../../../../src/rules/engine/rule-index.js";
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

// ─── Tests ───

describe("FridayRuleIndex", () => {
  let index: FridayRuleIndex;

  beforeEach(() => {
    index = new FridayRuleIndex();
  });

  it("starts empty", () => {
    expect(index.size).toBe(0);
    expect(index.findRules("shell", "execute")).toEqual([]);
  });

  it("indexes active rules", () => {
    const bundle = makeBundle();
    const rule = makeRule();

    index.rebuild([{ bundle, rules: [rule] }]);

    expect(index.size).toBe(1);
    const found = index.findRules("shell", "execute");
    expect(found).toHaveLength(1);
    expect(found[0].rule.id).toBe("rule-1");
  });

  it("skips disabled bundles", () => {
    const bundle = makeBundle({ enabled: false });
    const rule = makeRule();

    index.rebuild([{ bundle, rules: [rule] }]);

    expect(index.size).toBe(0);
  });

  it("skips disabled rules", () => {
    const bundle = makeBundle();
    const rule = makeRule({ enabled: false });

    index.rebuild([{ bundle, rules: [rule] }]);

    expect(index.size).toBe(0);
  });

  it("skips soft-deleted rules", () => {
    const bundle = makeBundle();
    const rule = makeRule({ deletedAt: "2026-01-02T00:00:00Z" });

    index.rebuild([{ bundle, rules: [rule] }]);

    expect(index.size).toBe(0);
  });

  it("sorts rules by effective priority (ascending)", () => {
    const bundle = makeBundle({ priority: 10 });
    const ruleA = makeRule({ id: "a", priority: 200 });
    const ruleB = makeRule({ id: "b", priority: 50 });

    index.rebuild([{ bundle, rules: [ruleA, ruleB] }]);

    const found = index.findRules("shell", "execute");
    expect(found[0].rule.id).toBe("b");
    expect(found[1].rule.id).toBe("a");
  });

  it("uses tuple ordering so bundle precedence is never bypassed by large rule priorities", () => {
    const highPriorityBundle = makeBundle({ id: "b-high", priority: 10 });
    const lowPriorityBundle = makeBundle({ id: "b-low", priority: 11 });
    const highRulePriority = makeRule({ id: "r-high", policyBundleId: "b-high", priority: 5000 });
    const lowRulePriority = makeRule({ id: "r-low", policyBundleId: "b-low", priority: 1 });

    index.rebuild([
      { bundle: highPriorityBundle, rules: [highRulePriority] },
      { bundle: lowPriorityBundle, rules: [lowRulePriority] },
    ]);

    const found = index.findRules("shell", "execute");
    expect(found).toHaveLength(2);
    expect(found[0].rule.id).toBe("r-high");
    expect(found[0].effectivePriority).toBeLessThan(found[1].effectivePriority);
  });

  it("returns immutable snapshots from findRules", () => {
    const bundle = makeBundle();
    const rule = makeRule();
    index.rebuild([{ bundle, rules: [rule] }]);

    const first = index.findRules("shell", "execute");
    expect(() => {
      first[0].rule.name = "mutated";
    }).toThrow();

    const second = index.findRules("shell", "execute");
    expect(second[0].rule.name).toBe("Test Rule");
  });

  it("handles multiple resource:action buckets", () => {
    const bundle = makeBundle();
    const rule1 = makeRule({ id: "r1", resource: "shell", action: "execute" });
    const rule2 = makeRule({ id: "r2", resource: "filesystem", action: "write" });

    index.rebuild([{ bundle, rules: [rule1, rule2] }]);

    expect(index.size).toBe(2);
    expect(index.findRules("shell", "execute")).toHaveLength(1);
    expect(index.findRules("filesystem", "write")).toHaveLength(1);
    expect(index.findRules("network", "connect")).toEqual([]);
  });

  it("handles multiple bundles", () => {
    const bundle1 = makeBundle({ id: "b1", priority: 10 });
    const bundle2 = makeBundle({ id: "b2", priority: 20 });
    const rule1 = makeRule({ id: "r1", policyBundleId: "b1" });
    const rule2 = makeRule({ id: "r2", policyBundleId: "b2" });

    index.rebuild([
      { bundle: bundle1, rules: [rule1] },
      { bundle: bundle2, rules: [rule2] },
    ]);

    expect(index.size).toBe(2);
    const found = index.findRules("shell", "execute");
    expect(found).toHaveLength(2);
    // bundle1 has lower priority number, so its rule comes first.
    expect(found[0].rule.id).toBe("r1");
  });

  it("clears the index", () => {
    index.rebuild([{ bundle: makeBundle(), rules: [makeRule()] }]);
    expect(index.size).toBe(1);

    index.clear();
    expect(index.size).toBe(0);
  });

  it("getAllRules returns all indexed rules", () => {
    const bundle = makeBundle();
    const rule1 = makeRule({ id: "r1", resource: "shell", action: "execute" });
    const rule2 = makeRule({ id: "r2", resource: "filesystem", action: "write" });

    index.rebuild([{ bundle, rules: [rule1, rule2] }]);

    expect(index.getAllRules()).toHaveLength(2);
  });
});

// ─── buildIndexKey ───

describe("buildIndexKey", () => {
  it("creates composite key", () => {
    expect(buildIndexKey("shell", "execute")).toBe("shell:execute");
    expect(buildIndexKey("filesystem", "write")).toBe("filesystem:write");
  });
});
