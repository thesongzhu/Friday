/**
 * Comprehensive secret-shape redaction — a reusable, provider-agnostic scrubber that removes
 * leaked credentials from arbitrary at-rest / in-transit strings and flags sensitive field NAMES.
 *
 * SEC-EVENT-REDACTION-001 rejects copied / incomplete secret redactors. This module is the single
 * place that carries the full baseline coverage a redactor must have, so a sink layers it once
 * instead of hand-rolling a partial list:
 *   - sensitive field NAMES whose VALUE is a credential regardless of shape
 *     (`password` / `apiKey` / `api_key` / `token` / `secret` / …) — an opaque secret has no
 *     distinctive substring, so it can ONLY be caught by its key;
 *   - generic `key=value` / `key: value` credential ASSIGNMENTS embedded in free text;
 *   - GitHub tokens (`ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_` and fine-grained `github_pat_`);
 *   - provider API keys (`sk-` / `sk-proj-` / `rk-` / `ak-` / xAI `xai-`) — the `sk-` shape also
 *     covers Anthropic `sk-ant-…` (the `-` is inside the value class). The client-safe Stripe/Google
 *     PUBLISHABLE `pk-` prefix is DELIBERATELY EXCLUDED (round-16): a publishable key is not a secret,
 *     and Friday's own domain uses `pk-` for a satellite PUBLIC key — redacting it is data-loss;
 *   - Google API keys (`AIza…`, the documented 39-char format) + Google OAuth access tokens (`ya29.…`)
 *     + Google OAuth client secrets (`GOCSPX-…`);
 *   - npm access tokens (`npm_…`);
 *   - additional provider credential SHAPES Friday itself recognizes (round-16 consolidated audit):
 *     Groq (`gsk_…`), GitLab PAT (`glpat-…`), SendGrid (`SG.<22>.<43>`), Square (`sq0atp-…` / `sq0csp-…`),
 *     DigitalOcean PAT (`dop_v1_<64-hex>`), Slack app-level tokens (`xapp-…`). Each has a distinctive,
 *     low-false-positive prefix. Publishable / IDENTIFIER-only formats are NOT added (see the exclusion
 *     note below);
 *   - Stripe UNDERSCORE-format SECRET keys (`sk_live_` / `sk_test_`) + RESTRICTED keys
 *     (`rk_live_` / `rk_test_`) + the webhook signing secret (`whsec_`) — the hyphenated `sk-` /
 *     `rk-` shapes above MISS the underscore forms Stripe actually issues. The PUBLISHABLE keys
 *     `pk_live_` / `pk_test_` are DELIBERATELY NOT matched: they are client-safe and not a secret;
 *   - AWS access-key ids (`AKIA…` and the STS/temporary variants);
 *   - Slack tokens (`xoxb-` / `xoxp-` / … bot/user) AND app-level tokens (`xapp-…`);
 *   - JWTs (three base64url segments beginning `eyJ`);
 *   - PEM private-key blocks (RSA / EC / OPENSSH / PGP / generic);
 *   - Bearer / `Authorization: Bearer` credentials (scheme kept, token redacted).
 *
 * DELIBERATELY EXCLUDED — not a secret, or an over-redactor with no bounded shape (round-16 audit):
 *   - Stripe/Google PUBLISHABLE `pk-` / `pk_live_` / `pk_test_` — client-safe, not a secret;
 *   - Twilio API Key SID `SK<32-hex>` — that is the IDENTIFIER (username), NOT the credential; the
 *     Twilio secret / Auth Token is a SHAPELESS value caught by its KEY NAME (like the AWS secret key),
 *     and a bare `SK`+32-hex would false-fire on benign 34-char hex strings;
 *   - generic / unverified prefixes Friday's error-message display scrubber uses (`key-` / `sess-` /
 *     `ssm-` / `aip-` / `whsk-`) — too generic (`key-<8+>` collides with benign `key-management…`) or of
 *     unverified provider provenance; that aggressive display scrubber tolerates over-redaction, this
 *     canonical persistence/egress detector must NOT;
 *   - Square `EAAA…` — a 4-char base64 prefix with unacceptable false-positive risk (kept `sq0atp-`).
 * PII-by-value (email / phone / SSN / card) is DELIBERATELY out of scope here — that is the shared
 * `createFridayMemoryPiiGuard("redact").redactDeep` responsibility. This module is the secret
 * complement, kept as an independent string primitive so any sink can layer it OVER the PII guard.
 *
 * The marker is a parameter (default `[REDACTED_SECRET]`) so consumers keep their own convention.
 *
 * PREFIX-PRESERVING CREDENTIAL SUBSPAN (round-13). Every detector reports ONLY the sensitive CREDENTIAL
 * subspan of its match — for a prefix-bearing shape (`Authorization: Bearer <token>`, generic
 * `<key>=<value>` assignment) that is the token AFTER the scheme/label + separator, NOT the whole
 * `prefix+credential` span, and NOT a replacement reconstructed from the (possibly NORMALIZED) prefix
 * capture. This is what lets `redactUnicodeObfuscated` map a match found on the Unicode-de-obfuscated
 * DETECTION copy back into the ORIGINAL string and splice the marker at the credential ALONE, so the
 * benign forensic prefix / keyword / whitespace / quoting / separator bytes survive BYTE-FOR-BYTE (a
 * fullwidth `Ａｕｔｈｏｒｉｚａｔｉｏｎ： Ｂｅａｒｅｒ` prefix is not silently rewritten to ASCII). `findSecretShapeSpans`
 * is the single CANONICAL prefix-preserving detector both this module's in-place scrubber and PR #1618's
 * realtime secret-unicode scanner build on (see `SecretShapeSensitiveSpan`, mirroring #1618's design).
 */

