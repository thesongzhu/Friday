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

// PRIV-UNICODE-REDACTION-001: the SAME shared Unicode DETECTION primitive the audit writer's
// field-name classifiers use (NFKD → strip `\p{M}` → strip Cf / Default_Ignorable → fold `\p{Nd}`).
//   - round-10: `buildUnicodeDetectionCopy` Unicode-canonicalizes the KEY as an ADDITIVE second pass
//     in the guard's key-NAME classifier so a PII-context key hidden behind zero-width / combining /
//     full-width / precomposed obfuscation is classified identically to its de-obfuscated ASCII form
//     (the strict-superset union in `sensitiveTypeForKey`).
//   - round-11: `redactUnicodeObfuscated` + the shared span-mapper make the key-CONTENT PII REDACTOR
//     (`redactKey`) Unicode-aware — the OTHER key leg, where the KEY STRING ITSELF is PII
//     (`victim@examp<U+200B>le.com`, Arabic-Indic `١٢٣-٤٥-٦٧٨٩`, a combining-spliced card USED AS AN
//     OBJECT KEY). It runs the SAME PII detectors over the detection copy, maps each matched span
//     back to the ORIGINAL key span, and redacts only that span — the SAME primitive the audit writer
//     uses for VALUE content, so no divergent sink-local copy exists.
// No import cycle: `friday-unicode-pii-normalizer.ts` is a dependency-free LEAF module (imports
// nothing), so the guard importing it introduces no cycle.
import {
  buildUnicodeDetectionCopy,
  redactUnicodeObfuscated,
  type UnicodeNormalizedSpan,
} from "../../../security/friday-unicode-pii-normalizer.js";

// SEC-EVENT-REDACTION-001 (round-12): the SAME value-side secret-shape detectors the audit writer
// layers over VALUES — reused, NOT re-copied — so a SECRET-shape string used AS AN OBJECT KEY
// (`sk-proj-…`, a JWT, `api_key=…`, `Authorization: Bearer …`) is sanitized by the ONE shared
// key-content choke point (`redactKey`) rather than persisting verbatim. `findSecretShapeSpans`
// reports each secret match as a `[start,end)` span + its exact replacement, so it composes with the
// PII span machinery over BOTH the raw key and the Unicode detection copy. `redactSecretShapesInString`
// is the in-place equivalent used for the raw residual leg. No import cycle: the secret-shape redactor
// depends only on the dependency-free Unicode-normalizer LEAF, never on the guard.
import {
  findSecretShapeSpans,
  FRIDAY_DEFAULT_SECRET_MARKER,
  redactSecretShapesInString,
} from "../../../security/friday-secret-shape-redactor.js";

/**
 * Marker spliced for a secret-shape match in a KEY or a string VALUE — byte-identical to the audit
 * writer's `AUDIT_SECRET_MARKER`, so the key leg, the value leg (`redactStringLeaf`/`scanAndTransform`),
 * and the audit content/identifier legs all splice the SAME `[REDACTED_SECRET]` token. ONE canonical
 * marker, no sink-local divergence.
 */
const SECRET_MARKER = FRIDAY_DEFAULT_SECRET_MARKER;

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

/**
 * Report every PII match in `normalized` as a `[start, end)` span plus the SAME placeholder
 * `redactContent` would splice for it (`[EMAIL]` / `[SSN_US]` / `[CREDIT_CARD]` / `[PHONE_US]`), so
 * span-based Unicode redaction is byte-consistent with the in-place ASCII redactor. This is the KEY-leg
 * Unicode-PII SPAN entry point `redactKey` hands to `redactUnicodeObfuscated`: the matcher runs over the
 * de-obfuscated DETECTION COPY, and each span is mapped back to the ORIGINAL key and redacted there.
 * Reusing `findMatches` keeps the credit-card Luhn + false-positive gates identical to how the guard
 * classifies the same shape as a raw VALUE — no divergent copy of the detectors.
 *
 * NOTE: the string-VALUE leg (`redactSecretAndPiiValueString`) deliberately does NOT run this over the
 * NFKD detection copy — it keeps PII on `findMatches` (which does not fold U+3000 / U+FF0C) to avoid the
 * ideographic-space card-bridge over-redaction. See `redactSecretAndPiiValueString`'s header.
 */
function findPiiSpans(normalized: string): UnicodeNormalizedSpan[] {
  return findMatches(normalized).map((m) => ({
    start: m.start,
    end: m.end,
    replacement: `[${m.type.toUpperCase()}]`,
  }));
}

