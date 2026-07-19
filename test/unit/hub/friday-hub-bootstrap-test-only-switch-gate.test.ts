import { describe, it, expect } from "vitest";
import { resolveFridayHubConfig } from "#hub";
import type { FridayHubConfig } from "#hub";

/**
 * ART-NONPROD-001 (P0) — a test/mock activation switch must NOT be activatable
 * in the default/production (release) path.
 *
 * `resolveFridayHubConfig` honors the ENV-sourced test-only switches
 * `FRIDAY_ALLOW_TEST_ONLY_PLUGIN_EXECUTION` and
 * `FRIDAY_ALLOW_TEST_ONLY_AUTONOMY_LIFECYCLE_EXECUTION` (which drive
 * `pluginRuntimeMode = "full"`). In a protected profile (NODE_ENV=production or
 * FRIDAY_RELEASE_TAG set) they must FAIL CLOSED (throw), not activate.
 *
 * `resolveFridayHubConfig` is pure w.r.t. the passed `env` (it never reads
 * process.env for these flags), so these cases need no process.env mutation.
 */

function makeConfig(overrides: Partial<FridayHubConfig> = {}): FridayHubConfig {
  return {
    skillDirs: [],
    ...overrides,
  };
}

const GATE_MESSAGE = /cannot be enabled in production\/release profiles/;

describe("resolveFridayHubConfig test-only switch protected-profile gate", () => {
  // ─── FRIDAY_ALLOW_TEST_ONLY_PLUGIN_EXECUTION ───

  it("throws when the plugin-execution switch is set with NODE_ENV=production", () => {
    expect(() =>
      resolveFridayHubConfig(makeConfig(), {
        NODE_ENV: "production",
        FRIDAY_PLUGIN_RUNTIME_MODE: "full",
        FRIDAY_ALLOW_TEST_ONLY_PLUGIN_EXECUTION: "1",
      }),
    ).toThrow(GATE_MESSAGE);
    expect(() =>
      resolveFridayHubConfig(makeConfig(), {
        NODE_ENV: "production",
        FRIDAY_ALLOW_TEST_ONLY_PLUGIN_EXECUTION: "1",
      }),
    ).toThrow(/FRIDAY_ALLOW_TEST_ONLY_PLUGIN_EXECUTION/);
  });

  it("throws when the plugin-execution switch is set with a release tag", () => {
    expect(() =>
      resolveFridayHubConfig(makeConfig(), {
        FRIDAY_RELEASE_TAG: "v1.2.3",
        FRIDAY_ALLOW_TEST_ONLY_PLUGIN_EXECUTION: "true",
      }),
    ).toThrow(GATE_MESSAGE);
  });

  it("still activates the plugin-execution switch in a non-protected (dev/test) profile", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), {
      FRIDAY_PLUGIN_RUNTIME_MODE: "full",
      FRIDAY_ALLOW_TEST_ONLY_PLUGIN_EXECUTION: "1",
    });
    expect(resolved.allowTestOnlyPluginExecution).toBe(true);
    expect(resolved.pluginRuntimeMode).toBe("full");
  });

  it("does not throw when the plugin-execution switch is absent in production", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), { NODE_ENV: "production" });
    expect(resolved.allowTestOnlyPluginExecution).toBeUndefined();
    expect(resolved.pluginRuntimeMode).toBe("stub");
  });

  // ─── FRIDAY_ALLOW_TEST_ONLY_AUTONOMY_LIFECYCLE_EXECUTION ───

  it("throws when the autonomy-lifecycle switch is set with NODE_ENV=production", () => {
    expect(() =>
      resolveFridayHubConfig(makeConfig(), {
        NODE_ENV: "production",
        FRIDAY_ALLOW_TEST_ONLY_AUTONOMY_LIFECYCLE_EXECUTION: "1",
      }),
    ).toThrow(/FRIDAY_ALLOW_TEST_ONLY_AUTONOMY_LIFECYCLE_EXECUTION/);
  });

  it("throws when the autonomy-lifecycle switch is set with a release tag", () => {
    expect(() =>
      resolveFridayHubConfig(makeConfig(), {
        FRIDAY_RELEASE_TAG: "2026.07.19",
        FRIDAY_ALLOW_TEST_ONLY_AUTONOMY_LIFECYCLE_EXECUTION: "true",
      }),
    ).toThrow(GATE_MESSAGE);
  });

  it("still activates the autonomy-lifecycle switch in a non-protected (dev/test) profile", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), {
      FRIDAY_ALLOW_TEST_ONLY_AUTONOMY_LIFECYCLE_EXECUTION: "1",
    });
    expect(resolved.allowTestOnlyAutonomyLifecycleExecution).toBe(true);
  });

  // ─── Defense-in-depth: explicit config boolean is also refused ───

  it("throws when an explicit config allowTestOnlyPluginExecution=true is used in production", () => {
    expect(() =>
      resolveFridayHubConfig(
        makeConfig({ pluginRuntimeMode: "full", allowTestOnlyPluginExecution: true }),
        { NODE_ENV: "production" },
      ),
    ).toThrow(GATE_MESSAGE);
  });

  it("throws when an explicit config allowTestOnlyAutonomyLifecycleExecution=true is used with a release tag", () => {
    expect(() =>
      resolveFridayHubConfig(
        makeConfig({ allowTestOnlyAutonomyLifecycleExecution: true }),
        { FRIDAY_RELEASE_TAG: "v9.9.9" },
      ),
    ).toThrow(GATE_MESSAGE);
  });

  it("still honors an explicit config test-only flag in a non-protected profile", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig({ pluginRuntimeMode: "full", allowTestOnlyPluginExecution: true }),
      {},
    );
    expect(resolved.allowTestOnlyPluginExecution).toBe(true);
    expect(resolved.pluginRuntimeMode).toBe("full");
  });
});
