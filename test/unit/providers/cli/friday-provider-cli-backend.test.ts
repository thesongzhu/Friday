import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runFridayCliBackendTextCompletion } from "#providers";

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

  function writeMockCli(source: string): string {
    testDir = join(tmpdir(), `friday-provider-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    const cliPath = join(testDir, "mock-cli.mjs");
    writeFileSync(cliPath, `#!/usr/bin/env node\n${source}`);
    chmodSync(cliPath, 0o755);
    return cliPath;
  }
});