/**
 * SEC-EVENT-REDACTION-001 (round-12; round-13 subspan; round-14 value leg): secret-SHAPE spans in a
 * KEY or string-VALUE scan, via the SAME canonical detector (`findSecretShapeSpans`) the audit writer
 * uses for VALUES — NOT a divergent sink-local copy. Each match is reported as its sensitive CREDENTIAL
 * `[start, end)` subspan + the marker: for a whole-value shape (`sk-…`, a JWT, …) that is the whole
 * match; for a PREFIX-BEARING shape (`Authorization: Bearer …`, `api_key=…`) it is ONLY the credential
 * AFTER the preserved scheme / label + separator (round-13). So when `redactUnicodeObfuscated` maps the
 * span back from the de-obfuscated detection copy into the ORIGINAL key/value, ONLY the credential
 * becomes the marker and the ORIGINAL (possibly fullwidth / combining / zero-width) prefix + separator
 * bytes survive BYTE-FOR-BYTE — no ASCII reconstruction of the benign prefix. This is the SHARED SECRET
 * SPAN entry point reused by BOTH the key leg (`redactKey`, where it composes with `findPiiSpans` as
 * `[findSecretSpans, findPiiSpans]` — secret ∪ PII) AND the value leg
 * (`redactSecretAndPiiValueString`, where it runs ALONE as `[findSecretSpans]` — the value leg keeps
 * PII on `findMatches`; see that function's header). No divergent sink-local copy. Secret is listed
 * FIRST in the key leg so an overlap keeps the secret marker — the writer's content-leaf `secret ≻ PII`.
 */
function findSecretSpans(scan: string): UnicodeNormalizedSpan[] {
  return findSecretShapeSpans(scan, SECRET_MARKER).map((s) => ({
    start: s.start,
    end: s.end,
    replacement: s.replacement,
  }));
}

/**
 * SEC-EVENT-REDACTION-001 (round-14): the CANONICAL secret-shape redaction for a string VALUE,
 * composed WITH the UNCHANGED PII value leg (redact mode). Before round-14 the value leg
 * (`redactStringLeaf` / `scanAndTransform`) ran ONLY the PII detectors, so a SECRET-shape string VALUE
 * (`sk-proj-…` / a JWT / a PEM block / `Authorization: Bearer …` / `api_key=…` / `github_pat_…`, raw
 * OR Unicode-obfuscated) escaped every `redactDeep` consumer — memory egress, the learned-fact output
 * filter, and the public UIX / asset-inventory routes returned it verbatim. This adds the SAME
 * canonical secret detector (`findSecretShapeSpans` / `redactSecretShapesInString`) the audit writer
 * and `redactKey` already use — reused, NO sink-local copy — over BOTH the raw string AND its Unicode
 * de-obfuscation copy, secret FIRST so an overlapping credential keeps the secret marker
 * (`token=123-45-6789` → `token=[REDACTED_SECRET]`, mirroring the writer's content-leaf `secret ≻ PII`).
 * There is deliberately NO pure-`\p{Nd}` exemption (that is a KEY-only preservation for ambiguous
 * business ids; a full-width / Arabic-Indic card VALUE must still redact, exactly as the legacy value
 * leg redacted a full-width card).
 *
 * WHY PII STAYS ON `findMatches` (NOT the NFKD detection copy). The Unicode pass runs ONLY the SECRET
 * finder, never the PII finder. Secret shapes are contiguous / structured, so folding on the NFKD copy
 * only ever REVEALS a real obfuscated credential. The PII CARD detector is different: running it over
 * the NFKD copy would fold an ideographic space U+3000 / full-width comma U+FF0C into an ASCII
 * space/comma the card regex's `[ -]` class bridges, turning two benign full-width digit groups into a
 * false 16-digit card — the exact over-redaction `foldWidthForMatching` deliberately AVOIDS by NOT
 * folding U+3000 / U+FF0C (the "ideographic-space non-bridge" contract). So PII keeps the legacy
 * `findMatches` (ASCII + the length-preserving full-width fold) here, which makes the whole value leg a
 * PROVABLE STRICT SUPERSET of pre-round-14: identical PII behavior, ZERO over-redaction regression, and
 * the ONLY new redactions are raw + Unicode-obfuscated SECRET shapes. (Unicode-obfuscated PII-by-value
 * in the memory VALUE leg was NOT covered before round-14 and stays uncovered here — an intentional
 * exception recorded in the round-14 inventory; the audit content path covers it via the audit writer's
 * own pre/finalize passes, accepting that tradeoff for its owner-scoped 0600 sink.)
 *
 * STRICT SUPERSET / NO-DEGRADE. On a value whose Unicode detection copy is UNCHANGED (pure ASCII) AND
 * that carries NO secret shape, Pass 1 is skipped, Pass 2's raw secret scrubber is a no-op, and the
 * result is EXACTLY `redactContent(s, findMatches(s))` — byte-identical to the pre-round-14 PII-only
 * leg (and identical to returning `s` when there is no PII). A benign multilingual value folds to no
 * secret / PII shape, so every pass is a no-op and it round-trips verbatim.
 */
