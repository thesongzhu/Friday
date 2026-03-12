import { describe, it, expect } from "vitest";
import { createFridayExpressionEvaluator } from "#workflows";
import type { FridayExpressionContext } from "#workflows";

describe("FridayExpressionEvaluator", () => {
  const evaluator = createFridayExpressionEvaluator();

  const ctx: FridayExpressionContext = {
    inputs: { name: "Alice", count: 42, env: "production" },
    steps: {
      fetch: { output: { count: 42, healthy: true } },
      check: { output: { valid: false, result: true } },
    },
    env: { region: "us-east" },
  };

  // ─── Literal evaluation ───

  it("evaluates string literal", () => {
    expect(evaluator.exec('"hello"', ctx)).toBe("hello");
  });

  it("evaluates number literal", () => {
    expect(evaluator.exec("42", ctx)).toBe(42);
  });

  it("evaluates boolean literal true", () => {
    expect(evaluator.exec("true", ctx)).toBe(true);
  });

  it("evaluates boolean literal false", () => {
    expect(evaluator.exec("false", ctx)).toBe(false);
  });

  it("evaluates null literal", () => {
    expect(evaluator.exec("null", ctx)).toBe(null);
  });

  // ─── Reference resolution ───

  it("resolves $inputs.name", () => {
    expect(evaluator.exec("$inputs.name", ctx)).toBe("Alice");
  });

  it("resolves $steps.fetch.output.count", () => {
    expect(evaluator.exec("$steps.fetch.output.count", ctx)).toBe(42);
  });

  it("resolves $env.region", () => {
    expect(evaluator.exec("$env.region", ctx)).toBe("us-east");
  });

  // ─── Comparison operators ───

  it("evaluates == (equal)", () => {
    expect(evaluator.exec("$inputs.count == 42", ctx)).toBe(true);
  });

  it("evaluates != (not equal)", () => {
    expect(evaluator.exec("$inputs.count != 99", ctx)).toBe(true);
  });

  it("evaluates > (greater)", () => {
    expect(evaluator.exec("$inputs.count > 10", ctx)).toBe(true);
  });

  it("evaluates < (less)", () => {
    expect(evaluator.exec("$inputs.count < 100", ctx)).toBe(true);
  });

  it("evaluates >= (gte)", () => {
    expect(evaluator.exec("$inputs.count >= 42", ctx)).toBe(true);
  });

  it("evaluates <= (lte)", () => {
    expect(evaluator.exec("$inputs.count <= 42", ctx)).toBe(true);
  });

  // ─── Logical operators ───

  it("evaluates && (AND) with short-circuit", () => {
    expect(evaluator.exec("true && false", ctx)).toBe(false);
  });

  it("evaluates || (OR) with short-circuit", () => {
    expect(evaluator.exec("false || true", ctx)).toBe(true);
  });

  it("evaluates ! (NOT)", () => {
    expect(evaluator.exec("!true", ctx)).toBe(false);
  });

  it("evaluates negated reference", () => {
    expect(evaluator.exec("!$steps.check.output.valid", ctx)).toBe(true);
  });

  // ─── Parentheses ───

  it("evaluates (a || b) && c correctly", () => {
    expect(evaluator.exec("(true || false) && true", ctx)).toBe(true);
  });

  it("evaluates a || (b && c) correctly", () => {
    expect(evaluator.exec("false || (true && true)", ctx)).toBe(true);
  });

  // ─── Complex expression ───

  it("evaluates complex expression", () => {
    const result = evaluator.exec(
      '$inputs.env == "production" && $steps.fetch.output.healthy == true',
      ctx,
    );
    expect(result).toBe(true);
  });

  // ─── Undefined ref ───

  it("returns undefined for missing reference (not an error)", () => {
    expect(evaluator.exec("$steps.missing.output.x", ctx)).toBeUndefined();
  });

  // ─── Syntax errors ───

  it("throws on syntax error", () => {
    expect(() => evaluator.parse("$inputs.x ==")).toThrow();
  });

  it("throws on unterminated string", () => {
    expect(() => evaluator.parse('"hello')).toThrow();
  });

  // ─── Safety limits ───

  it("throws when expression exceeds max length", () => {
    const longExpr = "$inputs." + "a".repeat(4100);
    expect(() => evaluator.parse(longExpr)).toThrow("EXPRESSION_TOO_LONG");
  });

  it("throws when nesting exceeds max depth", () => {
    // Create deeply nested parentheses
    const open = "(".repeat(35);
    const close = ")".repeat(35);
    const expr = `${open}true${close}`;
    expect(() => evaluator.parse(expr)).toThrow("EXPRESSION_DEPTH_EXCEEDED");
  });

  it("rejects function-call-like identifiers", () => {
    expect(() => evaluator.parse("toString")).toThrow();
  });

  // ─── Single-quoted strings ───

  it("evaluates single-quoted string", () => {
    expect(evaluator.exec("'hello'", ctx)).toBe("hello");
  });

  // ─── Escaped characters ───

  it("handles escaped quotes in strings", () => {
    expect(evaluator.exec('"hello \\"world\\""', ctx)).toBe('hello "world"');
  });
});
