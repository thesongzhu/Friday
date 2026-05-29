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

function findMatches(content: string): FridayMemoryGuardPiiMatch[] {
  const matches: FridayMemoryGuardPiiMatch[] = [];

  for (const pattern of PII_PATTERNS) {
    // Reset regex state since they have global flag
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      // For credit card matches, validate with Luhn algorithm
      if (pattern.type === "credit_card") {
        const digits = match[0].replace(/[^0-9]/g, "");
        if (digits.length < 13 || digits.length > 19 || !luhnCheck(digits)) {
          continue;
        }
        if (isCreditCardIdentifierFalsePositive(content, match)) {
          continue;
        }
      }

      matches.push({
        type: pattern.type,
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  // Sort by start position for deterministic ordering
  matches.sort((a, b) => a.start - b.start);
  return matches;
}

function redactContent(content: string, matches: FridayMemoryGuardPiiMatch[]): string {
  if (matches.length === 0) return content;

  // Process matches from end to start to preserve indices
  const sorted = [...matches].sort((a, b) => b.start - a.start);
  let result = content;
  for (const m of sorted) {
    const redacted = `[${m.type.toUpperCase()}]`;
    result = result.substring(0, m.start) + redacted + result.substring(m.end);
  }
  return result;
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
      const MAX_DEPTH = 6;

      const walk = (v: unknown, depth: number): unknown => {
        if (depth > MAX_DEPTH) return v;
        if (typeof v === "string") {
          const matches = findMatches(v);
          if (matches.length === 0) return v;
          for (const m of matches) {
            tagSet.add(`${FRIDAY_MEMORY_GUARD_PII_TAG_PREFIX}.${m.type}`);
          }
          return effectiveMode === "redact" ? redactContent(v, matches) : v;
        }
        if (Array.isArray(v)) {
          return v.map((entry) => walk(entry, depth + 1));
        }
        if (v && typeof v === "object") {
          const out: Record<string, unknown> = {};
          for (const [k, entry] of Object.entries(v as Record<string, unknown>)) {
            out[k] = walk(entry, depth + 1);
          }
          return out;
        }
        return v;
      };

      return { value: walk(value, 0), tagsToAdd: [...tagSet] };
    },
  };
}
