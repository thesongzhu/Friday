/**
 * Package Installer — Install/uninstall/upgrade packages with dependency
 * management, verification, lifecycle transitions, and rollback safety.
 *
 * @module packaging/engine/package-installer
 */

import type {
  FridayDependencyResolutionResult,
  FridayPackageEngineConfig,
  FridayPackageInstall,
  FridayPackageInstallState,
  FridayPackageLifecycleEvent,
  FridayPackageLifecycleOperation,
  FridayPackageRegistryEntry,
  FridayPackageRollback,
  FridayPackageTrustedKey,
  FridayPackageVerificationOutcome,
  FridayPackageVerificationResult,
  ISODateTime,
  JsonObject,
  UUID,
} from "../model/friday-packaging.types.js";
import {
  FRIDAY_PACKAGE_ENGINE_DEFAULTS,
  FRIDAY_PACKAGE_STATE_TRANSITIONS,
  FRIDAY_PACKAGE_TERMINAL_STATES,
} from "../model/friday-packaging.types.js";
import type { RegistryManager } from "./registry-manager.js";
import { type DependencyResolverConfig, resolveDependencies } from "./dependency-resolver.js";
import { verifySignatureLogical } from "./package-validator.js";

// ─── Install Options ───

/** Options for installing a package. */
export interface InstallOptions {
  readonly packageName: string;
  readonly version?: string;
  readonly tenantId: string;
  readonly installedBy: string;
  readonly idempotencyKey?: string;
  readonly platformVersion: string;
}

/** Options for upgrading a package. */
export interface UpgradeOptions {
  readonly packageName: string;
  readonly targetVersion?: string;
  readonly tenantId: string;
  readonly etag: string;
  readonly upgradedBy: string;
  readonly idempotencyKey?: string;
  readonly platformVersion: string;
  readonly reason?: string;
}

/** Options for uninstalling a package. */
export interface UninstallOptions {
  readonly packageName: string;
  readonly tenantId: string;
  readonly etag: string;
  readonly reason?: string;
  readonly uninstalledBy?: string;
}

/** Options for rolling back a package. */
export interface RollbackOptions {
  readonly packageName: string;
  readonly targetVersion: string;
  readonly tenantId: string;
  readonly etag: string;
  readonly reason: string;
  readonly initiatedBy: string;
}

/** Query criteria for lifecycle events. */
export interface LifecycleEventQuery {
  readonly packageName?: string;
  readonly operation?: FridayPackageLifecycleOperation;
  readonly tenantId?: string;
  readonly after?: ISODateTime;
  readonly before?: ISODateTime;
}

/** Input to package verification before extraction. */
export interface PackageVerificationContext {
  readonly entry: FridayPackageRegistryEntry;
  readonly tenantId: string;
  readonly platformVersion: string;
  readonly initiatedBy: string;
  readonly verifiedAt: ISODateTime;
}

/** Verification hook used during install and upgrade. */
export type PackageVerifier = (
  context: PackageVerificationContext,
) => FridayPackageVerificationResult;

/** Package installer-specific configuration. */
export interface PackageInstallerConfig extends Partial<FridayPackageEngineConfig> {
  /** Trusted keys used by the default verifier. */
  readonly trustedKeys?: readonly FridayPackageTrustedKey[];
  readonly verifyPackage?: PackageVerifier;
}

/** Result of an install operation. */
export interface InstallResult {
  readonly success: boolean;
  readonly install: FridayPackageInstall | null;
  readonly dependencies: FridayDependencyResolutionResult | null;
  readonly verification: FridayPackageVerificationResult | null;
  readonly error?: string;
  readonly errorCode?: string;
}

/** Result of an upgrade operation. */
export interface UpgradeResult {
  readonly success: boolean;
  readonly install: FridayPackageInstall | null;
  readonly previousVersion?: string;
  readonly dependencies: FridayDependencyResolutionResult | null;
  readonly verification: FridayPackageVerificationResult | null;
  readonly error?: string;
  readonly errorCode?: string;
}

/** Result of an uninstall operation. */
export interface UninstallResult {
  readonly success: boolean;
  readonly install: FridayPackageInstall | null;
  readonly error?: string;
  readonly errorCode?: string;
}

