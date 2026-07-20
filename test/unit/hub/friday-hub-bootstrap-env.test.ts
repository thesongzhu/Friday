import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
import {
  resolveAgentRunControlViaRust,
  resolveFridayCanonicalMutatingActionGate,
  resolveFridayHubConfig,
  resolveRouteAgentRunViaRust,
  resolveRouteSessionsViaRust,
  resolveRouteMissionSpineViaRust,
  resolveRouteMemorySpineViaRust,
  resolveRouteRunOutcomeLearningViaRust,
  resolveMissionAutoDispatch,
  resolveRouteProvidersViaRust,
  resolveRouteWorkflowRunsViaRust,
  resolveRouteWorkflowsViaRust,
} from "#hub";
import type { FridayHubConfig } from "#hub";

// ─── Helpers ───

const require = createRequire(import.meta.url);
const PACKAGE_VERSION = (require("../../../package.json") as { version: string }).version;

function makeConfig(overrides: Partial<FridayHubConfig> = {}): FridayHubConfig {
  return {
    skillDirs: [],
    ...overrides,
  };
}

function emptyEnv(): NodeJS.ProcessEnv {
  return {};
}

// ─── Tests ───

describe("resolveFridayHubConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Port ───

  it("defaults port to 3141", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), emptyEnv());
    expect(resolved.port).toBe(3141);
  });

  it("uses explicit port over env and default", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig({ port: 8080 }),
      { FRIDAY_PORT: "9090" },
    );
    expect(resolved.port).toBe(8080);
  });

  it("uses FRIDAY_PORT env when no explicit port", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig(),
      { FRIDAY_PORT: "5555" },
    );
    expect(resolved.port).toBe(5555);
  });

  it("rejects malformed FRIDAY_PORT env values instead of truncating numeric prefixes", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig(),
      { FRIDAY_PORT: "123abc" },
    );
    expect(resolved.port).toBe(3141);
  });

  // ─── State dir ───

  it("defaults stateDir to undefined", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), emptyEnv());
    expect(resolved.stateDir).toBeUndefined();
  });

  it("uses explicit stateDir over env", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig({ stateDir: "/explicit" }),
      { FRIDAY_STATE_DIR: "/env" },
    );
    expect(resolved.stateDir).toBe("/explicit");
  });

  it("uses FRIDAY_STATE_DIR env when no explicit stateDir", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig(),
      { FRIDAY_STATE_DIR: "/from-env" },
    );
    expect(resolved.stateDir).toBe("/from-env");
  });

  // ─── Skill dirs ───

  it("defaults skillDirs to ['skills', 'managed-skills']", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), emptyEnv());
    expect(resolved.skillDirs).toEqual(["skills", "managed-skills"]);
  });

  it("uses explicit skillDirs over env", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig({ skillDirs: ["my-skills"] }),
      { FRIDAY_SKILLS_DIR: "env-skills" },
    );
    expect(resolved.skillDirs).toEqual(["my-skills"]);
  });

  it("parses comma-separated FRIDAY_SKILLS_DIR", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig(),
      { FRIDAY_SKILLS_DIR: "dir-a, dir-b , dir-c" },
    );
    expect(resolved.skillDirs).toEqual(["dir-a", "dir-b", "dir-c"]);
  });

  it("filters empty segments from FRIDAY_SKILLS_DIR", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig(),
      { FRIDAY_SKILLS_DIR: "dir-a,, ,dir-b" },
    );
    expect(resolved.skillDirs).toEqual(["dir-a", "dir-b"]);
  });

  // ─── Token secret ───

  it("generates a random tokenSecret when none provided", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = resolveFridayHubConfig(makeConfig(), emptyEnv());
    // Should be a 64-char hex string (32 random bytes)
    expect(resolved.tokenSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(resolved.tokenSecretSource).toMatch(/^(file|generated)$/);
  });

  it("uses explicit tokenSecret over env", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = resolveFridayHubConfig(
      makeConfig({ tokenSecret: "my-secret" }),
      { FRIDAY_TOKEN_SECRET: "env-secret" },
    );
    expect(resolved.tokenSecret).toBe("my-secret");
    expect(resolved.tokenSecretSource).toBe("config");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("uses FRIDAY_TOKEN_SECRET env when no explicit tokenSecret", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = resolveFridayHubConfig(
      makeConfig(),
      { FRIDAY_TOKEN_SECRET: "env-secret" },
    );
    expect(resolved.tokenSecret).toBe("env-secret");
    expect(resolved.tokenSecretSource).toBe("env");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("keeps workspaceRoot separate from stateDir when FRIDAY_WORKSPACE_ROOT is set", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig(),
      {
        FRIDAY_STATE_DIR: "/tmp/friday-state",
        FRIDAY_WORKSPACE_ROOT: "/repo/checkout",
      },
    );
    expect(resolved.stateDir).toBe("/tmp/friday-state");
    expect(resolved.workspaceRoot).toBe("/repo/checkout");
  });

  it("uses explicit workspaceRoot over env", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig({ workspaceRoot: "/explicit-workspace" }),
      { FRIDAY_WORKSPACE_ROOT: "/env-workspace" },
    );
    expect(resolved.workspaceRoot).toBe("/explicit-workspace");
  });

  it("defaults allowPrivateNetwork=false in dev mode", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), emptyEnv());
    expect(resolved.ssrfPolicy?.allowPrivateNetwork).toBe(false);
  });

  it("keeps allowPrivateNetwork=false in production by default", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), { NODE_ENV: "production" });
    expect(resolved.ssrfPolicy?.allowPrivateNetwork).toBe(false);
  });

  it("enables allowPrivateNetwork when FRIDAY_ALLOW_PRIVATE_NETWORK=true", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), { FRIDAY_ALLOW_PRIVATE_NETWORK: "true" });
    expect(resolved.ssrfPolicy?.allowPrivateNetwork).toBe(true);
  });

  it("enables allowPrivateNetwork when input ssrfPolicy explicitly opts in", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig({ ssrfPolicy: { allowPrivateNetwork: true } }),
      emptyEnv(),
    );
    expect(resolved.ssrfPolicy?.allowPrivateNetwork).toBe(true);
  });

  // ─── CORS origins ───

  it("defaults corsOrigins to [] (SEC-007: CORS disabled by default)", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), emptyEnv());
    expect(resolved.corsOrigins).toEqual([]);
  });

  it("uses explicit corsOrigins over env", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig({ corsOrigins: ["https://myapp.com"] }),
      { FRIDAY_CORS_ORIGINS: "https://env.com" },
    );
    expect(resolved.corsOrigins).toEqual(["https://myapp.com"]);
  });

  it("parses comma-separated FRIDAY_CORS_ORIGINS", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig(),
      { FRIDAY_CORS_ORIGINS: "https://a.com, https://b.com" },
    );
    expect(resolved.corsOrigins).toEqual(["https://a.com", "https://b.com"]);
  });

  it("allows wildcard CORS via explicit FRIDAY_CORS_ORIGINS env opt-in (SEC-007)", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig(),
      { FRIDAY_CORS_ORIGINS: "*" },
    );
    expect(resolved.corsOrigins).toEqual(["*"]);
  });

  it("allows empty corsOrigins to disable CORS", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig({ corsOrigins: [] }),
      emptyEnv(),
    );
    expect(resolved.corsOrigins).toEqual([]);
  });

  // ─── Log requests ───

  it("defaults logRequests to true", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), emptyEnv());
    expect(resolved.logRequests).toBe(true);
  });

  it("uses explicit logRequests over env", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig({ logRequests: false }),
      { FRIDAY_LOG_REQUESTS: "true" },
    );
    expect(resolved.logRequests).toBe(false);
  });

  it("parses FRIDAY_LOG_REQUESTS=false as false", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig(),
      { FRIDAY_LOG_REQUESTS: "false" },
    );
    expect(resolved.logRequests).toBe(false);
  });

  it("parses FRIDAY_LOG_REQUESTS=true as true", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig(),
      { FRIDAY_LOG_REQUESTS: "true" },
    );
    expect(resolved.logRequests).toBe(true);
  });

  // ─── Server version ───

  it("defaults serverVersion to package.json version", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), emptyEnv());
    expect(resolved.serverVersion).toBe(PACKAGE_VERSION);
  });

  it("uses explicit serverVersion", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig({ serverVersion: "2.0.0" }),
      emptyEnv(),
    );
    expect(resolved.serverVersion).toBe("2.0.0");
  });

  // ─── Plugin runtime mode ───

  it("defaults pluginRuntimeMode to stub", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), emptyEnv());
    expect(resolved.pluginRuntimeMode).toBe("stub");
  });

  it("uses explicit pluginRuntimeMode over env", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig({ pluginRuntimeMode: "stub" }),
      { FRIDAY_PLUGIN_RUNTIME_MODE: "full" },
    );
    expect(resolved.pluginRuntimeMode).toBe("stub");
  });

  it("keeps FRIDAY_PLUGIN_RUNTIME_MODE=stub from env", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), { FRIDAY_PLUGIN_RUNTIME_MODE: "stub" });
    expect(resolved.pluginRuntimeMode).toBe("stub");
  });

  it("ignores FRIDAY_PLUGIN_RUNTIME_MODE=full without a test-oracle plugin flag", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), { FRIDAY_PLUGIN_RUNTIME_MODE: "full" });
    expect(resolved.pluginRuntimeMode).toBe("stub");
  });

  it("allows pluginRuntimeMode full only with an explicit test-oracle plugin flag", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig({ pluginRuntimeMode: "full", allowTestOnlyPluginExecution: true }),
      emptyEnv(),
    );
    expect(resolved.pluginRuntimeMode).toBe("full");
  });

  it("maps closure scratch plugin lifecycle test-oracle env to explicit config flags", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), {
      FRIDAY_PLUGIN_RUNTIME_MODE: "full",
      FRIDAY_ALLOW_TEST_ONLY_PLUGIN_EXECUTION: "1",
      FRIDAY_ALLOW_TEST_ONLY_AUTONOMY_LIFECYCLE_EXECUTION: "1",
    });

    expect(resolved.allowTestOnlyPluginExecution).toBe(true);
    expect(resolved.allowTestOnlyAutonomyLifecycleExecution).toBe(true);
    expect(resolved.pluginRuntimeMode).toBe("full");
  });

  // ─── Deterministic pipeline mode ───

  it("defaults deterministic pipeline to enabled enforce mode", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), emptyEnv());
    expect(resolved.pipelineEnabled).toBe(true);
    expect(resolved.pipelineMode).toBe("enforce");
  });

  it("reads FRIDAY_PIPELINE_ENABLE and FRIDAY_PIPELINE_MODE", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), {
      FRIDAY_PIPELINE_ENABLE: "false",
      FRIDAY_PIPELINE_MODE: "shadow",
    });
    expect(resolved.pipelineEnabled).toBe(false);
    expect(resolved.pipelineMode).toBe("shadow");
  });

  // ─── Canonical mutating action gate ───

  it("keeps canonical mutating action gate off by default for dev/test lanes", () => {
    expect(resolveFridayCanonicalMutatingActionGate(emptyEnv())).toBe(false);
    expect(resolveFridayHubConfig(makeConfig(), emptyEnv()).canonicalMutatingActionGate).toBe(false);
    expect(resolveFridayCanonicalMutatingActionGate({ NODE_ENV: "test" })).toBe(false);
  });

  it("enables canonical mutating action gate when explicitly requested", () => {
    expect(resolveFridayCanonicalMutatingActionGate({ FRIDAY_CANONICAL_GATE: "true" })).toBe(true);
    expect(resolveFridayHubConfig(makeConfig(), { FRIDAY_CANONICAL_GATE: "1" }).canonicalMutatingActionGate).toBe(true);
  });

  it("enables canonical mutating action gate by default for production and release profiles", () => {
    expect(resolveFridayCanonicalMutatingActionGate({ NODE_ENV: "production" })).toBe(true);
    expect(resolveFridayCanonicalMutatingActionGate({ FRIDAY_RELEASE_TAG: "v1.2.3" })).toBe(true);
  });

  it("fails closed when production or release profiles explicitly disable canonical gate", () => {
    expect(() => resolveFridayCanonicalMutatingActionGate({
      NODE_ENV: "production",
      FRIDAY_CANONICAL_GATE: "false",
    })).toThrow(/cannot be disabled/);
    expect(() => resolveFridayCanonicalMutatingActionGate({
      FRIDAY_RELEASE_TAG: "v1.2.3",
      FRIDAY_CANONICAL_GATE: "off",
    })).toThrow(/cannot be disabled/);
  });

  it("rejects invalid canonical gate env values", () => {
    expect(() => resolveFridayCanonicalMutatingActionGate({
      FRIDAY_CANONICAL_GATE: "sometimes",
    })).toThrow(/Invalid FRIDAY_CANONICAL_GATE/);
  });
});

