import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FridaySkillRegistryImpl } from "#skills";
import type { FridaySkillRegistry } from "#skills";
import type { SkillManifestV2 } from "#skills";
import type { FridayHubConfigManagerService, FridayHubMemoryStateService } from "#hub";
import type { SkillLifecycleStatus } from "#skills";
import type { FridayDiscoveredSkillRecord } from "#hub";

function createStubConfigManager(
  workspaceDir: string,
  skillDir: string,
): FridayHubConfigManagerService {
  return {
    getCurrentConfig: vi.fn().mockResolvedValue({} as never),
    getConfig: vi.fn().mockResolvedValue({ revision: 1, settings: {} }),
    validatePatch: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
    applyPatch: vi.fn().mockResolvedValue({ revision: 1, changedKeys: [] }),
    listRevisions: vi.fn().mockResolvedValue({ items: [] }),
    revertToRevision: vi.fn().mockResolvedValue({ revision: 1, changedKeys: [], revertedFrom: 1 }),
    getSkillRegistrySettings: vi.fn().mockResolvedValue({
      workspaceDir,
      bundledSkillsDir: skillDir,
      managedSkillsDir: path.join(workspaceDir, "managed-skills"),
      extraSkillDirs: [],
      watchEnabled: false,
      watchDebounceMs: 300,
    }),
    getSkillSecurityProfile: vi.fn().mockResolvedValue({}),
  };
}

function createStubMemoryState(): FridayHubMemoryStateService {
  const statuses: Record<string, SkillLifecycleStatus> = {};
  return {
    listSkillStatuses: vi.fn().mockResolvedValue(statuses),
    upsertDiscoveredSkills: vi.fn().mockImplementation(async (records: FridayDiscoveredSkillRecord[]) => {
      for (const r of records) {
        statuses[r.id] = r.status;
      }
    }),
    updateSkillStatus: vi.fn().mockImplementation(async (skillId: string, status: SkillLifecycleStatus) => {
      statuses[skillId] = status;
    }),
    appendAuditLog: vi.fn(),
    getSession: vi.fn().mockResolvedValue(null),
    appendSessionMessage: vi.fn(),
    getMemoryItems: vi.fn().mockResolvedValue([]),
    putMemoryItem: vi.fn(),
  };
}

function buildManifest(overrides: Partial<SkillManifestV2>): SkillManifestV2 {
  const base: SkillManifestV2 = {
    schemaVersion: "2.0",
    id: "test-skill",
    name: "Test Skill",
    description: "A test skill",
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
    telemetry: {
      events: [],
    },
  };

  return {
    ...base,
    ...overrides,
    author: { ...base.author, ...overrides.author },
    runtime: { ...base.runtime, ...overrides.runtime },
    triggers: { ...base.triggers, ...overrides.triggers },
    invocation: { ...base.invocation, ...overrides.invocation },
    requirements: { ...base.requirements, ...overrides.requirements },
    permissions: { ...base.permissions, ...overrides.permissions },
    executionTargets: {
      ...base.executionTargets,
      ...overrides.executionTargets,
    },
    telemetry: {
      ...base.telemetry,
      ...overrides.telemetry,
    },
  };
}

