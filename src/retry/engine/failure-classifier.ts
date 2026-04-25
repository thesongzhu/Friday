/**
 * Failure Classifier — Categorizes raw execution failures into the
 * seven-category failure taxonomy.
 *
 * Classification follows a deterministic priority chain:
 *   1. Custom rules (highest priority)
 *   2. Retry hint from NodeRunner adapter
 *   3. HTTP status code
 *   4. Error code lookup
 *   5. Error message heuristic
 *   6. Default (unknown)
 *
 * When an error matches multiple categories, the priority order defined
 * in {@link FRIDAY_FAILURE_CATEGORY_PRIORITY} breaks the tie.
 *
 * @module retry/engine
 */

import type {
  FridayClassifiedFailure,
  FridayCustomClassificationRule,
  FridayFailureCategory,
  FridayFailureClass,
  FridayFailureClassificationSource,
  FridayFailureClassifier,
  FridayFailureSeverity,
} from "../model/friday-retry-engine.types.js";

import type { FridayRetryHint } from "../../node-runner/api/friday-node-runner-api.types.js";

import type { FridayClassifyFailureError } from "../api/friday-retry-api.types.js";
import type { FridayNodeExecutionResult } from "../../node-runner/model/friday-node-runner.types.js";

import type { ISODateTime, UUID } from "../../rules/model/friday-rules-engine.types.js";

import { FRIDAY_FAILURE_CATEGORY_PRIORITY } from "../model/friday-retry-engine.types.js";
import { precompileRegexPattern } from "../../rules/engine/condition-evaluator.js";

// ─── Failure Class Definitions ───

/**
 * Default failure class definitions for the seven taxonomy categories.
 * Each entry maps HTTP status codes, error codes, and message patterns
 * to a category with its default retry behavior.
 */
export const FAILURE_CLASS_DEFINITIONS: readonly FridayFailureClass[] = [
  {
    category: "rate_limit",
    description: "Rate-limited by upstream provider or API gateway",
    retryableByDefault: true,
    defaultSeverity: "minor",
    defaultMaxAttempts: 5,
    httpStatusCodes: [429],
    errorCodes: ["RATE_LIMIT", "RATE_LIMIT_EXCEEDED", "THROTTLED", "TOO_MANY_REQUESTS"],
    errorMessagePatterns: [
      "rate.?limit",
      "throttl",
      "too many requests",
      "quota exceeded",
    ],
  },
  {
    category: "timeout",
    description: "Execution or gateway timeout",
    retryableByDefault: true,
    defaultSeverity: "major",
    defaultMaxAttempts: 2,
    httpStatusCodes: [408, 504],
    errorCodes: [
      "NODE_EXECUTION_TIMEOUT",
      "NODE_TIMEOUT",
      "ETIMEDOUT",
      "ESOCKETTIMEDOUT",
    ],
    errorMessagePatterns: ["timeout", "timed.?out", "deadline exceeded"],
  },
  {
    category: "transient",
    description: "Temporary network or server errors",
    retryableByDefault: true,
    defaultSeverity: "minor",
    defaultMaxAttempts: 3,
    httpStatusCodes: [500, 502, 503],
    errorCodes: [
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EPIPE",
      "EAI_AGAIN",
      "NODE_INTERNAL_ERROR",
    ],
    errorMessagePatterns: [
      "network error",
      "connection reset",
      "connection refused",
      "dns resolution",
      "socket hang up",
      "econnreset",
      "internal server error",
      "service unavailable",
      "bad gateway",
    ],
  },
  {
    category: "resource",
    description: "Resource exhaustion (memory, disk, quota)",
    retryableByDefault: true,
    defaultSeverity: "major",
    defaultMaxAttempts: 2,
    httpStatusCodes: [507, 413],
    errorCodes: ["ENOMEM", "ENOSPC", "QUOTA_EXCEEDED"],
    errorMessagePatterns: [
      "out of memory",
      "disk full",
      "quota",
      "insufficient.?resources",
      "capacity",
      "storage",
    ],
  },
  {
    category: "auth",
    description: "Authentication or authorization failure",
    retryableByDefault: false,
    defaultSeverity: "critical",
    defaultMaxAttempts: 0,
    httpStatusCodes: [401, 403],
    errorCodes: [
      "NODE_PRE_RULES_DENIED",
      "NODE_POST_RULES_DENIED",
      "PRE_RULES_DENIED",
      "POST_RULES_DENIED",
    ],
    errorMessagePatterns: [
      "unauthorized",
      "forbidden",
      "auth",
      "token expired",
      "credential",
      "permission denied",
    ],
  },
  {
    category: "logic",
    description: "Application logic or validation errors",
    retryableByDefault: false,
    defaultSeverity: "major",
    defaultMaxAttempts: 0,
    httpStatusCodes: [400, 404, 405, 409, 422],
    errorCodes: [
      "NODE_VALIDATION_FAILED",
      "NODE_INPUT_SCHEMA_INVALID",
      "NODE_OUTPUT_SCHEMA_INVALID",
      "VALIDATION_FAILED",
    ],
    errorMessagePatterns: [
      "validation",
      "invalid input",
      "not found",
      "assertion",
      "schema",
    ],
  },
  {
    category: "unknown",
    description: "Unclassified failure",
    retryableByDefault: false,
    defaultSeverity: "info",
    defaultMaxAttempts: 1,
    httpStatusCodes: [],
    errorCodes: [],
    errorMessagePatterns: [],
  },
] as const;