// ─── execrun slice 4: routeAgentRunViaRust env knob (DARK, default-off) ───

describe("resolveRouteAgentRunViaRust", () => {
  // DEFAULT-OFF: env unset (nothing set) → false → byte-identical to today's gated-off 503.
  it("defaults to false when neither config nor env is set", () => {
    expect(resolveRouteAgentRunViaRust(undefined, emptyEnv())).toBe(false);
  });

  it("parses FRIDAY_ROUTE_AGENT_RUN_VIA_RUST=1 as true", () => {
    expect(resolveRouteAgentRunViaRust(undefined, { FRIDAY_ROUTE_AGENT_RUN_VIA_RUST: "1" })).toBe(true);
  });

  it("parses FRIDAY_ROUTE_AGENT_RUN_VIA_RUST=true as true", () => {
    expect(resolveRouteAgentRunViaRust(undefined, { FRIDAY_ROUTE_AGENT_RUN_VIA_RUST: "true" })).toBe(true);
  });

  it("parses the env case-insensitively (TRUE, True) and trims surrounding whitespace", () => {
    expect(resolveRouteAgentRunViaRust(undefined, { FRIDAY_ROUTE_AGENT_RUN_VIA_RUST: "TRUE" })).toBe(true);
    expect(resolveRouteAgentRunViaRust(undefined, { FRIDAY_ROUTE_AGENT_RUN_VIA_RUST: "True" })).toBe(true);
    expect(resolveRouteAgentRunViaRust(undefined, { FRIDAY_ROUTE_AGENT_RUN_VIA_RUST: "  1  " })).toBe(true);
    expect(resolveRouteAgentRunViaRust(undefined, { FRIDAY_ROUTE_AGENT_RUN_VIA_RUST: " true " })).toBe(true);
  });

  // Fail-safe OFF: everything that is not exactly "1"/"true" → false.
  it("treats 0, false, empty, and garbage env values as false (fail-safe off)", () => {
    expect(resolveRouteAgentRunViaRust(undefined, { FRIDAY_ROUTE_AGENT_RUN_VIA_RUST: "0" })).toBe(false);
    expect(resolveRouteAgentRunViaRust(undefined, { FRIDAY_ROUTE_AGENT_RUN_VIA_RUST: "false" })).toBe(false);
    expect(resolveRouteAgentRunViaRust(undefined, { FRIDAY_ROUTE_AGENT_RUN_VIA_RUST: "" })).toBe(false);
    expect(resolveRouteAgentRunViaRust(undefined, { FRIDAY_ROUTE_AGENT_RUN_VIA_RUST: "yes" })).toBe(false);
    expect(resolveRouteAgentRunViaRust(undefined, { FRIDAY_ROUTE_AGENT_RUN_VIA_RUST: "on" })).toBe(false);
    expect(resolveRouteAgentRunViaRust(undefined, { FRIDAY_ROUTE_AGENT_RUN_VIA_RUST: "enabled" })).toBe(false);
    expect(resolveRouteAgentRunViaRust(undefined, { FRIDAY_ROUTE_AGENT_RUN_VIA_RUST: "truthy" })).toBe(false);
    expect(resolveRouteAgentRunViaRust(undefined, { FRIDAY_ROUTE_AGENT_RUN_VIA_RUST: "2" })).toBe(false);
  });

  // PRECEDENCE: an explicit config boolean ALWAYS wins over the env.
  it("uses explicit config true over the env (even when env says false)", () => {
    expect(resolveRouteAgentRunViaRust(true, { FRIDAY_ROUTE_AGENT_RUN_VIA_RUST: "false" })).toBe(true);
    expect(resolveRouteAgentRunViaRust(true, { FRIDAY_ROUTE_AGENT_RUN_VIA_RUST: "0" })).toBe(true);
    expect(resolveRouteAgentRunViaRust(true, emptyEnv())).toBe(true);
  });

  // The discriminating case: config=false MUST beat env=true (a `||` would wrongly return true here).
  it("uses explicit config false over the env (config false beats env true)", () => {
    expect(resolveRouteAgentRunViaRust(false, { FRIDAY_ROUTE_AGENT_RUN_VIA_RUST: "1" })).toBe(false);
    expect(resolveRouteAgentRunViaRust(false, { FRIDAY_ROUTE_AGENT_RUN_VIA_RUST: "true" })).toBe(false);
    expect(resolveRouteAgentRunViaRust(false, emptyEnv())).toBe(false);
  });
});

