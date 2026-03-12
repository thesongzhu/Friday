import {
  FRIDAY_MEMORY_GUARD_MAX_QUERY_CHARS,
  FRIDAY_MEMORY_GUARD_MAX_QUERY_TOKEN_LENGTH,
  FRIDAY_MEMORY_GUARD_MAX_QUERY_TOKENS,
} from "../friday-memory-guard.constants.js";

/**
 * Characters that are FTS5 operators or special syntax: AND OR NOT NEAR + * - " ^ { } ( ) :
 * We strip these to prevent injection. Only safe alphanumeric tokens remain.
 */
const FTS5_OPERATOR_RE = /\b(?:AND|OR|NOT|NEAR)\b/gi;
const FTS5_SPECIAL_CHARS_RE = /[+*\-"^{}():,]/g;

/**
 * Safe token: Unicode word characters only (letters, digits, underscore + common Unicode).
 */
const SAFE_TOKEN_RE = /^[\p{L}\p{N}_]+$/u;

/**
 * Sanitizes a query string for safe use with FTS5.
 * Returns an array of safe tokens joined by spaces (implicit OR in FTS5).
 * Returns null if no safe tokens remain after sanitization.
 */
export function sanitizeFridayMemoryQuery(raw: string): string | null {
  // Enforce max query length
  const trimmed = raw.slice(0, FRIDAY_MEMORY_GUARD_MAX_QUERY_CHARS).trim();
  if (!trimmed) return null;

  // Strip FTS5 operators and special chars
  let cleaned = trimmed.replace(FTS5_OPERATOR_RE, " ");
  cleaned = cleaned.replace(FTS5_SPECIAL_CHARS_RE, " ");

  // Split into candidate tokens
  const candidates = cleaned.split(/\s+/).filter(Boolean);

  // Filter to safe tokens only, enforce per-token and total token limits
  const safeTokens: string[] = [];
  for (const candidate of candidates) {
    if (safeTokens.length >= FRIDAY_MEMORY_GUARD_MAX_QUERY_TOKENS) break;

    const truncated = candidate.slice(0, FRIDAY_MEMORY_GUARD_MAX_QUERY_TOKEN_LENGTH);
    if (SAFE_TOKEN_RE.test(truncated)) {
      safeTokens.push(truncated);
    }
  }

  if (safeTokens.length === 0) return null;

  return safeTokens.join(" ");
}
