/**
 * SEC-REALTIME-EVENT-PII-BY-VALUE — the CANONICAL value-PII detection FOLD.
 *
 * SHARED across every free-form VALUE egress that needs Unicode-obfuscated PII coverage WITHOUT the
 * canonical aggressive fold's benign over-redaction: the realtime / agent event-payload redactor
 * (`src/api/realtime/friday-event-payload-redactor.ts`) AND the memory read-back output filter
 * (`src/memory/guard/services/friday-memory-output-filter.ts`, which covers BOTH the agent
 * `memory_search` trust boundary and the HTTP memory get/list/search/replay routes). Relocated from
 * `src/api/realtime/` to this dependency-free `src/security/` leaf (alongside the sibling
 * `friday-unicode-pii-normalizer.ts` / `friday-secret-shape-redactor.ts` primitives it composes with)
 * so both consumers import ONE canonical fold — resolving the module-header FOLLOW-UP below — with no
 * cross-layer (memory → api) dependency.
 *
 * This module is NOT a detector. It carries NO secret-shape patterns (secret redaction is now
 * delegated wholesale to the CANONICAL `findSecretShapeSpans` / `redactSecretShapesInString` in
 * `src/security/friday-secret-shape-redactor.ts`, consumed via the canonical
 * `redactUnicodeObfuscated`) and NO PII detector (PII classification is delegated to the shared
 * production guard `createFridayMemoryPiiGuard`, passed in as the `detectMatches` callback). It is a
 * single, narrow FOLD-POLICY adapter that the canonical Unicode detection primitive
 * (`buildUnicodeDetectionCopy` in `src/security/friday-unicode-pii-normalizer.ts`) does NOT provide:
 * a compatibility fold that de-obfuscates value-PII (zero-width / combining / fullwidth / math-
 * alphanumeric / precomposed-accent) WITHOUT the benign over-redaction the canonical aggressive fold
 * would reintroduce.
 *
 * WHY A DEDICATED FOLD (and not the canonical `redactUnicodeObfuscated` + guard matcher). The
 * canonical `buildUnicodeDetectionCopy` applies FULL NFKD to every code point, which folds
 * compatibility WHITESPACE (U+3000 / U+00A0 / U+2007 / U+202F → ASCII space) and No/Nl "digit-like"
 * forms (circled ①, superscript ¹, parenthesized ⑴ → ASCII digits). Running the shared card/SSN
 * detector over that copy fabricates FALSE matches the guard would never make: an ideographic space
 * lets the card regex's `[ -]` class BRIDGE two benign fullwidth digit groups into a Luhn-valid
 * card, and a decorative circled-digit run folds into a card. The audit-log content sink
 * (`friday-hub-audit-log-writer.ts`) runs the guard over the aggressive copy and ACCEPTS that
 * over-redaction for its owner-scoped 0600 sink; the memory VALUE leg
 * (`friday-memory-pii-guard.ts::redactSecretAndPiiValueString`) AVOIDS it by not running PII over
 * the copy at all (so it does NOT cover Unicode-obfuscated PII-by-value — a documented gap). The
 * realtime seam needs BOTH: obfuscated-PII coverage AND no benign over-redaction (SEC-REALTIME-EVENT-
 * PII-BY-VALUE round-8 F2b + round-9 F2b-ND-1). Neither canonical sink's fold satisfies both, so this
 * adapter keeps the aligned fold below.
 *
 * THE ALIGNED FOLD (matches the shared guard's DELIBERATE `foldWidthForMatching` trade-off):
 *   1. NFKD compatibility DECOMPOSITION per code point — folds math-alphanumeric / fullwidth /
 *      ligature forms to base LETTERS and decomposes precomposed accents (é → e + ◌́). NFKD, not
 *      NFKC (NFKC re-composes accents, a canonical-equivalence bypass).
 *   2. strip combining marks (\p{M}) — an accent used to split a token disappears; precomposed and
 *      decomposed forms collapse to the SAME detection copy.
 *   3. strip Cf / Default_Ignorable (zero-width U+200B/C/D, U+2060, U+FEFF, soft hyphen, bidi
 *      controls, variation selectors, …).
 *   4. fold decimal digits (\p{Nd}) to ASCII BY VALUE (cross-script real digits NFKD does not fold —
 *      Arabic-Indic, Devanagari, …).
 * EXCEPT it PRESERVES from the compatibility fold exactly the source code points whose NFKD would
 * fabricate a matcher-significant ASCII char the guard never produces: compatibility WHITESPACE
 * (U+3000 / U+00A0 / U+2007 / U+202F) and No/Nl "digit-like" forms (circled / superscript /
 * parenthesized). ASCII whitespace is NOT preserved (it folds to itself and IS the guard's real
 * `[ -]` / `\s` separator). Fullwidth DIGITS (U+FF10–FF19) are NOT preserved (the guard folds those
 * too — the F2b fullwidth card/SSN/phone closure). The result is a strict Unicode-resistant SUPERSET
 * of the guard: identical PII behavior on ASCII + fullwidth-DIGIT + compat-whitespace + No-digit
 * content, extended ONLY by the letter / zero-width / combining / precomposed obfuscation the guard
 * misses — never a divergence that over-redacts benign data.
 *
 * FABRICATED DIGIT-GROUP-BRIDGE NEUTRALIZATION (round-7, refined round-8; whole-class NO-DEGRADE — see
 * {@link foldFabricatesDigitGroupSeparator}). Preserving whitespace + No/Nl covers the code points that
 * fold TO whitespace/digits, but NFKD also decomposes NON-whitespace, non-No/Nl compatibility code
 * points into a leading/standalone matcher-significant ASCII SEPARATOR the guard never produces: a
 * spacing accent (U+00A8 ¨ → `<space>+◌̈`, stripped to a bare `<space>`; U+00B4 ´, U+00AF ¯, U+00B8 ¸,
 * U+02D8–U+02DD, …), a dot-leader (U+2024 → `.`), a small hyphen-minus (U+FE63 → `-`), a full-width
 * macron (U+FFE3 → space), etc. Accepting such a fabricated separator lets the card/ssn/phone matcher
 * BRIDGE two benign digit groups into a false `[CREDIT_CARD]` / `[SSN_US]` / `[PHONE_US]`. The fold
 * NEUTRALIZES the whole class by a GENERAL rule (not an enumerated list): any source code point that is
 * NOT itself a DIGIT-GROUP-BRIDGE separator (nor a genuine Unicode whitespace, nor the guard's
 * deliberate full-width `foldWidthForMatching` set `（ ） ＋ － ．`) whose fold would contribute a
 * digit-group-bridge ASCII separator is PRESERVED unchanged, so in the detection copy it stays a single
 * non-separator, non-digit char that neither bridges nor joins adjacent groups. Round-8 SCOPES this to
 * DIGIT-GROUP bridges ONLY: the EMAIL matcher's anchors `@` / `_` / `%` are NOT digit-group bridges
 * (the card/ssn/phone regexes never use them), so a compat fold that yields one — full-width `＠`
 * U+FF20 → `@`, `＿` U+FF3F → `_`, `％` U+FF05 → `%` — is NOT neutralized and KEEPS folding, so a
 * full-width / obfuscated EMAIL still de-obfuscates and redacts to `[EMAIL]` full-span (leak coverage).
 *
 * FOLLOW-UP (further consolidation): the cleanest end state is a fold-policy parameter on the
 * canonical `buildUnicodeDetectionCopy` so this adapter collapses into the normalizer itself. Kept as
 * a distinct leaf here so it neither degrades benign fidelity nor entangles the normalizer's default
 * aggressive fold; both value-PII consumers now share THIS one module.
 *
 * @module security
 */