/** Result of a rollback operation. */
export interface RollbackResult {
  readonly success: boolean;
  readonly rollback: FridayPackageRollback | null;
  readonly install: FridayPackageInstall | null;
  readonly error?: string;
  readonly errorCode?: string;
}

// ─── Package Installer ───

/** Package installer facade. */
export interface PackageInstaller {
  /** Install a package. */
  install(options: InstallOptions): InstallResult;

  /** Upgrade an active package install. */
  upgrade(options: UpgradeOptions): UpgradeResult;

  /** Uninstall a package. */
  uninstall(options: UninstallOptions): UninstallResult;

  /** Rollback a package to a previous version. */
  rollback(options: RollbackOptions): RollbackResult;

  /** Get an install record by ID. */
  getInstall(installId: UUID): FridayPackageInstall | null;

  /** Get the latest verification result for an install. */
  getVerification(installId: UUID): FridayPackageVerificationResult | null;

  /** Get the active install for a package in a tenant. */
  getActiveInstall(packageName: string, tenantId: string): FridayPackageInstall | null;

  /** List all install records for a tenant. */
  listInstalls(tenantId: string): readonly FridayPackageInstall[];

  /** List all rollback records for an install. */
  listRollbacks(installId: UUID): readonly FridayPackageRollback[];

  /** List lifecycle events. */
  listLifecycleEvents(criteria?: LifecycleEventQuery): readonly FridayPackageLifecycleEvent[];

  /** Get the count of active (non-terminal) installs. */
  activeInstallCount(): number;

  /** Transition an install to a new state (for state machine testing). */
  transitionState(installId: UUID, newState: FridayPackageInstallState, error?: string): FridayPackageInstall | null;
}

// ─── State Machine ───

export function isValidInstallTransition(
  from: FridayPackageInstallState,
  to: FridayPackageInstallState,
): boolean {
  const allowed = FRIDAY_PACKAGE_STATE_TRANSITIONS[from];
  return allowed.includes(to);
}

function isTerminalState(state: FridayPackageInstallState): boolean {
  return FRIDAY_PACKAGE_TERMINAL_STATES.includes(state);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    const objectValue: object = value;
    for (const nested of Object.values(objectValue)) {
      if (nested !== null && typeof nested === "object" && !Object.isFrozen(nested)) {
        deepFreeze(nested);
      }
    }
    Object.freeze(value);
  }
  return value;
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function mapVerificationOutcomeToErrorCode(outcome: FridayPackageVerificationOutcome): string {
  switch (outcome) {
    case "untrusted_key":
      return "PACKAGING_UNTRUSTED_KEY";
    case "expired_signature":
      return "PACKAGING_SIGNATURE_EXPIRED";
    case "key_revoked":
      return "PACKAGING_KEY_REVOKED";
    case "digest_mismatch":
    case "manifest_tampered":
    case "signature_invalid":
      return "PACKAGING_VERIFICATION_FAILED";
    case "valid":
      return "";
  }
}

function createDefaultVerifier(trustedKeys: readonly FridayPackageTrustedKey[]): PackageVerifier {
  return (context: PackageVerificationContext): FridayPackageVerificationResult =>
    verifySignatureLogical(
      context.entry.signature,
      context.entry.manifestDigest,
      context.entry.archiveDigest,
      trustedKeys,
      context.verifiedAt,
    );
}

function lifecycleDetails(
  stateFrom: FridayPackageInstallState | null,
  stateTo: FridayPackageInstallState,
  reason: string | null,
  extra?: Readonly<Record<string, string | number | boolean | null>>,
): JsonObject {
  const details: Record<string, string | number | boolean | null> = {
    reason,
    stateFrom,
    stateTo,
  };

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      details[key] = value;
    }
  }

  return details;
}

// ─── Implementation ───