import { buildUnicodeDetectionCopy } from "./friday-unicode-pii-normalizer.js";

export const FRIDAY_DEFAULT_SECRET_MARKER = "[REDACTED_SECRET]";

/**
 * Field NAMES whose VALUE is a credential regardless of shape. Normalized for lookup by removing
 * `-` / `_` / whitespace and lowercasing, so `api_key`, `apiKey`, `API-KEY` all collapse to the
 * same token. Kept intentionally SPECIFIC (never the bare `id`, `key`, or `auth…header`) so a sink
 * does not wholesale-nuke a benign forensic identifier or an `Authorization` header whose scheme
 * word is worth keeping (that flows through the string scrubber's Bearer pattern instead).
 */
const SENSITIVE_SECRET_FIELD_NAMES = new Set<string>([
  "password", "passwd", "passphrase", "passcode",
  "secret", "clientsecret", "appsecret", "secretkey", "secretaccesskey",
  "token", "accesstoken", "refreshtoken", "sessiontoken", "idtoken", "bearertoken",
  "apikey", "apisecret", "privatekey",
  "authorization", "cookie", "setcookie",
  "credential", "credentials",
]);

/**
 * True when `key` names a credential whose whole value should be replaced (shape-independent).
 *
 * A shapeless credential VALUE is catchable ONLY by its KEY, so an obfuscated KEY must not escape
 * classification (PRIV-UNICODE-REDACTION-001 round-9). The key is FIRST canonicalized through the
 * SAME shared Unicode detection primitive used for VALUES — `buildUnicodeDetectionCopy` (NFKD
 * compatibility fold → strip `\p{M}` combining marks → strip Cf / Default_Ignorable → fold `\p{Nd}`
 * digits to ASCII) — so a KEY hidden behind a zero-width splice (`api<U+200B>Key`), a combining mark
 * (`to<U+0301>ken`), a full-width form (`ｓｅｃｒｅｔ`), a mathematical-alphanumeric (`𝐩𝐚𝐬𝐬𝐰𝐨𝐫𝐝`), or a
 * PRECOMPOSED accent (`pásswörd`) de-obfuscates to its canonical spelling. THEN the existing ASCII
 * normalization (strip `-` / `_` / whitespace, lowercase) runs on the canonical form. NO-DEGRADE:
 * for a pure-ASCII key `buildUnicodeDetectionCopy` returns it BYTE-IDENTICAL (fast path), so every
 * existing ASCII decision is unchanged; the canonical form only feeds the SAME exact-match set, so a
 * benign multilingual key (CJK / Arabic / accented) or a near-miss (`tokens` / `key` / `passwordHint`)
 * that does not fold to a listed token stays NON-sensitive — matching is never broadened.
 */
export function isSensitiveSecretFieldName(key: string): boolean {
  const canonical = buildUnicodeDetectionCopy(key).normalized;
  const normalized = canonical.replace(/[-_\s]/gu, "").toLowerCase();
  if (normalized.length === 0) return false;
  return SENSITIVE_SECRET_FIELD_NAMES.has(normalized);
}