// ─── Cross-script decimal-digit fold (real \p{Nd} blocks NFKD does not fold to ASCII) ───

/**
 * Base code point ("DIGIT ZERO") of each Unicode decimal-digit block whose digits NFKD does NOT
 * already fold to ASCII. Value = codePoint − base (the ten digits of every Nd block are contiguous).
 * ASCII / fullwidth / mathematical digits are omitted — NFKD folds those to ASCII before this pass
 * runs; leaving an unknown Nd untouched is safe (it simply will not match the ASCII PII classes).
 */
const ND_BLOCK_BASES: readonly number[] = [
  0x0660, // Arabic-Indic
  0x06f0, // Extended Arabic-Indic
  0x07c0, // NKo
  0x0966, // Devanagari
  0x09e6, // Bengali
  0x0a66, // Gurmukhi
  0x0ae6, // Gujarati
  0x0b66, // Oriya
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
  0x0de6, // Sinhala Lith
  0x0e50, // Thai
  0x0ed0, // Lao
  0x0f20, // Tibetan
  0x1040, // Myanmar
  0x1090, // Myanmar Shan
  0x17e0, // Khmer
  0x1810, // Mongolian
  0x1946, // Limbu
  0x19d0, // New Tai Lue
  0x1a80, // Tai Tham Hora
  0x1a90, // Tai Tham Tham
  0x1b50, // Balinese
  0x1bb0, // Sundanese
  0x1c40, // Lepcha
  0x1c50, // Ol Chiki
  0xa620, // Vai
  0xa8d0, // Saurashtra
  0xa900, // Kayah Li
  0xa9d0, // Javanese
  0xa9f0, // Myanmar Tai Laing
  0xaa50, // Cham
  0xabf0, // Meetei Mayek
  0x104a0, // Osmanya
  0x10d30, // Hanifi Rohingya
  0x11066, // Brahmi
  0x110f0, // Sora Sompeng
  0x11136, // Chakma
  0x111d0, // Sharada
  0x112f0, // Khudawadi
  0x11450, // Newa
  0x114d0, // Tirhuta
  0x11650, // Modi
  0x116c0, // Takri
  0x11730, // Ahom
  0x118e0, // Warang Citi
  0x11950, // Dives Akuru
  0x11c50, // Bhaiksuki
  0x11d50, // Masaram Gondi
  0x11da0, // Gunjala Gondi
  0x16a60, // Mro
  0x16b50, // Pahawh Hmong
  0x1e140, // Nyiakeng Puachue Hmong
  0x1e2f0, // Wancho
  0x1e950, // Adlam
];

