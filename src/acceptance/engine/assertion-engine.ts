/**
 * Assertion Engine — evaluate acceptance assertions against artifact content.
 *
 * Supports built-in assertion types:
 * - Schema validation (JSON Schema draft 2020-12 subset)
 * - Quantitative threshold comparisons
 * - Quality dimension scoring
 * - Custom handler delegation
 *
 * Each assertion evaluator produces a {@link FridayAcceptanceVerdict}
 * with structured evidence explaining the outcome.
 *
 * @module acceptance/engine
 */

import * as vm from "node:vm";

import type {
  FridayAcceptanceCheckConfig,
  FridayAcceptanceCustomCheckConfig,
  FridayAcceptanceEvidence,
  FridayAcceptanceQualityCheckConfig,
  FridayAcceptanceQualityDimension,
  FridayAcceptanceQuantCheckConfig,
  FridayAcceptanceSchemaCheckConfig,
  FridayAcceptanceSeverity,
  FridayAcceptanceVerdict,
  FridayAcceptanceVerdictOutcome,
} from "../model/friday-acceptance.types.js";

import type { JsonObject, JsonValue, UUID } from "../../rules/model/friday-rules-engine.types.js";

// ─── Custom Handler Registry ───

/**
 * Signature for custom assertion handlers.
 * Receives artifact content and handler configuration, returns a verdict.
 */
export type CustomAssertionHandler = (
  content: JsonValue,
  config?: JsonObject,
) => FridayAcceptanceVerdict;

/** Internal registry mapping handler references to implementations. */
const customHandlers = new Map<string, CustomAssertionHandler>();
const SANDBOX_TIMEOUT_MS = 250;

/**
 * Register a custom assertion handler.
 *
 * @param handlerRef - Unique handler identifier.
 * @param handler - Handler implementation.
 */
export function registerCustomHandler(
  handlerRef: string,
  handler: CustomAssertionHandler,
): void {
  customHandlers.set(handlerRef, handler);
}

/**
 * Unregister a custom assertion handler.
 *
 * @param handlerRef - Handler identifier to remove.
 * @returns `true` if the handler was found and removed.
 */
export function unregisterCustomHandler(handlerRef: string): boolean {
  return customHandlers.delete(handlerRef);
}

/**
 * Clear all registered custom handlers. Primarily for testing.
 */
export function clearCustomHandlers(): void {
  customHandlers.clear();
}

// ─── JSON Path Resolver ───

/**
 * Resolve a dot-separated JSON path against a value.
 * Supports array index notation (e.g., "items.0.name").
 *
 * @param value - Root value to traverse.
 * @param path - Dot-separated path string.
 * @returns The resolved value, or `undefined` if the path is invalid.
 */
