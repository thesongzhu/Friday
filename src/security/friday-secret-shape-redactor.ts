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
 *     Groq (`gsk_…`), HuggingFace (`hf_…`, round-17), GitLab PAT (`glpat-…`), SendGrid (`SG.<22>.<43>`),
 *     Square (`sq0atp-…` / `sq0csp-…`), DigitalOcean PAT (`dop_v1_<64-hex>`), Slack app-level tokens
 *     (`xapp-…`). Each has a distinctive, low-false-positive prefix. Publishable / IDENTIFIER-only formats
 *     are NOT added (see the exclusion note below);
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
  // GLUED-PREFIX: leading `\b` KEPT deliberately. `eyJ` is not a delimiter-prefix — it is the base64url
  // of `{"` and thus part of the token BODY (base64url includes `_`/`-`), so dropping the boundary would
  // let `eyJ` match mid-base64-blob and newly over-redact benign base64 (a case the no-degrade corpus
  // guards). The boundary stays; a JWT glued after a word char is out of this fix's enumerated scope.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // GitHub tokens: classic `gh?_` prefixes AND fine-grained `github_pat_`.
  //
  // GLUED-PREFIX (SEC-SECRET-GLUED-PREFIX-001): the GitHub branch KEEPS its leading `\b` — UNLIKE the 10
  // other de-`\b`'d shapes, the classic prefixes are common ENGLISH WORD-FRAGMENTS: `ghs` ends
  // walkthrou-GHS, breakthrou-GHS, cou-GHS, hi-GHS, lau-GHS, rou-GHS, wei-GHS, plou-GHS, borou-GHS; and
  // `github_pat_` contains the word "github". So dropping the boundary would over-redact benign
  // `<word-ending-in-ghs>_<16+ CONTIGUOUS base62 run>` content this SHARED egress detector processes —
  // even with a base62 body: `walkthroughs_completedThisWeek` → `ghs_completedThisWeek` (17 base62) or
  // `coughs_e3b0c44298fc1c14` (a content-hash suffix) would be corrupted. Because the collision surface
  // is a word FRAGMENT (not a distinctive token prefix), `\b` is REQUIRED. Effect: a DELIMITED /
  // standalone / labeled classic token (`ghp_<base62>`, `token: ghp_…`, `apikey=ghp_…`) is STILL caught
  // (the common case); only a classic token glued DIRECTLY after a word char (`keyghp_…`) is an
  // ACCEPTED, documented gap — exactly like the kept-`\b` `sk-`/`AIza`/`ya29.`/`eyJ`/`xapp-` prefixes.
  // The classic body is still BASE62 (`[A-Za-z0-9]`, real-token shape) so a standalone `ghs_a_b_c`
  // snake_case identifier breaks at the first `_`; the `github_pat_` branch keeps its `_`-inclusive body
  // (a fine-grained PAT's body legitimately has `_`).
  {
    pattern: /\b(?:gh[opsru]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // Provider hyphen-prefixed API keys: OpenAI `sk-` / `sk-proj-`, `rk-`, `ak-`, xAI `xai-`. The
  // client-safe PUBLISHABLE `pk-` prefix is DELIBERATELY ABSENT from the alternation (round-16): a
  // Stripe/Google publishable key is not a secret, and Friday's own domain uses `pk-` for a satellite
  // PUBLIC key (`publicKey: "pk-…"`), so redacting a `pk-` value is data-loss, not protection.
  // GLUED-PREFIX: leading `\b` KEPT deliberately. `sk`/`rk`/`ak` are SHORT (2-char) prefixes that glue
  // into extremely common words ending in them — `desk-`, `risk-`, `task-`, `disk-`, `mask-`, `work-`,
  // `mark-`, `fork-`, `network-`, `break-`, `speak-`, `leak-` — and the `-`-inclusive body would then
  // over-redact a benign kebab identifier (`desk-management-framework-v2` → `sk-management-framework-v2`).
  // The boundary is REQUIRED here; this is the canonical "short/low-signal prefix" exclusion.
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
  // GLUED-PREFIX: leading `\b` KEPT deliberately. The `sk_`/`rk_` prefixes glue into the SAME common
  // words as the hyphen form (`desk_live_…`, `risk_test_…`, `task_live_…`), so — like `sk-`/`rk-` — the
  // boundary is retained; catching a glued Stripe underscore-key is not worth the benign-`sk_`/`rk_`
  // over-redaction risk. (The distinctive `whsec_` shares this pattern and inherits the kept boundary.)
  {
    pattern: /\b(?:(?:sk|rk)_(?:live|test)|whsec)_[A-Za-z0-9]{16,}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // AWS access-key id (`AKIA…` long-term + STS/temporary variants). NB: the AWS SECRET access key is
  // a shapeless 40-char base64 with no prefix — it is caught by its KEY NAME (`secretAccessKey`,
  // in the sensitive-field-name set), NOT a shape, so it is not (and must not be) a content pattern.
  // GLUED-PREFIX: leading `\b` KEPT deliberately (UNLIKE the base62 vendor prefixes). The `A(?:KIA|SIA|…)`
  // alternation embeds ENGLISH-WORD / base32-constructible fragments — `ASIA` (Asia / Eurasia /
  // Australasia), `AIDA`, and `AGPA`/`ANPA`/`ANVA` (constructible from Crockford base32) — AND its body is
  // `[0-9A-Z]{16}`, i.e. UPPERCASE + DIGIT, exactly the alphabet of an all-caps constant or a ULID. So
  // de-`\b` over-redacts benign all-caps / ULID / base32 identifiers this SHARED egress detector
  // processes: e.g. a 26-char ULID `012345AGPA…` → `012345[REDACTED]`, an all-caps `…ASIA…WIDE…` constant
  // → `AUSTRAL[REDACTED]`, a base32 OTP `ASIA…`. (The earlier "…ASIA…-`_`-separated cannot
  // span it" reasoning was WRONG — it only considered `_`-separated forms and missed all-caps-contiguous
  // / ULID / base32.) Same word-fragment class we keep `\b` on for classic-github (`-ghs`), `xapp` (app),
  // `sk-`, `AIza` (AI), `ya29`. Effect: standalone / delimited / labeled AWS keys (`AKIA<16>`,
  // `token AKIA…`, `apikey=AKIA…` — AWS keys are ~always delimited in env/config) are STILL caught; only
  // a key glued DIRECTLY after a word char (`xAKIA<16>`) is an ACCEPTED, documented gap.
  {
    pattern: /\bA(?:KIA|SIA|GPA|IDA|ROA|IPA|NPA|NVA)[0-9A-Z]{16}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // Google API key — `AIza` + 35 chars of `[0-9A-Za-z_-]` (documented 39-char format).
  // GLUED-PREFIX: leading `\b` KEPT deliberately. `AIza` begins with `AI`, a ubiquitous fragment in an
  // AI-domain codebase (`openAI…`, `vertexAI…`), so a glued form (`openAIza<35>`) is a plausible-enough
  // benign collision that the NO-DEGRADE hard bar favors the boundary over catching a (rare) glued key.
  {
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // Google OAuth ACCESS token — `ya29.` + a long base64url-ish body (Friday's own provider-fallback
  // scrubber recognizes this exact shape as key material; the literal `ya29.` prefix is highly
  // distinctive). No trailing `\b` — the body legitimately ends in `.`/`-`/`_`; the greedy run grabs
  // the whole token and the marker replaces it. A benign near-miss `ya29_notatoken` (underscore, not
  // the required literal `.`) never matches.
  // GLUED-PREFIX: leading `\b` KEPT deliberately. A username-style identifier ending in `ya29`
  // (`maya29`, `sonya29`, `priya29`) followed by `.<field>` would collide (`maya29.profile_image_url`
  // → `ya29.profile_image_url`), so the boundary is retained over catching a (rare) glued access token.
  {
    pattern: /\bya29\.[A-Za-z0-9._-]{20,}/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // Google OAuth CLIENT SECRET — `GOCSPX-` + a base64url body (distinctive prefix, low false positive).
  // GLUED-PREFIX: leading `\b` dropped — `GOCSPX-` is an all-caps, non-word prefix (no benign glue).
  {
    pattern: /GOCSPX-[A-Za-z0-9_-]{20,}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // GitLab personal access token — `glpat-` + 20+ base64url chars (distinctive prefix). A benign
  // `glpat_docs` (underscore, not the required hyphen) never matches.
  // GLUED-PREFIX: leading `\b` dropped — no benign identifier segment ends in `glpat` before a `-`.
  {
    pattern: /glpat-[A-Za-z0-9_-]{20,}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // SendGrid API key — the exact `SG.<22>.<43>` structure (two dot-separated base64url runs of fixed
  // length). The structured length is what makes `SG.` specific enough to avoid a benign-text false fire.
  // GLUED-PREFIX: leading `\b` dropped — the rigid `SG.<exactly-22>.<exactly-43>` shape is what gates
  // it, so a glued `imgSG.<22>.<43>` cannot arise from a plausible benign identifier.
  {
    pattern: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // Square access token (`sq0atp-`) / OAuth client secret (`sq0csp-`) — distinctive `sq0` prefix. The
  // newer `EAAA…` form is DELIBERATELY excluded (4-char base64 prefix, unacceptable false-positive risk).
  // GLUED-PREFIX: leading `\b` dropped — `sq0atp-`/`sq0csp-` are not benign identifier fragments.
  {
    pattern: /sq0(?:atp|csp)-[A-Za-z0-9_-]{22,60}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // DigitalOcean personal access token — `dop_v1_` + exactly 64 hex (distinctive prefix + fixed length).
  // GLUED-PREFIX: leading `\b` dropped — `dop_v1_` + EXACTLY 64 lowercase-hex is astronomically specific.
  {
    pattern: /dop_v1_[a-f0-9]{64}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // Groq API key — `gsk_` + 40+ base62 chars (Friday's provider-catalog classifies `gsk_` as Groq with
  // HIGH confidence; the body class excludes `_`, so a benign `gsk_` snake_case identifier never matches).
  // GLUED-PREFIX: leading `\b` dropped — see the hf_ note. Body `[A-Za-z0-9]{40,}` EXCLUDES `_`/`-`,
  // so a snake_case run cannot span it and `gsk` is not a benign fragment; a glued `xgsk_<40>` is caught.
  {
    pattern: /gsk_[A-Za-z0-9]{40,}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // HuggingFace user access token — `hf_` + 34+ base62 chars (Friday's provider-catalog classifies `hf_`
  // as HuggingFace with HIGH confidence, `detectFridayProviderKindFromApiKey`; a real bearer credential).
  // Real HF tokens are base62 (`[A-Za-z0-9]`, digits INCLUDED) — a strict SUPERSET of the letters-only
  // `hf_[a-zA-Z]{34}` secret-scanner rule, so a digit-bearing token is never under-matched. `{34,}` is
  // open-ended (NOT exact `{34}`) so a longer fine-grained token cannot slip the trailing `\b` and leak,
  // mirroring the `gsk_`/`glpat-` open-ended convention. The body class excludes `_`, so a benign short
  // `hf_docs` / `hf_` / `hf_config_value` snake_case identifier never matches (distinctive, low false-positive).
  //
  // GLUED-PREFIX (SEC-SECRET-GLUED-PREFIX-001): the leading `\b` is DROPPED so a credential glued to a
  // preceding ASCII word char (`keyhf_<34>`) — which has NO word boundary before `hf` — is still caught.
  // This is safe ONLY because the body is long + high-entropy: `[A-Za-z0-9]{34,}` EXCLUDES `_` and `-`,
  // so it cannot span a snake_case / kebab identifier boundary, and no benign identifier is realistically
  // going to contain the literal `hf_` followed by 34+ contiguous base62 chars. The trailing `\b` (and
  // the whole-match span) are UNCHANGED, so the redacted span is exactly `hf_<body>` and the benign
  // leading char (`key`) survives byte-for-byte. Same reasoning applies to every de-`\b`'d shape below/above.
  {
    pattern: /hf_[A-Za-z0-9]{34,}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // npm access token — `npm_` + 36 base62 chars. The body class excludes `_`, so a benign `npm_`
  // config identifier (`npm_config_cache`) never matches (it is short and contains `_`).
  // GLUED-PREFIX: leading `\b` dropped — body `[A-Za-z0-9]{36}` excludes `_`, `npm` is not a benign
  // fragment ending a word before `_`, so a glued `xnpm_<36>` is caught without over-matching.
  {
    pattern: /npm_[A-Za-z0-9]{36}\b/gu,
    sensitiveSpan: wholeMatchSpan,
  },
  // Slack tokens: bot/user `xox[abprs]-` AND app-level `xapp-` (Socket Mode). Friday's own Slack setup
  // recipe marks the `xapp-` app-level token `sensitive: true`; the `xapp-` prefix is distinctive.
  //
  // GLUED-PREFIX: the leading `\b` is DROPPED for the `xox[abprs]-` bot/user branch only (`xoxb`/`xoxp`/…
  // are not benign identifier fragments, so a glued `zxoxb-<10+>` is caught). The `xapp-` branch KEEPS its
  // leading `\b` (moved onto the branch): `app` is a ubiquitous fragment and `xapp` glues into plausible
  // benign identifiers (`maxapp-…`, `linuxapp-…`), which a `-`-inclusive body would then over-redact.
  {
    pattern: /(?:xox[abprs]|\bxapp)-[A-Za-z0-9-]{10,}\b/gu,
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
