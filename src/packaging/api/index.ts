// ─── Agent Package and Publishing API Contract ───

import { resolveDependencies } from "../engine/dependency-resolver.js";
import type {
  PackageInstaller,
  RegistryManager,
} from "../engine/index.js";
import type {
  FridayDependencyConflict,
  FridayDependencyResolution,
  FridayPackageInstall,
  FridayPackageLifecycleEvent,
  FridayPackageRegistryEntry,
  FridayPackageRollback,
  FridayPackageVerificationResult,
} from "../model/friday-packaging.types.js";
import type {
  FridayCheckDependenciesRequest,
  FridayCheckDependenciesResponse,
  FridayDependencyConflictDto,
  FridayDependencyResolutionDto,
  FridayGetInstallResponse,
  FridayInstallPackageRequest,
  FridayInstallPackageResponse,
  FridayListInstallsQuery,
  FridayListInstallsResponse,
  FridayListLifecycleEventsQuery,
  FridayListLifecycleEventsResponse,
  FridayPackageDto,
  FridayPackageInstallDto,
  FridayPackageLifecycleEventDto,
  FridayPackageRollbackDto,
  FridayPackageVerificationDto,
  FridayRollbackPackageRequest,
  FridayRollbackPackageResponse,
  FridayUninstallPackageRequest,
  FridayUninstallPackageResponse,
  FridayUpgradePackageRequest,
  FridayUpgradePackageResponse,
} from "./friday-packaging-api.types.js";

export {
  FRIDAY_PACKAGING_ERROR_CODES,
  FRIDAY_PACKAGING_IDEMPOTENCY_TTL_HOURS,
} from "./friday-packaging-api.types.js";

export type {
  // Error codes
  FridayPackagingErrorCode,

  // Pagination
  FridayPackagingPaginationQuery,
  FridayPackagingPage,

  // Idempotency
  FridayPackagingIdempotencyContract,

  // API-local nested DTO shapes
  FridayPackageAuthorDto,
  FridayPackageAssetsDto,
  FridayPackageHooksDto,
  FridayPackageMetadataDto,
  FridayPackageSignatureDto,

  // DTO types
  FridayPackageDto,
  FridayPackageVersionDto,
  FridayPackageInstallDto,
  FridayPackageRollbackDto,
  FridayPackageVerificationDto,
  FridayDependencyResolutionDto,
  FridayDependencyConflictDto,
  FridayConflictingRangeDto,
  FridayVersionIncompatibleConflictDto,
  FridayNotFoundConflictDto,
  FridayCircularConflictDto,
  FridayPeerUnsatisfiedConflictDto,
  FridayPlatformIncompatibleConflictDto,
  FridayPackageLifecycleEventDto,
  FridayPackageTrustedKeyDto,

  // Publish
  FridayPublishPackageRequest,
  FridayPublishPackageResponse,

  // List packages
  FridayListPackagesQuery,
  FridayPackageSummaryDto,
  FridayListPackagesResponse,

  // Get package
  FridayGetPackageResponse,

  // List package versions
  FridayListPackageVersionsQuery,
  FridayListPackageVersionsResponse,

  // Install
  FridayInstallPackageRequest,
  FridayInstallPackageResponse,

  // Upgrade
  FridayUpgradePackageRequest,
  FridayUpgradePackageResponse,

  // Rollback
  FridayRollbackPackageRequest,
  FridayRollbackPackageResponse,

  // Uninstall
  FridayUninstallPackageRequest,
  FridayUninstallPackageResponse,

  // Verify signature
  FridayVerifyPackageRequest,
  FridayVerifyPackageResponse,

  // Check dependencies
  FridayCheckDependenciesRequest,
  FridayCheckDependenciesResponse,

  // List installs
  FridayListInstallsQuery,
  FridayListInstallsResponse,

  // Get install
  FridayGetInstallResponse,

  // Lifecycle events
  FridayListLifecycleEventsQuery,
  FridayListLifecycleEventsResponse,

  // Trusted key management
  FridayListTrustedKeysRequest,
  FridayListTrustedKeysResponse,
  FridayAddTrustedKeyRequest,
  FridayAddTrustedKeyResponse,
  FridayRevokeTrustedKeyRequest,
  FridayRevokeTrustedKeyResponse,
  FridayRotateTrustedKeyRequest,
  FridayRotateTrustedKeyResponse,
} from "./friday-packaging-api.types.js";

