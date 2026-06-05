import { afterEach, describe, expect, it, vi } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFridaySkillExecutor,
  createFridaySkillRunMutatingActionRequest,
  FridaySkillRegistryImpl,
  type FridaySkillRegistry,
  type SkillLifecycleStatus,
} from "#skills";
import { createFridaySkillRunStore } from "#ledger";
import type { FridayHubConfigManagerService, FridayHubMemoryStateService } from "#hub";
import type { FridayDiscoveredSkillRecord } from "#hub";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  signFridayCanonicalApproval,
} from "../../../src/security/friday-mutating-action-gate.js";
import { createTestDb, createTestIdGenerator } from "../../unit/satellites/_helpers/create-test-db.helper.js";

const SKILL_ID = "output-current-date-time";
const APPROVAL_SECRET = "friday-real-skill-add-test-secret"; // pragma: allowlist secret

function createConfigManager(workspaceDir: string, managedSkillsDir: string): FridayHubConfigManagerService {
  return {
    getCurrentConfig: vi.fn().mockResolvedValue({} as never),
    getConfig: vi.fn().mockResolvedValue({ revision: 1, settings: {} }),
    validatePatch: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
    applyPatch: vi.fn().mockResolvedValue({ revision: 1, changedKeys: [] }),
    listRevisions: vi.fn().mockResolvedValue({ items: [] }),
    revertToRevision: vi.fn().mockResolvedValue({ revision: 1, changedKeys: [], revertedFrom: 1 }),
    getSkillRegistrySettings: vi.fn().mockResolvedValue({
      workspaceDir,
      bundledSkillsDir: join(workspaceDir, "bundled-skills"),
      managedSkillsDir,
      extraSkillDirs: [],
      watchEnabled: false,
      watchDebounceMs: 300,
    }),
    getSkillSecurityProfile: vi.fn().mockResolvedValue({}),
  };
}

