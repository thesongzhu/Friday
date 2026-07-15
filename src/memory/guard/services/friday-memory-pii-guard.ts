import type {
  FridayMemoryGuardPiiGuard,
  FridayMemoryGuardPiiMatch,
  FridayMemoryGuardPiiMode,
  FridayMemoryGuardPiiScanResult,
  FridayMemoryGuardPiiType,
} from "../model/friday-memory-guard.types.js";

import {
  FRIDAY_MEMORY_GUARD_CREDIT_CARD_REGEX,
  FRIDAY_MEMORY_GUARD_EMAIL_REGEX,
  FRIDAY_MEMORY_GUARD_PII_MODE,
  FRIDAY_MEMORY_GUARD_PII_TAG_PREFIX,
  FRIDAY_MEMORY_GUARD_US_PHONE_REGEX,
  FRIDAY_MEMORY_GUARD_US_SSN_REGEX,
} from "../friday-memory-guard.constants.js";

interface PiiPattern {
  type: FridayMemoryGuardPiiType;
  regex: RegExp;
}

const PII_PATTERNS: PiiPattern[] = [
  { type: "email", regex: FRIDAY_MEMORY_GUARD_EMAIL_REGEX },
  { type: "phone_us", regex: FRIDAY_MEMORY_GUARD_US_PHONE_REGEX },
  { type: "ssn_us", regex: FRIDAY_MEMORY_GUARD_US_SSN_REGEX },
  { type: "credit_card", regex: FRIDAY_MEMORY_GUARD_CREDIT_CARD_REGEX },
];

/**
 * Length-preserving width fold used ONLY for matching. Folds full-width decimal digits
 * (U+FF10–FF19) → 0–9 plus the full-width number separators/format chars used by phone and
 * card formats: hyphen-minus U+FF0D → '-', plus U+FF0B → '+', left/right paren U+FF08/FF09
 * → '(' / ')', and full stop U+FF0E → '.'. Every mapped code unit is a single BMP code unit
 * replaced by exactly one ASCII code unit, so `String.length` and every offset stay
 * identical to the original — a match found in the folded view maps to the SAME
 * [start, end) in the ORIGINAL string.
 *
 * Deliberate scope decisions (only ADD detection, never over-redact):
 *  - NFKC is NOT used: it can change string length (ligatures / compatibility forms) and
 *    would break index alignment.
 *  - U+3000 (ideographic space) and U+FF0C (full-width comma) are NOT folded. The card
 *    regex's `[ -]` class would otherwise bridge two distinct full-width number groups
 *    separated only by such a char into one false card (over-redaction of legitimate
 *    content).
 *
 * NOTE: folding a full-width DIGIT (a non-word char) into an ASCII digit (a word char) can
 * merge it with an adjacent ASCII digit run and destroy a `\b` the ASCII-only regexes rely
 * on. `findMatches` therefore uses this fold ADDITIVELY — detection also runs on the
 * original string — so a match the unfolded scan would find is never lost.
 */