function foldDigit(digit: string): string {
  const cp = digit.codePointAt(0);
  if (cp === undefined) return digit;
  if (cp >= 0x30 && cp <= 0x39) return digit; // already ASCII
  for (const base of ND_BLOCK_BASES) {
    if (cp >= base && cp <= base + 9) {
      return String.fromCharCode(0x30 + (cp - base));
    }
  }
  return digit; // unknown Nd block — safe to leave (never matches ASCII PII classes)
}

// ─── Per-code-point compatibility folds ───

const COMBINING_MARK_RE = /\p{M}/gu;
const IGNORABLE_RE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const DECIMAL_DIGIT_RE = /\p{Nd}/gu;

/**
 * The MAXIMALLY-aggressive per-code-point fold (NFKD → strip \p{M} → strip Cf / Default_Ignorable →
 * fold \p{Nd} digits). Applying NFKD + mark/format strip PER code point is equivalent to whole-string
 * NFKD for our purpose (we strip ALL combining marks, so canonical reordering — the only
 * cross-character effect — is irrelevant), and lets us map every output code unit back to exactly one
 * source code point. May return "" (dropped mark / zero-width) or several chars (a decomposition).
 * `foldCodePointForPii` delegates every non-preserved code point here.
 */
function foldCodePoint(codePoint: string): string {
  return codePoint
    .normalize("NFKD")
    .replace(COMBINING_MARK_RE, "")
    .replace(IGNORABLE_RE, "")
    .replace(DECIMAL_DIGIT_RE, foldDigit);
}

// Source code points the VALUE-PII copy PRESERVES from the NFKD compatibility fold (see module
// header): No/Nl "digit-like" numeric forms (circled ①, superscript ¹, parenthesized ⑴, Roman Ⅴ)
// and non-ASCII WHITESPACE (U+00A0 / U+2007 / U+202F / U+3000 / …). Folding either would fabricate a
// matcher-significant ASCII char the shared guard's `foldWidthForMatching` deliberately never
// produces, over-redacting benign content the guard preserves byte-identical.
const PII_PRESERVED_NUMERIC_RE = /[\p{No}\p{Nl}]/u;
const PII_PRESERVED_WHITESPACE_RE = /\p{White_Space}/u;