/** Error thrown by API handlers. */
export class FridayPackagingApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number = 400) {
    super(message);
    this.name = "FridayPackagingApiError";
    this.code = code;
    this.status = status;
  }
}

/** Dependencies required to build packaging API handlers. */
export interface FridayPackagingApiDeps {
  readonly registry: RegistryManager;
  readonly installer: PackageInstaller;
  readonly principalId: string;
  readonly platformVersion: string;
}

/** Concrete packaging API handler surface. */
export interface FridayPackagingApiHandlers {
  installPackage(packageName: string, request: FridayInstallPackageRequest): FridayInstallPackageResponse;
  upgradePackage(packageName: string, request: FridayUpgradePackageRequest): FridayUpgradePackageResponse;
  rollbackPackage(packageName: string, request: FridayRollbackPackageRequest): FridayRollbackPackageResponse;
  uninstallPackage(packageName: string, request: FridayUninstallPackageRequest): FridayUninstallPackageResponse;
  checkDependencies(packageName: string, request: FridayCheckDependenciesRequest): FridayCheckDependenciesResponse;
  listInstalls(query: FridayListInstallsQuery): FridayListInstallsResponse;
  getInstall(installId: string): FridayGetInstallResponse;
  listLifecycleEvents(query: FridayListLifecycleEventsQuery): FridayListLifecycleEventsResponse;
}

type PaginationInput = {
  readonly cursor?: string;
  readonly limit?: number;
};

function paginate<T extends { readonly id: string }>(
  items: readonly T[],
  input: PaginationInput,
): { items: T[]; nextCursor?: string } {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  let startIndex = 0;
  if (input.cursor) {
    const idx = items.findIndex((item) => item.id === input.cursor);
    if (idx >= 0) startIndex = idx + 1;
  }
  const paged = items.slice(startIndex, startIndex + limit);
  const nextCursor = startIndex + limit < items.length ? paged[paged.length - 1]?.id : undefined;
  return { items: paged, nextCursor };
}

function mapInstallDto(install: FridayPackageInstall): FridayPackageInstallDto {
  return {
    id: install.id,
    packageId: install.packageId,
    packageName: install.packageName,
    packageVersion: install.packageVersion,
    tenantId: install.tenantId,
    state: install.state,
    ...(install.installDir ? { installDir: install.installDir } : {}),
    ...(install.errorMessage ? { errorMessage: install.errorMessage } : {}),
    ...(install.errorCode ? { errorCode: install.errorCode } : {}),
    ...(install.previousVersion ? { previousVersion: install.previousVersion } : {}),
    etag: install.etag,
    version: install.version,
    installedBy: install.installedBy,
    createdAt: install.createdAt,
    updatedAt: install.updatedAt,
  };
}

function mapRollbackDto(rollback: FridayPackageRollback): FridayPackageRollbackDto {
  return {
    id: rollback.id,
    installId: rollback.installId,
    packageName: rollback.packageName,
    fromVersion: rollback.fromVersion,
    toVersion: rollback.toVersion,
    reason: rollback.reason,
    initiatedBy: rollback.initiatedBy,
    state: rollback.state,
    ...(rollback.errorMessage ? { errorMessage: rollback.errorMessage } : {}),
    startedAt: rollback.startedAt,
    ...(rollback.completedAt ? { completedAt: rollback.completedAt } : {}),
  };
}

function mapVerificationDto(verification: FridayPackageVerificationResult): FridayPackageVerificationDto {
  return {
    valid: verification.valid,
    outcome: verification.outcome,
    message: verification.message,
    ...(verification.keyId ? { keyId: verification.keyId } : {}),
    verifiedAt: verification.verifiedAt,
    durationMs: verification.durationMs,
  };
}