describe("resolveRouteSessionsViaRust (CORE-A CR-3 session bridge flag)", () => {
  // DEFAULT-OFF: env unset → false → the runtime threads no session bridge → today's fail-closed 503.
  it("defaults to false when neither config nor env is set", () => {
    expect(resolveRouteSessionsViaRust(undefined, emptyEnv())).toBe(false);
  });

  it("parses FRIDAY_ROUTE_SESSIONS_VIA_RUST=1 / =true (case-insensitive, trimmed) as true", () => {
    expect(resolveRouteSessionsViaRust(undefined, { FRIDAY_ROUTE_SESSIONS_VIA_RUST: "1" })).toBe(true);
    expect(resolveRouteSessionsViaRust(undefined, { FRIDAY_ROUTE_SESSIONS_VIA_RUST: "true" })).toBe(true);
    expect(resolveRouteSessionsViaRust(undefined, { FRIDAY_ROUTE_SESSIONS_VIA_RUST: "TRUE" })).toBe(true);
    expect(resolveRouteSessionsViaRust(undefined, { FRIDAY_ROUTE_SESSIONS_VIA_RUST: "  True  " })).toBe(true);
  });

  // Fail-safe OFF: everything that is not exactly "1"/"true" → false (NARROWER than the canonical gate).
  it("treats 0, false, empty, and garbage env values as false (fail-safe off)", () => {
    expect(resolveRouteSessionsViaRust(undefined, { FRIDAY_ROUTE_SESSIONS_VIA_RUST: "0" })).toBe(false);
    expect(resolveRouteSessionsViaRust(undefined, { FRIDAY_ROUTE_SESSIONS_VIA_RUST: "false" })).toBe(false);
    expect(resolveRouteSessionsViaRust(undefined, { FRIDAY_ROUTE_SESSIONS_VIA_RUST: "" })).toBe(false);
    expect(resolveRouteSessionsViaRust(undefined, { FRIDAY_ROUTE_SESSIONS_VIA_RUST: "yes" })).toBe(false);
    expect(resolveRouteSessionsViaRust(undefined, { FRIDAY_ROUTE_SESSIONS_VIA_RUST: "on" })).toBe(false);
    expect(resolveRouteSessionsViaRust(undefined, { FRIDAY_ROUTE_SESSIONS_VIA_RUST: "enabled" })).toBe(false);
  });

  // PRECEDENCE: an explicit config boolean ALWAYS wins over the env (the discriminating false case).
  it("uses explicit config over the env (config true beats env false; config false beats env true)", () => {
    expect(resolveRouteSessionsViaRust(true, { FRIDAY_ROUTE_SESSIONS_VIA_RUST: "false" })).toBe(true);
    expect(resolveRouteSessionsViaRust(true, emptyEnv())).toBe(true);
    expect(resolveRouteSessionsViaRust(false, { FRIDAY_ROUTE_SESSIONS_VIA_RUST: "1" })).toBe(false);
    expect(resolveRouteSessionsViaRust(false, { FRIDAY_ROUTE_SESSIONS_VIA_RUST: "true" })).toBe(false);
  });
});