function redactSecretAndPiiValueString(s: string): string {
  // Pass 1 — Unicode-aware SECRET redaction over the de-obfuscated detection copy (secret shapes ONLY:
  // a Unicode-obfuscated sk-/JWT/PEM/github_pat/Bearer/assignment de-obfuscates and is redacted, its
  // ORIGINAL prefix bytes preserved via the credential-subspan mapping). Skipped (no-op) when the copy
  // is unchanged (pure ASCII). PII is deliberately NOT run here (see the header note).
  const detection = buildUnicodeDetectionCopy(s);
  const secretUnicode = detection.changed
    ? redactUnicodeObfuscated(s, [findSecretSpans])
    : s;
  // Pass 2 — raw secret residual: the in-place secret-shape scrubber (no-op on any string with no
  // secret shape → byte-identical to the legacy leg on a non-secret value). For a PURE-ASCII secret
  // this is the ONLY leg that catches it (Pass 1 was skipped).
  const secretResidual = redactSecretShapesInString(secretUnicode, SECRET_MARKER);
  // Pass 3 — PII residual: the UNCHANGED legacy value-PII leg (`findMatches` = ASCII + full-width fold,
  // U+3000 / U+FF0C-safe) over the secret-scrubbed result. Byte-identical to pre-round-14 for every
  // non-secret value; on a secret whose credential is also PII-shaped the secret marker already
  // consumed those bytes, so PII finds nothing (secret precedence).
  const piiResidual = findMatches(secretResidual);
  return piiResidual.length > 0 ? redactContent(secretResidual, piiResidual) : secretResidual;
}

/**
 * Sensitive-field registry for CONTEXT-AWARE typed redaction.
 *
 * A bare `number`/`bigint` carries no reliable signal of being PII: a 9/10/13–19-digit run or a
 * Luhn-valid value is just as likely an order number, invoice id, account id, or epoch
 * timestamp. `redactDeep` therefore redacts a numeric/bigint value only under TWO gates:
 *  (1) its OBJECT KEY names a known sensitive field (this registry), AND
 *  (2) the value's string form ACTUALLY matches that type's canonical detector (SSN / phone /
 *      Luhn-gated card) — see the value gate in `redactDeep`.
 * Never by digit shape or Luhn validity ALONE. Ambiguous numerics under other keys, benign
 * numerics under sensitive-sounding keys (`gift_card: 3`, `head_phone: 42`), and pure-numeric
 * object keys are preserved unchanged (no irreversible masking of legitimate ids). The string
 * at-rest policy is untouched: string values/keys still use the existing shape-based patterns.
 *
 * Key matching is by normalized token SUFFIX so prefixed variants match (`home_phone`,
 * `user_ssn`, `billing_card_number`) while unrelated names do not (`phone_count`, `telemetry`,
 * `discard`, `cardinality`, `order_id`). The final-token footgun (`gift_card`, `dust_pan`, …) is
 * covered by the value gate rather than a brittle denylist. Keys are normalized: camelCase is
 * split, digits and separators are dropped, and a trailing plural `s` on the final token folded.
 */
type FridayKeyDrivenPiiType = Extract<FridayMemoryGuardPiiType, "ssn_us" | "phone_us" | "credit_card">;

const SENSITIVE_KEY_PHRASE_TO_TYPE = new Map<string, FridayKeyDrivenPiiType>([
  ["ssn", "ssn_us"],
  ["ssn number", "ssn_us"],
  ["social security", "ssn_us"],
  ["social security number", "ssn_us"],
  ["phone", "phone_us"],
  ["phone number", "phone_us"],
  ["telephone", "phone_us"],
  ["tel", "phone_us"],
  ["mobile", "phone_us"],
  ["mobile number", "phone_us"],
  ["mobile phone", "phone_us"],
  ["card", "credit_card"],
  ["card number", "credit_card"],
  ["credit card", "credit_card"],
  ["credit card number", "credit_card"],
  ["pan", "credit_card"],
]);
const SENSITIVE_KEY_MAX_PHRASE_TOKENS = 3;

function normalizeKeyTokens(key: string): string[] {
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length > 0);
  const last = tokens.pop();
  if (last === undefined) return tokens;
  const singular =
    last.length > 3 && last.endsWith("s") && !last.endsWith("ss") ? last.slice(0, -1) : last;
  tokens.push(singular);
  return tokens;
}

/** Longest-suffix (most specific) lookup of a token list against the sensitive-key phrase registry. */
function matchSensitiveTypeForTokens(tokens: string[]): FridayKeyDrivenPiiType | undefined {
  if (tokens.length === 0) return undefined;
  const maxLen = Math.min(SENSITIVE_KEY_MAX_PHRASE_TOKENS, tokens.length);
  for (let len = maxLen; len >= 1; len -= 1) {
    const suffix = tokens.slice(tokens.length - len).join(" ");
    const type = SENSITIVE_KEY_PHRASE_TO_TYPE.get(suffix);
    if (type) return type;
  }
  return undefined;
}

