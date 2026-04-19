import type {
  FridayRetryCostBudget,
  FridayRetryPolicy,
  FridayRetryStrategy,
} from "../model/friday-retry-engine.types.js";

export const DEFAULT_UNIFIED_RETRY_POLICY_ID = "default-unified-retry-policy-v1";

export function buildDefaultRetryStrategies(): FridayRetryStrategy[] {
  return [
    {
      strategy: "exponential",
      failureCategory: "rate_limit",
      maxAttempts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 60_000,
      jitterPercent: 25,
      respectRetryAfter: true,
      timeoutMultiplier: 1,
      escalate: false,
      escalateOnExhaustion: true,
      escalationChannel: "operator",
    },
    {
      strategy: "exponential",
      failureCategory: "timeout",
      maxAttempts: 3,
      baseDelayMs: 1500,
      maxDelayMs: 30_000,
      jitterPercent: 20,
      respectRetryAfter: false,
      timeoutMultiplier: 1.5,
      escalate: false,
      escalateOnExhaustion: true,
      escalationChannel: "operator",
    },
    {
      strategy: "exponential",
      failureCategory: "transient",
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 15_000,
      jitterPercent: 30,
      respectRetryAfter: false,
      timeoutMultiplier: 1,
      escalate: false,
      escalateOnExhaustion: true,
      escalationChannel: "developer",
    },
    {
      strategy: "linear",
      failureCategory: "resource",
      maxAttempts: 2,
      baseDelayMs: 5000,
      maxDelayMs: 30_000,
      jitterPercent: 10,
      respectRetryAfter: false,
      timeoutMultiplier: 1,
      escalate: false,
      escalateOnExhaustion: true,
      escalationChannel: "operator",
    },
    {
      strategy: "none",
      failureCategory: "auth",
      maxAttempts: 0,
      respectRetryAfter: false,
      timeoutMultiplier: 1,
      escalate: true,
      escalateOnExhaustion: false,
      escalationChannel: "operator",
    },
    {
      strategy: "none",
      failureCategory: "logic",
      maxAttempts: 0,
      respectRetryAfter: false,
      timeoutMultiplier: 1,
      escalate: false,
      escalateOnExhaustion: false,
    },
    {
      strategy: "fixed",
      failureCategory: "unknown",
      maxAttempts: 1,
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      jitterPercent: 50,
      respectRetryAfter: false,
      timeoutMultiplier: 1,
      escalate: false,
      escalateOnExhaustion: true,
      escalationChannel: "developer",
    },
  ];
}

export function buildDefaultRetryPolicy(
  nowIso: string,
  etag: string,
): FridayRetryPolicy {
  const costBudget: FridayRetryCostBudget = {
    maxTotalTokens: 100_000,
    maxTotalApiCalls: 50,
    maxTotalComputeMs: 300_000,
  };
  return {
    id: DEFAULT_UNIFIED_RETRY_POLICY_ID,
    name: "Default Unified Retry Policy",
    description: "Stable retry defaults for workflow execution and acceptance-quality flows.",
    version: 1,
    priority: 100,
    enabled: true,
    tags: ["built-in", "default"],
    costBudget,
    strategies: buildDefaultRetryStrategies(),
    etag,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}
