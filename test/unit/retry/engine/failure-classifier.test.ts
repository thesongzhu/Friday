import { describe, it, expect, beforeEach } from "vitest";

import {
  createFailureClassifier,
  FAILURE_CLASS_DEFINITIONS,
} from "../../../../src/retry/engine/failure-classifier.js";

import type { FailureClassifierConfig } from "../../../../src/retry/engine/failure-classifier.js";
import type { FridayClassifyFailureError } from "../../../../src/retry/api/friday-retry-api.types.js";
import type { FridayRetryHint } from "../../../../src/node-runner/api/friday-node-runner-api.types.js";
import type { FridayCustomClassificationRule } from "../../../../src/retry/model/friday-retry-engine.types.js";
import type { FridayNodeExecutionResult } from "../../../../src/node-runner/model/friday-node-runner.types.js";

// ─── Helpers ───

let idCounter = 0;
const testConfig: FailureClassifierConfig = {
  generateId: () => `test-id-${++idCounter}` as string,
  nowIso: () => "2026-02-24T10:00:00.000Z" as string,
};

function createTestClassifier() {
  idCounter = 0;
  return createFailureClassifier(testConfig);
}

// ─── Tests ───

describe("FailureClassifier", () => {
  let classifier: ReturnType<typeof createFailureClassifier>;

  beforeEach(() => {
    classifier = createTestClassifier();
  });

  describe("FAILURE_CLASS_DEFINITIONS", () => {
    it("defines exactly 7 failure categories", () => {
      expect(FAILURE_CLASS_DEFINITIONS).toHaveLength(7);
    });

    it("covers all taxonomy categories", () => {
      const categories = FAILURE_CLASS_DEFINITIONS.map((fc) => fc.category);
      expect(categories).toContain("transient");
      expect(categories).toContain("rate_limit");
      expect(categories).toContain("auth");
      expect(categories).toContain("logic");
      expect(categories).toContain("resource");
      expect(categories).toContain("timeout");
      expect(categories).toContain("unknown");
    });
  });

  describe("classifyError — HTTP status codes", () => {
    it("classifies 429 as rate_limit", () => {
      const result = classifier.classifyError({ httpStatusCode: 429 });
      expect(result.category).toBe("rate_limit");
      expect(result.classificationSource).toBe("http_status");
      expect(result.retryable).toBe(true);
    });

    it("classifies 401 as auth", () => {
      const result = classifier.classifyError({ httpStatusCode: 401 });
      expect(result.category).toBe("auth");
      expect(result.retryable).toBe(false);
    });

    it("classifies 403 as auth", () => {
      const result = classifier.classifyError({ httpStatusCode: 403 });
      expect(result.category).toBe("auth");
    });

    it("classifies 408 as timeout", () => {
      const result = classifier.classifyError({ httpStatusCode: 408 });
      expect(result.category).toBe("timeout");
      expect(result.retryable).toBe(true);
    });

    it("classifies 504 as timeout", () => {
      const result = classifier.classifyError({ httpStatusCode: 504 });
      expect(result.category).toBe("timeout");
    });

    it("classifies 500 as transient", () => {
      const result = classifier.classifyError({ httpStatusCode: 500 });
      expect(result.category).toBe("transient");
      expect(result.retryable).toBe(true);
    });

    it("classifies 502 as transient", () => {
      const result = classifier.classifyError({ httpStatusCode: 502 });
      expect(result.category).toBe("transient");
    });

    it("classifies 503 as transient", () => {
      const result = classifier.classifyError({ httpStatusCode: 503 });
      expect(result.category).toBe("transient");
    });

    it("classifies 400 as logic", () => {
      const result = classifier.classifyError({ httpStatusCode: 400 });
      expect(result.category).toBe("logic");
      expect(result.retryable).toBe(false);
    });

    it("classifies 422 as logic", () => {
      const result = classifier.classifyError({ httpStatusCode: 422 });
      expect(result.category).toBe("logic");
    });

    it("classifies 507 as resource", () => {
      const result = classifier.classifyError({ httpStatusCode: 507 });
      expect(result.category).toBe("resource");
    });

    it("classifies unmatched 4xx as logic (fallback)", () => {
      const result = classifier.classifyError({ httpStatusCode: 418 });
      expect(result.category).toBe("logic");
      expect(result.confidence).toBe(50);
    });

    it("classifies unmatched 5xx as transient (fallback)", () => {
      const result = classifier.classifyError({ httpStatusCode: 599 });
      expect(result.category).toBe("transient");
      expect(result.confidence).toBe(50);
    });
  });

  describe("classify (contract-aligned entrypoint)", () => {
    it("classifies API error input via classify()", () => {
      const error: FridayClassifyFailureError = { httpStatusCode: 429 };
      const result = classifier.classify(error);
      expect(result.category).toBe("rate_limit");
    });

    it("classifies node execution result input via classify()", () => {
      const executionResult: FridayNodeExecutionResult = {
        executionId: "exec-1" as string,
        status: "failed",
        stepResults: [
          {
            step: "execute",
            outcome: "failure",
            durationMs: 10,
            metadata: { httpStatusCode: 503 },
          },
        ],
        durationMs: 10,
        errorCode: "NODE_INTERNAL_ERROR",
        errorMessage: "upstream unavailable",
        startedAt: "2026-02-24T10:00:00.000Z",
        completedAt: "2026-02-24T10:00:00.010Z",
      };
      const result = classifier.classify(executionResult);
      expect(result.category).toBe("transient");
    });
  });

  describe("classifyError — error codes", () => {
    it("classifies ECONNRESET as transient", () => {
      const result = classifier.classifyError({ errorCode: "ECONNRESET" });
      expect(result.category).toBe("transient");
      expect(result.classificationSource).toBe("error_code");
    });

    it("classifies ECONNREFUSED as transient", () => {
      const result = classifier.classifyError({ errorCode: "ECONNREFUSED" });
      expect(result.category).toBe("transient");
    });

    it("classifies NODE_EXECUTION_TIMEOUT as timeout", () => {
      const result = classifier.classifyError({ errorCode: "NODE_EXECUTION_TIMEOUT" });
      expect(result.category).toBe("timeout");
    });

    it("classifies NODE_VALIDATION_FAILED as logic", () => {
      const result = classifier.classifyError({ errorCode: "NODE_VALIDATION_FAILED" });
      expect(result.category).toBe("logic");
    });

    it("classifies RATE_LIMIT_EXCEEDED as rate_limit", () => {
      const result = classifier.classifyError({ errorCode: "RATE_LIMIT_EXCEEDED" });
      expect(result.category).toBe("rate_limit");
    });

    it("classifies NODE_PRE_RULES_DENIED as auth", () => {
      const result = classifier.classifyError({ errorCode: "NODE_PRE_RULES_DENIED" });
      expect(result.category).toBe("auth");
    });
  });

  describe("classifyError — error message heuristic", () => {
    it("classifies rate limit messages as rate_limit", () => {
      const result = classifier.classifyError({ errorMessage: "rate limit exceeded, please wait" });
      expect(result.category).toBe("rate_limit");
      expect(result.classificationSource).toBe("error_message");
    });

    it("classifies timeout messages as timeout", () => {
      const result = classifier.classifyError({ errorMessage: "request timed out after 30s" });
      expect(result.category).toBe("timeout");
    });

    it("classifies connection reset messages as transient", () => {
      const result = classifier.classifyError({ errorMessage: "connection reset by peer" });
      expect(result.category).toBe("transient");
    });

    it("classifies out of memory messages as resource", () => {
      const result = classifier.classifyError({ errorMessage: "Out of memory: cannot allocate" });
      expect(result.category).toBe("resource");
    });

    it("classifies auth messages as auth", () => {
      const result = classifier.classifyError({ errorMessage: "token expired, please re-authenticate" });
      expect(result.category).toBe("auth");
    });

    it("classifies validation messages as logic", () => {
      const result = classifier.classifyError({ errorMessage: "validation failed: field X is required" });
      expect(result.category).toBe("logic");
    });
  });

  describe("classifyError — priority chain", () => {
    it("prefers HTTP status over error message", () => {
      const result = classifier.classifyError({
        httpStatusCode: 429,
        errorMessage: "internal server error",
      });
      expect(result.category).toBe("rate_limit");
      expect(result.classificationSource).toBe("http_status");
    });

    it("keeps hard 429/rate-limit signals retryable when wrapped in auth wording", () => {
      const result = classifier.classifyError({
        errorCode: "PROVIDER_AUTH_INVALID",
        errorMessage: "429 rate limit exceeded while refreshing auth profile",
      });
      expect(result.category).toBe("rate_limit");
      expect(result.classificationSource).toBe("error_message");
      expect(result.retryable).toBe(true);
    });

    it("prefers error code over error message", () => {
      const result = classifier.classifyError({
        errorCode: "ECONNRESET",
        errorMessage: "validation failed",
      });
      expect(result.category).toBe("transient");
      expect(result.classificationSource).toBe("error_code");
    });

    it("falls back to unknown when no signals match", () => {
      const result = classifier.classifyError({
        errorCode: "SOME_UNKNOWN_CODE",
        errorMessage: "something went very wrong in an unusual way",
      });
      expect(result.category).toBe("unknown");
      expect(result.classificationSource).toBe("default");
    });
  });

  describe("classifyError — retry hint integration", () => {
    it("uses retry hint when retryable=false to classify as logic", () => {
      const hint: FridayRetryHint = { retryable: false, reason: "permanent" };
      const result = classifier.classifyError(
        { errorCode: "SOME_UNKNOWN_CODE" },
        hint,
      );
      expect(result.category).toBe("logic");
      expect(result.classificationSource).toBe("retry_hint");
    });

    it("uses retry hint with fixed backoff to classify as rate_limit", () => {
      const hint: FridayRetryHint = {
        retryable: true,
        backoff: "fixed",
        retryAfterMs: 5000,
      };
      const result = classifier.classifyError(
        { errorCode: "SOME_UNKNOWN_CODE" },
        hint,
      );
      expect(result.category).toBe("rate_limit");
      expect(result.retryAfterMs).toBe(5000);
    });

    it("uses retry hint with exponential backoff to classify as transient", () => {
      const hint: FridayRetryHint = {
        retryable: true,
        backoff: "exponential",
      };
      const result = classifier.classifyError(
        { errorCode: "SOME_UNKNOWN_CODE" },
        hint,
      );
      expect(result.category).toBe("transient");
    });

    it("HTTP 429 takes priority over non-retryable retry hints", () => {
      const hint: FridayRetryHint = { retryable: false };
      const result = classifier.classifyError(
        { httpStatusCode: 429 },
        hint,
      );
      expect(result.category).toBe("rate_limit");
      expect(result.classificationSource).toBe("http_status");
      expect(result.retryable).toBe(true);
    });
  });

  describe("classifyError — custom rules", () => {
    it("custom rules take highest priority", () => {
      const rule: FridayCustomClassificationRule = {
        id: "custom-1",
        name: "OpenAI rate limit",
        errorCodePattern: "openai_rate_limit",
        category: "rate_limit",
        severity: "minor",
        priority: 1,
      };
      classifier.registerCustomRule(rule);

      const result = classifier.classifyError({
        errorCode: "openai_rate_limit",
        httpStatusCode: 500,
      });
      expect(result.category).toBe("rate_limit");
      expect(result.classificationSource).toBe("custom_rule");
    });

    it("custom rule matches HTTP status code", () => {
      classifier.registerCustomRule({
        id: "custom-2",
        name: "Custom 418",
        httpStatusCode: 418,
        category: "transient",
        severity: "minor",
        priority: 1,
      });

      const result = classifier.classifyError({ httpStatusCode: 418 });
      expect(result.category).toBe("transient");
      expect(result.classificationSource).toBe("custom_rule");
    });

    it("custom rule matches error message pattern", () => {
      classifier.registerCustomRule({
        id: "custom-3",
        name: "Anthropic overload",
        errorMessagePattern: "anthropic.*overloaded",
        category: "rate_limit",
        severity: "minor",
        priority: 1,
      });

      const result = classifier.classifyError({
        errorMessage: "Anthropic API is overloaded",
      });
      expect(result.category).toBe("rate_limit");
      expect(result.classificationSource).toBe("custom_rule");
    });

    it("rejects unsafe custom regex patterns at registration", () => {
      expect(() =>
        classifier.registerCustomRule({
          id: "custom-unsafe",
          name: "Unsafe regex",
          errorMessagePattern: "^(a+)+$",
          category: "transient",
          severity: "minor",
          priority: 1,
        }),
      ).toThrow("Regex pattern rejected");
    });

    it("getCustomRules returns registered rules", () => {
      expect(classifier.getCustomRules()).toHaveLength(0);
      classifier.registerCustomRule({
        id: "r1",
        name: "Rule 1",
        category: "transient",
        severity: "minor",
        priority: 1,
      });
      expect(classifier.getCustomRules()).toHaveLength(1);
    });
  });

  describe("classifyError — output shape", () => {
    it("generates unique classification IDs", () => {
      const r1 = classifier.classifyError({ httpStatusCode: 500 });
      const r2 = classifier.classifyError({ httpStatusCode: 500 });
      expect(r1.classificationId).not.toBe(r2.classificationId);
    });

    it("includes original error details in the output", () => {
      const result = classifier.classifyError({
        errorCode: "TEST_CODE",
        errorMessage: "test message",
        httpStatusCode: 503,
      });
      expect(result.originalErrorCode).toBe("TEST_CODE");
      expect(result.originalErrorMessage).toBe("test message");
      expect(result.httpStatusCode).toBe(503);
    });

    it("includes timestamp", () => {
      const result = classifier.classifyError({ httpStatusCode: 500 });
      expect(result.classifiedAt).toBe("2026-02-24T10:00:00.000Z");
    });

    it("includes retry hint in output when provided", () => {
      const hint: FridayRetryHint = { retryable: true, retryAfterMs: 1000 };
      const result = classifier.classifyError({ httpStatusCode: 500 }, hint);
      expect(result.retryHint).toBe(hint);
      expect(result.retryAfterMs).toBe(1000);
    });
  });

  describe("getFailureClassForCategory", () => {
    it("returns the correct failure class for each category", () => {
      const fc = classifier.getFailureClassForCategory("transient");
      expect(fc.category).toBe("transient");
      expect(fc.retryableByDefault).toBe(true);
      expect(fc.defaultMaxAttempts).toBe(3);
    });

    it("returns unknown class for unrecognized categories", () => {
      const fc = classifier.getFailureClassForCategory("unknown");
      expect(fc.category).toBe("unknown");
      expect(fc.defaultMaxAttempts).toBe(1);
    });
  });
});
