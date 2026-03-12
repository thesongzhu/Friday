import { describe, it, expect, vi } from "vitest";
import { FridayDomainError } from "#errors";
import { FRIDAY_MEMORY_GUARD_ERROR_CODES } from "#memory";
import { createGuardTestSetup } from "./_helpers/create-guard-service.helper.js";

describe("FridayMemoryGuardService — Rate Limiting", () => {
  it("allows store when rate limiter allows", async () => {
    const { guard, core } = createGuardTestSetup();
    await guard.store("test-ns", "content");
    expect(core.store).toHaveBeenCalled();
  });

  it("rejects store when namespace write rate limit exceeded", async () => {
    const { guard, rateLimiter } = createGuardTestSetup();
    vi.mocked(rateLimiter.consume).mockReturnValue({
      allowed: false,
      action: "write",
      key: "ns:write:tenant.default.user.user1.test-ns",
      remaining: 0,
      resetAt: "2026-02-18T10:01:00.000Z",
      retryAfterMs: 60_000,
    });

    await expect(guard.store("test-ns", "content")).rejects.toThrow(FridayDomainError);
    try {
      await guard.store("test-ns", "content");
    } catch (e) {
      const err = e as FridayDomainError;
      expect(err.code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.RATE_LIMIT_NAMESPACE_WRITE);
      expect(err.httpStatus).toBe(429);
      expect(err.retryable).toBe(true);
      expect(err.details.retryAfterMs).toBe(60_000);
    }
  });

  it("rejects store when global write rate limit exceeded", async () => {
    const { guard, rateLimiter } = createGuardTestSetup();
    vi.mocked(rateLimiter.consume).mockReturnValue({
      allowed: false,
      action: "write",
      key: "global:write",
      remaining: 0,
      resetAt: "2026-02-18T10:01:00.000Z",
      retryAfterMs: 30_000,
    });

    try {
      await guard.store("test-ns", "content");
    } catch (e) {
      const err = e as FridayDomainError;
      expect(err.code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.RATE_LIMIT_GLOBAL_WRITE);
      expect(err.httpStatus).toBe(429);
    }
  });

  it("rejects search when namespace search rate limit exceeded", async () => {
    const { guard, rateLimiter } = createGuardTestSetup();
    vi.mocked(rateLimiter.consume).mockReturnValue({
      allowed: false,
      action: "search",
      key: "ns:search:tenant.default.user.user1",
      remaining: 0,
      resetAt: "2026-02-18T10:01:00.000Z",
      retryAfterMs: 30_000,
    });

    try {
      await guard.search("hello");
    } catch (e) {
      const err = e as FridayDomainError;
      expect(err.code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.RATE_LIMIT_NAMESPACE_SEARCH);
      expect(err.httpStatus).toBe(429);
    }
  });

  it("rejects search when global search rate limit exceeded", async () => {
    const { guard, rateLimiter } = createGuardTestSetup();
    vi.mocked(rateLimiter.consume).mockReturnValue({
      allowed: false,
      action: "search",
      key: "global:search",
      remaining: 0,
      resetAt: "2026-02-18T10:01:00.000Z",
      retryAfterMs: 30_000,
    });

    try {
      await guard.search("hello");
    } catch (e) {
      const err = e as FridayDomainError;
      expect(err.code).toBe(FRIDAY_MEMORY_GUARD_ERROR_CODES.RATE_LIMIT_GLOBAL_SEARCH);
    }
  });

  it("consumes write rate on delete", async () => {
    const { guard, rateLimiter } = createGuardTestSetup();
    await guard.delete("item-1");
    expect(rateLimiter.consume).toHaveBeenCalledWith(
      "write",
      expect.anything(),
      expect.anything(),
    );
  });

  it("consumes write rate on prune", async () => {
    const { guard, rateLimiter } = createGuardTestSetup();
    await guard.prune();
    expect(rateLimiter.consume).toHaveBeenCalledWith(
      "write",
      expect.anything(),
      expect.anything(),
    );
  });

  it("consumes search rate on search", async () => {
    const { guard, rateLimiter } = createGuardTestSetup();
    await guard.search("hello world");
    expect(rateLimiter.consume).toHaveBeenCalledWith(
      "search",
      expect.anything(),
      expect.anything(),
    );
  });
});
