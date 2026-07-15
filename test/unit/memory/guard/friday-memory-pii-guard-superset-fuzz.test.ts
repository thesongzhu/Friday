import { describe, it, expect } from "vitest";
import {
  createFridayMemoryPiiGuard,
  FRIDAY_MEMORY_GUARD_EMAIL_REGEX,
  FRIDAY_MEMORY_GUARD_US_PHONE_REGEX,
  FRIDAY_MEMORY_GUARD_US_SSN_REGEX,
  FRIDAY_MEMORY_GUARD_CREDIT_CARD_REGEX,
} from "#memory";

// ─── Reference: the ORIGINAL (pre-width-fold) detection, run on the raw input string. ───
function luhnCheck(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}
const CTX_BEFORE =
  /(?:credit\s*card|card(?:\s*number)?|cc|visa|mastercard|master\s*card|amex|american\s*express|discover|payment|billing|account)\s*(?:number|no\.?)?\s*[:#=-]?\s*$/i;
const ID_PREFIX = /[A-Za-z][A-Za-z0-9]{1,31}[-_:]$/;
const ID_SUFFIX = /^[-_:][A-Za-z][A-Za-z0-9]{1,31}/;
function fpCard(content: string, m: RegExpExecArray): boolean {
  const before = content.slice(Math.max(0, m.index - 48), m.index);
  if (CTX_BEFORE.test(before)) return false;
  const after = content.slice(m.index + m[0].length, m.index + m[0].length + 48);
  return ID_PREFIX.test(before) || ID_SUFFIX.test(after);
}
const PATTERNS: Array<{ type: string; regex: RegExp }> = [
  { type: "email", regex: FRIDAY_MEMORY_GUARD_EMAIL_REGEX },
  { type: "phone_us", regex: FRIDAY_MEMORY_GUARD_US_PHONE_REGEX },
  { type: "ssn_us", regex: FRIDAY_MEMORY_GUARD_US_SSN_REGEX },
  { type: "credit_card", regex: FRIDAY_MEMORY_GUARD_CREDIT_CARD_REGEX },
];
function referenceSpans(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const p of PATTERNS) {
    const re = new RegExp(p.regex.source, p.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (p.type === "credit_card") {
        const digits = m[0].replace(/[^0-9]/g, "");
        if (digits.length < 13 || digits.length > 19 || !luhnCheck(digits)) continue;
        if (fpCard(content, m)) continue;
      }
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  return spans;
}

// ─── Deterministic PRNG (LCG) for reproducibility. ───
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
function toFullwidth(str: string): string {
  return [...str].map((ch) => {
    const c = ch.charCodeAt(0);
    if (c === 0x20) return "　";
    if (c >= 0x21 && c <= 0x7e) return String.fromCharCode(c + 0xfee0);
    return ch;
  }).join("");
}

// Alphabet of tokens the generator stitches together — heavy on the risky adjacency cases
// (full-width digits next to ASCII digits, mixed separators, U+3000/commas).
const KNOWN = [
  "4111111111111111", // luhn-valid card
  "5500005555555559", // luhn-valid card
  "123-45-6789",      // ssn
  "234-567-8901",     // phone
  "(234)567-8901",
  "234.567.8901",
  "user@example.com",
];
const NOISE = [
  " ", "-", ".", "(", ")", "+", ",", "　", "0", "1", "9", "5",
  "abc", "カード", "です", "_x-", ":", "BARB-", "credit card ",
];

function randomInput(rng: () => number): string {
  const parts: string[] = [];
  const n = 1 + Math.floor(rng() * 8);
  for (let i = 0; i < n; i++) {
    const pick = rng();
    if (pick < 0.4) {
      let tok = KNOWN[Math.floor(rng() * KNOWN.length)];
      const form = rng();
      if (form < 0.33) tok = toFullwidth(tok);
      else if (form < 0.5) {
        // mixed: fold a random half to full-width
        const cut = Math.floor(rng() * tok.length);
        tok = tok.slice(0, cut) + toFullwidth(tok.slice(cut));
      }
      parts.push(tok);
    } else {
      parts.push(NOISE[Math.floor(rng() * NOISE.length)]);
    }
    // Occasionally jam a stray full-width digit directly against the previous token.
    if (rng() < 0.35) parts.push(toFullwidth(String(Math.floor(rng() * 10))));
  }
  return parts.join("");
}

describe("width-fold superset fuzz (200k)", () => {
  it("union redaction covers every span the original-only ASCII detection finds", () => {
    const guard = createFridayMemoryPiiGuard("redact");
    const rng = makeRng(0x9e3779b9);
    const ITER = 200_000;
    let violations = 0;
    let firstViolation = "";
    let refMatchInputs = 0;
    for (let i = 0; i < ITER; i++) {
      const input = randomInput(rng);
      const ref = referenceSpans(input);
      if (ref.length === 0) continue;
      refMatchInputs++;
      // Coverage set from the NEW union matches.
      const covered = new Set<number>();
      for (const m of guard.scanAndTransform(input).matches) {
        for (let k = m.start; k < m.end; k++) covered.add(k);
      }
      for (const [s, e] of ref) {
        for (let k = s; k < e; k++) {
          if (!covered.has(k)) {
            violations++;
            if (!firstViolation) {
              firstViolation = `idx ${k} of [${s},${e}) uncovered in ${JSON.stringify(input)}`;
            }
            break;
          }
        }
      }
    }
    // The union redaction must never leave un-redacted a span the original-only detection
    // finds (strict superset). `firstViolation` names the first counter-example if any.
    expect(firstViolation).toBe("");
    expect(violations).toBe(0);
    // Non-vacuity: a "0 violations" result is only meaningful if the generator actually
    // produced many PII-bearing inputs (deterministic seed → ~99.7k of 200k).
    expect(refMatchInputs).toBeGreaterThan(20_000);
  });
});