// ─── Internal Helpers ───

/** Configuration for the failure classifier. */
export interface FailureClassifierConfig {
  /** Generate a new UUID for classification IDs. */
  generateId: () => UUID;
  /** Get the current ISO timestamp. */
  nowIso: () => ISODateTime;
}

/** A candidate classification with its priority for tie-breaking. */
interface ClassificationCandidate {
  category: FridayFailureCategory;
  severity: FridayFailureSeverity;
  source: FridayFailureClassificationSource;
  confidence: number;
}

/**
 * Get the priority index for a failure category.
 * Lower index means higher priority.
 */
function categoryPriority(category: FridayFailureCategory): number {
  const idx = FRIDAY_FAILURE_CATEGORY_PRIORITY.indexOf(category);
  return idx === -1 ? FRIDAY_FAILURE_CATEGORY_PRIORITY.length : idx;
}

/**
 * Select the highest-priority candidate from a list.
 * Ties are broken by confidence (higher wins), then by taxonomy priority.
 */
function selectBestCandidate(
  candidates: ClassificationCandidate[],
): ClassificationCandidate | undefined {
  if (candidates.length === 0) return undefined;
  return candidates.sort((a, b) => {
    const priDiff = categoryPriority(a.category) - categoryPriority(b.category);
    if (priDiff !== 0) return priDiff;
    return b.confidence - a.confidence;
  })[0];
}

/**
 * Test whether a message matches any of the given patterns (case-insensitive).
 */
function matchesMessagePattern(message: string, patterns: string[]): boolean {
  const lower = message.toLowerCase();
  return patterns.some((p) => precompileRegexPattern(p, "i").test(lower));
}

function matchesCustomPattern(pattern: string, value: string): boolean {
  return precompileRegexPattern(pattern, "i").test(value);
}

function hasRateLimitErrorCode(errorCode?: string): boolean {
  return typeof errorCode === "string"
    && /(?:^|[_-])(?:RATE[_-]?LIMIT|THROTTLED|TOO[_-]?MANY[_-]?REQUESTS)(?:$|[_-])/i.test(errorCode);
}

function hasRateLimitMessage(errorMessage?: string): boolean {
  return typeof errorMessage === "string"
    && /(?:\b429\b|rate.?limit|throttl|too many requests|quota exceeded)/i.test(errorMessage);
}

/**
 * Look up a failure class by category.
 */
function getFailureClass(category: FridayFailureCategory): FridayFailureClass {
  return (
    FAILURE_CLASS_DEFINITIONS.find((fc) => fc.category === category) ??
    FAILURE_CLASS_DEFINITIONS[FAILURE_CLASS_DEFINITIONS.length - 1]
  );
}

// ─── Failure Classifier Implementation ───

/**
 * Creates a new failure classifier instance.
 *
 * The classifier is stateful only for custom rules — the core classification
 * logic is purely deterministic based on the failure class definitions and
 * the priority chain.
 *
 * @param config - Classifier configuration (ID generation, timestamping).
 * @returns A {@link FridayFailureClassifier}-compatible object with an
 *          additional `classifyError` method for API-layer classification.
 */
