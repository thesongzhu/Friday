import type { FridaySqliteLayer } from "#state";
import type { FridaySkillRepository } from "../persistence/friday-skill-repository.js";
import type { FridaySkillInstallationRepository } from "../persistence/friday-skill-installation-repository.js";
import type { FridaySkillVersionResolutionService } from "./friday-skill-version-resolution-service.js";
import type { FridaySkillSignatureVerifier } from "./friday-skill-signature-verifier.js";
import type { FridaySkillTrustScoringService } from "./friday-skill-trust-scoring-service.js";
import type { FridaySkillPermissionCheckService } from "./friday-skill-permission-check-service.js";
import type { FridaySkillPackageInstaller } from "./friday-skill-package-installer.js";
import type { FridayMarketplaceHttpClient } from "./friday-marketplace-http-client.js";
import type { FridayMarketplaceSourceRepository } from "../persistence/friday-marketplace-source-repository.js";
import type {
  FridayMarketplaceTrustPolicy,
  FridaySkillInstallRequest,
  FridaySkillInstallResult,
} from "../model/friday-skill-marketplace.types.js";
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
  sourceRepo: FridayMarketplaceSourceRepository;
  versionResolver: FridaySkillVersionResolutionService;
  signatureVerifier: FridaySkillSignatureVerifier;
  trustScoring: FridaySkillTrustScoringService;
  permissionCheck: FridaySkillPermissionCheckService;
  packageInstaller: FridaySkillPackageInstaller;
  httpClient: FridayMarketplaceHttpClient;
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

      // 3. Download package
      let packageBytes: Buffer;
      try {
        packageBytes = await deps.httpClient.fetchPackage(resolved.packageUrl);
      } catch (err) {
        const errorMsg = `Download failed: ${err instanceof Error ? err.message : String(err)}`;
        deps.db.withWriteTransaction((conn) => {
          for (const instId of installationIds) {
            deps.installationRepo.setInstallationError(conn, instId, errorMsg, deps.nowIso());
          }
        });
        throw new FridayDomainError("INSTALLATION_DOWNLOAD_FAILED", errorMsg, { httpStatus: 502, retryable: true });
      }

      // 4. Verify integrity + signature
      let signatureDoc = undefined;
      let publisherKey = undefined;
      let trustPolicy: FridayMarketplaceTrustPolicy | undefined;

      if (resolved.sourceId) {
        const source = deps.db.withReadConnection((conn) =>
          deps.sourceRepo.getSourceById(conn, resolved.sourceId),
        );
        if (source) {
          trustPolicy = source.trustPolicy;
          // Attempt to fetch signature and key
          try {
            const sigUrl = `${source.baseUrl.replace(/\/$/, "")}/skills/${resolved.skillId}/versions/${resolved.version}/signature.json`;
            signatureDoc = await deps.httpClient.fetchSignature(sigUrl);
            publisherKey = await deps.httpClient.fetchPublisherKey(source.baseUrl, signatureDoc.keyId);
          } catch (err) {
          console.warn("[friday][skill-installation-service] operation failed:", err instanceof Error ? err.message : String(err));
            // Signature artifacts optional for non-strict policies
          }
        }
      }

      // Fail closed: if source cannot be resolved, reject installation
      if (!trustPolicy) {
        const errorMsg = `Source not resolved for skill ${resolved.skillId}@${resolved.version}. Cannot determine trust policy; rejecting installation.`;
        deps.db.withWriteTransaction((conn) => {
          for (const instId of installationIds) {
            deps.installationRepo.setInstallationError(conn, instId, errorMsg, deps.nowIso());
          }
        });
        throw new FridayDomainError("INSTALLATION_SOURCE_UNRESOLVED", errorMsg, { httpStatus: 400 });
      }

      const pinnedKeyIds = resolved.sourceId
        ? deps.db.withReadConnection((conn) => {
            const source = deps.sourceRepo.getSourceById(conn, resolved.sourceId);
            return source?.pinnedKeyIds ?? [];
          })
        : [];

      const verification = deps.signatureVerifier.verifySignature({
        packageBytes,
        expectedChecksum: resolved.checksum,
        skillId: resolved.skillId,
        version: resolved.version,
        signatureDoc,
        publisherKey,
        pinnedKeyIds,
      });

      // 5. Compute trust score
      const trust = deps.trustScoring.computeScore({
        verification,
        trustPolicy,
        hasPinnedKeys: pinnedKeyIds.length > 0,
        keyPinningPassed: verification.checks.includes("key-pinning:pass"),
        publisherInstallCount: 0,
        indexedAt: deps.nowIso(),
        nowIso: deps.nowIso(),
        cacheTtlHours,
      });

      // 6. Evaluate policy
      const decision = deps.trustScoring.evaluatePolicy(trustPolicy, trust, verification);
      if (!decision.allowed) {
        const errorMsg = `Trust policy rejected: ${decision.reason}`;
        deps.db.withWriteTransaction((conn) => {
          for (const instId of installationIds) {
            deps.installationRepo.setInstallationError(conn, instId, errorMsg, deps.nowIso());
          }
        });
        throw new FridayDomainError("INSTALLATION_TRUST_REJECTED", errorMsg, { httpStatus: 403 });
      }

      // 7. Permission check
      const permResult = deps.permissionCheck.checkPermissions(
        resolved.manifest,
        request.grantPermissions ?? [],
      );
      if (!permResult.allowed) {
        const errorMsg = `Missing required permissions: ${permResult.missingRequired.join(", ")}`;
        deps.db.withWriteTransaction((conn) => {
          for (const instId of installationIds) {
            deps.installationRepo.setInstallationError(conn, instId, errorMsg, deps.nowIso());
          }
        });
        throw new FridayDomainError("INSTALLATION_PERMISSION_DENIED", errorMsg, { httpStatus: 403 });
      }

      // 8. Stage and activate package
      try {
        deps.packageInstaller.stage(resolved.skillId, resolved.version, packageBytes);
        deps.packageInstaller.activate(resolved.skillId, resolved.version);
      } catch (err) {
        const errorMsg = `Package installation failed: ${err instanceof Error ? err.message : String(err)}`;
        deps.db.withWriteTransaction((conn) => {
          for (const instId of installationIds) {
            deps.installationRepo.setInstallationError(conn, instId, errorMsg, deps.nowIso());
          }
        });
        throw new FridayDomainError("INSTALLATION_PACKAGE_FAILED", errorMsg, { httpStatus: 500 });
      }

      // 9. Update database state
      deps.db.withWriteTransaction((conn) => {
        deps.skillRepo.setInstalledVersion(
          conn,
          resolved.skillId,
          resolved.version,
          resolved.manifest,
          deps.nowIso(),
        );

        for (const instId of installationIds) {
          deps.installationRepo.setInstallationStatus(conn, instId, "installed", deps.nowIso());
        }
      });

      // 10. Publish event if handler provided
      if (deps.publishEvent) {
        await deps.publishEvent("skill.installed", {
          skillId: resolved.skillId,
          version: resolved.version,
          installationIds,
        });
      }

      return {
        installationIds,
        resolvedVersion: resolved.version,
        verification,
        trust,
      };
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