/**
 * The ABSOLUTE `[start, end)` code-unit range (in the scanned string's coordinates) of a secret-shape
 * match's sensitive CREDENTIAL — the ONLY range a consumer replaces with the marker. Every byte the
 * pattern matched OUTSIDE this range — a Bearer scheme prefix, an assignment keyword + separator +
 * surrounding quotes — is BENIGN forensic context and MUST be preserved byte-for-byte.
 *
 * This is the mechanism that lets a match found on a NORMALIZED (Unicode-de-obfuscated) detection copy
 * be mapped back and spliced into the ORIGINAL string WITHOUT rewriting the original's benign prefix
 * bytes (`redactUnicodeObfuscated`): reporting the whole `prefix+credential` span with a replacement
 * reconstructed from the NORMALIZED prefix capture would persist the fullwidth prefix
 * `Ａｕｔｈｏｒｉｚａｔｉｏｎ： Ｂｅａｒｅｒ` as ASCII — violating the PRIV-UNICODE-REDACTION-001 byte-preservation
 * contract (round-13). Mirrors PR #1618's `sensitiveSpan` design so the two converge on one detector.
 */
type SecretShapeSensitiveSpan = (match: RegExpExecArray) => { readonly start: number; readonly end: number };

type SecretContentPattern = {
  readonly pattern: RegExp;
  readonly sensitiveSpan: SecretShapeSensitiveSpan;
};

/** Whole match IS the credential (no benign prefix): PEM / JWT / GitHub / `sk-` / AWS / Slack. */
function wholeMatchSpan(match: RegExpExecArray): { start: number; end: number } {
  return { start: match.index, end: match.index + match[0].length };
}

/**
 * `[end of prefix, end of whole match]` — the credential AFTER a preserved leading scheme/header prefix
 * (`Bearer ` / `Authorization: Bearer `). `prefix` is the capture group that runs from the match start
 * (after the zero-width `\b`) up to the credential, so its LENGTH gives the credential's start offset —
 * no RegExp `d` (indices) flag needed. Equivalent to #1618's `afterGroupToEnd(m, 1)`.
 */
function credentialAfterPrefix(
  match: RegExpExecArray,
  prefix: string | undefined,
): { start: number; end: number } {
  return { start: match.index + (prefix ?? "").length, end: match.index + match[0].length };
}

/**
 * `[end of prefix, start of suffix]` — the credential VALUE of a `<label><sep><value>` assignment,
 * preserving `leading` (the char before the label) + `prefix` (label + separator + any opening quote) +
 * `suffix` (any closing quote). The three groups are contiguous within the match, so their LENGTHS
 * locate the credential subspan without the RegExp `d` flag. Equivalent to #1618's `betweenGroups(m, 2, 3)`.
 */
function credentialBetween(
  match: RegExpExecArray,
  leading: string | undefined,
  prefix: string | undefined,
  suffix: string | undefined,
): { start: number; end: number } {
  const before = (leading ?? "").length + (prefix ?? "").length;
  return { start: match.index + before, end: match.index + match[0].length - (suffix ?? "").length };
}

/**
 * Ordered secret-shape passes. Ordering favors the most specific shape first so a value is redacted
 * whole (a Bearer JWT is caught by the Bearer pass before the JWT pass). Each pattern carries a
 * `sensitiveSpan` reporting ONLY its credential subspan (see `SecretShapeSensitiveSpan`); the marker is
 * a splice PARAMETER of the consumers, so no marker state is baked into the shared patterns and no
 * `RegExp` `lastIndex` is shared (the consumers clone each pattern before scanning).
 */
