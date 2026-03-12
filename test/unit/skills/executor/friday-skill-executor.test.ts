import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createFridaySkillExecutor } from "#skills";
import { createFridaySkillRunStore } from "#ledger";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { makeManifest } from "../_helpers/make-manifest.helper.js";
import type { FridaySqliteLayer } from "#state";
import type { FridaySkillRegistry } from "#skills";
import type { FridayRegisteredSkill } from "#skills";
import type { FridaySkillRunStore } from "#ledger";
import type { FridaySkillExecuteRequest } from "#skills";

/** Minimal mock registry that returns skills from a pre-built map. */
function createMockRegistry(
  skills: Map<string, FridayRegisteredSkill>,
): FridaySkillRegistry {
  return {
    list: () => Array.from(skills.values()),
    get: (id: string) => skills.get(id) ?? null,
    resolveByIntent: () => null,
    validateAll: () => [],
    reload: async () => {},
    refresh: async () => {},
    isCompatible: () => ({ compatible: true, reasons: [] }),
    startWatching: async () => {},
    stopWatching: async () => {},
    close: async () => {},
  };
}

/** Creates a minimal FridayRegisteredSkill for testing. */
function makeRegisteredSkill(
  overrides: {
    id?: string;
    runtimeKind?: "shell" | "node" | "builtin" | "python" | "remote-http";
    entrypoint?: string;
    skillDir?: string;
    timeoutMs?: number;
  } = {},
): FridayRegisteredSkill {
  const manifest = makeManifest({
    id: overrides.id ?? "test-skill",
    runtime: {
      kind: overrides.runtimeKind ?? "shell",
      entrypoint: overrides.entrypoint ?? "run.sh",
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: overrides.timeoutMs ?? 30_000,
    },
  });

  return {
    manifest,
    skillDir: overrides.skillDir ?? "/tmp/test-skill",
    source: "local",
    origin: "workspace",
    status: "installed",
    loaded: {
      manifest,
      format: "skill-json",
      rawContent: "{}",
      declaredFiles: [],
    },
    validation: {
      ok: true,
      issues: [],
      skillId: manifest.id,
      timestamp: "2025-01-01T00:00:00.000Z",
    },
    trust: {
      trusted: true,
      reason: "test",
    },
  };
}

describe("FridaySkillExecutor", () => {
  let db: FridaySqliteLayer;
  let runStore: FridaySkillRunStore;

  beforeEach(() => {
    db = createTestDb();
    runStore = createFridaySkillRunStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  const baseRequest: FridaySkillExecuteRequest = {
    skillId: "echo-skill",
    input: { message: "hello" },
    sessionId: "session-1",
    userId: "test-user",
    channel: "test",
  };

  it("routes shell skill to shell executor and returns result", async () => {
    const skill = makeRegisteredSkill({
      id: "echo-skill",
      runtimeKind: "shell",
      entrypoint: "/bin/echo",
      skillDir: "/tmp",
    });

    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("echo-skill", skill);

    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const handle = executor.execute(baseRequest);
    expect(handle.runId).toBe("test-id-0001");

    const result = await handle.result;
    expect(result.status).toBe("completed");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns failed when skill is not found", async () => {
    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(new Map()),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result = await executor.execute(baseRequest).result;

    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("not found");
  });

  it("returns failed for unsupported runtime kind", async () => {
    const skill = makeRegisteredSkill({
      id: "echo-skill",
      runtimeKind: "python",
    });

    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("echo-skill", skill);

    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result = await executor.execute(baseRequest).result;

    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("Unsupported runtime kind");
  });

  it("persists run state in the run store", async () => {
    const skill = makeRegisteredSkill({
      id: "echo-skill",
      runtimeKind: "shell",
      entrypoint: "/bin/echo",
      skillDir: "/tmp",
    });

    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("echo-skill", skill);

    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const handle = executor.execute(baseRequest);
    const result = await handle.result;

    const stored = runStore.getRun(result.runId);
    expect(stored).not.toBeNull();
    expect(stored!.skillId).toBe("echo-skill");
    expect(stored!.sessionId).toBe("session-1");
    expect(stored!.userId).toBe("test-user");
    // Terminal status
    expect(["completed", "failed", "cancelled"]).toContain(stored!.status);
  });

  it("handles shell execution with timeout", { timeout: 30_000 }, async () => {
    // Use a script that ignores stdin and sleeps forever
    const scriptDir = await import("node:fs/promises").then(async (fs) => {
      const dir = await fs.mkdtemp("/tmp/friday-test-");
      await fs.writeFile(`${dir}/slow.sh`, "#!/bin/sh\nsleep 60\n", { mode: 0o755 });
      return dir;
    });

    const skill = makeRegisteredSkill({
      id: "echo-skill",
      runtimeKind: "shell",
      entrypoint: "slow.sh",
      skillDir: scriptDir,
      timeoutMs: 30_000,
    });

    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("echo-skill", skill);

    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result = await executor.execute({
      ...baseRequest,
      timeoutMs: 200,
    }).result;

    expect(result.status).toBe("timeout");
    expect(result.durationMs).toBeLessThan(5_000);

    // Cleanup
    const fs = await import("node:fs/promises");
    await fs.rm(scriptDir, { recursive: true });
  });

  it("cancel kills a running shell process", { timeout: 30_000 }, async () => {
    // Create a script that sleeps for 60s
    const scriptDir = await import("node:fs/promises").then(async (fs) => {
      const dir = await fs.mkdtemp("/tmp/friday-cancel-");
      await fs.writeFile(`${dir}/slow.sh`, "#!/bin/sh\nsleep 60\n", { mode: 0o755 });
      return dir;
    });

    const skill = makeRegisteredSkill({
      id: "echo-skill",
      runtimeKind: "shell",
      entrypoint: "slow.sh",
      skillDir: scriptDir,
      timeoutMs: 60_000,
    });

    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("echo-skill", skill);

    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    // execute() now returns { runId, result } synchronously
    const handle = executor.execute(baseRequest);

    // Cancel after a short delay to let the process start
    await new Promise((r) => setTimeout(r, 100));
    executor.cancel(handle.runId);

    const result = await handle.result;
    expect(result.status).toBe("cancelled");
    expect(result.durationMs).toBeLessThan(5_000);

    // Cleanup
    const fs = await import("node:fs/promises");
    await fs.rm(scriptDir, { recursive: true });
  });

  it("cancel on non-existent run does not throw", () => {
    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(new Map()),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    // Should not throw
    executor.cancel("nonexistent-run");
  });

  it("generates unique run IDs for each execution", async () => {
    const skill = makeRegisteredSkill({
      id: "echo-skill",
      runtimeKind: "shell",
      entrypoint: "/bin/echo",
      skillDir: "/tmp",
    });

    const skills = new Map<string, FridayRegisteredSkill>();
    skills.set("echo-skill", skill);

    const executor = createFridaySkillExecutor({
      db,
      registry: createMockRegistry(skills),
      runStore,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result1 = await executor.execute(baseRequest).result;
    const result2 = await executor.execute(baseRequest).result;

    expect(result1.runId).not.toBe(result2.runId);
  });
});