function foldWidthForMatching(content: string): string {
  return content.replace(/[\uFF08\uFF09\uFF0B\uFF0D\uFF0E\uFF10-\uFF19]/g, (ch) =>
    // Every mapped code unit maps to exactly one ASCII code unit via (code − 0xFEE0):
    //   U+FF08→'(' U+FF09→')' U+FF0B→'+' U+FF0D→'-' U+FF0E→'.' U+FF10–FF19→'0'–'9'.
    // Only digits are word chars (their `\b` effect is handled by the additive union in
    // findMatches); the separators/parens fold to non-word ASCII, so they never perturb `\b`.
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
}

function luhnCheck(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

const CREDIT_CARD_CONTEXT_BEFORE =
  /(?:credit\s*card|card(?:\s*number)?|cc|visa|mastercard|master\s*card|amex|american\s*express|discover|payment|billing|account)\s*(?:number|no\.?)?\s*[:#=-]?\s*$/i;

const CREDIT_CARD_IDENTIFIER_PREFIX = /[A-Za-z][A-Za-z0-9]{1,31}[-_:]$/;
const CREDIT_CARD_IDENTIFIER_SUFFIX = /^[-_:][A-Za-z][A-Za-z0-9]{1,31}/;

function isCreditCardIdentifierFalsePositive(content: string, match: RegExpExecArray): boolean {
  const before = content.slice(Math.max(0, match.index - 48), match.index);
  if (CREDIT_CARD_CONTEXT_BEFORE.test(before)) {
    return false;
  }

  const matched = match[0];
  const after = content.slice(match.index + matched.length, match.index + matched.length + 48);
  return CREDIT_CARD_IDENTIFIER_PREFIX.test(before) || CREDIT_CARD_IDENTIFIER_SUFFIX.test(after);
}

/**
 * Run every PII pattern against `scan` (which must be length-aligned with `original`),
 * applying the credit-card Luhn + false-positive gates per pass. Because `scan` and
 * `original` share a coordinate system, every match offset is valid in `original`, so the
 * reported value/start/end reference the ORIGINAL text.
 */
function detectMatches(scan: string, original: string): FridayMemoryGuardPiiMatch[] {
  const matches: FridayMemoryGuardPiiMatch[] = [];

  for (const pattern of PII_PATTERNS) {
    // Reset regex state since they have global flag
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(scan)) !== null) {
      // For credit card matches, validate with Luhn algorithm
      if (pattern.type === "credit_card") {
        const digits = match[0].replace(/[^0-9]/g, "");
        if (digits.length < 13 || digits.length > 19 || !luhnCheck(digits)) {
          continue;
        }
        if (isCreditCardIdentifierFalsePositive(scan, match)) {
          continue;
        }
      }

      matches.push({
        type: pattern.type,
        value: original.slice(match.index, match.index + match[0].length),
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  return matches;
}

/**
 * Additive two-pass detection. The ORIGINAL pass reproduces the pre-width-fold behavior
 * exactly (pure-ASCII PII with correct `\b` boundaries); the FOLDED pass adds full-width
 * PII. Both scans are length-preserving and index-aligned with `content`, so their match
 * spans live in one coordinate system. The union is a strict SUPERSET of the original pass:
 * every span the unfolded scan finds is retained, so no pre-existing match can be lost by
 * the fold — full-width detection only ever ADDS redactions.
 */
function findMatches(content: string): FridayMemoryGuardPiiMatch[] {
  const originalPass = detectMatches(content, content);
  const foldedPass = detectMatches(foldWidthForMatching(content), content);

  // Dedupe exact duplicates (a pure-ASCII region is found identically by both passes) so
  // downstream match counts / distinct types / tags are not inflated.
  const seen = new Set<string>();
  const matches: FridayMemoryGuardPiiMatch[] = [];
  for (const m of [...originalPass, ...foldedPass]) {
    const key = `${m.type}:${m.start}:${m.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push(m);
  }

  // Sort by start position for deterministic ordering
  matches.sort((a, b) => a.start - b.start || a.end - b.end);
  return matches;
}

function redactContent(content: string, matches: FridayMemoryGuardPiiMatch[]): string {
  if (matches.length === 0) return content;

  // Merge overlapping spans into non-overlapping segments before replacing. The two-pass
  // union can yield overlapping spans (e.g. a mixed ASCII/full-width number matched at
  // slightly different extents), and replacing overlapping ranges independently would
  // corrupt indices. Non-overlapping (merely adjacent) matches are kept separate so their
  // individual labels are preserved.
  const sorted = [...matches].sort((a, b) => a.start - b.start || a.end - b.end);
  const segments: Array<{ start: number; end: number; type: FridayMemoryGuardPiiType }> = [];
  for (const m of sorted) {
    const last = segments[segments.length - 1];
    if (last && m.start < last.end) {
      // Overlap: extend the segment; keep the earliest contributor's label (cosmetic only —
      // the whole span is redacted regardless of label).
      if (m.end > last.end) last.end = m.end;
    } else {
      segments.push({ start: m.start, end: m.end, type: m.type });
    }
  }

  // Process segments from end to start to preserve indices
  let result = content;
  for (const s of [...segments].reverse()) {
    const redacted = `[${s.type.toUpperCase()}]`;
    result = result.substring(0, s.start) + redacted + result.substring(s.end);
  }
  return result;
}

export function createFridayMemoryPiiGuard(
  mode?: FridayMemoryGuardPiiMode,
): FridayMemoryGuardPiiGuard {
  const effectiveMode: FridayMemoryGuardPiiMode = mode ?? FRIDAY_MEMORY_GUARD_PII_MODE;

  return {
    scanAndTransform(content: string): FridayMemoryGuardPiiScanResult {
      const matches = findMatches(content);
      const distinctTypes = [...new Set(matches.map((m) => m.type))];
      const tagsToAdd = distinctTypes.map(
        (type) => `${FRIDAY_MEMORY_GUARD_PII_TAG_PREFIX}.${type}`,
      );

      let transformedContent = content;
      if (effectiveMode === "redact" && matches.length > 0) {
        transformedContent = redactContent(content, matches);
      }

      return {
        matches,
        distinctTypes,
        transformedContent,
        tagsToAdd,
      };
    },

    redactDeep(value: unknown): { value: unknown; tagsToAdd: string[] } {
      const tagSet = new Set<string>();
      const MAX_DEPTH = 6;

      const walk = (v: unknown, depth: number): unknown => {
        if (depth > MAX_DEPTH) return v;
        if (typeof v === "string") {
          const matches = findMatches(v);
          if (matches.length === 0) return v;
          for (const m of matches) {
            tagSet.add(`${FRIDAY_MEMORY_GUARD_PII_TAG_PREFIX}.${m.type}`);
          }
          return effectiveMode === "redact" ? redactContent(v, matches) : v;
        }
        if (Array.isArray(v)) {
          return v.map((entry) => walk(entry, depth + 1));
        }
        if (v && typeof v === "object") {
          const out: Record<string, unknown> = {};
          for (const [k, entry] of Object.entries(v as Record<string, unknown>)) {
            out[k] = walk(entry, depth + 1);
          }
          return out;
        }
        return v;
      };

      return { value: walk(value, 0), tagsToAdd: [...tagSet] };
    },
  };
}