export function resolveJsonPath(value: JsonValue, path: string): JsonValue | undefined {
  const segments = path.split(".");
  let current: JsonValue | undefined = value;

  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;

    if (typeof current === "object" && !Array.isArray(current)) {
      current = (current as JsonObject)[segment];
    } else if (Array.isArray(current)) {
      const index = Number(segment);
      if (Number.isNaN(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else {
      return undefined;
    }
  }

  return current;
}

// ─── Schema Validation ───

/**
 * Validate a JSON value against a JSON Schema (lightweight subset).
 *
 * Supports: type, required, properties, items, enum, minimum, maximum,
 * minLength, maxLength, pattern, minItems, maxItems.
 *
 * @returns Array of validation error messages. Empty array means valid.
 */
function validateSchema(value: JsonValue, schema: JsonObject, path: string = ""): string[] {
  const errors: string[] = [];
  const prefix = path ? `${path}: ` : "";

  // type check
  if (schema["type"] !== undefined) {
    const expectedType = schema["type"] as string;
    if (!matchesType(value, expectedType)) {
      errors.push(`${prefix}expected type "${expectedType}", got "${actualType(value)}"`);
      return errors; // short-circuit on type mismatch
    }
  }

  // enum check
  if (schema["enum"] !== undefined) {
    const enumValues = schema["enum"] as JsonValue[];
    if (!enumValues.some((e) => deepEqual(e, value))) {
      errors.push(`${prefix}value must be one of: ${JSON.stringify(enumValues)}`);
    }
  }

  // string checks
  if (typeof value === "string") {
    if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) {
      errors.push(`${prefix}string length ${value.length} is below minimum ${schema["minLength"]}`);
    }
    if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"]) {
      errors.push(`${prefix}string length ${value.length} exceeds maximum ${schema["maxLength"]}`);
    }
    if (typeof schema["pattern"] === "string") {
      const regex = new RegExp(schema["pattern"] as string);
      if (!regex.test(value)) {
        errors.push(`${prefix}string does not match pattern "${schema["pattern"]}"`);
      }
    }
  }

  // number checks
  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) {
      errors.push(`${prefix}value ${value} is below minimum ${schema["minimum"]}`);
    }
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) {
      errors.push(`${prefix}value ${value} exceeds maximum ${schema["maximum"]}`);
    }
  }

  // array checks
  if (Array.isArray(value)) {
    if (typeof schema["minItems"] === "number" && value.length < (schema["minItems"] as number)) {
      errors.push(`${prefix}array length ${value.length} is below minimum ${schema["minItems"]}`);
    }
    if (typeof schema["maxItems"] === "number" && value.length > (schema["maxItems"] as number)) {
      errors.push(`${prefix}array length ${value.length} exceeds maximum ${schema["maxItems"]}`);
    }
    if (schema["items"] !== undefined) {
      const itemSchema = schema["items"] as JsonObject;
      for (let i = 0; i < value.length; i++) {
        errors.push(...validateSchema(value[i], itemSchema, `${path}[${i}]`));
      }
    }
  }

  // object checks
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as JsonObject;

    if (schema["required"] !== undefined) {
      const required = schema["required"] as string[];
      for (const key of required) {
        if (!(key in obj)) {
          errors.push(`${prefix}missing required property "${key}"`);
        }
      }
    }

    if (schema["properties"] !== undefined) {
      const props = schema["properties"] as JsonObject;
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in obj) {
          errors.push(...validateSchema(obj[key], propSchema as JsonObject, path ? `${path}.${key}` : key));
        }
      }
    }
  }

  return errors;
}

/** Check if a value matches a JSON Schema type string. */
function matchesType(value: JsonValue, type: string): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    default: return true;
  }
}

/** Get the actual type name of a JSON value. */
function actualType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Deep equality check for JSON values. */
function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keysA = Object.keys(a as JsonObject);
    const keysB = Object.keys(b as JsonObject);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => deepEqual((a as JsonObject)[key], (b as JsonObject)[key]));
  }

  return false;
}

// ─── Quality Scoring ───

/**
 * Score an artifact on a quality dimension (0–100).
 * Uses deterministic heuristics (no ML).
 */
function scoreQualityDimension(content: JsonValue, dimension: FridayAcceptanceQualityDimension): number {
  switch (dimension) {
    case "completeness": return scoreCompleteness(content);
    case "consistency": return scoreConsistency(content);
    case "validity": return scoreValidity(content);
    case "readability": return scoreReadability(content);
  }
}

/** Completeness: non-null fields ratio for objects, non-empty for strings/arrays. */
function scoreCompleteness(content: JsonValue): number {
  if (content === null || content === undefined) return 0;

  if (typeof content === "string") {
    return content.trim().length > 0 ? 100 : 0;
  }

  if (Array.isArray(content)) {
    if (content.length === 0) return 0;
    const nonNull = content.filter((item) => item !== null && item !== undefined).length;
    return Math.round((nonNull / content.length) * 100);
  }

  if (typeof content === "object") {
    const obj = content as JsonObject;
    const keys = Object.keys(obj);
    if (keys.length === 0) return 0;
    const nonNull = keys.filter((k) => obj[k] !== null && obj[k] !== undefined).length;
    return Math.round((nonNull / keys.length) * 100);
  }

  // Primitives (number, boolean) are complete if they exist.
  return 100;
}