function writeSkillManifest(dir: string, overrides: Partial<SkillManifestV2>): void {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = buildManifest(overrides);
  fs.writeFileSync(
    path.join(dir, "skill.manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  const entryPath = path.join(dir, manifest.runtime.entrypoint);
  fs.writeFileSync(entryPath, "#!/bin/sh\necho friday-skill-test\n");
  fs.chmodSync(entryPath, 0o755);
}

describe("FridaySkillRegistry Lifecycle (Integration)", () => {
  const tmpDirs: string[] = [];
  const registries: FridaySkillRegistry[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-skill-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const reg of registries) {
      try {
        await reg.close();
      } catch {
        // ignore
      }
    }
    registries.length = 0;

    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tmpDirs.length = 0;
  });

  function createRegistry(workspaceDir: string, skillDir: string): FridaySkillRegistry {
    const reg = new FridaySkillRegistryImpl({
      workspaceDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
      configManager: createStubConfigManager(workspaceDir, skillDir),
      memoryStateService: createStubMemoryState(),
    });
    registries.push(reg);
    return reg;
  }

  // ─── Register skill in registry ───

  describe("register and discover skills", () => {
    it("discovers and registers a valid skill from directory", async () => {
      const workspace = makeTmpDir();
      const skillsDir = path.join(workspace, "skills");
      const skillDir = path.join(skillsDir, "test-skill");

      writeSkillManifest(skillDir, {
        id: "test-skill",
        name: "Test Skill",
        version: "1.0.0",
        description: "A test skill",
        triggers: { intents: ["test"] },
      });

      const reg = createRegistry(workspace, skillsDir);
      await reg.initialize();

      const skills = reg.list();
      expect(skills.length).toBeGreaterThanOrEqual(1);

      const testSkill = reg.get("test-skill");
      expect(testSkill).not.toBeNull();
      expect(testSkill!.manifest.name).toBe("Test Skill");
      expect(testSkill!.status).toBe("installed");
    });
  });

  // ─── List skills ───

  describe("list skills", () => {
    it("lists all registered skills", async () => {
      const workspace = makeTmpDir();
      const skillsDir = path.join(workspace, "skills");

      writeSkillManifest(path.join(skillsDir, "skill-a"), {
        id: "skill-a",
        name: "Skill A",
        version: "1.0.0",
        description: "Skill A",
        triggers: { intents: ["a"] },
      });

      writeSkillManifest(path.join(skillsDir, "skill-b"), {
        id: "skill-b",
        name: "Skill B",
        version: "1.0.0",
        description: "Skill B",
        triggers: { intents: ["b"] },
      });

      const reg = createRegistry(workspace, skillsDir);
      await reg.initialize();

      const skills = reg.list();
      expect(skills).toHaveLength(2);
    });

    it("returns empty list when no skills directory exists", async () => {
      const workspace = makeTmpDir();
      const emptySkillsDir = path.join(workspace, "empty-skills");

      const reg = createRegistry(workspace, emptySkillsDir);
      await reg.initialize();

      expect(reg.list()).toHaveLength(0);
    });

    it("loads the bundled diagnosis and recovery starter skills from the repo starter pack", async () => {
      const workspace = process.cwd();
      const skillsDir = path.join(workspace, "skills");

      const reg = createRegistry(workspace, skillsDir);
      await reg.initialize();

      expect(reg.get("system-health-snapshot")).not.toBeNull();
      expect(reg.get("review-open-issues")).not.toBeNull();
      expect(reg.get("autofix-readiness-review")).not.toBeNull();
      expect(reg.get("failed-deploy-recovery-brief")).not.toBeNull();
      expect(reg.get("idea-clarifier")).not.toBeNull();
      expect(reg.get("implementation-plan-review")).not.toBeNull();
      expect(reg.get("browser-qa-report")).not.toBeNull();
      expect(reg.get("workspace-diff-review")).not.toBeNull();
      expect(reg.get("release-doc-sync")).not.toBeNull();
    });
  });

  // ─── Get skill by ID ───

  describe("get skill by ID", () => {
    it("returns null for nonexistent skill", async () => {
      const workspace = makeTmpDir();
      const skillsDir = path.join(workspace, "skills");
      fs.mkdirSync(skillsDir, { recursive: true });

      const reg = createRegistry(workspace, skillsDir);
      await reg.initialize();

      expect(reg.get("nonexistent")).toBeNull();
    });
  });

  // ─── Refresh registry ───

  describe("refresh", () => {
    it("discovers new skills after refresh", async () => {
      const workspace = makeTmpDir();
      const skillsDir = path.join(workspace, "skills");
      fs.mkdirSync(skillsDir, { recursive: true });

      const reg = createRegistry(workspace, skillsDir);
      await reg.initialize();
      expect(reg.list()).toHaveLength(0);

      // Add a skill after initial load
      writeSkillManifest(path.join(skillsDir, "late-skill"), {
        id: "late-skill",
        name: "Late Skill",
        version: "1.0.0",
        description: "Added after init",
        triggers: { intents: ["late"] },
      });

      await reg.refresh();
      expect(reg.list()).toHaveLength(1);
      expect(reg.get("late-skill")).not.toBeNull();
    });
  });
});
