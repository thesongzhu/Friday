import { describe, it, expect, vi } from "vitest";
import { parseArgs } from "#cli";

describe("CLI auth argument parsing", () => {
  const argv = (...args: string[]) => ["node", "friday-cli.js", ...args];

  it("parses 'auth login anthropic'", () => {
    const result = parseArgs(argv("auth", "login", "anthropic"));
    expect(result.command).toBe("auth");
    expect(result.authSubcommand).toBe("login");
    expect(result.authTarget).toBe("anthropic");
  });

  it("parses --provider-id flag", () => {
    const result = parseArgs(argv("auth", "login", "anthropic", "--provider-id", "prov-123"));
    expect(result.providerId).toBe("prov-123");
  });

  it("parses --no-browser flag", () => {
    const result = parseArgs(argv("auth", "login", "anthropic", "--no-browser"));
    expect(result.noBrowser).toBe(true);
  });

  it("parses --code flag", () => {
    const result = parseArgs(argv("auth", "login", "anthropic", "--code", "abc#xyz"));
    expect(result.code).toBe("abc#xyz");
  });

  it("parses all auth flags combined", () => {
    const result = parseArgs(argv(
      "auth", "login", "anthropic",
      "--provider-id", "prov-001",
      "--code", "code#state",
      "--no-browser",
    ));
    expect(result.command).toBe("auth");
    expect(result.authSubcommand).toBe("login");
    expect(result.authTarget).toBe("anthropic");
    expect(result.providerId).toBe("prov-001");
    expect(result.code).toBe("code#state");
    expect(result.noBrowser).toBe(true);
  });

  it("noBrowser defaults to false", () => {
    const result = parseArgs(argv("auth", "login", "anthropic"));
    expect(result.noBrowser).toBe(false);
  });
});