/**
 * Resolve the PII type a value inherits from its object KEY, or `undefined` for a non-sensitive key.
 * The longest matching suffix wins (most specific). Purely key-driven — the value itself is never
 * inspected, so no benign number can be redacted by this path.
 *
 * PRIV-UNICODE-REDACTION-001 (round-10): classified over an ADDITIVE UNION of two tokenizations — the
 * same strict-superset discipline `findMatches` uses for value shapes — so a numeric/bigint PII value
 * under a Unicode-OBFUSCATED PII-context key is caught with ZERO regression:
 *   (1) RAW key tokens (`normalizeKeyTokens(key)`) — the EXACT pre-round-10 pass. Preserving it first
 *       means every key the guard classified before still classifies identically, so nothing is lost.
 *       This matters because the raw `.split(/[^a-z]+/)` treats a non-ASCII char as a token SEPARATOR
 *       that ISOLATES an adjacent complete PII token (`ssné`/`telé`/`cardé` → `ssn`/`tel`/`card`);
 *       canonicalizing FIRST would fold that separator into a letter and MERGE it away, dropping a
 *       match the guard used to make (a superset violation). Raw-first forecloses that.
 *   (2) UNICODE-CANONICAL key tokens — the key run through the SHARED detection primitive
 *       (`buildUnicodeDetectionCopy`: NFKD → strip `\p{M}` → strip Cf / Default_Ignorable → fold
 *       `\p{Nd}`, the SAME form the audit writer's field-name classifiers use) BEFORE the same
 *       camelCase-split derivation. This ADDS the obfuscated forms the raw split fragmented — a
 *       zero-width splice (`ph<U+200B>one`), a combining mark (`pho<U+0301>ne`), a full-width form
 *       (`ｐｈｏｎｅ`), or a precomposed accent (`phóne`) all fold to `phone`. NFKD preserves case, so a
 *       full-width camelCase key (`ｈｏｍｅＰｈｏｎｅ` → `homePhone`) still splits correctly.
 * The union returns the RAW match when present (byte-identical legacy decision) and otherwise the
 * canonical match, so NEW ⊇ OLD (strict superset). ASCII fast path: for a pure-ASCII key
 * `buildUnicodeDetectionCopy` returns the input unchanged, so pass (2) is skipped and the result is
 * byte-identical to the legacy classifier at zero extra cost. Only the CLASSIFICATION input is
 * normalized — the guard still writes/preserves ORIGINAL key bytes (`redactKey` and the redactDeep
 * slot keys are untouched), and the numeric VALUE gate (`numericValueMatchesKeyedType`) is unchanged,
 * so a benign number under a benign / coincidental key (`gift_card: 3`, `head_phone: 42`) is never
 * over-redacted.
 */
function sensitiveTypeForKey(key: string): FridayKeyDrivenPiiType | undefined {
  const rawType = matchSensitiveTypeForTokens(normalizeKeyTokens(key));
  if (rawType) return rawType;
  const canonicalKey = buildUnicodeDetectionCopy(key).normalized;
  if (canonicalKey === key) return undefined; // pure-ASCII (or no-op) fast path: nothing new to add
  return matchSensitiveTypeForTokens(normalizeKeyTokens(canonicalKey));
}

/**
 * VALUE gate for a numeric/bigint value whose OBJECT KEY already resolved to `type`
 * (sensitiveTypeForKey). Returns true only when the value's string form actually matches that
 * type's canonical detector. This runs strictly AFTER the sensitive-key gate, so it can never
 * reintroduce shape-only inference — a value under a non-sensitive key never reaches here.
 *
 * Phone normalization (F1): a US number persisted as a numeric loses its leading '+', producing
 * the 11-digit country-code form 1XXXXXXXXXX. The reused phone detector only accepts +1XXXXXXXXXX
 * or the bare 10-digit form, so that numeric form leaked. Because the key is ALREADY a registered
 * phone key, we may safely normalize by stripping the leading country-code '1' to the 10-digit
 * form the SAME detector recognizes — no new shape-only redaction is introduced.
 */
function numericValueMatchesKeyedType(str: string, type: FridayKeyDrivenPiiType): boolean {
  if (findMatches(str).some((m) => m.type === type)) return true;
  if (type === "phone_us" && /^1\d{10}$/.test(str)) {
    return findMatches(str.slice(1)).some((m) => m.type === "phone_us");
  }
  return false;
}

