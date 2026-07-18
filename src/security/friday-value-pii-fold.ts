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
 * FABRICATED JOINING-DIGIT NEUTRALIZATION (round-9; whole-class NO-DEGRADE, SYMMETRIC to the bridge rule
 * above — see {@link foldFabricatesJoiningDigit}). The bridge rule stops a fabricated matcher SEPARATOR;
 * its mirror image is a fabricated matcher DIGIT. NFKD also decomposes NON-`\p{Nd}`, non-No/Nl
 * compatibility symbols into strings that CONTRIBUTE an ASCII DIGIT: ~80 CJK compatibility symbols —
 * enclosed months ㋀–㋋ (U+32C0–32CB → "1月".."12月"), telegraph hours ㍘–㍰ (U+3358–3370 → "0点".."24点"),
 * date days ㏠–㏾ (U+33E0–33FE → "1日".."31日"), squared unit symbols ㎟/㎠/㎡/… (→ "mm2" / "cm2" / "m2") —
 * fold to strings whose LEADING ASCII DIGITS JOIN an adjacent benign digit run to complete a card / SSN /
 * phone shape (SSN & phone have no Luhn gate, so a single joined digit suffices). Accepting such a
 * fabricated digit corrupts benign CJK date / time / measurement content into a false `[CREDIT_CARD]` /
 * `[SSN_US]` / `[PHONE_US]`. The fold NEUTRALIZES the whole class by a GENERAL rule (not an enumerated
 * list): the fold may put an ASCII DIGIT in the detection copy ONLY when the SOURCE code point IS a
 * Unicode decimal digit (`\p{Nd}`); any non-`\p{Nd}` source whose fold would emit an ASCII digit is
 * PRESERVED unchanged, so its decomposition digits cannot JOIN / EXTEND an adjacent run. RETAINED: real
 * `\p{Nd}` folding is untouched — fullwidth U+FF10–FF19 and cross-script Arabic-Indic / Devanagari / …
 * real digits STILL fold, so a full-width / cross-script digit card / ssn / phone still redacts full-span.
 *
 * FOLLOW-UP (further consolidation): the cleanest end state is a fold-policy parameter on the
 * canonical `buildUnicodeDetectionCopy` so this adapter collapses into the normalizer itself. Kept as
 * a distinct leaf here so it neither degrades benign fidelity nor entangles the normalizer's default
 * aggressive fold; both value-PII consumers now share THIS one module.
 *
 * @module security
 */

// ─── Cross-script decimal-digit fold (real \p{Nd} blocks NFKD does not fold to ASCII) ───
//
// COMPLETENESS (SEC-AGENT-MEMORY-SEARCH-RAW-EGRESS-001 round-10 — Advisor P0 cross-script LEAK).
// A prior revision folded cross-script `\p{Nd}` digits via a HAND-MAINTAINED list of block bases.
// That list DRIFTED behind the supported runtime's Unicode version (16.0), OMITTING ten whole Nd blocks
// the runtime recognizes — the DIGIT-ZERO code points U+10D40, U+116D0, U+116DA (the second block of a
// merged run), U+11BF0, U+11F50, U+16130 (Garay), U+16AC0, U+16D70, U+1E4F0 (Nag Mundari) and U+1E5F1
// (Ol Onal). Digits in those blocks NFKD does NOT fold, so they stayed non-ASCII and EVADED the ASCII
// card/ssn/phone matchers — a Visa-shaped card written in Garay digits was emitted VERBATIM, a
// cross-script PII leak contradicting the uniform cross-script redaction.
//
// The fold is now RUNTIME-DERIVED so it is AUTOMATICALLY COMPLETE for the supported runtime's Unicode
// version and CANNOT drift: at first use (memoized once) we scan the runtime's own `\p{Nd}` set and map
// EVERY decimal digit to its ASCII value 0–9. Because a `\p{Nd}` block is exactly ten contiguous code
// points laid out DIGIT ZERO..DIGIT NINE by Numeric_Value, we scan the set for contiguous decimal RUNS
// and, within each run, assign value = (codePoint − runStart) mod 10. Deriving by run (not by "a base is
// an Nd whose predecessor is not Nd") is REQUIRED for correctness because a few runs concatenate two or
// more blocks with NO gap — e.g. the runtime exposes U+116D0–116E3 as ONE 20-code-point run (two Kirat-
// Rai-family 0–9 blocks) and U+1D7CE–1D7FF as one 50-code-point run (five mathematical 0–9 blocks); the
// predecessor-gap heuristic would mis-assign the second block digits values 10..19 and LEAK them. NFKD
// still runs FIRST in {@link foldCodePoint}, so ASCII / fullwidth / mathematical digits are already ASCII
// (fast path) before this map is consulted, and the map is only built when a genuine cross-script digit
// that NFKD does NOT fold actually appears.

