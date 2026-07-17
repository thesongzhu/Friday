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

// PRIV-UNICODE-REDACTION-001 (round-10): the SAME shared Unicode DETECTION primitive the audit
// writer's field-name classifiers use (NFKD → strip `\p{M}` → strip Cf / Default_Ignorable → fold
// `\p{Nd}`). Imported to Unicode-canonicalize the KEY as an ADDITIVE second pass in the guard's
// key-NAME classifier so a PII-context key hidden behind zero-width / combining / full-width /
// precomposed obfuscation is classified identically to its de-obfuscated ASCII form (see the
// strict-superset union in `sensitiveTypeForKey`). No import cycle: `friday-unicode-pii-normalizer.ts`
// is a dependency-free LEAF module (imports nothing), so the guard importing it introduces no cycle.
import { buildUnicodeDetectionCopy } from "../../../security/friday-unicode-pii-normalizer.js";

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

      // String leaves keep the EXISTING shape-based at-rest policy (unchanged by this lane):
      // scan with the PII patterns and redact in place in redact mode, tag-only otherwise.
      const redactStringLeaf = (s: string): string => {
        const matches = findMatches(s);
        if (matches.length === 0) return s;
        for (const m of matches) {
          tagSet.add(`${FRIDAY_MEMORY_GUARD_PII_TAG_PREFIX}.${m.type}`);
        }
        return effectiveMode === "redact" ? redactContent(s, matches) : s;
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
      const redactKey = (key: string): string => {
        if (/^\p{Nd}+$/u.test(key)) return key;
        const matches = findMatches(key);
        if (matches.length === 0) return key;
        for (const m of matches) {
          tagSet.add(`${FRIDAY_MEMORY_GUARD_PII_TAG_PREFIX}.${m.type}`);
        }
        return effectiveMode === "redact" ? redactContent(key, matches) : key;
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
