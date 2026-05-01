import semver from "semver";
import type { FridaySqliteLayer } from "#state";
import type { FridaySkillVersionRepository } from "../persistence/friday-skill-version-repository.js";
import type { FridaySkillInstallationRepository } from "../persistence/friday-skill-installation-repository.js";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type {
  FridaySkillSignature,
  FridaySkillVersionEntity,
  FridaySkillVersionResolutionInput,
  FridaySkillVersionResolutionResult,
} from "../model/friday-skill-catalog.types.js";
import { FridayDomainError } from "#errors";

// ─── Interface ───

export interface FridaySkillVersionResolutionService {
  resolve(input: FridaySkillVersionResolutionInput): FridaySkillVersionResolutionResult;
}

// ─── Dependencies ───

export interface CreateVersionResolutionServiceDeps {
  db: FridaySqliteLayer;
  versionRepo: FridaySkillVersionRepository;
  installationRepo: FridaySkillInstallationRepository;
}

// ─── Factory ───

export function createFridaySkillVersionResolutionService(
  deps: CreateVersionResolutionServiceDeps,
): FridaySkillVersionResolutionService {
  function resolveFromVersions(
    versions: FridaySkillVersionEntity[],
    requestedVersion: string | undefined,
    allowYanked: boolean,
  ): FridaySkillVersionEntity | null {
    const candidates = allowYanked ? versions : versions.filter((v) => !v.yankedAt);
    if (candidates.length === 0) return null;

    if (requestedVersion) {
      // Exact match first
      const exact = candidates.find((v) => v.version === requestedVersion);
      if (exact) return exact;

      // Semver range match
      const matched = candidates
        .filter((v) => semver.valid(v.version) && semver.satisfies(v.version, requestedVersion))
        .sort((a, b) => semver.rcompare(a.version, b.version));
      return matched[0] ?? null;
    }

    // No version requested: pick latest by semver, fall back to release date
    const sorted = [...candidates].sort((a, b) => {
      if (semver.valid(a.version) && semver.valid(b.version)) {
        return semver.rcompare(a.version, b.version);
      }
      return b.releasedAt.localeCompare(a.releasedAt);
    });
    return sorted[0] ?? null;
  }

  return {
    resolve(input) {
      return deps.db.withReadConnection((conn) => {
        const versions = deps.versionRepo.listVersionsForResolution(
          conn,
          input.skillId,
          input.allowYanked,
        );

        switch (input.strategy) {
          case "install":
          case "upgrade": {
            const resolved = resolveFromVersions(
              versions,
              input.requestedVersion,
              input.allowYanked ?? false,
            );

            if (!resolved) {
              throw new FridayDomainError(
                "VERSION_NOT_FOUND",
                `No matching version found for ${input.skillId}${input.requestedVersion ? `@${input.requestedVersion}` : ""}`,
                { httpStatus: 404 },
              );
            }

            let sourceId = input.sourceId ?? "";

            return {
              skillId: input.skillId,
              version: resolved.version,
              sourceId,
              manifest: resolved.manifest,
              checksum: resolved.checksum,
              packageUrl: resolved.packageUrl ?? "",
              signature: resolved.signature,
              reason: input.strategy === "upgrade"
                ? `Upgrade to ${resolved.version}`
                : `Install version ${resolved.version}`,
            };
          }

          case "rollback": {
            // Find previous successfully installed version
            const history = deps.installationRepo.listInstalledHistory(
              conn,
              input.skillId,
              10,
            );

            // Skip the current (first) entry, take the next one
            const previousInstall = history.length > 1 ? history[1] : null;
            if (!previousInstall) {
              throw new FridayDomainError("VERSION_ROLLBACK_NOT_FOUND", `No previous installed version found for rollback of ${input.skillId}`, { httpStatus: 404 });
            }

            const targetVersion = versions.find(
              (v) => v.version === previousInstall.version,
            );
            if (!targetVersion) {
              throw new FridayDomainError(
                "VERSION_METADATA_NOT_FOUND",
                `Previous version ${previousInstall.version} metadata not found for ${input.skillId}`,
                { httpStatus: 404 },
              );
            }

            return {
              skillId: input.skillId,
              version: targetVersion.version,
              sourceId: input.sourceId ?? "",
              manifest: targetVersion.manifest,
              checksum: targetVersion.checksum,
              packageUrl: targetVersion.packageUrl ?? "",
              signature: targetVersion.signature,
              reason: `Rollback to ${targetVersion.version}`,
            };
          }

          default:
            throw new FridayDomainError("VERSION_RESOLUTION_VALIDATION_ERROR", `Unknown resolution strategy: ${input.strategy}`, { httpStatus: 400 });
        }
      });
    },
  };
}