const ND_SET_RE = /\p{Nd}/u;

/**
 * Lazily-built, memoized COMPLETE map from every runtime `\p{Nd}` code point to its ASCII digit 0–9.
 * Built once on first cross-script fold (the full scan is ~one pass over the Unicode space, memoized).
 */
let ndDigitMapCache: Map<number, string> | null = null;

function ndDigitMap(): Map<number, string> {
  if (ndDigitMapCache !== null) return ndDigitMapCache;
  const map = new Map<number, string>();
  let cp = 0;
  while (cp <= 0x10ffff) {
    if (ND_SET_RE.test(String.fromCodePoint(cp))) {
      // Start of a contiguous decimal RUN (one or more concatenated ten-digit blocks). The digit
      // value repeats 0..9 every ten code points, so (cp − runStart) mod 10 is the value for the whole
      // run regardless of how many blocks it concatenates.
      const runStart = cp;
      while (cp <= 0x10ffff && ND_SET_RE.test(String.fromCodePoint(cp))) {
        map.set(cp, String.fromCharCode(0x30 + ((cp - runStart) % 10)));
        cp += 1;
      }
    } else {
      cp += 1;
    }
  }
  ndDigitMapCache = map;
  return map;
}

/**
 * Fold ONE Unicode decimal digit (`\p{Nd}`) to its ASCII value 0–9. Only ever invoked on a `\p{Nd}`
 * match (see {@link DECIMAL_DIGIT_RE}), so the runtime-derived map is COMPLETE for every code point that
 * can reach here. ASCII digits short-circuit before the map (so pure-ASCII content never triggers the
 * one-time scan). The `?? digit` is defensive only — an Nd the runtime scan somehow missed is left
 * unchanged, which is safe (it simply will not match the ASCII PII classes).
 */
