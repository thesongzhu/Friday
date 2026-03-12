import type {
  FridayMemoryGuardAction,
  FridayMemoryGuardRateLimitDecision,
  FridayMemoryGuardRateLimiter,
  FridayMemoryGuardTokenBucketState,
} from "../model/friday-memory-guard.types.js";

import {
  FRIDAY_MEMORY_GUARD_GLOBAL_SEARCH_RATE_PER_MINUTE,
  FRIDAY_MEMORY_GUARD_GLOBAL_WRITE_RATE_PER_MINUTE,
  FRIDAY_MEMORY_GUARD_SEARCH_RATE_PER_MINUTE,
  FRIDAY_MEMORY_GUARD_WRITE_RATE_PER_MINUTE,
} from "../friday-memory-guard.constants.js";

const MS_PER_MINUTE = 60_000;

function createBucket(ratePerMinute: number, nowMs: number): FridayMemoryGuardTokenBucketState {
  return {
    tokens: ratePerMinute,
    capacity: ratePerMinute,
    refillPerMs: ratePerMinute / MS_PER_MINUTE,
    lastRefillMs: nowMs,
  };
}

function refillBucket(bucket: FridayMemoryGuardTokenBucketState, nowMs: number): void {
  const elapsed = nowMs - bucket.lastRefillMs;
  if (elapsed <= 0) return;
  const tokensToAdd = elapsed * bucket.refillPerMs;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + tokensToAdd);
  bucket.lastRefillMs = nowMs;
}

function tryConsume(bucket: FridayMemoryGuardTokenBucketState, nowMs: number): { allowed: boolean; remaining: number; retryAfterMs: number; resetAt: string } {
  refillBucket(bucket, nowMs);

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    const remaining = Math.floor(bucket.tokens);
    return {
      allowed: true,
      remaining,
      retryAfterMs: 0,
      resetAt: new Date(nowMs + (bucket.capacity - bucket.tokens) / bucket.refillPerMs).toISOString(),
    };
  }

  // Not enough tokens — calculate when one token will be available
  const deficit = 1 - bucket.tokens;
  const retryAfterMs = Math.ceil(deficit / bucket.refillPerMs);
  return {
    allowed: false,
    remaining: 0,
    retryAfterMs,
    resetAt: new Date(nowMs + retryAfterMs).toISOString(),
  };
}

function rateForAction(action: FridayMemoryGuardAction, scope: "namespace" | "global"): number {
  if (scope === "namespace") {
    return action === "write"
      ? FRIDAY_MEMORY_GUARD_WRITE_RATE_PER_MINUTE
      : FRIDAY_MEMORY_GUARD_SEARCH_RATE_PER_MINUTE;
  }
  return action === "write"
    ? FRIDAY_MEMORY_GUARD_GLOBAL_WRITE_RATE_PER_MINUTE
    : FRIDAY_MEMORY_GUARD_GLOBAL_SEARCH_RATE_PER_MINUTE;
}

export function createFridayMemoryRateLimiter(): FridayMemoryGuardRateLimiter {
  const buckets = new Map<string, FridayMemoryGuardTokenBucketState>();

  function getOrCreate(key: string, ratePerMinute: number, nowMs: number): FridayMemoryGuardTokenBucketState {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = createBucket(ratePerMinute, nowMs);
      buckets.set(key, bucket);
    }
    return bucket;
  }

  return {
    consume(action: FridayMemoryGuardAction, namespace: string, nowMs: number): FridayMemoryGuardRateLimitDecision {
      // Check namespace-scoped bucket first
      const nsRate = rateForAction(action, "namespace");
      const nsKey = `ns:${action}:${namespace}`;
      const nsBucket = getOrCreate(nsKey, nsRate, nowMs);
      const nsResult = tryConsume(nsBucket, nowMs);

      if (!nsResult.allowed) {
        return {
          allowed: false,
          action,
          key: nsKey,
          remaining: nsResult.remaining,
          resetAt: nsResult.resetAt,
          retryAfterMs: nsResult.retryAfterMs,
        };
      }

      // Check global bucket
      const globalRate = rateForAction(action, "global");
      const globalKey = `global:${action}`;
      const globalBucket = getOrCreate(globalKey, globalRate, nowMs);
      const globalResult = tryConsume(globalBucket, nowMs);

      if (!globalResult.allowed) {
        // Refund the namespace token since global rejected
        nsBucket.tokens = Math.min(nsBucket.capacity, nsBucket.tokens + 1);
        return {
          allowed: false,
          action,
          key: globalKey,
          remaining: globalResult.remaining,
          resetAt: globalResult.resetAt,
          retryAfterMs: globalResult.retryAfterMs,
        };
      }

      return {
        allowed: true,
        action,
        key: nsKey,
        remaining: nsResult.remaining,
        resetAt: nsResult.resetAt,
        retryAfterMs: 0,
      };
    },
  };
}