export function createFailureClassifier(config: FailureClassifierConfig) {
  const customRules: FridayCustomClassificationRule[] = [];

  type ClassifyInput = FridayClassifyFailureError | FridayNodeExecutionResult;

  /**
   * Detect API-layer classification input shape.
   */
  function isClassifyFailureErrorInput(input: ClassifyInput): input is FridayClassifyFailureError {
    return !("stepResults" in input);
  }

  /**
   * Extract HTTP status code from a node execution result if available.
   */
  function extractHttpStatusCode(
    executionResult: FridayNodeExecutionResult,
  ): number | undefined {
    for (const stepResult of executionResult.stepResults) {
      const metadata = stepResult.metadata as { httpStatusCode?: unknown } | undefined;
      if (metadata && typeof metadata.httpStatusCode === "number") {
        return metadata.httpStatusCode;
      }
    }
    return undefined;
  }

  /**
   * Normalize supported classifier inputs to the API error descriptor shape.
   */
  function normalizeClassifyInput(input: ClassifyInput): FridayClassifyFailureError {
    if (isClassifyFailureErrorInput(input)) {
      return input;
    }

    const httpStatusCode = extractHttpStatusCode(input);
    if (input.errorCode !== undefined) {
      return {
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        httpStatusCode,
      };
    }
    if (input.errorMessage !== undefined) {
      return { errorMessage: input.errorMessage, httpStatusCode };
    }
    if (httpStatusCode !== undefined) {
      return { httpStatusCode };
    }

    return {
      errorMessage: `Node execution failed with status '${input.status}'`,
    };
  }

  /**
   * Attempt classification via custom rules.
   */
  function classifyByCustomRules(
    errorCode?: string,
    errorMessage?: string,
    httpStatusCode?: number,
  ): ClassificationCandidate | undefined {
    const sortedRules = [...customRules].sort((a, b) => a.priority - b.priority);

    for (const rule of sortedRules) {
      if (rule.httpStatusCode !== undefined && rule.httpStatusCode === httpStatusCode) {
        return {
          category: rule.category,
          severity: rule.severity,
          source: "custom_rule",
          confidence: 95,
        };
      }
      if (rule.errorCodePattern && errorCode) {
        if (matchesCustomPattern(rule.errorCodePattern, errorCode)) {
          return {
            category: rule.category,
            severity: rule.severity,
            source: "custom_rule",
            confidence: 90,
          };
        }
      }
      if (rule.errorMessagePattern && errorMessage) {
        if (matchesCustomPattern(rule.errorMessagePattern, errorMessage)) {
          return {
            category: rule.category,
            severity: rule.severity,
            source: "custom_rule",
            confidence: 85,
          };
        }
      }
    }
    return undefined;
  }

  /**
   * Attempt classification via retry hint from NodeRunner adapter.
   */
  function classifyByRetryHint(
    retryHint: FridayRetryHint,
  ): ClassificationCandidate | undefined {
    if (!retryHint.retryable) {
      return {
        category: "logic",
        severity: "major",
        source: "retry_hint",
        confidence: 80,
      };
    }
    // Retryable hint — classify based on backoff strategy hint.
    if (retryHint.backoff === "fixed") {
      return {
        category: "rate_limit",
        severity: "minor",
        source: "retry_hint",
        confidence: 70,
      };
    }
    return {
      category: "transient",
      severity: "minor",
      source: "retry_hint",
      confidence: 65,
    };
  }

  /**
   * Attempt classification via HTTP status code.
   */
  function classifyByHttpStatus(
    httpStatusCode: number,
  ): ClassificationCandidate | undefined {
    for (const fc of FAILURE_CLASS_DEFINITIONS) {
      if (fc.httpStatusCodes.includes(httpStatusCode)) {
        return {
          category: fc.category,
          severity: fc.defaultSeverity,
          source: "http_status",
          confidence: 90,
        };
      }
    }
    // Catch-all for unmatched 4xx → logic, 5xx → transient
    if (httpStatusCode >= 400 && httpStatusCode < 500) {
      return {
        category: "logic",
        severity: "major",
        source: "http_status",
        confidence: 50,
      };
    }
    if (httpStatusCode >= 500) {
      return {
        category: "transient",
        severity: "minor",
        source: "http_status",
        confidence: 50,
      };
    }
    return undefined;
  }

  /**
   * Attempt classification via error code.
   */
  function classifyByErrorCode(
    errorCode: string,
  ): ClassificationCandidate | undefined {
    for (const fc of FAILURE_CLASS_DEFINITIONS) {
      if (fc.errorCodes.includes(errorCode)) {
        return {
          category: fc.category,
          severity: fc.defaultSeverity,
          source: "error_code",
          confidence: 85,
        };
      }
    }
    return undefined;
  }

  /**
   * Attempt classification via error message heuristic.
   */
  function classifyByErrorMessage(
    errorMessage: string,
  ): ClassificationCandidate | undefined {
    const candidates: ClassificationCandidate[] = [];

    for (const fc of FAILURE_CLASS_DEFINITIONS) {
      if (
        fc.errorMessagePatterns.length > 0 &&
        matchesMessagePattern(errorMessage, fc.errorMessagePatterns)
      ) {
        candidates.push({
          category: fc.category,
          severity: fc.defaultSeverity,
          source: "error_message",
          confidence: 60,
        });
      }
    }

    return selectBestCandidate(candidates);
  }

  /**
   * Core classification pipeline. Runs the priority chain and returns
   * a classified failure.
   */
  function classifyInternal(
    error: FridayClassifyFailureError,
    retryHint?: FridayRetryHint,
  ): FridayClassifiedFailure {
    const errorCode = (error as { errorCode?: string }).errorCode;
    const errorMessage = (error as { errorMessage?: string }).errorMessage;
    const httpStatusCode = (error as { httpStatusCode?: number }).httpStatusCode;

    const rateLimitSignalSource: FridayFailureClassificationSource | undefined = httpStatusCode === 429
      ? "http_status"
      : hasRateLimitErrorCode(errorCode)
        ? "error_code"
        : hasRateLimitMessage(errorMessage)
          ? "error_message"
          : undefined;
    const rateLimitCandidate: ClassificationCandidate | undefined = rateLimitSignalSource
      ? {
          category: "rate_limit",
          severity: getFailureClass("rate_limit").defaultSeverity,
          source: rateLimitSignalSource,
          confidence: rateLimitSignalSource === "http_status"
            ? 90
            : rateLimitSignalSource === "error_code"
              ? 85
              : 60,
        }
      : undefined;

    // Priority chain: custom rules → hard rate-limit signals → retry hint → HTTP status → error code → message → default
    const candidate =
      classifyByCustomRules(errorCode, errorMessage, httpStatusCode) ??
      rateLimitCandidate ??
      (retryHint ? classifyByRetryHint(retryHint) : undefined) ??
      (httpStatusCode !== undefined ? classifyByHttpStatus(httpStatusCode) : undefined) ??
      (errorCode ? classifyByErrorCode(errorCode) : undefined) ??
      (errorMessage ? classifyByErrorMessage(errorMessage) : undefined);

    const category: FridayFailureCategory = candidate?.category ?? "unknown";
    const severity: FridayFailureSeverity = candidate?.severity ?? "info";
    const source: FridayFailureClassificationSource = candidate?.source ?? "default";
    const confidence = candidate?.confidence ?? 10;
    const fc = getFailureClass(category);

    return {
      classificationId: config.generateId(),
      category,
      severity,
      classificationSource: source,
      confidence,
      originalErrorCode: errorCode,
      originalErrorMessage: errorMessage,
      httpStatusCode,
      retryAfterMs: retryHint?.retryAfterMs,
      retryHint,
      retryable: fc.retryableByDefault,
      classifiedAt: config.nowIso(),
    };
  }

  /**
   * Contract-aligned classifier entrypoint.
   */
  function classify(
    input: ClassifyInput,
    retryHint?: FridayRetryHint,
  ): FridayClassifiedFailure {
    return classifyInternal(normalizeClassifyInput(input), retryHint);
  }

  /**
   * Backward-compatible API-layer adapter.
   */
  function classifyError(
    error: FridayClassifyFailureError,
    retryHint?: FridayRetryHint,
  ): FridayClassifiedFailure {
    return classify(error, retryHint);
  }

  /**
   * Register a custom classification rule.
   */
  function registerCustomRule(rule: FridayCustomClassificationRule): void {
    if (rule.errorCodePattern) {
      precompileRegexPattern(rule.errorCodePattern, "i");
    }
    if (rule.errorMessagePattern) {
      precompileRegexPattern(rule.errorMessagePattern, "i");
    }
    customRules.push(rule);
  }

  /**
   * Get a snapshot of currently registered custom rules.
   */
  function getCustomRules(): readonly FridayCustomClassificationRule[] {
    return [...customRules];
  }

  /**
   * Get the failure class definition for a category.
   */
  function getFailureClassForCategory(category: FridayFailureCategory): FridayFailureClass {
    return getFailureClass(category);
  }

  return {
    classify,
    classifyError,
    registerCustomRule,
    getCustomRules,
    getFailureClassForCategory,
  };
}

/** Type of the failure classifier returned by {@link createFailureClassifier}. */
export type FailureClassifierInstance = ReturnType<typeof createFailureClassifier>;
