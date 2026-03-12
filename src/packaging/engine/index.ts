// ─── Agent Package and Publishing — Core Runtime Engine ───

// Semver utilities
export {
  parseSemver,
  isValidSemver,
  isValidSemverRange,
  compareSemver,
  compareSemverStr,
  satisfiesRange,
  maxSatisfying,
  rangesIntersect,
} from "./semver.js";

export type { SemverParsed } from "./semver.js";

// Manifest parser
export {
  parseManifestJson,
  validateManifestObject,
  serializeManifest,
} from "./manifest-parser.js";

export type {
  ManifestValidationError,
  ManifestParseResult,
} from "./manifest-parser.js";

// Package validator
export {
  validatePackage,
  verifySignatureLogical,
  validatePlatformCompatibility,
} from "./package-validator.js";

export type {
  PackageValidationResult,
  PackageValidationError,
  PackageContents,
} from "./package-validator.js";

// Registry manager
export { createRegistryManager } from "./registry-manager.js";

export type {
  RegistryManager,
  PublishOptions,
  DuplicateCheckResult,
  RegistrySearchCriteria,
  RegistryPagination,
  RegistryPage,
} from "./registry-manager.js";

// Dependency resolver
export {
  resolveDependencies,
  checkInstallConflicts,
} from "./dependency-resolver.js";

export type { DependencyResolverConfig } from "./dependency-resolver.js";

// Package builder
export {
  buildPackage,
  createMemoryFileSystem,
} from "./package-builder.js";

export type {
  SourceFile,
  PackageFileSystem,
  BuiltPackage,
  BuiltPackageAssets,
  PackageFile,
  BuildError,
  BuildResult,
  PackageBuilderConfig,
} from "./package-builder.js";

// Unified package lifecycle (B-007)
export { createUnifiedPackageLifecycle } from "./friday-unified-package-lifecycle.js";

export type {
  LifecycleSubsystem,
  UnifiedLifecycleOperation,
  UnifiedOperationStatus,
  UnifiedLifecycleEvent,
  UnifiedPackageStatus,
  PackageSkillAsset,
  PackagePluginAsset,
  UnifiedPackageLifecycleDeps,
  FridayUnifiedPackageLifecycle,
} from "./friday-unified-package-lifecycle.js";

// Package installer
export { createPackageInstaller } from "./package-installer.js";
export { isValidInstallTransition } from "./package-installer.js";

export type {
  PackageInstaller,
  PackageInstallerConfig,
  PackageVerifier,
  InstallOptions,
  UpgradeOptions,
  UninstallOptions,
  RollbackOptions,
  LifecycleEventQuery,
  InstallResult,
  UpgradeResult,
  UninstallResult,
  RollbackResult,
} from "./package-installer.js";