describe("resolveAgentRunControlViaRust (A3 courier pause/resume flag)", () => {
  // DEFAULT-OFF: env unset → false → the courier's paused/resume behavior is inert (byte-identical).
  it("defaults to false when neither config nor env is set", () => {
    expect(resolveAgentRunControlViaRust(undefined, emptyEnv())).toBe(false);
  });

  it("parses FRIDAY_AGENT_RUN_CONTROL_VIA_RUST=1 / =true (case-insensitive, trimmed) as true", () => {
    expect(resolveAgentRunControlViaRust(undefined, { FRIDAY_AGENT_RUN_CONTROL_VIA_RUST: "1" })).toBe(true);
    expect(resolveAgentRunControlViaRust(undefined, { FRIDAY_AGENT_RUN_CONTROL_VIA_RUST: "true" })).toBe(true);
    expect(resolveAgentRunControlViaRust(undefined, { FRIDAY_AGENT_RUN_CONTROL_VIA_RUST: "TRUE" })).toBe(true);
    expect(resolveAgentRunControlViaRust(undefined, { FRIDAY_AGENT_RUN_CONTROL_VIA_RUST: "  1  " })).toBe(true);
    expect(resolveAgentRunControlViaRust(undefined, { FRIDAY_AGENT_RUN_CONTROL_VIA_RUST: " true " })).toBe(true);
  });

  // Fail-safe OFF: everything that is not exactly "1"/"true" → false (narrower than the canonical set).
  it("treats 0, false, empty, and garbage env values as false (fail-safe off)", () => {
    for (const raw of ["0", "false", "", "yes", "on", "enabled", "truthy", "2"]) {
      expect(resolveAgentRunControlViaRust(undefined, { FRIDAY_AGENT_RUN_CONTROL_VIA_RUST: raw })).toBe(false);
    }
  });

  // PRECEDENCE: an explicit config boolean ALWAYS wins over the env (config false MUST beat env true).
  it("uses explicit config over the env (true wins; the discriminating config=false beats env=true)", () => {
    expect(resolveAgentRunControlViaRust(true, { FRIDAY_AGENT_RUN_CONTROL_VIA_RUST: "0" })).toBe(true);
    expect(resolveAgentRunControlViaRust(true, emptyEnv())).toBe(true);
    expect(resolveAgentRunControlViaRust(false, { FRIDAY_AGENT_RUN_CONTROL_VIA_RUST: "1" })).toBe(false);
    expect(resolveAgentRunControlViaRust(false, { FRIDAY_AGENT_RUN_CONTROL_VIA_RUST: "true" })).toBe(false);
  });
});

