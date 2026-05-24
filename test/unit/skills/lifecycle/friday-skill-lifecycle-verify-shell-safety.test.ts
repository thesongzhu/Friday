/**
 * B1 path-traversal hardening — runtime proof through verifySkill.
 *
 * `friday-skill-lifecycle-service.ts` line ~1554 used to build the shell-scan
 * entrypoint path via `join(deps.managedSkillsDir, input.skillId)`. With an
 * adversarial skillId (e.g. `"../../etc"`), `join` resolves into the parent
 * directory and the subsequent `existsSync` + `readFileSync` would probe and
 * read arbitrary files matching the hardcoded candidate names
 * (index.sh / run.sh / etc).
 *
 * The fix swaps `join` for `resolveSafeInstallDir`, which:
 *   1. Sanitizes via `safeDirName` (strips null bytes, leading dots, `..`, etc.)
 *   2. Resolves the absolute path
 *   3. Uses `path.relative` containment to verify the result stays under the
 *      managed-skills root, throwing `INSTALL_PATH_ESCAPE` otherwise.
 *
 * The existing best-effort try/catch around the scan swallows the throw, so
 * the scan is correctly skipped on adversarial input and no out-of-base file
 * is read.
 *
 * These tests run `verifySkill` directly (not just the helper) to prove the
 * wiring catches the attack at the lifecycle-service boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFridaySkillLifecycleService,
  type FridaySkillRegistry,
} from "#skills";

function makeStubRegistry(getOverride?: () => unknown): FridaySkillRegistry {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    get: vi.fn(getOverride ?? (() => undefined)),
    list: vi.fn(() => []),
    findByIntent: vi.fn(() => undefined),
    findByPhrase: vi.fn(() => undefined),
    refresh: vi.fn(async () => {}),
    listForChannel: vi.fn(() => []),
    setUserAuthorization: vi.fn(),
    getUserAuthorization: vi.fn(() => undefined),
  } as unknown as FridaySkillRegistry;
}

interface DepsOverrides {
  managedSkillsDir: string;
  registeredSkill?: unknown;
  persistedSkill?: unknown;
}

function makeLifecycleDeps(opts: DepsOverrides) {
  const db = {
    withReadConnection: <T,>(fn: (handle: unknown) => T): T => fn({}),
    withWriteTransaction: <T,>(fn: (handle: unknown) => T): T => fn({}),
    close: () => {},
  };
  return {
    db: db as never,
    nowIso: () => "2026-05-24T14:30:00.000Z",
    managedSkillsDir: opts.managedSkillsDir,
    hubVersion: "1.0.0",
    supportedApiVersions: ["1"],
    registry: makeStubRegistry(() => opts.registeredSkill),
    installations: {} as never,
    packageInstaller: {} as never,
    signatureVerifier: {} as never,
    trustScoring: {
      computeScore: vi.fn(() => ({
        total: 50,
        signature: 0,
        integrity: 50,
        keyPinning: 0,
        sourcePolicy: 0,
        publisher: 0,
        freshness: 0,
        reasons: [],
      })),
    } as never,
    skillRepo: {
      getSkillById: vi.fn(() => opts.persistedSkill ?? null),
      listSkills: vi.fn(() => []),
    } as never,
    versionRepo: {
      listVersions: vi.fn(() => []),
      getVersion: vi.fn(() => null),
    } as never,
    installationRepo: {
      listBySkill: vi.fn(() => []),
    } as never,
  };
}

function makeRegisteredSkillMock(skillId: string) {
  return {
    skillId,
    manifest: {
      schemaVersion: "2.0",
      id: skillId,
      name: skillId,
      description: "B1 test skill",
      version: "1.0.0",
      kind: "automation",
      category: "utility",
      author: { name: "Test" },
      tags: [],
      runtime: {
        kind: "shell",
        entrypoint: "index.sh",
        minHubVersion: "0.1.0",
        apiVersion: "1",
        timeoutMsDefault: 30000,
      },
      triggers: { intents: [], phrases: [], channels: [] },
      invocation: { userInvocable: true, modelInvocable: true, priority: 50, modes: ["intent"] },
      requirements: { bins: [], env: [], config: [], os: ["darwin", "linux"] },
      inputs: [],
      outputs: [],
      permissions: { grants: [], promptOn: [] },
      executionTargets: { allowedSatelliteTypes: [], requiredCapabilities: [] },
    },
    validation: { ok: true, issues: [] },
    source: "local",
    origin: "managed",
    status: "installed",
    starter: false,
    tags: [],
    updateAvailable: false,
    managed: true,
    registryLoaded: true,
    trust: {
      trustTier: "trusted_local",
      executionMode: "sandbox",
    },
  };
}

describe("verifySkill — B1 path-traversal hardening for shellSafety scan", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let baseDir: string;
  let secretFilePath: string;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    // Set up a managed-skills root and a hostile "sibling" directory outside
    // that root containing the candidate filename. If the path-traversal
    // hardening fails, the scan would read this file.
    const root = mkdtempSync(join(tmpdir(), "friday-b1-shellsafety-"));
    baseDir = join(root, "managed-skills");
    mkdirSync(baseDir, { recursive: true });

    // Hostile sibling: an "index.sh" at the same level as the managed-skills
    // dir. A traversal-attempt skillId of "../hostile" would resolve to this
    // dir if the path-traversal hardening is broken.
    const hostileSibling = join(root, "hostile");
    mkdirSync(hostileSibling, { recursive: true });
    secretFilePath = join(hostileSibling, "index.sh");
    writeFileSync(
      secretFilePath,
      "#!/bin/bash\nrm -rf /\necho 'this file should NEVER be scanned'\n",
      "utf8",
    );
  });

  afterEach(() => {
    infoSpy.mockRestore();
    try {
      rmSync(baseDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  function findShellSafetyCheck(evidence: { preflight: { checks: ReadonlyArray<{ id: string; label: string; level: string }> } }) {
    return evidence.preflight.checks.find((c) => c.id === "shell-safety");
  }

  it("positive: legitimate skill entrypoint inside managedSkillsDir is scanned and a shell-safety preflight check is emitted", async () => {
    const skillId = "legit-skill";
    const skillDir = join(baseDir, skillId);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "index.sh"), "#!/bin/bash\necho hello\n", "utf8");

    const registered = makeRegisteredSkillMock(skillId);
    const deps = makeLifecycleDeps({ managedSkillsDir: baseDir, registeredSkill: registered });
    const service = createFridaySkillLifecycleService(deps);

    const evidence = await service.verifySkill({ skillId, userId: "user-1" });

    expect(evidence.skillId).toBe(skillId);
    const shellSafetyCheck = findShellSafetyCheck(evidence as never);
    expect(shellSafetyCheck).toBeDefined();
    expect(shellSafetyCheck!.label).toBe("Shell Safety");
  });

  it("traversal: skillId='../hostile' is sanitized — shellSafety is undefined and the out-of-base index.sh is NEVER read", async () => {
    // Register the "hostile" skillId so verifySkill gets past the SKILL_NOT_FOUND
    // gate at the top of the function. This simulates a future code path that
    // populates the registry from an untrusted source — defense-in-depth.
    const skillId = "../hostile";
    const registered = makeRegisteredSkillMock(skillId);
    const deps = makeLifecycleDeps({ managedSkillsDir: baseDir, registeredSkill: registered });
    const service = createFridaySkillLifecycleService(deps);

    // Sanity check that the out-of-base file exists and is non-empty BEFORE the call.
    expect(existsSync(secretFilePath)).toBe(true);
    const originalSize = readFileSync(secretFilePath, "utf8").length;
    expect(originalSize).toBeGreaterThan(0);

    // The traversal attempt should NOT throw — verifySkill completes — but the
    // shellSafety scan is silently skipped because resolveSafeInstallDir throws
    // INSTALL_PATH_ESCAPE inside the best-effort try/catch.
    const evidence = await service.verifySkill({ skillId, userId: "user-1" });

    expect(evidence.skillId).toBe(skillId);
    // Critical assertion: shellSafety is undefined because the scan path was
    // never reached. If the hardening regressed (back to bare `join`), the
    // scanner would have read secretFilePath and shellSafety would have a
    // populated verdict.
    expect(findShellSafetyCheck(evidence as never)).toBeUndefined();

    // The out-of-base file remains untouched (no side-effect from the scan).
    expect(existsSync(secretFilePath)).toBe(true);
    expect(readFileSync(secretFilePath, "utf8").length).toBe(originalSize);
  });

  it("traversal: skillId with leading slash (absolute path) is also sanitized and shellSafety stays undefined", async () => {
    const skillId = "/etc/passwd-attack";
    const registered = makeRegisteredSkillMock(skillId);
    const deps = makeLifecycleDeps({ managedSkillsDir: baseDir, registeredSkill: registered });
    const service = createFridaySkillLifecycleService(deps);

    const evidence = await service.verifySkill({ skillId, userId: "user-1" });

    expect(evidence.skillId).toBe(skillId);
    expect(findShellSafetyCheck(evidence as never)).toBeUndefined();
  });

  it("traversal: skillId with null bytes is sanitized and shellSafety stays undefined", async () => {
    const skillId = "evil ../escape";
    const registered = makeRegisteredSkillMock(skillId);
    const deps = makeLifecycleDeps({ managedSkillsDir: baseDir, registeredSkill: registered });
    const service = createFridaySkillLifecycleService(deps);

    const evidence = await service.verifySkill({ skillId, userId: "user-1" });

    expect(evidence.skillId).toBe(skillId);
    expect(findShellSafetyCheck(evidence as never)).toBeUndefined();
  });
});
