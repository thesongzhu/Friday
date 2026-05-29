import { describe, it, expect } from "vitest";
import { createFridayMemoryPiiGuard } from "#memory";

describe("FridayMemoryPiiGuard", () => {
  // ─── Default mode (tag) ───

  describe("tag mode (default)", () => {
    const guard = createFridayMemoryPiiGuard("tag");

    it("detects email addresses", () => {
      const result = guard.scanAndTransform("Contact me at user@example.com please");
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].type).toBe("email");
      expect(result.matches[0].value).toBe("user@example.com");
      expect(result.distinctTypes).toEqual(["email"]);
      expect(result.tagsToAdd).toEqual(["pii.email"]);
      // In tag mode, content is NOT transformed
      expect(result.transformedContent).toBe("Contact me at user@example.com please");
    });

    it("detects US phone numbers", () => {
      const result = guard.scanAndTransform("Call me at 555-234-5678");
      expect(result.matches.length).toBeGreaterThanOrEqual(1);
      expect(result.distinctTypes).toContain("phone_us");
      expect(result.tagsToAdd).toContain("pii.phone_us");
      expect(result.transformedContent).toBe("Call me at 555-234-5678");
    });

    it("detects US SSN", () => {
      const result = guard.scanAndTransform("SSN: 123-45-6789");
      expect(result.matches.length).toBeGreaterThanOrEqual(1);
      expect(result.distinctTypes).toContain("ssn_us");
      expect(result.tagsToAdd).toContain("pii.ssn_us");
    });

    it("detects credit card numbers (Luhn valid)", () => {
      // Visa test number: 4111111111111111 (Luhn valid)
      const result = guard.scanAndTransform("Card: 4111111111111111");
      expect(result.matches.length).toBeGreaterThanOrEqual(1);
      expect(result.distinctTypes).toContain("credit_card");
      expect(result.tagsToAdd).toContain("pii.credit_card");
    });

    it("rejects Luhn-invalid credit card candidates", () => {
      const result = guard.scanAndTransform("Number: 1234567890123");
      const ccMatches = result.matches.filter((m) => m.type === "credit_card");
      expect(ccMatches).toHaveLength(0);
    });

    it("does not redact Luhn-valid project codenames with alphabetic identifier prefixes", () => {
      const result = guard.scanAndTransform(
        "For this proof run, codename is BARB-1779879819520. marker=phase22d-rgg-1779879819520.",
      );
      expect(result.matches.filter((m) => m.type === "credit_card")).toHaveLength(0);
      expect(result.distinctTypes).not.toContain("credit_card");
      expect(result.transformedContent).toContain("BARB-1779879819520");
      expect(result.transformedContent).toContain("phase22d-rgg-1779879819520");
    });

    it("still detects Luhn-valid credit cards with explicit payment context", () => {
      const result = guard.scanAndTransform("Credit card number: 4111111111111111");
      expect(result.matches.filter((m) => m.type === "credit_card")).toHaveLength(1);
      expect(result.distinctTypes).toContain("credit_card");
    });

    it("returns empty matches for clean content", () => {
      const result = guard.scanAndTransform("This is a safe message with no PII");
      expect(result.matches).toHaveLength(0);
      expect(result.distinctTypes).toHaveLength(0);
      expect(result.tagsToAdd).toHaveLength(0);
      expect(result.transformedContent).toBe("This is a safe message with no PII");
    });

    it("detects multiple PII types", () => {
      const result = guard.scanAndTransform("Email: test@test.com SSN: 123-45-6789");
      expect(result.distinctTypes.length).toBeGreaterThanOrEqual(2);
      expect(result.distinctTypes).toContain("email");
      expect(result.distinctTypes).toContain("ssn_us");
    });

    it("matches are sorted by start position", () => {
      const result = guard.scanAndTransform("SSN 123-45-6789 and email user@test.com");
      if (result.matches.length >= 2) {
        for (let i = 1; i < result.matches.length; i++) {
          expect(result.matches[i].start).toBeGreaterThanOrEqual(result.matches[i - 1].start);
        }
      }
    });
  });

  // ─── Redact mode ───

  describe("redact mode", () => {
    const guard = createFridayMemoryPiiGuard("redact");

    it("redacts email addresses", () => {
      const result = guard.scanAndTransform("Email: user@example.com");
      expect(result.transformedContent).toContain("[EMAIL]");
      expect(result.transformedContent).not.toContain("user@example.com");
    });

    it("preserves proof and project identifiers that look numeric but are not cards", () => {
      const result = guard.scanAndTransform(
        "For this proof run, the user's project codename is BARB-1779879819520. marker=phase22d-rgg-1779879819520.",
      );
      expect(result.transformedContent).toContain("BARB-1779879819520");
      expect(result.transformedContent).toContain("marker=phase22d-rgg-1779879819520");
      expect(result.transformedContent).not.toContain("[CREDIT_CARD]");
      expect(result.tagsToAdd).not.toContain("pii.credit_card");
    });

    it("continues to redact standalone credit cards", () => {
      const result = guard.scanAndTransform("Card: 4111111111111111");
      expect(result.transformedContent).toContain("[CREDIT_CARD]");
      expect(result.transformedContent).not.toContain("4111111111111111");
      expect(result.tagsToAdd).toContain("pii.credit_card");
    });

    it("redacts SSN", () => {
      const result = guard.scanAndTransform("SSN: 123-45-6789");
      expect(result.transformedContent).toContain("[SSN_US]");
      expect(result.transformedContent).not.toContain("123-45-6789");
    });

    it("still returns tags in redact mode", () => {
      const result = guard.scanAndTransform("Email: user@example.com");
      expect(result.tagsToAdd).toContain("pii.email");
    });

    it("leaves clean content unchanged", () => {
      const result = guard.scanAndTransform("No PII here");
      expect(result.transformedContent).toBe("No PII here");
    });
  });

  // ─── Block mode ───

  describe("block mode", () => {
    const guard = createFridayMemoryPiiGuard("block");

    it("still detects PII (blocking is done at guard service level)", () => {
      const result = guard.scanAndTransform("Email: user@example.com");
      expect(result.matches).toHaveLength(1);
      expect(result.distinctTypes).toContain("email");
      // Block mode doesn't transform content — it's the guard service that throws
      expect(result.transformedContent).toBe("Email: user@example.com");
    });
  });

  // ─── Edge cases ───

  it("handles empty string", () => {
    const guard = createFridayMemoryPiiGuard();
    const result = guard.scanAndTransform("");
    expect(result.matches).toHaveLength(0);
  });

  it("detects phone with +1 prefix", () => {
    const guard = createFridayMemoryPiiGuard();
    const result = guard.scanAndTransform("Call +1-555-234-5678");
    expect(result.distinctTypes).toContain("phone_us");
  });

  // ─── redactDeep (metadata + tags) ───

  describe("redactDeep", () => {
    const guard = createFridayMemoryPiiGuard("redact");

    it("redacts PII in string values of a metadata object (incl nested)", () => {
      const { value, tagsToAdd } = guard.redactDeep({
        note: "reach me at user@example.com",
        nested: { phone: "555-234-5678", count: 7 },
        when: "tomorrow",
      });
      const meta = value as { note: string; nested: { phone: string; count: number }; when: string };
      expect(meta.note).toContain("[EMAIL]");
      expect(meta.note).not.toContain("user@example.com");
      expect(meta.nested.phone).toContain("[PHONE_US]");
      expect(meta.nested.count).toBe(7); // non-strings untouched
      expect(meta.when).toBe("tomorrow"); // clean strings untouched
      expect(tagsToAdd).toEqual(expect.arrayContaining(["pii.email", "pii.phone_us"]));
    });

    it("redacts PII in tag strings", () => {
      const { value, tagsToAdd } = guard.redactDeep(["project-x", "ssn 123-45-6789"]);
      const tags = value as string[];
      expect(tags[0]).toBe("project-x");
      expect(tags[1]).toContain("[SSN_US]");
      expect(tags[1]).not.toContain("123-45-6789");
      expect(tagsToAdd).toContain("pii.ssn_us");
    });

    it("returns clean values unchanged with no extra tags", () => {
      const { value, tagsToAdd } = guard.redactDeep({ a: "no pii", b: [1, 2, "also clean"] });
      expect(value).toEqual({ a: "no pii", b: [1, 2, "also clean"] });
      expect(tagsToAdd).toHaveLength(0);
    });

    it("in tag mode, reports PII tags without altering values (non-redact)", () => {
      const tagGuard = createFridayMemoryPiiGuard("tag");
      const { value, tagsToAdd } = tagGuard.redactDeep({ note: "user@example.com" });
      expect((value as { note: string }).note).toBe("user@example.com"); // not redacted in tag mode
      expect(tagsToAdd).toContain("pii.email");
    });
  });
});
