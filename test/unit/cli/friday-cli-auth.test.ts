import { describe, it, expect, vi } from "vitest";
import { parseArgs } from "#cli";
import { buildOpenAuthorizationUrlCommand } from "../../../src/cli/friday-cli-auth.js";

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

  it("parses 'auth setup-token anthropic'", () => {
    const result = parseArgs(argv("auth", "setup-token", "anthropic"));
    expect(result.command).toBe("auth");
    expect(result.authSubcommand).toBe("setup-token");
    expect(result.authTarget).toBe("anthropic");
  });

  it("parses 'auth paste-token anthropic' with --token", () => {
    const result = parseArgs(argv("auth", "paste-token", "anthropic", "--token", "tok-ant-test"));
    expect(result.command).toBe("auth");
    expect(result.authSubcommand).toBe("paste-token");
    expect(result.authTarget).toBe("anthropic");
    expect(result.token).toBe("tok-ant-test");
  });

  it("parses 'auth attach-cli codex' with --binary-path", () => {
    const result = parseArgs(argv("auth", "attach-cli", "codex", "--binary-path", "/usr/local/bin/codex"));
    expect(result.command).toBe("auth");
    expect(result.authSubcommand).toBe("attach-cli");
    expect(result.authTarget).toBe("codex");
    expect(result.binaryPath).toBe("/usr/local/bin/codex");
  });

  it("parses 'auth status' without a target", () => {
    const result = parseArgs(argv("auth", "status"));
    expect(result.command).toBe("auth");
    expect(result.authSubcommand).toBe("status");
    expect(result.authTarget).toBeUndefined();
  });

  it("builds browser open commands with URL as argv, not shell text", () => {
    const url = "https://example.com/oauth?next=$(touch%20/tmp/friday-pwn)&x=a%26b";
    const command = buildOpenAuthorizationUrlCommand(url, "darwin");
    expect(command.command).toBe("open");
    expect(command.args).toEqual([url]);
  });

  it("rejects non-http OAuth browser URLs", () => {
    expect(() =>
      buildOpenAuthorizationUrlCommand("javascript:alert(1)", "linux"),
    ).toThrow("Browser URL must use http or https");
  });
});
