import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
import { resolveFridayHubConfig } from "#hub";
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

  it("defaults pluginRuntimeMode to full", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), emptyEnv());
    expect(resolved.pluginRuntimeMode).toBe("full");
  });

  it("uses explicit pluginRuntimeMode over env", () => {
    const resolved = resolveFridayHubConfig(
      makeConfig({ pluginRuntimeMode: "stub" }),
      { FRIDAY_PLUGIN_RUNTIME_MODE: "full" },
    );
    expect(resolved.pluginRuntimeMode).toBe("stub");
  });

  it("reads FRIDAY_PLUGIN_RUNTIME_MODE from env", () => {
    const resolved = resolveFridayHubConfig(makeConfig(), { FRIDAY_PLUGIN_RUNTIME_MODE: "stub" });
    expect(resolved.pluginRuntimeMode).toBe("stub");
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
});