// ─── Fabricated DIGIT-GROUP-BRIDGE neutralization (NO-DEGRADE, whole class) ───
//
// The FALSE POSITIVE this neutralization prevents is a FABRICATED DIGIT-GROUP BRIDGE: an ASCII
// separator the card / ssn / phone matchers consume BETWEEN two digit groups, so a BENIGN digit run
// split by a decomposing compat char gets corrupted into `[CREDIT_CARD]` / `[SSN_US]` / `[PHONE_US]`.
// Exactly those digit-group-bridge separators are (round-8: this set is the neutralization TRIGGER —
// no email-only anchor belongs in it; see below):
//   • card  `\b(?:\d[ -]*?){13,19}\b`             → SPACE, '-'
//   • ssn   `\d{3}[- ]?\d{2}[- ]?\d{4}`           → '-', SPACE
//   • phone `(?:\+1[-.\s]?)?(?:\(?…\)?…)`         → '+', '(' ')', '-', '.', and all of ASCII `\s`
const DIGIT_GROUP_BRIDGE_SEPARATORS: ReadonlySet<number> = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, // \t \n \v \f \r  (phone `\s`)
  0x20, //   SPACE                (card `[ -]`, ssn `[- ]`, phone `\s`)
  0x2d, // - HYPHEN-MINUS         (card, ssn, phone)
  0x2e, // . FULL STOP            (phone)
  0x2b, // + PLUS                 (phone `\+`)
  0x28, 0x29, // ( )  PARENS      (phone)
]);

// EMAIL-ONLY ANCHORS/COMPONENTS `@` (0x40) `_` (0x5F) `%` (0x25) are DELIBERATELY ABSENT from the
// bridge set above (round-8 email leak-coverage fix). The email matcher `[A-Z0-9._%+-]+@[A-Z0-9.-]+\.
// [A-Z]{2,}` also consumes them, but they are used by NO other matcher — the card/ssn/phone regexes
// never contain `@` / `_` / `%` — so a FABRICATED one can never bridge two benign digit groups into a
// false card/ssn/phone. Because they are not in the bridge set, folding a full-width / compat form TO
// one of them (`＠` U+FF20 → '@', `＿` U+FF3F → '_', `％` U+FF05 → '%', …) is NOT neutralized and KEEPS
// folding — REQUIRED to de-obfuscate and redact a full-width / obfuscated EMAIL to `[EMAIL]` full-span.
// ('.', '-', '+' ARE bridge separators AND email components: their guard-aligned full-width forms
// FF0E/FF0D/FF0B keep folding via GUARD_ALIGNED_WIDTH_SEPARATOR_FOLDS below — so a full-width email
// keeps its dot / hyphen / plus — while a NON-guard fabricator of those, e.g. dot-leader U+2024 → '.'
// or small hyphen-minus U+FE63 → '-', is still neutralized as a benign digit-group bridge.)

// The ONLY compatibility code points whose fold to a BRIDGE separator is DELIBERATE and matches the
// shared guard's `foldWidthForMatching` (full-width `（ ） ＋ － ．` → `( ) + - .`). Every OTHER source
// code point that NFKD decomposes into a bridge separator does so via a compatibility fold the guard
// NEVER applies, so it must not be allowed to fabricate one. (Full-width DIGITS U+FF10–FF19 also fold,
// but to ASCII DIGITS — never a separator — so they are irrelevant here and correctly keep folding.)
const GUARD_ALIGNED_WIDTH_SEPARATOR_FOLDS: ReadonlySet<number> = new Set<number>([
  0xff08, 0xff09, 0xff0b, 0xff0d, 0xff0e, // （ ） ＋ － ．
]);

/**
 * True when folding `codePoint` would CONTRIBUTE a DIGIT-GROUP-BRIDGE separator that the source code
 * point is NOT itself — a FABRICATED bridge that lets the card / ssn / phone matcher join two BENIGN
 * digit groups into a false `[CREDIT_CARD]` / `[SSN_US]` / `[PHONE_US]`. Exempt: a source that IS such
 * a separator (its fold is that separator, legitimately) or a guard-aligned full-width separator
 * (folds to the SAME ASCII the shared guard's `foldWidthForMatching` produces). The EMAIL-ONLY anchors
 * `@` / `_` / `%` are NOT bridge separators, so a fold that yields one (`＠` U+FF20 → `@`, `＿` U+FF3F →
 * `_`, `％` U+FF05 → `%`) is NOT caught here and KEEPS folding — REQUIRED to de-obfuscate a full-width /
 * obfuscated EMAIL, and unable to fabricate a benign card/ssn/phone match (those matchers never use
 * `@` / `_` / `%`). A GENERAL rule over the whole class, not an enumerated list.
 */
