// ─── Agent Package and Publishing Domain Model ───

export {
  FRIDAY_PACKAGE_SIGNATURE_ALGORITHMS,
  FRIDAY_PACKAGE_INSTALL_STATES,
  FRIDAY_PACKAGE_STATE_TRANSITIONS,
  FRIDAY_PACKAGE_TERMINAL_STATES,
  FRIDAY_DEPENDENCY_CONFLICT_TYPES,
  FRIDAY_PACKAGE_ROLLBACK_STATES,
  FRIDAY_PACKAGE_VERIFICATION_OUTCOMES,
  FRIDAY_PACKAGE_LIFECYCLE_OPERATIONS,
  FRIDAY_PACKAGE_ENGINE_DEFAULTS,
} from "./friday-packaging.types.js";

export type {
  // Foundational value types
  UUID,
  ISODateTime,
  JsonPrimitive,
  JsonValue,
  JsonObject,

  // Package manifest
  FridayPackageAuthor,
  FridayPackageAssets,
  FridayPackageHooks,
  FridayPackageMetadata,
  FridayPackageManifest,

  // Package signature
  FridayPackageSignatureAlgorithm,
  FridayPackageSignature,

  // Package version
  FridayPackageVersion,

  // Install state machine
  FridayPackageInstallState,
  FridayPackageInstall,

  // Registry
  FridayPackageRegistryEntry,

  // Dependency resolution
  FridayDependencyConflictType,
  FridayDependencyResolution,
  FridayDependencyConflict,
  FridayConflictingRange,
  FridayVersionIncompatibleConflict,
  FridayNotFoundConflict,
  FridayCircularConflict,
  FridayPeerUnsatisfiedConflict,
  FridayPlatformIncompatibleConflict,
  FridayDependencyResolutionResult,

  // Rollback
  FridayPackageRollbackState,
  FridayPackageRollback,

  // Trusted keys
  FridayPackageTrustedKey,

  // Verification
  FridayPackageVerificationOutcome,
  FridayPackageVerificationResult,

  // Lifecycle audit
  FridayPackageLifecycleOperation,
  FridayPackageLifecycleEvent,

  // Engine configuration
  FridayPackageEngineConfig,

  // Persistence row types
  FridayPackageRegistryRow,
  FridayPackageInstallRow,
  FridayPackageRollbackRow,
  FridayPackageTrustedKeyRow,
  FridayPackageDependencyLockRow,
  FridayPackageLifecycleLogRow,
  FridayPackageIdempotencyKeyRow,
  FridayPackageRowMapper,
} from "./friday-packaging.types.js";
