/**
 * Agent Package and Publishing — API and SDK Contract.
 *
 * Request/response DTOs for the package management REST API.
 * All types follow Friday API conventions: `FridayPage<T>` for pagination,
 * `FridayApiSuccessResponse<T>` / `FridayApiErrorResponse` for responses.
 *
 * @module packaging/api
 */

import type { FridayPage, FridayPaginationQuery } from "../../api/model/friday-api-common.types.js";

// ═══════════════════════════════════════════════════════════════════════
// API-LOCAL SCALAR TYPES (no domain model imports)
// ═══════════════════════════════════════════════════════════════════════

/** UUID string identifier (API-local). */
type UUID = string;

/** ISO 8601 date-time string (API-local). */
type ISODateTime = string;

// ═══════════════════════════════════════════════════════════════════════
// API-LOCAL NESTED DTO SHAPES
// ═══════════════════════════════════════════════════════════════════════

/** Author information DTO. */
export interface FridayPackageAuthorDto {
  readonly name: string;
  readonly email?: string;
  readonly url?: string;
}

/** Asset glob patterns DTO. */
export interface FridayPackageAssetsDto {
  readonly skills?: readonly string[];
  readonly rules?: readonly string[];
  readonly playbooks?: readonly string[];
  readonly providers?: readonly string[];
}

/** Lifecycle hooks DTO. */
export interface FridayPackageHooksDto {
  readonly preInstall?: string | null;
  readonly postInstall?: string | null;
  readonly preUninstall?: string | null;
  readonly postUninstall?: string | null;
}

/** Package metadata DTO. */
export interface FridayPackageMetadataDto {
  readonly repository?: string;
  readonly keywords?: readonly string[];
  readonly tenantScopes?: readonly string[];
}

/** Package signature DTO. */
export interface FridayPackageSignatureDto {
  readonly algorithm: "Ed25519";
  readonly publicKey: string;
  readonly signature: string;
  readonly digest: string;
  readonly manifestDigest: string;
  readonly timestamp: ISODateTime;
  readonly expiresAt: ISODateTime;
  readonly keyId: string;
  readonly certificateChain?: readonly string[];
}

/** Signature algorithm (API-local). */
type FridayPackageSignatureAlgorithm = "Ed25519";

/** Install state (API-local). */
type FridayPackageInstallState =
  | "downloading"
  | "verifying"
  | "extracting"
  | "activating"
  | "active"
  | "verification_failed"
  | "rolling_back"
  | "rolled_back"
  | "uninstalling"
  | "uninstalled"
  | "failed";

/** Rollback state (API-local). */
type FridayPackageRollbackState = "initiated" | "completed" | "failed";

/** Verification outcome (API-local). */
type FridayPackageVerificationOutcome =
  | "valid"
  | "untrusted_key"
  | "expired_signature"
  | "digest_mismatch"
  | "signature_invalid"
  | "manifest_tampered"
  | "key_revoked";

/** Lifecycle operation (API-local). */
type FridayPackageLifecycleOperation =
  | "publish"
  | "install"
  | "upgrade"
  | "rollback"
  | "uninstall"
  | "verify"
  | "key_trust"
  | "key_revoke";

/** Dependency conflict type (API-local). */
type FridayDependencyConflictType =
  | "version_incompatible"
  | "not_found"
  | "circular"
  | "peer_unsatisfied"
  | "platform_incompatible";

// ═══════════════════════════════════════════════════════════════════════
// ERROR CODES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Standardised error codes for the packaging domain.
 *
 * @example
 * ```ts
 * if (error.code === FRIDAY_PACKAGING_ERROR_CODES.PACKAGE_NOT_FOUND) { ... }
 * ```
 */
