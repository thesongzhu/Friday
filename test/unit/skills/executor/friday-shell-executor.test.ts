import { afterEach, describe, it, expect } from "vitest";
import { createFridayShellExecutor } from "#skills";

describe("FridayShellExecutor", () => {
  const originalParentSecret = process.env.FRIDAY_PARENT_SECRET;

  afterEach(() => {
    if (originalParentSecret == null) {
      delete process.env.FRIDAY_PARENT_SECRET;
    } else {
      process.env.FRIDAY_PARENT_SECRET = originalParentSecret;
    }
  });

  function createExecutor() {
    return createFridayShellExecutor();
  }

  it("captures stdout from a simple command", async () => {
    const executor = createExecutor();
    const result = await executor.run({
      command: "echo",
      args: ["hello world"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
    expect(result.stderr).toBe("");
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures stderr from a failing command", async () => {
    const executor = createExecutor();
    const result = await executor.run({
      command: "sh",
      args: ["-c", "echo err >&2 && exit 1"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe("err");
    expect(result.timedOut).toBe(false);
  });

  it("times out and kills long-running process", async () => {
    const executor = createExecutor();
    const result = await executor.run({
      command: "sleep",
      args: ["60"],
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124); // timeout exit code
    expect(result.durationMs).toBeLessThan(5_000); // should be much less
  });

  it("passes stdin to the child process", async () => {
    const executor = createExecutor();
    const result = await executor.run({
      command: "cat",
      stdin: "hello from stdin",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello from stdin");
    expect(result.timedOut).toBe(false);
  });

  it("sets environment variables", async () => {
    process.env.FRIDAY_PARENT_SECRET = "super-secret-parent-value"; // pragma: allowlist secret
    const executor = createExecutor();
    const result = await executor.run({
      command: "sh",
      args: ["-c", "printf '%s|%s' \"$FRIDAY_TEST_VAR\" \"${FRIDAY_PARENT_SECRET-unset}\""],
      env: { FRIDAY_TEST_VAR: "test-value-42" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("test-value-42|unset");
  });

  it("does not inherit undeclared parent env vars", async () => {
    process.env.FRIDAY_PARENT_SECRET = "super-secret-parent-value"; // pragma: allowlist secret
    const executor = createExecutor();
    const result = await executor.run({
      command: "sh",
      args: ["-c", "printf '%s' \"${FRIDAY_PARENT_SECRET-unset}\""],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("unset");
  });

  it("handles command not found gracefully", async () => {
    const executor = createExecutor();
    const result = await executor.run({
      command: "__nonexistent_command_xyz__",
    });

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("ENOENT");
  });

  it("handles multi-line output", async () => {
    const executor = createExecutor();
    const result = await executor.run({
      command: "sh",
      args: ["-c", "echo line1 && echo line2 && echo line3"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("line1\nline2\nline3");
  });

  it("does not throw when child closes stdin early (EPIPE path)", async () => {
    const executor = createExecutor();
    const result = await executor.run({
      command: "sh",
      args: ["-c", "exit 0"],
      stdin: JSON.stringify({ ping: "pong" }),
    });
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("respects cwd option", async () => {
    const executor = createExecutor();
    const result = await executor.run({
      command: "pwd",
      cwd: "/tmp",
    });

    expect(result.exitCode).toBe(0);
    // On macOS /tmp is a symlink to /private/tmp
    expect(result.stdout.trim()).toMatch(/\/(tmp|private\/tmp)$/);
  });
});