function mapDependencyDto(resolution: FridayDependencyResolution): FridayDependencyResolutionDto {
  return {
    name: resolution.name,
    requestedRange: resolution.requestedRange,
    resolvedVersion: resolution.resolvedVersion,
    registryEntryId: resolution.registryEntryId,
    direct: resolution.direct,
    requestedBy: resolution.requestedBy,
  };
}

function mapConflictDto(conflict: FridayDependencyConflict): FridayDependencyConflictDto {
  switch (conflict.type) {
    case "version_incompatible":
      return {
        type: "version_incompatible",
        dependencyName: conflict.dependencyName,
        message: conflict.message,
        conflictingRanges: conflict.conflictingRanges.map((range) => ({
          requestedBy: range.requestedBy,
          range: range.range,
        })),
      };
    case "not_found":
      return {
        type: "not_found",
        dependencyName: conflict.dependencyName,
        message: conflict.message,
      };
    case "circular":
      return {
        type: "circular",
        dependencyName: conflict.dependencyName,
        message: conflict.message,
        cyclePath: conflict.cyclePath,
      };
    case "peer_unsatisfied":
      return {
        type: "peer_unsatisfied",
        dependencyName: conflict.dependencyName,
        message: conflict.message,
        requiredRange: conflict.requiredRange,
        ...(conflict.availableVersion ? { availableVersion: conflict.availableVersion } : {}),
      };
    case "platform_incompatible":
      return {
        type: "platform_incompatible",
        dependencyName: conflict.dependencyName,
        message: conflict.message,
        requiredRange: conflict.requiredRange,
        currentVersion: conflict.currentVersion,
      };
  }
}