/** Create a new package installer. */
export function createPackageInstaller(
  registry: RegistryManager,
  config?: PackageInstallerConfig,
): PackageInstaller {
  const generateId = config?.generateId ?? (() => crypto.randomUUID());
  const nowIso = config?.nowIso ?? (() => new Date().toISOString());
  const maxConcurrent = config?.maxConcurrentInstalls ?? FRIDAY_PACKAGE_ENGINE_DEFAULTS.maxConcurrentInstalls;
  const trustedKeys = config?.trustedKeys ?? [];
  const verifyPackage = config?.verifyPackage ?? createDefaultVerifier(trustedKeys);

  // Install records: id → install
  const installs = new Map<UUID, FridayPackageInstall>();
  // Active install index: "tenantId:packageName" → installId
  const activeIndex = new Map<string, UUID>();
  // Rollback records: installId → rollback[]
  const rollbacks = new Map<UUID, FridayPackageRollback[]>();
  // Latest verification by install
  const verificationByInstall = new Map<UUID, FridayPackageVerificationResult>();
  // Lifecycle audit log
  const lifecycleEvents: FridayPackageLifecycleEvent[] = [];

  function activeKey(tenantId: string, packageName: string): string {
    return `${tenantId}:${packageName}`;
  }

  function countActiveInstalls(): number {
    let count = 0;
    for (const install of installs.values()) {
      if (!isTerminalState(install.state) && install.state !== "active") {
        count++;
      }
    }
    return count;
  }

  function updateInstall(
    install: FridayPackageInstall,
    updates: Partial<FridayPackageInstall>,
  ): FridayPackageInstall {
    const now = nowIso();
    const updated: FridayPackageInstall = {
      ...install,
      ...updates,
      etag: generateId(),
      version: install.version + 1,
      updatedAt: now,
    };
    installs.set(updated.id, updated);

    // Update active index
    const key = activeKey(updated.tenantId, updated.packageName);
    if (updated.state === "active") {
      activeIndex.set(key, updated.id);
    } else if (isTerminalState(updated.state)) {
      if (activeIndex.get(key) === updated.id) {
        activeIndex.delete(key);
      }
    }

    return updated;
  }

  function pushLifecycleEvent(
    operation: FridayPackageLifecycleOperation,
    install: FridayPackageInstall,
    stateFrom: FridayPackageInstallState | null,
    stateTo: FridayPackageInstallState,
    reason: string | null,
    principalId?: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ): void {
    lifecycleEvents.push({
      id: generateId(),
      packageName: install.packageName,
      packageVersion: install.packageVersion,
      operation,
      ...(stateFrom !== null ? { stateFrom } : {}),
      stateTo,
      ...(principalId ? { principalId } : {}),
      tenantId: install.tenantId,
      details: lifecycleDetails(stateFrom, stateTo, reason, details),
      createdAt: nowIso(),
    });
  }

  function transitionInstall(
    install: FridayPackageInstall,
    newState: FridayPackageInstallState,
    operation: FridayPackageLifecycleOperation,
    principalId?: string,
    reason?: string,
    updates?: Partial<FridayPackageInstall>,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ): FridayPackageInstall | null {
    if (!isValidInstallTransition(install.state, newState)) {
      return null;
    }

    const nextUpdates: Partial<FridayPackageInstall> = {
      ...(updates ?? {}),
      state: newState,
    };

    const updated = updateInstall(install, nextUpdates);
    pushLifecycleEvent(
      operation,
      updated,
      install.state,
      newState,
      reason ?? null,
      principalId,
      details,
    );
    return updated;
  }

  function transitionFailure(
    install: FridayPackageInstall,
    operation: FridayPackageLifecycleOperation,
    principalId: string | undefined,
    error: string,
    errorCode: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ): FridayPackageInstall {
    const failed = transitionInstall(
      install,
      "failed",
      operation,
      principalId,
      error,
      { errorMessage: error, errorCode },
      details,
    );
    return failed ?? install;
  }

  function createInstallRecord(
    entry: FridayPackageRegistryEntry,
    tenantId: string,
    principalId: string,
    idempotencyKey: string | undefined,
    previousVersion?: string,
  ): FridayPackageInstall {
    const now = nowIso();
    return {
      id: generateId(),
      packageId: entry.id,
      packageName: entry.name,
      packageVersion: entry.version,
      tenantId,
      state: "downloading",
      ...(previousVersion ? { previousVersion } : {}),
      etag: generateId(),
      version: 1,
      installedBy: principalId,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  function runInstallLifecycle(
    entry: FridayPackageRegistryEntry,
    tenantId: string,
    principalId: string,
    platformVersion: string,
    operation: "install" | "upgrade",
    idempotencyKey?: string,
    previousVersion?: string,
  ): {
    readonly success: boolean;
    readonly install: FridayPackageInstall;
    readonly verification: FridayPackageVerificationResult;
    readonly error?: string;
    readonly errorCode?: string;
  } {
    const install = createInstallRecord(
      entry,
      tenantId,
      principalId,
      idempotencyKey,
      previousVersion,
    );

    installs.set(install.id, install);
    pushLifecycleEvent(
      operation,
      install,
      null,
      "downloading",
      `${operation} started`,
      principalId,
    );

    let current = install;

    const verifying = transitionInstall(
      current,
      "verifying",
      operation,
      principalId,
      "Verifying package integrity",
    );

    if (!verifying) {
      const message = `Invalid transition from ${current.state} to verifying`;
      const failed = transitionFailure(
        current,
        operation,
        principalId,
        message,
        "PACKAGING_VALIDATION_FAILED",
      );
      const invalidVerification = {
        valid: false,
        outcome: "signature_invalid",
        message,
        keyId: entry.signature.keyId,
        verifiedAt: nowIso(),
        durationMs: 0,
      } satisfies FridayPackageVerificationResult;
      verificationByInstall.set(failed.id, invalidVerification);
      return {
        success: false,
        install: failed,
        verification: invalidVerification,
        error: message,
        errorCode: "PACKAGING_VALIDATION_FAILED",
      };
    }

    current = verifying;

    const verification = verifyPackage({
      entry,
      tenantId,
      platformVersion,
      initiatedBy: principalId,
      verifiedAt: nowIso(),
    });

    verificationByInstall.set(current.id, verification);
    lifecycleEvents.push({
      id: generateId(),
      packageName: current.packageName,
      packageVersion: current.packageVersion,
      operation: "verify",
      stateFrom: current.state,
      stateTo: current.state,
      principalId,
      tenantId: current.tenantId,
      details: {
        reason: verification.message,
        stateFrom: current.state,
        stateTo: current.state,
        outcome: verification.outcome,
        valid: verification.valid,
      },
      createdAt: nowIso(),
    });

    if (!verification.valid) {
      const errorCode = mapVerificationOutcomeToErrorCode(verification.outcome);

      const verificationFailed = transitionInstall(
        current,
        "verification_failed",
        operation,
        principalId,
        verification.message,
        { errorMessage: verification.message, errorCode },
        {
          verificationOutcome: verification.outcome,
        },
      );

      const failureStart = verificationFailed ?? current;
      const failed = transitionFailure(
        failureStart,
        operation,
        principalId,
        verification.message,
        errorCode,
        {
          verificationOutcome: verification.outcome,
        },
      );

      return {
        success: false,
        install: failed,
        verification,
        error: verification.message,
        errorCode,
      };
    }

    const extracting = transitionInstall(
      current,
      "extracting",
      operation,
      principalId,
      "Extracting package archive",
    );

    if (!extracting) {
      const message = `Invalid transition from ${current.state} to extracting`;
      const failed = transitionFailure(
        current,
        operation,
        principalId,
        message,
        "PACKAGING_VALIDATION_FAILED",
      );
      return {
        success: false,
        install: failed,
        verification,
        error: message,
        errorCode: "PACKAGING_VALIDATION_FAILED",
      };
    }

    current = extracting;

    const activating = transitionInstall(
      current,
      "activating",
      operation,
      principalId,
      "Activating package",
    );

    if (!activating) {
      const message = `Invalid transition from ${current.state} to activating`;
      const failed = transitionFailure(
        current,
        operation,
        principalId,
        message,
        "PACKAGING_VALIDATION_FAILED",
      );
      return {
        success: false,
        install: failed,
        verification,
        error: message,
        errorCode: "PACKAGING_VALIDATION_FAILED",
      };
    }

    current = activating;

    const active = transitionInstall(
      current,
      "active",
      operation,
      principalId,
      "Package active",
    );

    if (!active) {
      const message = `Invalid transition from ${current.state} to active`;
      const failed = transitionFailure(
        current,
        operation,
        principalId,
        message,
        "PACKAGING_VALIDATION_FAILED",
      );
      return {
        success: false,
        install: failed,
        verification,
        error: message,
        errorCode: "PACKAGING_VALIDATION_FAILED",
      };
    }

    return {
      success: true,
      install: active,
      verification,
    };
  }

  function resolveTargetEntry(
    packageName: string,
    version: string | undefined,
    tenantId: string,
  ): FridayPackageRegistryEntry | null {
    if (version) {
      return registry.getByNameVersion(packageName, version, tenantId);
    }
    return registry.getLatest(packageName, tenantId);
  }

  function snapshotInstall(install: FridayPackageInstall | null): FridayPackageInstall | null {
    return install ? cloneAndFreeze(install) : null;
  }

  function snapshotRollback(rollback: FridayPackageRollback | null): FridayPackageRollback | null {
    return rollback ? cloneAndFreeze(rollback) : null;
  }

  function snapshotVerification(
    verification: FridayPackageVerificationResult | null,
  ): FridayPackageVerificationResult | null {
    return verification ? cloneAndFreeze(verification) : null;
  }

  function snapshotDependencies(
    dependencies: FridayDependencyResolutionResult | null,
  ): FridayDependencyResolutionResult | null {
    return dependencies ? cloneAndFreeze(dependencies) : null;
  }

  return {
    install(options: InstallOptions): InstallResult {
      const {
        packageName,
        version,
        tenantId,
        installedBy,
        idempotencyKey,
        platformVersion,
      } = options;

      // Check concurrent install limit
      if (countActiveInstalls() >= maxConcurrent) {
        return {
          success: false,
          install: null,
          dependencies: null,
          verification: null,
          error: `Maximum concurrent installs (${maxConcurrent}) reached`,
          errorCode: "PACKAGING_CONCURRENT_LIMIT",
        };
      }

      // Check for existing active install
      const existingId = activeIndex.get(activeKey(tenantId, packageName));
      if (existingId) {
        const existing = installs.get(existingId);
        if (existing && existing.state === "active") {
          return {
            success: false,
            install: null,
            dependencies: null,
            verification: null,
            error: `Package "${packageName}" is already installed for tenant "${tenantId}"`,
            errorCode: "PACKAGING_NOT_INSTALLABLE",
          };
        }
      }

      const entry = resolveTargetEntry(packageName, version, tenantId);
      if (!entry) {
        return {
          success: false,
          install: null,
          dependencies: null,
          verification: null,
          error: `Package "${packageName}${version ? `@${version}` : ""}" not found in registry`,
          errorCode: "PACKAGING_PACKAGE_NOT_FOUND",
        };
      }

      const resolverConfig: DependencyResolverConfig = {
        registry,
        platformVersion,
        tenantId,
      };

      const depResult = resolveDependencies(entry.name, entry.version, resolverConfig);
      if (!depResult.success) {
        return {
          success: false,
          install: null,
          dependencies: snapshotDependencies(depResult),
          verification: null,
          error: "Dependency resolution failed",
          errorCode: "PACKAGING_DEPENDENCY_CONFLICT",
        };
      }

      const lifecycle = runInstallLifecycle(
        entry,
        tenantId,
        installedBy,
        platformVersion,
        "install",
        idempotencyKey,
      );

      return {
        success: lifecycle.success,
        install: snapshotInstall(lifecycle.install),
        dependencies: snapshotDependencies(depResult),
        verification: snapshotVerification(lifecycle.verification),
        ...(lifecycle.error ? { error: lifecycle.error } : {}),
        ...(lifecycle.errorCode ? { errorCode: lifecycle.errorCode } : {}),
      };
    },

    upgrade(options: UpgradeOptions): UpgradeResult {
      const {
        packageName,
        targetVersion,
        tenantId,
        etag,
        upgradedBy,
        idempotencyKey,
        platformVersion,
        reason,
      } = options;

      const currentInstallId = activeIndex.get(activeKey(tenantId, packageName));
      if (!currentInstallId) {
        return {
          success: false,
          install: null,
          dependencies: null,
          verification: null,
          error: `No active install of "${packageName}" for tenant "${tenantId}"`,
          errorCode: "PACKAGING_INSTALL_NOT_FOUND",
        };
      }

      const currentInstall = installs.get(currentInstallId);
      if (!currentInstall || currentInstall.state !== "active") {
        return {
          success: false,
          install: null,
          dependencies: null,
          verification: null,
          error: "Install record not found or not active",
          errorCode: "PACKAGING_INSTALL_NOT_FOUND",
        };
      }

      if (currentInstall.etag !== etag) {
        return {
          success: false,
          install: null,
          dependencies: null,
          verification: null,
          error: "ETag mismatch — the install has been modified",
          errorCode: "PACKAGING_ETAG_MISMATCH",
        };
      }

      const targetEntry = resolveTargetEntry(packageName, targetVersion, tenantId);
      if (!targetEntry) {
        return {
          success: false,
          install: null,
          dependencies: null,
          verification: null,
          error: `Package "${packageName}${targetVersion ? `@${targetVersion}` : ""}" not found in registry`,
          errorCode: "PACKAGING_PACKAGE_NOT_FOUND",
        };
      }

      if (targetEntry.version === currentInstall.packageVersion) {
        return {
          success: false,
          install: null,
          dependencies: null,
          verification: null,
          error: `Package "${packageName}" is already at version ${targetEntry.version}`,
          errorCode: "PACKAGING_NOT_INSTALLABLE",
        };
      }

      const depResult = resolveDependencies(targetEntry.name, targetEntry.version, {
        registry,
        platformVersion,
        tenantId,
      });

      if (!depResult.success) {
        return {
          success: false,
          install: null,
          dependencies: snapshotDependencies(depResult),
          verification: null,
          error: "Dependency resolution failed",
          errorCode: "PACKAGING_DEPENDENCY_CONFLICT",
        };
      }

      const upgradeLifecycle = runInstallLifecycle(
        targetEntry,
        tenantId,
        upgradedBy,
        platformVersion,
        "upgrade",
        idempotencyKey,
        currentInstall.packageVersion,
      );

      if (!upgradeLifecycle.success) {
        return {
          success: false,
          install: snapshotInstall(upgradeLifecycle.install),
          previousVersion: currentInstall.packageVersion,
          dependencies: snapshotDependencies(depResult),
          verification: snapshotVerification(upgradeLifecycle.verification),
          ...(upgradeLifecycle.error ? { error: upgradeLifecycle.error } : {}),
          ...(upgradeLifecycle.errorCode ? { errorCode: upgradeLifecycle.errorCode } : {}),
        };
      }

      const rollingBackOld = transitionInstall(
        currentInstall,
        "rolling_back",
        "upgrade",
        upgradedBy,
        reason ?? `Upgrade to ${targetEntry.version}`,
        { previousVersion: currentInstall.packageVersion },
        {
          fromVersion: currentInstall.packageVersion,
          toVersion: targetEntry.version,
        },
      );

      if (!rollingBackOld) {
        return {
          success: false,
          install: snapshotInstall(upgradeLifecycle.install),
          previousVersion: currentInstall.packageVersion,
          dependencies: snapshotDependencies(depResult),
          verification: snapshotVerification(upgradeLifecycle.verification),
          error: `Cannot transition current install from ${currentInstall.state} to rolling_back`,
          errorCode: "PACKAGING_NOT_ROLLBACKABLE",
        };
      }

      const oldRolledBack = transitionInstall(
        rollingBackOld,
        "rolled_back",
        "upgrade",
        upgradedBy,
        reason ?? `Upgrade to ${targetEntry.version}`,
        undefined,
        {
          fromVersion: currentInstall.packageVersion,
          toVersion: targetEntry.version,
        },
      );

      if (!oldRolledBack) {
        return {
          success: false,
          install: snapshotInstall(upgradeLifecycle.install),
          previousVersion: currentInstall.packageVersion,
          dependencies: snapshotDependencies(depResult),
          verification: snapshotVerification(upgradeLifecycle.verification),
          error: `Cannot transition current install from ${rollingBackOld.state} to rolled_back`,
          errorCode: "PACKAGING_NOT_ROLLBACKABLE",
        };
      }

      return {
        success: true,
        install: snapshotInstall(upgradeLifecycle.install),
        previousVersion: currentInstall.packageVersion,
        dependencies: snapshotDependencies(depResult),
        verification: snapshotVerification(upgradeLifecycle.verification),
      };
    },

    uninstall(options: UninstallOptions): UninstallResult {
      const { packageName, tenantId, etag, reason, uninstalledBy } = options;

      const installId = activeIndex.get(activeKey(tenantId, packageName));
      if (!installId) {
        return {
          success: false,
          install: null,
          error: `No active install of "${packageName}" for tenant "${tenantId}"`,
          errorCode: "PACKAGING_INSTALL_NOT_FOUND",
        };
      }

      const install = installs.get(installId);
      if (!install) {
        return {
          success: false,
          install: null,
          error: "Install record not found",
          errorCode: "PACKAGING_INSTALL_NOT_FOUND",
        };
      }

      if (install.etag !== etag) {
        return {
          success: false,
          install: null,
          error: "ETag mismatch — the install has been modified",
          errorCode: "PACKAGING_ETAG_MISMATCH",
        };
      }

      const uninstalling = transitionInstall(
        install,
        "uninstalling",
        "uninstall",
        uninstalledBy ?? install.installedBy,
        reason ?? "Uninstall requested",
      );

      if (!uninstalling) {
        return {
          success: false,
          install: snapshotInstall(install),
          error: `Cannot uninstall from state "${install.state}"`,
          errorCode: "PACKAGING_NOT_UNINSTALLABLE",
        };
      }

      const uninstalled = transitionInstall(
        uninstalling,
        "uninstalled",
        "uninstall",
        uninstalledBy ?? install.installedBy,
        reason ?? "Uninstall completed",
      );

      if (!uninstalled) {
        return {
          success: false,
          install: snapshotInstall(uninstalling),
          error: `Cannot transition uninstall from state "${uninstalling.state}"`,
          errorCode: "PACKAGING_NOT_UNINSTALLABLE",
        };
      }

      return {
        success: true,
        install: snapshotInstall(uninstalled),
      };
    },

    rollback(options: RollbackOptions): RollbackResult {
      const { packageName, targetVersion, tenantId, etag, reason, initiatedBy } = options;

      const installId = activeIndex.get(activeKey(tenantId, packageName));
      if (!installId) {
        return {
          success: false,
          rollback: null,
          install: null,
          error: `No active install of "${packageName}" for tenant "${tenantId}"`,
          errorCode: "PACKAGING_INSTALL_NOT_FOUND",
        };
      }

      const install = installs.get(installId);
      if (!install) {
        return {
          success: false,
          rollback: null,
          install: null,
          error: "Install record not found",
          errorCode: "PACKAGING_INSTALL_NOT_FOUND",
        };
      }

      if (install.etag !== etag) {
        return {
          success: false,
          rollback: null,
          install: null,
          error: "ETag mismatch — the install has been modified",
          errorCode: "PACKAGING_ETAG_MISMATCH",
        };
      }

      const targetEntry = registry.getByNameVersion(packageName, targetVersion, tenantId);
      if (!targetEntry) {
        return {
          success: false,
          rollback: null,
          install: snapshotInstall(install),
          error: `Target version "${packageName}@${targetVersion}" not found`,
          errorCode: "PACKAGING_VERSION_NOT_FOUND",
        };
      }

      const now = nowIso();

      const rollback: FridayPackageRollback = {
        id: generateId(),
        installId: install.id,
        packageName,
        fromVersion: install.packageVersion,
        toVersion: targetVersion,
        reason,
        initiatedBy,
        state: "initiated",
        startedAt: now,
      };

      const rollingBack = transitionInstall(
        install,
        "rolling_back",
        "rollback",
        initiatedBy,
        reason,
        { previousVersion: install.packageVersion },
        {
          fromVersion: install.packageVersion,
          toVersion: targetVersion,
        },
      );

      if (!rollingBack) {
        const failedRollback: FridayPackageRollback = {
          ...rollback,
          state: "failed",
          errorMessage: `Cannot rollback from state "${install.state}"`,
          completedAt: nowIso(),
        };

        const installRollbacks = rollbacks.get(install.id) ?? [];
        installRollbacks.push(failedRollback);
        rollbacks.set(install.id, installRollbacks);

        return {
          success: false,
          rollback: snapshotRollback(failedRollback),
          install: snapshotInstall(install),
          error: failedRollback.errorMessage,
          errorCode: "PACKAGING_NOT_ROLLBACKABLE",
        };
      }

      const rolledBack = transitionInstall(
        rollingBack,
        "rolled_back",
        "rollback",
        initiatedBy,
        reason,
        {
          packageVersion: targetVersion,
          packageId: targetEntry.id,
        },
        {
          fromVersion: install.packageVersion,
          toVersion: targetVersion,
        },
      );

      if (!rolledBack) {
        const failed = transitionFailure(
          rollingBack,
          "rollback",
          initiatedBy,
          `Cannot rollback from state "${rollingBack.state}"`,
          "PACKAGING_NOT_ROLLBACKABLE",
          {
            fromVersion: install.packageVersion,
            toVersion: targetVersion,
          },
        );

        const failedRollback: FridayPackageRollback = {
          ...rollback,
          state: "failed",
          errorMessage: failed.errorMessage,
          completedAt: nowIso(),
        };

        const installRollbacks = rollbacks.get(install.id) ?? [];
        installRollbacks.push(failedRollback);
        rollbacks.set(install.id, installRollbacks);

        return {
          success: false,
          rollback: snapshotRollback(failedRollback),
          install: snapshotInstall(failed),
          error: failed.errorMessage,
          errorCode: failed.errorCode,
        };
      }

      const completedRollback: FridayPackageRollback = {
        ...rollback,
        state: "completed",
        completedAt: nowIso(),
      };

      const installRollbacks = rollbacks.get(install.id) ?? [];
      installRollbacks.push(completedRollback);
      rollbacks.set(install.id, installRollbacks);

      return {
        success: true,
        rollback: snapshotRollback(completedRollback),
        install: snapshotInstall(rolledBack),
      };
    },

    getInstall(installId: UUID): FridayPackageInstall | null {
      const install = installs.get(installId) ?? null;
      return snapshotInstall(install);
    },

    getVerification(installId: UUID): FridayPackageVerificationResult | null {
      const verification = verificationByInstall.get(installId) ?? null;
      return snapshotVerification(verification);
    },

    getActiveInstall(packageName: string, tenantId: string): FridayPackageInstall | null {
      const installId = activeIndex.get(activeKey(tenantId, packageName));
      if (!installId) return null;
      const install = installs.get(installId);
      if (!install || install.state !== "active") return null;
      return snapshotInstall(install);
    },

    listInstalls(tenantId: string): readonly FridayPackageInstall[] {
      const results: FridayPackageInstall[] = [];
      for (const install of installs.values()) {
        if (install.tenantId === tenantId) results.push(install);
      }
      results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return cloneAndFreeze(results);
    },

    listRollbacks(installId: UUID): readonly FridayPackageRollback[] {
      const records = rollbacks.get(installId) ?? [];
      return cloneAndFreeze(records);
    },

    listLifecycleEvents(criteria?: LifecycleEventQuery): readonly FridayPackageLifecycleEvent[] {
      let events = [...lifecycleEvents];

      if (criteria?.packageName) {
        events = events.filter((event) => event.packageName === criteria.packageName);
      }
      if (criteria?.operation) {
        events = events.filter((event) => event.operation === criteria.operation);
      }
      if (criteria?.tenantId) {
        events = events.filter((event) => event.tenantId === criteria.tenantId);
      }
      if (criteria?.after) {
        const after = criteria.after;
        events = events.filter((event) => event.createdAt >= after);
      }
      if (criteria?.before) {
        const before = criteria.before;
        events = events.filter((event) => event.createdAt < before);
      }

      events.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return cloneAndFreeze(events);
    },

    activeInstallCount(): number {
      return countActiveInstalls();
    },

    transitionState(
      installId: UUID,
      newState: FridayPackageInstallState,
      error?: string,
    ): FridayPackageInstall | null {
      const install = installs.get(installId);
      if (!install) return null;

      const transitioned = transitionInstall(
        install,
        newState,
        "verify",
        install.installedBy,
        error,
        error
          ? {
              errorMessage: error,
              ...(newState === "failed" ? { errorCode: "PACKAGING_VALIDATION_FAILED" } : {}),
            }
          : undefined,
      );

      return snapshotInstall(transitioned);
    },
  };
}
