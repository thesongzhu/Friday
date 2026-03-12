import { describe, it, expect } from "vitest";
import {
  parsePolicyBundleDocument,
  parsePolicyBundleJson,
  validateRegexPattern,
  RuleDslParseError,
} from "../../../../src/rules/engine/dsl-parser.js";

// ─── Valid Bundle Fixture ───

function validBundleObject() {
  return {
    apiVersion: "friday/rules/v1",
    kind: "PolicyBundle",
    metadata: {
      id: "test-bundle",
      name: "Test Bundle",
      version: 1,
      description: "A test policy bundle",
      priority: 50,
      enabled: true,
      tags: ["test", "safety"],
    },
    rules: [
      {
        id: "rule-1",
        name: "Block rm -rf",
        resource: "shell",
        action: "execute",
        decision: "deny",
        message: "rm -rf is not allowed",
        priority: 10,
        conditions: {
          all: [
            { field: "args.command", operator: "matches", value: "rm\\s+-rf" },
          ],
        },
      },
      {
        id: "rule-2",
        name: "Audit file writes",
        resource: "filesystem",
        action: "write",
        decision: "audit",
        message: "File write recorded",
      },
    ],
  };
}

// ─── parsePolicyBundleDocument ───

describe("parsePolicyBundleDocument", () => {
  it("parses a valid bundle document", () => {
    const result = parsePolicyBundleDocument(validBundleObject());
    expect(result.apiVersion).toBe("friday/rules/v1");
    expect(result.kind).toBe("PolicyBundle");
    expect(result.metadata.id).toBe("test-bundle");
    expect(result.metadata.name).toBe("Test Bundle");
    expect(result.metadata.version).toBe(1);
    expect(result.metadata.priority).toBe(50);
    expect(result.metadata.tags).toEqual(["test", "safety"]);
    expect(result.rules).toHaveLength(2);
  });

  it("parses rules with correct fields", () => {
    const result = parsePolicyBundleDocument(validBundleObject());
    const rule1 = result.rules[0];
    expect(rule1.id).toBe("rule-1");
    expect(rule1.name).toBe("Block rm -rf");
    expect(rule1.resource).toBe("shell");
    expect(rule1.action).toBe("execute");
    expect(rule1.decision).toBe("deny");
    expect(rule1.priority).toBe(10);
    expect(rule1.conditions?.all).toHaveLength(1);
  });

  it("defaults optional rule fields", () => {
    const result = parsePolicyBundleDocument(validBundleObject());
    const rule2 = result.rules[1];
    expect(rule2.enabled).toBeUndefined();
    expect(rule2.conditions).toBeUndefined();
    expect(rule2.priority).toBeUndefined();
  });

  it("rejects non-object input", () => {
    expect(() => parsePolicyBundleDocument(null)).toThrow(RuleDslParseError);
    expect(() => parsePolicyBundleDocument("string")).toThrow(RuleDslParseError);
    expect(() => parsePolicyBundleDocument([])).toThrow(RuleDslParseError);
  });

  it("rejects wrong apiVersion", () => {
    const doc = validBundleObject();
    doc.apiVersion = "wrong/v1" as typeof doc.apiVersion;
    expect(() => parsePolicyBundleDocument(doc)).toThrow(RuleDslParseError);
  });

  it("rejects wrong kind", () => {
    const doc = validBundleObject();
    doc.kind = "Wrong" as typeof doc.kind;
    expect(() => parsePolicyBundleDocument(doc)).toThrow(RuleDslParseError);
  });

  it("rejects missing metadata.id", () => {
    const doc = validBundleObject();
    (doc.metadata as Record<string, unknown>).id = undefined;
    expect(() => parsePolicyBundleDocument(doc)).toThrow(RuleDslParseError);
  });

  it("rejects invalid resource in rule", () => {
    const doc = validBundleObject();
    (doc.rules[0] as Record<string, unknown>).resource = "invalid_resource";
    expect(() => parsePolicyBundleDocument(doc)).toThrow(RuleDslParseError);
  });

  it("rejects invalid action in rule", () => {
    const doc = validBundleObject();
    (doc.rules[0] as Record<string, unknown>).action = "invalid_action";
    expect(() => parsePolicyBundleDocument(doc)).toThrow(RuleDslParseError);
  });

  it("rejects invalid decision in rule", () => {
    const doc = validBundleObject();
    (doc.rules[0] as Record<string, unknown>).decision = "invalid_decision";
    expect(() => parsePolicyBundleDocument(doc)).toThrow(RuleDslParseError);
  });

  it("rejects duplicate rule IDs", () => {
    const doc = validBundleObject();
    doc.rules[1].id = "rule-1"; // duplicate
    expect(() => parsePolicyBundleDocument(doc)).toThrow(RuleDslParseError);
  });

  it("rejects invalid operator in condition", () => {
    const doc = validBundleObject();
    (doc.rules[0].conditions!.all![0] as Record<string, unknown>).operator = "bad_op";
    expect(() => parsePolicyBundleDocument(doc)).toThrow(RuleDslParseError);
  });

  it("rejects value operator without value", () => {
    const doc = validBundleObject();
    const condition = doc.rules[0].conditions!.all![0] as Record<string, unknown>;
    condition.operator = "equals";
    delete condition.value;
    expect(() => parsePolicyBundleDocument(doc)).toThrow(RuleDslParseError);
  });

  it("parses presence operators without value", () => {
    const doc = validBundleObject();
    doc.rules[0].conditions = {
      all: [{ field: "args.command", operator: "exists" } as unknown as typeof doc.rules[0].conditions!["all"] extends (infer T)[] | undefined ? T : never],
    };
    const result = parsePolicyBundleDocument(doc);
    expect(result.rules[0].conditions?.all?.[0].operator).toBe("exists");
  });

  it("rejects presence operators when value is provided", () => {
    const doc = validBundleObject();
    doc.rules[0].conditions = {
      all: [{ field: "args.command", operator: "exists", value: "unexpected" } as unknown as typeof doc.rules[0].conditions!["all"] extends (infer T)[] | undefined ? T : never],
    };
    expect(() => parsePolicyBundleDocument(doc)).toThrow(RuleDslParseError);
  });

  it("validates condition groups (any, none)", () => {
    const doc = validBundleObject();
    doc.rules[0].conditions = {
      any: [{ field: "args.command", operator: "contains", value: "rm" }],
      none: [{ field: "args.host", operator: "equals", value: "localhost" }],
    };
    const result = parsePolicyBundleDocument(doc);
    expect(result.rules[0].conditions?.any).toHaveLength(1);
    expect(result.rules[0].conditions?.none).toHaveLength(1);
  });

  it("rejects unknown condition group keys", () => {
    const doc = validBundleObject();
    doc.rules[0].conditions = {
      typo: [{ field: "args.command", operator: "contains", value: "rm" }],
    } as unknown as typeof doc.rules[0].conditions;
    expect(() => parsePolicyBundleDocument(doc)).toThrow(RuleDslParseError);
  });

  it("rejects provided conditions when no valid group is present", () => {
    const doc = validBundleObject();
    doc.rules[0].conditions = {} as unknown as typeof doc.rules[0].conditions;
    expect(() => parsePolicyBundleDocument(doc)).toThrow(RuleDslParseError);
  });

  it("rejects prototype-chain field segments", () => {
    const doc = validBundleObject();
    doc.rules[0].conditions = {
      all: [{ field: "args.__proto__.polluted", operator: "equals", value: "x" }],
    };
    expect(() => parsePolicyBundleDocument(doc)).toThrow(RuleDslParseError);
  });

  it("rejects template/eval injection field patterns", () => {
    const doc = validBundleObject();
    doc.rules[0].conditions = {
      all: [{ field: "args.command.${eval(1)}", operator: "contains", value: "rm" }],
    };
    expect(() => parsePolicyBundleDocument(doc)).toThrow(RuleDslParseError);
  });

  it("accepts safe field paths", () => {
    const doc = validBundleObject();
    doc.rules[0].conditions = {
      all: [{ field: "metadata.user.role", operator: "equals", value: "admin" }],
    };
    const parsed = parsePolicyBundleDocument(doc);
    expect(parsed.rules[0].conditions?.all?.[0].field).toBe("metadata.user.role");
  });

  it("parses valid metadata signature", () => {
    const doc = validBundleObject();
    (doc.metadata as Record<string, unknown>).signature = {
      algorithm: "hmac-sha256",
      keyId: "k1",
      value: "deadbeef",
    };

    const parsed = parsePolicyBundleDocument(doc);
    expect(parsed.metadata.signature?.keyId).toBe("k1");
  });

  it("rejects invalid metadata signature algorithm", () => {
    const doc = validBundleObject();
    (doc.metadata as Record<string, unknown>).signature = {
      algorithm: "bad-algo",
      keyId: "k1",
      value: "deadbeef",
    };

    expect(() => parsePolicyBundleDocument(doc)).toThrow(RuleDslParseError);
  });
});