function mapPackageDto(entry: FridayPackageRegistryEntry): FridayPackageDto {
  return {
    id: entry.id,
    name: entry.name,
    version: entry.version,
    ...(entry.description ? { description: entry.description } : {}),
    author: entry.author,
    ...(entry.license ? { license: entry.license } : {}),
    capabilities: entry.capabilities,
    dependencies: entry.dependencies,
    peerDependencies: entry.peerDependencies,
    fridayVersionRange: entry.fridayVersionRange,
    assets: entry.assets,
    hooks: entry.hooks,
    metadata: entry.metadata,
    sizeBytes: entry.sizeBytes,
    archiveDigest: entry.archiveDigest,
    manifestDigest: entry.manifestDigest,
    publishedBy: entry.publishedBy,
    ...(entry.tenantId ? { tenantId: entry.tenantId } : {}),
    etag: entry.etag,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function mapLifecycleEventDto(event: FridayPackageLifecycleEvent): FridayPackageLifecycleEventDto {
  return {
    id: event.id,
    packageName: event.packageName,
    ...(event.packageVersion ? { packageVersion: event.packageVersion } : {}),
    operation: event.operation,
    ...(event.stateFrom ? { stateFrom: event.stateFrom } : {}),
    stateTo: event.stateTo,
    ...(event.principalId ? { principalId: event.principalId } : {}),
    ...(event.tenantId ? { tenantId: event.tenantId } : {}),
    createdAt: event.createdAt,
  };
}

/** Build concrete packaging handlers wired to the engine runtime. */
export function createFridayPackagingApiHandlers(deps: FridayPackagingApiDeps): FridayPackagingApiHandlers {
  const { registry, installer, principalId, platformVersion } = deps;

  function ensureInstallSuccess(
    result: {
      readonly success: boolean;
      readonly error?: string;
      readonly errorCode?: string;
    },
    fallbackCode: string,
  ): void {
    if (result.success) return;
    throw new FridayPackagingApiError(
      result.errorCode ?? fallbackCode,
      result.error ?? "Packaging operation failed",
    );
  }

  return {
    installPackage(packageName: string, request: FridayInstallPackageRequest): FridayInstallPackageResponse {
      const installResult = installer.install({
        packageName,
        version: request.version,
        tenantId: request.tenantId,
        installedBy: principalId,
        idempotencyKey: request.idempotencyKey,
        platformVersion,
      });

      ensureInstallSuccess(installResult, "PACKAGING_NOT_INSTALLABLE");
      if (!installResult.install || !installResult.dependencies || !installResult.verification) {
        throw new FridayPackagingApiError("PACKAGING_VALIDATION_FAILED", "Install response was incomplete");
      }

      return {
        install: mapInstallDto(installResult.install),
        dependencies: installResult.dependencies.resolved.map((dep) => mapDependencyDto(dep)),
        verification: mapVerificationDto(installResult.verification),
      };
    },

    upgradePackage(packageName: string, request: FridayUpgradePackageRequest): FridayUpgradePackageResponse {
      const upgradeResult = installer.upgrade({
        packageName,
        targetVersion: request.targetVersion,
        tenantId: request.tenantId,
        etag: request.etag,
        upgradedBy: principalId,
        idempotencyKey: request.idempotencyKey,
        platformVersion,
        reason: "API upgrade request",
      });

      ensureInstallSuccess(upgradeResult, "PACKAGING_NOT_INSTALLABLE");
      if (!upgradeResult.install || !upgradeResult.dependencies || !upgradeResult.verification || !upgradeResult.previousVersion) {
        throw new FridayPackagingApiError("PACKAGING_VALIDATION_FAILED", "Upgrade response was incomplete");
      }

      return {
        install: mapInstallDto(upgradeResult.install),
        previousVersion: upgradeResult.previousVersion,
        dependencies: upgradeResult.dependencies.resolved.map((dep) => mapDependencyDto(dep)),
        verification: mapVerificationDto(upgradeResult.verification),
      };
    },

    rollbackPackage(packageName: string, request: FridayRollbackPackageRequest): FridayRollbackPackageResponse {
      const rollbackResult = installer.rollback({
        packageName,
        targetVersion: request.targetVersion,
        tenantId: request.tenantId,
        etag: request.etag,
        reason: request.reason,
        initiatedBy: principalId,
        platformVersion,
      });

      ensureInstallSuccess(rollbackResult, "PACKAGING_NOT_ROLLBACKABLE");
      if (!rollbackResult.install || !rollbackResult.rollback) {
        throw new FridayPackagingApiError("PACKAGING_VALIDATION_FAILED", "Rollback response was incomplete");
      }

      return {
        rollback: mapRollbackDto(rollbackResult.rollback),
        install: mapInstallDto(rollbackResult.install),
      };
    },

    uninstallPackage(packageName: string, request: FridayUninstallPackageRequest): FridayUninstallPackageResponse {
      const uninstallResult = installer.uninstall({
        packageName,
        tenantId: request.tenantId,
        etag: request.etag,
        reason: "API uninstall request",
        uninstalledBy: principalId,
      });

      ensureInstallSuccess(uninstallResult, "PACKAGING_NOT_UNINSTALLABLE");
      if (!uninstallResult.install) {
        throw new FridayPackagingApiError("PACKAGING_VALIDATION_FAILED", "Uninstall response was incomplete");
      }

      return { install: mapInstallDto(uninstallResult.install) };
    },

    checkDependencies(packageName: string, request: FridayCheckDependenciesRequest): FridayCheckDependenciesResponse {
      const entry = request.version
        ? registry.getByNameVersion(packageName, request.version, request.tenantId)
        : registry.getLatest(packageName, request.tenantId);

      if (!entry) {
        throw new FridayPackagingApiError("PACKAGING_PACKAGE_NOT_FOUND", `Package \"${packageName}\" not found`, 404);
      }

      const resolution = resolveDependencies(packageName, entry.version, {
        registry,
        platformVersion,
        tenantId: request.tenantId,
      });

      return {
        success: resolution.success,
        resolved: resolution.resolved.map((dep) => mapDependencyDto(dep)),
        conflicts: resolution.conflicts.map((conflict) => mapConflictDto(conflict)),
      };
    },

    listInstalls(query: FridayListInstallsQuery): FridayListInstallsResponse {
      if (!query.tenantId) {
        throw new FridayPackagingApiError("PACKAGING_VALIDATION_FAILED", "tenantId is required");
      }

      let installs = installer.listInstalls(query.tenantId).map((install) => mapInstallDto(install));

      if (query.packageName) {
        installs = installs.filter((install) => install.packageName === query.packageName);
      }
      if (query.state) {
        installs = installs.filter((install) => install.state === query.state);
      }

      const sortBy = query.sortBy ?? "createdAt";
      const sortDir = query.sortDir ?? "asc";
      const sortMul = sortDir === "asc" ? 1 : -1;

      installs.sort((a, b) => {
        switch (sortBy) {
          case "packageName":
            return sortMul * a.packageName.localeCompare(b.packageName);
          case "updatedAt":
            return sortMul * a.updatedAt.localeCompare(b.updatedAt);
          case "state":
            return sortMul * a.state.localeCompare(b.state);
          case "createdAt":
          default:
            return sortMul * a.createdAt.localeCompare(b.createdAt);
        }
      });

      return paginate(installs, query);
    },

    getInstall(installId: string): FridayGetInstallResponse {
      const install = installer.getInstall(installId);
      if (!install) {
        throw new FridayPackagingApiError("PACKAGING_INSTALL_NOT_FOUND", `Install \"${installId}\" not found`, 404);
      }

      const entry = registry.getById(install.packageId);
      if (!entry) {
        throw new FridayPackagingApiError(
          "PACKAGING_PACKAGE_NOT_FOUND",
          `Package \"${install.packageName}@${install.packageVersion}\" not found`,
          404,
        );
      }

      return {
        install: mapInstallDto(install),
        package: mapPackageDto(entry),
        rollbacks: installer.listRollbacks(install.id).map((rollback) => mapRollbackDto(rollback)),
      };
    },

    listLifecycleEvents(query: FridayListLifecycleEventsQuery): FridayListLifecycleEventsResponse {
      const events = installer.listLifecycleEvents({
        packageName: query.packageName,
        operation: query.operation,
        tenantId: query.tenantId,
        after: query.after,
        before: query.before,
      }).map((event) => mapLifecycleEventDto(event));

      return paginate(events, query);
    },
  };
}

/** CLI command variants wired to the same engine-backed handlers. */
export type FridayPackagingCliCommand =
  | {
      readonly command: "install";
      readonly packageName: string;
      readonly request: FridayInstallPackageRequest;
    }
  | {
      readonly command: "upgrade";
      readonly packageName: string;
      readonly request: FridayUpgradePackageRequest;
    }
  | {
      readonly command: "rollback";
      readonly packageName: string;
      readonly request: FridayRollbackPackageRequest;
    }
  | {
      readonly command: "uninstall";
      readonly packageName: string;
      readonly request: FridayUninstallPackageRequest;
    }
  | {
      readonly command: "check-dependencies";
      readonly packageName: string;
      readonly request: FridayCheckDependenciesRequest;
    };

export type FridayPackagingCliResult =
  | FridayInstallPackageResponse
  | FridayUpgradePackageResponse
  | FridayRollbackPackageResponse
  | FridayUninstallPackageResponse
  | FridayCheckDependenciesResponse;

/** Run a packaging CLI command via engine-backed handlers. */
export function runFridayPackagingCliCommand(
  handlers: FridayPackagingApiHandlers,
  command: FridayPackagingCliCommand,
): FridayPackagingCliResult {
  switch (command.command) {
    case "install":
      return handlers.installPackage(command.packageName, command.request);
    case "upgrade":
      return handlers.upgradePackage(command.packageName, command.request);
    case "rollback":
      return handlers.rollbackPackage(command.packageName, command.request);
    case "uninstall":
      return handlers.uninstallPackage(command.packageName, command.request);
    case "check-dependencies":
      return handlers.checkDependencies(command.packageName, command.request);
  }
}
