import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runFridayCliBackendTextCompletion } from "#providers";
import { parseCodexStatus } from "../../../../src/providers/cli/friday-provider-cli-backend.js";

describe("friday-provider-cli-backend", () => {
  let testDir: string | undefined;

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
      testDir = undefined;
    }
  });

  it("bounds stdout captured from CLI text completions", async () => {
    const cliPath = writeMockCli(`
      process.stdin.resume();
      process.stdin.on("end", () => {
        process.stdout.write("x".repeat(1100000));
      });
    `);

    const result = await runFridayCliBackendTextCompletion({
      cliConfig: {
        backendId: "claude-cli",
        binaryPath: cliPath,
      },
      systemPrompt: "system",
      conversation: "hello",
    });

    expect(result.length).toBeLessThan(1_100_000);
    expect(result).toContain("stdout truncated");
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

  function writeMockCli(source: string): string {
    testDir = join(tmpdir(), `friday-provider-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    const cliPath = join(testDir, "mock-cli.mjs");
    writeFileSync(cliPath, `#!/usr/bin/env node\n${source}`);
    chmodSync(cliPath, 0o755);
    return cliPath;
  }
});
