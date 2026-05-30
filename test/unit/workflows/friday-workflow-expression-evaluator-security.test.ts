import { describe, it, expect } from "vitest";
import { createFridayExpressionEvaluator } from "#workflows";
import type { FridayExpressionContext } from "#workflows";

// Adversarial-security characterization for the workflow expression evaluator
// (extended this session with arithmetic + nested-mapping recursion). Derived
// from a 5-agent adversarial probe: prototype-pollution, code-execution/sandbox
// escape, ReDoS/DoS, and coercion. Locks the safety properties so a future
// change that weakens them fails loudly.
describe("FridayExpressionEvaluator — adversarial security", () => {
  const evaluator = createFridayExpressionEvaluator();
  const ctx: FridayExpressionContext = {
    inputs: { a: 5, b: 3, name: "Ada", nested: { x: 1 }, obj: { k: 1 }, arr: [1, 2] },
    steps: { "s3-csv": { output: { total: 9 } } },
    env: {},
  };

  // ─── Prototype pollution / sandbox escape (READ path) ───
  it("rejects prototype-internal ref segments at ANY position", () => {
    expect(() => evaluator.exec("$inputs.__proto__.x", ctx)).toThrow("EXPRESSION_UNSAFE_PATH_ACCESS");
    expect(() => evaluator.exec("$inputs.constructor", ctx)).toThrow("EXPRESSION_UNSAFE_PATH_ACCESS");
    expect(() => evaluator.exec("$inputs.prototype", ctx)).toThrow("EXPRESSION_UNSAFE_PATH_ACCESS");
    expect(() => evaluator.exec("$inputs.nested.constructor.constructor", ctx)).toThrow("EXPRESSION_UNSAFE_PATH_ACCESS");
    expect(() => evaluator.exec("$steps.__proto__.x", ctx)).toThrow("EXPRESSION_UNSAFE_PATH_ACCESS");
  });
  it("returns undefined for non-sandbox roots (no deref, no throw)", () => {
    expect(evaluator.exec("$__proto__.x", ctx)).toBeUndefined();
    expect(evaluator.exec("$constructor.prototype", ctx)).toBeUndefined();
  });
  // Own-property hardening (this session): inherited builtins are NOT readable.
  it("does not expose inherited Object.prototype members (own-property guard)", () => {
    expect(evaluator.exec("$inputs.valueOf", ctx)).toBeUndefined();
    expect(evaluator.exec("$inputs.hasOwnProperty", ctx)).toBeUndefined();
    expect(evaluator.exec("$inputs.toString", ctx)).toBeUndefined();
    // own data still resolves
    expect(evaluator.exec("$inputs.nested.x", ctx)).toBe(1);
    expect(evaluator.exec("$steps.s3-csv.output.total", ctx)).toBe(9); // hyphenated step id
  });

  // ─── Code execution / sandbox escape (no such grammar) ───
  it("has no call / index / template / sequence / assignment / global productions", () => {
    for (const expr of [
      "$inputs.a()",
      "$fn(1)",
      '$inputs.constructor("return process")()',
      "`${process}`",
      "$inputs.a, $inputs.b",
      "$inputs.a = 5",
      "$inputs[a]",
      "process",
      "globalThis",
    ]) {
      expect(() => evaluator.parse(expr), expr).toThrow();
    }
  });

  // ─── DoS / resource bounds ───
  it("bounds recursion depth for ! chains (fixed), unary-minus chains, and parens", () => {
    expect(() => evaluator.parse("!".repeat(40) + "1")).toThrow("EXPRESSION_DEPTH_EXCEEDED");
    expect(() => evaluator.parse("-".repeat(40) + "1")).toThrow("EXPRESSION_DEPTH_EXCEEDED");
    expect(() => evaluator.parse("(".repeat(40) + "1" + ")".repeat(40))).toThrow("EXPRESSION_DEPTH_EXCEEDED");
  });
  it("bounds total expression length", () => {
    expect(() => evaluator.parse("1".repeat(4097))).toThrow("EXPRESSION_TOO_LONG");
  });

  // ─── Coercion characterization (explicit, documented rule) ───
  it("'+' adds numbers, concats otherwise (incl. null/boolean → concat, NOT JS numeric)", () => {
    expect(evaluator.exec("5 + 3", ctx)).toBe(8);
    expect(evaluator.exec('"5" + "3"', ctx)).toBe("53");
    expect(evaluator.exec("null + 5", ctx)).toBe("5"); // deliberately NOT JS (which is 5)
    expect(evaluator.exec("true + 1", ctx)).toBe("true1");
  });
  it("'- * / %' Number()-coerce (so they differ from '+' on string operands)", () => {
    expect(evaluator.exec("10 - 4", ctx)).toBe(6);
    expect(evaluator.exec('"5" - "3"', ctx)).toBe(2);
    expect(evaluator.exec("1 / 0", ctx)).toBe(Infinity);
    expect(Number.isNaN(evaluator.exec("0 / 0", ctx) as number)).toBe(true);
  });
  it("concat uses JSON for objects/arrays and '' for null/undefined", () => {
    expect(evaluator.exec('"" + $inputs.obj', ctx)).toBe('{"k":1}');
    expect(evaluator.exec('"" + $inputs.arr', ctx)).toBe("[1,2]");
    expect(evaluator.exec("$inputs.missing + ' tail'", ctx)).toBe(" tail");
  });
});