// ─── parsePolicyBundleJson ───

describe("parsePolicyBundleJson", () => {
  it("parses valid JSON", () => {
    const json = JSON.stringify(validBundleObject());
    const result = parsePolicyBundleJson(json);
    expect(result.metadata.id).toBe("test-bundle");
  });

  it("rejects invalid JSON", () => {
    expect(() => parsePolicyBundleJson("{invalid}")).toThrow(RuleDslParseError);
  });
});

// ─── validateRegexPattern ───

describe("validateRegexPattern", () => {
  it("returns null for valid patterns", () => {
    expect(validateRegexPattern("^test$")).toBeNull();
    expect(validateRegexPattern("rm\\s+-rf")).toBeNull();
  });

  it("returns error for invalid patterns", () => {
    expect(validateRegexPattern("[invalid")).not.toBeNull();
  });

  it("returns error for patterns exceeding max length", () => {
    const longPattern = "a".repeat(257);
    expect(validateRegexPattern(longPattern)).not.toBeNull();
  });

  it("returns error for catastrophic nested quantifier patterns", () => {
    expect(validateRegexPattern("(a+)+$")).not.toBeNull();
  });

  it("returns error for backreference patterns", () => {
    expect(validateRegexPattern("(test)\\1")).not.toBeNull();
  });
});

// ─── RuleDslParseError ───

describe("RuleDslParseError", () => {
  it("includes path in message", () => {
    const error = new RuleDslParseError("test error", "metadata.id");
    expect(error.message).toContain("metadata.id");
    expect(error.path).toBe("metadata.id");
  });

  it("includes details when provided", () => {
    const error = new RuleDslParseError("test error", "root", "extra info");
    expect(error.message).toContain("extra info");
    expect(error.details).toBe("extra info");
  });
});
