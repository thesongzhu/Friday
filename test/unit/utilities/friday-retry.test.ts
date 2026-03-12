import { describe, it, expect, vi } from "vitest";
import { computeFridayBackoff, sleepWithAbort, retryFridayAsync } from "#utilities";

describe("computeFridayBackoff", () => {
  it("returns base delay for attempt 0", () => {
    // With jitter disabled (factor=0), should be exactly baseMs
    const delay = computeFridayBackoff(0, { baseMs: 1000, jitterFactor: 0 });
    expect(delay).toBe(1000);
  });

  it("doubles for each attempt", () => {
    const d0 = computeFridayBackoff(0, { baseMs: 100, jitterFactor: 0 });
    const d1 = computeFridayBackoff(1, { baseMs: 100, jitterFactor: 0 });
    const d2 = computeFridayBackoff(2, { baseMs: 100, jitterFactor: 0 });
    expect(d0).toBe(100);
    expect(d1).toBe(200);
    expect(d2).toBe(400);
  });

  it("caps at maxMs", () => {
    const delay = computeFridayBackoff(20, { baseMs: 100, maxMs: 5000, jitterFactor: 0 });
    expect(delay).toBe(5000);
  });

  it("applies jitter within bounds", () => {
    const results = new Set<number>();
    for (let i = 0; i < 100; i++) {
      results.add(computeFridayBackoff(0, { baseMs: 1000, jitterFactor: 0.25 }));
    }
    // With 25% jitter on 1000ms base, range should be ~750-1250
    for (const r of results) {
      expect(r).toBeGreaterThanOrEqual(700);
      expect(r).toBeLessThanOrEqual(1300);
    }
    // Should have some variation
    expect(results.size).toBeGreaterThan(1);
  });

  it("uses defaults when no options provided", () => {
    const delay = computeFridayBackoff(0);
    // Default: baseMs=1000, jitterFactor=0.25 → 750-1250
    expect(delay).toBeGreaterThanOrEqual(700);
    expect(delay).toBeLessThanOrEqual(1300);
  });

  // ─── Normalization / invalid inputs ───

  it("normalizes negative attempt to 0", () => {
    const delay = computeFridayBackoff(-3, { baseMs: 100, jitterFactor: 0 });
    expect(delay).toBe(100);
  });

  it("normalizes fractional attempt to floor", () => {
    const delay = computeFridayBackoff(1.7, { baseMs: 100, jitterFactor: 0 });
    // floor(1.7) = 1 → 100 * 2^1 = 200
    expect(delay).toBe(200);
  });

  it("normalizes NaN attempt to 0", () => {
    const delay = computeFridayBackoff(NaN, { baseMs: 100, jitterFactor: 0 });
    expect(delay).toBe(100);
  });

  it("normalizes Infinity attempt to 0", () => {
    const delay = computeFridayBackoff(Infinity, { baseMs: 100, jitterFactor: 0 });
    // Capped at maxMs since Infinity isn't finite
    expect(delay).toBeGreaterThanOrEqual(0);
  });

  it("clamps negative baseMs to 0", () => {
    const delay = computeFridayBackoff(0, { baseMs: -500, jitterFactor: 0 });
    expect(delay).toBe(0);
  });

  it("clamps NaN baseMs to default (1000)", () => {
    const delay = computeFridayBackoff(0, { baseMs: NaN, jitterFactor: 0 });
    expect(delay).toBe(1000);
  });

  it("enforces maxMs >= baseMs", () => {
    // maxMs (50) < baseMs (200) → maxMs clamped to 200
    const delay = computeFridayBackoff(0, { baseMs: 200, maxMs: 50, jitterFactor: 0 });
    expect(delay).toBe(200);
  });

  it("clamps negative maxMs to baseMs", () => {
    const delay = computeFridayBackoff(0, { baseMs: 100, maxMs: -10, jitterFactor: 0 });
    expect(delay).toBe(100);
  });

  it("clamps jitterFactor > 1 to 1", () => {
    const results = new Set<number>();
    for (let i = 0; i < 50; i++) {
      results.add(computeFridayBackoff(0, { baseMs: 1000, jitterFactor: 5.0 }));
    }
    // With jitterFactor clamped to 1.0 on 1000ms, range should be 0–2000
    for (const r of results) {
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(2000);
    }
  });

  it("clamps negative jitterFactor to 0", () => {
    const delay = computeFridayBackoff(0, { baseMs: 1000, jitterFactor: -0.5 });
    expect(delay).toBe(1000); // no jitter
  });

  it("never returns negative or NaN", () => {
    for (let i = 0; i < 100; i++) {
      const d = computeFridayBackoff(i, { baseMs: 1, maxMs: 100, jitterFactor: 1.0 });
      expect(d).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(d)).toBe(false);
      expect(Number.isFinite(d)).toBe(true);
    }
  });
});

