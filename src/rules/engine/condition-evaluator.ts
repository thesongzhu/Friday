import { FridayDomainError } from "#errors";

/**
 * Condition Evaluator — evaluates rule conditions against an evaluation context.
 *
 * Deterministic: same input always produces the same output.
 * Lazy short-circuit on `all` groups (fail-fast) and `any` groups (pass-fast).
 *
 * @module rules/engine
 */

import type {
  FridayEvaluationContext,
  FridayRuleCondition,
  FridayRuleConditionGroup,
  JsonObject,
  JsonValue,
} from "../model/friday-rules-engine.types.js";

import type {
  FridayRuleConditionOperator,
} from "../model/friday-rules-engine.types.js";

// ─── Regex Precompilation ───

const MAX_REGEX_CACHE_ENTRIES = 1000;
const MAX_REGEX_PATTERN_LENGTH = 512;
const precompiledRegexCache: Map<string, RegExp> = new Map();
const FORBIDDEN_FIELD_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Detect common ReDoS-vulnerable patterns:
 * - Nested quantifiers: (a+)+, (a*)+, (a+)*, (a{2,})+
 * - Overlapping alternation with quantifiers: (a|a)+
 *
 * This is a heuristic check — it catches the most common dangerous
 * constructs without requiring an external library.
 */
const REDOS_NESTED_QUANTIFIER_RE = /[+*}]\s*\)[\s)]*[+*?{]/;
const REDOS_STAR_PLUS_ALTERNATION_RE = /\([^)]*\|[^)]*\)[+*]{1}/;
// P2-SEC: Additional ReDoS heuristics for broader coverage
const REDOS_LOOKAHEAD_QUANTIFIER_RE = /\(\?[=!][^)]*[+*]\)/; // Quantifier inside lookahead
const REDOS_REPETITION_OVERLAP_RE = /\[[^\]]*\]\+[^?][^\[]*\[[^\]]*\]\+/; // Adjacent char-class quantifiers
const REDOS_DEEP_NESTING_RE = /\({3,}/; // Deeply nested groups (3+ levels)

function isUnsafeRegexPattern(pattern: string): boolean {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return true;
  if (REDOS_NESTED_QUANTIFIER_RE.test(pattern)) return true;
  if (REDOS_STAR_PLUS_ALTERNATION_RE.test(pattern)) return true;
  if (REDOS_LOOKAHEAD_QUANTIFIER_RE.test(pattern)) return true;
  if (REDOS_REPETITION_OVERLAP_RE.test(pattern)) return true;
  if (REDOS_DEEP_NESTING_RE.test(pattern)) return true;
  return false;
}

/**
 * Precompile a regex pattern once and cache it for hot-path reuse.
 * Throws if the pattern is invalid.
 */
export function precompileRegexPattern(pattern: string): RegExp {
  const cached = precompiledRegexCache.get(pattern);
  if (cached) {
    // Map insertion order lets us implement LRU by re-inserting on access.
    precompiledRegexCache.delete(pattern);
    precompiledRegexCache.set(pattern, cached);
    return cached;
  }

  if (isUnsafeRegexPattern(pattern)) {
    throw new FridayDomainError("VALIDATION_ERROR", `Regex pattern rejected: potentially unsafe (ReDoS risk or exceeds max length ${String(MAX_REGEX_PATTERN_LENGTH)})`, { httpStatus: 400 });
  }

  const compiled = new RegExp(pattern);
  if (precompiledRegexCache.size >= MAX_REGEX_CACHE_ENTRIES) {
    const leastRecentlyUsedKey = precompiledRegexCache.keys().next().value;
    if (leastRecentlyUsedKey !== undefined) {
      precompiledRegexCache.delete(leastRecentlyUsedKey);
    }
  }
  precompiledRegexCache.set(pattern, compiled);
  return compiled;
}

/** Clear all cached compiled regex patterns (primarily for tests). */
export function clearCache(): void {
  precompiledRegexCache.clear();
}

/**
 * Precompile all regex conditions in a condition group.
 * Intended for parse/load time to keep evaluation allocation-free.
 */
export function precompileConditionGroupRegex(group: FridayRuleConditionGroup): void {
  for (const conditionList of [group.all, group.any, group.none]) {
    if (!conditionList) continue;
    for (const condition of conditionList) {
      if (condition.operator === "matches" && typeof condition.value === "string") {
        precompileRegexPattern(condition.value);
      }
    }
  }
}

// ─── Field Resolution ───

/**
 * Resolve a dot-separated field path against the evaluation context.
 * Supports paths like "args.command", "metadata.user.role", "resource".
 */
export function resolveField(context: FridayEvaluationContext, field: string): JsonValue | undefined {
  const parts = field.split(".");
  let current: unknown = context;

  for (const part of parts) {
    if (FORBIDDEN_FIELD_SEGMENTS.has(part)) {
      return undefined;
    }
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    const container = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(container, part)) {
      return undefined;
    }
    current = container[part];
  }

  return current as JsonValue | undefined;
}