/** Consistency: for objects, checks that sibling values have consistent types. */
function scoreConsistency(content: JsonValue): number {
  if (content === null || content === undefined) return 0;

  if (Array.isArray(content)) {
    if (content.length <= 1) return 100;
    const types = content.map(actualType);
    const dominant = mode(types);
    const consistent = types.filter((t) => t === dominant).length;
    return Math.round((consistent / types.length) * 100);
  }

  if (typeof content === "object") {
    const obj = content as JsonObject;
    const keys = Object.keys(obj);
    if (keys.length <= 1) return 100;
    // Check that all values exist (no undefined/null mixing)
    const values = keys.map((k) => obj[k]);
    const nonNull = values.filter((v) => v !== null && v !== undefined).length;
    return Math.round((nonNull / values.length) * 100);
  }

  return 100;
}

/** Validity: structural validity check. */
function scoreValidity(content: JsonValue): number {
  if (content === null || content === undefined) return 0;

  if (typeof content === "string") {
    // Non-empty, trimmed string is valid.
    const trimmed = content.trim();
    if (trimmed.length === 0) return 0;
    // Check for control characters (excluding common whitespace).
    const controlChars = trimmed.replace(/[\n\r\t]/g, "").match(/[\x00-\x1f]/g);
    return controlChars ? Math.max(0, 100 - controlChars.length * 10) : 100;
  }

  if (Array.isArray(content)) {
    return content.length > 0 ? 100 : 50;
  }

  if (typeof content === "object") {
    const keys = Object.keys(content as JsonObject);
    return keys.length > 0 ? 100 : 50;
  }

  return 100;
}

/** Readability: for strings, measure sentence length and vocabulary diversity. */
function scoreReadability(content: JsonValue): number {
  if (typeof content !== "string") return 50;

  const text = content.trim();
  if (text.length === 0) return 0;

  // Sentence count heuristic.
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const words = text.split(/\s+/).filter((w) => w.length > 0);

  if (words.length === 0) return 0;

  // Average words per sentence (ideal: 10-25 words).
  const avgWordsPerSentence = sentences.length > 0 ? words.length / sentences.length : words.length;
  let sentenceScore: number;
  if (avgWordsPerSentence >= 10 && avgWordsPerSentence <= 25) {
    sentenceScore = 100;
  } else if (avgWordsPerSentence < 5 || avgWordsPerSentence > 40) {
    sentenceScore = 40;
  } else {
    sentenceScore = 70;
  }

  // Vocabulary diversity: unique words / total words.
  const uniqueWords = new Set(words.map((w) => w.toLowerCase()));
  const diversityScore = Math.round((uniqueWords.size / words.length) * 100);

  return Math.round((sentenceScore + diversityScore) / 2);
}

/** Find the most common element in an array. */
function mode(arr: string[]): string {
  const freq = new Map<string, number>();
  for (const item of arr) {
    freq.set(item, (freq.get(item) ?? 0) + 1);
  }
  let maxCount = 0;
  let result = arr[0];
  for (const [item, count] of freq) {
    if (count > maxCount) {
      maxCount = count;
      result = item;
    }
  }
  return result;
}

// ─── Assertion Evaluators ───

/** Evaluate a schema assertion. */
function evaluateSchemaAssertion(
  checkId: UUID,
  content: JsonValue,
  config: FridayAcceptanceSchemaCheckConfig,
): FridayAcceptanceVerdict {
  const errors = validateSchema(content, config.schema);

  if (errors.length === 0) {
    return {
      verdict: "pass",
      severity: "info",
      evidence: [{
        checkId,
        checkType: "schema",
        message: "Artifact passes schema validation",
        expected: config.schema,
        actual: content,
      }],
    };
  }

  return {
    verdict: "fail",
    severity: config.strict ? "critical" : "major",
    evidence: [{
      checkId,
      checkType: "schema",
      message: `Schema validation failed with ${errors.length} error(s): ${errors.join("; ")}`,
      expected: config.schema,
      actual: errors as JsonValue,
    }],
  };
}