function foldDigit(digit: string): string {
  const cp = digit.codePointAt(0);
  if (cp === undefined) return digit;
  if (cp >= 0x30 && cp <= 0x39) return digit; // already ASCII (fast path — no map build)
  return ndDigitMap().get(cp) ?? digit;
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

// ─── Fabricated JOINING-DIGIT neutralization (NO-DEGRADE, whole class — symmetric to the bridge rule) ─
//
// The FALSE POSITIVE this neutralization prevents is a FABRICATED JOINING DIGIT: an ASCII digit the card
// / ssn / phone matchers consume as PART OF a digit group, so a BENIGN digit run ADJACENT to a
// decomposing compatibility symbol gets EXTENDED into `[CREDIT_CARD]` / `[SSN_US]` / `[PHONE_US]`. Full
// NFKD decomposes ~80 CJK compatibility symbols — enclosed months ㋀–㋋ (U+32C0–32CB → "1月".."12月"),
// telegraph hours ㍘–㍰ (U+3358–3370 → "0点".."24点"), date days ㏠–㏾ (U+33E0–33FE → "1日".."31日") and
// squared unit symbols ㎟/㎠/㎡/… (→ "mm2" / "cm2" / "m2" / …) — into strings whose LEADING ASCII DIGITS
// JOIN an adjacent benign run to complete a card / SSN / phone shape (SSN & phone have NO Luhn gate, so
// even a single joined digit suffices; a card needs Luhn but a crafted run reaches it). NONE of these
// sources IS a Unicode decimal digit, so the shared guard's `foldWidthForMatching` never turns them into
// a matcher digit — accepting the fabricated digit CORRUPTS benign CJK date / time / measurement content
// on read-back into a false marker.
//
// PRINCIPLE (symmetric to {@link foldFabricatesDigitGroupSeparator}): the fold may put an ASCII DIGIT
// (0x30–0x39) into the detection copy ONLY when the SOURCE code point IS a Unicode decimal digit
// (`\p{Nd}`). Any NON-`\p{Nd}` source whose NFKD / compat fold would EMIT an ASCII digit is PRESERVED
// unchanged, so in the copy it stays a single non-digit character that can neither JOIN nor EXTEND an
// adjacent group. A GENERAL rule over the whole class, not an enumerated list.
//   • RETAINED: real `\p{Nd}` digits STILL fold to ASCII — fullwidth U+FF10–FF19 (the F2b fullwidth
//     card/ssn/phone closure), mathematical digits, and cross-script Arabic-Indic / Devanagari / … real
//     digits all remain full-span-redactable (their SOURCE is `\p{Nd}`, so this rule exempts them).
//   • No/Nl "digit-like" forms (circled ① / superscript ¹ / parenthesized ⑴ / Roman Ⅴ) are ALREADY
//     preserved earlier in `foldCodePointForPii` and never reach here, so they never emit a joining digit.
const DECIMAL_DIGIT_SOURCE_RE = /\p{Nd}/u;

/**
 * True when folding `codePoint` would CONTRIBUTE an ASCII DIGIT (0x30–0x39) that the source code point
 * is NOT legitimately entitled to produce (its General_Category is not `\p{Nd}`) — a FABRICATED joining
 * digit that lets the card / ssn / phone matcher JOIN / EXTEND a BENIGN adjacent digit run into a false
 * `[CREDIT_CARD]` / `[SSN_US]` / `[PHONE_US]`. Exempt: a source that IS a Unicode decimal digit
 * (`\p{Nd}`) — ASCII, fullwidth U+FF10–FF19, mathematical, or cross-script Arabic-Indic / Devanagari / …
 * — whose fold to an ASCII digit is LEGITIMATE real-digit PII coverage and MUST be kept. Symmetric to
 * {@link foldFabricatesDigitGroupSeparator}: a matcher-significant char (there a digit-group-bridge
 * separator, here a digit) may only enter the detection copy from a source that legitimately produces it.
 * A GENERAL rule over the whole class (~80 CJK compatibility symbols today), not an enumerated list.
 */
function foldFabricatesJoiningDigit(codePoint: string, folded: string): boolean {
  if (DECIMAL_DIGIT_SOURCE_RE.test(codePoint)) return false; // source IS \p{Nd} — legit real-digit fold
  for (const ch of folded) {
    const u = ch.codePointAt(0);
    if (u !== undefined && u >= 0x30 && u <= 0x39) return true; // fabricated ASCII digit
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
  // NO-DEGRADE (fabricated JOINING-DIGIT neutralization — SEC-AGENT-MEMORY-SEARCH-RAW-EGRESS-001 round-9,
  // symmetric to the digit-group-bridge rule above). Full NFKD decomposes a source that is NOT itself a
  // decimal digit (~80 CJK compatibility symbols: months ㋀–㋋, hours ㍘–㍰, days ㏠–㏾, unit symbols
  // ㎟/㎡/…) into a string whose LEADING ASCII DIGITS would JOIN an adjacent benign run and complete a
  // card / SSN / phone shape (SSN & phone have no Luhn gate, so a single joined digit suffices). The
  // shared guard never folds these to a matcher digit, so accepting one corrupts benign CJK date / time
  // / measurement content into a false [CREDIT_CARD]/[SSN_US]/[PHONE_US]. PRESERVE the source instead: a
  // fold may emit an ASCII digit ONLY from a genuine `\p{Nd}` source (ASCII / fullwidth FF10-19 / cross-
  // script real digits still fold, so a full-width or Arabic-Indic digit card/ssn/phone still redacts
  // full-span). See {@link foldFabricatesJoiningDigit}.
  if (foldFabricatesJoiningDigit(codePoint, folded)) return codePoint;
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