describe("resolveRouteProvidersViaRust", () => {
  // DEFAULT-OFF: env unset (nothing set) → false → byte-identical to today's gated-off 503.
  it("defaults to false when neither config nor env is set", () => {
    expect(resolveRouteProvidersViaRust(undefined, emptyEnv())).toBe(false);
  });

  it("parses FRIDAY_ROUTE_PROVIDERS_VIA_RUST=1 / =true (case-insensitive, trimmed) as true", () => {
    expect(resolveRouteProvidersViaRust(undefined, { FRIDAY_ROUTE_PROVIDERS_VIA_RUST: "1" })).toBe(true);
    expect(resolveRouteProvidersViaRust(undefined, { FRIDAY_ROUTE_PROVIDERS_VIA_RUST: "true" })).toBe(true);
    expect(resolveRouteProvidersViaRust(undefined, { FRIDAY_ROUTE_PROVIDERS_VIA_RUST: "TRUE" })).toBe(true);
    expect(resolveRouteProvidersViaRust(undefined, { FRIDAY_ROUTE_PROVIDERS_VIA_RUST: " true " })).toBe(true);
  });

  // Fail-safe OFF: everything that is not exactly "1"/"true" → false.
  it("treats 0, false, empty, and garbage env values as false (fail-safe off)", () => {
    for (const raw of ["0", "false", "", "yes", "on", "enabled", "truthy", "2"]) {
      expect(resolveRouteProvidersViaRust(undefined, { FRIDAY_ROUTE_PROVIDERS_VIA_RUST: raw })).toBe(false);
    }
  });

  // PRECEDENCE: an explicit config boolean ALWAYS wins over the env.
  it("uses explicit config true over the env (even when env says false)", () => {
    expect(resolveRouteProvidersViaRust(true, { FRIDAY_ROUTE_PROVIDERS_VIA_RUST: "false" })).toBe(true);
    expect(resolveRouteProvidersViaRust(true, emptyEnv())).toBe(true);
  });

  // The discriminating case: config=false MUST beat env=true (a `||` would wrongly return true here).
  it("uses explicit config false over the env (config false beats env true)", () => {
    expect(resolveRouteProvidersViaRust(false, { FRIDAY_ROUTE_PROVIDERS_VIA_RUST: "1" })).toBe(false);
    expect(resolveRouteProvidersViaRust(false, emptyEnv())).toBe(false);
  });
});

