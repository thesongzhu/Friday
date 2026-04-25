import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  evaluateAssertion,
  validateSchema,
  scoreQualityDimension,
  deepEqual,
  resolveJsonPath,
  registerCustomHandler,
  unregisterCustomHandler,
  clearCustomHandlers,
} from "../../../../src/acceptance/engine/assertion-engine.js";
import type {
  FridayAcceptanceSchemaCheckConfig,
  FridayAcceptanceQuantCheckConfig,
  FridayAcceptanceQualityCheckConfig,
  FridayAcceptanceCustomCheckConfig,
} from "../../../../src/acceptance/model/friday-acceptance.types.js";

// ─── resolveJsonPath ───

describe("resolveJsonPath", () => {
  it("resolves top-level property", () => {
    expect(resolveJsonPath({ name: "Alice" }, "name")).toBe("Alice");
  });

  it("resolves nested property", () => {
    expect(resolveJsonPath({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
  });

  it("resolves array index", () => {
    expect(resolveJsonPath({ items: [10, 20, 30] }, "items.1")).toBe(20);
  });

  it("returns undefined for missing path", () => {
    expect(resolveJsonPath({ a: 1 }, "b.c")).toBeUndefined();
  });

  it("returns undefined for primitive traversal", () => {
    expect(resolveJsonPath("hello", "length")).toBeUndefined();
  });

  it("returns undefined for null value", () => {
    expect(resolveJsonPath(null, "a")).toBeUndefined();
  });

  it("returns undefined for out-of-bounds array index", () => {
    expect(resolveJsonPath([1, 2], "5")).toBeUndefined();
  });

  it("returns undefined for negative array index", () => {
    expect(resolveJsonPath([1, 2], "-1")).toBeUndefined();
  });
});

// ─── validateSchema ───

describe("validateSchema", () => {
  it("passes for valid object against schema", () => {
    const schema = {
      type: "object",
      required: ["name", "age"],
      properties: {
        name: { type: "string" },
        age: { type: "number", minimum: 0 },
      },
    };
    expect(validateSchema({ name: "Alice", age: 30 }, schema)).toEqual([]);
  });

  it("fails for missing required property", () => {
    const schema = { type: "object", required: ["name"] };
    const errors = validateSchema({}, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("missing required property");
  });

  it("fails for type mismatch", () => {
    const schema = { type: "string" };
    const errors = validateSchema(42, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('expected type "string"');
  });

  it("validates array items", () => {
    const schema = { type: "array", items: { type: "number" } };
    const errors = validateSchema([1, "two", 3], schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("[1]");
  });

  it("validates string minLength", () => {
    const schema = { type: "string", minLength: 5 };
    expect(validateSchema("ab", schema)).toHaveLength(1);
  });

  it("validates string maxLength", () => {
    const schema = { type: "string", maxLength: 3 };
    expect(validateSchema("abcde", schema)).toHaveLength(1);
  });

  it("validates string pattern", () => {
    const schema = { type: "string", pattern: "^[a-z]+$" };
    expect(validateSchema("abc123", schema)).toHaveLength(1);
    expect(validateSchema("abc", schema)).toEqual([]);
  });

  it("rejects unsafe string patterns without evaluating them", () => {
    const schema = { type: "string", pattern: "(a+)+$" };
    const errors = validateSchema("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", schema);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("invalid or unsafe pattern");
  });

  it("reports invalid string patterns as validation errors", () => {
    const schema = { type: "string", pattern: "[" };
    const errors = validateSchema("abc", schema);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("invalid or unsafe pattern");
  });

  it("validates number minimum", () => {
    const schema = { type: "number", minimum: 10 };
    expect(validateSchema(5, schema)).toHaveLength(1);
    expect(validateSchema(15, schema)).toEqual([]);
  });

  it("validates number maximum", () => {
    const schema = { type: "number", maximum: 100 };
    expect(validateSchema(150, schema)).toHaveLength(1);
  });

  it("validates enum values", () => {
    const schema = { enum: ["red", "green", "blue"] };
    expect(validateSchema("red", schema)).toEqual([]);
    expect(validateSchema("yellow", schema)).toHaveLength(1);
  });

  it("validates array minItems", () => {
    const schema = { type: "array", minItems: 2 };
    expect(validateSchema([1], schema)).toHaveLength(1);
  });

  it("validates array maxItems", () => {
    const schema = { type: "array", maxItems: 2 };
    expect(validateSchema([1, 2, 3], schema)).toHaveLength(1);
  });

  it("validates integer type", () => {
    const schema = { type: "integer" };
    expect(validateSchema(3.14, schema)).toHaveLength(1);
    expect(validateSchema(42, schema)).toEqual([]);
  });

  it("validates null type", () => {
    const schema = { type: "null" };
    expect(validateSchema(null, schema)).toEqual([]);
    expect(validateSchema(0, schema)).toHaveLength(1);
  });

  it("validates boolean type", () => {
    const schema = { type: "boolean" };
    expect(validateSchema(true, schema)).toEqual([]);
    expect(validateSchema("true", schema)).toHaveLength(1);
  });
});

// ─── deepEqual ───

describe("deepEqual", () => {
  it("returns true for identical primitives", () => {
    expect(deepEqual(42, 42)).toBe(true);
    expect(deepEqual("hello", "hello")).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
  });

  it("returns false for different primitives", () => {
    expect(deepEqual(42, 43)).toBe(false);
    expect(deepEqual("hello", "world")).toBe(false);
  });

  it("returns true for equal objects", () => {
    expect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
  });

  it("returns false for different objects", () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("returns true for equal arrays", () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  it("returns false for arrays of different length", () => {
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("handles nested structures", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
  });

  it("returns false for null vs non-null", () => {
    expect(deepEqual(null, { a: 1 })).toBe(false);
    expect(deepEqual({ a: 1 }, null)).toBe(false);
  });

  it("returns false for type mismatches", () => {
    expect(deepEqual(42, "42")).toBe(false);
    expect(deepEqual([], {})).toBe(false);
  });
});

// ─── scoreQualityDimension ───

describe("scoreQualityDimension", () => {
  describe("completeness", () => {
    it("scores 0 for null", () => {
      expect(scoreQualityDimension(null, "completeness")).toBe(0);
    });

    it("scores 0 for empty string", () => {
      expect(scoreQualityDimension("", "completeness")).toBe(0);
    });

    it("scores 100 for non-empty string", () => {
      expect(scoreQualityDimension("hello", "completeness")).toBe(100);
    });

    it("scores based on non-null ratio for objects", () => {
      expect(scoreQualityDimension({ a: 1, b: null, c: 3 }, "completeness")).toBe(67);
    });

    it("scores 0 for empty array", () => {
      expect(scoreQualityDimension([], "completeness")).toBe(0);
    });

    it("scores 100 for primitives (number, boolean)", () => {
      expect(scoreQualityDimension(42, "completeness")).toBe(100);
      expect(scoreQualityDimension(true, "completeness")).toBe(100);
    });
  });

  describe("consistency", () => {
    it("scores 100 for single-element array", () => {
      expect(scoreQualityDimension([1], "consistency")).toBe(100);
    });

    it("scores 100 for homogeneous array", () => {
      expect(scoreQualityDimension([1, 2, 3], "consistency")).toBe(100);
    });

    it("scores less than 100 for heterogeneous array", () => {
      const score = scoreQualityDimension([1, "two", 3], "consistency");
      expect(score).toBeLessThan(100);
      expect(score).toBeGreaterThan(0);
    });
  });

  describe("validity", () => {
    it("scores 0 for null", () => {
      expect(scoreQualityDimension(null, "validity")).toBe(0);
    });

    it("scores 100 for clean string", () => {
      expect(scoreQualityDimension("Hello world", "validity")).toBe(100);
    });

    it("scores 0 for empty string", () => {
      expect(scoreQualityDimension("", "validity")).toBe(0);
    });
  });

  describe("readability", () => {
    it("scores 0 for empty string", () => {
      expect(scoreQualityDimension("", "readability")).toBe(0);
    });

    it("scores > 0 for readable text", () => {
      const text = "The quick brown fox jumps over the lazy dog. This is a sample sentence with decent readability.";
      expect(scoreQualityDimension(text, "readability")).toBeGreaterThan(0);
    });

    it("returns 50 for non-string types", () => {
      expect(scoreQualityDimension(42, "readability")).toBe(50);
    });
  });
});

// ─── evaluateAssertion: schema ───

describe("evaluateAssertion — schema", () => {
  const config: FridayAcceptanceSchemaCheckConfig = {
    checkType: "schema",
    schema: {
      type: "object",
      required: ["name", "score"],
      properties: {
        name: { type: "string" },
        score: { type: "number", minimum: 0, maximum: 100 },
      },
    },
  };

  it("passes for valid artifact", () => {
    const result = evaluateAssertion("check-1", { name: "test", score: 85 }, config);
    expect(result.verdict).toBe("pass");
    expect(result.evidence).toHaveLength(1);
  });

  it("fails for missing required field", () => {
    const result = evaluateAssertion("check-2", { name: "test" }, config);
    expect(result.verdict).toBe("fail");
    expect(result.evidence[0].message).toContain("Schema validation failed");
  });

  it("fails for wrong type", () => {
    const result = evaluateAssertion("check-3", "not an object", config);
    expect(result.verdict).toBe("fail");
  });

  it("uses critical severity when strict is true", () => {
    const strictConfig: FridayAcceptanceSchemaCheckConfig = { ...config, strict: true };
    const result = evaluateAssertion("check-4", { name: "test" }, strictConfig);
    expect(result.verdict).toBe("fail");
    expect(result.severity).toBe("critical");
  });

  it("uses major severity when strict is false", () => {
    const result = evaluateAssertion("check-5", { name: "test" }, config);
    expect(result.verdict).toBe("fail");
    expect(result.severity).toBe("major");
  });
});

// ─── evaluateAssertion: quantitative ───

describe("evaluateAssertion — quantitative", () => {
  it("passes for value greater than threshold (gt)", () => {
    const config: FridayAcceptanceQuantCheckConfig = {
      checkType: "quantitative",
      metricPath: "score",
      operator: "gt",
      threshold: 50,
    };
    const result = evaluateAssertion("q-1", { score: 80 }, config);
    expect(result.verdict).toBe("pass");
  });

  it("fails for value not greater than threshold (gt)", () => {
    const config: FridayAcceptanceQuantCheckConfig = {
      checkType: "quantitative",
      metricPath: "score",
      operator: "gt",
      threshold: 50,
    };
    const result = evaluateAssertion("q-2", { score: 50 }, config);
    expect(result.verdict).toBe("fail");
  });

  it("passes for value equal to threshold (eq)", () => {
    const config: FridayAcceptanceQuantCheckConfig = {
      checkType: "quantitative",
      metricPath: "count",
      operator: "eq",
      threshold: 10,
    };
    const result = evaluateAssertion("q-3", { count: 10 }, config);
    expect(result.verdict).toBe("pass");
  });

  it("passes for value within range (between)", () => {
    const config: FridayAcceptanceQuantCheckConfig = {
      checkType: "quantitative",
      metricPath: "temp",
      operator: "between",
      lowerBound: 20,
      upperBound: 30,
    };
    const result = evaluateAssertion("q-4", { temp: 25 }, config);
    expect(result.verdict).toBe("pass");
  });

  it("fails for value outside range (between)", () => {
    const config: FridayAcceptanceQuantCheckConfig = {
      checkType: "quantitative",
      metricPath: "temp",
      operator: "between",
      lowerBound: 20,
      upperBound: 30,
    };
    const result = evaluateAssertion("q-5", { temp: 35 }, config);
    expect(result.verdict).toBe("fail");
  });

  it("fails when metric path does not resolve to a number", () => {
    const config: FridayAcceptanceQuantCheckConfig = {
      checkType: "quantitative",
      metricPath: "missing",
      operator: "gt",
      threshold: 0,
    };
    const result = evaluateAssertion("q-6", { other: 1 }, config);
    expect(result.verdict).toBe("fail");
    expect(result.evidence[0].message).toContain("did not resolve to a number");
  });

  it("passes for gte at boundary", () => {
    const config: FridayAcceptanceQuantCheckConfig = {
      checkType: "quantitative",
      metricPath: "val",
      operator: "gte",
      threshold: 10,
    };
    const result = evaluateAssertion("q-7", { val: 10 }, config);
    expect(result.verdict).toBe("pass");
  });

  it("passes for lt below threshold", () => {
    const config: FridayAcceptanceQuantCheckConfig = {
      checkType: "quantitative",
      metricPath: "val",
      operator: "lt",
      threshold: 10,
    };
    const result = evaluateAssertion("q-8", { val: 5 }, config);
    expect(result.verdict).toBe("pass");
  });

  it("passes for lte at boundary", () => {
    const config: FridayAcceptanceQuantCheckConfig = {
      checkType: "quantitative",
      metricPath: "val",
      operator: "lte",
      threshold: 10,
    };
    const result = evaluateAssertion("q-9", { val: 10 }, config);
    expect(result.verdict).toBe("pass");
  });

  it("warns when near warn threshold", () => {
    const config: FridayAcceptanceQuantCheckConfig = {
      checkType: "quantitative",
      metricPath: "score",
      operator: "gte",
      threshold: 50,
      warnThreshold: 60,
    };
    const result = evaluateAssertion("q-10", { score: 60 }, config);
    expect(result.verdict).toBe("warn");
  });
});

// ─── evaluateAssertion: quality ───

describe("evaluateAssertion — quality", () => {
  it("passes when score meets minimum", () => {
    const config: FridayAcceptanceQualityCheckConfig = {
      checkType: "quality",
      dimension: "completeness",
      minScore: 50,
    };
    const result = evaluateAssertion("ql-1", { a: 1, b: 2, c: 3 }, config);
    expect(result.verdict).toBe("pass");
  });

  it("fails when score is below minimum", () => {
    const config: FridayAcceptanceQualityCheckConfig = {
      checkType: "quality",
      dimension: "completeness",
      minScore: 80,
    };
    // 1 out of 3 fields are null → 67% completeness
    const result = evaluateAssertion("ql-2", { a: 1, b: null, c: 3 }, config);
    expect(result.verdict).toBe("fail");
  });

  it("warns when score is between warnScore and minScore", () => {
    const config: FridayAcceptanceQualityCheckConfig = {
      checkType: "quality",
      dimension: "completeness",
      minScore: 80,
      warnScore: 60,
    };
    const result = evaluateAssertion("ql-3", { a: 1, b: null, c: 3 }, config);
    expect(result.verdict).toBe("warn");
  });

  it("includes dimension in evidence metadata", () => {
    const config: FridayAcceptanceQualityCheckConfig = {
      checkType: "quality",
      dimension: "readability",
      minScore: 10,
    };
    const result = evaluateAssertion("ql-4", "A clear and readable sentence with good structure.", config);
    expect(result.evidence[0].metadata?.dimension).toBe("readability");
  });
});

// ─── evaluateAssertion: custom ───

describe("evaluateAssertion — custom", () => {
  afterEach(() => {
    clearCustomHandlers();
  });

  it("fails when handler is not registered", () => {
    const config: FridayAcceptanceCustomCheckConfig = {
      checkType: "custom",
      handlerRef: "nonexistent",
    };
    const result = evaluateAssertion("c-1", { data: 1 }, config);
    expect(result.verdict).toBe("fail");
    expect(result.severity).toBe("critical");
    expect(result.evidence[0].message).toContain("not found");
  });

  it("delegates to registered handler", () => {
    registerCustomHandler("always-pass", () => ({
      verdict: "pass",
      severity: "info",
      evidence: [{
        checkId: "c-2",
        checkType: "custom",
        message: "Custom handler passed",
      }],
    }));

    const config: FridayAcceptanceCustomCheckConfig = {
      checkType: "custom",
      handlerRef: "always-pass",
    };
    const result = evaluateAssertion("c-2", { data: 1 }, config);
    expect(result.verdict).toBe("pass");
  });

  it("catches handler exceptions and returns fail", () => {
    registerCustomHandler("throws", () => {
      throw new Error("Handler exploded");
    });

    const config: FridayAcceptanceCustomCheckConfig = {
      checkType: "custom",
      handlerRef: "throws",
    };
    const result = evaluateAssertion("c-3", { data: 1 }, config);
    expect(result.verdict).toBe("fail");
    expect(result.severity).toBe("critical");
    expect(result.evidence[0].message).toContain("Handler exploded");
  });

  it("passes handler config to the handler", () => {
    registerCustomHandler("config-echo", (_content, config) => ({
      verdict: "pass",
      severity: "info",
      evidence: [{
        checkId: "c-4",
        checkType: "custom",
        message: `Config: ${JSON.stringify(config)}`,
      }],
    }));

    const config: FridayAcceptanceCustomCheckConfig = {
      checkType: "custom",
      handlerRef: "config-echo",
      handlerConfig: { threshold: 42 },
    };
    const result = evaluateAssertion("c-4", { data: 1 }, config);
    expect(result.evidence[0].message).toContain("42");
  });

  it("unregisterCustomHandler removes handler", () => {
    registerCustomHandler("temp", () => ({
      verdict: "pass",
      severity: "info",
      evidence: [],
    }));

    expect(unregisterCustomHandler("temp")).toBe(true);
    expect(unregisterCustomHandler("temp")).toBe(false);

    const config: FridayAcceptanceCustomCheckConfig = {
      checkType: "custom",
      handlerRef: "temp",
    };
    const result = evaluateAssertion("c-5", {}, config);
    expect(result.verdict).toBe("fail");
  });

  it("executes sandboxed scripts with JSON-isolated content and config", () => {
    const config: FridayAcceptanceCustomCheckConfig = {
      checkType: "custom",
      handlerRef: "scripted",
      handlerConfig: {
        min: 2,
        script: `
          return {
            verdict: content.count >= config.min ? "pass" : "fail",
            severity: "info",
            evidence: [{ message: "scripted check" }],
          };
        `,
      },
    };

    const result = evaluateAssertion("c-script", { count: 3 }, config);

    expect(result.verdict).toBe("pass");
    expect(result.evidence[0].metadata?.sandboxed).toBe(true);
  });

  it("blocks dynamic code generation inside sandboxed scripts", () => {
    const config: FridayAcceptanceCustomCheckConfig = {
      checkType: "custom",
      handlerRef: "scripted",
      handlerConfig: {
        script: `
          content.constructor.constructor("return process")();
          return { verdict: "pass", severity: "info", evidence: [] };
        `,
      },
    };

    const result = evaluateAssertion("c-script-blocked-codegen", {}, config);

    expect(result.verdict).toBe("fail");
    expect(result.severity).toBe("critical");
    expect(result.evidence[0].message).toContain("Sandboxed custom check failed");
  });

  it("terminates runaway sandboxed scripts", () => {
    const config: FridayAcceptanceCustomCheckConfig = {
      checkType: "custom",
      handlerRef: "scripted",
      handlerConfig: {
        script: "while (true) {}",
      },
    };

    const result = evaluateAssertion("c-script-timeout", {}, config);

    expect(result.verdict).toBe("fail");
    expect(result.severity).toBe("critical");
    expect(result.evidence[0].message).toContain("timed out");
  });
});