/** Evaluate a quantitative assertion. */
function evaluateQuantitativeAssertion(
  checkId: UUID,
  content: JsonValue,
  config: FridayAcceptanceQuantCheckConfig,
): FridayAcceptanceVerdict {
  const rawValue = resolveJsonPath(content, config.metricPath);

  if (rawValue === undefined || typeof rawValue !== "number") {
    return {
      verdict: "fail",
      severity: "major",
      evidence: [{
        checkId,
        checkType: "quantitative",
        message: `Metric path "${config.metricPath}" did not resolve to a number`,
        expected: config.metricPath,
        actual: rawValue ?? null,
      }],
    };
  }

  const value = rawValue;
  let passes: boolean;

  if (config.operator === "between") {
    passes = value >= config.lowerBound && value <= config.upperBound;
  } else {
    switch (config.operator) {
      case "gt": passes = value > config.threshold; break;
      case "gte": passes = value >= config.threshold; break;
      case "lt": passes = value < config.threshold; break;
      case "lte": passes = value <= config.threshold; break;
      case "eq": passes = value === config.threshold; break;
    }
  }

  // Check warn threshold.
  if (passes && config.warnThreshold !== undefined) {
    const nearWarn = Math.abs(value - config.warnThreshold) < Math.abs(value) * 0.1 || value === config.warnThreshold;
    if (nearWarn) {
      return {
        verdict: "warn",
        severity: "minor",
        evidence: [{
          checkId,
          checkType: "quantitative",
          message: `Metric "${config.metricPath}" = ${value} is near warn threshold ${config.warnThreshold}`,
          expected: formatQuantExpectation(config),
          actual: value,
        }],
      };
    }
  }

  if (passes) {
    return {
      verdict: "pass",
      severity: "info",
      evidence: [{
        checkId,
        checkType: "quantitative",
        message: `Metric "${config.metricPath}" = ${value} satisfies ${formatQuantExpectation(config)}`,
        expected: formatQuantExpectation(config),
        actual: value,
      }],
    };
  }

  return {
    verdict: "fail",
    severity: "major",
    evidence: [{
      checkId,
      checkType: "quantitative",
      message: `Metric "${config.metricPath}" = ${value} does not satisfy ${formatQuantExpectation(config)}`,
      expected: formatQuantExpectation(config),
      actual: value,
    }],
  };
}

/** Format a human-readable quantitative expectation. */
function formatQuantExpectation(config: FridayAcceptanceQuantCheckConfig): string {
  if (config.operator === "between") {
    return `between [${config.lowerBound}, ${config.upperBound}]`;
  }
  return `${config.operator} ${config.threshold}`;
}

/** Evaluate a quality assertion. */
function evaluateQualityAssertion(
  checkId: UUID,
  content: JsonValue,
  config: FridayAcceptanceQualityCheckConfig,
): FridayAcceptanceVerdict {
  const score = scoreQualityDimension(content, config.dimension);

  if (score >= config.minScore) {
    return {
      verdict: "pass",
      severity: "info",
      evidence: [{
        checkId,
        checkType: "quality",
        message: `Quality dimension "${config.dimension}" scored ${score} (minimum: ${config.minScore})`,
        expected: config.minScore,
        actual: score,
        metadata: { dimension: config.dimension },
      }],
    };
  }

  if (config.warnScore !== undefined && score >= config.warnScore) {
    return {
      verdict: "warn",
      severity: "minor",
      evidence: [{
        checkId,
        checkType: "quality",
        message: `Quality dimension "${config.dimension}" scored ${score} (warn threshold: ${config.warnScore}, minimum: ${config.minScore})`,
        expected: config.minScore,
        actual: score,
        metadata: { dimension: config.dimension, warnScore: config.warnScore },
      }],
    };
  }

  return {
    verdict: "fail",
    severity: "major",
    evidence: [{
      checkId,
      checkType: "quality",
      message: `Quality dimension "${config.dimension}" scored ${score}, below minimum ${config.minScore}`,
      expected: config.minScore,
      actual: score,
      metadata: { dimension: config.dimension },
    }],
  };
}

