/**
 * SEC-REALTIME-EVENT-PII-BY-VALUE / round-7 F2 + round-8 F2b — Unicode-obfuscation-
 * resistant SECRET **and** value-PII detection for the realtime / agent event-payload
 * redactor.
 *
 * The previous secret pass matched only CONTIGUOUS ASCII shapes (`\bsk-…`, `Bearer …`,
 * …), and content-field value-PII (email / phone / SSN / card) relied on the shared
 * ASCII + fullwidth-DIGIT guard. An attacker (or a mis-encoded upstream) could split a
 * secret OR an email with a zero-width space, a combining mark, or write it in fullwidth
 * / mathematical-alphanumeric code points, and it survived RAW at rest and on the wire
 * (round-8 F2b: a fullwidth / zero-width / combining / precomposed-accent EMAIL leaked
 * VERBATIM, and a partial ASCII-fragment residual survived). This module closes that
 * bypass for BOTH classes WITHOUT over-redacting benign multilingual text, sharing ONE
 * non-destructive detection copy.
 *
 * PROVEN, COMPLETE RECIPE (detection copy is non-destructive; storage is byte-identical
 * when nothing matches):
 *   1. NFKD compatibility DECOMPOSITION — folds math-alphanumeric / fullwidth / ligature
 *      / circled forms to their base letters AND decomposes precomposed accented chars
 *      (é → e + ◌́). NFKC is deliberately NOT used: it does not decompose precomposed
 *      forms, a known canonical-equivalence bypass.
 *   2. strip combining marks (\p{M} — Mn/Mc/Me), so an accent used to split a token
 *      disappears and precomposed/decomposed forms collapse to the SAME detection copy.
 *   3. strip Cf / Default_Ignorable code points (zero-width & format: U+200B/C/D, U+2060,
 *      U+FEFF, soft hyphen, bidi controls, variation selectors, tag chars, …).
 *   4. fold decimal digits (\p{Nd}) to ASCII BY VALUE (fullwidth/math digits are already
 *      folded by NFKD; this additionally covers scripts NFKD does not, e.g. Arabic-Indic).
 *
 * Secret / PII shapes are matched over the normalized copy; every matched span is mapped
 * back to the ORIGINAL code-unit range that produced it and only those original bytes are
 * redacted. Because each normalized code unit records the [start,end) of its SOURCE code
 * point, any obfuscation char that sits INSIDE a matched region (a zero-width split, a
 * combining mark) is inside the mapped original span and is redacted along with the whole
 * match — nothing raw survives and no ASCII pass can later fragment a partially-matched
 * span. {@link redactUnicodeResistantSecrets} covers the SECRET shapes (used for both the
 * content and identifier paths); {@link redactUnicodeResistantPii} covers the value-PII
 * shapes (content path only — identifiers keep their identity), reusing the SAME detection
 * copy and a caller-supplied matcher so the shared guard's email/phone/SSN/Luhn-gated-card
 * detection is the single source of truth (no divergent second detector).
 *
 * @module api/realtime
 */

const REDACTED = "[REDACTED]";

// ─── Secret shape detectors (matched over the NORMALIZED copy) ───

/**
 * A detector's `sensitiveSpan` returns the [start, end) NORMALIZED code-unit range that
 * must be redacted for a given match — the whole match for opaque secrets, or the token
 * AFTER a preserved keyword prefix (Authorization/Bearer header, `key=` assignment) so
 * the surrounding structure stays legible, exactly as the pre-round-7 pass did.
 */
interface SecretDetector {
  readonly pattern: RegExp;
  readonly sensitiveSpan: (match: RegExpExecArray) => readonly [number, number];
}

function wholeMatch(match: RegExpExecArray): readonly [number, number] {
  return [match.index, match.index + match[0].length];
}

/** [end of capture group `groupIndex`, end of whole match] — preserves a leading prefix. */
function afterGroupToEnd(match: RegExpExecArray, groupIndex: number): readonly [number, number] {
  const groupSpan = match.indices?.[groupIndex];
  const whole = match.indices?.[0];
  if (!groupSpan || !whole) return wholeMatch(match);
  return [groupSpan[1], whole[1]];
}

