/**
 * Agent Package and Publishing — Domain Model and Data Contract.
 *
 * Canonical types for the Friday Agent Packaging system: package manifests,
 * signatures, versioning, install state machine, registry entries,
 * dependency resolution, rollback records, and persistence schema types.
 *
 * @module packaging/model
 */

// ─── Foundational Value Types (local; mirrors rules/workflow/observability pattern) ───

/** UUID string identifier. */
export type UUID = string;

/** ISO 8601 date-time string. */
export type ISODateTime = string;

/** JSON-safe primitive value. */
export type JsonPrimitive = string | number | boolean | null;

/** Recursive JSON-safe value. */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/** JSON-safe object. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

// ═══════════════════════════════════════════════════════════════════════
// PACKAGE MANIFEST
// ═══════════════════════════════════════════════════════════════════════

/**
 * Author information for a package.
 */
export interface FridayPackageAuthor {
  /** Author display name. */
  readonly name: string;
  /** Author email address. */
  readonly email?: string;
  /** Author URL (homepage, profile). */
  readonly url?: string;
}

/**
 * Asset glob patterns grouped by category.
 */
export interface FridayPackageAssets {
  /** Skill definition file globs. */
  readonly skills?: readonly string[];
  /** Rule policy bundle file globs. */
  readonly rules?: readonly string[];
  /** Playbook template file globs. */
  readonly playbooks?: readonly string[];
  /** Provider configuration file globs. */
  readonly providers?: readonly string[];
}

/**
 * Lifecycle hook declarations.
 *
 * Each hook is either a path to a SQL migration script or null (no-op).
 */
export interface FridayPackageHooks {
  /** Script to run before package installation. */
  readonly preInstall?: string | null;
  /** Script to run after package installation. */
  readonly postInstall?: string | null;
  /** Script to run before package uninstallation. */
  readonly preUninstall?: string | null;
  /** Script to run after package uninstallation. */
  readonly postUninstall?: string | null;
}

/**
 * Additional package metadata for discovery and tenant scoping.
 */
export interface FridayPackageMetadata {
  /** Source repository URL. */
  readonly repository?: string;
  /** Searchable keywords. */
  readonly keywords?: readonly string[];
  /**
   * Tenant IDs this package is visible to.
   * `["*"]` means globally visible.
   */
  readonly tenantScopes?: readonly string[];
}

/**
 * The package manifest — the primary descriptor of a Friday package.
 *
 * Corresponds to the `manifest.json` file within the `.fridaypkg` archive.
 */
export interface FridayPackageManifest {
  /** Scoped package name (e.g. `@friday/example-skills`). */
  readonly name: string;
  /** Semantic version string (e.g. `1.2.3` or `1.0.0-beta.1`). */
  readonly version: string;
  /** Human-readable description. */
  readonly description: string;
  /** Package author information. */
  readonly author: FridayPackageAuthor;
  /** SPDX license identifier. */
  readonly license?: string;
  /**
   * Capabilities provided by this package.
   * Format: `type:name` (e.g. `skill:web-search`).
   */
  readonly capabilities: readonly string[];
  /**
   * Direct dependencies as `name → semver range` pairs.
   */
  readonly dependencies: Readonly<Record<string, string>>;
  /**
   * Peer dependencies as `name → semver range` pairs.
   * Must be satisfied by the host environment; not auto-installed.
   */
  readonly peerDependencies?: Readonly<Record<string, string>>;
  /**
   * Compatible Friday platform version range (semver range syntax).
   */
  readonly fridayVersionRange: string;
  /** Asset glob patterns grouped by category. */
  readonly assets: FridayPackageAssets;
  /** Lifecycle hooks. */
  readonly hooks?: FridayPackageHooks;
  /** Additional metadata for discovery and scoping. */
  readonly metadata?: FridayPackageMetadata;
}

// ═══════════════════════════════════════════════════════════════════════
// PACKAGE SIGNATURE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Supported signature algorithms.
 */
export const FRIDAY_PACKAGE_SIGNATURE_ALGORITHMS = ["Ed25519"] as const;

/** Signature algorithm union type. */
export type FridayPackageSignatureAlgorithm =
  (typeof FRIDAY_PACKAGE_SIGNATURE_ALGORITHMS)[number];

