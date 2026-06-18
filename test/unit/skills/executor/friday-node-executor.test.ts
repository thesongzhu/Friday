import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createFridayNodeExecutor,
  FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
  FRIDAY_UNISOLATED_NODE_SKILLS_TEST_HARNESS_ENV,
  isFridayUnisolatedNodeSkillsEnabled,
} from "#skills";
import * as fs from "node:fs/promises";
import * as path from "node:path";

describe("FridayNodeExecutor", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp("/tmp/friday-node-exec-");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function createExecutor() {
    return createFridayNodeExecutor({
      env: {
        [FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV]: "true",
        [FRIDAY_UNISOLATED_NODE_SKILLS_TEST_HARNESS_ENV]: "true",
      } as NodeJS.ProcessEnv,
    });
  }

  async function writeModule(filename: string, code: string): Promise<string> {
    const filePath = path.join(tmpDir, filename);
    await fs.writeFile(filePath, code);
    return filePath;
  }

  it("executes a module with an 'execute' export", async () => {
    await writeModule(
      "skill.mjs",
      `export async function execute(input) { return { greeting: "hello " + input.name }; }`,
    );

    const executor = createExecutor();
    const result = await executor.run({
      entrypoint: "skill.mjs",
      input: { name: "world" },
      cwd: tmpDir,
    });

    expect(result.timedOut).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({ greeting: "hello world" });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("executes a module with a 'default' export", async () => {
    await writeModule(
      "skill-default.mjs",
      `export default async function(input) { return { doubled: input.value * 2 }; }`,
    );

    const executor = createExecutor();
    const result = await executor.run({
      entrypoint: "skill-default.mjs",
      input: { value: 21 },
      cwd: tmpDir,
    });

    expect(result.timedOut).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({ doubled: 42 });
  });

  it("returns error when module does not export execute or default", async () => {
    await writeModule(
      "no-fn.mjs",
      `export const foo = 42;`,
    );

    const executor = createExecutor();
    const result = await executor.run({
      entrypoint: "no-fn.mjs",
      input: {},
      cwd: tmpDir,
    });

    expect(result.timedOut).toBe(false);
    expect(result.error).toContain("does not export");
  });

  it("returns error when module is not found", async () => {
    const executor = createExecutor();
    const result = await executor.run({
      entrypoint: "nonexistent-module.mjs",
      input: {},
      cwd: tmpDir,
    });

    expect(result.timedOut).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.output).toEqual({});
  });

  it("rejects entrypoints that escape the skill directory sandbox", async () => {
    const outsideDir = await fs.mkdtemp("/tmp/friday-node-outside-");
    try {
      await fs.writeFile(
        path.join(outsideDir, "outside.mjs"),
        `export async function execute() { return { escaped: true }; }`,
      );
      const executor = createExecutor();
      const result = await executor.run({
        entrypoint: path.relative(tmpDir, path.join(outsideDir, "outside.mjs")),
        input: {},
        cwd: tmpDir,
      });

      expect(result.timedOut).toBe(false);
      expect(result.output).toEqual({});
      expect(result.error).toContain("escapes the skill directory sandbox");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("times out when execution takes too long", async () => {
    await writeModule(
      "slow.mjs",
      `export async function execute() { await new Promise(r => setTimeout(r, 60000)); return {}; }`,
    );

    const executor = createExecutor();
    const result = await executor.run({
      entrypoint: "slow.mjs",
      input: {},
      cwd: tmpDir,
      timeoutMs: 100,
    });

    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out");
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it("wraps non-object results in { result: ... }", async () => {
    await writeModule(
      "scalar.mjs",
      `export async function execute() { return 42; }`,
    );

    const executor = createExecutor();
    const result = await executor.run({
      entrypoint: "scalar.mjs",
      input: {},
      cwd: tmpDir,
    });

    expect(result.timedOut).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({ result: 42 });
  });

  it("handles synchronous execute function", async () => {
    await writeModule(
      "sync.mjs",
      `export function execute(input) { return { sum: input.a + input.b }; }`,
    );

    const executor = createExecutor();
    const result = await executor.run({
      entrypoint: "sync.mjs",
      input: { a: 3, b: 4 },
      cwd: tmpDir,
    });

    expect(result.timedOut).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({ sum: 7 });
  });

  it("cancels execution when signal is aborted", async () => {
    await writeModule(
      "cancellable.mjs",
      `export async function execute() { await new Promise(r => setTimeout(r, 60000)); return {}; }`,
    );

    const controller = new AbortController();
    const executor = createExecutor();

    // Abort after a short delay
    setTimeout(() => controller.abort(), 50);

    const result = await executor.run({
      entrypoint: "cancellable.mjs",
      input: {},
      cwd: tmpDir,
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    expect(result.error).toContain("cancelled");
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it("handles pre-aborted signal", async () => {
    await writeModule(
      "preaborted.mjs",
      `export async function execute() { await new Promise(r => setTimeout(r, 60000)); return {}; }`,
    );

    const controller = new AbortController();
    controller.abort(); // Abort before running

    const executor = createExecutor();
    const result = await executor.run({
      entrypoint: "preaborted.mjs",
      input: {},
      cwd: tmpDir,
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    expect(result.error).toContain("cancelled");
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it("blocks unisolated node execution when the runtime gate is off", async () => {
    await writeModule(
      "blocked.mjs",
      `export async function execute() { return { ok: true }; }`,
    );

    const executor = createFridayNodeExecutor({
      env: {} as NodeJS.ProcessEnv,
    });
    const result = await executor.run({
      entrypoint: "blocked.mjs",
      input: {},
      cwd: tmpDir,
    });

    expect(result.timedOut).toBe(false);
    expect(result.output).toEqual({});
    expect(result.error).toContain("disabled");
    expect(result.error).toContain(FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV);
  });

  it("does not let the unisolated env gate unlock Node skills outside the test harness", async () => {
    await writeModule(
      "prod-blocked.mjs",
      `export async function execute() { return { ok: true }; }`,
    );

    const env = {
      [FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV]: "true",
      VITEST: "",
    } as NodeJS.ProcessEnv;
    const executor = createFridayNodeExecutor({ env });
    const result = await executor.run({
      entrypoint: "prod-blocked.mjs",
      input: {},
      cwd: tmpDir,
    });

    expect(isFridayUnisolatedNodeSkillsEnabled(env)).toBe(false);
    expect(result.output).toEqual({});
    expect(result.error).toContain("disabled in production");
  });
});