/** Evaluate a custom assertion. */
function evaluateCustomAssertion(
  checkId: UUID,
  content: JsonValue,
  config: FridayAcceptanceCustomCheckConfig,
): FridayAcceptanceVerdict {
  const handler = customHandlers.get(config.handlerRef);

  if (!handler) {
    const script = typeof config.handlerConfig?.script === "string"
      ? config.handlerConfig.script
      : undefined;
    if (script) {
      try {
        return executeSandboxedCustomAssertion(checkId, content, config, script);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          verdict: "fail",
          severity: "critical",
          evidence: [{
            checkId,
            checkType: "custom",
            message: `Sandboxed custom check failed: ${message}`,
            expected: config.handlerRef,
            actual: null,
            metadata: { error: message },
          }],
        };
      }
    }

    return {
      verdict: "fail",
      severity: "critical",
      evidence: [{
        checkId,
        checkType: "custom",
        message: `Custom handler "${config.handlerRef}" not found`,
        expected: config.handlerRef,
        actual: null,
      }],
    };
  }

  try {
    return handler(content, config.handlerConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      verdict: "fail",
      severity: "critical",
      evidence: [{
        checkId,
        checkType: "custom",
        message: `Custom handler "${config.handlerRef}" threw an error: ${message}`,
        expected: config.handlerRef,
        actual: null,
        metadata: { error: message },
      }],
    };
  }
}

function executeSandboxedCustomAssertion(
  checkId: UUID,
  content: JsonValue,
  config: FridayAcceptanceCustomCheckConfig,
  scriptSource: string,
): FridayAcceptanceVerdict {
  const wrapped = [
    "(function () {",
    "\"use strict\";",
    "const result = (() => {",
    scriptSource,
    "})();",
    "return result;",
    "})()",
  ].join("\n");
  const sandbox = {
    content,
    config: config.handlerConfig ?? {},
    Math,
    JSON,
  };
  const script = new vm.Script(wrapped, {
    filename: `friday-acceptance-custom-${config.handlerRef}.vm.js`,
  });
  const result = script.runInNewContext(sandbox, {
    timeout: SANDBOX_TIMEOUT_MS,
  }) as Partial<FridayAcceptanceVerdict> | undefined;

  if (!result || typeof result !== "object") {
    throw new Error("Sandboxed custom check must return a verdict object");
  }

  const verdict = result.verdict;
  const severity = result.severity;
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "warn") {
    throw new Error("Sandboxed custom check returned an invalid verdict");
  }
  if (severity !== "critical" && severity !== "major" && severity !== "minor" && severity !== "info") {
    throw new Error("Sandboxed custom check returned an invalid severity");
  }

  const evidence = Array.isArray(result.evidence)
    ? result.evidence.map((entry) => ({
      checkId,
      checkType: "custom" as const,
      message: typeof entry?.message === "string" ? entry.message : "Sandboxed custom check emitted evidence",
      expected: (entry as FridayAcceptanceEvidence | undefined)?.expected,
      actual: (entry as FridayAcceptanceEvidence | undefined)?.actual,
      metadata: {
        ...(typeof (entry as FridayAcceptanceEvidence | undefined)?.metadata === "object"
          && (entry as FridayAcceptanceEvidence | undefined)?.metadata !== null
          ? (entry as FridayAcceptanceEvidence).metadata
          : {}),
        sandboxed: true,
      },
    }))
    : [{
      checkId,
      checkType: "custom" as const,
      message: `Sandboxed custom check "${config.handlerRef}" completed`,
      expected: config.handlerRef,
      actual: verdict,
      metadata: { sandboxed: true },
    }];

  return {
    verdict,
    severity,
    evidence,
  };
}

// ─── Main Assertion Engine ───

/**
 * Evaluate a single acceptance assertion against artifact content.
 *
 * Routes to the appropriate evaluator based on the check config's `checkType`.
 *
 * @param checkId - Unique check identifier for evidence tracking.
 * @param content - Artifact content to evaluate.
 * @param config - Check configuration defining the assertion.
 * @returns Verdict with evidence chain.
 */
export function evaluateAssertion(
  checkId: UUID,
  content: JsonValue,
  config: FridayAcceptanceCheckConfig,
): FridayAcceptanceVerdict {
  switch (config.checkType) {
    case "schema":
      return evaluateSchemaAssertion(checkId, content, config);
    case "quantitative":
      return evaluateQuantitativeAssertion(checkId, content, config);
    case "quality":
      return evaluateQualityAssertion(checkId, content, config);
    case "custom":
      return evaluateCustomAssertion(checkId, content, config);
  }
}

// ─── Exported Utilities ───

export { validateSchema, scoreQualityDimension, deepEqual };
