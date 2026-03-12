import { describe, it, expect, beforeEach } from "vitest";
import {
  clearCache,
  resolveField,
  evaluateOperator,
  evaluateCondition,
  evaluateConditionGroup,
  precompileRegexPattern,
} from "../../../../src/rules/engine/condition-evaluator.js";
import type {
  FridayEvaluationContext,
  FridayRuleConditionGroup,
} from "../../../../src/rules/model/friday-rules-engine.types.js";

// ─── Helper ───

function makeContext(overrides: Partial<FridayEvaluationContext> = {}): FridayEvaluationContext {
  return {
    resource: "shell",
    action: "execute",
    args: { command: "ls -la", path: "/tmp" },
    source: "agent",
    ...overrides,
  };
}

// ─── resolveField ───

describe("resolveField", () => {
  const ctx = makeContext({
    args: { command: "rm -rf /", nested: { deep: { value: 42 } } },
    metadata: { user: { role: "admin" } },
  });

  it("resolves top-level fields", () => {
    expect(resolveField(ctx, "resource")).toBe("shell");
    expect(resolveField(ctx, "action")).toBe("execute");
    expect(resolveField(ctx, "source")).toBe("agent");
  });

  it("resolves nested args fields", () => {
    expect(resolveField(ctx, "args.command")).toBe("rm -rf /");
  });

  it("resolves deeply nested fields", () => {
    expect(resolveField(ctx, "args.nested.deep.value")).toBe(42);
  });

  it("resolves metadata fields", () => {
    expect(resolveField(ctx, "metadata.user.role")).toBe("admin");
  });

  it("returns undefined for missing fields", () => {
    expect(resolveField(ctx, "args.nonexistent")).toBeUndefined();
    expect(resolveField(ctx, "nonexistent")).toBeUndefined();
    expect(resolveField(ctx, "args.nested.deep.missing")).toBeUndefined();
  });

  it("returns undefined for paths through primitives", () => {
    expect(resolveField(ctx, "args.command.something")).toBeUndefined();
  });

  it("returns undefined for prototype-chain segments", () => {
    expect(resolveField(ctx, "args.__proto__.polluted")).toBeUndefined();
    expect(resolveField(ctx, "args.constructor.prototype")).toBeUndefined();
    expect(resolveField(ctx, "args.prototype.value")).toBeUndefined();
  });
});

// ─── evaluateOperator ───

describe("evaluateOperator", () => {
  describe("equals", () => {
    it("matches equal strings", () => {
      expect(evaluateOperator("equals", "foo", "foo")).toBe(true);
    });
    it("rejects unequal strings", () => {
      expect(evaluateOperator("equals", "foo", "bar")).toBe(false);
    });
    it("matches equal numbers", () => {
      expect(evaluateOperator("equals", 42, 42)).toBe(true);
    });
    it("rejects different types", () => {
      expect(evaluateOperator("equals", "42", 42)).toBe(false);
    });
  });

  describe("not_equals", () => {
    it("matches unequal values", () => {
      expect(evaluateOperator("not_equals", "foo", "bar")).toBe(true);
    });
    it("rejects equal values", () => {
      expect(evaluateOperator("not_equals", "foo", "foo")).toBe(false);
    });
  });

  describe("contains", () => {
    it("matches substring", () => {
      expect(evaluateOperator("contains", "hello world", "world")).toBe(true);
    });
    it("rejects missing substring", () => {
      expect(evaluateOperator("contains", "hello world", "xyz")).toBe(false);
    });
    it("returns false for non-string values", () => {
      expect(evaluateOperator("contains", 42, "4")).toBe(false);
    });
  });

  describe("matches", () => {
    it("matches regex pattern", () => {
      expect(evaluateOperator("matches", "rm -rf /tmp", "rm\\s+-rf")).toBe(true);
    });
    it("rejects non-matching pattern", () => {
      expect(evaluateOperator("matches", "ls -la", "rm\\s+-rf")).toBe(false);
    });
    it("returns false for invalid regex", () => {
      expect(evaluateOperator("matches", "test", "[invalid")).toBe(false);
    });
    it("returns false for non-string field value", () => {
      expect(evaluateOperator("matches", 42, "\\d+")).toBe(false);
    });
  });

  describe("in", () => {
    it("matches value in array", () => {
      expect(evaluateOperator("in", "foo", ["foo", "bar", "baz"])).toBe(true);
    });
    it("rejects value not in array", () => {
      expect(evaluateOperator("in", "qux", ["foo", "bar"])).toBe(false);
    });
    it("returns false for non-array condition", () => {
      expect(evaluateOperator("in", "foo", "foo")).toBe(false);
    });
  });

  describe("not_in", () => {
    it("matches value not in array", () => {
      expect(evaluateOperator("not_in", "qux", ["foo", "bar"])).toBe(true);
    });
    it("rejects value in array", () => {
      expect(evaluateOperator("not_in", "foo", ["foo", "bar"])).toBe(false);
    });
  });

  describe("numeric comparisons", () => {
    it("gt: true for greater values", () => {
      expect(evaluateOperator("gt", 10, 5)).toBe(true);
    });
    it("gt: false for equal values", () => {
      expect(evaluateOperator("gt", 5, 5)).toBe(false);
    });
    it("gte: true for equal values", () => {
      expect(evaluateOperator("gte", 5, 5)).toBe(true);
    });
    it("lt: true for lesser values", () => {
      expect(evaluateOperator("lt", 3, 5)).toBe(true);
    });
    it("lte: true for equal values", () => {
      expect(evaluateOperator("lte", 5, 5)).toBe(true);
    });
    it("returns false for non-numeric values", () => {
      expect(evaluateOperator("gt", "10", 5)).toBe(false);
    });
  });

  describe("existence", () => {
    it("exists: true for defined value", () => {
      expect(evaluateOperator("exists", "hello", undefined)).toBe(true);
    });
    it("exists: false for undefined", () => {
      expect(evaluateOperator("exists", undefined, undefined)).toBe(false);
    });
    it("exists: false for null", () => {
      expect(evaluateOperator("exists", null, undefined)).toBe(false);
    });
    it("not_exists: true for undefined", () => {
      expect(evaluateOperator("not_exists", undefined, undefined)).toBe(true);
    });
    it("not_exists: true for null", () => {
      expect(evaluateOperator("not_exists", null, undefined)).toBe(true);
    });
    it("not_exists: false for defined value", () => {
      expect(evaluateOperator("not_exists", "hello", undefined)).toBe(false);
    });
  });
});

