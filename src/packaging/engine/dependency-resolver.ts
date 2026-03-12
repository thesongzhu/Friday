/**
 * Dependency Resolver — Resolve package dependency trees, detect conflicts
 * and circular dependencies.
 *
 * Implements the resolution algorithm described in the RFC:
 * 1. Flatten — collect all direct and transitive dependencies
 * 2. Intersect — compute intersection of all requested ranges per dep
 * 3. Resolve — select highest satisfying version from registry
 * 4. Validate — check peer dependencies and platform compatibility
 * 5. Conflict — report any unresolvable conflicts
 *
 * @module packaging/engine/dependency-resolver
 */

import type {
  FridayDependencyConflict,
  FridayDependencyResolution,
  FridayDependencyResolutionResult,
  FridayPackageRegistryEntry,
} from "../model/friday-packaging.types.js";
import type { RegistryManager } from "./registry-manager.js";
import { compareSemverStr, satisfiesRange } from "./semver.js";

// ─── Resolver Configuration ───

/** Configuration for the dependency resolver. */
export interface DependencyResolverConfig {
  /** The registry manager to look up packages. */
  readonly registry: RegistryManager;
  /** Current Friday platform version for compatibility checks. */
  readonly platformVersion: string;
  /** Tenant scope for package resolution. */
  readonly tenantId?: string;
  /** Maximum depth for transitive dependency resolution. @default 50 */
  readonly maxDepth?: number;
}

// ─── Internal State ───

interface RangeRequest {
  readonly requestedBy: string;
  readonly range: string;
  readonly direct: boolean;
}

// ─── Resolver ───

/**
 * Resolve the complete dependency tree for a package.
 *
 * @param packageName - Root package name to resolve dependencies for
 * @param packageVersion - Root package version
 * @param config - Resolver configuration
 * @returns Resolution result with resolved deps and/or conflicts
 */
export function resolveDependencies(
  packageName: string,
  packageVersion: string,
  config: DependencyResolverConfig,
): FridayDependencyResolutionResult {
  const { registry, platformVersion, tenantId, maxDepth = 50 } = config;
  const conflicts: FridayDependencyConflict[] = [];

  // Get the root package entry
  const rootEntry = registry.getByNameVersion(packageName, packageVersion, tenantId);
  if (!rootEntry) {
    conflicts.push({
      type: "not_found",
      dependencyName: packageName,
      message: `Root package "${packageName}@${packageVersion}" not found in registry`,
    });
    return { resolved: [], conflicts, success: false };
  }

  // Check platform compatibility for root
  if (!satisfiesRange(platformVersion, rootEntry.fridayVersionRange)) {
    conflicts.push({
      type: "platform_incompatible",
      dependencyName: packageName,
      message: `Package "${packageName}@${packageVersion}" requires Friday ${rootEntry.fridayVersionRange}, but current version is ${platformVersion}`,
      requiredRange: rootEntry.fridayVersionRange,
      currentVersion: platformVersion,
    });
    return { resolved: [], conflicts, success: false };
  }

  // Collect all range requests per dependency name
  const rangeRequests = new Map<string, RangeRequest[]>();
  // Track visited nodes for cycle detection
  const visiting = new Set<string>();
  const visited = new Set<string>();

  // BFS/DFS to collect all dependency ranges
  collectDependencies(
    rootEntry,
    packageName,
    true,
    rangeRequests,
    visiting,
    visited,
    conflicts,
    registry,
    tenantId,
    0,
    maxDepth,
  );

  // If cycles were detected, return early
  if (conflicts.some((c) => c.type === "circular")) {
    return { resolved: [], conflicts, success: false };
  }

  // Resolve each dependency
  const resolved: FridayDependencyResolution[] = [];

  for (const [depName, requests] of rangeRequests) {
    // Get all available versions
    const versions = registry.getVersions(depName, tenantId);
    if (versions.length === 0) {
      conflicts.push({
        type: "not_found",
        dependencyName: depName,
        message: `Dependency "${depName}" not found in registry`,
      });
      continue;
    }

    const versionStrings = versions.map((v) => v.version);

    // Find versions that satisfy ALL requested ranges (intersection)
    const satisfying = versionStrings.filter((v) =>
      requests.every((r) => satisfiesRange(v, r.range)),
    );

    if (satisfying.length === 0) {
      // No version satisfies all ranges — version conflict
      conflicts.push({
        type: "version_incompatible",
        dependencyName: depName,
        message: `No version of "${depName}" satisfies all requested ranges`,
        conflictingRanges: requests.map((r) => ({
          requestedBy: r.requestedBy,
          range: r.range,
        })),
      });
      continue;
    }

    // Pick the highest satisfying version
    const bestVersion = [...satisfying].sort((a, b) => compareSemverStr(b, a))[0];

    const resolvedEntry = versions.find((v) => v.version === bestVersion)!;

    // Check platform compatibility for the dependency
    if (!satisfiesRange(platformVersion, resolvedEntry.fridayVersionRange)) {
      conflicts.push({
        type: "platform_incompatible",
        dependencyName: depName,
        message: `Dependency "${depName}@${bestVersion}" requires Friday ${resolvedEntry.fridayVersionRange}, but current version is ${platformVersion}`,
        requiredRange: resolvedEntry.fridayVersionRange,
        currentVersion: platformVersion,
      });
      continue;
    }

    const isDirect = requests.some((r) => r.direct);
    const requestedBy = isDirect
      ? requests.find((r) => r.direct)!.requestedBy
      : requests[0].requestedBy;

    resolved.push({
      name: depName,
      requestedRange: requests[0].range,
      resolvedVersion: bestVersion,
      registryEntryId: resolvedEntry.id,
      direct: isDirect,
      requestedBy,
    });
  }

  // Validate peer dependencies
  validatePeerDependencies(rootEntry, resolved, registry, conflicts, tenantId);

  const success = conflicts.length === 0;
  return { resolved, conflicts, success };
}