function foldFabricatesDigitGroupSeparator(codePoint: string, folded: string): boolean {
  const cp = codePoint.codePointAt(0);
  if (cp === undefined) return false;
  if (DIGIT_GROUP_BRIDGE_SEPARATORS.has(cp)) return false; // source IS the bridge separator — legit
  if (GUARD_ALIGNED_WIDTH_SEPARATOR_FOLDS.has(cp)) return false; // guard-aligned width fold — legit
  for (const ch of folded) {
    const u = ch.codePointAt(0);
    if (u !== undefined && DIGIT_GROUP_BRIDGE_SEPARATORS.has(u)) return true; // fabricated bridge
  }
  return false;
}

/**
 * Fold a SINGLE original code point to its VALUE-PII detection form. Identical to
 * {@link foldCodePoint} EXCEPT it PRESERVES compatibility whitespace and No/Nl digit-like forms so
 * the copy matches the shared guard's deliberate `foldWidthForMatching` trade-off and never
 * over-redacts benign content. Every fold the guard lacks that the leak-closure needs — zero-width /
 * combining / precomposed-accent strip + fullwidth / math LETTER folds + cross-script \p{Nd}
 * real-digit folds — is retained by delegating all other code points to {@link foldCodePoint}.
 */
function foldCodePointForPii(codePoint: string): string {
  if (PII_PRESERVED_NUMERIC_RE.test(codePoint)) return codePoint;
  // Preserve NON-ASCII whitespace so it is NOT folded to an ASCII space the card regex's [ -] class
  // could bridge. ASCII whitespace is left to foldCodePoint (it folds to itself and IS a real
  // [ -] / \s separator, so genuine ASCII-separated PII stays detectable — parity with the guard).
  const cp = codePoint.codePointAt(0);
  if (cp !== undefined && cp > 0x7f && PII_PRESERVED_WHITESPACE_RE.test(codePoint)) {
    return codePoint;
  }
  const folded = foldCodePoint(codePoint);
  // NO-DEGRADE (fabricated digit-group-bridge neutralization — SEC-AGENT-MEMORY-SEARCH-RAW-EGRESS-001
  // round-7, refined round-8). Full NFKD can decompose a source code point that is NOT itself a matcher
  // separator into one that CONTRIBUTES an ASCII digit-group-bridge separator (spacing accent U+00A8 ¨
  // → `<space>+◌̈` → `<space>`; dot-leader U+2024 → `.`; small hyphen-minus U+FE63 → `-`). The shared
  // guard's `foldWidthForMatching` never produces such a bridge, so accepting it lets the card/ssn/
  // phone matcher BRIDGE two BENIGN digit groups into a false [CREDIT_CARD]/[SSN_US]/[PHONE_US] —
  // corrupting benign content. PRESERVE the ORIGINAL source code point instead: in the detection copy
  // it stays a single non-separator, non-digit character that neither BRIDGES nor JOINS adjacent
  // groups — guard-aligned (the guard doesn't fold it either). This is scoped to DIGIT-GROUP bridges
  // ONLY: the EMAIL-only anchors `@` / `_` / `%` are NOT bridges (round-8), so a fold that yields one
  // (`＠` U+FF20 → `@`) KEEPS folding and a full-width / obfuscated EMAIL still de-obfuscates to [EMAIL].
  if (foldFabricatesDigitGroupSeparator(codePoint, folded)) return codePoint;
  return folded;
}

// ─── Normalized detection copy with origin mapping ───

interface NormalizedView {
  /** Obfuscation-folded detection copy of the original string. */
  readonly normalized: string;
  /** originStart[i] = ORIGINAL code-unit index where normalized code unit i's source code point begins. */
  readonly originStart: readonly number[];
  /** originEnd[i] = ORIGINAL code-unit index just past that source code point. */
  readonly originEnd: readonly number[];
}