// ─── evaluateConditionGroup ───

describe("evaluateConditionGroup", () => {
  const ctx = makeContext({
    args: { command: "rm -rf /tmp", host: "example.com", count: 5 },
  });

  it("empty group matches all contexts (vacuous truth)", () => {
    expect(evaluateConditionGroup(ctx, {})).toBe(true);
  });

  describe("all (AND)", () => {
    it("matches when all conditions pass", () => {
      const group: FridayRuleConditionGroup = {
        all: [
          { field: "args.command", operator: "contains", value: "rm" },
          { field: "args.host", operator: "equals", value: "example.com" },
        ],
      };
      expect(evaluateConditionGroup(ctx, group)).toBe(true);
    });

    it("fails when any condition fails", () => {
      const group: FridayRuleConditionGroup = {
        all: [
          { field: "args.command", operator: "contains", value: "rm" },
          { field: "args.host", operator: "equals", value: "other.com" },
        ],
      };
      expect(evaluateConditionGroup(ctx, group)).toBe(false);
    });
  });

  describe("any (OR)", () => {
    it("matches when at least one condition passes", () => {
      const group: FridayRuleConditionGroup = {
        any: [
          { field: "args.command", operator: "contains", value: "docker" },
          { field: "args.host", operator: "equals", value: "example.com" },
        ],
      };
      expect(evaluateConditionGroup(ctx, group)).toBe(true);
    });

    it("fails when no conditions pass", () => {
      const group: FridayRuleConditionGroup = {
        any: [
          { field: "args.command", operator: "contains", value: "docker" },
          { field: "args.host", operator: "equals", value: "other.com" },
        ],
      };
      expect(evaluateConditionGroup(ctx, group)).toBe(false);
    });
  });

  describe("none (NOT ANY)", () => {
    it("matches when no conditions pass", () => {
      const group: FridayRuleConditionGroup = {
        none: [
          { field: "args.command", operator: "contains", value: "docker" },
          { field: "args.host", operator: "equals", value: "other.com" },
        ],
      };
      expect(evaluateConditionGroup(ctx, group)).toBe(true);
    });

    it("fails when any condition passes", () => {
      const group: FridayRuleConditionGroup = {
        none: [
          { field: "args.command", operator: "contains", value: "rm" },
        ],
      };
      expect(evaluateConditionGroup(ctx, group)).toBe(false);
    });
  });

  describe("combined groups", () => {
    it("requires all groups to pass", () => {
      const group: FridayRuleConditionGroup = {
        all: [{ field: "args.command", operator: "contains", value: "rm" }],
        none: [{ field: "args.host", operator: "equals", value: "localhost" }],
      };
      expect(evaluateConditionGroup(ctx, group)).toBe(true);
    });

    it("fails if any group fails", () => {
      const group: FridayRuleConditionGroup = {
        all: [{ field: "args.command", operator: "contains", value: "rm" }],
        none: [{ field: "args.host", operator: "equals", value: "example.com" }],
      };
      expect(evaluateConditionGroup(ctx, group)).toBe(false);
    });
  });
});

describe("regex cache", () => {
  beforeEach(() => {
    clearCache();
  });

  it("clearCache removes compiled regex entries", () => {
    const first = precompileRegexPattern("^safe-pattern$");
    clearCache();

    const second = precompileRegexPattern("^safe-pattern$");
    expect(second).not.toBe(first);
  });

  it("evicts least-recently-used entries when cache exceeds capacity", () => {
    const pattern0 = "^pattern-0$";
    const pattern1 = "^pattern-1$";

    const compiled0 = precompileRegexPattern(pattern0);
    const compiled1 = precompileRegexPattern(pattern1);

    for (let i = 2; i < 1000; i++) {
      precompileRegexPattern(`^pattern-${i}$`);
    }

    // Touch pattern-0 so pattern-1 becomes the least-recently-used entry.
    expect(precompileRegexPattern(pattern0)).toBe(compiled0);

    // Inserting one more pattern should evict exactly one LRU entry.
    precompileRegexPattern("^pattern-1000$");

    expect(precompileRegexPattern(pattern0)).toBe(compiled0);
    expect(precompileRegexPattern(pattern1)).not.toBe(compiled1);
  });
});
