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

  // ─── redactDeep — Unicode-obfuscated KEY canonicalization (PRIV-UNICODE-REDACTION-001 round-10) ───
  //
  // A bare number/bigint PII value has NO string shape; it relies ENTIRELY on its object KEY naming a
  // PII field (sensitiveTypeForKey → SENSITIVE_KEY_PHRASE_TO_TYPE) to be redacted. The key-NAME
  // classifier derives tokens by ASCII camelCase/lowercase splitting, so a PII-context key hidden
  // behind a zero-width splice, a combining mark, a full-width form, or a precomposed accent never
  // folded to `phone`/`ssn`/`card` — and the numeric value under it LEAKED RAW (RED on 5ec445ed). The
  // guard now Unicode-canonicalizes the key (buildUnicodeDetectionCopy: NFKD → strip \p{M} → strip
  // Cf/Default_Ignorable → fold \p{Nd}) BEFORE token derivation, so the obfuscated key classifies
  // identically to its de-obfuscated ASCII form and the EXISTING key+value gates redact the value.
  // Original obfuscated KEY BYTES are preserved (only the classification input is normalized).
  describe("redactDeep Unicode-obfuscated KEY canonicalization — REDACTED [red-first]", () => {
    const guard = createFridayMemoryPiiGuard("redact");
    // ASCII canary in the name; the constant carries the obfuscation.
    const ZW_PHONE_KEY = "ph​one"; // U+200B zero-width space between `ph` and `one`
    const CM_PHONE_KEY = "phóne"; // U+0301 combining acute over `o`
    const FW_PHONE_KEY = "ｐｈｏｎｅ"; // full-width latin `phone`
    const NF_PHONE_KEY = "phóne"; // precomposed ó (single NFC code point U+00F3)
    const ZWJ_SSN_KEY = "ss‍n"; // U+200D zero-width joiner
    const FW_SSN_KEY = "ｓｓｎ"; // full-width `ssn`
    const FW_CARD_KEY = "ｃａｒｄ"; // full-width `card`
    const CM_MOBILE_KEY = "mobíle"; // combining acute → `mobile`
    const PHONE_NUM = 14155552671; // 11-digit country-code numeric form → [PHONE_US]
    const PHONE_NATIONAL = 5552345678; // 10-digit national → [PHONE_US]
    const SSN_NUM = 123456789;
    const CARD_BIGINT = 4111111111111111n; // pragma: allowlist secret

    it("redacts a numeric phone under each obfuscated `phone` key form (ZW / combining / full-width / precomposed); key bytes preserved", () => {
      for (const key of [ZW_PHONE_KEY, CM_PHONE_KEY, FW_PHONE_KEY, NF_PHONE_KEY]) {
        const { value, tagsToAdd } = guard.redactDeep({ [key]: PHONE_NUM });
        const out = value as Record<string, unknown>;
        expect(out[key]).toBe("[PHONE_US]");
        expect(Object.keys(out)).toEqual([key]); // ORIGINAL obfuscated key bytes preserved exactly
        expect(tagsToAdd).toContain("pii.phone_us");
      }
    });

    it("redacts a numeric SSN under a ZWJ-spliced `ssn` key and a full-width `ssn` key", () => {
      for (const key of [ZWJ_SSN_KEY, FW_SSN_KEY]) {
        const { value, tagsToAdd } = guard.redactDeep({ [key]: SSN_NUM });
        const out = value as Record<string, unknown>;
        expect(out[key]).toBe("[SSN_US]");
        expect(Object.keys(out)).toEqual([key]);
        expect(tagsToAdd).toContain("pii.ssn_us");
      }
    });

    it("redacts a bigint card under a full-width `card` key", () => {
      const { value, tagsToAdd } = guard.redactDeep({ [FW_CARD_KEY]: CARD_BIGINT });
      const out = value as Record<string, unknown>;
      expect(out[FW_CARD_KEY]).toBe("[CREDIT_CARD]");
      expect(Object.keys(out)).toEqual([FW_CARD_KEY]);
      expect(tagsToAdd).toContain("pii.credit_card");
    });

    it("redacts number AND bigint PII under obfuscated keys NESTED and IN ARRAYS", () => {
      const { value } = guard.redactDeep({
        outer: { [FW_PHONE_KEY]: PHONE_NATIONAL }, // nested object, obfuscated key
        [ZW_PHONE_KEY]: [PHONE_NUM, PHONE_NUM], // array threaded from an obfuscated sensitive key
        deep: { level2: { [CM_MOBILE_KEY]: 5552345678n } }, // deep bigint under obfuscated mobile key
        cards: { [FW_CARD_KEY]: [CARD_BIGINT, CARD_BIGINT] }, // array of bigint cards under obf key
      });
      const out = value as {
        outer: Record<string, unknown>;
        deep: { level2: Record<string, unknown> };
        cards: Record<string, unknown>;
      } & Record<string, unknown>;
      expect(out.outer[FW_PHONE_KEY]).toBe("[PHONE_US]");
      expect(out[ZW_PHONE_KEY]).toEqual(["[PHONE_US]", "[PHONE_US]"]);
      expect(out.deep.level2[CM_MOBILE_KEY]).toBe("[PHONE_US]");
      expect(out.cards[FW_CARD_KEY]).toEqual(["[CREDIT_CARD]", "[CREDIT_CARD]"]);
    });

    it("redacts under an obfuscated compound/camelCase key (full-width `mobilePhone`, NFKD preserves case for the split)", () => {
      const key = "ｍｏｂｉｌｅＰｈｏｎｅ"; // full-width `mobilePhone` → NFKD → `mobilePhone` → split → phone
      const { value } = guard.redactDeep({ [key]: PHONE_NATIONAL });
      expect((value as Record<string, unknown>)[key]).toBe("[PHONE_US]");
    });

    it("STRICT SUPERSET: a complete PII token isolated by a foldable non-ASCII letter still redacts (no regression)", () => {
      // The RAW `.split(/[^a-z]+/)` treats the trailing accented letter as a token SEPARATOR that
      // ISOLATES the complete PII token (`ssné`→`ssn`, `telé`→`tel`, `cardé`→`card`) — a match the
      // guard made BEFORE round-10. Canonicalizing the key FIRST would fold `é`→`e` and MERGE it
      // (`ssn`→`ssne`), dropping the match — a superset VIOLATION. The additive union keeps the RAW
      // pass first, so every legacy match survives. (Regression guard: RED if canonicalization ever
      // replaces the raw pass instead of augmenting it.)
      const { value } = guard.redactDeep({
        ssné: 123456789,
        telé: 5552345678,
        cardé: 4111111111111111n, // pragma: allowlist secret
      });
      const out = value as Record<string, unknown>;
      expect(out.ssné).toBe("[SSN_US]");
      expect(out.telé).toBe("[PHONE_US]");
      expect(out.cardé).toBe("[CREDIT_CARD]");
    });
  });

  // NO-DEGRADE: the centralized key canonicalization is a strict SUPERSET — it catches obfuscated PII
  // keys with ZERO benign divergence. The value gate is untouched, so a benign number under a benign
  // (or coincidental) key is never newly over-redacted, and ASCII keys fold BYTE-IDENTICAL (fast path).
  describe("redactDeep Unicode-obfuscated KEY canonicalization — NO-DEGRADE (benign near-miss preserved)", () => {
    const guard = createFridayMemoryPiiGuard("redact");

    it("preserves a benign number under a key that FOLDS CLOSE to but ≠ a PII key (byte-identical)", () => {
      const input = {
        "iph​one": 14155552671, // ZW-spliced → `iphone` (one token) ≠ `phone`
        "café": 14155552671, // precomposed é → `cafe` ≠ any PII key
        "ｔｅｌｅｍｅｔｒｙ": 14155552671, // full-width → `telemetry` ≠ `tel`
        phone_count: 14155552671, // `phone count` — `count` is the final token, not a PII field
        "discárd": 14155552671, // combining mark → `discard` ≠ `card`
      };
      const { value, tagsToAdd } = guard.redactDeep(structuredClone(input));
      expect(value).toEqual(input); // no over-redaction; every key + value byte-identical
      expect(tagsToAdd).toEqual([]);
    });

    it("preserves a benign numeric under an obfuscated sensitive-SOUNDING key whose value is not type-shaped (value gate intact)", () => {
      // full-width `gift_card`/`head_phone` fold to card/phone key-types, but 3/42 are not card/phone
      // shaped, so the VALUE gate preserves them — the same guarantee as the ASCII case.
      const input = { "ｇｉｆｔ_ｃａｒｄ": 3, "ｈｅａｄ_ｐｈｏｎｅ": 42 };
      const { value, tagsToAdd } = guard.redactDeep(structuredClone(input));
      expect(value).toEqual(input);
      expect(tagsToAdd).toEqual([]);
    });

    it("ASCII keys → byte-identical decisions (fast path unchanged: ascii PII redacts, benign preserved)", () => {
      const input = { phone: 5552345678, order_id: 4111111111111111n, gift_card: 3, note: "clean" }; // pragma: allowlist secret
      const { value } = guard.redactDeep(structuredClone(input));
      const out = value as Record<string, unknown>;
      expect(out.phone).toBe("[PHONE_US]"); // ASCII sensitive key still redacts
      expect(out.order_id).toBe(4111111111111111n); // benign bigint id preserved
      expect(out.gift_card).toBe(3); // value gate preserves
      expect(out.note).toBe("clean");
    });
  });

  // ─── redactDeep — Unicode-obfuscated key-CONTENT PII redaction (PRIV-UNICODE-REDACTION-001 round-11) ───
  //
  // The OTHER key leg from round-10. Round-10 made the key-NAME→type CLASSIFICATION Unicode-aware (a
  // numeric VALUE under an obfuscated `phone`/`ssn`/`card` key). This closes key-CONTENT PII: the KEY
  // STRING ITSELF is PII — an email / SSN / card written AS AN OBJECT KEY and obfuscated so the raw
  // ASCII (+ full-width-digit) matcher misses it. Before round-11, `redactKey` ran ONLY `findMatches`,
  // so an obfuscated PII KEY persisted BYTE-FOR-BYTE (RED). It now runs the SAME PII detectors over the
  // shared de-obfuscated detection copy (`redactUnicodeObfuscated`), maps each span back to the ORIGINAL
  // key, and redacts it — additively over the retained legacy raw pass, with the ALL-Nd exemption and
  // key-collision preservation intact. The value is untouched; only the key is redacted.
  //
  // Helper: map ASCII digits of a template to any Nd decimal block by numeric value (separators kept).
  const toNd = (ascii: string, zeroCp: number): string =>
    ascii.replace(/[0-9]/g, (d) => String.fromCodePoint(zeroCp + Number(d)));

  describe("redactDeep Unicode-obfuscated key-CONTENT PII — REDACTED [red-first]", () => {
    const guard = createFridayMemoryPiiGuard("redact");

    // Obfuscated EMAIL key forms (ASCII-fold `victim@example.com`); each carries the obfuscation.
    const ZW_EMAIL_KEY = "victim@examp​le.com"; // U+200B zero-width space in the domain
    const ZWNJ_EMAIL_KEY = "victim@examp‌le.com"; // U+200C zero-width non-joiner
    const WJ_EMAIL_KEY = "victim@examp⁠le.com"; // U+2060 word joiner
    const BOM_EMAIL_KEY = "victim@exa﻿mple.com"; // U+FEFF BOM / ZW no-break space
    const CM_EMAIL_KEY = "víctim@example.com"; // U+0301 combining acute on `i`
    const NF_EMAIL_KEY = "víctim@example.com"; // precomposed í (single NFC code point U+00ED)
    const FW_EMAIL_KEY = "ｖｉｃｔｉｍ@example.com"; // full-width `victim` letters
    const MATH_EMAIL_KEY = "\u{1D5CB}\u{1D5C2}\u{1D5BC}\u{1D5CD}\u{1D5C2}\u{1D5C6}@example.com"; // math sans-serif `victim`
    const EMAIL_FOLDED = "victim@example.com";

    it("redacts an email KEY STRING under every obfuscation family (ZW / ZWNJ / WJ / BOM / combining / precomposed / full-width / math-alnum); value preserved", () => {
      for (const key of [
        ZW_EMAIL_KEY, ZWNJ_EMAIL_KEY, WJ_EMAIL_KEY, BOM_EMAIL_KEY,
        CM_EMAIL_KEY, NF_EMAIL_KEY, FW_EMAIL_KEY, MATH_EMAIL_KEY,
      ]) {
        const { value, tagsToAdd } = guard.redactDeep({ [key]: "hello" });
        const out = value as Record<string, unknown>;
        expect(Object.keys(out)).toEqual(["[EMAIL]"]); // key redacted whole-span
        expect(Object.keys(out)).not.toContain(key); // raw obfuscated key absent
        expect(Object.keys(out).join("")).not.toContain(EMAIL_FOLDED); // de-obfuscated form absent
        expect(out["[EMAIL]"]).toBe("hello"); // value preserved
        expect(tagsToAdd).toContain("pii.email");
      }
    });

    it("redacts an SSN KEY STRING under Arabic-Indic / Extended-Arabic / Devanagari / zero-width / combining families", () => {
      const AR_SSN = toNd("123-45-6789", 0x0660); // Arabic-Indic
      const EXT_AR_SSN = toNd("123-45-6789", 0x06f0); // Extended Arabic-Indic
      const DEV_SSN = toNd("123-45-6789", 0x0966); // Devanagari
      const ZW_SSN = "123-45-​6789"; // zero-width space
      const CM_SSN = "123-45-6́789"; // combining acute
      for (const key of [AR_SSN, EXT_AR_SSN, DEV_SSN, ZW_SSN, CM_SSN]) {
        const { value, tagsToAdd } = guard.redactDeep({ [key]: 1 });
        const out = value as Record<string, unknown>;
        expect(Object.keys(out)).toContain("[SSN_US]");
        expect(Object.keys(out)).not.toContain(key);
        expect(Object.keys(out).join("")).not.toContain("123-45-6789");
        expect(out["[SSN_US]"]).toBe(1); // value preserved
        expect(tagsToAdd).toContain("pii.ssn_us");
      }
    });

    it("redacts a Luhn card KEY STRING under Arabic-Indic / full-width-with-separators / combining / zero-width families", () => {
      const AR_CARD = toNd("4111-1111-1111-1111", 0x0660); // Arabic-Indic w/ ASCII separators // pragma: allowlist secret
      const FW_CARD = "４１１１-１１１１-１１１１-１１１１"; // full-width digits + ASCII hyphens (NOT all-Nd) // pragma: allowlist secret
      const CM_CARD = "4́111 1111 1111 1111"; // combining acute after first digit // pragma: allowlist secret
      const ZW_CARD = "4111​1111​1111​1111"; // zero-width spaces // pragma: allowlist secret
      for (const key of [AR_CARD, FW_CARD, CM_CARD, ZW_CARD]) {
        const { value, tagsToAdd } = guard.redactDeep({ [key]: "x" });
        const out = value as Record<string, unknown>;
        expect(Object.keys(out)).toContain("[CREDIT_CARD]");
        expect(Object.keys(out)).not.toContain(key);
        expect(Object.keys(out).join("")).not.toContain("4111111111111111"); // pragma: allowlist secret
        expect(out["[CREDIT_CARD]"]).toBe("x");
        expect(tagsToAdd).toContain("pii.credit_card");
      }
    });

    it("redacts obfuscated PII KEY STRINGS NESTED and IN ARRAYS (object keys at every position)", () => {
      const { value } = guard.redactDeep({
        outer: { [ZW_EMAIL_KEY]: "v1" }, // nested object, obfuscated email key
        list: [{ [CM_EMAIL_KEY]: "v2" }, { [toNd("123-45-6789", 0x0660)]: 2 }], // objects INSIDE an array
        deep: { l2: { [FW_EMAIL_KEY]: "v3" } }, // deeper nesting
      });
      const out = value as {
        outer: Record<string, unknown>;
        list: Array<Record<string, unknown>>;
        deep: { l2: Record<string, unknown> };
      };
      expect(Object.keys(out.outer)).toEqual(["[EMAIL]"]);
      expect(out.outer["[EMAIL]"]).toBe("v1");
      expect(Object.keys(out.list[0])).toEqual(["[EMAIL]"]);
      expect(out.list[0]["[EMAIL]"]).toBe("v2");
      expect(Object.keys(out.list[1])).toEqual(["[SSN_US]"]);
      expect(out.list[1]["[SSN_US]"]).toBe(2);
      expect(Object.keys(out.deep.l2)).toEqual(["[EMAIL]"]);
      expect(out.deep.l2["[EMAIL]"]).toBe("v3");
    });

    it("redacts ONLY the PII span of a compound obfuscated KEY, keeping surrounding text", () => {
      // `contact:` prefix + a zero-width-spliced email → prefix survives, email span redacted.
      const key = "contact:victim@examp​le.com";
      const { value } = guard.redactDeep({ [key]: "keep" });
      const out = value as Record<string, unknown>;
      expect(Object.keys(out)).toEqual(["contact:[EMAIL]"]);
      expect(out["contact:[EMAIL]"]).toBe("keep");
    });

    // COVERAGE-SENSITIVITY NEGATIVE (Advisor requirement). For EACH required Unicode family, prove the
    // coverage is LOAD-BEARING and complete two ways in ONE assertion pair:
    //   (a) the RAW ASCII (+ full-width-digit) matcher `scanAndTransform` — the exact detection the
    //       pre-round-11 `redactKey` used — finds NOTHING on the obfuscated key (so redaction cannot be
    //       an accident of the raw matcher);
    //   (b) the full `redactDeep` key path DOES redact it (so the Unicode normalization is what catches
    //       it). If ANY family were dropped from the shared normalizer (zero-width / combining /
    //       Arabic-Indic / full-width-letter / precomposed / NFKD-math) — or if Unicode key
    //       normalization were disabled entirely — that family's row fails (b) and this test turns RED.
    it("COVERAGE-SENSITIVITY: each Unicode family is load-bearing — raw matcher MISSES it, Unicode key path CATCHES it", () => {
      // Obfuscations chosen so the raw ASCII (+ full-width-digit) matcher finds NOTHING (not even a
      // fragment): the combining / precomposed marks sit in the DOMAIN (breaking the `\.TLD`), and the
      // full-width / math letters sit in the local part (no ASCII char immediately before `@`).
      const rawMissThenRedactedFamilies: Array<{ family: string; key: string; marker: string }> = [
        { family: "zero-width (U+200B)", key: ZW_EMAIL_KEY, marker: "[EMAIL]" },
        { family: "combining-mark (U+0301)", key: "victim@exa\u0301mple.com", marker: "[EMAIL]" },
        { family: "Arabic-Indic (U+0660)", key: toNd("123-45-6789", 0x0660), marker: "[SSN_US]" },
        { family: "Extended-Arabic (U+06F0)", key: toNd("123-45-6789", 0x06f0), marker: "[SSN_US]" },
        { family: "Devanagari (U+0966)", key: toNd("123-45-6789", 0x0966), marker: "[SSN_US]" },
        { family: "full-width letters (U+FF__)", key: FW_EMAIL_KEY, marker: "[EMAIL]" },
        { family: "precomposed NFC (U+00E1)", key: "victim@ex\u00e1mple.com", marker: "[EMAIL]" },
        { family: "NFKD math-alnum (U+1D5__)", key: MATH_EMAIL_KEY, marker: "[EMAIL]" },
      ];
      for (const { family, key, marker } of rawMissThenRedactedFamilies) {
        // (a) The raw ASCII (+ full-width-digit) matcher misses the obfuscated key entirely — so
        //     the redaction below is NOT an accident of the legacy matcher; it is the Unicode layer.
        expect(guard.scanAndTransform(key).matches, `raw matcher must MISS ${family}`).toHaveLength(0);
        // (b) The Unicode-aware key path redacts it. Omitting this family from the normalizer → RED here.
        const { value } = guard.redactDeep({ [key]: "v" });
        expect(Object.keys(value as Record<string, unknown>), `Unicode key path must CATCH ${family}`).toContain(marker);
      }
    });
  });

  // NO-DEGRADE for round-11 key-CONTENT redaction: benign keys, all-Nd keys, and key collisions.
  describe("redactDeep Unicode-obfuscated key-CONTENT PII — NO-DEGRADE", () => {
    const guard = createFridayMemoryPiiGuard("redact");

    it("preserves benign multilingual / near-miss KEYS byte-identical (no PII shape → untouched, no tags)", () => {
      const input = {
        "café_naïve": "a", // precomposed accents, no PII shape
        "日本語_ключ": "b", // CJK + Cyrillic
        "user​name": "c", // zero-width in a benign word
        "ｕｓｅｒＩＤ": "d", // full-width `userID` (folds to a benign word, no PII)
        "victim@example": "e", // near-miss email (no TLD) → not an email shape
        "family \u{1F468}‍\u{1F469}‍\u{1F467} dinner": "f", // ZWJ emoji key
      };
      const { value, tagsToAdd } = guard.redactDeep(structuredClone(input));
      expect(value).toEqual(input); // every key + value byte-identical
      expect(tagsToAdd).toEqual([]);
    });

    it("preserves ALL-Nd pure-digit KEYS (any script) verbatim — the business-id exemption is retained", () => {
      const input: Record<string, string> = {};
      input["4111111111111111"] = "ascii"; // pragma: allowlist secret
      input["４１１１１１１１１１１１１１１１"] = "fullwidth"; // all full-width digits // pragma: allowlist secret
      input[toNd("4111111111111111", 0x0660)] = "arabic"; // all Arabic-Indic digits // pragma: allowlist secret
      input[toNd("123456789", 0x0966)] = "devanagari"; // all Devanagari digits
      const { value, tagsToAdd } = guard.redactDeep(structuredClone(input));
      expect(value).toEqual(input); // NOT folded into [CREDIT_CARD]/[SSN_US]; byte-identical
      expect(tagsToAdd).toEqual([]);
      expect(Object.keys(value as Record<string, unknown>)).not.toContain("[CREDIT_CARD]");
    });

    it("KEY COLLISION: two DISTINCT obfuscated email keys collapsing to [EMAIL] keep BOTH values (disambiguated)", () => {
      const k1 = "a@examp​le.com"; // zero-width
      const k2 = "b@exámple.com"; // combining mark
      const { value } = guard.redactDeep({ [k1]: 1, [k2]: 2 });
      const out = value as Record<string, unknown>;
      expect(Object.keys(out)).not.toContain(k1);
      expect(Object.keys(out)).not.toContain(k2);
      expect(Object.values(out).sort()).toEqual([1, 2]); // both values survive (lossless)
      expect(Object.keys(out).every((k) => k.startsWith("[EMAIL]"))).toBe(true);
    });

    it("tag mode: an obfuscated PII KEY surfaces its pii.* tag but is NOT mutated", () => {
      const tagGuard = createFridayMemoryPiiGuard("tag");
      const { value, tagsToAdd } = tagGuard.redactDeep({ [`victim@examp​le.com`]: "x" });
      const out = value as Record<string, unknown>;
      expect(Object.keys(out)).toContain("victim@examp​le.com"); // key bytes UNCHANGED in tag mode
      expect(tagsToAdd).toContain("pii.email"); // but the tag is surfaced
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

  // ─── F2 (Advisor round 2): deep nesting is FULLY SCANNED — no cap, no sentinel ───
  //
  // The prior round replaced every subtree past a fixed recursion cap (depth 500) with a
  // "[REDACTED_DEPTH]" sentinel in ALL modes. That silently CORRUPTED valid deep user metadata
  // (canonical-data loss — DATA-RETENTION-001) and violated the tag/block non-transform
  // contract. The rewrite makes the walker ITERATIVE (heap work stack) + CYCLE-AWARE + FULL-
  // SCAN: bounded only by the upstream 16 KiB metadata byte-limit, every admitted structure is
  // scanned to its leaves. Deep PII is ALWAYS found (the F2 leak stays closed) AND benign deep
  // data round-trips UNCHANGED (the new data-loss defect is fixed). No sentinel exists anymore.
  describe("redactDeep F2 — deep nesting fully scanned, no cap/sentinel [red-first]", () => {
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

    // `depth` levels of {child: …} wrapping a purely BENIGN leaf that must round-trip unchanged.
    function deepBenign(depth: number): unknown {
      let node: Record<string, unknown> = { keepme: "benign-canonical-marker", count: 42 };
      for (let i = 0; i < depth; i += 1) node = { child: node, idx: i };
      return node;
    }

    it("redacts PII at depth 7 (regression — was the depth-6 fail-open boundary)", () => {
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

    it("redacts PII much deeper (depth 300) — regression, was below the old cap", () => {
      const { value } = guard.redactDeep(deepPii(300));
      const json = JSON.stringify(value);
      expect(json).not.toContain("owner@example.com");
      expect(json).not.toContain("5552345678");
      expect(json).toContain("[EMAIL]");
    });

    // Red-first: on the pre-fix code the leaf sits past the depth-500 cap, so it was replaced by
    // the sentinel (no [EMAIL], a "[REDACTED_DEPTH]" instead). Now it is fully scanned.
    it.each([501, 1200, 2000])(
      "redacts deep PII at depth %i — no sentinel, no leak (red-first)",
      (depth) => {
        const { value, tagsToAdd } = guard.redactDeep(deepPii(depth));
        const json = JSON.stringify(value);
        expect(json).not.toContain("owner@example.com"); // no cleartext leak
        expect(json).not.toContain("5552345678");
        expect(json).not.toContain("123456789");
        expect(json).not.toContain("[REDACTED_DEPTH]"); // sentinel is gone entirely
        expect(json).toContain("[EMAIL]"); // deep PII actually redacted
        expect(json).toContain("[PHONE_US]");
        expect(json).toContain("[SSN_US]");
        expect(tagsToAdd).toEqual(
          expect.arrayContaining(["pii.email", "pii.phone_us", "pii.ssn_us"]),
        );
      },
    );

    // Red-first: on the pre-fix code the benign leaf past depth 500 was CORRUPTED to the
    // sentinel (silent canonical-data loss). Now deep benign metadata round-trips byte-identical.
    it.each([501, 1200, 2000])(
      "round-trips BENIGN deep data UNCHANGED at depth %i (no silent loss — red-first)",
      (depth) => {
        const input = deepBenign(depth);
        const { value, tagsToAdd } = guard.redactDeep(input);
        const json = JSON.stringify(value);
        expect(json).not.toContain("[REDACTED_DEPTH]"); // never corrupted
        expect(json).toContain("benign-canonical-marker"); // deep canonical value survives
        expect(json).toBe(JSON.stringify(input)); // byte-identical round-trip
        expect(tagsToAdd).toHaveLength(0); // no PII → no tags
      },
    );
  });

  // ─── F2b (Advisor round 2): the tag/block MODE CONTRACTS hold at ANY depth ───
  //
  // The old sentinel replaced deep subtrees regardless of mode. tag mode MUST NOT transform any
  // value; block mode MUST surface a pii.* tag for PII at any depth so the guard service can
  // reject the whole write (never persist an untagged "scanned-clean" sentinel).
  describe("redactDeep F2b — deep mode contracts (tag non-transform / block tags) [red-first]", () => {
    function deepNode(depth: number, leaf: Record<string, unknown>): unknown {
      let node: Record<string, unknown> = leaf;
      for (let i = 0; i < depth; i += 1) node = { child: node };
      return node;
    }

    it("tag mode: deep subtree is returned UNCHANGED (no sentinel, no value transform)", () => {
      const tagGuard = createFridayMemoryPiiGuard("tag");
      const input = deepNode(1200, { contact: "owner@example.com", phone: 5552345678, note: "keep-me" });
      const { value, tagsToAdd } = tagGuard.redactDeep(input);
      const json = JSON.stringify(value);
      expect(json).not.toContain("[REDACTED_DEPTH]");
      expect(json).toBe(JSON.stringify(input)); // tag mode transforms NOTHING, even deep
      expect(json).toContain("owner@example.com"); // value untouched
      expect(json).toContain("5552345678");
      // …but the deep PII is still DETECTED and reported as tags.
      expect(tagsToAdd).toEqual(expect.arrayContaining(["pii.email", "pii.phone_us"]));
    });

    it("block mode: deep PII yields pii.* tags (so the blocker can reject) — no untagged sentinel", () => {
      const blockGuard = createFridayMemoryPiiGuard("block");
      const input = deepNode(1200, { contact: "owner@example.com", ssn: 123456789 });
      const { value, tagsToAdd } = blockGuard.redactDeep(input);
      const json = JSON.stringify(value);
      // block mode does not transform values here (the guard service throws on tagsToAdd);
      // crucially the deep PII must be TAGGED, never silently replaced by an untagged sentinel.
      expect(json).not.toContain("[REDACTED_DEPTH]");
      expect(tagsToAdd).toEqual(expect.arrayContaining(["pii.email", "pii.ssn_us"]));
    });
  });

  // ─── F2c (Advisor round 2): cycle safety — no hang, no stack overflow ───
  //
  // A cyclic object must terminate: the ancestor-path guard breaks the back-edge (structural
  // share, no data loss) instead of infinite-looping. The old recursive walker would stack-
  // overflow (or, past the cap, sentinel-truncate) a deep/cyclic structure.
  describe("redactDeep F2c — cycle safety (terminates, each node once) [red-first]", () => {
    const guard = createFridayMemoryPiiGuard("redact");

    it("terminates on a direct self-cycle and still redacts the PII leaf", () => {
      const node: Record<string, unknown> = { contact: "owner@example.com", phone: 5552345678 };
      node.self = node; // cycle
      const { value, tagsToAdd } = guard.redactDeep(node);
      const out = value as Record<string, unknown>;
      expect(out.contact).toBe("[EMAIL]"); // PII in the cyclic node is redacted
      expect(out.phone).toBe("[PHONE_US]");
      expect(out.self).toBe(out); // back-edge preserved as a structural self-reference
      expect(tagsToAdd).toEqual(expect.arrayContaining(["pii.email", "pii.phone_us"]));
    });

    it("terminates on a mutual (A→B→A) cycle nested under a benign parent", () => {
      const a: Record<string, unknown> = { email: "a-owner@example.com" };
      const b: Record<string, unknown> = { ssn: 123456789, back: a };
      a.next = b; // A → B → A
      const { value } = guard.redactDeep({ root: a, note: "keep" });
      const out = value as { root: Record<string, unknown>; note: string };
      expect(out.note).toBe("keep");
      expect(out.root.email).toBe("[EMAIL]");
      const bOut = out.root.next as Record<string, unknown>;
      expect(bOut.ssn).toBe("[SSN_US]");
      expect(bOut.back).toBe(out.root); // cycle closed back onto the same output node
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

  // ─── Advisor round 3 — pure-numeric object-KEY exemption is Unicode-width/script-consistent ───
  //
  // The pure-numeric object-KEY exemption ("a bare digit-only key is an ambiguous business id —
  // preserve it verbatim") was tested with an ASCII-only /^\d+$/, but the PII matcher applies a
  // full-width fold. So the ASCII key "4111111111111111" was preserved (correct) while its
  // semantically-identical FULL-WIDTH form was folded, matched as a card, and IRREVERSIBLY renamed
  // to "[CREDIT_CARD]" — silently breaking canonical-lookup identity (DATA-RETENTION-001 no
  // corruption; PRIV-UNICODE-REDACTION-001 benign-multilingual no-degrade). The exemption is now
  // Unicode-decimal-aware (/^\p{Nd}+$/u): a KEY composed ENTIRELY of Unicode decimal digits in ANY
  // script (ASCII / full-width / Arabic-Indic / mixed) with NO separators is preserved; a FORMATTED
  // PII key (separators/context present) STILL redacts; the VALUE path is unchanged (a full-width
  // card VALUE still redacts). Red-first: tests [1] and [3] FAIL on the pre-fix ASCII-only check.
  describe("redactDeep — pure-numeric object-KEY exemption is Unicode-width/script-consistent (Advisor round 3) [red-first]", () => {
    const guard = createFridayMemoryPiiGuard("redact");

    // ASCII 0x21–0x7E → full-width (U+FF01–FF5E); ASCII space → ideographic space.
    const fw = (s: string): string =>
      [...s]
        .map((ch) => {
          const c = ch.charCodeAt(0);
          if (c === 0x20) return "　";
          if (c >= 0x21 && c <= 0x7e) return String.fromCharCode(c + 0xfee0);
          return ch;
        })
        .join("");
    // ASCII digits → Arabic-Indic digits (U+0660–U+0669).
    const ai = (s: string): string =>
      [...s]
        .map((ch) =>
          ch >= "0" && ch <= "9" ? String.fromCharCode(0x0660 + (ch.charCodeAt(0) - 0x30)) : ch,
        )
        .join("");

    const CARD = "4111111111111111"; // Luhn-valid Visa test number

    it("[1] preserves a FULL-WIDTH pure-numeric KEY byte-identical (NOT renamed to [CREDIT_CARD])", () => {
      const key = fw(CARD);
      const { value, tagsToAdd } = guard.redactDeep({ [key]: "x" });
      const out = value as Record<string, unknown>;
      expect(Object.keys(out)).toContain(key); // byte-identical preservation of the business id
      expect(Object.keys(out)).not.toContain("[CREDIT_CARD]");
      expect(out[key]).toBe("x");
      expect(tagsToAdd).toHaveLength(0);
    });

    it("[2] preserves an ASCII pure-numeric KEY (regression)", () => {
      const { value, tagsToAdd } = guard.redactDeep({ [CARD]: "x" });
      const out = value as Record<string, unknown>;
      expect(Object.keys(out)).toContain(CARD);
      expect(Object.keys(out)).not.toContain("[CREDIT_CARD]");
      expect(out[CARD]).toBe("x");
      expect(tagsToAdd).toHaveLength(0);
    });

    it("[3] preserves a MIXED-WIDTH digit-only KEY (ASCII + full-width, no separators)", () => {
      const key = "4111" + fw("111111111111"); // 16 digits, mixed width, no separators
      const { value, tagsToAdd } = guard.redactDeep({ [key]: "x" });
      const out = value as Record<string, unknown>;
      expect(Object.keys(out)).toContain(key);
      expect(Object.keys(out)).not.toContain("[CREDIT_CARD]");
      expect(out[key]).toBe("x");
      expect(tagsToAdd).toHaveLength(0);
    });

    it("[4] preserves an ARABIC-INDIC digit-only KEY", () => {
      const key = ai(CARD);
      const { value, tagsToAdd } = guard.redactDeep({ [key]: "x" });
      const out = value as Record<string, unknown>;
      expect(Object.keys(out)).toContain(key);
      expect(Object.keys(out)).not.toContain("[CREDIT_CARD]");
      expect(out[key]).toBe("x");
      expect(tagsToAdd).toHaveLength(0);
    });

    it("[5] CONTROL: a FORMATTED full-width card KEY (separators present) STILL redacts", () => {
      const key = fw("4111-1111-1111-1111"); // full-width dashes → not a pure digit-only id → PII
      const { value, tagsToAdd } = guard.redactDeep({ [key]: "x" });
      const out = value as Record<string, unknown>;
      expect(Object.keys(out)).not.toContain(key);
      expect(Object.keys(out)).toContain("[CREDIT_CARD]");
      expect(out["[CREDIT_CARD]"]).toBe("x");
      expect(tagsToAdd).toContain("pii.credit_card");
    });

    it("[6] CONTROL: a full-width card as a VALUE still redacts (key-path change did not weaken values)", () => {
      const { value, tagsToAdd } = guard.redactDeep({ note: fw(CARD) });
      const out = value as { note: string };
      expect(out.note).toBe("[CREDIT_CARD]");
      expect(out.note).not.toContain(fw(CARD));
      expect(tagsToAdd).toContain("pii.credit_card");
    });
  });
});
