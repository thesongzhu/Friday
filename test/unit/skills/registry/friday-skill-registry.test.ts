import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FridaySkillRegistryImpl } from "#skills";
import type { FridayHubConfigManagerService } from "#hub";
import type { FridayHubMemoryStateService } from "#hub";
import { makeManifest } from "../_helpers/make-manifest.helper.js";

function createMockConfigManager(
  workspaceDir: string,
  bundledDir: string,
  managedDir: string,
): FridayHubConfigManagerService {
  return {
    getCurrentConfig: vi.fn(),
    getConfig: vi.fn(),
    validatePatch: vi.fn(),
    applyPatch: vi.fn(),
    listRevisions: vi.fn(),
    revertToRevision: vi.fn(),
    getSkillRegistrySettings: vi.fn().mockResolvedValue({
      workspaceDir,
      bundledSkillsDir: bundledDir,
      managedSkillsDir: managedDir,
      extraSkillDirs: [],
      watchEnabled: false,
      watchDebounceMs: 300,
    }),
    getSkillSecurityProfile: vi.fn().mockResolvedValue({}),
  } as unknown as FridayHubConfigManagerService;
}

function createMockMemoryState(): FridayHubMemoryStateService {
  return {
    listSkillStatuses: vi.fn().mockResolvedValue({}),
    upsertDiscoveredSkills: vi.fn().mockResolvedValue(undefined),
    updateSkillStatus: vi.fn(),
    appendAuditLog: vi.fn(),
    getSession: vi.fn(),
    appendSessionMessage: vi.fn(),
    getMemoryItems: vi.fn(),
    putMemoryItem: vi.fn(),
  } as unknown as FridayHubMemoryStateService;
}

describe("FridaySkillRegistryImpl", () => {
  let workspaceDir: string;
  let bundledDir: string;
  let managedDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "friday-test-registry-ws-"));
    bundledDir = join(workspaceDir, "bundled");
    managedDir = join(workspaceDir, "managed");
    mkdirSync(bundledDir, { recursive: true });
    mkdirSync(managedDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("discovers and registers skills on refresh", async () => {
    // Create a bundled skill
    const skillDir = join(bundledDir, "hello-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "skill.manifest.json"),
      JSON.stringify(makeManifest({ id: "hello", name: "Hello Skill" })),
    );
    writeFileSync(join(skillDir, "index.ts"), "export default {}");

    const registry = new FridaySkillRegistryImpl({
      workspaceDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
      configManager: createMockConfigManager(workspaceDir, bundledDir, managedDir),
      memoryStateService: createMockMemoryState(),
    });

    await registry.initialize();

    const skills = registry.list();
    expect(skills.length).toBeGreaterThanOrEqual(1);
    expect(registry.get("hello")).toBeDefined();
    expect(registry.get("hello")!.manifest.name).toBe("Hello Skill");
  });

  it("higher precedence origin overwrites lower on collision", async () => {
    // Create same skill ID in both bundled and workspace
    const bundledSkill = join(bundledDir, "dup-skill");
    mkdirSync(bundledSkill, { recursive: true });
    writeFileSync(
      join(bundledSkill, "skill.manifest.json"),
      JSON.stringify(makeManifest({ id: "dup", name: "Bundled Version" })),
    );
    writeFileSync(join(bundledSkill, "index.ts"), "export default {}");

    // Workspace skill directory: per §2.7.1, workspace root is <workspaceDir>/skills/
    const wsSkillsDir = join(workspaceDir, "skills");
    const wsSkillDir = join(wsSkillsDir, "dup-skill");
    mkdirSync(wsSkillDir, { recursive: true });
    writeFileSync(
      join(wsSkillDir, "skill.manifest.json"),
      JSON.stringify(makeManifest({ id: "dup", name: "Workspace Version" })),
    );
    writeFileSync(join(wsSkillDir, "index.ts"), "export default {}");

    const registry = new FridaySkillRegistryImpl({
      workspaceDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
      configManager: createMockConfigManager(workspaceDir, bundledDir, managedDir),
      memoryStateService: createMockMemoryState(),
    });

    await registry.initialize();

    const dup = registry.get("dup");
    expect(dup).toBeDefined();
    // Workspace has higher precedence than bundled
    expect(dup!.manifest.name).toBe("Workspace Version");
  });

  it("resolveByIntent returns highest priority match", async () => {
    const skill1Dir = join(bundledDir, "skill1");
    mkdirSync(skill1Dir, { recursive: true });
    writeFileSync(
      join(skill1Dir, "skill.manifest.json"),
      JSON.stringify(
        makeManifest({
          id: "skill1",
          triggers: { intents: ["send-email"], phrases: [], channels: [] },
          invocation: { userInvocable: true, modelInvocable: true, priority: 10, modes: ["intent"] },
        }),
      ),
    );
    writeFileSync(join(skill1Dir, "index.ts"), "export default {}");

    const skill2Dir = join(bundledDir, "skill2");
    mkdirSync(skill2Dir, { recursive: true });
    writeFileSync(
      join(skill2Dir, "skill.manifest.json"),
      JSON.stringify(
        makeManifest({
          id: "skill2",
          triggers: { intents: ["send-email"], phrases: [], channels: [] },
          invocation: { userInvocable: true, modelInvocable: true, priority: 50, modes: ["intent"] },
        }),
      ),
    );
    writeFileSync(join(skill2Dir, "index.ts"), "export default {}");

    const memState = createMockMemoryState();
    // Mark both as installed
    (memState.listSkillStatuses as ReturnType<typeof vi.fn>).mockResolvedValue({
      skill1: "installed",
      skill2: "installed",
    });

    const registry = new FridaySkillRegistryImpl({
      workspaceDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
      configManager: createMockConfigManager(workspaceDir, bundledDir, managedDir),
      memoryStateService: memState,
    });

    await registry.initialize();

    const resolved = registry.resolveByIntent("send-email", {});
    expect(resolved).toBeDefined();
    expect(resolved!.manifest.id).toBe("skill2"); // higher priority
  });

  it("isCompatible returns compatible for matching versions", () => {
    const registry = new FridaySkillRegistryImpl({
      workspaceDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
      configManager: createMockConfigManager(workspaceDir, bundledDir, managedDir),
      memoryStateService: createMockMemoryState(),
    });

    const manifest = makeManifest();
    const result = registry.isCompatible(manifest);
    expect(result.compatible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("isCompatible returns incompatible for bad hub version", () => {
    const registry = new FridaySkillRegistryImpl({
      workspaceDir,
      hubVersion: "0.1.0",
      supportedApiVersions: ["1"],
      configManager: createMockConfigManager(workspaceDir, bundledDir, managedDir),
      memoryStateService: createMockMemoryState(),
    });

    const manifest = makeManifest({
      runtime: {
        kind: "node",
        entrypoint: "index.ts",
        minHubVersion: "5.0.0",
        apiVersion: "1",
        timeoutMsDefault: 30_000,
      },
    });
    const result = registry.isCompatible(manifest);
    expect(result.compatible).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("close cleans up registry", async () => {
    const registry = new FridaySkillRegistryImpl({
      workspaceDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
      configManager: createMockConfigManager(workspaceDir, bundledDir, managedDir),
      memoryStateService: createMockMemoryState(),
    });

    await registry.initialize();
    await registry.close();
    expect(registry.list()).toEqual([]);
  });
});
