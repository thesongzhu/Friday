import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayMarketplaceCacheRepository,
  createFridayMarketplaceDiscoveryService,
  createFridayMarketplaceSourceRepository,
  createFridaySkillInstallationRepository,
  createFridaySkillLifecycleService,
  createFridaySkillRepository,
  createFridaySkillSignatureVerifier,
  createFridaySkillTrustScoringService,
  createFridaySkillVersionRepository,
} from "#skills";
import type { FridaySkillRegistry } from "#skills";
import { createTestDb, createTestManifest, NOW } from "./marketplace.helper.js";

describe("FridaySkillLifecycleService", () => {
  let db: FridaySqliteLayer;
  let managedSkillsDir: string;

  beforeEach(() => {
    db = createTestDb();
    managedSkillsDir = mkdtempSync(join(tmpdir(), "friday-skill-lifecycle-"));
  });

  afterEach(() => {
    db.close();
    rmSync(managedSkillsDir, { recursive: true, force: true });
  });

  function createLifecycle(overrides: {
    selfHealing?: { reportStructuredFailure: ReturnType<typeof vi.fn> };
    install?: ReturnType<typeof vi.fn>;
    packageInstaller?: {
      remove: ReturnType<typeof vi.fn>;
    };
    registry?: FridaySkillRegistry;
  } = {}) {
    const sourceRepo = createFridayMarketplaceSourceRepository();
    const cacheRepo = createFridayMarketplaceCacheRepository();
    const skillRepo = createFridaySkillRepository();
    const versionRepo = createFridaySkillVersionRepository();
    const installationRepo = createFridaySkillInstallationRepository();
    const discovery = createFridayMarketplaceDiscoveryService({ db, cacheRepo });
    const registry: FridaySkillRegistry = overrides.registry ?? {
      list: () => [],
      get: () => null,
      resolveByIntent: () => null,
      validateAll: () => [],
      reload: async () => {},
      refresh: async () => {},
      isCompatible: () => ({ compatible: true, reasons: [] }),
      startWatching: async () => {},
      stopWatching: async () => {},
      close: async () => {},
    };

    return {
      sourceRepo,
      cacheRepo,
      skillRepo,
      versionRepo,
      installationRepo,
      lifecycle: createFridaySkillLifecycleService({
        db,
        nowIso: () => NOW,
        managedSkillsDir,
        hubVersion: "0.3.1",
        supportedApiVersions: ["1"],
        registry,
        discovery,
        installations: {
          install: overrides.install ?? vi.fn(async () => ({
            installationIds: ["inst-1"],
            resolvedVersion: "1.0.0",
            verification: {
              integrityValid: true,
              signatureValid: true,
              checks: ["integrity:pass"],
            },
            trust: {
              total: 90,
              signature: 30,
              integrity: 30,
              keyPinning: 10,
              sourcePolicy: 10,
              publisher: 5,
              freshness: 5,
              reasons: [],
            },
          })),
        } as never,
        packageInstaller: {
          remove: overrides.packageInstaller?.remove ?? vi.fn(),
        } as never,
        signatureVerifier: createFridaySkillSignatureVerifier(),
        trustScoring: createFridaySkillTrustScoringService(),
        skillRepo,
        versionRepo,
        installationRepo,
        sourceRepo,
        cacheRepo,
        selfHealing: overrides.selfHealing as never,
      }),
    };
  }

  it("merges catalog state with installed lifecycle state", () => {
    const { lifecycle, sourceRepo, cacheRepo, skillRepo, versionRepo, installationRepo } = createLifecycle();
    const manifest = createTestManifest({
      id: "skill.alpha",
      name: "Alpha",
      version: "1.1.0",
      requirements: {
        bins: [],
        env: ["ALPHA_TOKEN"],
        config: ["alpha.region"],
        os: ["darwin", "linux"],
      },
    });

    db.withWriteTransaction((writer) => {
      sourceRepo.insertSource(writer, "src-1", {
        name: "Friday Skills",
        baseUrl: "https://skills.example.com",
        trustPolicy: "warn",
        pinnedKeyIds: [],
      }, NOW);
      cacheRepo.upsertCacheEntry(writer, {
        id: "cache-1",
        sourceId: "src-1",
        skillId: "skill.alpha",
        version: "1.1.0",
        manifestJson: JSON.stringify(manifest),
        signatureValid: true,
        indexedAt: NOW,
        trustScore: 91,
        nowIso: NOW,
      });
      skillRepo.upsertSkillFromMarketplace(writer, {
        id: "skill.alpha",
        name: "Alpha",
        source: "marketplace",
        origin: "managed",
        publisher: "Friday",
        latestVersion: "1.1.0",
        status: "installed",
        currentManifest: manifest,
        nowIso: NOW,
      });
      skillRepo.setInstalledVersion(writer, "skill.alpha", "1.0.0", createTestManifest({
        id: "skill.alpha",
        name: "Alpha",
        version: "1.0.0",
        requirements: {
          bins: [],
          env: ["ALPHA_TOKEN"],
          config: ["alpha.region"],
          os: ["darwin", "linux"],
        },
      }), NOW);
      versionRepo.upsertVersion(writer, {
        id: "version-1",
        skillId: "skill.alpha",
        version: "1.0.0",
        checksum: "abc",
        manifest: createTestManifest({
          id: "skill.alpha",
          version: "1.0.0",
          requirements: {
            bins: [],
            env: ["ALPHA_TOKEN"],
            config: ["alpha.region"],
            os: ["darwin", "linux"],
          },
        }),
        releasedAt: NOW,
        nowIso: NOW,
      });
      installationRepo.insertInstallation(writer, {
        id: "inst-1",
        skillId: "skill.alpha",
        version: "1.0.0",
        status: "installed",
        permissionsGranted: ["network.connect"],
        nowIso: NOW,
      });
    });

    const catalog = lifecycle.listCatalog({ limit: 20, includeStale: true });
    expect(catalog.items[0]).toMatchObject({
      skillId: "skill.alpha",
      installed: true,
      installedVersion: "1.0.0",
      updateAvailable: true,
      originType: "generated",
      maturity: "stable",
      verificationStatus: "trusted",
      eligibility: {
        verdict: "needs_configuration",
        installable: true,
        reviewRequired: true,
      },
    });
    expect(catalog.items[0]?.requirementPreview.missingEnv).toEqual(["ALPHA_TOKEN"]);
    expect(catalog.items[0]?.requirementPreview.unresolvedConfig).toEqual(["alpha.region"]);
    expect(catalog.items[0]?.permissionPreview.required).toContain("network.connect");
    expect(catalog.items[0]?.installPlan.sourceTrustPolicy).toBe("warn");

    const detail = lifecycle.getSkill("skill.alpha");
    expect(detail).toMatchObject({
      skillId: "skill.alpha",
      installedVersion: "1.0.0",
      latestVersion: "1.1.0",
      originType: "generated",
      maturity: "stable",
      verificationStatus: "trusted",
      eligibility: {
        verdict: "needs_configuration",
      },
    });
    expect(detail?.sourceDetails?.id).toBe("src-1");
    expect(detail?.versions).toHaveLength(1);
    expect(detail?.installations).toHaveLength(1);
    expect(detail?.installPlan.targetVersion).toBe("1.1.0");
    expect(detail?.latestFailure).toBeUndefined();
  });

  it("derives cli-backed origin and verified maturity for shell-oriented skills", () => {
    const { lifecycle, sourceRepo, cacheRepo } = createLifecycle();
    const manifest = createTestManifest({
      id: "skill.cli",
      name: "CLI Helper",
      runtime: {
        kind: "shell",
        entrypoint: "run.sh",
        minHubVersion: "0.1.0",
        apiVersion: "1",
        timeoutMsDefault: 30_000,
      },
      tags: ["cli"],
    });

    db.withWriteTransaction((writer) => {
      sourceRepo.insertSource(writer, "src-cli", {
        name: "Friday Skills",
        baseUrl: "https://skills.example.com",
        trustPolicy: "warn",
        pinnedKeyIds: [],
      }, NOW);
      cacheRepo.upsertCacheEntry(writer, {
        id: "cache-cli",
        sourceId: "src-cli",
        skillId: "skill.cli",
        version: "1.0.0",
        manifestJson: JSON.stringify(manifest),
        signatureValid: true,
        indexedAt: NOW,
        trustScore: 91,
        nowIso: NOW,
      });
    });

    const detail = lifecycle.getSkill("skill.cli");
    expect(detail).toMatchObject({
      originType: "cli-backed",
      maturity: "verified",
    });
  });

  it("reports verification failures to self-healing and marks deleted skills unavailable", async () => {
    const reportStructuredFailure = vi.fn();
    const remove = vi.fn();
    const { lifecycle, skillRepo, installationRepo } = createLifecycle({
      selfHealing: { reportStructuredFailure },
      packageInstaller: { remove },
    });

    db.withWriteTransaction((writer) => {
      skillRepo.upsertSkillFromMarketplace(writer, {
        id: "skill.beta",
        name: "Beta",
        source: "marketplace",
        origin: "managed",
        publisher: "Friday",
        latestVersion: "1.0.0",
        status: "installed",
        currentManifest: createTestManifest({ id: "skill.beta", name: "Beta", version: "1.0.0" }),
        nowIso: NOW,
      });
      skillRepo.setInstalledVersion(writer, "skill.beta", "1.0.0", createTestManifest({
        id: "skill.beta",
        name: "Beta",
        version: "1.0.0",
      }), NOW);
      installationRepo.insertInstallation(writer, {
        id: "inst-failed",
        skillId: "skill.beta",
        version: "1.0.0",
        status: "failed",
        permissionsGranted: [],
        nowIso: NOW,
      });
      installationRepo.setInstallationError(writer, "inst-failed", "Broken package", NOW);
    });

    const installedDir = join(managedSkillsDir, "skill-beta", "1.0.0");
    mkdirSync(installedDir, { recursive: true });
    writeFileSync(join(installedDir, "not-a-skill.txt"), "broken");

    const evidence = await lifecycle.verifySkill({ skillId: "skill.beta", userId: "user-1" });
    expect(evidence.ok).toBe(false);
    expect(reportStructuredFailure).toHaveBeenCalledTimes(1);
    expect(lifecycle.getSkill("skill.beta")?.latestFailure).toMatchObject({
      installationId: "inst-failed",
      message: "Broken package",
    });

    await lifecycle.deleteSkill({ skillId: "skill.beta", deletedBy: "user-1" });
    expect(remove).toHaveBeenCalledWith("skill.beta", "1.0.0");
    expect(lifecycle.getSkill("skill.beta")).toBeNull();
  });
});
