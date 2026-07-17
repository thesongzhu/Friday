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
 *   - provider API keys (`sk-` / `sk-proj-` / `pk-` / `rk-` / `ak-`);
 *   - AWS access-key ids (`AKIA…` and the STS/temporary variants);
 *   - Slack tokens (`xoxb-` / `xoxp-` / …);
 *   - JWTs (three base64url segments beginning `eyJ`);
 *   - PEM private-key blocks (RSA / EC / OPENSSH / PGP / generic);
 *   - Bearer / `Authorization: Bearer` credentials (scheme kept, token redacted).
 *
 * PII-by-value (email / phone / SSN / card) is DELIBERATELY out of scope here — that is the shared
 * `createFridayMemoryPiiGuard("redact").redactDeep` responsibility. This module is the secret
 * complement, kept as an independent string primitive so any sink can layer it OVER the PII guard.
 *
 * The marker is a parameter (default `[REDACTED_SECRET]`) so consumers keep their own convention.
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

type SecretContentPattern = {
  readonly pattern: RegExp;
  readonly replacement: string | ((match: string, ...groups: string[]) => string);
};

/**
 * Ordered secret-shape passes. Built per-call so the caller's marker is baked in and no `RegExp`
 * `lastIndex` state is shared across invocations. Ordering favors the most specific shape first so
 * a value is redacted whole (a Bearer JWT is caught by the Bearer pass before the JWT pass).
 */
function buildSecretContentPatterns(marker: string): SecretContentPattern[] {
  return [
    // PEM private-key blocks (RSA / EC / OPENSSH / PGP / generic).
    {
      pattern:
        /-----BEGIN (?:PGP )?[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:PGP )?[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/gu,
      replacement: marker,
    },
    // `Authorization: Bearer <token>` — keep the header + scheme, redact the credential.
    {
      pattern: /\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu,
      replacement: (_match, prefix: string) => `${prefix}${marker}`,
    },
    // Bare `Bearer <token>`.
    {
      pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu,
      replacement: (_match, prefix: string) => `${prefix}${marker}`,
    },
    // JWT — three base64url segments, the first beginning `eyJ` (`{"…`).
    {
      pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}\b/gu,
      replacement: marker,
    },
    // GitHub tokens: classic `gh?_` prefixes AND fine-grained `github_pat_`.
    {
      pattern: /\b(?:gh[opsru]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/gu,
      replacement: marker,
    },
    // Provider API keys: OpenAI `sk-` / `sk-proj-`, publishable `pk-`, `rk-`, `ak-`.
    {
      pattern: /\b(?:sk|pk|rk|ak)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/gu,
      replacement: marker,
    },
    // AWS access-key id (`AKIA…` long-term + STS/temporary variants).
    {
      pattern: /\bA(?:KIA|SIA|GPA|IDA|ROA|IPA|NPA|NVA)[0-9A-Z]{16}\b/gu,
      replacement: marker,
    },
    // Slack tokens.
    {
      pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/gu,
      replacement: marker,
    },
    // Generic credential ASSIGNMENT embedded in free text: `<cred-name>=<value>` / `<cred-name>: <value>`.
    // Keeps the credential label (forensic context) and redacts only the value.
    {
      pattern:
        /(^|[^A-Za-z0-9_])("?(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|session[_-]?token|secret[_-]?access[_-]?key|client[_-]?secret|passphrase|passcode|password|passwd|secret|token)"?\s*[=:]\s*"?)[A-Za-z0-9._~+/=-]{6,}("?)/giu,
      replacement: (_match, leading: string, prefix: string, suffix: string) =>
        `${leading}${prefix}${marker}${suffix}`,
    },
  ];
}

/**
 * Redact every recognized secret SHAPE inside a single string. Non-matching text (and any string
 * with no secret shape) round-trips byte-identical. PII-by-value is NOT handled here (see module
 * header). Idempotent: re-running over an already-redacted string is a no-op (the marker matches
 * no pattern).
 */
export function redactSecretShapesInString(
  input: string,
  marker: string = FRIDAY_DEFAULT_SECRET_MARKER,
): string {
  let redacted = input;
  for (const { pattern, replacement } of buildSecretContentPatterns(marker)) {
    redacted = redacted.replace(pattern, replacement as never);
  }
  return redacted;
}

/** A secret-shape match reported as a SPAN + the replacement string (for out-of-band redaction). */
export interface FridaySecretShapeSpan {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/**
 * Report every secret-shape match in `input` as a `[start, end)` span plus the exact replacement
 * string `redactSecretShapesInString` would produce for it (marker for a whole-value shape;
 * `scheme`/`label` + marker for the Bearer / generic-assignment shapes). Same ordered pattern set
 * as the string scrubber, so span coverage is byte-consistent with in-place redaction — this is the
 * SPAN entry point the Unicode-normalizer de-obfuscation layer consults so a match found on the
 * normalized detection copy can be mapped back and redacted in the ORIGINAL string. Empty-width
 * matches are skipped (with a `lastIndex` bump) so a global regex cannot spin.
 */
export function findSecretShapeSpans(
  input: string,
  marker: string = FRIDAY_DEFAULT_SECRET_MARKER,
): FridaySecretShapeSpan[] {
  const spans: FridaySecretShapeSpan[] = [];
  for (const { pattern, replacement } of buildSecretContentPatterns(marker)) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(input)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      const replaced =
        typeof replacement === "string"
          ? replacement
          : replacement(match[0], ...match.slice(1));
      spans.push({ start: match.index, end: match.index + match[0].length, replacement: replaced });
    }
  }
  return spans;
}