// ─── Tier-2 workflow catalog-mutation route bridge: routeWorkflowsViaRust (DARK, default-off) ───

describe("resolveRouteWorkflowsViaRust", () => {
  // DEFAULT-OFF: nothing set → false → byte-identical to today's retirement 503.
  it("defaults to false when neither config nor env is set", () => {
    expect(resolveRouteWorkflowsViaRust(undefined, emptyEnv())).toBe(false);
  });

  it("parses FRIDAY_ROUTE_WORKFLOWS_VIA_RUST 1/true (case-insensitive, trimmed) as true", () => {
    expect(resolveRouteWorkflowsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOWS_VIA_RUST: "1" })).toBe(true);
    expect(resolveRouteWorkflowsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOWS_VIA_RUST: "true" })).toBe(true);
    expect(resolveRouteWorkflowsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOWS_VIA_RUST: "TRUE" })).toBe(true);
    expect(resolveRouteWorkflowsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOWS_VIA_RUST: "  1  " })).toBe(true);
    expect(resolveRouteWorkflowsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOWS_VIA_RUST: " true " })).toBe(true);
  });

  // Fail-safe OFF: everything that is not exactly "1"/"true" → false.
  it("treats 0, false, empty, and garbage env values as false (fail-safe off)", () => {
    expect(resolveRouteWorkflowsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOWS_VIA_RUST: "0" })).toBe(false);
    expect(resolveRouteWorkflowsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOWS_VIA_RUST: "false" })).toBe(false);
    expect(resolveRouteWorkflowsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOWS_VIA_RUST: "" })).toBe(false);
    expect(resolveRouteWorkflowsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOWS_VIA_RUST: "yes" })).toBe(false);
    expect(resolveRouteWorkflowsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOWS_VIA_RUST: "on" })).toBe(false);
    expect(resolveRouteWorkflowsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOWS_VIA_RUST: "2" })).toBe(false);
  });

  // PRECEDENCE: explicit config wins over env (true wins, AND the discriminating false-beats-env-true).
  it("uses explicit config over the env (true wins; false beats env true)", () => {
    expect(resolveRouteWorkflowsViaRust(true, { FRIDAY_ROUTE_WORKFLOWS_VIA_RUST: "0" })).toBe(true);
    expect(resolveRouteWorkflowsViaRust(true, emptyEnv())).toBe(true);
    expect(resolveRouteWorkflowsViaRust(false, { FRIDAY_ROUTE_WORKFLOWS_VIA_RUST: "1" })).toBe(false);
    expect(resolveRouteWorkflowsViaRust(false, { FRIDAY_ROUTE_WORKFLOWS_VIA_RUST: "true" })).toBe(false);
  });
});

// ─── Tier-2 workflow-run route bridge: routeWorkflowRunsViaRust (DARK, default-off) ───

describe("resolveRouteWorkflowRunsViaRust", () => {
  it("defaults to false when neither config nor env is set", () => {
    expect(resolveRouteWorkflowRunsViaRust(undefined, emptyEnv())).toBe(false);
  });

  it("parses FRIDAY_ROUTE_WORKFLOW_RUNS_VIA_RUST 1/true (case-insensitive, trimmed) as true", () => {
    expect(resolveRouteWorkflowRunsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOW_RUNS_VIA_RUST: "1" })).toBe(true);
    expect(resolveRouteWorkflowRunsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOW_RUNS_VIA_RUST: "true" })).toBe(true);
    expect(resolveRouteWorkflowRunsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOW_RUNS_VIA_RUST: "TRUE" })).toBe(true);
    expect(resolveRouteWorkflowRunsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOW_RUNS_VIA_RUST: "  1  " })).toBe(true);
  });

  it("treats 0, false, empty, and garbage env values as false (fail-safe off)", () => {
    expect(resolveRouteWorkflowRunsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOW_RUNS_VIA_RUST: "0" })).toBe(false);
    expect(resolveRouteWorkflowRunsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOW_RUNS_VIA_RUST: "false" })).toBe(false);
    expect(resolveRouteWorkflowRunsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOW_RUNS_VIA_RUST: "" })).toBe(false);
    expect(resolveRouteWorkflowRunsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOW_RUNS_VIA_RUST: "yes" })).toBe(false);
    expect(resolveRouteWorkflowRunsViaRust(undefined, { FRIDAY_ROUTE_WORKFLOW_RUNS_VIA_RUST: "on" })).toBe(false);
  });

  it("uses explicit config over the env (true wins; false beats env true)", () => {
    expect(resolveRouteWorkflowRunsViaRust(true, { FRIDAY_ROUTE_WORKFLOW_RUNS_VIA_RUST: "0" })).toBe(true);
    expect(resolveRouteWorkflowRunsViaRust(true, emptyEnv())).toBe(true);
    expect(resolveRouteWorkflowRunsViaRust(false, { FRIDAY_ROUTE_WORKFLOW_RUNS_VIA_RUST: "1" })).toBe(false);
    expect(resolveRouteWorkflowRunsViaRust(false, { FRIDAY_ROUTE_WORKFLOW_RUNS_VIA_RUST: "true" })).toBe(false);
  });
});

