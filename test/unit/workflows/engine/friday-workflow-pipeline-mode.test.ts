import { describe, expect, it, vi } from "vitest";

import {
  resolveFridayPipelineRetryConfig,
  resolveFridayPipelineRuntimeConfig,
} from "#workflows";

describe("resolveFridayPipelineRuntimeConfig", () => {
  it("defaults to enabled enforce mode", () => {
    const resolved = resolveFridayPipelineRuntimeConfig({});
    expect(resolved).toEqual({
      enabled: true,
      mode: "enforce",
    });
  });

  it("parses disabled flag variants", () => {
    expect(resolveFridayPipelineRuntimeConfig({ FRIDAY_PIPELINE_ENABLE: "false" }).enabled).toBe(false);
    expect(resolveFridayPipelineRuntimeConfig({ FRIDAY_PIPELINE_ENABLE: "0" }).enabled).toBe(false);
    expect(resolveFridayPipelineRuntimeConfig({ FRIDAY_PIPELINE_ENABLE: "off" }).enabled).toBe(false);
    expect(resolveFridayPipelineRuntimeConfig({ FRIDAY_PIPELINE_ENABLE: "no" }).enabled).toBe(false);
  });

  it("parses valid mode values case-insensitively", () => {
    expect(resolveFridayPipelineRuntimeConfig({ FRIDAY_PIPELINE_MODE: "shadow" }).mode).toBe("shadow");
    expect(resolveFridayPipelineRuntimeConfig({ FRIDAY_PIPELINE_MODE: "WARN" }).mode).toBe("warn");
    expect(resolveFridayPipelineRuntimeConfig({ FRIDAY_PIPELINE_MODE: "EnFoRcE" }).mode).toBe("enforce");
  });

  it("falls back to enforce for invalid mode and warns once", () => {
    const warn = vi.fn();
    const resolved = resolveFridayPipelineRuntimeConfig(
      { FRIDAY_PIPELINE_MODE: "invalid-mode" },
      warn,
    );

    expect(resolved.mode).toBe("enforce");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("Invalid FRIDAY_PIPELINE_MODE");
  });
});

describe("resolveFridayPipelineRetryConfig", () => {
  it("returns defaults when no env is provided", () => {
    const resolved = resolveFridayPipelineRetryConfig({});
    expect(resolved).toEqual({
      maxAttempts: 3,
      baseDelayMs: 1_000,
      retryBudgetMax: 10,
      circuitBreakerThreshold: 5,
    });
  });

  it("parses positive integer env values", () => {
    const resolved = resolveFridayPipelineRetryConfig({
      FRIDAY_PIPELINE_RETRY_MAX_ATTEMPTS: "6",
      FRIDAY_PIPELINE_RETRY_BASE_DELAY_MS: "250",
      FRIDAY_PIPELINE_RETRY_BUDGET_MAX: "42",
      FRIDAY_PIPELINE_RETRY_CIRCUIT_THRESHOLD: "9",
    });

    expect(resolved).toEqual({
      maxAttempts: 6,
      baseDelayMs: 250,
      retryBudgetMax: 42,
      circuitBreakerThreshold: 9,
    });
  });

  it("supports override defaults for deterministic runtime", () => {
    const resolved = resolveFridayPipelineRetryConfig(
      {},
      { retryBudgetMax: 20 },
    );
    expect(resolved.retryBudgetMax).toBe(20);
  });

  it("falls back to defaults for invalid values and warns", () => {
    const warn = vi.fn();
    const resolved = resolveFridayPipelineRetryConfig(
      {
        FRIDAY_PIPELINE_RETRY_MAX_ATTEMPTS: "0",
        FRIDAY_PIPELINE_RETRY_BASE_DELAY_MS: "-1",
        FRIDAY_PIPELINE_RETRY_BUDGET_MAX: "abc",
        FRIDAY_PIPELINE_RETRY_CIRCUIT_THRESHOLD: "",
      },
      {},
      warn,
    );

    expect(resolved).toEqual({
      maxAttempts: 3,
      baseDelayMs: 1_000,
      retryBudgetMax: 10,
      circuitBreakerThreshold: 5,
    });
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("FRIDAY_PIPELINE_RETRY_MAX_ATTEMPTS");
  });
});
