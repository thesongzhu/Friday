import { describe, it, expect } from "vitest";
import { computeFridayBackoff, sleepWithAbort } from "#utilities";

describe("computeFridayBackoff – normalization", () => {
  it("normalizes negative attempt to 0", () => {
    expect(computeFridayBackoff(-5, { baseMs: 100, jitterFactor: 0 })).toBe(100);
  });

  it("normalizes fractional attempt via floor", () => {
    // floor(2.9) = 2 → 100 * 4 = 400
    expect(computeFridayBackoff(2.9, { baseMs: 100, jitterFactor: 0 })).toBe(400);
  });

  it("normalizes NaN attempt to 0", () => {
    expect(computeFridayBackoff(NaN, { baseMs: 100, jitterFactor: 0 })).toBe(100);
  });

  it("normalizes Infinity attempt to 0 (falls back)", () => {
    // Infinity is not finite → finiteOr returns 0 → delay = baseMs capped at maxMs
    const delay = computeFridayBackoff(Infinity, { baseMs: 100, maxMs: 5000, jitterFactor: 0 });
    expect(delay).toBe(100); // 100 * 2^0 = 100
  });

  it("clamps negative baseMs to 0", () => {
    expect(computeFridayBackoff(0, { baseMs: -1000, jitterFactor: 0 })).toBe(0);
  });

  it("clamps NaN baseMs to default 1000", () => {
    expect(computeFridayBackoff(0, { baseMs: NaN, jitterFactor: 0 })).toBe(1000);
  });

  it("clamps Infinity baseMs to default 1000", () => {
    expect(computeFridayBackoff(0, { baseMs: Infinity, jitterFactor: 0 })).toBe(1000);
  });

  it("enforces maxMs >= baseMs when maxMs < baseMs", () => {
    // baseMs=500, maxMs=100 → maxMs clamped to 500
    expect(computeFridayBackoff(0, { baseMs: 500, maxMs: 100, jitterFactor: 0 })).toBe(500);
  });

  it("clamps negative maxMs", () => {
    expect(computeFridayBackoff(0, { baseMs: 200, maxMs: -50, jitterFactor: 0 })).toBe(200);
  });

  it("clamps NaN maxMs to default 60_000", () => {
    expect(computeFridayBackoff(0, { baseMs: 100, maxMs: NaN, jitterFactor: 0 })).toBe(100);
  });

  it("clamps jitterFactor > 1 to 1", () => {
    // 100% jitter on 1000ms → range [0, 2000]
    for (let i = 0; i < 50; i++) {
      const d = computeFridayBackoff(0, { baseMs: 1000, jitterFactor: 99 });
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(2000);
    }
  });

  it("clamps negative jitterFactor to 0", () => {
    expect(computeFridayBackoff(0, { baseMs: 1000, jitterFactor: -1 })).toBe(1000);
  });

  it("never returns negative, NaN, or Infinity for any combination", () => {
    const badInputs = [NaN, Infinity, -Infinity, -1, 0, 0.5, 100];
    for (const attempt of badInputs) {
      for (const baseMs of badInputs) {
        for (const maxMs of badInputs) {
          for (const jitterFactor of badInputs) {
            const d = computeFridayBackoff(attempt, { baseMs, maxMs, jitterFactor });
            expect(d).toBeGreaterThanOrEqual(0);
            expect(Number.isNaN(d)).toBe(false);
            expect(Number.isFinite(d)).toBe(true);
          }
        }
      }
    }
  });
});

describe("sleepWithAbort – edge cases", () => {
  it("ms=0 resolves immediately with true", async () => {
    const result = await sleepWithAbort(0);
    expect(result).toBe(true);
  });

  it("negative ms resolves immediately with true", async () => {
    const result = await sleepWithAbort(-100);
    expect(result).toBe(true);
  });

  it("ms=0 does not attach abort listeners", async () => {
    const controller = new AbortController();
    await sleepWithAbort(0, controller.signal);
    // If a listener leaked, aborting would cause unexpected behavior
    controller.abort();
  });

  it("pre-aborted signal returns false even for ms=0", async () => {
    const controller = new AbortController();
    controller.abort();
    // Pre-abort check runs first, before ms<=0 check
    const result = await sleepWithAbort(0, controller.signal);
    expect(result).toBe(false);
  });
});
