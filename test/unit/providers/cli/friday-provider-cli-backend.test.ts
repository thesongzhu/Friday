import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { probeFridayCliSession, runFridayCliBackendTextCompletion } from "#providers";
import { parseCodexStatus } from "../../../../src/providers/cli/friday-provider-cli-backend.js";

describe("friday-provider-cli-backend", () => {
  let testDir: string | undefined;
  const originalCliBinaryAllowlist = process.env.FRIDAY_CLI_BINARY_ALLOWLIST;
  const originalPath = process.env.PATH;

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
      testDir = undefined;
    }
    if (originalCliBinaryAllowlist === undefined) {
      delete process.env.FRIDAY_CLI_BINARY_ALLOWLIST;
    } else {
      process.env.FRIDAY_CLI_BINARY_ALLOWLIST = originalCliBinaryAllowlist;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  });

  it("rejects explicit tmpdir CLI binary paths before probing version", async () => {
    const cliPath = writeMockCli(`
      writeFileSync(${JSON.stringify(join(tmpdir(), "friday-new32-probe-pwned"))}, "executed");
      process.stdout.write("codex 1.0.0\\n");
    `, "codex", tmpdir());
    const sentinelPath = join(testDir!, "PWNED");
    writeFileSync(cliPath, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinelPath)}, "executed");\nprocess.stdout.write("codex 1.0.0\\n");\n`);
    chmodSync(cliPath, 0o755);

    const result = await probeFridayCliSession({
      cliConfig: {
        backendId: "codex-cli",
        binaryPath: cliPath,
      },
      nowIso: () => "2026-07-02T00:00:00.000Z",
    });

    expect(existsSync(sentinelPath)).toBe(false);
    expect(result.status).toBe("missing");
    expect(result.message).toContain("cliConfig.binaryPath is not in the allowed set");
  });

  it("rejects explicit tmpdir CLI binary paths before text completion spawn", async () => {
    const cliPath = writeMockCli(`
      writeFileSync(${JSON.stringify(join(tmpdir(), "friday-new32-completion-pwned"))}, "executed");
      process.stdout.write("unexpected completion\\n");
    `, "codex", tmpdir());
    const sentinelPath = join(testDir!, "PWNED");
    writeFileSync(cliPath, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinelPath)}, "executed");\nprocess.stdout.write("unexpected completion\\n");\n`);
    chmodSync(cliPath, 0o755);

    await expect(runFridayCliBackendTextCompletion({
      cliConfig: {
        backendId: "codex-cli",
        binaryPath: cliPath,
      },
      systemPrompt: "system",
      conversation: "hello",
    })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      httpStatus: 400,
    });
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("bounds stdout captured from CLI text completions", async () => {
    const cliPath = writeMockCli(`
      process.stdin.resume();
      process.stdin.on("end", () => {
        process.stdout.write("x".repeat(1100000));
      });
    `);
    allowCliBinaryPath(cliPath);

    const result = await runFridayCliBackendTextCompletion({
      cliConfig: {
        backendId: "codex-cli",
        binaryPath: cliPath,
      },
      systemPrompt: "system",
      conversation: "hello",
    });

    expect(result.length).toBeLessThan(1_100_000);
    expect(result).toContain("stdout truncated");
  });

  it("maps missing CLI binaries to PROVIDER_UNREACHABLE for text completions", async () => {
    const missingPath = `/usr/local/bin/friday-missing-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    allowCliBinaryPath(missingPath);

    await expect(runFridayCliBackendTextCompletion({
      cliConfig: {
        backendId: "codex-cli",
        binaryPath: missingPath,
      },
      systemPrompt: "system",
      conversation: "hello",
    })).rejects.toMatchObject({
      code: "PROVIDER_UNREACHABLE",
      httpStatus: 422,
      message: `CLI binary "${missingPath}" not found`,
    });
  });

  it("keeps the default bare codex binary on PATH instead of applying explicit-path validation", async () => {
    process.env.FRIDAY_CLI_BINARY_ALLOWLIST = "/definitely/not/codex";
    process.env.PATH = "";

    await expect(runFridayCliBackendTextCompletion({
      cliConfig: {
        backendId: "codex-cli",
      },
      systemPrompt: "system",
      conversation: "hello",
    })).rejects.toMatchObject({
      code: "PROVIDER_UNREACHABLE",
      httpStatus: 422,
      message: "CLI binary \"codex\" not found",
    });
  });

  describe("parseCodexStatus (Phase 18B CLAW-003)", () => {
    it("treats 'Not logged in' as loggedIn=false (does not match the positive substring)", () => {
      expect(parseCodexStatus("Not logged in.\nRun `codex login` to authenticate.", "")).toEqual({
        loggedIn: false,
      });
    });

    it("treats 'Unauthenticated' as loggedIn=false (does not match the positive 'authenticated' substring)", () => {
      expect(parseCodexStatus("", "Unauthenticated: please run codex login")).toEqual({
        loggedIn: false,
      });
    });

    it("treats 'Not authenticated' as loggedIn=false", () => {
      expect(parseCodexStatus("Not authenticated. Run `codex login`.", "")).toEqual({
        loggedIn: false,
      });
    });

    it("treats 'Login required' as loggedIn=false", () => {
      expect(parseCodexStatus("Login required", "")).toEqual({ loggedIn: false });
    });

    it("treats 'Logged out' as loggedIn=false", () => {
      expect(parseCodexStatus("Logged out", "")).toEqual({ loggedIn: false });
    });

    it("treats 'Not signed in' / 'Signed out' as loggedIn=false", () => {
      expect(parseCodexStatus("Not signed in", "")).toEqual({ loggedIn: false });
      expect(parseCodexStatus("Signed out", "")).toEqual({ loggedIn: false });
    });

    it("recognizes 'Logged in as user@example.com' as loggedIn=true", () => {
      expect(parseCodexStatus("Logged in as user@example.com", "")).toEqual({ loggedIn: true });
    });

    it("recognizes 'Authenticated' as loggedIn=true", () => {
      expect(parseCodexStatus("Authenticated.", "")).toEqual({ loggedIn: true });
    });

    it("returns a message when neither side of the boundary matches", () => {
      const result = parseCodexStatus("codex-cli 0.1.2", "");
      expect(result.loggedIn).toBeUndefined();
      expect(result.message).toContain("codex-cli");
    });

    it("returns the empty-output message when both streams are empty", () => {
      expect(parseCodexStatus("", "").message).toContain("did not emit login status");
    });
  });

  function allowCliBinaryPath(binaryPath: string): void {
    process.env.FRIDAY_CLI_BINARY_ALLOWLIST = binaryPath;
  }

  function writeMockCli(source: string, filename = "mock-cli.mjs", rootDir = join(homedir(), ".friday-test-cli-binaries")): string {
    testDir = join(rootDir, `friday-provider-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    const cliPath = join(testDir, filename);
    writeFileSync(cliPath, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\n${source}`);
    chmodSync(cliPath, 0o755);
    return cliPath;
  }
});