const SECRET_CONTENT_PATTERNS: readonly SecretContentPattern[] = [
  // PEM private-key blocks (RSA / EC / OPENSSH / PGP / generic).
  {
    pattern:
      /-----BEGIN (?:PGP )?[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:PGP )?[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // `Authorization: Bearer <token>` — keep the header + scheme, redact ONLY the credential.
  {
    pattern: /\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu,
    sensitiveSpan: (m) => credentialAfterPrefix(m, m[1]),
  },
  // Bare `Bearer <token>` — keep the scheme, redact ONLY the credential.
  {
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu,
    sensitiveSpan: (m) => credentialAfterPrefix(m, m[1]),
  },
  // JWT — three base64url segments, the first beginning `eyJ` (`{"…`).
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // GitHub tokens: classic `gh?_` prefixes AND fine-grained `github_pat_`.
  {
    pattern: /\b(?:gh[opsru]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // Provider hyphen-prefixed API keys: OpenAI `sk-` / `sk-proj-`, `rk-`, `ak-`, xAI `xai-`. The
  // client-safe PUBLISHABLE `pk-` prefix is DELIBERATELY ABSENT from the alternation (round-16): a
  // Stripe/Google publishable key is not a secret, and Friday's own domain uses `pk-` for a satellite
  // PUBLIC key (`publicKey: "pk-…"`), so redacting a `pk-` value is data-loss, not protection.
  {
    pattern: /\b(?:sk|rk|ak|xai)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // Stripe-style UNDERSCORE-format credentials the hyphenated `sk-` / `rk-` shape above MISSES:
  // SECRET keys `sk_live_` / `sk_test_`, RESTRICTED keys `rk_live_` / `rk_test_`, and the webhook
  // signing secret `whsec_`. The PUBLISHABLE keys `pk_live_` / `pk_test_` are DELIBERATELY excluded
  // (client-safe, not a secret) — the `pk` prefix is absent from the alternation, so a publishable
  // key never matches. (Stripe key bodies are base62 with no internal `_`, so the value run is
  // `[A-Za-z0-9]{16,}`; the leading `(?:sk|rk)_(?:live|test)` / `whsec` cannot false-fire on benign
  // snake_case identifiers.)
  {
    pattern: /\b(?:(?:sk|rk)_(?:live|test)|whsec)_[A-Za-z0-9]{16,}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // AWS access-key id (`AKIA…` long-term + STS/temporary variants). NB: the AWS SECRET access key is
  // a shapeless 40-char base64 with no prefix — it is caught by its KEY NAME (`secretAccessKey`,
  // in the sensitive-field-name set), NOT a shape, so it is not (and must not be) a content pattern.
  {
    pattern: /\bA(?:KIA|SIA|GPA|IDA|ROA|IPA|NPA|NVA)[0-9A-Z]{16}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // Google API key — `AIza` + 35 chars of `[0-9A-Za-z_-]` (documented 39-char format).
  {
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // Google OAuth ACCESS token — `ya29.` + a long base64url-ish body (Friday's own provider-fallback
  // scrubber recognizes this exact shape as key material; the literal `ya29.` prefix is highly
  // distinctive). No trailing `\b` — the body legitimately ends in `.`/`-`/`_`; the greedy run grabs
  // the whole token and the marker replaces it. A benign near-miss `ya29_notatoken` (underscore, not
  // the required literal `.`) never matches.
  {
    pattern: /\bya29\.[A-Za-z0-9._-]{20,}/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // Google OAuth CLIENT SECRET — `GOCSPX-` + a base64url body (distinctive prefix, low false positive).
  {
    pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // GitLab personal access token — `glpat-` + 20+ base64url chars (distinctive prefix). A benign
  // `glpat_docs` (underscore, not the required hyphen) never matches.
  {
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // SendGrid API key — the exact `SG.<22>.<43>` structure (two dot-separated base64url runs of fixed
  // length). The structured length is what makes `SG.` specific enough to avoid a benign-text false fire.
  {
    pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // Square access token (`sq0atp-`) / OAuth client secret (`sq0csp-`) — distinctive `sq0` prefix. The
  // newer `EAAA…` form is DELIBERATELY excluded (4-char base64 prefix, unacceptable false-positive risk).
  {
    pattern: /\bsq0(?:atp|csp)-[A-Za-z0-9_-]{22,60}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // DigitalOcean personal access token — `dop_v1_` + exactly 64 hex (distinctive prefix + fixed length).
  {
    pattern: /\bdop_v1_[a-f0-9]{64}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // Groq API key — `gsk_` + 40+ base62 chars (Friday's provider-catalog classifies `gsk_` as Groq with
  // HIGH confidence; the body class excludes `_`, so a benign `gsk_` snake_case identifier never matches).
  {
    pattern: /\bgsk_[A-Za-z0-9]{40,}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // npm access token — `npm_` + 36 base62 chars. The body class excludes `_`, so a benign `npm_`
  // config identifier (`npm_config_cache`) never matches (it is short and contains `_`).
  {
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // Slack tokens: bot/user `xox[abprs]-` AND app-level `xapp-` (Socket Mode). Friday's own Slack setup
  // recipe marks the `xapp-` app-level token `sensitive: true`; the `xapp-` prefix is distinctive.
  {
    pattern: /\b(?:xox[abprs]|xapp)-[A-Za-z0-9-]{10,}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // Generic credential ASSIGNMENT embedded in free text: `<cred-name>=<value>` / `<cred-name>: <value>`.
  // Keeps the leading char + credential label + separator + surrounding quotes, redacts ONLY the value.
  {
    pattern:
      /(^|[^A-Za-z0-9_])("?(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|session[_-]?token|secret[_-]?access[_-]?key|client[_-]?secret|passphrase|passcode|password|passwd|secret|token)"?\s*[=:]\s*"?)[A-Za-z0-9._~+/=-]{6,}("?)/giu,
    sensitiveSpan: (m) => credentialBetween(m, m[1], m[2], m[3]),
  },
];

/**
 * Splice `marker` over every credential subspan a single `pattern` reports in `input` (right-to-left,
 * so earlier offsets stay valid). Only each match's `sensitiveSpan` credential range changes; a Bearer
 * scheme prefix or an assignment label + separator + quotes is preserved BYTE-FOR-BYTE. Non-matching
 * text round-trips identical. Empty / zero-width matches are skipped (with a `lastIndex` bump) so a
 * global regex cannot spin. The pattern is cloned so no shared `lastIndex` leaks across calls.
 */
function spliceCredentialSubspans(
  input: string,
  { pattern, sensitiveSpan }: SecretContentPattern,
  marker: string,
): string {
  const regex = new RegExp(pattern.source, pattern.flags);
  const spans: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    const { start, end } = sensitiveSpan(match);
    if (end > start) spans.push({ start, end });
  }
  if (spans.length === 0) return input;
  // Splice from the LAST match backward so earlier offsets stay valid (spans are collected in ascending
  // match order). Property access on each span avoids a computed-index object-injection sink.
  let result = input;
  for (const span of [...spans].reverse()) {
    result = result.slice(0, span.start) + marker + result.slice(span.end);
  }
  return result;
}

/**
 * Redact every recognized secret SHAPE inside a single string, in place. For a whole-value shape the
 * whole match becomes the marker; for a PREFIX-BEARING shape (Bearer / `Authorization: Bearer` /
 * generic assignment) ONLY the credential subspan becomes the marker and the benign scheme / label +
 * separator + quoting is PRESERVED byte-for-byte. Non-matching text (and any string with no secret
 * shape) round-trips byte-identical. PII-by-value is NOT handled here (see module header). Idempotent:
 * re-running over an already-redacted string is a no-op (the marker matches no pattern). Uses the SAME
 * per-pattern `sensitiveSpan` credential subspans as `findSecretShapeSpans`, so the in-place and
 * out-of-band redaction paths are byte-consistent.
 */
export function redactSecretShapesInString(
  input: string,
  marker: string = FRIDAY_DEFAULT_SECRET_MARKER,
): string {
  let redacted = input;
  for (const pattern of SECRET_CONTENT_PATTERNS) {
    redacted = spliceCredentialSubspans(redacted, pattern, marker);
  }
  return redacted;
}

/**
 * A secret-shape match reported as its sensitive CREDENTIAL `[start, end)` subspan plus the marker to
 * splice there. For a whole-value shape the subspan IS the whole match; for a prefix-bearing shape
 * (Bearer / `Authorization: Bearer` / generic assignment) the subspan is ONLY the credential AFTER the
 * preserved scheme / label + separator (the prefix is NOT part of the span). `replacement` is always
 * the marker — never a string reconstructed from (possibly normalized) prefix captures.
 */
export interface FridaySecretShapeSpan {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/**
 * Report every secret-shape match in `input` as its sensitive CREDENTIAL `[start, end)` subspan plus
 * the marker. This is the CANONICAL prefix-preserving credential-subspan detector: because a
 * prefix-bearing match reports ONLY the credential subspan (never the whole `prefix+credential` span,
 * never a replacement reconstructed from the prefix capture), a caller that runs this over a NORMALIZED
 * (Unicode-de-obfuscated) detection copy and maps the span back into the ORIGINAL string redacts ONLY
 * the credential and leaves the ORIGINAL prefix / keyword / whitespace / quoting / separator bytes
 * BYTE-IDENTICAL (PRIV-UNICODE-REDACTION-001 byte-preservation, round-13 — a fullwidth
 * `Ａｕｔｈｏｒｉｚａｔｉｏｎ： Ｂｅａｒｅｒ` prefix is NOT rewritten to ASCII). It is the SPAN entry point the
 * Unicode-normalizer de-obfuscation layer (`redactUnicodeObfuscated`) consults, and — per
 * SEC-EVENT-REDACTION-001 — the single canonical detector PR #1618's realtime secret-unicode scanner
 * rebases to consume (replacing its local `sensitiveSpan` detectors). Same ordered pattern set +
 * credential subspans as `redactSecretShapesInString`, so span coverage is byte-consistent with
 * in-place redaction. Empty-width matches are skipped (with a `lastIndex` bump) so a global regex
 * cannot spin.
 */
export function findSecretShapeSpans(
  input: string,
  marker: string = FRIDAY_DEFAULT_SECRET_MARKER,
): FridaySecretShapeSpan[] {
  const spans: FridaySecretShapeSpan[] = [];
  for (const { pattern, sensitiveSpan } of SECRET_CONTENT_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(input)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      const { start, end } = sensitiveSpan(match);
      if (end > start) spans.push({ start, end, replacement: marker });
    }
  }
  return spans;
}
