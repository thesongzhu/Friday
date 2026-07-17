import { describe, it, expect } from "vitest";
import {
  buildUnicodeDetectionCopy,
  redactUnicodeObfuscated,
  type UnicodeNormalizedSpan,
  type UnicodeSpanFinder,
} from "../../../src/security/friday-unicode-pii-normalizer.js";

// PRIV-UNICODE-REDACTION-001: the shared, additive, NON-DESTRUCTIVE Unicode-aware detection layer.
// It normalizes a DETECTION COPY only (Nd digits folded to ASCII by value; zero-width / format /
// default-ignorable code points stripped) and maps matches back to the ORIGINAL span so benign
// multilingual text survives byte-identical.
describe("friday-unicode-pii-normalizer", () => {
  describe("buildUnicodeDetectionCopy", () => {
    it("folds Unicode decimal digits (any Nd script) to ASCII 0-9 by numeric value", () => {
      const cases: Array<[string, string]> = [
        ["+١٤١٥٥٥٥٢٦٧١", "+14155552671"], // Arabic-Indic (U+0660–0669)
        ["+۴۴۷۹۱۱۱۲۳۴۵۶", "+447911123456"], // Extended Arabic-Indic (U+06F0–06F9)
        ["४१११११११११११११११", "4111111111111111"], // Devanagari (U+0966–096F)
        ["２１３５５５０１８８", "2135550188"], // full-width (U+FF10–FF19)
        ["๐๑๒๓๔๕๖๗๘๙", "0123456789"], // Thai (U+0E50–0E59)
      ];
      for (const [input, expected] of cases) {
        expect(buildUnicodeDetectionCopy(input).normalized).toBe(expected);
      }
    });

    it("strips zero-width + format + default-ignorable code points from the detection copy", () => {
      // ZWSP / ZWNJ / ZWJ / WORD JOINER / BOM / variation selector / soft hyphen / CGJ.
      const input = "s​k‌-‍ab⁠cd﻿ef️gh­ij͏kl";
      expect(buildUnicodeDetectionCopy(input).normalized).toBe("sk-abcdefghijkl");
      expect(buildUnicodeDetectionCopy(input).changed).toBe(true);
    });

    it("reports changed=false and identity map for pure-ASCII / benign text", () => {
      for (const benign of ["run-42", "channel:signal:route-in", "hello world 2015550123"]) {
        const copy = buildUnicodeDetectionCopy(benign);
        expect(copy.changed).toBe(false);
        expect(copy.normalized).toBe(benign);
      }
    });

    it("maps every normalized code unit back to a monotonic original code-unit index (astral-safe)", () => {
      const input = "a​b😀c٤"; // ZWSP stripped, astral emoji (2 units), Arabic digit folded
      const copy = buildUnicodeDetectionCopy(input);
      expect(copy.normalized).toBe("ab😀c4");
      // originalIndex has one entry per normalized code unit + a sentinel at the end.
      expect(copy.originalIndex).toHaveLength(copy.normalized.length + 1);
      expect(copy.originalIndex[copy.originalIndex.length - 1]).toBe(input.length);
      // Strictly increasing (no NFKC expansion here — pass-through + fold + strip are all 1:1/strip).
      for (let i = 1; i < copy.originalIndex.length; i += 1) {
        expect(copy.originalIndex[i]).toBeGreaterThan(copy.originalIndex[i - 1]);
      }
    });

    // ── Round-7: combining-mark strip (Mn/Mc/Me) ──
    it("strips combining marks (Mn / Mc / Me) from the detection copy", () => {
      // Combining ACUTE after 6 (the Advisor's probe), Devanagari matra (Mc), enclosing mark (Me).
      const cases: Array<[string, string]> = [
        ["123-45-6́789", "123-45-6789"], // combining acute (Mn) after 6
        ["sk-́abc", "sk-abc"], // combining acute right after '-'
        ["1́23-4́5-67́89", "123-45-6789"], // interspersed Mn marks all stripped
      ];
      for (const [input, expected] of cases) {
        expect(buildUnicodeDetectionCopy(input).normalized).toBe(expected);
        expect(buildUnicodeDetectionCopy(input).changed).toBe(true);
      }
      // Mc (Devanagari sign AA) and Me (combining enclosing circle) are stripped too.
      expect(buildUnicodeDetectionCopy("kाa⃝b").normalized).toBe("kab");
    });

    // ── Round-7: NFKC compatibility folding (math-alphanumeric / fullwidth / ligature / circled / superscript) ──
    it("NFKC-folds compatibility forms (math-alphanumeric / fullwidth / circled / superscript) to ASCII", () => {
      const cases: Array<[string, string]> = [
        ["\u{1D5CC}\u{1D5C4}-abc", "sk-abc"], // 𝗌𝗄- mathematical sans-serif → sk-
        ["\u{1D7D1}\u{1D7D2}\u{1D7D3}", "345"], // 𝟑𝟒𝟓 mathematical bold digits → 345
        ["ＡＢｃ１２３", "ABc123"], // fullwidth letters + digits
        ["①②③", "123"], // circled digits
        ["²³", "23"], // superscript digits
      ];
      for (const [input, expected] of cases) {
        expect(buildUnicodeDetectionCopy(input).normalized).toBe(expected);
      }
    });

    it("maps a multi-char NFKC expansion (ligature) block-atomically: output units share the source index", () => {
      const input = "aﬁb"; // 'a' + LATIN SMALL LIGATURE FI (U+FB01, 1 code unit) + 'b'
      const copy = buildUnicodeDetectionCopy(input);
      expect(copy.normalized).toBe("afib"); // ligature expands to "fi"
      // 'a'@0, ligature@1 → 'f'+'i' both map to 1 (block-atomic), 'b'@2, sentinel@3.
      expect(copy.originalIndex).toEqual([0, 1, 1, 2, 3]);
      // Non-decreasing (weakly monotonic): equal entries occur ONLY inside one source cp's expansion.
      for (let i = 1; i < copy.originalIndex.length; i += 1) {
        expect(copy.originalIndex[i]).toBeGreaterThanOrEqual(copy.originalIndex[i - 1]);
      }
    });

    it("keeps changed=false and identity map for pure-ASCII (fast path preserved after NFKC extension)", () => {
      for (const benign of ["123-45-6789", "sk-abcdefghijklmnop", "run-42 / channel:signal:x"]) {
        const copy = buildUnicodeDetectionCopy(benign);
        expect(copy.changed).toBe(false);
        expect(copy.normalized).toBe(benign);
      }
    });

    it("NO-DEGRADE: benign combining / diacritic text folds for detection but is not corrupted (changed set, shape absent)", () => {
      // café résumé (combining acute), Vietnamese precomposed, benign math word — none is a PII shape.
      const cafe = buildUnicodeDetectionCopy("café");
      expect(cafe.normalized).toBe("cafe"); // detection copy strips the mark
      expect(cafe.changed).toBe(true);
      const mathWord = buildUnicodeDetectionCopy("\u{1D5DB}\u{1D5D8}\u{1D5DF}\u{1D5DF}\u{1D5E2}");
      expect(mathWord.normalized).toBe("HELLO"); // 𝗛𝗘𝗟𝗟𝗢 → HELLO (no PII shape)
    });
  });

  describe("redactUnicodeObfuscated", () => {
    // A trivial finder: redact the ASCII substring "SECRET" wherever it appears in the copy.
    const secretWordFinder: UnicodeSpanFinder = (normalized) => {
      const spans: UnicodeNormalizedSpan[] = [];
      const re = /SECRET/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(normalized)) !== null) {
        spans.push({ start: m.index, end: m.index + m[0].length, replacement: "[X]" });
      }
      return spans;
    };

    it("redacts only the original span a normalized match maps to (zero-width inside a match is removed with it)", () => {
      const input = "pre SE​CRET post"; // ZWSP splits the word
      const out = redactUnicodeObfuscated(input, [secretWordFinder]);
      expect(out).toBe("pre [X] post"); // the whole obfuscated token incl. ZWSP is replaced
      expect(out).not.toContain("​");
    });

    it("returns the input BYTE-IDENTICAL when normalization changed nothing OR no finder matched", () => {
      expect(redactUnicodeObfuscated("plain ascii text", [secretWordFinder])).toBe("plain ascii text");
      // changed=true (ZWJ emoji) but no match → byte-identical, ZWJ preserved.
      const emoji = "family 👨‍👩‍👧 dinner";
      expect(redactUnicodeObfuscated(emoji, [secretWordFinder])).toBe(emoji);
    });

    it("preserves benign surrounding text and a zero-width OUTSIDE any match (non-destructive)", () => {
      const input = "keep​ SE​CRET keep2"; // first ZWSP is outside the match
      const out = redactUnicodeObfuscated(input, [secretWordFinder]);
      expect(out).toBe("keep​ [X] keep2"); // outer ZWSP survives byte-identical
    });

    it("honors finder ORDER as precedence and merges overlapping spans without leaking the tail", () => {
      const wide: UnicodeSpanFinder = (n) => (n.includes("ABCDEF") ? [{ start: n.indexOf("ABCDEF"), end: n.indexOf("ABCDEF") + 6, replacement: "[WIDE]" }] : []);
      const narrow: UnicodeSpanFinder = (n) => (n.includes("CD") ? [{ start: n.indexOf("CD"), end: n.indexOf("CD") + 2, replacement: "[NARROW]" }] : []);
      // Higher-precedence (earlier) finder's placeholder wins; the union span is fully covered.
      const out = redactUnicodeObfuscated("x AB​CDEF y", [wide, narrow]);
      expect(out).toBe("x [WIDE] y");
    });

    // ── Round-7: a match landing mid-NFKC-expansion redacts the WHOLE covering source code point
    //    (block-atomic end-rounding) — no partial-expansion leak, no adjacent benign over-redaction ──
    it("redacts a whole ligature source code point when a match ends INSIDE its NFKC expansion", () => {
      // "aﬁbc" → detection copy "afibc"; the ligature (U+FB01) at original index 1 expands to "fi".
      const matchExact = (needle: string): UnicodeSpanFinder => (n) =>
        n.includes(needle) ? [{ start: n.indexOf(needle), end: n.indexOf(needle) + needle.length, replacement: "[X]" }] : [];

      // Match ONLY the "f" half of the expansion → the whole ligature is redacted, neighbors survive.
      expect(redactUnicodeObfuscated("aﬁbc", [matchExact("f")])).toBe("a[X]bc");
      // Match "ib" (crossing from mid-expansion into the next real char) → ligature + 'b' redacted,
      // 'a' and 'c' survive byte-identical (no tail leak of the ligature, no over-reach onto 'c').
      expect(redactUnicodeObfuscated("aﬁbc", [matchExact("ib")])).toBe("a[X]c");
      // Match the full expansion "fi" → the ligature is redacted, neighbors survive.
      expect(redactUnicodeObfuscated("aﬁbc", [matchExact("fi")])).toBe("a[X]bc");
    });
  });
});