export function createFridayMemoryPiiGuard(
  mode?: FridayMemoryGuardPiiMode,
): FridayMemoryGuardPiiGuard {
  const effectiveMode: FridayMemoryGuardPiiMode = mode ?? FRIDAY_MEMORY_GUARD_PII_MODE;

  return {
    scanAndTransform(content: string): FridayMemoryGuardPiiScanResult {
      // `matches` / `distinctTypes` / `tagsToAdd` remain PII-ONLY (secrets carry no guard tag — the
      // guard is a PII tagger; secret redaction is a mutation, matching the key leg + the audit
      // value-secret path which also emit no tag). So a secret-only content string still returns
      // `matches: []`, keeping every downstream consumer (store-path block/tag decisions, the audit
      // writer's `findPiiValueSpans`) byte-identical.
      const matches = findMatches(content);
      const distinctTypes = [...new Set(matches.map((m) => m.type))];
      const tagsToAdd = distinctTypes.map(
        (type) => `${FRIDAY_MEMORY_GUARD_PII_TAG_PREFIX}.${type}`,
      );

      // SEC-EVENT-REDACTION-001 (round-14): in redact mode `transformedContent` now composes the
      // shared secret-shape scrubber (raw ∪ Unicode) WITH the existing PII redaction via the ONE
      // canonical value transform — so a secret string VALUE is scrubbed exactly as `redactKey`
      // scrubs a secret KEY. On a PII-only / benign / pure-ASCII content string this is
      // byte-identical to the pre-round-14 `redactContent(content, matches)` (see
      // `redactSecretAndPiiValueString`). tag/block mode leaves content unchanged (unchanged).
      const transformedContent =
        effectiveMode === "redact" ? redactSecretAndPiiValueString(content) : content;

      return {
        matches,
        distinctTypes,
        transformedContent,
        tagsToAdd,
      };
    },

    redactDeep(value: unknown): { value: unknown; tagsToAdd: string[] } {
      const tagSet = new Set<string>();
      // Traversal is ITERATIVE (an explicit heap-allocated work stack), CYCLE-AWARE, and
      // FULL-SCAN — there is NO depth cap and NO truncation sentinel. The real resource bound
      // is the UPSTREAM 16 KiB metadata byte-limit (validateMetadata runs before this on the
      // store path); every structure admitted by that bound is scanned to its leaves. Because
      // the work stack lives on the heap (not the ~2000–5000-frame JS call stack), arbitrarily
      // deep byte-bounded input is scanned without stack overflow. This replaces the previous
      // fixed recursion that returned a "[REDACTED_DEPTH]" sentinel past a depth cap in ALL
      // modes — silently corrupting valid deep metadata (canonical-data loss, DATA-RETENTION-001)
      // and violating the tag/block mode contracts. Deep PII is still ALWAYS found (the F2 leak
      // stays closed) and benign deep data now round-trips UNCHANGED.

      // String VALUE leaf. PII tags are collected from `findMatches` (ASCII + full-width) exactly as
      // before — secrets carry NO guard tag (mirrors `redactKey` + the audit value-secret path), and
      // tag/block mode never mutates the value. In REDACT mode the value is scrubbed by the ONE
      // canonical secret ∪ PII value transform (`redactSecretAndPiiValueString`) so a secret-shape
      // string VALUE (raw or Unicode-obfuscated) is redacted exactly as `redactKey` redacts a secret
      // KEY — closing SEC-EVENT-REDACTION-001's memory-egress leak. On a PII-only / benign /
      // pure-ASCII value that transform is byte-identical to the pre-round-14
      // `redactContent(s, findMatches(s))` (or to returning `s` unchanged when there is no PII), so
      // this is a STRICT SUPERSET.
      const redactStringLeaf = (s: string): string => {
        const matches = findMatches(s);
        for (const m of matches) {
          tagSet.add(`${FRIDAY_MEMORY_GUARD_PII_TAG_PREFIX}.${m.type}`);
        }
        return effectiveMode === "redact" ? redactSecretAndPiiValueString(s) : s;
      };

      // Redact PII carried in an object KEY. String key CONTENT that is itself recognizable PII
      // (email, or a formatted phone/SSN/card) is redacted in place, so `user@example.com` →
      // `[EMAIL]` and a compound `ssn:123-45-6789` → `ssn:[SSN_US]`. A PURE-DIGIT key is NEVER
      // shape-redacted — it is an ambiguous business id and is preserved verbatim.
      //
      // The pure-digit exemption is Unicode-decimal-aware (`/^\p{Nd}+$/u`), NOT ASCII-only
      // (`/^\d+$/`). The PII matcher folds full-width digits before matching, so an ASCII-only
      // exemption let the ASCII key "4111111111111111" through (correct) but folded its
      // semantically-identical FULL-WIDTH form "４１１１…" into a card and irreversibly renamed it
      // to "[CREDIT_CARD]" — corrupting a benign business id (DATA-RETENTION-001 no-corruption;
      // PRIV-UNICODE-REDACTION-001 benign-multilingual no-degrade). Testing `\p{Nd}` makes ASCII,
      // full-width, Arabic-Indic, and MIXED-width digit-only keys reach the SAME exempt outcome —
      // width/script-consistent with the matcher's fold. Only keys composed ENTIRELY of decimal
      // digits (any script, NON-empty, NO separators/other chars) are exempt: a FORMATTED PII key
      // (dashes/spaces/letters, e.g. "４１１１-…" or "ssn:123-45-6789") contains a non-`Nd` char, so
      // it fails the exemption and STILL redacts. This is purely the key-preservation exemption —
      // it does NOT weaken the value path (a full-width card VALUE is redacted as before).
      //
      // PRIV-UNICODE-REDACTION-001 (round-11): the key-CONTENT PII redaction is now UNICODE-AWARE.
      // The pre-round-11 pass ran ONLY `findMatches` (ASCII + full-width digit fold), so a KEY STRING
      // that is itself PII hidden by a zero-width splice (`victim@examp<U+200B>le.com`), a non-ASCII
      // decimal script (Arabic-Indic `١٢٣-٤٥-٦٧٨٩`), a combining-mark splice, or a precomposed accent
      // persisted BYTE-FOR-BYTE in both audit sinks and in memory egress. This is an ADDITIVE UNION of
      // two passes — the SAME strict-superset discipline the audit writer's content pre-pass uses:
      //   (1) UNICODE PASS FIRST — `redactUnicodeObfuscated(key, [findPiiSpans])` runs the guard's
      //       OWN PII detectors over the shared de-obfuscated DETECTION COPY (NFKD → strip `\p{M}` →
      //       strip Cf / Default_Ignorable → fold `\p{Nd}`), maps each matched span back to the
      //       ORIGINAL key span, and redacts the FULL original span. Running FULL-SPAN de-obfuscated
      //       redaction FIRST forecloses the local-part-accent FRAGMENTATION the raw ASCII matcher
      //       would produce (`víctim@…` → raw matches only the ASCII tail; NFC ≡ NFD here). It is a
      //       NO-OP on a key whose detection copy is unchanged (pure ASCII → `changed=false`
      //       short-circuit) or where no detector matches (benign multilingual key), so a benign key
      //       is returned verbatim.
      //   (2) RAW residual pass — `findMatches` over the pass-(1) result + `redactContent`. This
      //       REPRODUCES the EXACT pre-round-11 redaction for a pure-ASCII PII key (pass (1) short-
      //       circuits on it) AND rescues any legacy raw match a fold could have merged away
      //       (`123-45-6789<combining>0`: the raw `\b`-bounded SSN still redacts) — so NEW ⊇ OLD,
      //       byte-identical on every key the old pass caught and on every benign key.
      // TAGS are collected from BOTH passes (union) so an obfuscated PII key still contributes its
      // `pii.*` tag in tag/block mode, which never mutates the key. The ALL-`Nd` exemption runs FIRST
      // and unchanged, so a pure-decimal key (any script) is preserved before either pass. KEY
      // COLLISION is handled OUTSIDE this function by `resolveFinalKey` (two keys redacting to the
      // same marker are disambiguated so both VALUES survive) — unchanged; the markers this returns
      // (`[EMAIL]` / `[SSN_US]` / `[CREDIT_CARD]` / `[PHONE_US]`) are byte-identical to `redactContent`,
      // so collision detection keys on the same token.
      //
      // SEC-EVENT-REDACTION-001 (round-12): this is now the COMPLETE structured-key sanitizer —
      // secret ∪ PII, over raw ∪ Unicode. The Advisor ruled a SECRET-shape string used AS AN OBJECT
      // KEY (`sk-proj-…`, a JWT, `api_key=…`, `Authorization: Bearer …`) must be sanitized too (the
      // raw-sink oracle does not exempt JSON keys), and the audit writer applied secret-shape
      // redaction only to string VALUES. Both legs of the round-11 two-pass now compose the SAME
      // value-side secret detector alongside the PII one, secret FIRST (precedence on overlap, mirroring
      // the writer's content-leaf `secret ≻ PII`):
      //   (1) UNICODE PASS — `redactUnicodeObfuscated(key, [findSecretSpans, findPiiSpans])` runs
      //       BOTH finders over the de-obfuscated detection copy, so an OBFUSCATED secret key
      //       (`sk-<U+200B>…`, a full-width / combining-spliced credential) maps back and redacts
      //       exactly as an obfuscated PII key does. Round-13: `findSecretSpans` reports ONLY the
      //       sensitive CREDENTIAL subspan, so for a PREFIX-BEARING secret key
      //       (`Ａｕｔｈｏｒｉｚａｔｉｏｎ： Ｂｅａｒｅｒ <token>`, `ａｐｉ＿ｋｅｙ＝<token>`) the marker is spliced at the
      //       credential ALONE and the ORIGINAL fullwidth / combining / zero-width prefix + separator
      //       bytes survive BYTE-FOR-BYTE — the benign forensic prefix is NOT rewritten to ASCII
      //       (PRIV-UNICODE-REDACTION-001 byte-preservation). Whole-value shapes still redact whole.
      //   (2) RAW residual — secret-shape redaction (`redactSecretShapesInString`) runs FIRST over the
      //       pass-(1) result, THEN the UNCHANGED round-11 PII residual (`findMatches` + `redactContent`)
      //       over that. For a PURE-ASCII secret key the detection copy is unchanged so pass (1) is
      //       skipped — this raw leg is the ONLY one that catches it. `redactSecretShapesInString` is a
      //       NO-OP on any string with no secret shape, so on every non-secret key the raw residual is
      //       BYTE-IDENTICAL to round-11 (STRICT SUPERSET: nothing round-11's PII redactKey or the
      //       legacy ASCII redactKey caught is dropped — a key that is both is still fully redacted,
      //       just to the secret marker).
      // The ALL-`Nd` exemption still runs FIRST (a pure-decimal key of any script is never touched — a
      // pure-digit key carries no secret SHAPE either). Secrets carry NO guard tag (the guard is a PII
      // tagger; secret redaction is a mutation, matching the writer's value-secret path which also emits
      // no tag) — so tag/block mode returns a secret key UNCHANGED, consistent with the value path.
      const redactKey = (key: string): string => {
        if (/^\p{Nd}+$/u.test(key)) return key;

        // Tag union (PII only): raw-key matches ∪ detection-copy matches. Collected in ALL modes
        // (tag/block return the key unchanged but still surface the pii.* tag).
        const rawMatches = findMatches(key);
        for (const m of rawMatches) {
          tagSet.add(`${FRIDAY_MEMORY_GUARD_PII_TAG_PREFIX}.${m.type}`);
        }
        const detection = buildUnicodeDetectionCopy(key);
        if (detection.changed) {
          for (const m of findMatches(detection.normalized)) {
            tagSet.add(`${FRIDAY_MEMORY_GUARD_PII_TAG_PREFIX}.${m.type}`);
          }
        }

        // Sensitivity probe over the RAW key: PII ∪ secret-shape. A pure-ASCII SECRET key has
        // `detection.changed === false` and no PII match, so the pre-round-12 benign fast path
        // (`rawMatches.length === 0 && !detection.changed`) LEAKED it verbatim — the secret probe
        // closes that. (An OBFUSCATED secret key already has `detection.changed === true`, so it never
        // hit the fast path; its secret is caught by the Unicode pass below.)
        const hasRawSecret = findSecretShapeSpans(key, SECRET_MARKER).length > 0;

        // Benign key (no secret/PII in either view): byte-identical fast path, no tags — matches the
        // pre-round-11 `matches.length === 0` early return for pure ASCII and adds nothing for benign
        // multilingual keys.
        if (rawMatches.length === 0 && !hasRawSecret && !detection.changed) return key;

        if (effectiveMode !== "redact") return key; // tag/block: never mutate the key

        // Pass (1) Unicode-aware full-span redaction — secret ∪ PII (skipped when the copy is
        // unchanged — pure ASCII). Secret finder FIRST so an overlap keeps the secret marker.
        const unicodeRedacted = detection.changed
          ? redactUnicodeObfuscated(key, [findSecretSpans, findPiiSpans])
          : key;
        // Pass (2) raw residual — secret-shape FIRST (no-op when no secret shape), then the UNCHANGED
        // round-11 PII residual. On a non-secret key `secretResidual === unicodeRedacted`, so this is
        // byte-identical to round-11.
        const secretResidual = redactSecretShapesInString(unicodeRedacted, SECRET_MARKER);
        const rawResidual = findMatches(secretResidual);
        return rawResidual.length > 0
          ? redactContent(secretResidual, rawResidual)
          : secretResidual;
      };

      // Write `val` under `key` as an OWN DATA property rather than `out[key] = val`: a
      // JSON-originated own key named `__proto__` would otherwise invoke the legacy prototype
      // setter, mutating the output object's prototype (prototype confusion) AND dropping the
      // field from serialization. `Object.defineProperty` round-trips such keys as ordinary own
      // enumerable data properties with the prototype untouched. (F3 — preserved.)
      const defineOwn = (out: Record<string, unknown>, key: string, val: unknown): void => {
        Object.defineProperty(out, key, {
          value: val,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      };

      // Resolve the collision-disambiguated final key for `key` in `out`, WITHOUT writing the
      // value. Redacting keys can collapse two distinct PII keys onto the same token (e.g.
      // `a@x.com` and `b@y.com` → `[EMAIL]`); on collision the later entry is disambiguated
      // deterministically so both VALUES survive. The `#N` suffix contains no PII pattern, so a
      // second redactDeep pass is a no-op (idempotent). The slot is RESERVED in forward key
      // order (see the object branch) so the resulting key set and enumeration order are
      // byte-identical to the previous recursive walker; the deep value fills the slot later.
      const resolveFinalKey = (out: Record<string, unknown>, key: string): string => {
        if (!Object.prototype.hasOwnProperty.call(out, key)) return key;
        let suffix = 2;
        while (Object.prototype.hasOwnProperty.call(out, `${key}#${suffix}`)) {
          suffix += 1;
        }
        return `${key}#${suffix}`;
      };

      // Transform a scalar leaf. `keyedType` is the PII type a numeric/bigint value INHERITS
      // FROM ITS OBJECT KEY (see sensitiveTypeForKey); it is threaded through arrays (a list
      // under a sensitive key) but NOT into nested objects, which re-establish their own key
      // context. Containers (array/object) are NOT handled here — the iterative loop below
      // reconstructs them so the traversal never touches the call stack.
      const transformScalar = (v: unknown, keyedType?: FridayKeyDrivenPiiType): unknown => {
        if (typeof v === "string") {
          return redactStringLeaf(v);
        }
        // CONTEXT-AWARE typed redaction, gated on BOTH the key AND the value:
        //  (1) key gate  — the object key must name a known PII type (keyedType); unknown keys
        //      and context-less/array numbers are never candidates.
        //  (2) value gate — the value's string form must ACTUALLY match that type's canonical
        //      detector (SSN / phone / Luhn-gated card). This is strictly more conservative than
        //      key-alone: a benign numeric under a sensitive-sounding field (gift_card: 3,
        //      head_phone: 42, sim_card: 2) is preserved because "3"/"42"/"2" is not card/phone
        //      shaped. It does NOT reintroduce shape-alone inference — the value gate only runs
        //      AFTER the sensitive-key gate, so a Luhn-valid `order_id` under a NON-sensitive key
        //      is still preserved. In tag/block mode the value is returned UNCHANGED (contract:
        //      those modes never transform data) while the pii.* tag is still collected.
        if (typeof v === "number" || typeof v === "bigint") {
          if (!keyedType) return v;
          if (!numericValueMatchesKeyedType(String(v), keyedType)) return v;
          tagSet.add(`${FRIDAY_MEMORY_GUARD_PII_TAG_PREFIX}.${keyedType}`);
          return effectiveMode === "redact" ? `[${keyedType.toUpperCase()}]` : v;
        }
        // Preserve a Date's original TYPE (the object branch would otherwise walk its zero
        // own-enumerable props and corrupt it into `{}`). A Date is not a numeric PII carrier.
        return v;
      };

      // Explicit work stack. Each `value` frame writes its transformed result into a parent slot
      // via `assign`; each `exit` frame pops a container off the ancestor path once its whole
      // subtree is processed. `onPath` maps a container currently on the DFS ancestor path to
      // its output container; a back-edge to a node still on the path is a CYCLE — we assign the
      // (in-progress) output reference and do NOT recurse, so a cyclic input never infinite-loops
      // or stack-overflows and no data is lost. `onPath` is cleared on exit, so a re-referenced
      // node reached via a sibling path (a DAG, not a cycle) is fully re-walked — byte-identical
      // to the old recursive walker for every acyclic input.
      type ValueFrame = { value: unknown; keyedType?: FridayKeyDrivenPiiType; assign: (r: unknown) => void };
      type ExitFrame = { exit: object };
      const root: { out: unknown } = { out: undefined };
      const onPath = new WeakMap<object, unknown>();
      const stack: Array<ValueFrame | ExitFrame> = [
        { value, assign: (r) => { root.out = r; } },
      ];

      while (stack.length > 0) {
        const frame = stack.pop() as ValueFrame | ExitFrame;
        if ("exit" in frame) {
          onPath.delete(frame.exit);
          continue;
        }
        const { value: v, keyedType, assign } = frame;

        if (Array.isArray(v)) {
          if (onPath.has(v)) {
            assign(onPath.get(v)); // cycle back-edge → structural share (no data loss)
            continue;
          }
          const out: unknown[] = new Array(v.length);
          onPath.set(v, out);
          assign(out);
          stack.push({ exit: v });
          // Push in reverse so element frames are processed in forward index order (arrays
          // thread the parent keyedType into their elements).
          for (let i = v.length - 1; i >= 0; i -= 1) {
            const idx = i;
            stack.push({ value: v[idx], keyedType, assign: (r) => { out[idx] = r; } });
          }
          continue;
        }

        if (v instanceof Date) {
          assign(v);
          continue;
        }

        if (v && typeof v === "object") {
          if (onPath.has(v)) {
            assign(onPath.get(v)); // cycle back-edge → structural share (no data loss)
            continue;
          }
          const out: Record<string, unknown> = {};
          onPath.set(v, out);
          assign(out);
          stack.push({ exit: v });
          // Reserve every key slot in FORWARD Object.entries order (collision-disambiguated,
          // own data property) so the key set / enumeration order match the old recursive
          // walker exactly; deep values fill the reserved slots as their frames complete.
          const childFrames: ValueFrame[] = [];
          for (const [k, entry] of Object.entries(v as Record<string, unknown>)) {
            const finalKey = resolveFinalKey(out, redactKey(k));
            defineOwn(out, finalKey, undefined);
            const childKeyedType = sensitiveTypeForKey(k);
            childFrames.push({
              value: entry,
              keyedType: childKeyedType,
              assign: (r) => { defineOwn(out, finalKey, r); },
            });
          }
          for (let i = childFrames.length - 1; i >= 0; i -= 1) {
            stack.push(childFrames[i]);
          }
          continue;
        }

        // Scalar leaf (string / number / bigint / Date / null / boolean / undefined / other).
        assign(transformScalar(v, keyedType));
      }

      return { value: root.out, tagsToAdd: [...tagSet] };
    },
  };
}