// ─── Internal Helpers ───

function collectDependencies(
  entry: FridayPackageRegistryEntry,
  requesterName: string,
  isDirect: boolean,
  rangeRequests: Map<string, RangeRequest[]>,
  visiting: Set<string>,
  visited: Set<string>,
  conflicts: FridayDependencyConflict[],
  registry: RegistryManager,
  tenantId: string | undefined,
  depth: number,
  maxDepth: number,
): void {
  const entryKey = `${entry.name}@${entry.version}`;

  if (visiting.has(entryKey)) {
    // Cycle detected — build the cycle path
    const cyclePath = [...visiting, entryKey];
    conflicts.push({
      type: "circular",
      dependencyName: entry.name,
      message: `Circular dependency detected: ${cyclePath.join(" → ")}`,
      cyclePath,
    });
    return;
  }

  if (visited.has(entryKey)) return;
  if (depth > maxDepth) return;

  visiting.add(entryKey);

  for (const [depName, depRange] of Object.entries(entry.dependencies)) {
    // Record the range request
    let requests = rangeRequests.get(depName);
    if (!requests) {
      requests = [];
      rangeRequests.set(depName, requests);
    }
    requests.push({
      requestedBy: entry.name,
      range: depRange,
      direct: isDirect,
    });

    // Resolve this dependency to continue traversal
    const depEntry = registry.resolveVersion(depName, depRange, tenantId);
    if (depEntry) {
      collectDependencies(
        depEntry,
        depName,
        false,
        rangeRequests,
        visiting,
        visited,
        conflicts,
        registry,
        tenantId,
        depth + 1,
        maxDepth,
      );
    }
  }

  visiting.delete(entryKey);
  visited.add(entryKey);
}

function validatePeerDependencies(
  rootEntry: FridayPackageRegistryEntry,
  resolved: readonly FridayDependencyResolution[],
  registry: RegistryManager,
  conflicts: FridayDependencyConflict[],
  tenantId?: string,
): void {
  const peerDeps = rootEntry.peerDependencies;
  if (!peerDeps) return;

  for (const [peerName, peerRange] of Object.entries(peerDeps)) {
    // Check if the peer dep is among the resolved deps or installed
    const resolvedDep = resolved.find((r) => r.name === peerName);
    if (resolvedDep) {
      if (!satisfiesRange(resolvedDep.resolvedVersion, peerRange)) {
        conflicts.push({
          type: "peer_unsatisfied",
          dependencyName: peerName,
          message: `Peer dependency "${peerName}" resolved to ${resolvedDep.resolvedVersion} but requires ${peerRange}`,
          requiredRange: peerRange,
          availableVersion: resolvedDep.resolvedVersion,
        });
      }
      continue;
    }

    // Check if any version exists in registry
    const latest = registry.getLatest(peerName, tenantId);
    if (!latest) {
      conflicts.push({
        type: "peer_unsatisfied",
        dependencyName: peerName,
        message: `Peer dependency "${peerName}" (${peerRange}) is not available`,
        requiredRange: peerRange,
      });
    } else if (!satisfiesRange(latest.version, peerRange)) {
      conflicts.push({
        type: "peer_unsatisfied",
        dependencyName: peerName,
        message: `Peer dependency "${peerName}" requires ${peerRange}, but latest available is ${latest.version}`,
        requiredRange: peerRange,
        availableVersion: latest.version,
      });
    }
  }
}

/**
 * Check if installing a set of resolved dependencies would create any
 * conflicts with already-installed packages.
 *
 * @param resolved - Newly resolved dependencies
 * @param installed - Currently installed package name→version map
 * @returns List of conflicts (empty if compatible)
 */
export function checkInstallConflicts(
  resolved: readonly FridayDependencyResolution[],
  installed: ReadonlyMap<string, string>,
): readonly FridayDependencyConflict[] {
  const conflicts: FridayDependencyConflict[] = [];

  for (const dep of resolved) {
    const installedVersion = installed.get(dep.name);
    if (installedVersion && installedVersion !== dep.resolvedVersion) {
      if (!satisfiesRange(installedVersion, dep.requestedRange)) {
        conflicts.push({
          type: "version_incompatible",
          dependencyName: dep.name,
          message: `"${dep.name}" would resolve to ${dep.resolvedVersion} but ${installedVersion} is already installed`,
          conflictingRanges: [
            { requestedBy: dep.requestedBy, range: dep.requestedRange },
            { requestedBy: "(installed)", range: `=${installedVersion}` },
          ],
        });
      }
    }
  }

  return conflicts;
}
