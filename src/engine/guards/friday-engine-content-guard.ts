/**
 * Content Guard — Initiative F.3
 *
 * Scans tool results for PII before returning them to the LLM.
 * Reuses the PII detection patterns from the memory guard module.
 *
 * Policy:
 * - Detected PII is redacted (replaced with [REDACTED])
 * - The guard does NOT block tool results — it sanitizes them
 * - A flag is returned indicating whether redaction occurred
 */

// ─── PII patterns (aligned with memory guard) ───

const PII_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    replacement: "[EMAIL_REDACTED]",
  },
  {
    name: "us_phone",
    pattern: /\b(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    replacement: "[PHONE_REDACTED]",
  },
  {
    name: "us_ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[SSN_REDACTED]",
  },
  {
    name: "credit_card",
    pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    replacement: "[CARD_REDACTED]",
  },
  {
    name: "api_key_like",
    // Matches common API key patterns: sk-..., ak_..., key-...
    pattern: /\b(?:sk|ak|pk|rk|key)[-_][A-Za-z0-9]{20,}\b/g,
    replacement: "[KEY_REDACTED]",
  },
];

// ─── Types ───

export interface FridayContentGuardResult {
  /** Sanitized content (may be same as input if no PII found). */
  content: string;
  /** Whether any redaction was applied. */
  redacted: boolean;
  /** Names of PII types that were redacted. */
  redactedTypes: string[];
}

export type FridayContentGuardMode = "redact" | "flag_only" | "disabled";

export interface FridayContentGuardOptions {
  /** Guard mode. Default: "redact". */
  mode?: FridayContentGuardMode;
  /** Additional custom patterns to scan. */
  extraPatterns?: Array<{ name: string; pattern: RegExp; replacement: string }>;
}

// ─── Guard ───

export interface FridayContentGuard {
  /** Scan and optionally redact PII from content. */
  scan(content: string): FridayContentGuardResult;
}

export function createFridayContentGuard(
  options?: FridayContentGuardOptions,
): FridayContentGuard {
  const mode = options?.mode ?? "redact";
  const allPatterns = [...PII_PATTERNS, ...(options?.extraPatterns ?? [])];

  function scan(content: string): FridayContentGuardResult {
    if (mode === "disabled") {
      return { content, redacted: false, redactedTypes: [] };
    }

    const redactedTypes: string[] = [];
    let result = content;

    for (const { name, pattern, replacement } of allPatterns) {
      // Reset regex state for global patterns
      pattern.lastIndex = 0;
      if (pattern.test(result)) {
        redactedTypes.push(name);
        if (mode === "redact") {
          // Reset again before replace
          pattern.lastIndex = 0;
          result = result.replace(pattern, replacement);
        }
      }
    }

    return {
      content: result,
      redacted: redactedTypes.length > 0,
      redactedTypes,
    };
  }

  return { scan };
}
