/**
 * Context Redactor — redacts sensitive fields from evaluation context
 * before persisting to the audit log.
 *
 * @module rules/engine
 */

import type {
  ContextRedactionRules,
  JsonObject,
  JsonValue,
} from "../model/friday-rules-engine.types.js";

// ─── Constants ───

/** Default key pattern for fields that should be redacted. */
const DEFAULT_SENSITIVE_KEY_PATTERN =
  /^.*(password|passphrase|secret|token|authorization|cookie|api[_-]?key|credential).*$/i;

/** Default sensitive key names (case-insensitive). */
const DEFAULT_SENSITIVE_KEYS = [
  "password",
  "passphrase",
  "secret",
  "token",
  "authorization",
  "cookie",
  "api_key",
  "apikey",
  "credential",
];

/** Replacement value for redacted fields. */
const DEFAULT_REDACTED_VALUE = "[REDACTED]";

/** Maximum length for non-redacted string values. */
const DEFAULT_MAX_STRING_LENGTH = 256;

interface NormalizedRedactionRules {
  readonly sensitiveKeys: ReadonlySet<string>;
  readonly sensitiveKeyPatterns: readonly RegExp[];
  readonly sensitivePaths: ReadonlySet<string>;
  readonly replacement: string;
  readonly maxStringLength: number;
}

// ─── Redaction Result ───

export interface RedactionResult {
  /** The redacted context object. */
  redacted: JsonObject;
  /** Whether any redaction was applied. */
  redactionApplied: boolean;
  /** List of field paths that were redacted. */
  redactedFields: string[];
}

// ─── Public API ───

/** Redact sensitive fields from a JSON object. */
export function redactContext(
  context: JsonObject,
  rules?: ContextRedactionRules,
): RedactionResult {
  const normalizedRules = normalizeRedactionRules(rules);
  const redactedFields: string[] = [];
  const redacted = redactObject(context, "", redactedFields, normalizedRules);
  return {
    redacted,
    redactionApplied: redactedFields.length > 0,
    redactedFields,
  };
}

// ─── Internal ───

function normalizeRedactionRules(rules?: ContextRedactionRules): NormalizedRedactionRules {
  const sensitiveKeys = new Set(DEFAULT_SENSITIVE_KEYS.map((key) => key.toLowerCase()));
  if (rules?.sensitiveKeys) {
    for (const key of rules.sensitiveKeys) {
      sensitiveKeys.add(key.toLowerCase());
    }
  }

  const sensitiveKeyPatterns: RegExp[] = [DEFAULT_SENSITIVE_KEY_PATTERN];
  if (rules?.sensitiveKeyPatterns) {
    for (const pattern of rules.sensitiveKeyPatterns) {
      sensitiveKeyPatterns.push(new RegExp(pattern, "i"));
    }
  }

  const sensitivePaths = new Set(rules?.sensitivePaths ?? []);

  const configuredMaxStringLength = rules?.maxStringLength;
  let maxStringLength = DEFAULT_MAX_STRING_LENGTH;
  if (
    configuredMaxStringLength !== undefined
    && Number.isInteger(configuredMaxStringLength)
    && configuredMaxStringLength >= 0
  ) {
    maxStringLength = configuredMaxStringLength;
  }

  return {
    sensitiveKeys,
    sensitiveKeyPatterns,
    sensitivePaths,
    replacement: rules?.replacement ?? DEFAULT_REDACTED_VALUE,
    maxStringLength,
  };
}

/** Recursively redact an object. */
function redactObject(
  obj: JsonObject,
  prefix: string,
  redactedFields: string[],
  rules: NormalizedRedactionRules,
): JsonObject {
  const result: JsonObject = {};

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (shouldRedact(path, key, rules)) {
      result[key] = rules.replacement;
      recordRedactedField(redactedFields, path);
      continue;
    }

    result[key] = redactValue(value, path, redactedFields, rules);
  }

  return result;
}

/** Redact a single value (recursive for objects/arrays). */
function redactValue(
  value: JsonValue,
  path: string,
  redactedFields: string[],
  rules: NormalizedRedactionRules,
): JsonValue {
  if (rules.sensitivePaths.has(path)) {
    recordRedactedField(redactedFields, path);
    return rules.replacement;
  }

  if (value === null) return null;

  if (typeof value === "string") {
    return value.length > rules.maxStringLength
      ? value.slice(0, rules.maxStringLength) + "…"
      : value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, `${path}[${index}]`, redactedFields, rules));
  }

  if (typeof value === "object") {
    return redactObject(value as JsonObject, path, redactedFields, rules);
  }

  return value;
}

function shouldRedact(path: string, key: string, rules: NormalizedRedactionRules): boolean {
  if (rules.sensitivePaths.has(path)) return true;

  const loweredKey = key.toLowerCase();
  if (rules.sensitiveKeys.has(loweredKey)) {
    return true;
  }

  return rules.sensitiveKeyPatterns.some((pattern) => pattern.test(key));
}

function recordRedactedField(redactedFields: string[], path: string): void {
  if (!redactedFields.includes(path)) {
    redactedFields.push(path);
  }
}