function createMemoryState() {
  const statuses: Record<string, SkillLifecycleStatus> = {};
  const discovered: FridayDiscoveredSkillRecord[] = [];
  const service: FridayHubMemoryStateService = {
    listSkillStatuses: vi.fn().mockResolvedValue(statuses),
    upsertDiscoveredSkills: vi.fn().mockImplementation(async (records: FridayDiscoveredSkillRecord[]) => {
      discovered.length = 0;
      discovered.push(...records);
      for (const record of records) {
        statuses[record.id] = record.status;
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
  return { service, statuses, discovered };
}

function createRegistry(input: {
  workspaceDir: string;
  managedSkillsDir: string;
  memoryState: FridayHubMemoryStateService;
}): FridaySkillRegistry {
  return new FridaySkillRegistryImpl({
    workspaceDir: input.workspaceDir,
    hubVersion: "1.0.0",
    supportedApiVersions: ["1"],
    configManager: createConfigManager(input.workspaceDir, input.managedSkillsDir),
    memoryStateService: input.memoryState,
  });
}

function installRepoSkillIntoManagedDir(managedSkillsDir: string): string {
  const sourceDir = join(process.cwd(), "managed-skills", SKILL_ID);
  const targetDir = join(managedSkillsDir, SKILL_ID);
  mkdirSync(managedSkillsDir, { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true });
  return targetDir;
}

function addLowerPriorityDuplicate(managedSkillsDir: string): void {
  const sourceDir = join(managedSkillsDir, SKILL_ID);
  const targetDir = join(managedSkillsDir, "low-priority-time-skill");
  cpSync(sourceDir, targetDir, { recursive: true });
  const manifestPath = join(targetDir, "skill.manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  manifest.id = "low-priority-time-skill";
  manifest.name = "Low Priority Time Skill";
  manifest.invocation = {
    ...(manifest.invocation as Record<string, unknown>),
    priority: 10,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

describe("Friday real skill add/use/memory behavior", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("discovers a managed skill, remembers installation, selects by intent, and runs only after canonical approval", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "friday-real-skill-add-"));
    tmpDirs.push(workspaceDir);
    const managedSkillsDir = join(workspaceDir, "managed-skills");
    const memory = createMemoryState();

    const registryBeforeAdd = createRegistry({
      workspaceDir,
      managedSkillsDir,
      memoryState: memory.service,
    });
    await registryBeforeAdd.initialize();
    expect(registryBeforeAdd.resolveByIntent("current_datetime", { channel: "desktop", mode: "intent" })).toBeNull();
    await registryBeforeAdd.close();

    const skillDir = installRepoSkillIntoManagedDir(managedSkillsDir);
    addLowerPriorityDuplicate(managedSkillsDir);

    const registry = createRegistry({
      workspaceDir,
      managedSkillsDir,
      memoryState: memory.service,
    });
    await registry.initialize();

    expect(registry.get(SKILL_ID)?.origin).toBe("managed");
    expect(registry.get(SKILL_ID)?.source).toBe("local");
    expect(registry.get(SKILL_ID)?.status).toBe("not_installed");
    expect(registry.resolveByIntent("current_datetime", { channel: "desktop", mode: "intent" })).toBeNull();

    await memory.service.updateSkillStatus(SKILL_ID, "installed");
    await memory.service.updateSkillStatus("low-priority-time-skill", "installed");
    await registry.refresh();

    const resolved = registry.resolveByIntent("current_datetime", { channel: "desktop", mode: "intent" });
    expect(resolved?.manifest.id).toBe(SKILL_ID);
    expect(resolved?.manifest.invocation.priority).toBe(50);

    await registry.close();
    const registryAfterRestart = createRegistry({
      workspaceDir,
      managedSkillsDir,
      memoryState: memory.service,
    });
    await registryAfterRestart.initialize();
    expect(registryAfterRestart.get(SKILL_ID)?.status).toBe("installed");
    expect(registryAfterRestart.resolveByIntent("current_datetime", { channel: "desktop", mode: "intent" })?.skillDir).toBe(skillDir);

    const db = createTestDb();
    try {
      const runStore = createFridaySkillRunStore({ db });
      const executor = createFridaySkillExecutor({
        db,
        registry: registryAfterRestart,
        runStore,
        idGenerator: createTestIdGenerator(),
        nowIso: () => "2026-06-04T12:00:00.000Z",
        canonicalMutationGate: createFridayMutatingActionGate({
          nowIso: () => "2026-06-04T12:00:00.000Z",
          ticketIdGenerator: () => "ticket-real-skill-run",
          approvalSignatureSecret: APPROVAL_SECRET,
          requireApprovalSignature: true,
        }),
      });

      const directResult = await executor.execute({
        skillId: SKILL_ID,
        input: {},
        sessionId: "session-real-skill",
        userId: "test-user",
        channel: "desktop",
      }).result;
      expect(directResult.status).toBe("failed");
      expect(directResult.output).toMatchObject({
        code: "SKILL_RUN_APPROVAL_REQUIRED",
        status: "installed",
      });

      const actor = { kind: "api", id: "test-user", principalId: "test-user" };
      const approvalRequest = createFridaySkillRunMutatingActionRequest({
        skillId: SKILL_ID,
        input: {},
        channel: "desktop",
        sessionId: "session-real-skill",
        actor,
        surface: "test:real-skill-add",
        idempotencyKey: "real-skill-run",
      });
      const canonicalApproval = signFridayCanonicalApproval({
        decision: "approved",
        approvalId: "approval-real-skill-run",
        decidedByPrincipalId: "test-user",
        actionDigest: createFridayMutatingActionDigest(approvalRequest),
        expiresAt: "2999-01-01T00:00:00.000Z",
      }, APPROVAL_SECRET);

      const approvedResult = await executor.execute({
        skillId: SKILL_ID,
        input: {},
        sessionId: "session-real-skill",
        userId: "test-user",
        channel: "desktop",
        canonicalApprovalRequest: approvalRequest,
        canonicalApproval,
      }).result;

      expect(approvedResult.status).toBe("completed");
      expect(approvedResult.output.dateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(runStore.getRun("test-id-0002")).toMatchObject({
        runId: "test-id-0002",
        skillId: SKILL_ID,
        status: "completed",
        sessionId: "session-real-skill",
        userId: "test-user",
        channel: "desktop",
      });
    } finally {
      db.close();
      await registryAfterRestart.close();
    }
  });
});