export const FRIDAY_PACKAGING_ERROR_CODES = {
  /** The requested package does not exist or has been deleted. */
  PACKAGE_NOT_FOUND: "PACKAGING_PACKAGE_NOT_FOUND",
  /** The requested package version does not exist. */
  VERSION_NOT_FOUND: "PACKAGING_VERSION_NOT_FOUND",
  /** A package with this name and version already exists with a different digest. */
  VERSION_ALREADY_EXISTS: "PACKAGING_VERSION_ALREADY_EXISTS",
  /** The install record was not found. */
  INSTALL_NOT_FOUND: "PACKAGING_INSTALL_NOT_FOUND",
  /** The package is not in an installable state. */
  NOT_INSTALLABLE: "PACKAGING_NOT_INSTALLABLE",
  /** The package is not in a rollback-eligible state. */
  NOT_ROLLBACKABLE: "PACKAGING_NOT_ROLLBACKABLE",
  /** The package is not in an uninstallable state. */
  NOT_UNINSTALLABLE: "PACKAGING_NOT_UNINSTALLABLE",
  /** Signature verification failed. */
  VERIFICATION_FAILED: "PACKAGING_VERIFICATION_FAILED",
  /** The signing key is not trusted. */
  UNTRUSTED_KEY: "PACKAGING_UNTRUSTED_KEY",
  /** The package signature has expired. */
  SIGNATURE_EXPIRED: "PACKAGING_SIGNATURE_EXPIRED",
  /** The signing key has been revoked. */
  KEY_REVOKED: "PACKAGING_KEY_REVOKED",
  /** Dependency resolution failed. */
  DEPENDENCY_CONFLICT: "PACKAGING_DEPENDENCY_CONFLICT",
  /** A circular dependency was detected. */
  CIRCULAR_DEPENDENCY: "PACKAGING_CIRCULAR_DEPENDENCY",
  /** A required dependency was not found in the registry. */
  DEPENDENCY_NOT_FOUND: "PACKAGING_DEPENDENCY_NOT_FOUND",
  /** The package exceeds the maximum allowed size. */
  PACKAGE_TOO_LARGE: "PACKAGING_PACKAGE_TOO_LARGE",
  /** Optimistic concurrency conflict — the etag does not match. */
  ETAG_MISMATCH: "PACKAGING_ETAG_MISMATCH",
  /** The package is incompatible with the current Friday platform version. */
  PLATFORM_INCOMPATIBLE: "PACKAGING_PLATFORM_INCOMPATIBLE",
  /** The maximum number of concurrent installs has been reached. */
  CONCURRENT_LIMIT: "PACKAGING_CONCURRENT_LIMIT",
  /** Validation failed on the request payload. */
  VALIDATION_FAILED: "PACKAGING_VALIDATION_FAILED",
  /** Idempotency key reused with a different payload inside retention window. */
  IDEMPOTENCY_KEY_CONFLICT: "PACKAGING_IDEMPOTENCY_KEY_CONFLICT",
  /** The requesting principal lacks the required scope for this operation. */
  INSUFFICIENT_SCOPE: "PACKAGING_INSUFFICIENT_SCOPE",
  /** The package is not visible to the requesting tenant. */
  TENANT_SCOPE_DENIED: "PACKAGING_TENANT_SCOPE_DENIED",
  /** The trusted key was not found. */
  KEY_NOT_FOUND: "PACKAGING_KEY_NOT_FOUND",
  /** The trusted key has already been revoked. */
  KEY_ALREADY_REVOKED: "PACKAGING_KEY_ALREADY_REVOKED",
  /** A trusted key with this keyId already exists. */
  KEY_ALREADY_EXISTS: "PACKAGING_KEY_ALREADY_EXISTS",
  /** Key rotation failed (e.g., old key not found or already revoked). */
  KEY_ROTATION_FAILED: "PACKAGING_KEY_ROTATION_FAILED",
} as const;

/** Union type of all packaging error codes. */
export type FridayPackagingErrorCode =
  (typeof FRIDAY_PACKAGING_ERROR_CODES)[keyof typeof FRIDAY_PACKAGING_ERROR_CODES];

// ═══════════════════════════════════════════════════════════════════════
// PAGINATION (reuses shared types from api/model)
// ═══════════════════════════════════════════════════════════════════════

/** Pagination query for packaging endpoints. */
export type FridayPackagingPaginationQuery = FridayPaginationQuery;

/** Paginated result for packaging endpoints. */
export type FridayPackagingPage<TItem> = FridayPage<TItem>;

// ═══════════════════════════════════════════════════════════════════════
// IDEMPOTENCY CONTRACT
// ═══════════════════════════════════════════════════════════════════════

