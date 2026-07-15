import { describe, it, expect } from "vitest";
import { createFridayMemoryOutputFilter } from "#memory";

// ─── Unit coverage for the learned-fact egress redactor added for the sibling-route leak
//     closure (uix / asset-inventory / agent-tool). `redactLearnedFactValue` runs the SAME
//     production deep PII redactor (#1607) over a free-form `value: unknown`, preserving the
//     value's structure/type while redacting PII in place (string, nested object, array). ───

// toFullwidth("4111111111111111") — Luhn-valid Visa test number in full-width digits.
const FULLWIDTH_CARD = "４１１１１１１１１１１１１１１１";
const ASCII_CARD = "4111 1111 1111 1111";

describe("FridayMemoryOutputFilter.redactLearnedFactValue", () => {
  const filter = createFridayMemoryOutputFilter();

  it("redacts a full-width card in a plain string value (width fold)", () => {
    const out = filter.redactLearnedFactValue(`カード番号は${FULLWIDTH_CARD}です`);
    expect(out).toBe("カード番号は[CREDIT_CARD]です");
    expect(JSON.stringify(out)).not.toContain(FULLWIDTH_CARD);
  });

  it("redacts PII inside a nested object/array value, preserving structure", () => {
    const value = {
      label: "contact",
      channels: [
        { kind: "email", raw: "alice@example.com" },
        { kind: "card", raw: FULLWIDTH_CARD },
      ],
      note: "no pii here",
    };
    const out = filter.redactLearnedFactValue(value) as {
      label: string;
      channels: Array<{ kind: string; raw: string }>;
      note: string;
    };
    // Structure/type preserved.
    expect(out.label).toBe("contact");
    expect(out.note).toBe("no pii here");
    expect(Array.isArray(out.channels)).toBe(true);
    expect(out.channels).toHaveLength(2);
    expect(out.channels[0]!.kind).toBe("email");
    // PII redacted in place.
    expect(out.channels[0]!.raw).toBe("[EMAIL]");
    expect(out.channels[1]!.raw).toBe("[CREDIT_CARD]");
    expect(JSON.stringify(out)).not.toContain("alice@example.com");
    expect(JSON.stringify(out)).not.toContain(FULLWIDTH_CARD);
  });

  it("is idempotent — a second pass over an already-redacted value is a no-op", () => {
    const once = filter.redactLearnedFactValue({ raw: ASCII_CARD, nested: { raw: FULLWIDTH_CARD } });
    const twice = filter.redactLearnedFactValue(once);
    expect(twice).toEqual(once);
    expect(JSON.stringify(twice)).not.toContain(ASCII_CARD);
    expect(JSON.stringify(twice)).not.toContain(FULLWIDTH_CARD);
  });

  it("leaves a value with no PII unchanged (negative control)", () => {
    expect(filter.redactLearnedFactValue("blue")).toBe("blue");
    const obj = { color: "blue", count: 3, ok: true, nothing: null };
    expect(filter.redactLearnedFactValue(obj)).toEqual(obj);
  });

  it("passes non-string scalars through unchanged", () => {
    expect(filter.redactLearnedFactValue(42)).toBe(42);
    expect(filter.redactLearnedFactValue(true)).toBe(true);
    expect(filter.redactLearnedFactValue(null)).toBe(null);
    expect(filter.redactLearnedFactValue(undefined)).toBe(undefined);
  });

  it("perf sanity: redacts a large mixed string well within a generous bound (no O(n^2))", () => {
    const big = `${"lorem ipsum dolor sit amet ".repeat(4000)} card ${FULLWIDTH_CARD}`;
    const start = Date.now();
    const out = filter.redactLearnedFactValue(big) as string;
    const elapsed = Date.now() - start;
    expect(out).toContain("[CREDIT_CARD]");
    expect(out).not.toContain(FULLWIDTH_CARD);
    expect(elapsed).toBeLessThan(2000);
  });
});