describe("resolveRouteMissionSpineViaRust (Lane B-2 organic POST routes flag)", () => {
  // DEFAULT-OFF: nothing set → false → missionSpine.dispatch stays null → byte-identical 503.
  it("defaults to false when neither config nor env is set", () => {
    expect(resolveRouteMissionSpineViaRust(undefined, emptyEnv())).toBe(false);
  });

  it("parses FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST 1/true (case-insensitive, trimmed) as true", () => {
    expect(resolveRouteMissionSpineViaRust(undefined, { FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST: "1" })).toBe(true);
    expect(resolveRouteMissionSpineViaRust(undefined, { FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST: "true" })).toBe(true);
    expect(resolveRouteMissionSpineViaRust(undefined, { FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST: "TRUE" })).toBe(true);
    expect(resolveRouteMissionSpineViaRust(undefined, { FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST: "  1  " })).toBe(true);
    expect(resolveRouteMissionSpineViaRust(undefined, { FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST: " true " })).toBe(true);
  });

  // Fail-safe OFF: everything that is not exactly "1"/"true" → false.
  it("treats 0, false, empty, and garbage env values as false (fail-safe off)", () => {
    expect(resolveRouteMissionSpineViaRust(undefined, { FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST: "0" })).toBe(false);
    expect(resolveRouteMissionSpineViaRust(undefined, { FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST: "false" })).toBe(false);
    expect(resolveRouteMissionSpineViaRust(undefined, { FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST: "" })).toBe(false);
    expect(resolveRouteMissionSpineViaRust(undefined, { FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST: "yes" })).toBe(false);
    expect(resolveRouteMissionSpineViaRust(undefined, { FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST: "on" })).toBe(false);
    expect(resolveRouteMissionSpineViaRust(undefined, { FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST: "2" })).toBe(false);
  });

  // PRECEDENCE: explicit config wins over env (true wins, AND the discriminating false-beats-env-true).
  it("uses explicit config over the env (true wins; false beats env true)", () => {
    expect(resolveRouteMissionSpineViaRust(true, { FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST: "0" })).toBe(true);
    expect(resolveRouteMissionSpineViaRust(true, emptyEnv())).toBe(true);
    expect(resolveRouteMissionSpineViaRust(false, { FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST: "1" })).toBe(false);
    expect(resolveRouteMissionSpineViaRust(false, { FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST: "true" })).toBe(false);
  });
});

describe("resolveRouteMemorySpineViaRust (Lane M organic memory-confirmation POST route flag)", () => {
  // DEFAULT-OFF: nothing set → false → memorySpine.dispatch stays null → byte-identical 503.
  it("defaults to false when neither config nor env is set", () => {
    expect(resolveRouteMemorySpineViaRust(undefined, emptyEnv())).toBe(false);
  });

  it("parses FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST 1/true (case-insensitive, trimmed) as true", () => {
    expect(resolveRouteMemorySpineViaRust(undefined, { FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST: "1" })).toBe(true);
    expect(resolveRouteMemorySpineViaRust(undefined, { FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST: "true" })).toBe(true);
    expect(resolveRouteMemorySpineViaRust(undefined, { FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST: "TRUE" })).toBe(true);
    expect(resolveRouteMemorySpineViaRust(undefined, { FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST: "  1  " })).toBe(true);
    expect(resolveRouteMemorySpineViaRust(undefined, { FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST: " true " })).toBe(true);
  });

  // Fail-safe OFF: everything that is not exactly "1"/"true" → false.
  it("treats 0, false, empty, and garbage env values as false (fail-safe off)", () => {
    expect(resolveRouteMemorySpineViaRust(undefined, { FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST: "0" })).toBe(false);
    expect(resolveRouteMemorySpineViaRust(undefined, { FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST: "false" })).toBe(false);
    expect(resolveRouteMemorySpineViaRust(undefined, { FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST: "" })).toBe(false);
    expect(resolveRouteMemorySpineViaRust(undefined, { FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST: "yes" })).toBe(false);
    expect(resolveRouteMemorySpineViaRust(undefined, { FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST: "on" })).toBe(false);
    expect(resolveRouteMemorySpineViaRust(undefined, { FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST: "2" })).toBe(false);
  });

  // PRECEDENCE: explicit config wins over env (true wins, AND the discriminating false-beats-env-true).
  it("uses explicit config over the env (true wins; false beats env true)", () => {
    expect(resolveRouteMemorySpineViaRust(true, { FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST: "0" })).toBe(true);
    expect(resolveRouteMemorySpineViaRust(true, emptyEnv())).toBe(true);
    expect(resolveRouteMemorySpineViaRust(false, { FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST: "1" })).toBe(false);
    expect(resolveRouteMemorySpineViaRust(false, { FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST: "true" })).toBe(false);
  });
});

