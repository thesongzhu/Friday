/**
 * E2E tests for skill discovery → registry → execution → ledger lifecycle.
 *
 * These tests exercise the real skill subsystem (registry, executor, run store)
 * against the filesystem — no HTTP involved.
 */

import * as crypto from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import type { SkillManifestV2 } from "#skills";
import { FridaySkillRegistryImpl, createFridaySkillExecutor } from "#skills";
import { createFridaySkillRunStore } from "#ledger";
import type { FridaySkillRunStore } from "#ledger";
import type { FridayHubConfigManagerService, FridayHubMemoryStateService } from "#hub";
import type { FridaySkillSecurityProfile } from "#skills";
import type { FridaySkillRegistrySettings } from "#hub";
import type { SkillLifecycleStatus } from "#skills";
import type { FridayDiscoveredSkillRecord } from "#hub";
import type { FridaySqliteLayer } from "#state";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";
import Database from "better-sqlite3";

// ─── Helpers ───────────────────────────────────────────────────────────────

function createTestDb(): FridaySqliteLayer {
  const db = new Database(":memory:");
  runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

  db.prepare(
    `INSERT OR IGNORE INTO users (id, display_name, role, is_local_only, created_at, updated_at)
     VALUES ('test-user', 'Test User', 'admin', 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run();

  return {
    dbPath: ":memory:",
    writer: db,
    reads: {
      size: 1,
      withReadConnection<T>(fn: (d: Database.Database) => T): T {
        return fn(db);
      },
      close() {},
    },
    withWriteTransaction<T>(fn: (writerDb: Database.Database) => T): T {
      return db.transaction(() => fn(db))();
    },
    withReadConnection<T>(fn: (d: Database.Database) => T): T {
      return fn(db);
    },
    checkpoint() {},
    close() {
      db.close();
    },
  };
}

function createStubConfigManager(
  skillDirs: string[],
  workspaceDir: string,
): FridayHubConfigManagerService {
  const settings: FridaySkillRegistrySettings = {
    workspaceDir,
    bundledSkillsDir: skillDirs[0] ?? join(workspaceDir, "bundled-skills"),
    managedSkillsDir: skillDirs[1] ?? join(workspaceDir, "managed-skills"),
    extraSkillDirs: skillDirs.slice(2),
    watchEnabled: false,
    watchDebounceMs: 300,
  };

  const securityProfile: FridaySkillSecurityProfile = {};

  return {
    getCurrentConfig: async () => {
      throw new Error("Not implemented in test stub");
    },
    getConfig: async () => ({ revision: 1, settings: {} }),
    validatePatch: async () => ({ valid: true, errors: [] }),
    applyPatch: async () => ({ revision: 1, changedKeys: [] }),
    listRevisions: async () => ({ items: [] }),
    revertToRevision: async () => ({
      revision: 1,
      changedKeys: [],
      revertedFrom: 1,
    }),
    getSkillRegistrySettings: async () => settings,
    getSkillSecurityProfile: async () => securityProfile,
  };
}

function createStubMemoryState(): FridayHubMemoryStateService {
  const statuses: Record<string, SkillLifecycleStatus> = {};
  return {
    listSkillStatuses: async () => statuses,
    upsertDiscoveredSkills: async (records: FridayDiscoveredSkillRecord[]) => {
      for (const r of records) {
        statuses[r.id] = r.status;
      }
    },
    updateSkillStatus: async (skillId: string, status: SkillLifecycleStatus) => {
      statuses[skillId] = status;
    },
    appendAuditLog: async () => {},
    getSession: async () => null,
    appendSessionMessage: async (input) => ({
      ...input,
      id: crypto.randomUUID(),
      sequence: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    getMemoryItems: async () => [],
    putMemoryItem: async () => {},
  };
}

/** Builds a minimal manifest that passes the Zod schema + defaults. */
function buildMinimalManifest(overrides: Partial<SkillManifestV2> = {}): SkillManifestV2 {
  return {
    schemaVersion: "2.0",
    id: "test-skill",
    name: "Test Skill",
    description: "A test skill for E2E tests",
    version: "1.0.0",
    kind: "conversation",
    category: "utility",
    author: { name: "tester" },
    tags: [],
    runtime: {
      kind: "shell",
      entrypoint: "run.sh",
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: 30_000,
    },
    triggers: {
      intents: [],
      phrases: [],
      channels: ["*"],
    },
    invocation: {
      userInvocable: true,
      modelInvocable: true,
      priority: 50,
      modes: ["intent"],
    },
    requirements: {
      bins: [],
      env: [],
      config: [],
      os: ["darwin", "linux", "win32"],
    },
    inputs: [],
    outputs: [],
    permissions: {
      grants: [],
      promptOn: [],
    },
    schemas: null,
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: { events: [] },
    ...overrides,
  };
}

/** Creates a skill directory with manifest and entrypoint. */
function writeSkillToDir(
  parentDir: string,
  skillId: string,
  manifest: SkillManifestV2,
  entrypointContent: string,
): string {
  const skillDir = join(parentDir, skillId);
  mkdirSync(skillDir, { recursive: true });

  writeFileSync(
    join(skillDir, "skill.manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );

  const entryPath = join(skillDir, manifest.runtime.entrypoint);
  writeFileSync(entryPath, entrypointContent, "utf-8");
  if (manifest.runtime.kind === "shell") {
    chmodSync(entryPath, 0o755);
  }

  return skillDir;
}

function makeTempDir(label: string): string {
  const dir = join(
    tmpdir(),
    `friday-e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Test suite ────────────────────────────────────────────────────────────

describe("Skill lifecycle — discovery → registry → execution → ledger", () => {
  let workspaceDir: string;
  let skillsDir: string;
  let db: FridaySqliteLayer;
  let runStore: FridaySkillRunStore;
  const tempDirs: string[] = [];

  beforeAll(() => {
    workspaceDir = makeTempDir("workspace");
    tempDirs.push(workspaceDir);
    db = createTestDb();
    runStore = createFridaySkillRunStore({ db });
  });

  afterAll(() => {
    db.close();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    // Each test gets a fresh skills directory
    skillsDir = makeTempDir("skills");
    tempDirs.push(skillsDir);
  });

  // ── hub_discovers_skills_from_directory ────────────────────────────────

  it("hub_discovers_skills_from_directory", async () => {
    const manifest = buildMinimalManifest({
      id: "echo-skill",
      name: "Echo Skill",
      runtime: {
        kind: "shell",
        entrypoint: "run.sh",
        minHubVersion: "1.0.0",
        apiVersion: "1",
        timeoutMsDefault: 30_000,
      },
    });

    writeSkillToDir(skillsDir, "echo-skill", manifest, "#!/bin/sh\necho hello");

    const configManager = createStubConfigManager([skillsDir], workspaceDir);
    const memoryState = createStubMemoryState();

    const registry = new FridaySkillRegistryImpl({
      workspaceDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
      configManager,
      memoryStateService: memoryState,
    });

    await registry.refresh();

    const skills = registry.list();
    expect(skills).toHaveLength(1);

    const echoSkill = registry.get("echo-skill");
    expect(echoSkill).not.toBeNull();
    expect(echoSkill!.manifest.id).toBe("echo-skill");
    expect(echoSkill!.manifest.name).toBe("Echo Skill");
    expect(echoSkill!.skillDir).toBe(join(skillsDir, "echo-skill"));

    await registry.close();
  });

  // ── execute_shell_skill_captures_output ────────────────────────────────

  it("execute_shell_skill_captures_output", async () => {
    const manifest = buildMinimalManifest({
      id: "shell-echo",
      name: "Shell Echo",
      runtime: {
        kind: "shell",
        entrypoint: "run.sh",
        minHubVersion: "1.0.0",
        apiVersion: "1",
        timeoutMsDefault: 10_000,
      },
    });

    writeSkillToDir(
      skillsDir,
      "shell-echo",
      manifest,
      '#!/bin/sh\necho "hello from shell"',
    );

    const configManager = createStubConfigManager([skillsDir], workspaceDir);
    const memoryState = createStubMemoryState();

    const registry = new FridaySkillRegistryImpl({
      workspaceDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
      configManager,
      memoryStateService: memoryState,
    });

    await registry.refresh();

    const executor = createFridaySkillExecutor({
      db,
      registry,
      runStore,
      idGenerator: () => crypto.randomUUID(),
      nowIso: () => new Date().toISOString(),
    });

    const handle = executor.execute({
      skillId: "shell-echo",
      input: {},
      sessionId: "test-session",
      userId: "test-user",
      channel: "test",
    });

    const result = await handle.result;

    expect(result.status).toBe("completed");
    expect(result.stdout).toContain("hello from shell");
    expect(result.runId).toBe(handle.runId);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Verify run was persisted in the ledger
    const storedRun = runStore.getRun(handle.runId);
    expect(storedRun).not.toBeNull();
    expect(storedRun!.skillId).toBe("shell-echo");
    expect(storedRun!.status).toBe("completed");

    await registry.close();
  });

  // ── execute_node_skill_returns_output ──────────────────────────────────

  it("execute_node_skill_returns_output", async () => {
    const manifest = buildMinimalManifest({
      id: "node-greet",
      name: "Node Greet",
      runtime: {
        kind: "node",
        entrypoint: "index.js",
        minHubVersion: "1.0.0",
        apiVersion: "1",
        timeoutMsDefault: 10_000,
      },
    });

    const nodeScript = `
module.exports.execute = async function execute(input) {
  const name = input?.name ?? "world";
  return { greeting: "hello " + name };
};
`;

    writeSkillToDir(skillsDir, "node-greet", manifest, nodeScript);

    const configManager = createStubConfigManager([skillsDir], workspaceDir);
    const memoryState = createStubMemoryState();

    const registry = new FridaySkillRegistryImpl({
      workspaceDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
      configManager,
      memoryStateService: memoryState,
    });

    await registry.refresh();

    const executor = createFridaySkillExecutor({
      db,
      registry,
      runStore,
      idGenerator: () => crypto.randomUUID(),
      nowIso: () => new Date().toISOString(),
    });

    const handle = executor.execute({
      skillId: "node-greet",
      input: { name: "Friday" },
      sessionId: "test-session",
      userId: "test-user",
      channel: "test",
    });

    const result = await handle.result;

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ greeting: "hello Friday" });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Verify ledger entry
    const storedRun = runStore.getRun(handle.runId);
    expect(storedRun).not.toBeNull();
    expect(storedRun!.skillId).toBe("node-greet");
    expect(storedRun!.status).toBe("completed");

    await registry.close();
  });

  // ── registry_refresh_picks_up_new_skill ────────────────────────────────

  it("registry_refresh_picks_up_new_skill", async () => {
    const configManager = createStubConfigManager([skillsDir], workspaceDir);
    const memoryState = createStubMemoryState();

    const registry = new FridaySkillRegistryImpl({
      workspaceDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
      configManager,
      memoryStateService: memoryState,
    });

    // Initial refresh — empty directory
    await registry.refresh();
    expect(registry.list().length).toBe(0);

    // Add a skill after initial refresh
    const manifest = buildMinimalManifest({
      id: "late-arrival",
      name: "Late Arrival Skill",
      runtime: {
        kind: "shell",
        entrypoint: "run.sh",
        minHubVersion: "1.0.0",
        apiVersion: "1",
        timeoutMsDefault: 30_000,
      },
    });

    writeSkillToDir(skillsDir, "late-arrival", manifest, "#!/bin/sh\necho late");

    // Refresh again — should pick up the new skill
    await registry.refresh();

    const skills = registry.list();
    expect(skills.length).toBe(1);

    const lateSkill = registry.get("late-arrival");
    expect(lateSkill).not.toBeNull();
    expect(lateSkill!.manifest.id).toBe("late-arrival");
    expect(lateSkill!.manifest.name).toBe("Late Arrival Skill");

    await registry.close();
  });
});
