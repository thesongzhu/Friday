import * as path from "node:path";
import * as fs from "node:fs";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type { FridaySkillValidationIssue } from "./friday-skill-validation.types.js";

export interface ValidateFridayFilesystemScopeOptions {
  scope: string;
  skillDir: string;
  workspaceDir: string;
  absoluteAllowPrefixes?: string[];
}

export interface FridayFilesystemScopeValidationResult {
  ok: boolean;
  resolvedPath?: string;
  reason?: string;
}

/**
 * Allowed root prefixes for filesystem scopes.
 * Only paths under these roots are valid. Per §2.3.1.
 */
function getAllowedScopeRoots(
  workspaceDir: string,
  skillDir: string,
  absoluteAllowPrefixes: string[] = [],
): string[] {
  const roots: string[] = [];

  // Add canonicalized workspace and skill dirs
  try {
    roots.push(fs.realpathSync(workspaceDir));
  } catch (err) {
    console.warn("[friday][skill-filesystem-scope-validator] operation failed:", err instanceof Error ? err.message : String(err));
    roots.push(path.resolve(workspaceDir));
  }

  try {
    roots.push(fs.realpathSync(skillDir));
  } catch (err) {
    console.warn("[friday][skill-filesystem-scope-validator] operation failed:", err instanceof Error ? err.message : String(err));
    roots.push(path.resolve(skillDir));
  }

  // Add explicit allow prefixes
  for (const prefix of absoluteAllowPrefixes) {
    try {
      roots.push(fs.realpathSync(prefix));
    } catch (err) {
    console.warn("[friday][skill-filesystem-scope-validator] operation failed:", err instanceof Error ? err.message : String(err));
      roots.push(path.resolve(prefix));
    }
  }

  return roots;
}

/** Validates one filesystem scope with canonicalization + containment checks per §2.3.1. */
export function validateFridayFilesystemScope(
  options: ValidateFridayFilesystemScopeOptions,
): FridayFilesystemScopeValidationResult {
  const { scope, skillDir, workspaceDir, absoluteAllowPrefixes = [] } = options;

  // 1. Reject absolute paths outright (must be relative or use ${workspaceDir})
  if (path.isAbsolute(scope) && !scope.startsWith("${workspaceDir}")) {
    // Check if it's within allowed scope roots directly
    const allowedRoots = getAllowedScopeRoots(workspaceDir, skillDir, absoluteAllowPrefixes);
    const resolvedPath = path.resolve(scope);

    let canonical: string;
    try {
      canonical = fs.realpathSync(resolvedPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        canonical = resolvedPath;
      } else {
        return {
          ok: false,
          reason: `Cannot resolve scope path: ${scope}`,
        };
      }
    }

    const isContained = allowedRoots.some((root) => {
      const rel = path.relative(root, canonical);
      return !rel.startsWith("..") && !path.isAbsolute(rel);
    });

    if (!isContained) {
      return {
        ok: false,
        resolvedPath: canonical,
        reason: `Scope resolves outside allowed boundaries: ${canonical}`,
      };
    }

    return { ok: true, resolvedPath: canonical };
  }

  // 2. Resolve variables and relative paths against skill directory (not CWD)
  const resolved = scope.startsWith("${workspaceDir}")
    ? scope.replace("${workspaceDir}", workspaceDir)
    : path.join(skillDir, scope);

  // 3. Strip glob suffixes, canonicalize to real path (resolves symlinks and ../ traversals)
  const globStripped = resolved.replace(/[/*]+$/, "") || resolved;
  const resolvedPath = path.resolve(globStripped);

  let canonical: string;
  try {
    canonical = fs.realpathSync(resolvedPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      canonical = resolvedPath;
    } else {
      return {
        ok: false,
        reason: `Cannot resolve scope path: ${scope}`,
      };
    }
  }

  // 4. Verify containment using path.relative per §2.3.1
  const allowedRoots = getAllowedScopeRoots(workspaceDir, skillDir, absoluteAllowPrefixes);
  const isContained = allowedRoots.some((root) => {
    const rel = path.relative(root, canonical);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  });

  if (!isContained) {
    return {
      ok: false,
      resolvedPath: canonical,
      reason: `Scope resolves outside allowed boundaries: ${canonical}`,
    };
  }

  return { ok: true, resolvedPath: canonical };
}

/** Validates all filesystem selector scopes in manifest permissions. */
export function validateFridayManifestFilesystemScopes(
  manifest: SkillManifestV2,
  skillDir: string,
  workspaceDir: string,
): FridaySkillValidationIssue[] {
  const issues: FridaySkillValidationIssue[] = [];

  for (const grant of manifest.permissions.grants) {
    if (grant.resource !== "filesystem" || !grant.selectors?.pathPrefixes) {
      continue;
    }

    for (const scope of grant.selectors.pathPrefixes) {
      const result = validateFridayFilesystemScope({
        scope,
        skillDir,
        workspaceDir,
      });

      if (!result.ok) {
        issues.push({
          stage: "filesystem-scope",
          severity: "error",
          code: "FILESYSTEM_SCOPE_VIOLATION",
          message: result.reason!,
          path: `permissions.grants[${grant.id}].selectors.pathPrefixes`,
        });
      }
    }
  }

  return issues;
}