/**
 * Cryptographic signature for a package archive.
 *
 * Corresponds to the `signature.json` file within the `.fridaypkg` archive.
 * The digest covers all archive contents except `signature.json` itself.
 *
 * **Signed payload:** The `signature` field contains the Ed25519 signature
 * computed over the canonical JSON encoding of:
 * ```json
 * { "digest": "<archive digest>", "manifestDigest": "<manifest digest>" }
 * ```
 * Keys are sorted lexicographically; no whitespace. This ensures a
 * deterministic byte sequence for signing and verification.
 */
export interface FridayPackageSignature {
  /** Signing algorithm used. */
  readonly algorithm: FridayPackageSignatureAlgorithm;
  /** Base64-encoded public key of the signer. */
  readonly publicKey: string;
  /**
   * Base64-encoded Ed25519 signature bytes.
   *
   * The signed payload is the canonical JSON of
   * `{ "digest": "<digest>", "manifestDigest": "<manifestDigest>" }`
   * (keys sorted, no whitespace).
   */
  readonly signature: string;
  /**
   * Content digest of the archive (excluding signature.json).
   * Format: `sha256:<hex>`.
   */
  readonly digest: string;
  /**
   * Content digest of manifest.json alone.
   * Format: `sha256:<hex>`.
   */
  readonly manifestDigest: string;
  /** ISO 8601 timestamp when the signature was created. */
  readonly timestamp: ISODateTime;
  /** ISO 8601 timestamp when the signature expires. */
  readonly expiresAt: ISODateTime;
  /** Identifier of the signing key in the trust store. */
  readonly keyId: string;
  /**
   * Optional PEM-encoded certificate chain for the signing key.
   * First entry is the leaf certificate; last is the root.
   */
  readonly certificateChain?: readonly string[];
}

// ═══════════════════════════════════════════════════════════════════════
// PACKAGE VERSION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Version metadata for a published package.
 *
 * Captures semver, changelog, and compatibility information for a
 * specific version of a package in the registry.
 */
