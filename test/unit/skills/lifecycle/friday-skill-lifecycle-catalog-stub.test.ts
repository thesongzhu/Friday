/**
 * B1 catalog truth-labeling tests.
 *
 * When `createFridaySkillLifecycleService` is constructed without a catalog
 * backend:
 *   1. A one-time INFO log is emitted at service creation advising operators
 *      that catalog-derived enrichments are proof_pending in this build.
 *   2. `listCatalog(query)` returns `{ items: [], total: 0 }` for every query.
 *   3. `getSkill(skillId)` returns a summary built from persisted + registry
 *      state only — `sourceDetails` and `catalogEntry` are always `undefined`.
 *
 * The wired backend path is tested below for both manifest-v2 packages and
 * legacy SKILL.md-only packages, matching D21's read-only discovery slice.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  createFridayManagedSkillsCatalogBackend,
  createFridaySkillLifecycleService,
  type CreateFridaySkillLifecycleServiceDeps,
  type FridaySkillRegistry,
} from "#skills";

function makeStubRegistry(): FridaySkillRegistry {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    get: vi.fn(() => undefined),
    list: vi.fn(() => []),
    findByIntent: vi.fn(() => undefined),
    findByPhrase: vi.fn(() => undefined),
    refresh: vi.fn(async () => {}),
    listForChannel: vi.fn(() => []),
    setUserAuthorization: vi.fn(),
    getUserAuthorization: vi.fn(() => undefined),
  } as unknown as FridaySkillRegistry;
}

function makeMinimalDeps(
  overrides: Partial<CreateFridaySkillLifecycleServiceDeps> = {},
): CreateFridaySkillLifecycleServiceDeps {
  // Database stub: returns null/empty for every read; no writes expected in
  // listCatalog or getSkill(unknown).
  const db = {
    withReadConnection: <T,>(fn: (handle: unknown) => T): T => fn({}),
    withWriteTransaction: <T,>(fn: (handle: unknown) => T): T => fn({}),
    close: () => {},
  };
  return {
    db: db as never,
    nowIso: () => "2026-05-24T13:30:00.000Z",
    managedSkillsDir: "/tmp/friday-b1-test-skills",
    hubVersion: "1.0.0",
    supportedApiVersions: ["1"],
    registry: makeStubRegistry(),
    installations: {} as never,
    packageInstaller: {} as never,
    signatureVerifier: {} as never,
    trustScoring: {} as never,
    skillRepo: {
      getSkillById: vi.fn(() => null),
      listSkills: vi.fn(() => []),
      listAll: vi.fn(() => []),
    } as never,
    versionRepo: {
      listVersions: vi.fn(() => []),
    } as never,
    installationRepo: {
      listBySkill: vi.fn(() => []),
    } as never,
    ...overrides,
  };
}

async function makeManagedSkillDir(): Promise<string> {
  const managedSkillsDir = await mkdtemp(join(tmpdir(), "friday-d21-skill-catalog-"));
  const skillDir = join(managedSkillsDir, "live-catalog-smoke");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "run.sh"), "#!/bin/sh\nprintf 'live-catalog-smoke'\n");
  writeFileSync(
    join(skillDir, "skill.manifest.json"),
    JSON.stringify({
      schemaVersion: "2.0",
      id: "live-catalog-smoke",
      name: "Live Catalog Smoke",
      description: "Exposes a managed skill through the read-only lifecycle catalog.",
      version: "1.0.0",
      kind: "conversation",
      category: "utility",
      author: {
        name: "Friday",
      },
      tags: ["managed", "starter"],
      runtime: {
        kind: "shell",
        entrypoint: "run.sh",
        minHubVersion: "1.0.0",
        apiVersion: "1",
        timeoutMsDefault: 30000,
      },
      triggers: {
        intents: ["catalog_smoke"],
        phrases: ["catalog smoke"],
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
        os: ["darwin", "linux"],
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
        allowedSatelliteTypes: ["desktop", "cloud-vm"],
        requiredCapabilities: [],
      },
      telemetry: {
        events: [],
      },
    }),
  );
  return managedSkillsDir;
}

async function makeLegacySkillMdDir(): Promise<string> {
  const managedSkillsDir = await mkdtemp(join(tmpdir(), "friday-d21-legacy-skill-catalog-"));
  const skillDir = join(managedSkillsDir, "legacy-markdown-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: Legacy Markdown Skill",
      "skillKey: legacy-markdown-skill",
      "primaryEnv: FRIDAY_LEGACY_SKILL_TOKEN",
      "---",
      "Summarizes open SKILL.md packages through Friday's governed catalog.",
      "",
      "Use this when a user wants to inspect a legacy markdown skill before install.",
    ].join("\n"),
  );
  return managedSkillsDir;
}

async function makeTamperedSignedSkillDir(): Promise<string> {
  const managedSkillsDir = await mkdtemp(join(tmpdir(), "friday-a8-tampered-skill-catalog-"));
  const skillDir = join(managedSkillsDir, "tampered-signed-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "run.sh"), "#!/bin/sh\nprintf 'tampered'\n");
  writeFileSync(
    join(skillDir, "skill.manifest.json"),
    JSON.stringify({
      id: "tampered-signed-skill",
      name: "Tampered Signed Skill",
      description: "Declares a signature that does not verify against the local package bytes.",
      version: "1.0.0",
      runtime: {
        kind: "shell",
        entrypoint: "run.sh",
      },
      distribution: {
        integrity: {
          algorithm: "sha256",
          digest: "not-the-real-digest",
        },
        signature: {
          algorithm: "ed25519",
          keyId: "test-key",
          value: "definitely-not-a-valid-signature",
        },
      },
    }),
  );
  return managedSkillsDir;
}

async function makeEmptyShellSkillDir(): Promise<string> {
  const managedSkillsDir = await mkdtemp(join(tmpdir(), "friday-a8-empty-shell-skill-catalog-"));
  const skillDir = join(managedSkillsDir, "empty-shell-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "skill.manifest.json"),
    JSON.stringify({
      id: "empty-shell-skill",
      name: "Empty Shell Skill",
      description: "Declares a shell runtime without a real executable entrypoint.",
      version: "1.0.0",
      runtime: {
        kind: "shell",
        entrypoint: "run.sh",
      },
    }),
  );
  return managedSkillsDir;
}

describe("createFridaySkillLifecycleService — B1 catalog truth-labeling", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it("emits a one-time INFO log at service creation advising that catalog is proof_pending", () => {
    createFridaySkillLifecycleService(makeMinimalDeps());

    const catalogAdvisories = infoSpy.mock.calls.filter(([msg]) =>
      typeof msg === "string" && msg.includes("Catalog backend is not wired"),
    );
    expect(catalogAdvisories).toHaveLength(1);
    const [message] = catalogAdvisories[0]!;
    expect(message).toContain("listCatalog()");
    expect(message).toContain("getSkill()");
    expect(message).toContain("proof_pending");
  });

  it("listCatalog returns {items: [], total: 0} for any query (catalog backend not wired)", () => {
    const service = createFridaySkillLifecycleService(makeMinimalDeps());

    const result = service.listCatalog({} as never);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("listCatalog returns empty for queries with filters too (no query parameter changes the result)", () => {
    const service = createFridaySkillLifecycleService(makeMinimalDeps());

    const result = service.listCatalog({
      query: "starter",
      tags: ["productivity"],
      category: "utility",
    } as never);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("getSkill returns null for an unknown skillId when neither persisted nor registered", () => {
    const service = createFridaySkillLifecycleService(makeMinimalDeps());

    const result = service.getSkill("unknown-skill-id");
    expect(result).toBeNull();
  });

  it("creating multiple services emits one advisory per creation (no global de-dup)", () => {
    // The advisory is per-instance — operators get one notice per process-managed
    // service so the diagnostic is visible regardless of how many lifecycles exist.
    createFridaySkillLifecycleService(makeMinimalDeps());
    createFridaySkillLifecycleService(makeMinimalDeps());

    const catalogAdvisories = infoSpy.mock.calls.filter(([msg]) =>
      typeof msg === "string" && msg.includes("Catalog backend is not wired"),
    );
    expect(catalogAdvisories).toHaveLength(2);
  });

  it("listCatalog exposes managed-skills entries when a read-only catalog backend is wired", async () => {
    const managedSkillsDir = await makeManagedSkillDir();
    try {
      const service = createFridaySkillLifecycleService(makeMinimalDeps({
        managedSkillsDir,
        catalog: createFridayManagedSkillsCatalogBackend({
          managedSkillsDir,
          workspaceDir: managedSkillsDir,
          nowIso: () => "2026-05-24T13:30:00.000Z",
        }),
      }));

      const result = service.listCatalog({ q: "smoke" } as never);
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        sourceId: "managed-skills",
        skillId: "live-catalog-smoke",
        skillName: "Live Catalog Smoke",
        publisher: "Friday",
        category: "utility",
        implementationStatus: "installed",
      });
      expect(result.items[0]?.sourceDetails).toMatchObject({
        id: "managed-skills",
        enabled: true,
        trustPolicy: "warn",
      });
      expect(result.items[0]?.firstUsePrompts).toEqual(["catalog smoke", "catalog_smoke"]);
    } finally {
      rmSync(managedSkillsDir, { recursive: true, force: true });
    }
  });

  it("getSkill enriches summaries with catalogEntry and sourceDetails from the backend", async () => {
    const managedSkillsDir = await makeManagedSkillDir();
    try {
      const service = createFridaySkillLifecycleService(makeMinimalDeps({
        managedSkillsDir,
        catalog: createFridayManagedSkillsCatalogBackend({
          managedSkillsDir,
          workspaceDir: managedSkillsDir,
          nowIso: () => "2026-05-24T13:30:00.000Z",
        }),
      }));

      const result = service.getSkill("live-catalog-smoke");
      expect(result).toMatchObject({
        skillId: "live-catalog-smoke",
        name: "Live Catalog Smoke",
        sourceId: "managed-skills",
        sourceDetails: {
          id: "managed-skills",
          enabled: true,
        },
        catalogEntry: {
          skillId: "live-catalog-smoke",
          sourceId: "managed-skills",
          implementationStatus: "installed",
        },
      });
    } finally {
      rmSync(managedSkillsDir, { recursive: true, force: true });
    }
  });

  it("listCatalog exposes SKILL.md-only managed entries through the legacy fallback", async () => {
    const managedSkillsDir = await makeLegacySkillMdDir();
    try {
      const service = createFridaySkillLifecycleService(makeMinimalDeps({
        managedSkillsDir,
        catalog: createFridayManagedSkillsCatalogBackend({
          managedSkillsDir,
          workspaceDir: managedSkillsDir,
          nowIso: () => "2026-05-24T13:30:00.000Z",
        }),
      }));

      const result = service.listCatalog({ q: "markdown" } as never);
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        sourceId: "managed-skills",
        skillId: "legacy-markdown-skill",
        skillName: "Legacy Markdown Skill",
        publisher: "unknown",
        version: "0.0.0",
        category: "utility",
        implementationStatus: "installed",
        sourceDetails: {
          id: "managed-skills",
          enabled: true,
          trustPolicy: "warn",
        },
        manifest: {
          id: "legacy-markdown-skill",
          name: "Legacy Markdown Skill",
          runtime: {
            kind: "builtin",
            entrypoint: "",
          },
          requirements: {
            env: ["FRIDAY_LEGACY_SKILL_TOKEN"],
          },
        },
      });
      expect(result.items[0]?.manifest.description).toBe(
        "Summarizes open SKILL.md packages through Friday's governed catalog.",
      );
    } finally {
      rmSync(managedSkillsDir, { recursive: true, force: true });
    }
  });

  it("does not mark tampered managed skill signatures as valid catalog evidence", async () => {
    const managedSkillsDir = await makeTamperedSignedSkillDir();
    try {
      const service = createFridaySkillLifecycleService(makeMinimalDeps({
        managedSkillsDir,
        catalog: createFridayManagedSkillsCatalogBackend({
          managedSkillsDir,
          workspaceDir: managedSkillsDir,
          nowIso: () => "2026-05-24T13:30:00.000Z",
        }),
      }));

      const result = service.listCatalog({ q: "tampered" } as never);
      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({
        skillId: "tampered-signed-skill",
        signatureValid: false,
        verificationStatus: "warning",
        implementationStatus: "catalog-only",
      });
      expect(result.items[0]?.blockedReasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining("signature"),
        ]),
      );
      expect(result.items[0]?.recommendedNextAction).toContain("signature");
    } finally {
      rmSync(managedSkillsDir, { recursive: true, force: true });
    }
  });

  it("does not present empty shell managed skills as installed and available", async () => {
    const managedSkillsDir = await makeEmptyShellSkillDir();
    try {
      const service = createFridaySkillLifecycleService(makeMinimalDeps({
        managedSkillsDir,
        catalog: createFridayManagedSkillsCatalogBackend({
          managedSkillsDir,
          workspaceDir: managedSkillsDir,
          nowIso: () => "2026-05-24T13:30:00.000Z",
        }),
      }));

      const result = service.listCatalog({ q: "empty shell" } as never);
      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({
        skillId: "empty-shell-skill",
        implementationStatus: "catalog-only",
      });
      expect(result.items[0]?.blockedReasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining("entrypoint"),
        ]),
      );
      expect(result.items[0]?.recommendedNextAction).toContain("entrypoint");
    } finally {
      rmSync(managedSkillsDir, { recursive: true, force: true });
    }
  });
});