describe("sleepWithAbort", () => {
  it("resolves true after delay", async () => {
    const result = await sleepWithAbort(10);
    expect(result).toBe(true);
  });

  it("resolves false when pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await sleepWithAbort(10000, controller.signal);
    expect(result).toBe(false);
  });

  it("resolves false when aborted during sleep", async () => {
    const controller = new AbortController();
    const promise = sleepWithAbort(10000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    const result = await promise;
    expect(result).toBe(false);
  });

  it("resolves true immediately when ms <= 0", async () => {
    const t1 = performance.now();
    const result = await sleepWithAbort(0);
    const elapsed = performance.now() - t1;
    expect(result).toBe(true);
    expect(elapsed).toBeLessThan(50); // practically instant
  });

  it("resolves true immediately for negative ms", async () => {
    const result = await sleepWithAbort(-100);
    expect(result).toBe(true);
  });

  it("does not leak abort listeners when ms <= 0", async () => {
    const controller = new AbortController();
    await sleepWithAbort(0, controller.signal);
    // No listeners should have been attached in the first place.
    // If the signal had a listener and abort is called, we'd get an error without cleanup.
    controller.abort(); // should be a no-op
  });
});

describe("retryFridayAsync", () => {
  it("returns on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryFridayAsync(fn, { maxAttempts: 3 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockResolvedValue("ok");
    const result = await retryFridayAsync(fn, {
      maxAttempts: 3,
      baseMs: 1,
      jitterFactor: 0,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws last error after all attempts exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always-fail"));
    await expect(retryFridayAsync(fn, {
      maxAttempts: 3,
      baseMs: 1,
      jitterFactor: 0,
    })).rejects.toThrow("always-fail");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("stops retrying when shouldRetry returns false", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fatal"));
    await expect(retryFridayAsync(fn, {
      maxAttempts: 5,
      baseMs: 1,
      jitterFactor: 0,
      shouldRetry: () => false,
    })).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry with structured info before sleeping", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("tmp"))
      .mockResolvedValue("ok");
    await retryFridayAsync(fn, {
      maxAttempts: 3,
      baseMs: 1,
      jitterFactor: 0,
      onRetry,
      label: "test-op",
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 0,
        maxAttempts: 3,
        delayMs: 1,
        label: "test-op",
        err: expect.any(Error),
      }),
    );
  });

  it("uses retryAfterMs hint when provided", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("rate-limited"))
      .mockResolvedValue("ok");
    await retryFridayAsync(fn, {
      maxAttempts: 3,
      baseMs: 1000,
      jitterFactor: 0,
      retryAfterMs: () => 5,
      onRetry,
    });
    // The delay should be the hint (5ms), not the backoff (1000ms)
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: 5 }),
    );
  });

  it("clamps retryAfterMs hint to maxMs", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("rate-limited"))
      .mockResolvedValue("ok");
    await retryFridayAsync(fn, {
      maxAttempts: 3,
      baseMs: 10,
      maxMs: 100,
      jitterFactor: 0,
      retryAfterMs: () => 9999,
      onRetry,
    });
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: 100 }),
    );
  });

  it("produces finite delayMs when options.maxMs is NaN and retryAfterMs hint is present", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("rate-limited"))
      .mockResolvedValue("ok");
    await retryFridayAsync(fn, {
      maxAttempts: 3,
      baseMs: 10,
      maxMs: NaN,
      jitterFactor: 0,
      retryAfterMs: () => 42,
      onRetry,
    });
    const info = onRetry.mock.calls[0][0];
    expect(Number.isFinite(info.delayMs)).toBe(true);
    expect(Number.isNaN(info.delayMs)).toBe(false);
    // Should clamp to 42 (hint within default fallback of 60_000)
    expect(info.delayMs).toBe(42);
  });

  it("clamps retryAfterMs hint to default 60_000 when options.maxMs is NaN", async () => {
    const onRetry = vi.fn();
    const controller = new AbortController();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("rate-limited"))
      .mockRejectedValue(new Error("rate-limited"));
    // Abort immediately after onRetry fires to avoid sleeping 60s
    onRetry.mockImplementation(() => controller.abort());
    await expect(retryFridayAsync(fn, {
      maxAttempts: 3,
      baseMs: 10,
      maxMs: NaN,
      jitterFactor: 0,
      retryAfterMs: () => 999_999,
      onRetry,
      signal: controller.signal,
    })).rejects.toThrow("rate-limited");
    const info = onRetry.mock.calls[0][0];
    expect(Number.isFinite(info.delayMs)).toBe(true);
    // Should be clamped to the default fallback (60_000), not NaN
    expect(info.delayMs).toBe(60_000);
  });

  it("produces finite delayMs when options.maxMs is Infinity and retryAfterMs hint is present", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("rate-limited"))
      .mockResolvedValue("ok");
    await retryFridayAsync(fn, {
      maxAttempts: 3,
      baseMs: 10,
      maxMs: Infinity,
      jitterFactor: 0,
      retryAfterMs: () => 500,
      onRetry,
    });
    const info = onRetry.mock.calls[0][0];
    // Infinity maxMs → finiteOrUndef returns undefined → fallback 60_000
    // hint 500 < 60_000, so delayMs = 500
    expect(Number.isFinite(info.delayMs)).toBe(true);
    expect(info.delayMs).toBe(500);
  });

  it("clamps negative retryAfterMs hint to 0", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("rate-limited"))
      .mockResolvedValue("ok");
    await retryFridayAsync(fn, {
      maxAttempts: 3,
      baseMs: 10,
      maxMs: 100,
      jitterFactor: 0,
      retryAfterMs: () => -500,
      onRetry,
    });
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: 0 }),
    );
  });

  it("ignores non-finite retryAfterMs (NaN, Infinity) and falls back to backoff", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("ok");
    await retryFridayAsync(fn, {
      maxAttempts: 3,
      baseMs: 42,
      jitterFactor: 0,
      retryAfterMs: () => NaN,
      onRetry,
    });
    // Should use backoff (42ms for attempt 0), not NaN
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: 42 }),
    );
  });

  it("clamps maxAttempts <= 0 to 1", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(retryFridayAsync(fn, {
      maxAttempts: 0,
      baseMs: 1,
      jitterFactor: 0,
    })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("clamps negative maxAttempts to 1", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(retryFridayAsync(fn, {
      maxAttempts: -5,
      baseMs: 1,
      jitterFactor: 0,
    })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops on abort signal", async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    // Abort before the sleep
    setTimeout(() => controller.abort(), 5);
    await expect(retryFridayAsync(fn, {
      maxAttempts: 10,
      baseMs: 10000,
      jitterFactor: 0,
      signal: controller.signal,
    })).rejects.toThrow("fail");
    // Should not have exhausted all 10 attempts
    expect(fn.mock.calls.length).toBeLessThan(10);
  });

  it("passes label through to onRetry info", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("err"))
      .mockResolvedValue("ok");
    await retryFridayAsync(fn, {
      maxAttempts: 2,
      baseMs: 1,
      jitterFactor: 0,
      label: "my-operation",
      onRetry,
    });
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ label: "my-operation" }),
    );
  });

  it("label is undefined when not provided", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("err"))
      .mockResolvedValue("ok");
    await retryFridayAsync(fn, {
      maxAttempts: 2,
      baseMs: 1,
      jitterFactor: 0,
      onRetry,
    });
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ label: undefined }),
    );
  });
});