/** [end of prefix group, start of suffix group] — the VALUE of a `key = "value"` shape. */
function betweenGroups(
  match: RegExpExecArray,
  prefixGroup: number,
  suffixGroup: number,
): readonly [number, number] {
  const prefix = match.indices?.[prefixGroup];
  const suffix = match.indices?.[suffixGroup];
  if (!prefix || !suffix) return wholeMatch(match);
  return [prefix[1], suffix[0]];
}

// All patterns carry the `d` (hasIndices) flag so group spans are available for
// prefix-preserving redaction, plus `g`/`u` for global Unicode scanning.
const SECRET_DETECTORS: readonly SecretDetector[] = [
  {
    pattern:
      /-----BEGIN (?:PGP )?[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:PGP )?[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/gdu,
    sensitiveSpan: wholeMatch,
  },
  {
    pattern: /\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gdiu,
    sensitiveSpan: (m) => afterGroupToEnd(m, 1),
  },
  {
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gdiu,
    sensitiveSpan: (m) => afterGroupToEnd(m, 1),
  },
  {
    pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/gdu,
    sensitiveSpan: wholeMatch,
  },
  {
    pattern: /\b(?:gh[opsru]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{16,})\b/gdu,
    sensitiveSpan: wholeMatch,
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}\b/gdu,
    sensitiveSpan: wholeMatch,
  },
  {
    pattern:
      /(^|[^A-Za-z0-9])("?(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret[_-]?access[_-]?key|password|secret|token)"?\s*[=:]\s*"?)[A-Za-z0-9._~+/=-]{8,}("?)/gdiu,
    sensitiveSpan: (m) => betweenGroups(m, 2, 3),
  },
];

// ─── Normalized detection copy with origin mapping ───

const COMBINING_MARK_RE = /\p{M}/gu;
const IGNORABLE_RE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const DECIMAL_DIGIT_RE = /\p{Nd}/gu;

/**
 * Base code point ("DIGIT ZERO") of each Unicode decimal-digit block whose digits NFKD
 * does NOT already fold to ASCII. Value = codePoint − base (the ten digits of every Nd
 * block are contiguous). ASCII, fullwidth and mathematical digits are omitted — NFKD
 * folds those to ASCII before this pass runs; leaving an unknown Nd untouched is safe
 * (it simply will not match the ASCII secret classes).
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
  return digit; // unknown Nd block — safe to leave (never matches ASCII secret classes)
}

/**
 * Fold a SINGLE original code point to its detection form. Applying NFKD + mark/format
 * strip PER code point is equivalent to whole-string NFKD for our purpose (we strip ALL
 * combining marks, so canonical reordering — the only cross-character effect — is
 * irrelevant), and lets us map every output code unit back to exactly one source code
 * point. May return "" (dropped mark / zero-width) or several chars (a decomposition).
 */
function foldCodePoint(codePoint: string): string {
  return codePoint
    .normalize("NFKD")
    .replace(COMBINING_MARK_RE, "")
    .replace(IGNORABLE_RE, "")
    .replace(DECIMAL_DIGIT_RE, foldDigit);
}

interface NormalizedView {
  /** Obfuscation-folded detection copy of the original string. */
  readonly normalized: string;
  /** originStart[i] = ORIGINAL code-unit index where normalized code unit i's source code point begins. */
  readonly originStart: readonly number[];
  /** originEnd[i] = ORIGINAL code-unit index just past that source code point. */
  readonly originEnd: readonly number[];
}

function buildNormalizedView(original: string): NormalizedView {
  let normalized = "";
  const originStart: number[] = [];
  const originEnd: number[] = [];
  let idx = 0;
  for (const codePoint of original) {
    const start = idx;
    const end = idx + codePoint.length; // 1 or 2 UTF-16 code units
    idx = end;
    const folded = foldCodePoint(codePoint);
    if (folded.length === 0) continue; // dropped (combining mark / zero-width / format)
    normalized += folded;
    for (let u = 0; u < folded.length; u += 1) {
      originStart.push(start);
      originEnd.push(end);
    }
  }
  return { normalized, originStart, originEnd };
}

// ─── Span merge + redaction over the ORIGINAL string ───