export interface FridayPackageVersion {
  /** Unique version record identifier. */
  readonly id: UUID;
  /** Parent package name. */
  readonly packageName: string;
  /** Semantic version string. */
  readonly version: string;
  /** Human-readable changelog entry for this version. */
  readonly changelog?: string;
  /**
   * Compatible Friday platform version range.
   * Copied from the manifest's `fridayVersionRange` at publish time.
   */
  readonly compatibilityRange: string;
  /** SHA-256 digest of the archive. Format: `sha256:<hex>`. */
  readonly archiveDigest: string;
  /** Archive size in bytes. */
  readonly sizeBytes: number;
  /** When this version was published. */
  readonly publishedAt: ISODateTime;
  /** Principal ID of the publisher. */
  readonly publishedBy: string;
  /** Whether this version has been deprecated. */
  readonly deprecated: boolean;
  /** Optional deprecation message. */
  readonly deprecationMessage?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// INSTALL STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════

/**
 * All possible states in the package install lifecycle.
 *
 * State transitions:
 * - downloading → verifying → extracting → activating → active
 * - verifying → verification_failed → failed (verification errors)
 * - active → rolling_back → rolled_back
 * - active → uninstalling → uninstalled
 * - active → verification_failed (when a trusted key is revoked post-install)
 * - Any non-terminal state → failed (on error)
 *
 * Terminal states: rolled_back, uninstalled, failed.
 * Note: `active` is NOT terminal — it can transition to `rolling_back`,
 * `uninstalling`, or `verification_failed`.
 */
export const FRIDAY_PACKAGE_INSTALL_STATES = [
  "downloading",
  "verifying",
  "extracting",
  "activating",
  "active",
  "verification_failed",
  "rolling_back",
  "rolled_back",
  "uninstalling",
  "uninstalled",
  "failed",
] as const;

/** Install state union type. */
export type FridayPackageInstallState =
  (typeof FRIDAY_PACKAGE_INSTALL_STATES)[number];

/**
 * Valid state transitions for the install state machine.
 *
 * Maps each state to the set of states it can transition to.
 */
export const FRIDAY_PACKAGE_STATE_TRANSITIONS: Readonly<
  Record<FridayPackageInstallState, readonly FridayPackageInstallState[]>
> = {
  downloading: ["verifying", "failed"],
  verifying: ["extracting", "verification_failed", "failed"],
  extracting: ["activating", "failed"],
  activating: ["active", "failed"],
  active: ["rolling_back", "uninstalling", "verification_failed", "failed"],
  verification_failed: ["uninstalling", "rolling_back", "failed"],
  rolling_back: ["rolled_back", "failed"],
  rolled_back: [],
  uninstalling: ["uninstalled", "failed"],
  uninstalled: [],
  failed: [],
} as const;

/**
 * Terminal states — no further transitions are possible.
 *
 * Note: `active` is NOT terminal. It can transition to `rolling_back`,
 * `uninstalling`, or `verification_failed`.
 */
export const FRIDAY_PACKAGE_TERMINAL_STATES: readonly FridayPackageInstallState[] = [
  "rolled_back",
  "uninstalled",
  "failed",
] as const;

/**
 * An install record tracking the lifecycle of a package installation
 * within a specific tenant.
 */
export interface FridayPackageInstall {
  /** Unique install record identifier. */
  readonly id: UUID;
  /** Registry package ID. */
  readonly packageId: UUID;
  /** Package name (denormalized for querying). */
  readonly packageName: string;
  /** Package version string (denormalized). */
  readonly packageVersion: string;
  /** Tenant this install belongs to. */
  readonly tenantId: string;
  /** Current install state. */
  readonly state: FridayPackageInstallState;
  /** Filesystem path where the package is extracted. */
  readonly installDir?: string;
  /** Error message if state is `failed`. */
  readonly errorMessage?: string;
  /** Error code if state is `failed`. */
  readonly errorCode?: string;
  /** Previous version before upgrade (for rollback reference). */
  readonly previousVersion?: string;
  /** Optimistic concurrency token (opaque string, changes on every write). */
  readonly etag: string;
  /**
   * Monotonically increasing version counter for optimistic concurrency.
   * Incremented on every state transition; used together with `etag`
   * to detect stale reads.
   */
  readonly version: number;
  /** Principal ID of the installer. */
  readonly installedBy: string;
  /** Idempotency key for the install operation. */
  readonly idempotencyKey?: string;
  /** When this install record was created. */
  readonly createdAt: ISODateTime;
  /** When this install record was last updated. */
  readonly updatedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// PACKAGE REGISTRY ENTRY
// ═══════════════════════════════════════════════════════════════════════

/**
 * A published package in the registry.
 *
 * Represents a unique (name, version) tuple with its manifest,
 * signature, and publication metadata.
 */
export interface FridayPackageRegistryEntry {
  /** Unique registry entry identifier. */
  readonly id: UUID;
  /** Package name. */
  readonly name: string;
  /** Semantic version string. */
  readonly version: string;
  /** Human-readable description. */
  readonly description?: string;
  /** Author information from the manifest. */
  readonly author: FridayPackageAuthor;
  /** SPDX license identifier. */
  readonly license?: string;
  /** Capabilities provided by this package. */
  readonly capabilities: readonly string[];
  /** Direct dependencies. */
  readonly dependencies: Readonly<Record<string, string>>;
  /** Peer dependencies. */
  readonly peerDependencies: Readonly<Record<string, string>>;
  /** Compatible Friday platform version range. */
  readonly fridayVersionRange: string;
  /** Asset configuration. */
  readonly assets: FridayPackageAssets;
  /** Lifecycle hooks. */
  readonly hooks: FridayPackageHooks;
  /** Additional metadata. */
  readonly metadata: FridayPackageMetadata;
  /** Archive size in bytes. */
  readonly sizeBytes: number;
  /** SHA-256 digest of the archive. */
  readonly archiveDigest: string;
  /** SHA-256 digest of the manifest. */
  readonly manifestDigest: string;
  /** Cryptographic signature. */
  readonly signature: FridayPackageSignature;
  /** Principal ID of the publisher. */
  readonly publishedBy: string;
  /** Tenant ID (null for global packages). */
  readonly tenantId?: string;
  /** Optimistic concurrency token. */
  readonly etag: string;
  /** When this entry was created. */
  readonly createdAt: ISODateTime;
  /** When this entry was last updated. */
  readonly updatedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// DEPENDENCY RESOLUTION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Conflict type identifiers for dependency resolution failures.
 */
export const FRIDAY_DEPENDENCY_CONFLICT_TYPES = [
  "version_incompatible",
  "not_found",
  "circular",
  "peer_unsatisfied",
  "platform_incompatible",
] as const;

/** Dependency conflict type union. */
export type FridayDependencyConflictType =
  (typeof FRIDAY_DEPENDENCY_CONFLICT_TYPES)[number];

/**
 * A single resolved dependency in the dependency graph.
 */
export interface FridayDependencyResolution {
  /** Dependency package name. */
  readonly name: string;
  /** Requested version range. */
  readonly requestedRange: string;
  /** Resolved concrete version. */
  readonly resolvedVersion: string;
  /** Registry entry ID for the resolved package. */
  readonly registryEntryId: UUID;
  /** Whether this is a direct or transitive dependency. */
  readonly direct: boolean;
  /** Name of the package that depends on this one. */
  readonly requestedBy: string;
}

/**
 * A conflicting version range from a specific requester.
 */
export interface FridayConflictingRange {
  /** Package that requested this range. */
  readonly requestedBy: string;
  /** The semver range that was requested. */
  readonly range: string;
}

// ─── Discriminated union variants for dependency conflicts ───

/** Two or more dependents request incompatible version ranges. */
export interface FridayVersionIncompatibleConflict {
  readonly type: "version_incompatible";
  readonly dependencyName: string;
  readonly message: string;
  /** The conflicting version ranges from different requesters. */
  readonly conflictingRanges: readonly FridayConflictingRange[];
}

/** A required dependency does not exist in the registry. */
export interface FridayNotFoundConflict {
  readonly type: "not_found";
  readonly dependencyName: string;
  readonly message: string;
}

/** A circular dependency cycle was detected. */
export interface FridayCircularConflict {
  readonly type: "circular";
  readonly dependencyName: string;
  readonly message: string;
  /** The dependency cycle path (e.g. `["A", "B", "C", "A"]`). */
  readonly cyclePath: readonly string[];
}

/** A peer dependency requirement is not satisfied by the host. */
export interface FridayPeerUnsatisfiedConflict {
  readonly type: "peer_unsatisfied";
  readonly dependencyName: string;
  readonly message: string;
  /** The range required by the peer dependency declaration. */
  readonly requiredRange: string;
  /** The version available in the host (if any). */
  readonly availableVersion?: string;
}

/** The package is incompatible with the current Friday platform version. */
export interface FridayPlatformIncompatibleConflict {
  readonly type: "platform_incompatible";
  readonly dependencyName: string;
  readonly message: string;
  /** The required Friday platform version range. */
  readonly requiredRange: string;
  /** The current Friday platform version. */
  readonly currentVersion: string;
}

/**
 * A dependency conflict preventing installation.
 *
 * Discriminated union keyed by `type`. Each variant carries only the
 * fields relevant to that conflict kind.
 */
export type FridayDependencyConflict =
  | FridayVersionIncompatibleConflict
  | FridayNotFoundConflict
  | FridayCircularConflict
  | FridayPeerUnsatisfiedConflict
  | FridayPlatformIncompatibleConflict;

/**
 * Complete result of dependency resolution.
 *
 * If conflicts is non-empty, the resolution failed and the install
 * should be blocked.
 */
export interface FridayDependencyResolutionResult {
  /** Successfully resolved dependencies. */
  readonly resolved: readonly FridayDependencyResolution[];
  /** Conflicts preventing resolution. */
  readonly conflicts: readonly FridayDependencyConflict[];
  /** Whether all dependencies were resolved without conflicts. */
  readonly success: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// ROLLBACK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Rollback state values.
 */
export const FRIDAY_PACKAGE_ROLLBACK_STATES = [
  "initiated",
  "completed",
  "failed",
] as const;

/** Rollback state union type. */
export type FridayPackageRollbackState =
  (typeof FRIDAY_PACKAGE_ROLLBACK_STATES)[number];

/**
 * A record of a package rollback operation.
 */
export interface FridayPackageRollback {
  /** Unique rollback record identifier. */
  readonly id: UUID;
  /** Install record ID that was rolled back. */
  readonly installId: UUID;
  /** Package name. */
  readonly packageName: string;
  /** Version rolled back from. */
  readonly fromVersion: string;
  /** Version rolled back to. */
  readonly toVersion: string;
  /** Human-readable reason for the rollback. */
  readonly reason: string;
  /** Principal ID who initiated the rollback. */
  readonly initiatedBy: string;
  /** Current rollback state. */
  readonly state: FridayPackageRollbackState;
  /** Error message if the rollback failed. */
  readonly errorMessage?: string;
  /** When the rollback was initiated. */
  readonly startedAt: ISODateTime;
  /** When the rollback completed (or failed). */
  readonly completedAt?: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// TRUSTED KEY
// ═══════════════════════════════════════════════════════════════════════

/**
 * A trusted public key registered in the key trust store.
 */
export interface FridayPackageTrustedKey {
  /** Unique record identifier. */
  readonly id: UUID;
  /** Key identifier (matches `FridayPackageSignature.keyId`). */
  readonly keyId: string;
  /** Base64-encoded public key. */
  readonly publicKey: string;
  /** Signature algorithm. */
  readonly algorithm: FridayPackageSignatureAlgorithm;
  /** Human-readable owner name. */
  readonly owner: string;
  /** Tenant ID (null for globally trusted keys). */
  readonly tenantId?: string;
  /** When this key was trusted. */
  readonly trustedAt: ISODateTime;
  /** When this key expires (null for no expiry). */
  readonly expiresAt?: ISODateTime;
  /** When this key was revoked (null if not revoked). */
  readonly revokedAt?: ISODateTime;
  /** Reason for revocation. */
  readonly revocationReason?: string;
  /** When this record was created. */
  readonly createdAt: ISODateTime;
  /** When this record was last updated. */
  readonly updatedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// VERIFICATION RESULT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Verification outcome codes.
 */
export const FRIDAY_PACKAGE_VERIFICATION_OUTCOMES = [
  "valid",
  "untrusted_key",
  "expired_signature",
  "digest_mismatch",
  "signature_invalid",
  "manifest_tampered",
  "key_revoked",
] as const;

/** Verification outcome union type. */
export type FridayPackageVerificationOutcome =
  (typeof FRIDAY_PACKAGE_VERIFICATION_OUTCOMES)[number];

/**
 * Result of verifying a package's cryptographic signature and integrity.
 */
export interface FridayPackageVerificationResult {
  /** Whether the verification passed. */
  readonly valid: boolean;
  /** Verification outcome code. */
  readonly outcome: FridayPackageVerificationOutcome;
  /** Human-readable description of the result. */
  readonly message: string;
  /** Key ID used for verification. */
  readonly keyId?: string;
  /** When the verification was performed. */
  readonly verifiedAt: ISODateTime;
  /** Verification duration in milliseconds. */
  readonly durationMs: number;
}

// ═══════════════════════════════════════════════════════════════════════
// LIFECYCLE AUDIT EVENT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Lifecycle operations that generate audit events.
 */
export const FRIDAY_PACKAGE_LIFECYCLE_OPERATIONS = [
  "publish",
  "install",
  "upgrade",
  "rollback",
  "uninstall",
  "verify",
  "key_trust",
  "key_revoke",
] as const;

/** Lifecycle operation union type. */
export type FridayPackageLifecycleOperation =
  (typeof FRIDAY_PACKAGE_LIFECYCLE_OPERATIONS)[number];

/**
 * An audit event for a package lifecycle operation.
 */
export interface FridayPackageLifecycleEvent {
  /** Unique event identifier. */
  readonly id: UUID;
  /** Package name. */
  readonly packageName: string;
  /** Package version (if applicable). */
  readonly packageVersion?: string;
  /** Lifecycle operation. */
  readonly operation: FridayPackageLifecycleOperation;
  /** State before the operation. */
  readonly stateFrom?: FridayPackageInstallState;
  /** State after the operation. */
  readonly stateTo: FridayPackageInstallState;
  /** Principal ID performing the operation. */
  readonly principalId?: string;
  /** Tenant ID context. */
  readonly tenantId?: string;
  /** Additional event details. */
  readonly details: JsonObject;
  /** When the event occurred. */
  readonly createdAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// ENGINE CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Configuration for the package lifecycle engine.
 */
export interface FridayPackageEngineConfig {
  /** Maximum package archive size in bytes. @default 104_857_600 (100 MB) */
  readonly maxPackageSizeBytes: number;
  /** Maximum concurrent installs. @default 4 */
  readonly maxConcurrentInstalls: number;
  /** Grace period in hours before cleaning up old versions after upgrade. @default 24 */
  readonly upgradeGracePeriodHours: number;
  /** Key rotation grace period in days. @default 90 */
  readonly keyRotationGraceDays: number;
  /** Idempotency key TTL in hours. @default 24 */
  readonly idempotencyTtlHours: number;
  /** Generate a new UUID. */
  readonly generateId: () => UUID;
  /** Get current ISO timestamp. */
  readonly nowIso: () => ISODateTime;
}

/**
 * Default engine configuration values.
 */
export const FRIDAY_PACKAGE_ENGINE_DEFAULTS = {
  maxPackageSizeBytes: 104_857_600,
  maxConcurrentInstalls: 4,
  upgradeGracePeriodHours: 24,
  keyRotationGraceDays: 90,
  idempotencyTtlHours: 24,
} as const;

// ═══════════════════════════════════════════════════════════════════════
// PERSISTENCE ROW TYPES (SQLite)
// ═══════════════════════════════════════════════════════════════════════

/** SQLite row shape for the `package_registry` table. */
export interface FridayPackageRegistryRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string | null;
  readonly author_json: string;
  readonly license: string | null;
  readonly capabilities_json: string;
  readonly dependencies_json: string;
  readonly peer_deps_json: string;
  readonly friday_version: string;
  readonly assets_json: string;
  readonly hooks_json: string;
  readonly metadata_json: string;
  readonly size_bytes: number;
  readonly archive_digest: string;
  readonly manifest_digest: string;
  readonly signature_json: string;
  readonly published_by: string;
  readonly tenant_id: string | null;
  readonly etag: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

/** SQLite row shape for the `package_installs` table. */
export interface FridayPackageInstallRow {
  readonly id: string;
  readonly package_id: string;
  readonly package_name: string;
  readonly package_version: string;
  readonly tenant_id: string;
  readonly state: string;
  readonly install_dir: string | null;
  readonly error_message: string | null;
  readonly error_code: string | null;
  readonly previous_version: string | null;
  readonly etag: string;
  readonly version: number;
  readonly installed_by: string;
  readonly idempotency_key: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `package_rollbacks` table. */
export interface FridayPackageRollbackRow {
  readonly id: string;
  readonly install_id: string;
  readonly package_name: string;
  readonly from_version: string;
  readonly to_version: string;
  readonly reason: string;
  readonly initiated_by: string;
  readonly state: string;
  readonly error_message: string | null;
  readonly started_at: string;
  readonly completed_at: string | null;
}

/** SQLite row shape for the `package_trusted_keys` table. */
export interface FridayPackageTrustedKeyRow {
  readonly id: string;
  readonly key_id: string;
  readonly public_key: string;
  readonly algorithm: string;
  readonly owner: string;
  readonly tenant_id: string | null;
  readonly trusted_at: string;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
  readonly revocation_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `package_dependency_locks` table. */
export interface FridayPackageDependencyLockRow {
  readonly id: string;
  readonly install_id: string;
  readonly dependency_name: string;
  readonly resolved_version: string;
  readonly requested_range: string;
  readonly resolved_at: string;
}

/** SQLite row shape for the `package_lifecycle_log` table. */
export interface FridayPackageLifecycleLogRow {
  readonly id: string;
  readonly package_name: string;
  readonly package_version: string | null;
  readonly operation: string;
  readonly state_from: string | null;
  readonly state_to: string;
  readonly principal_id: string | null;
  readonly tenant_id: string | null;
  readonly details_json: string;
  readonly created_at: string;
}

/**
 * SQLite row shape for the `package_idempotency_keys` table.
 *
 * Uniqueness is on `(principal_id, operation, key)` — the same key
 * string may be reused by different principals or for different
 * operations without conflict.
 */
export interface FridayPackageIdempotencyKeyRow {
  readonly principal_id: string;
  readonly operation: string;
  readonly key: string;
  readonly payload_hash: string;
  readonly response_json: string;
  readonly created_at: string;
  readonly expires_at: string;
}

// ─── Row-to-Entity Mapper Signature ───

/** Generic row-to-entity mapper function type. */
export type FridayPackageRowMapper<TRow, TEntity> = (row: TRow) => TEntity;
