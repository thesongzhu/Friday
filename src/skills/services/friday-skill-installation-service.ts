import type { FridaySqliteLayer } from "#state";
import type { FridaySkillRepository } from "../persistence/friday-skill-repository.js";
import type { FridaySkillInstallationRepository } from "../persistence/friday-skill-installation-repository.js";
import type { FridaySkillVersionResolutionService } from "./friday-skill-version-resolution-service.js";
import type { FridaySkillSignatureVerifier } from "./friday-skill-signature-verifier.js";
import type { FridaySkillTrustScoringService } from "./friday-skill-trust-scoring-service.js";
import type { FridaySkillPermissionCheckService } from "./friday-skill-permission-check-service.js";
import type { FridaySkillPackageInstaller } from "./friday-skill-package-installer.js";
import type {
  FridaySkillInstallRequest,
  FridaySkillInstallResult,
} from "../model/friday-skill-catalog.types.js";
import { FridayDomainError } from "#errors";

// ─── Interface ───

export interface FridaySkillInstallationService {
  install(request: FridaySkillInstallRequest): Promise<FridaySkillInstallResult>;
  uninstall(skillId: string): void;
}

// ─── Dependencies ───

export interface CreateSkillInstallationServiceDeps {
  db: FridaySqliteLayer;
  skillRepo: FridaySkillRepository;
  installationRepo: FridaySkillInstallationRepository;
  versionResolver: FridaySkillVersionResolutionService;
  signatureVerifier: FridaySkillSignatureVerifier;
  trustScoring: FridaySkillTrustScoringService;
  permissionCheck: FridaySkillPermissionCheckService;
  packageInstaller: FridaySkillPackageInstaller;
  idGenerator: () => string;
  nowIso: () => string;
  cacheTtlHours?: number;
  publishEvent?: (event: string, payload: unknown) => Promise<void>;
}

// ─── Factory ───

export function createFridaySkillInstallationService(
  deps: CreateSkillInstallationServiceDeps,
): FridaySkillInstallationService {
  const cacheTtlHours = deps.cacheTtlHours ?? 6;

  return {
    async install(request) {
      // 1. Resolve version
      const resolved = deps.versionResolver.resolve({
        skillId: request.skillId,
        requestedVersion: request.version,
        strategy: "install",
        sourceId: request.sourceId,
      });

      // 2. Create installation rows
      const targets: (string | undefined)[] = request.targetSatelliteIds ?? [undefined];
      const installationIds: string[] = [];

      deps.db.withWriteTransaction((conn) => {
        for (const satId of targets) {
          const instId = deps.idGenerator();
          deps.installationRepo.insertInstallation(conn, {
            id: instId,
            skillId: request.skillId,
            version: resolved.version,
            satelliteId: satId || undefined,
            status: "installing",
            permissionsGranted: request.grantPermissions ?? [],
            nowIso: deps.nowIso(),
          });
          installationIds.push(instId);
        }
      });

      void cacheTtlHours;
      void deps.signatureVerifier;
      void deps.trustScoring;
      void deps.permissionCheck;
      void resolved;
      const errorMsg = "External skill package installation is retired; use local, generated, or bundled skills.";
      deps.db.withWriteTransaction((conn) => {
        for (const instId of installationIds) {
          deps.installationRepo.setInstallationError(conn, instId, errorMsg, deps.nowIso());
        }
      });
      throw new FridayDomainError("SKILL_EXTERNAL_INSTALL_RETIRED", errorMsg, { httpStatus: 410 });
    },

    uninstall(skillId) {
      deps.db.withWriteTransaction((conn) => {
        const skill = deps.skillRepo.getSkillById(conn, skillId);
        if (!skill) return;

        if (skill.installedVersion) {
          deps.packageInstaller.remove(skillId, skill.installedVersion);
        }

        deps.skillRepo.clearInstalledVersion(conn, skillId, deps.nowIso());

        // Mark current installations as uninstalled
        const installations = deps.installationRepo.listBySkill(conn, skillId);
        for (const inst of installations) {
          if (inst.status === "installed") {
            deps.installationRepo.setInstallationStatus(
              conn,
              inst.id,
              "uninstalled",
              deps.nowIso(),
            );
          }
        }
      });
    },
  };
}
