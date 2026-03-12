/**
 * Safe install directory authority — single source of truth for install path
 * resolution, ID validation, and containment checks.
 *
 * All installers (skill package, import, generator) should use this module
 * for consistent path safety. Re-exported from `#utilities` for convenience.
 *
 * Security properties:
 *   - Pre-resolution ID validation rejects traversal, reserved segments, and
 *     dangerous characters before any path operations.
 *   - Containment check uses `path.relative` + `path.isAbsolute`, not string prefix.
 *   - Windows-style backslash separators are normalized.
 *   - Scoped package names (`@scope/name`) are preserved.
 *   - Version suffixes (e.g., `1.0.0-beta.1`) are allowed.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

import { FridayDomainError } from "#errors";

// ─── Policy options ───

export interface FridaySafeInstallPolicy {
  /**
   * Maximum length for a normalized ID.
   * Default: 214 (npm package name limit).
   */
  maxLength?: number;
  /**
   * Whether to allow scoped package names (`@scope/name`).
   * Default: true.
   */
  allowScoped?: boolean;
}

const DEFAULT_MAX_LENGTH = 214;

// ─── Unsafe character pattern ───

/**
 * Pattern matching unsafe characters in directory names.
 * Allows alphanumeric, hyphens, underscores, dots, and `@`/`/` for scoped npm packages.
 * Strips everything else.
 */
const UNSAFE_DIR_CHARS_RE = /[^a-zA-Z0-9._@/-]/g;

/**
 * Reserved path segments that must not appear as the entire ID.
 */
const RESERVED_SEGMENTS = new Set([".", "..", "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"]);

// ─── Normalize ───

/**
 * Normalize an install ID: trim, lowercase, strip null bytes, normalize
 * backslash separators to forward slashes.
 */
export function normalizeInstallId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/\0/g, "")
    .replace(/\\/g, "/");
}

// ─── Validate ───

/**
 * Validate an install ID. Returns null if valid, or an error message string if invalid.
 *
 * Checks:
 *   - Non-empty after normalization
 *   - No reserved path segments (`.`, `..`, Windows device names)
 *   - No path traversal (`..` anywhere)
 *   - Length within limits
 *   - No absolute paths
 */
export function validateInstallId(
  id: string,
  policy?: FridaySafeInstallPolicy,
): string | null {
  const normalized = normalizeInstallId(id);
  const maxLength = policy?.maxLength ?? DEFAULT_MAX_LENGTH;

  if (!normalized) {
    return "invalid install ID: empty after normalization";
  }

  if (normalized.length > maxLength) {
    return `invalid install ID: exceeds maximum length of ${maxLength}`;
  }

  // Reject spaces — disallowed in package names / versions
  if (/\s/.test(normalized)) {
    return "invalid install ID: disallowed characters (spaces)";
  }

  // Check for absolute paths
  if (isAbsolute(normalized) || normalized.startsWith("/")) {
    return "invalid install ID: absolute path not allowed";
  }

  // Check for traversal
  if (normalized.includes("..")) {
    return "invalid install ID: disallowed path traversal";
  }

  // Reject slashes unless this is a scoped package (@scope/name — exactly one slash)
  if (normalized.includes("/")) {
    if (!normalized.startsWith("@") || normalized.indexOf("/") !== normalized.lastIndexOf("/")) {
      return "invalid install ID: disallowed characters (slashes)";
    }
  }

  // Check each segment for reserved names (strip extensions for Windows safety)
  const segments = normalized.split("/");
  for (const segment of segments) {
    const stem = segment.includes(".") ? segment.slice(0, segment.indexOf(".")) : segment;
    if (RESERVED_SEGMENTS.has(stem) || RESERVED_SEGMENTS.has(segment)) {
      return `invalid install ID: reserved path segment '${segment}'`;
    }
  }

  // Check scope format if present
  if (normalized.startsWith("@")) {
    if (policy?.allowScoped === false) {
      return "invalid install ID: scoped packages not allowed";
    }
    if (!normalized.includes("/")) {
      return "invalid install ID: scoped package must have format @scope/name";
    }
    const [scopePart, namePart] = normalized.split("/");
    // scopePart must be more than just "@", and namePart must be non-empty
    if (!scopePart || scopePart === "@" || !namePart) {
      return "invalid install ID: scoped package must have format @scope/name";
    }
  }

  return null;
}

// ─── Safe directory name ───

/**
 * Sanitize an arbitrary string into a safe directory name.
 *
 * - Strips null bytes and control characters
 * - Normalizes backslash separators
 * - Collapses consecutive separators
 * - Removes leading dots (prevents hidden dirs / traversal)
 * - Removes trailing dots and spaces
 *
 * @param name - Untrusted input (e.g. skill ID, plugin ID).
 * @returns Sanitized directory name safe for filesystem use.
 * @throws FridayDomainError if the sanitized result is empty.
 */
export function safeDirName(name: string): string {
  // Strip null bytes first
  let safe = name.replace(/\0/g, "");

  // Normalize backslash separators
  safe = safe.replace(/\\/g, "/");

  // Replace unsafe chars
  safe = safe.replace(UNSAFE_DIR_CHARS_RE, "-");

  // Collapse consecutive slashes/hyphens
  safe = safe.replace(/\/{2,}/g, "/").replace(/-{2,}/g, "-");

  // Remove leading dots and slashes to prevent hidden dirs / root-relative paths
  safe = safe.replace(/^[./]+/, "");

  // Remove trailing dots, hyphens, and spaces
  safe = safe.replace(/[. -]+$/, "");

  // Block ".." sequences
  safe = safe.replace(/\.\./g, "");

  if (safe.length === 0) {
    throw new FridayDomainError(
      "INSTALL_INVALID_NAME",
      `Cannot derive a safe directory name from: ${JSON.stringify(name)}`,
      { httpStatus: 400 },
    );
  }

  return safe;
}

// ─── Resolve safe install directory ───

/**
 * Resolve a safe install directory within a base directory.
 * Uses `path.relative` + `path.isAbsolute` for containment instead of string prefix checks.
 *
 * @param baseDir - Trusted base directory (e.g. managed-skills dir, plugins dir).
 * @param name - Untrusted directory name to sanitize and resolve.
 * @returns Absolute path guaranteed to be within `baseDir`.
 * @throws FridayDomainError if the name is invalid or the result escapes the base.
 */
export function resolveSafeInstallDir(baseDir: string, name: string): string {
  const sanitized = safeDirName(name);
  const resolvedBase = resolve(baseDir);
  const resolvedFull = resolve(resolvedBase, sanitized);

  // Use path.relative containment check
  const rel = relative(resolvedBase, resolvedFull);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new FridayDomainError(
      "INSTALL_PATH_ESCAPE",
      `Install path escapes base directory: ${sanitized} (resolved to ${resolvedFull}, base is ${resolvedBase})`,
      { httpStatus: 400 },
    );
  }

  return resolvedFull;
}