// ─── Operator Evaluation ───

/**
 * Evaluate a single operator against a resolved field value and a condition value.
 * Returns true if the condition is satisfied.
 */
export function evaluateOperator(
  operator: FridayRuleConditionOperator,
  fieldValue: JsonValue | undefined,
  conditionValue: JsonValue | undefined,
): boolean {
  switch (operator) {
    case "exists":
      return fieldValue !== undefined && fieldValue !== null;

    case "not_exists":
      return fieldValue === undefined || fieldValue === null;

    case "equals":
      return fieldValue === conditionValue;

    case "not_equals":
      return fieldValue !== conditionValue;

    case "contains":
      if (typeof fieldValue !== "string" || typeof conditionValue !== "string") return false;
      return fieldValue.includes(conditionValue);

    case "matches":
      return evaluateRegex(fieldValue, conditionValue);

    case "in":
      return evaluateIn(fieldValue, conditionValue);

    case "not_in":
      return !evaluateIn(fieldValue, conditionValue);

    case "gt":
      return compareNumeric(fieldValue, conditionValue, (a, b) => a > b);

    case "gte":
      return compareNumeric(fieldValue, conditionValue, (a, b) => a >= b);

    case "lt":
      return compareNumeric(fieldValue, conditionValue, (a, b) => a < b);

    case "lte":
      return compareNumeric(fieldValue, conditionValue, (a, b) => a <= b);

    default:
      return false;
  }
}

/** Test a field value against a regex pattern. */
function evaluateRegex(fieldValue: JsonValue | undefined, pattern: JsonValue | undefined): boolean {
  if (typeof fieldValue !== "string" || typeof pattern !== "string") return false;
  try {
    return precompileRegexPattern(pattern).test(fieldValue);
  } catch (err) {
    // Invalid regex — treated as non-match at evaluation time.
    // Validation should catch this at rule creation/import time.
    console.warn("[friday][condition-evaluator] regex evaluation failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Test whether a field value is in an array of allowed values. */
function evaluateIn(fieldValue: JsonValue | undefined, conditionValue: JsonValue | undefined): boolean {
  if (!Array.isArray(conditionValue)) return false;
  if (fieldValue === undefined) return false;
  return conditionValue.includes(fieldValue);
}

/** Compare two values numerically. */
function compareNumeric(
  fieldValue: JsonValue | undefined,
  conditionValue: JsonValue | undefined,
  comparator: (a: number, b: number) => boolean,
): boolean {
  if (typeof fieldValue !== "number" || typeof conditionValue !== "number") return false;
  return comparator(fieldValue, conditionValue);
}

// ─── Condition Evaluation ───

/** Evaluate a single condition against the evaluation context. */
export function evaluateCondition(context: FridayEvaluationContext, condition: FridayRuleCondition): boolean {
  const fieldValue = resolveField(context, condition.field);
  const conditionValue: JsonValue | undefined = "value" in condition ? condition.value : undefined;
  return evaluateOperator(condition.operator, fieldValue, conditionValue);
}

/**
 * Evaluate a condition group against the evaluation context.
 *
 * - `all`: every condition must match (AND). Short-circuits on first failure.
 * - `any`: at least one condition must match (OR). Short-circuits on first success.
 * - `none`: no condition may match (NOT ANY).
 *
 * An empty or undefined group matches all contexts (vacuous truth).
 */
export function evaluateConditionGroup(
  context: FridayEvaluationContext,
  group: FridayRuleConditionGroup,
): boolean {
  const hasAll = group.all !== undefined && group.all.length > 0;
  const hasAny = group.any !== undefined && group.any.length > 0;
  const hasNone = group.none !== undefined && group.none.length > 0;

  // Empty group matches everything (rule with no conditions).
  if (!hasAll && !hasAny && !hasNone) return true;

  // ALL: every condition must match.
  if (hasAll) {
    for (const condition of group.all!) {
      if (!evaluateCondition(context, condition)) return false;
    }
  }

  // ANY: at least one condition must match.
  if (hasAny) {
    let anyMatched = false;
    for (const condition of group.any!) {
      if (evaluateCondition(context, condition)) {
        anyMatched = true;
        break;
      }
    }
    if (!anyMatched) return false;
  }

  // NONE: no condition may match.
  if (hasNone) {
    for (const condition of group.none!) {
      if (evaluateCondition(context, condition)) return false;
    }
  }

  return true;
}
