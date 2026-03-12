import { describe, it, expect } from "vitest";
import { createFridayMemoryRateLimiter } from "#memory";
import {
  FRIDAY_MEMORY_GUARD_WRITE_RATE_PER_MINUTE,
  FRIDAY_MEMORY_GUARD_SEARCH_RATE_PER_MINUTE,
  FRIDAY_MEMORY_GUARD_GLOBAL_WRITE_RATE_PER_MINUTE,
  FRIDAY_MEMORY_GUARD_GLOBAL_SEARCH_RATE_PER_MINUTE,
} from "#memory";

describe("FridayMemoryRateLimiter", () => {
  const BASE_TIME = 1_700_000_000_000; // Fixed ms timestamp

  it("allows the first write request", () => {
    const limiter = createFridayMemoryRateLimiter();
    const decision = limiter.consume("write", "test-ns", BASE_TIME);
    expect(decision.allowed).toBe(true);
    expect(decision.action).toBe("write");
    expect(decision.retryAfterMs).toBe(0);
  });

  it("allows the first search request", () => {
    const limiter = createFridayMemoryRateLimiter();
    const decision = limiter.consume("search", "test-ns", BASE_TIME);
    expect(decision.allowed).toBe(true);
    expect(decision.action).toBe("search");
  });

  it("allows up to capacity writes per namespace", () => {
    const limiter = createFridayMemoryRateLimiter();
    for (let i = 0; i < FRIDAY_MEMORY_GUARD_WRITE_RATE_PER_MINUTE; i++) {
      const decision = limiter.consume("write", "test-ns", BASE_TIME);
      expect(decision.allowed).toBe(true);
    }
  });

  it("rejects writes when namespace bucket is exhausted", () => {
    const limiter = createFridayMemoryRateLimiter();
    // Exhaust namespace bucket
    for (let i = 0; i < FRIDAY_MEMORY_GUARD_WRITE_RATE_PER_MINUTE; i++) {
      limiter.consume("write", "test-ns", BASE_TIME);
    }
    const decision = limiter.consume("write", "test-ns", BASE_TIME);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBeGreaterThan(0);
  });

  it("separate namespaces have independent buckets", () => {
    const limiter = createFridayMemoryRateLimiter();
    // Exhaust ns-a
    for (let i = 0; i < FRIDAY_MEMORY_GUARD_WRITE_RATE_PER_MINUTE; i++) {
      limiter.consume("write", "ns-a", BASE_TIME);
    }
    // ns-b should still be allowed
    const decision = limiter.consume("write", "ns-b", BASE_TIME);
    expect(decision.allowed).toBe(true);
  });

  it("refills tokens over time", () => {
    const limiter = createFridayMemoryRateLimiter();
    // Exhaust all tokens
    for (let i = 0; i < FRIDAY_MEMORY_GUARD_WRITE_RATE_PER_MINUTE; i++) {
      limiter.consume("write", "test-ns", BASE_TIME);
    }
    // Should be rejected at same time
    expect(limiter.consume("write", "test-ns", BASE_TIME).allowed).toBe(false);

    // Wait enough time for at least 1 token to refill (60s / rate = ms per token)
    const msPerToken = 60_000 / FRIDAY_MEMORY_GUARD_WRITE_RATE_PER_MINUTE;
    const laterTime = BASE_TIME + msPerToken + 1;
    const decision = limiter.consume("write", "test-ns", laterTime);
    expect(decision.allowed).toBe(true);
  });

  it("write and search use separate buckets per namespace", () => {
    const limiter = createFridayMemoryRateLimiter();
    // Exhaust write bucket
    for (let i = 0; i < FRIDAY_MEMORY_GUARD_WRITE_RATE_PER_MINUTE; i++) {
      limiter.consume("write", "test-ns", BASE_TIME);
    }
    // Search should still work
    const decision = limiter.consume("search", "test-ns", BASE_TIME);
    expect(decision.allowed).toBe(true);
  });

  it("reports remaining tokens correctly", () => {
    const limiter = createFridayMemoryRateLimiter();
    const d1 = limiter.consume("search", "test-ns", BASE_TIME);
    expect(d1.remaining).toBe(FRIDAY_MEMORY_GUARD_SEARCH_RATE_PER_MINUTE - 1);
  });

  it("returns resetAt as ISO string", () => {
    const limiter = createFridayMemoryRateLimiter();
    const decision = limiter.consume("write", "test-ns", BASE_TIME);
    expect(decision.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejected request has retryAfterMs > 0", () => {
    const limiter = createFridayMemoryRateLimiter();
    for (let i = 0; i < FRIDAY_MEMORY_GUARD_WRITE_RATE_PER_MINUTE; i++) {
      limiter.consume("write", "exhaust", BASE_TIME);
    }
    const decision = limiter.consume("write", "exhaust", BASE_TIME);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBeGreaterThan(0);
    expect(typeof decision.resetAt).toBe("string");
  });

  // ─── Global bucket exhaustion ───

  it("rejects when global write bucket is exhausted across namespaces", () => {
    const limiter = createFridayMemoryRateLimiter();
    // Spread writes across many namespaces to exhaust the global bucket
    // without exhausting any single namespace bucket.
    const namespacesNeeded = Math.ceil(
      FRIDAY_MEMORY_GUARD_GLOBAL_WRITE_RATE_PER_MINUTE / FRIDAY_MEMORY_GUARD_WRITE_RATE_PER_MINUTE,
    ) + 1;

    let totalConsumed = 0;
    for (let ns = 0; ns < namespacesNeeded && totalConsumed < FRIDAY_MEMORY_GUARD_GLOBAL_WRITE_RATE_PER_MINUTE; ns++) {
      const batchSize = Math.min(
        FRIDAY_MEMORY_GUARD_WRITE_RATE_PER_MINUTE,
        FRIDAY_MEMORY_GUARD_GLOBAL_WRITE_RATE_PER_MINUTE - totalConsumed,
      );
      for (let i = 0; i < batchSize; i++) {
        const d = limiter.consume("write", `ns-${ns}`, BASE_TIME);
        expect(d.allowed).toBe(true);
        totalConsumed++;
      }
    }

    // Global should now be exhausted; a fresh namespace should be rejected at the global level
    const decision = limiter.consume("write", "fresh-ns", BASE_TIME);
    expect(decision.allowed).toBe(false);
    expect(decision.key).toBe("global:write");
    expect(decision.retryAfterMs).toBeGreaterThan(0);
  });

  it("rejects when global search bucket is exhausted across namespaces", () => {
    const limiter = createFridayMemoryRateLimiter();
    const namespacesNeeded = Math.ceil(
      FRIDAY_MEMORY_GUARD_GLOBAL_SEARCH_RATE_PER_MINUTE / FRIDAY_MEMORY_GUARD_SEARCH_RATE_PER_MINUTE,
    ) + 1;

    let totalConsumed = 0;
    for (let ns = 0; ns < namespacesNeeded && totalConsumed < FRIDAY_MEMORY_GUARD_GLOBAL_SEARCH_RATE_PER_MINUTE; ns++) {
      const batchSize = Math.min(
        FRIDAY_MEMORY_GUARD_SEARCH_RATE_PER_MINUTE,
        FRIDAY_MEMORY_GUARD_GLOBAL_SEARCH_RATE_PER_MINUTE - totalConsumed,
      );
      for (let i = 0; i < batchSize; i++) {
        const d = limiter.consume("search", `ns-${ns}`, BASE_TIME);
        expect(d.allowed).toBe(true);
        totalConsumed++;
      }
    }

    const decision = limiter.consume("search", "fresh-ns", BASE_TIME);
    expect(decision.allowed).toBe(false);
    expect(decision.key).toBe("global:search");
  });

  // ─── Namespace token refund on global rejection ───

  it("refunds namespace token when global bucket rejects", () => {
    const limiter = createFridayMemoryRateLimiter();

    // Exhaust global write bucket across many namespaces
    let totalConsumed = 0;
    let nsIdx = 0;
    while (totalConsumed < FRIDAY_MEMORY_GUARD_GLOBAL_WRITE_RATE_PER_MINUTE) {
      const batchSize = Math.min(
        FRIDAY_MEMORY_GUARD_WRITE_RATE_PER_MINUTE,
        FRIDAY_MEMORY_GUARD_GLOBAL_WRITE_RATE_PER_MINUTE - totalConsumed,
      );
      for (let i = 0; i < batchSize; i++) {
        limiter.consume("write", `fill-ns-${nsIdx}`, BASE_TIME);
        totalConsumed++;
      }
      nsIdx++;
    }

    // Now consume from "refund-ns" — should be rejected at global level
    const rejected = limiter.consume("write", "refund-ns", BASE_TIME);
    expect(rejected.allowed).toBe(false);
    expect(rejected.key).toBe("global:write");

    // Wait for global to refill enough for 1 token
    const globalMsPerToken = 60_000 / FRIDAY_MEMORY_GUARD_GLOBAL_WRITE_RATE_PER_MINUTE;
    const laterTime = BASE_TIME + globalMsPerToken + 1;

    // "refund-ns" should still have its full capacity minus 0 (refunded),
    // so it should be allowed now that global has a token again
    const afterRefill = limiter.consume("write", "refund-ns", laterTime);
    expect(afterRefill.allowed).toBe(true);
    // Verify the remaining is capacity - 1 (only one consumed from the namespace bucket)
    expect(afterRefill.remaining).toBe(FRIDAY_MEMORY_GUARD_WRITE_RATE_PER_MINUTE - 1);
  });
});
