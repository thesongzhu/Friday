import { describe, it, expect, vi } from "vitest";
import { parseArgs } from "#cli";
import {
  buildOpenAuthorizationUrlCommand,
  runFridayCliAuthLoginAnthropic,
  runFridayCliAuthAttachCli,
} from "../../../src/cli/friday-cli-auth.js";

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

describe("CLI auth Anthropic OAuth login", () => {
  it("fails closed without looking up or initiating Anthropic OAuth", async () => {
    const providerService = {
      listProviders: vi.fn(),
      initiateOAuthLogin: vi.fn(),
      completeOAuthLogin: vi.fn(),
    };
    const stderr = vi.fn();

    await runFridayCliAuthLoginAnthropic(
      { authTarget: "anthropic", providerId: "anth-001", code: "code#state" },
      {
        providerService: providerService as never,
        stdout: vi.fn(),
        stderr,
      },
    );

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Anthropic OAuth/bearer authentication is disabled"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("setup-token anthropic"));
    expect(providerService.listProviders).not.toHaveBeenCalled();
    expect(providerService.initiateOAuthLogin).not.toHaveBeenCalled();
    expect(providerService.completeOAuthLogin).not.toHaveBeenCalled();
  });
});

describe("CLI auth attach-cli", () => {
  function makeProviderService(overrides: Record<string, unknown> = {}) {
    return {
      getProvider: vi.fn(),
      updateProvider: vi.fn(),
      createProvider: vi.fn(),
      doctorProvider: vi.fn(),
      ...overrides,
    };
  }

  it("requires --provider-id instead of creating an implicit CLI provider", async () => {
    const providerService = makeProviderService();

    await expect(runFridayCliAuthAttachCli(
      { authTarget: "codex" },
      {
        providerService: providerService as never,
        stdout: vi.fn(),
        stderr: vi.fn(),
      },
    )).rejects.toThrow("attach-cli requires --provider-id");

    expect(providerService.getProvider).not.toHaveBeenCalled();
    expect(providerService.createProvider).not.toHaveBeenCalled();
    expect(providerService.updateProvider).not.toHaveBeenCalled();
  });

  it("fails closed when the explicit CLI provider id does not exist", async () => {
    const providerService = makeProviderService({
      getProvider: vi.fn().mockResolvedValue(null),
    });

    await expect(runFridayCliAuthAttachCli(
      { authTarget: "codex", providerId: "missing-provider" },
      {
        providerService: providerService as never,
        stdout: vi.fn(),
        stderr: vi.fn(),
      },
    )).rejects.toThrow('Provider "missing-provider" not found');

    expect(providerService.createProvider).not.toHaveBeenCalled();
    expect(providerService.updateProvider).not.toHaveBeenCalled();
  });

  it("updates only the explicit matching provider", async () => {
    const provider = {
      id: "openai-codex-cli",
      kind: "openai-codex",
      name: "Codex CLI",
      config: { backendKind: "cli" },
    };
    const providerService = makeProviderService({
      getProvider: vi.fn().mockResolvedValue(provider),
      updateProvider: vi.fn().mockResolvedValue(provider),
      doctorProvider: vi.fn().mockResolvedValue({
        backendKind: "cli",
        authMode: "external-session",
        backendHealth: "ok",
        authHealth: "ok",
        reasons: [],
      }),
    });

    await runFridayCliAuthAttachCli(
      {
        authTarget: "codex",
        providerId: provider.id,
        binaryPath: "/usr/local/bin/codex",
      },
      {
        providerService: providerService as never,
        stdout: vi.fn(),
        stderr: vi.fn(),
      },
    );

    expect(providerService.createProvider).not.toHaveBeenCalled();
    expect(providerService.updateProvider).toHaveBeenCalledWith(
      provider.id,
      expect.objectContaining({
        backendKind: "cli",
        authMode: "external-session",
        cliConfig: {
          backendId: "codex-cli",
          binaryPath: "/usr/local/bin/codex",
        },
      }),
    );
    expect(providerService.doctorProvider).toHaveBeenCalledWith(provider.id);
  });

  it("rejects a provider id for the wrong CLI target kind", async () => {
    const providerService = makeProviderService({
      getProvider: vi.fn().mockResolvedValue({
        id: "anthropic-cli",
        kind: "anthropic",
        name: "Codex CLI",
        config: { backendKind: "cli" },
      }),
    });

    await expect(runFridayCliAuthAttachCli(
      { authTarget: "codex", providerId: "anthropic-cli" },
      {
        providerService: providerService as never,
        stdout: vi.fn(),
        stderr: vi.fn(),
      },
    )).rejects.toThrow('Provider "anthropic-cli" is kind "anthropic", not openai-codex');

    expect(providerService.updateProvider).not.toHaveBeenCalled();
  });

  it("rejects removed Claude CLI attach targets before provider mutation", async () => {
    const providerService = makeProviderService({
      getProvider: vi.fn().mockResolvedValue({
        id: "anthropic-http",
        kind: "anthropic",
        name: "Anthropic HTTP",
        config: {
          backendKind: "http",
          authMode: "api-key",
        },
      }),
    });

    await expect(runFridayCliAuthAttachCli(
      { authTarget: "claude", providerId: "anthropic-http" },
      {
        providerService: providerService as never,
        stdout: vi.fn(),
        stderr: vi.fn(),
      },
    )).rejects.toThrow("attach-cli currently supports: codex");

    expect(providerService.createProvider).not.toHaveBeenCalled();
    expect(providerService.updateProvider).not.toHaveBeenCalled();
  });
});