function buildNormalizedView(
  original: string,
  foldOne: (codePoint: string) => string,
): NormalizedView {
  let normalized = "";
  const originStart: number[] = [];
  const originEnd: number[] = [];
  let idx = 0;
  for (const codePoint of original) {
    const start = idx;
    const end = idx + codePoint.length; // 1 or 2 UTF-16 code units
    idx = end;
    const folded = foldOne(codePoint);
    if (folded.length === 0) continue; // dropped (combining mark / zero-width / format)
    normalized += folded;
    for (let u = 0; u < folded.length; u += 1) {
      originStart.push(start);
      originEnd.push(end);
    }
  }
  return { normalized, originStart, originEnd };
}

// ─── Value-PII (email / phone / SSN / card) over the aligned detection copy ───

/**
 * A value-PII match reported over the NORMALIZED detection copy: `[start, end)` are NORMALIZED
 * code-unit offsets and `type` is the shared guard's PII type label (`email` | `phone_us` |
 * `ssn_us` | `credit_card`). Shape-compatible (structurally) with the shared guard's
 * `FridayMemoryGuardPiiMatch` so a caller can pass its matches through unchanged.
 */
export interface UnicodeResistantPiiMatch {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Redact value-PII (email / US phone / US SSN / Luhn-gated card) from `original`, resistant to
 * zero-width / combining / fullwidth / mathematical / precomposed-vs-decomposed obfuscation. The
 * caller supplies `detectMatches` — the shared production PII detector (e.g.
 * `guard.scanAndTransform(s).matches`) — run over the NON-DESTRUCTIVE value-PII detection copy, so
 * the guard's email / phone / SSN / Luhn+false-positive-gated card logic stays the SINGLE source of
 * truth (no divergent second detector). The copy is ALIGNED with the guard's DELIBERATE
 * `foldWidthForMatching` (see {@link foldCodePointForPii}): it preserves compatibility whitespace and
 * No/Nl "digit-like" forms, so it never fabricates a bridged / circled card the guard would not.
 * Each match is mapped back to the ORIGINAL span that produced it and the FULL span is replaced with
 * the guard's canonical `[<TYPE>]` marker (e.g. `[EMAIL]`), so an obfuscation char inside a match is
 * redacted with it (no fragment residual). Overlapping original spans are merged (earliest label
 * kept — cosmetic; the whole span is redacted regardless), mirroring the shared guard's
 * `redactContent`. Returns the input BYTE-IDENTICAL when nothing matches — and, because the copy
 * folds NO digit / whitespace / separator the guard does not, its output equals the shared guard's
 * own `redactContent` / `redactDeep` output for ALL content the guard handles, extended ONLY by the
 * letter / zero-width / combining / precomposed obfuscation the guard misses — a strict
 * Unicode-resistant SUPERSET, never a divergence.
 */
export function redactUnicodeResistantPii(
  original: string,
  detectMatches: (normalized: string) => readonly UnicodeResistantPiiMatch[],
): string {
  if (original.length === 0) return original;
  const view = buildNormalizedView(original, foldCodePointForPii);
  if (view.normalized.length === 0) return original;

  const matches = detectMatches(view.normalized);
  if (matches.length === 0) return original;

  // Map each NORMALIZED match to the ORIGINAL span that produced it, preserving its label.
  const spans: Array<{ start: number; end: number; type: string }> = [];
  for (const m of matches) {
    if (m.end <= m.start) continue;
    const oStart = view.originStart[m.start];
    const oEnd = view.originEnd[m.end - 1];
    if (oStart === undefined || oEnd === undefined || oEnd <= oStart) continue;
    spans.push({ start: oStart, end: oEnd, type: m.type });
  }
  if (spans.length === 0) return original;

  // Merge overlapping ORIGINAL spans (keep the earliest contributor's label — cosmetic, the whole
  // span is redacted regardless), then splice END→START so earlier indices stay valid. Touching
  // (adjacent) spans stay separate so distinct types keep distinct markers, matching the shared
  // guard's redactContent.
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number; type: string }> = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) {
      if (s.end > last.end) last.end = s.end;
    } else {
      merged.push({ start: s.start, end: s.end, type: s.type });
    }
  }

  let result = original;
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const seg = merged[i];
    result = result.slice(0, seg.start) + `[${seg.type.toUpperCase()}]` + result.slice(seg.end);
  }
  return result;
}