describe("resolveRouteRunOutcomeLearningViaRust (A1 run-outcome learning decision route flag)", () => {
  it("defaults to false when neither config nor env is set", () => {
    expect(resolveRouteRunOutcomeLearningViaRust(undefined, emptyEnv())).toBe(false);
  });

  it("parses FRIDAY_RUN_OUTCOME_LEARNING_ROUTES_VIA_RUST 1/true as true", () => {
    expect(resolveRouteRunOutcomeLearningViaRust(undefined, { FRIDAY_RUN_OUTCOME_LEARNING_ROUTES_VIA_RUST: "1" })).toBe(true);
    expect(resolveRouteRunOutcomeLearningViaRust(undefined, { FRIDAY_RUN_OUTCOME_LEARNING_ROUTES_VIA_RUST: "true" })).toBe(true);
    expect(resolveRouteRunOutcomeLearningViaRust(undefined, { FRIDAY_RUN_OUTCOME_LEARNING_ROUTES_VIA_RUST: " TRUE " })).toBe(true);
  });

  it("treats false-ish and garbage env values as false", () => {
    expect(resolveRouteRunOutcomeLearningViaRust(undefined, { FRIDAY_RUN_OUTCOME_LEARNING_ROUTES_VIA_RUST: "0" })).toBe(false);
    expect(resolveRouteRunOutcomeLearningViaRust(undefined, { FRIDAY_RUN_OUTCOME_LEARNING_ROUTES_VIA_RUST: "false" })).toBe(false);
    expect(resolveRouteRunOutcomeLearningViaRust(undefined, { FRIDAY_RUN_OUTCOME_LEARNING_ROUTES_VIA_RUST: "on" })).toBe(false);
    expect(resolveRouteRunOutcomeLearningViaRust(undefined, { FRIDAY_RUN_OUTCOME_LEARNING_ROUTES_VIA_RUST: "" })).toBe(false);
  });

  it("uses explicit config over env", () => {
    expect(resolveRouteRunOutcomeLearningViaRust(true, { FRIDAY_RUN_OUTCOME_LEARNING_ROUTES_VIA_RUST: "0" })).toBe(true);
    expect(resolveRouteRunOutcomeLearningViaRust(false, { FRIDAY_RUN_OUTCOME_LEARNING_ROUTES_VIA_RUST: "1" })).toBe(false);
  });
});

describe("resolveMissionAutoDispatch (organic mission→run binding PRODUCER flag)", () => {
  it("defaults OFF when neither config nor env is set", () => {
    expect(resolveMissionAutoDispatch(undefined, emptyEnv())).toBe(false);
  });

  it("env exact opt-in (case-insensitive, trimmed) → true", () => {
    expect(resolveMissionAutoDispatch(undefined, { FRIDAY_MISSION_AUTO_DISPATCH: "1" })).toBe(true);
    expect(resolveMissionAutoDispatch(undefined, { FRIDAY_MISSION_AUTO_DISPATCH: "true" })).toBe(true);
    expect(resolveMissionAutoDispatch(undefined, { FRIDAY_MISSION_AUTO_DISPATCH: "TRUE" })).toBe(true);
    expect(resolveMissionAutoDispatch(undefined, { FRIDAY_MISSION_AUTO_DISPATCH: "  1  " })).toBe(true);
    expect(resolveMissionAutoDispatch(undefined, { FRIDAY_MISSION_AUTO_DISPATCH: " true " })).toBe(true);
  });

  it("any non-exact env value (incl. 0/false/empty/yes/on/2) → false", () => {
    expect(resolveMissionAutoDispatch(undefined, { FRIDAY_MISSION_AUTO_DISPATCH: "0" })).toBe(false);
    expect(resolveMissionAutoDispatch(undefined, { FRIDAY_MISSION_AUTO_DISPATCH: "false" })).toBe(false);
    expect(resolveMissionAutoDispatch(undefined, { FRIDAY_MISSION_AUTO_DISPATCH: "" })).toBe(false);
    expect(resolveMissionAutoDispatch(undefined, { FRIDAY_MISSION_AUTO_DISPATCH: "yes" })).toBe(false);
    expect(resolveMissionAutoDispatch(undefined, { FRIDAY_MISSION_AUTO_DISPATCH: "on" })).toBe(false);
    expect(resolveMissionAutoDispatch(undefined, { FRIDAY_MISSION_AUTO_DISPATCH: "2" })).toBe(false);
  });

  it("uses explicit config over the env (true wins; false beats env true)", () => {
    expect(resolveMissionAutoDispatch(true, { FRIDAY_MISSION_AUTO_DISPATCH: "0" })).toBe(true);
    expect(resolveMissionAutoDispatch(true, emptyEnv())).toBe(true);
    expect(resolveMissionAutoDispatch(false, { FRIDAY_MISSION_AUTO_DISPATCH: "1" })).toBe(false);
    expect(resolveMissionAutoDispatch(false, { FRIDAY_MISSION_AUTO_DISPATCH: "true" })).toBe(false);
  });
});