function redactOriginalSpans(original: string, spans: Array<[number, number]>): string {
  // Merge overlapping / touching spans so each contiguous secret region becomes ONE
  // [REDACTED] marker, then splice from END to START so earlier indices stay valid.
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      if (end > last[1]) last[1] = end;
    } else {
      merged.push([start, end]);
    }
  }
  let result = original;
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const [start, end] = merged[i];
    result = result.slice(0, start) + REDACTED + result.slice(end);
  }
  return result;
}

/**
 * Redact every secret shape from `original`, resistant to zero-width / combining /
 * fullwidth / mathematical / precomposed-vs-decomposed Unicode obfuscation. Returns the
 * input BYTE-IDENTICAL when no secret shape is present (benign multilingual text is never
 * touched). Only the ORIGINAL bytes that produced a matched normalized span are replaced.
 */
export function redactUnicodeResistantSecrets(original: string): string {
  if (original.length === 0) return original;
  const view = buildNormalizedView(original);
  if (view.normalized.length === 0) return original;

  const spans: Array<[number, number]> = [];
  for (const detector of SECRET_DETECTORS) {
    // Fresh RegExp instance per string so `lastIndex` never leaks across calls.
    const re = new RegExp(detector.pattern.source, detector.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(view.normalized)) !== null) {
      if (match[0].length === 0) {
        re.lastIndex += 1; // guard against a zero-width match stalling the loop
        continue;
      }
      const [ns, ne] = detector.sensitiveSpan(match);
      if (ne <= ns) continue;
      const oStart = view.originStart[ns];
      const oEnd = view.originEnd[ne - 1];
      if (oStart === undefined || oEnd === undefined || oEnd <= oStart) continue;
      spans.push([oStart, oEnd]);
    }
  }
  if (spans.length === 0) return original;
  return redactOriginalSpans(original, spans);
}

// ─── Value-PII (email / phone / SSN / card) over the SAME detection copy ───

/**
 * A value-PII match reported over the NORMALIZED detection copy: `[start, end)` are
 * NORMALIZED code-unit offsets and `type` is the shared guard's PII type label
 * (`email` | `phone_us` | `ssn_us` | `credit_card`). Shape-compatible (structurally) with
 * the shared guard's `FridayMemoryGuardPiiMatch` so a caller can pass its matches through
 * unchanged.
 */
export interface UnicodeResistantPiiMatch {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Redact value-PII (email / US phone / US SSN / Luhn-gated card) from `original`, resistant
 * to the SAME zero-width / combining / fullwidth / mathematical / precomposed-vs-decomposed
 * obfuscation as {@link redactUnicodeResistantSecrets}. The caller supplies `detectMatches`
 * — the shared production PII detector (e.g. `guard.scanAndTransform(s).matches`) — which is
 * run over the NON-DESTRUCTIVE normalized detection copy, so the guard's email/phone/SSN/
 * Luhn+false-positive-gated card logic stays the single source of truth (no divergent
 * second detector, no benign-content over-redaction). Each match is mapped back to the
 * ORIGINAL span that produced it and the FULL span is replaced with the guard's canonical
 * `[<TYPE>]` marker (e.g. `[EMAIL]`), so an obfuscation char inside a match is redacted with
 * it (no fragment residual). Overlapping original spans are merged (earliest label kept —
 * cosmetic; the whole span is redacted regardless), mirroring the shared guard's
 * `redactContent`. Returns the input BYTE-IDENTICAL when nothing matches — and, because the
 * normalized copy of a pure-ASCII / fullwidth-DIGIT string is length-aligned 1:1 with the
 * original, the result for those inputs is byte-identical to the shared guard's own output
 * (this pass is a strict Unicode-resistant SUPERSET, never a divergence).
 */
export function redactUnicodeResistantPii(
  original: string,
  detectMatches: (normalized: string) => readonly UnicodeResistantPiiMatch[],
): string {
  if (original.length === 0) return original;
  const view = buildNormalizedView(original);
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

  // Merge overlapping ORIGINAL spans (keep the earliest contributor's label — cosmetic,
  // the whole span is redacted regardless), then splice END→START so earlier indices stay
  // valid. Touching (adjacent) spans stay separate so distinct types keep distinct markers,
  // matching the shared guard's redactContent.
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
