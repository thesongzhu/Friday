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

  // ─── Full-width / width-folding (egress PII correctness) ───
  //
  // The redaction regexes are ASCII-only (\d = [0-9], no `u` flag). Full-width digit
  // (U+FF10–FF19) and separator forms bypassed them, so a Luhn-valid card in full-width
  // form was returned UNREDACTED through the live memory egress/read path. The guard now
  // matches against a *length-preserving* width-folded view (each full-width code unit maps
  // to exactly one ASCII code unit at the SAME index), then redacts the ORIGINAL string at
  // the matched offsets — so match offsets stay valid and surrounding text is untouched.

  // Map ASCII printable + space to its full-width / ideographic-space counterpart.
  function toFullwidth(s: string): string {
    return [...s]
      .map((ch) => {
        const c = ch.charCodeAt(0);
        if (c === 0x20) return "　"; // space → ideographic space
        if (c >= 0x21 && c <= 0x7e) return String.fromCharCode(c + 0xfee0);
        return ch;
      })
      .join("");
  }

  describe("full-width width-fold", () => {
    const guard = createFridayMemoryPiiGuard("redact");

    it("redacts a full-width Luhn-valid card and preserves surrounding text byte-for-byte", () => {
      const card = toFullwidth("4111111111111111"); // ４１１１…, Luhn-valid Visa test number
      const result = guard.scanAndTransform(`カード番号は${card}です`);
      // Exact-equality proves index alignment: only the card span is replaced, the
      // Japanese context is preserved unchanged.
      expect(result.transformedContent).toBe("カード番号は[CREDIT_CARD]です");
      expect(result.distinctTypes).toContain("credit_card");
      expect(result.tagsToAdd).toContain("pii.credit_card");
      // The reported match must span exactly the full-width card (length-preserving fold).
      const cc = result.matches.find((m) => m.type === "credit_card");
      expect(cc?.value).toBe(card);
    });

    it("redacts a full-width US phone number", () => {
      const result = guard.scanAndTransform(`電話は${toFullwidth("555-234-5678")}まで`);
      expect(result.transformedContent).toBe("電話は[PHONE_US]まで");
      expect(result.distinctTypes).toContain("phone_us");
    });

    it("redacts a full-width US SSN", () => {
      const result = guard.scanAndTransform(`SSN ${toFullwidth("123-45-6789")}`);
      expect(result.transformedContent).toContain("[SSN_US]");
      expect(result.transformedContent).not.toContain(toFullwidth("123-45-6789"));
    });

    it("redacts full-width digit groups separated by ASCII spaces", () => {
      // ASCII space is a genuine, unambiguous separator (unlike U+3000 — see the
      // ideographic-space non-bridge test); the card regex's `[ -]` class bridges the groups.
      const card = [
        toFullwidth("4111"),
        toFullwidth("1111"),
        toFullwidth("1111"),
        toFullwidth("1111"),
      ].join(" ");
      const result = guard.scanAndTransform(card);
      expect(result.transformedContent).toBe("[CREDIT_CARD]");
      expect(result.distinctTypes).toContain("credit_card");
    });

    it("redacts a full-width card with full-width hyphen separators", () => {
      const result = guard.scanAndTransform(toFullwidth("4111-1111-1111-1111"));
      expect(result.transformedContent).toBe("[CREDIT_CARD]");
      expect(result.distinctTypes).toContain("credit_card");
    });

    it("redacts a card mixing ASCII and full-width digits", () => {
      const mixed = "4111" + toFullwidth("1111") + "11111111"; // 4111111111111111, Luhn-valid
      const result = guard.scanAndTransform(mixed);
      expect(result.transformedContent).toBe("[CREDIT_CARD]");
      expect(result.distinctTypes).toContain("credit_card");
    });

    it("does NOT redact a full-width NON-Luhn card (Luhn still gates; fold did not over-match)", () => {
      const nonLuhn = toFullwidth("4111111111111112"); // last digit broken → Luhn-invalid
      const result = guard.scanAndTransform(nonLuhn);
      expect(result.matches.filter((m) => m.type === "credit_card")).toHaveLength(0);
      expect(result.distinctTypes).not.toContain("credit_card");
      expect(result.transformedContent).toBe(nonLuhn); // returned unchanged
    });

    it("redacts a folded card at the very start and end of the string", () => {
      const card = toFullwidth("4111111111111111");
      const result = guard.scanAndTransform(card);
      expect(result.transformedContent).toBe("[CREDIT_CARD]");
      const cc = result.matches.find((m) => m.type === "credit_card");
      expect(cc?.start).toBe(0);
      expect(cc?.end).toBe(card.length);
    });

    it("redacts two adjacent PII spans without corrupting the boundary between them", () => {
      const card = toFullwidth("4111111111111111");
      const ssn = toFullwidth("123-45-6789");
      const result = guard.scanAndTransform(`${card} / ${ssn}`);
      expect(result.transformedContent).toBe("[CREDIT_CARD] / [SSN_US]");
    });

    it("redacts full-width PII inside metadata values and tags (redactDeep egress path)", () => {
      const { value, tagsToAdd } = guard.redactDeep({
        note: `card ${toFullwidth("4111111111111111")}`,
        tag: toFullwidth("123-45-6789"),
      });
      const meta = value as { note: string; tag: string };
      expect(meta.note).toContain("[CREDIT_CARD]");
      expect(meta.note).not.toContain(toFullwidth("4111111111111111"));
      expect(meta.tag).toContain("[SSN_US]");
      expect(tagsToAdd).toEqual(expect.arrayContaining(["pii.credit_card", "pii.ssn_us"]));
    });
  });

  // ─── Full-width adjacency: UNION / no-regression (a full-width digit next to an ASCII
  //     PII run must NOT make the ASCII PII vanish) ───
  //
  // A full-width digit is a NON-word char, so in the ORIGINAL string it forms a \b that
  // correctly delimits an adjacent ASCII PII run. Folding it to an ASCII digit turns it into
  // a word char, merging the runs and destroying that \b — the extended run overflows the
  // card length/Luhn gate (or breaks SSN/phone exact-length anchoring) and the match
  // vanishes. Detection must therefore be ADDITIVE: run on the ORIGINAL string too so no
  // pre-existing ASCII match is ever lost.

  describe("full-width adjacency (union superset)", () => {
    const guard = createFridayMemoryPiiGuard("redact");

    it("still redacts an ASCII card immediately followed by a full-width digit", () => {
      const result = guard.scanAndTransform("my card 4111111111111111１ thanks");
      expect(result.transformedContent).toContain("[CREDIT_CARD]");
      expect(result.transformedContent).not.toContain("4111111111111111");
      expect(result.distinctTypes).toContain("credit_card");
    });

    it("still redacts an ASCII card immediately preceded by a full-width digit", () => {
      const result = guard.scanAndTransform("１4111111111111111");
      expect(result.transformedContent).toContain("[CREDIT_CARD]");
      expect(result.transformedContent).not.toContain("4111111111111111");
    });

    it("still redacts an ASCII SSN immediately followed by a full-width digit", () => {
      const result = guard.scanAndTransform("SSN: 123-45-6789１");
      expect(result.transformedContent).toContain("[SSN_US]");
      expect(result.transformedContent).not.toContain("123-45-6789");
    });

    it("still redacts an ASCII phone immediately followed by a full-width digit", () => {
      const result = guard.scanAndTransform("call 234-5678１ now");
      expect(result.transformedContent).toContain("[PHONE_US]");
      expect(result.transformedContent).not.toContain("234-5678");
    });

    it("SUPERSET: the pre-fold (original-string) match span is always still redacted", () => {
      // For each input, the character range the ASCII regex matches on the ORIGINAL string
      // must be fully redacted after the union fix (old redaction span ⊆ new redaction span).
      const cases: Array<{ input: string; leaked: string }> = [
        { input: "my card 4111111111111111１ thanks", leaked: "4111111111111111" },
        { input: "１4111111111111111", leaked: "4111111111111111" },
        { input: "SSN: 123-45-6789１", leaked: "123-45-6789" },
        { input: "call 234-5678１ now", leaked: "234-5678" },
      ];
      for (const c of cases) {
        const out = guard.scanAndTransform(c.input).transformedContent;
        expect(out).not.toContain(c.leaked);
      }
    });
  });

  // ─── U+3000 (ideographic space) must NOT bridge two distinct full-width groups ───

  describe("full-width ideographic-space non-bridge", () => {
    const guard = createFridayMemoryPiiGuard("redact");

    it("does NOT bridge two full-width digit groups joined only by U+3000 into a false card", () => {
      // Bridged, these 8+8 digits would be a Luhn-valid 16-digit card; the ideographic space
      // must keep them separate so legitimate non-card content is not over-redacted.
      const g1 = toFullwidth("41111111");
      const g2 = toFullwidth("11111111");
      const result = guard.scanAndTransform(`${g1}　${g2}`);
      expect(result.distinctTypes).not.toContain("credit_card");
      expect(result.transformedContent).not.toContain("[CREDIT_CARD]");
    });
  });

  // ─── Full-width phone-format chars: period (U+FF0E), parens (U+FF08/FF09) ───
  //
  // Phone/number formats use '.', '(', ')' (and '+') as separators. Folding their full-width
  // forms lets the ASCII phone regex match full-width-formatted numbers. Additive union still
  // applies, so nothing pre-existing is lost.

  describe("full-width phone-format chars", () => {
    const guard = createFridayMemoryPiiGuard("redact");

    it("redacts a full-width phone using full-width PERIOD separators (U+FF0E)", () => {
      // Without folding U+FF0E there is no 7+ contiguous-digit run, so nothing matches → leak.
      const result = guard.scanAndTransform(`電話 ${toFullwidth("234.567.8901")}`);
      expect(result.transformedContent).toContain("[PHONE_US]");
      expect(result.distinctTypes).toContain("phone_us");
    });

    it("redacts the AREA CODE of a full-width parenthesized phone (U+FF08/FF09)", () => {
      // Without folding the full-width parens, only the local `567-8901` matches and the
      // area code `234` LEAKS; folding U+FF09 lets `\)?` extend the match over the area code.
      const result = guard.scanAndTransform(toFullwidth("(234)567-8901"));
      expect(result.transformedContent).toContain("[PHONE_US]");
      expect(result.transformedContent).not.toContain(toFullwidth("234")); // area code redacted
    });
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

  // ─── redactDeep — CONTEXT-AWARE typed PII + object-KEY coverage (lane R62) ───
  //
  // Honest boundary: redactDeep closes three gaps in the deep walker — (1) typed number/bigint
  // values, (2) Date corruption to `{}`, (3) object-KEY PII — WITHOUT inferring PII from digit
  // shape alone. A bare number/bigint is redacted only under TWO gates: its object KEY names a
  // known sensitive field AND the value's string form matches that type's canonical detector
  // (SSN / phone / Luhn card). Ambiguous numerics (business ids, order numbers, epochs, Luhn-
  // valid non-cards), benign numerics under sensitive-SOUNDING keys (gift_card: 3), and pure-
  // numeric object keys are PRESERVED unchanged. The existing string at-rest policy is untouched.
  // This is NOT a claim that every PII representation is caught.

  describe("redactDeep context-aware typed PII — PRESERVED (ambiguous numerics/ids)", () => {
    const guard = createFridayMemoryPiiGuard("redact");

    it("preserves a 9-digit business id under a non-sensitive key", () => {
      const { value, tagsToAdd } = guard.redactDeep({ user_id: 123456789 });
      expect(value).toEqual({ user_id: 123456789 });
      expect(tagsToAdd).toHaveLength(0);
    });

    it("preserves a 10-digit number under a non-sensitive key", () => {
      const { value } = guard.redactDeep({ order_ref: 5552345678 });
      expect((value as { order_ref: unknown }).order_ref).toBe(5552345678);
    });

    it("preserves a 13-digit epoch timestamp", () => {
      const { value } = guard.redactDeep({ created_at_ms: 1_700_000_000_000 });
      expect((value as { created_at_ms: unknown }).created_at_ms).toBe(1_700_000_000_000);
    });

    it("preserves a Luhn-valid 16-digit order id carried as a bigint (no irreversible masking)", () => {
      const { value, tagsToAdd } = guard.redactDeep({ order_id: 4111111111111111n });
      expect((value as { order_id: unknown }).order_id).toBe(4111111111111111n);
      expect(tagsToAdd).toHaveLength(0);
    });

    it("preserves context-less numbers inside an array (no sensitive parent key)", () => {
      const { value, tagsToAdd } = guard.redactDeep({ values: [123456789, 5552345678] });
      expect((value as { values: unknown[] }).values).toEqual([123456789, 5552345678]);
      expect(tagsToAdd).toHaveLength(0);
    });

    it("preserves pure-numeric object keys and their values", () => {
      const { value, tagsToAdd } = guard.redactDeep({
        "123456789": "a",
        "5552345678": "b",
        "4111111111111111": "c",
      });
      const out = value as Record<string, unknown>;
      expect(Object.keys(out).sort()).toEqual(["123456789", "4111111111111111", "5552345678"]);
      expect(out["123456789"]).toBe("a");
      expect(tagsToAdd).toHaveLength(0);
    });

    it("preserves a Date's original type (never corrupted to {})", () => {
      const iso = "2026-07-15T00:00:00.000Z";
      const { value } = guard.redactDeep({ when: new Date(iso) });
      const when = (value as { when: unknown }).when;
      expect(when).toBeInstanceOf(Date);
      expect((when as Date).toISOString()).toBe(iso);
    });

    it("does not treat sensitive-look-alike keys as sensitive", () => {
      const input = {
        phone_count: 5552345678,
        telemetry: 123456789,
        cardinality: 5551234567,
        scorecard: 987654321,
      };
      const { value, tagsToAdd } = guard.redactDeep(structuredClone(input));
      expect(value).toEqual(input);
      expect(tagsToAdd).toHaveLength(0);
    });

    it("preserves benign numerics under sensitive-SOUNDING keys whose value is not type-shaped (value gate)", () => {
      // The key's final normalized token equals a registry word, but the value is a small count
      // / grade / quantity — not card/phone/SSN shaped — so the value gate preserves it. Under
      // key-alone matching (pre-fix) every one of these was masked to a PII token.
      const input = {
        gift_card: 3,
        sim_card: 2,
        sd_card: 1,
        memory_card: 8,
        sound_card: 1,
        graphics_card: 2,
        score_card: 95,
        report_card: 4,
        time_card: 40,
        wild_card: 7,
        head_phone: 42,
        auto_mobile: 9,
        mega_phone: 3,
        saxo_phone: 1,
        dust_pan: 5,
        sauce_pan: 2,
        bed_pan: 6,
        card: 3,
        phone: 42,
        pan: 5,
        mobile: 7,
        cards: 2,
        phones: 1,
      };
      const { value, tagsToAdd } = guard.redactDeep(structuredClone(input));
      expect(value).toEqual(input);
      expect(tagsToAdd).toHaveLength(0);
    });
  });

  describe("redactDeep context-aware typed PII — REDACTED (registry-keyed) [red-first]", () => {
    const guard = createFridayMemoryPiiGuard("redact");

    it("redacts a numeric SSN under an `ssn` key", () => {
      const { value, tagsToAdd } = guard.redactDeep({ ssn: 123456789 });
      expect((value as { ssn: unknown }).ssn).toBe("[SSN_US]");
      expect(tagsToAdd).toContain("pii.ssn_us");
    });

    it("redacts a numeric phone under a `phone` key", () => {
      const { value, tagsToAdd } = guard.redactDeep({ phone: 5552345678 });
      expect((value as { phone: unknown }).phone).toBe("[PHONE_US]");
      expect(tagsToAdd).toContain("pii.phone_us");
    });

    it("redacts a bigint card under a `card` key", () => {
      const { value, tagsToAdd } = guard.redactDeep({ card: 4111111111111111n });
      expect((value as { card: unknown }).card).toBe("[CREDIT_CARD]");
      expect(tagsToAdd).toContain("pii.credit_card");
    });

    it("redacts under normalized key variants (social_security_number / mobileNumber / creditCardNumber / pan)", () => {
      const { value, tagsToAdd } = guard.redactDeep({
        social_security_number: 123456789,
        mobileNumber: 5552345678,
        creditCardNumber: 4111111111111111n,
        pan: 4111111111111111n,
      });
      const out = value as Record<string, unknown>;
      expect(out.social_security_number).toBe("[SSN_US]");
      expect(out.mobileNumber).toBe("[PHONE_US]");
      expect(out.creditCardNumber).toBe("[CREDIT_CARD]");
      expect(out.pan).toBe("[CREDIT_CARD]");
      expect(tagsToAdd).toEqual(
        expect.arrayContaining(["pii.ssn_us", "pii.phone_us", "pii.credit_card"]),
      );
    });

    it("redacts type-shaped numerics under sensitive keys (both key AND value gates pass)", () => {
      const { value, tagsToAdd } = guard.redactDeep({
        credit_card: 4111111111111111, // Luhn-16 (exactly representable as a number)
        card_number: 4111111111111111,
        creditCardNumber: 4111111111111111n, // bigint
        ssn: 123456789, // 9-digit
        social_security: 123456789,
        phone: 5552345678, // valid US phone (area 555, exchange 234)
        tel: 5552345678,
        mobile: 5552345678,
        home_phone: 5552345678,
        mobileNumber: 5552345678,
      });
      const out = value as Record<string, unknown>;
      expect(out.credit_card).toBe("[CREDIT_CARD]");
      expect(out.card_number).toBe("[CREDIT_CARD]");
      expect(out.creditCardNumber).toBe("[CREDIT_CARD]");
      expect(out.ssn).toBe("[SSN_US]");
      expect(out.social_security).toBe("[SSN_US]");
      expect(out.phone).toBe("[PHONE_US]");
      expect(out.tel).toBe("[PHONE_US]");
      expect(out.mobile).toBe("[PHONE_US]");
      expect(out.home_phone).toBe("[PHONE_US]");
      expect(out.mobileNumber).toBe("[PHONE_US]");
      expect(tagsToAdd).toEqual(
        expect.arrayContaining(["pii.credit_card", "pii.ssn_us", "pii.phone_us"]),
      );
    });

    it("redacts numeric elements of an array under a sensitive (plural) key", () => {
      const { value } = guard.redactDeep({ phones: [5552345678, 5559876543] });
      expect((value as { phones: unknown[] }).phones).toEqual(["[PHONE_US]", "[PHONE_US]"]);
    });

    it("does NOT propagate a sensitive key into a nested object (context re-established)", () => {
      const { value } = guard.redactDeep({ ssn: { note: 123456789 } });
      const out = value as { ssn: { note: unknown } };
      expect(out.ssn.note).toBe(123456789);
    });

    it("redacts an email object KEY, preserving the value", () => {
      const { value, tagsToAdd } = guard.redactDeep({ "user@example.com": "hello" });
      const out = value as Record<string, unknown>;
      expect(Object.keys(out)).not.toContain("user@example.com");
      expect(Object.keys(out)).toContain("[EMAIL]");
      expect(out["[EMAIL]"]).toBe("hello");
      expect(tagsToAdd).toContain("pii.email");
    });

    it("redacts an explicit formatted-SSN object KEY (separators present → not a pure-numeric id)", () => {
      const { value } = guard.redactDeep({ "123-45-6789": 1 });
      const out = value as Record<string, unknown>;
      expect(Object.keys(out)).toContain("[SSN_US]");
      expect(out["[SSN_US]"]).toBe(1);
    });

    it("redacts only the PII span of a compound object KEY, keeping surrounding text", () => {
      // String value keeps this focused on KEY redaction (strings are unaffected by the key's
      // inherited PII type; only number/bigint values inherit it).
      const { value } = guard.redactDeep({ "ssn:123-45-6789": "keep" });
      const out = value as Record<string, unknown>;
      expect(Object.keys(out)).toContain("ssn:[SSN_US]");
      expect(out["ssn:[SSN_US]"]).toBe("keep");
    });

    it("keeps BOTH values when two distinct PII keys collapse to the same token (lossless)", () => {
      const { value } = guard.redactDeep({ "a@x.com": 1, "b@y.com": 2 });
      const out = value as Record<string, unknown>;
      expect(Object.keys(out)).not.toContain("a@x.com");
      expect(Object.keys(out)).not.toContain("b@y.com");
      expect(Object.values(out).sort()).toEqual([1, 2]);
    });
  });

  describe("redactDeep — idempotence & PII modes", () => {
    it("is idempotent over key-driven numeric redaction (second pass is a no-op)", () => {
      const guard = createFridayMemoryPiiGuard("redact");
      const once = guard.redactDeep({ ssn: 123456789 }).value;
      const twice = guard.redactDeep(once).value;
      expect(twice).toEqual(once);
      expect(JSON.stringify(twice)).not.toContain("123456789");
    });

    it("tag mode: detects registry-keyed numeric PII WITHOUT altering the value", () => {
      const tagGuard = createFridayMemoryPiiGuard("tag");
      const { value, tagsToAdd } = tagGuard.redactDeep({ ssn: 123456789 });
      expect((value as { ssn: unknown }).ssn).toBe(123456789);
      expect(tagsToAdd).toContain("pii.ssn_us");
    });

    it("block mode: detects registry-keyed numeric PII without altering the value (blocking is enforced by the guard service)", () => {
      const blockGuard = createFridayMemoryPiiGuard("block");
      const { value, tagsToAdd } = blockGuard.redactDeep({ card: 4111111111111111n });
      expect((value as { card: unknown }).card).toBe(4111111111111111n);
      expect(tagsToAdd).toContain("pii.credit_card");
    });
  });

  // ─── Advisor round 2 ─────────────────────────────────────────────────────────
  //
  // Three real defects the independent Advisor found in the two-gate typed-PII redactor.
  // Each block is red-first: it reproduces the leak/bug against the pre-fix code, then the
  // fix makes it pass. Benign controls assert no over-redaction is introduced.

  // ─── F1: keyed numeric US phone stored as a country-code integer (1XXXXXXXXXX) ───
  //
  // A US number persisted numerically loses its leading '+', becoming the 11-digit form
  // 1XXXXXXXXXX. The reused phone detector only accepts +1XXXXXXXXXX (which it cannot even
  // anchor at string start) or the bare 10-digit form, so `redactDeep({phone: 15552345678})`
  // returned the CLEAR value. The fix normalizes the numeric string ONLY under an already-
  // phone-typed key (no shape-only redaction) against the SAME detector.
  describe("redactDeep F1 — keyed numeric country-code US phone (1XXXXXXXXXX) [red-first]", () => {
    const guard = createFridayMemoryPiiGuard("redact");

    it("redacts a numeric country-code phone (1XXXXXXXXXX) under a `phone` key", () => {
      const { value, tagsToAdd } = guard.redactDeep({ phone: 15552345678 });
      expect((value as { phone: unknown }).phone).toBe("[PHONE_US]");
      expect(tagsToAdd).toContain("pii.phone_us");
    });

    it("redacts a bigint country-code phone under a `phone` key", () => {
      const { value, tagsToAdd } = guard.redactDeep({ phone: 15552345678n });
      expect((value as { phone: unknown }).phone).toBe("[PHONE_US]");
      expect(tagsToAdd).toContain("pii.phone_us");
    });

    // Benign controls that MUST still preserve (no new over-redaction, no shape-only path).
    it("preserves a tiny number under a `phone` key (value gate still applies)", () => {
      const { value, tagsToAdd } = guard.redactDeep({ phone: 42 });
      expect((value as { phone: unknown }).phone).toBe(42);
      expect(tagsToAdd).toHaveLength(0);
    });

    it("preserves an 11-digit phone-ish value under a NON-phone key (gift_card → credit_card type)", () => {
      // The KEY governs the type; gift_card is a card key, and 11 digits is not card-shaped,
      // so the value gate preserves it. The phone normalization must NOT leak across key types.
      const { value, tagsToAdd } = guard.redactDeep({ gift_card: 15552345678 });
      expect((value as { gift_card: unknown }).gift_card).toBe(15552345678);
      expect(tagsToAdd).toHaveLength(0);
    });

    it("preserves an 11-digit value under a non-sensitive key (order_id)", () => {
      const { value, tagsToAdd } = guard.redactDeep({ order_id: 15552345678 });
      expect((value as { order_id: unknown }).order_id).toBe(15552345678);
      expect(tagsToAdd).toHaveLength(0);
    });
  });

  // ─── F2: deep nesting must fail CLOSED, never emit an unscanned subtree ───
  //
  // The walker returned the remaining subtree UNCHANGED past the recursion cap (fail-OPEN):
  // a 7-level object carrying `owner@example.com` egressed in cleartext. The fix scans every
  // depth realistic (byte-bounded) input can reach and, at a high structural safety cap
  // (stack-overflow guard), fails CLOSED by replacing the over-deep subtree with a redaction
  // sentinel — never cleartext.
  describe("redactDeep F2 — deep nesting fails CLOSED (no unscanned egress) [red-first]", () => {
    const guard = createFridayMemoryPiiGuard("redact");

    // `depth` levels of {child: …} wrapping a leaf object with an email + keyed phone/ssn.
    function deepPii(depth: number): unknown {
      let node: Record<string, unknown> = {
        contact: "owner@example.com",
        phone: 5552345678,
        ssn: 123456789,
      };
      for (let i = 0; i < depth; i += 1) node = { child: node };
      return node;
    }

    it("redacts PII at depth 7 (previously beyond the depth-6 fail-open boundary)", () => {
      const { value, tagsToAdd } = guard.redactDeep(deepPii(7));
      const json = JSON.stringify(value);
      expect(json).not.toContain("owner@example.com");
      expect(json).not.toContain("5552345678");
      expect(json).not.toContain("123456789");
      expect(json).toContain("[EMAIL]");
      expect(json).toContain("[PHONE_US]");
      expect(json).toContain("[SSN_US]");
      expect(tagsToAdd).toEqual(
        expect.arrayContaining(["pii.email", "pii.phone_us", "pii.ssn_us"]),
      );
    });

    it("redacts PII much deeper (depth 300) — still fully scanned below the safety cap", () => {
      const { value } = guard.redactDeep(deepPii(300));
      const json = JSON.stringify(value);
      expect(json).not.toContain("owner@example.com");
      expect(json).not.toContain("5552345678");
      expect(json).toContain("[EMAIL]");
    });

    it("fails CLOSED beyond the structural safety cap: the over-deep subtree is replaced by a redaction sentinel, never emitted clear", () => {
      const { value } = guard.redactDeep(deepPii(1200));
      const json = JSON.stringify(value);
      expect(json).not.toContain("owner@example.com"); // deep email never leaked
      expect(json).not.toContain("5552345678");
      expect(json).toContain("[REDACTED_DEPTH]"); // fail-closed sentinel present
    });
  });

  // ─── F3: JSON-originated dangerous keys must be OWN data properties (no proto pollution) ───
  //
  // `out[key] = val` invokes the legacy `__proto__` setter for a JSON-originated own key
  // `__proto__`, mutating the output object's prototype AND dropping the field. The fix
  // defines an OWN data property so `__proto__` round-trips and the prototype is unchanged.
  describe("redactDeep F3 — JSON-originated dangerous keys are own data properties [red-first]", () => {
    const guard = createFridayMemoryPiiGuard("redact");

    it("round-trips a JSON `__proto__` own key without mutating the output prototype or dropping data", () => {
      const input = JSON.parse(String.raw`{"__proto__": {"polluted": true}, "safe": 1}`);
      const { value } = guard.redactDeep(input);
      const out = value as Record<string, unknown>;
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype); // prototype untouched
      expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true); // no data drop
      expect(Object.keys(out)).toContain("__proto__");
      expect(out.safe).toBe(1);
      expect(JSON.parse(JSON.stringify(out)).safe).toBe(1); // still JSON-round-trips
      expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // no global pollution
    });

    it("preserves JSON `constructor` and `prototype` own keys as own data properties", () => {
      const input = JSON.parse(String.raw`{"constructor": 1, "prototype": 2, "clean": 3}`);
      const { value } = guard.redactDeep(input);
      const out = value as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(out, "constructor")).toBe(true);
      expect(out.constructor).toBe(1);
      expect(out.prototype).toBe(2);
      expect(out.clean).toBe(3);
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    });

    it("keeps idempotence and collision-safety with a dangerous key", () => {
      const input = JSON.parse(String.raw`{"__proto__": 1}`);
      const once = guard.redactDeep(input).value;
      const twice = guard.redactDeep(once).value;
      expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
      expect(Object.prototype.hasOwnProperty.call(twice as object, "__proto__")).toBe(true);
    });
  });
});