/** Idempotency TTL in hours for packaging API write operations. */
export const FRIDAY_PACKAGING_IDEMPOTENCY_TTL_HOURS = 24 as const;

/** Idempotency contract specification for packaging API write operations. */
export interface FridayPackagingIdempotencyContract {
  /** Scope is (principalId, operationId, key). */
  readonly scope: "principal+operation+key";
  /** Keys expire after 24 hours. */
  readonly ttlHours: 24;
  /** Same payload hash returns the original response. */
  readonly replayBehavior: "same_payload_returns_original_response";
  /** Different payload hash returns 409. */
  readonly conflict: {
    readonly httpStatus: 409;
    readonly code: "PACKAGING_IDEMPOTENCY_KEY_CONFLICT";
  };
}

// ═══════════════════════════════════════════════════════════════════════
// DTO TYPES (API layer — no domain entity leakage)
// ═══════════════════════════════════════════════════════════════════════

/** API DTO for a published package. */
export interface FridayPackageDto {
  readonly id: UUID;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author: FridayPackageAuthorDto;
  readonly license?: string;
  readonly capabilities: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly fridayVersionRange: string;
  readonly assets: FridayPackageAssetsDto;
  readonly hooks: FridayPackageHooksDto;
  readonly metadata: FridayPackageMetadataDto;
  readonly sizeBytes: number;
  readonly archiveDigest: string;
  readonly manifestDigest: string;
  readonly publishedBy: string;
  readonly tenantId?: string;
  readonly etag: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** API DTO for a package version summary. */
export interface FridayPackageVersionDto {
  readonly id: UUID;
  readonly packageName: string;
  readonly version: string;
  readonly changelog?: string;
  readonly compatibilityRange: string;
  readonly archiveDigest: string;
  readonly sizeBytes: number;
  readonly publishedAt: ISODateTime;
  readonly publishedBy: string;
  readonly deprecated: boolean;
  readonly deprecationMessage?: string;
}

/** API DTO for a package install record. */
export interface FridayPackageInstallDto {
  readonly id: UUID;
  readonly packageId: UUID;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly tenantId: string;
  readonly state: FridayPackageInstallState;
  readonly installDir?: string;
  readonly errorMessage?: string;
  readonly errorCode?: string;
  readonly previousVersion?: string;
  readonly etag: string;
  /** Monotonically increasing version counter for optimistic concurrency. */
  readonly version: number;
  readonly installedBy: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** API DTO for a package rollback record. */
export interface FridayPackageRollbackDto {
  readonly id: UUID;
  readonly installId: UUID;
  readonly packageName: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly reason: string;
  readonly initiatedBy: string;
  readonly state: FridayPackageRollbackState;
  readonly errorMessage?: string;
  readonly startedAt: ISODateTime;
  readonly completedAt?: ISODateTime;
}

/** API DTO for a signature verification result. */
export interface FridayPackageVerificationDto {
  readonly valid: boolean;
  readonly outcome: FridayPackageVerificationOutcome;
  readonly message: string;
  readonly keyId?: string;
  readonly verifiedAt: ISODateTime;
  readonly durationMs: number;
}

/** API DTO for a dependency resolution entry. */
export interface FridayDependencyResolutionDto {
  readonly name: string;
  readonly requestedRange: string;
  readonly resolvedVersion: string;
  readonly registryEntryId: UUID;
  readonly direct: boolean;
  readonly requestedBy: string;
}

/** API DTO for a conflicting version range. */
export interface FridayConflictingRangeDto {
  readonly requestedBy: string;
  readonly range: string;
}

// ─── Discriminated union variants for dependency conflict DTOs ───

/** Version incompatibility conflict DTO. */
export interface FridayVersionIncompatibleConflictDto {
  readonly type: "version_incompatible";
  readonly dependencyName: string;
  readonly message: string;
  readonly conflictingRanges: readonly FridayConflictingRangeDto[];
}

/** Dependency not found conflict DTO. */
export interface FridayNotFoundConflictDto {
  readonly type: "not_found";
  readonly dependencyName: string;
  readonly message: string;
}

/** Circular dependency conflict DTO. */
export interface FridayCircularConflictDto {
  readonly type: "circular";
  readonly dependencyName: string;
  readonly message: string;
  readonly cyclePath: readonly string[];
}

/** Peer dependency unsatisfied conflict DTO. */
export interface FridayPeerUnsatisfiedConflictDto {
  readonly type: "peer_unsatisfied";
  readonly dependencyName: string;
  readonly message: string;
  readonly requiredRange: string;
  readonly availableVersion?: string;
}

/** Platform incompatibility conflict DTO. */
export interface FridayPlatformIncompatibleConflictDto {
  readonly type: "platform_incompatible";
  readonly dependencyName: string;
  readonly message: string;
  readonly requiredRange: string;
  readonly currentVersion: string;
}

/**
 * API DTO for a dependency conflict (discriminated union).
 */
export type FridayDependencyConflictDto =
  | FridayVersionIncompatibleConflictDto
  | FridayNotFoundConflictDto
  | FridayCircularConflictDto
  | FridayPeerUnsatisfiedConflictDto
  | FridayPlatformIncompatibleConflictDto;

/** API DTO for a lifecycle audit event. */
export interface FridayPackageLifecycleEventDto {
  readonly id: UUID;
  readonly packageName: string;
  readonly packageVersion?: string;
  readonly operation: FridayPackageLifecycleOperation;
  readonly stateFrom?: FridayPackageInstallState;
  readonly stateTo: FridayPackageInstallState;
  readonly principalId?: string;
  readonly tenantId?: string;
  readonly createdAt: ISODateTime;
}

/** API DTO for a trusted signing key. */
export interface FridayPackageTrustedKeyDto {
  readonly id: UUID;
  readonly keyId: string;
  readonly publicKey: string;
  readonly algorithm: FridayPackageSignatureAlgorithm;
  readonly owner: string;
  readonly tenantId?: string;
  readonly trustedAt: ISODateTime;
  readonly expiresAt?: ISODateTime;
  readonly revokedAt?: ISODateTime;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLISH PACKAGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/packages`.
 *
 * Publishes a new package version to the registry. The archive
 * is uploaded as a binary payload alongside this metadata.
 *
 * @openapi operationId: publishPackage
 */
export interface FridayPublishPackageRequest {
  /** Base64-encoded package archive. */
  readonly archive: string;
  /** Tenant ID to scope the package to (null for global). */
  readonly tenantId?: string;
  /**
   * Idempotency key to prevent duplicate publishes.
   * See {@link FridayPackagingIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/packages`.
 *
 * @openapi operationId: publishPackage
 */
export interface FridayPublishPackageResponse {
  /** The published package DTO. */
  readonly package: FridayPackageDto;
  /** Signature verification result from the publish pipeline. */
  readonly verification: FridayPackageVerificationDto;
}

// ═══════════════════════════════════════════════════════════════════════
// LIST PACKAGES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/packages`.
 *
 * @openapi operationId: listPackages
 */
export interface FridayListPackagesQuery extends FridayPackagingPaginationQuery {
  /** Filter by package name (prefix match). */
  readonly name?: string;
  /** Filter by capability (matches any package providing this capability). */
  readonly capability?: string;
  /** Filter by keyword from metadata. */
  readonly keyword?: string;
  /** Filter by author name (prefix match). */
  readonly author?: string;
  /** Sort field. */
  readonly sortBy?: "name" | "createdAt" | "updatedAt" | "sizeBytes";
  /** Sort direction. */
  readonly sortDir?: "asc" | "desc";
}

/**
 * Summary DTO for list views (omits full assets/hooks/signature).
 */
export interface FridayPackageSummaryDto {
  readonly id: UUID;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author: FridayPackageAuthorDto;
  readonly license?: string;
  readonly capabilities: readonly string[];
  readonly sizeBytes: number;
  readonly publishedBy: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/**
 * Response body for `GET /api/packages`.
 *
 * @openapi operationId: listPackages
 */
export interface FridayListPackagesResponse extends FridayPackagingPage<FridayPackageSummaryDto> {}

// ═══════════════════════════════════════════════════════════════════════
// GET PACKAGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Response body for `GET /api/packages/:packageId`.
 *
 * Full package detail including signature.
 *
 * @openapi operationId: getPackage
 */
export interface FridayGetPackageResponse {
  /** The full package DTO. */
  readonly package: FridayPackageDto;
  /** Signature details. */
  readonly signature: FridayPackageSignatureDto;
  /** Total number of published versions for this package name. */
  readonly versionCount: number;
}

// ═══════════════════════════════════════════════════════════════════════
// LIST PACKAGE VERSIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/packages/:packageName/versions`.
 *
 * @openapi operationId: listPackageVersions
 */
export interface FridayListPackageVersionsQuery extends FridayPackagingPaginationQuery {
  /** Include deprecated versions. @default false */
  readonly includeDeprecated?: boolean;
}

/**
 * Response body for `GET /api/packages/:packageName/versions`.
 *
 * @openapi operationId: listPackageVersions
 */
export interface FridayListPackageVersionsResponse extends FridayPackagingPage<FridayPackageVersionDto> {}

// ═══════════════════════════════════════════════════════════════════════
// INSTALL PACKAGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/packages/:packageName/install`.
 *
 * @openapi operationId: installPackage
 */
export interface FridayInstallPackageRequest {
  /** Version to install (exact semver). If omitted, installs the latest. */
  readonly version?: string;
  /** Tenant to install for. */
  readonly tenantId: string;
  /**
   * Idempotency key to prevent duplicate installs.
   * See {@link FridayPackagingIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/packages/:packageName/install`.
 *
 * @openapi operationId: installPackage
 */
export interface FridayInstallPackageResponse {
  /** The install record. */
  readonly install: FridayPackageInstallDto;
  /** Resolved dependencies. */
  readonly dependencies: readonly FridayDependencyResolutionDto[];
  /** Verification result. */
  readonly verification: FridayPackageVerificationDto;
}

// ═══════════════════════════════════════════════════════════════════════
// UPGRADE PACKAGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/packages/:packageName/upgrade`.
 *
 * @openapi operationId: upgradePackage
 */
export interface FridayUpgradePackageRequest {
  /** Target version to upgrade to (exact semver). If omitted, upgrades to the latest. */
  readonly targetVersion?: string;
  /** Tenant context. */
  readonly tenantId: string;
  /** Required optimistic concurrency token from the current install. */
  readonly etag: string;
  /**
   * Idempotency key to prevent duplicate upgrades.
   * See {@link FridayPackagingIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/packages/:packageName/upgrade`.
 *
 * @openapi operationId: upgradePackage
 */
export interface FridayUpgradePackageResponse {
  /** The updated install record. */
  readonly install: FridayPackageInstallDto;
  /** Version upgraded from. */
  readonly previousVersion: string;
  /** Resolved dependencies for the new version. */
  readonly dependencies: readonly FridayDependencyResolutionDto[];
  /** Verification result for the new version. */
  readonly verification: FridayPackageVerificationDto;
}

// ═══════════════════════════════════════════════════════════════════════
// ROLLBACK PACKAGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/packages/:packageName/rollback`.
 *
 * @openapi operationId: rollbackPackage
 */
export interface FridayRollbackPackageRequest {
  /** Target version to roll back to. */
  readonly targetVersion: string;
  /** Tenant context. */
  readonly tenantId: string;
  /** Required optimistic concurrency token from the current install. */
  readonly etag: string;
  /** Human-readable reason for the rollback. */
  readonly reason: string;
  /**
   * Idempotency key to prevent duplicate rollbacks.
   * See {@link FridayPackagingIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/packages/:packageName/rollback`.
 *
 * @openapi operationId: rollbackPackage
 */
export interface FridayRollbackPackageResponse {
  /** The rollback record. */
  readonly rollback: FridayPackageRollbackDto;
  /** The updated install record. */
  readonly install: FridayPackageInstallDto;
}

// ═══════════════════════════════════════════════════════════════════════
// UNINSTALL PACKAGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/packages/:packageName/uninstall`.
 *
 * @openapi operationId: uninstallPackage
 */
export interface FridayUninstallPackageRequest {
  /** Tenant context. */
  readonly tenantId: string;
  /** Required optimistic concurrency token from the current install. */
  readonly etag: string;
  /**
   * Idempotency key to prevent duplicate uninstalls.
   * See {@link FridayPackagingIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/packages/:packageName/uninstall`.
 *
 * @openapi operationId: uninstallPackage
 */
export interface FridayUninstallPackageResponse {
  /** The updated install record (state will be `uninstalled`). */
  readonly install: FridayPackageInstallDto;
}

// ═══════════════════════════════════════════════════════════════════════
// VERIFY PACKAGE SIGNATURE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/packages/:packageId/verify`.
 *
 * Re-verifies the signature of an already-published package.
 *
 * @openapi operationId: verifyPackageSignature
 */
export interface FridayVerifyPackageRequest {
  /**
   * Idempotency key.
   * See {@link FridayPackagingIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/packages/:packageId/verify`.
 *
 * @openapi operationId: verifyPackageSignature
 */
export interface FridayVerifyPackageResponse {
  /** The verification result. */
  readonly verification: FridayPackageVerificationDto;
  /** The package DTO. */
  readonly package: FridayPackageDto;
}

// ═══════════════════════════════════════════════════════════════════════
// CHECK DEPENDENCIES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/packages/:packageName/check-dependencies`.
 *
 * Performs a dry-run dependency resolution without installing.
 *
 * @openapi operationId: checkDependencies
 */
export interface FridayCheckDependenciesRequest {
  /** Version to check dependencies for (exact semver). If omitted, checks latest. */
  readonly version?: string;
  /** Tenant context for scoped package resolution. */
  readonly tenantId: string;
}

/**
 * Response body for `POST /api/packages/:packageName/check-dependencies`.
 *
 * @openapi operationId: checkDependencies
 */
export interface FridayCheckDependenciesResponse {
  /** Whether all dependencies can be resolved. */
  readonly success: boolean;
  /** Resolved dependencies. */
  readonly resolved: readonly FridayDependencyResolutionDto[];
  /** Conflicts preventing resolution (empty if success is true). */
  readonly conflicts: readonly FridayDependencyConflictDto[];
}

// ═══════════════════════════════════════════════════════════════════════
// LIST INSTALLS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/packages/installs`.
 *
 * @openapi operationId: listInstalls
 */
export interface FridayListInstallsQuery extends FridayPackagingPaginationQuery {
  /** Filter by tenant ID. */
  readonly tenantId?: string;
  /** Filter by package name. */
  readonly packageName?: string;
  /** Filter by install state. */
  readonly state?: FridayPackageInstallState;
  /** Sort field. */
  readonly sortBy?: "packageName" | "createdAt" | "updatedAt" | "state";
  /** Sort direction. */
  readonly sortDir?: "asc" | "desc";
}

/**
 * Response body for `GET /api/packages/installs`.
 *
 * @openapi operationId: listInstalls
 */
export interface FridayListInstallsResponse extends FridayPackagingPage<FridayPackageInstallDto> {}

// ═══════════════════════════════════════════════════════════════════════
// GET INSTALL
// ═══════════════════════════════════════════════════════════════════════

/**
 * Response body for `GET /api/packages/installs/:installId`.
 *
 * @openapi operationId: getInstall
 */
export interface FridayGetInstallResponse {
  /** The install record. */
  readonly install: FridayPackageInstallDto;
  /** The published package DTO. */
  readonly package: FridayPackageDto;
  /** Rollback history for this install. */
  readonly rollbacks: readonly FridayPackageRollbackDto[];
}

// ═══════════════════════════════════════════════════════════════════════
// LIST LIFECYCLE EVENTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/packages/lifecycle`.
 *
 * @openapi operationId: listLifecycleEvents
 */
export interface FridayListLifecycleEventsQuery extends FridayPackagingPaginationQuery {
  /** Filter by package name. */
  readonly packageName?: string;
  /** Filter by operation type. */
  readonly operation?: FridayPackageLifecycleOperation;
  /** Filter by tenant ID. */
  readonly tenantId?: string;
  /** Events after this timestamp (inclusive). */
  readonly after?: ISODateTime;
  /** Events before this timestamp (exclusive). */
  readonly before?: ISODateTime;
}

/**
 * Response body for `GET /api/packages/lifecycle`.
 *
 * @openapi operationId: listLifecycleEvents
 */
export interface FridayListLifecycleEventsResponse extends FridayPackagingPage<FridayPackageLifecycleEventDto> {}

// ═══════════════════════════════════════════════════════════════════════
// TRUSTED KEY MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/packages/keys`.
 *
 * @openapi operationId: listTrustedKeys
 */
export interface FridayListTrustedKeysRequest extends FridayPackagingPaginationQuery {
  /** Filter by tenant ID (omit for global keys). */
  readonly tenantId?: string;
  /** Include revoked keys. @default false */
  readonly includeRevoked?: boolean;
}

/**
 * Response body for `GET /api/packages/keys`.
 *
 * @openapi operationId: listTrustedKeys
 */
export interface FridayListTrustedKeysResponse extends FridayPackagingPage<FridayPackageTrustedKeyDto> {}

/**
 * Request body for `POST /api/packages/keys`.
 *
 * Registers a new trusted signing key.
 *
 * @openapi operationId: addTrustedKey
 */
export interface FridayAddTrustedKeyRequest {
  /** Unique key identifier (must not collide with existing keys). */
  readonly keyId: string;
  /** Base64-encoded Ed25519 public key. */
  readonly publicKey: string;
  /** Signature algorithm. */
  readonly algorithm: FridayPackageSignatureAlgorithm;
  /** Human-readable owner name. */
  readonly owner: string;
  /** Tenant ID (omit for globally trusted keys). */
  readonly tenantId?: string;
  /** When this key expires (null for no expiry). */
  readonly expiresAt?: ISODateTime;
  /**
   * Idempotency key to prevent duplicate adds.
   * See {@link FridayPackagingIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/packages/keys`.
 *
 * @openapi operationId: addTrustedKey
 */
export interface FridayAddTrustedKeyResponse {
  /** The registered trusted key. */
  readonly key: FridayPackageTrustedKeyDto;
}

/**
 * Request body for `POST /api/packages/keys/:keyId/revoke`.
 *
 * Revokes a trusted signing key. All packages signed with this key
 * will have their active installs transitioned to `verification_failed`.
 *
 * @openapi operationId: revokeTrustedKey
 */
export interface FridayRevokeTrustedKeyRequest {
  /** Reason for revocation. */
  readonly reason: string;
  /** Client-generated idempotency key (UUID recommended). */
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/packages/keys/:keyId/revoke`.
 *
 * @openapi operationId: revokeTrustedKey
 */
export interface FridayRevokeTrustedKeyResponse {
  /** The updated trusted key (with revokedAt set). */
  readonly key: FridayPackageTrustedKeyDto;
  /** Number of active installs affected by this revocation. */
  readonly affectedInstalls: number;
}

/**
 * Request body for `POST /api/packages/keys/:keyId/rotate`.
 *
 * Rotates a trusted signing key. The old key remains trusted for
 * the configured grace period (default: 90 days) before automatic
 * revocation.
 *
 * @openapi operationId: rotateTrustedKey
 */
export interface FridayRotateTrustedKeyRequest {
  /** New key identifier. */
  readonly newKeyId: string;
  /** Base64-encoded new Ed25519 public key. */
  readonly newPublicKey: string;
  /** Human-readable owner name for the new key. */
  readonly owner: string;
  /** When the new key expires (null for no expiry). */
  readonly expiresAt?: ISODateTime;
  /**
   * Idempotency key to prevent duplicate rotations.
   * See {@link FridayPackagingIdempotencyContract}.
   */
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/packages/keys/:keyId/rotate`.
 *
 * @openapi operationId: rotateTrustedKey
 */
export interface FridayRotateTrustedKeyResponse {
  /** The new trusted key. */
  readonly newKey: FridayPackageTrustedKeyDto;
  /** The old key (still trusted during grace period). */
  readonly oldKey: FridayPackageTrustedKeyDto;
  /** When the old key will be automatically revoked (end of grace period). */
  readonly gracePeriodEndsAt: ISODateTime;
}
