/**
 * Path safety utilities — prevent path traversal and directory escape attacks.
 *
 * Validates that resolved paths remain within an expected base directory.
 */

import * as fs from "node:fs";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { FridayDomainError } from "#errors";

// ─── Path containment ───

/**
 * Check if a target path is within a base directory using `path.relative`.
 * Rejects `..`, `..${path.sep}*`, and absolute relative outputs.
 */
export function isWithinBase(base: string, target: string): boolean {
  const resolvedBase = resolve(base);
  const resolvedTarget = resolve(target);
  if (resolvedTarget === resolvedBase) {
    return true;
  }
  const rel = relative(resolvedBase, resolvedTarget);
  if (!rel) {
    return true;
  }
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return false;
  }
  return true;
}

/**
 * Resolves a relative path against a base directory, ensuring the result
 * stays within the base. Rejects absolute paths and `..` traversal.
 *
 * @param base - The trusted base directory (will be resolved to absolute).
 * @param relativePath - The untrusted relative path to validate.
 * @returns The validated absolute path.
 * @throws If the path is absolute, contains traversal, or escapes the base.
 */
export function resolveSafePath(base: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new FridayDomainError(
      "PATH_ABSOLUTE_REJECTED",
      `Path must be relative, got absolute path: ${relativePath}`,
      { httpStatus: 400 },
    );
  }

  // Split on both forward and back slashes to catch Windows-style traversal
  const segments = relativePath.split(/[/\\]/);
  if (segments.includes("..")) {
    throw new FridayDomainError(
      "PATH_TRAVERSAL_REJECTED",
      `Path must not contain ".." traversal: ${relativePath}`,
      { httpStatus: 400 },
    );
  }

  const resolvedBase = resolve(base);
  const resolvedFull = resolve(resolvedBase, relativePath);

  // Use path.relative containment check
  if (!isWithinBase(resolvedBase, resolvedFull)) {
    throw new FridayDomainError(
      "PATH_ESCAPE_REJECTED",
      `Path escapes base directory: ${relativePath} (resolved to ${resolvedFull}, base is ${resolvedBase})`,
      { httpStatus: 400 },
    );
  }

  // Ancestor realpath containment: resolve the nearest existing ancestor via
  // realpath and re-check containment to catch symlink-based escapes.
  // Uses the real base path for comparison (handles symlinked base dirs like /tmp → /private/tmp).
  try {
    const realBase = fs.realpathSync(resolvedBase);
    let ancestor = resolvedFull;
    let tail = "";
    while (true) {
      try {
        const realAncestor = fs.realpathSync(ancestor);
        const realFull = tail ? join(realAncestor, tail) : realAncestor;
        if (!isWithinBase(realBase, realFull)) {
          throw new FridayDomainError(
            "PATH_ESCAPE_REJECTED",
            `Path escapes base directory (realpath): ${relativePath}`,
            { httpStatus: 400 },
          );
        }
        break;
      } catch (err) {
        if (err instanceof FridayDomainError) throw err;
        // Walk up
        const parent = dirname(ancestor);
        if (parent === ancestor) break; // reached root
        const segment = ancestor.slice(parent.length + 1);
        tail = tail ? join(segment, tail) : segment;
        ancestor = parent;
      }
    }
  } catch (err) {
    if (err instanceof FridayDomainError) throw err;
    // If realpath of base fails, we can't do the check — allow the lexical check to stand
  }

  return resolvedFull;
}

// ─── Safe file open ───

/**
 * Error codes for safe file open operations.
 */
export type FridaySafeOpenErrorKind = "invalid-path" | "not-found";

/**
 * Error thrown when `openFileWithinRoot` fails.
 * Maps errno codes to error kinds:
 * - ENOENT/ENOTDIR → "not-found"
 * - ELOOP/EINVAL/ENOTSUP/EISDIR → "invalid-path"
 */
export class FridaySafeOpenError extends Error {
  readonly kind: FridaySafeOpenErrorKind;

  constructor(kind: FridaySafeOpenErrorKind, message: string) {
    super(message);
    this.name = "FridaySafeOpenError";
    this.kind = kind;
  }

  /**
   * Map an errno code to a safe open error kind.
   */
  static kindFromErrno(code: string | undefined): FridaySafeOpenErrorKind {
    switch (code) {
      case "ENOENT":
      case "ENOTDIR":
        return "not-found";
      case "ELOOP":
      case "EINVAL":
      case "ENOTSUP":
      case "EISDIR":
        return "invalid-path";
      default:
        return "not-found";
    }
  }
}

const NOT_FOUND_CODES = new Set(["ENOENT", "ENOTDIR"]);
const SYMLINK_OPEN_CODES = new Set(["ELOOP", "EINVAL", "ENOTSUP"]);

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(err && typeof err === "object" && "code" in (err as Record<string, unknown>));
}

/**
 * Open a file within a root directory with symlink and traversal protection.
 *
 * Uses `O_NOFOLLOW` to reject symlinks at the final component (platform-aware:
 * only on non-Windows platforms). If open fails with EINVAL/ENOTSUP, retries
 * without O_NOFOLLOW and performs explicit symlink checks.
 *
 * @param params.rootDir - Trusted root directory.
 * @param params.relativePath - Untrusted relative path to the file.
 * @returns An object with the file descriptor and resolved path. Caller must close the fd.
 * @throws FridaySafeOpenError on invalid path, escape, or not-found.
 */
export function openFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
}): { fd: number; resolvedPath: string } {
  const { rootDir, relativePath } = params;

  // Reject absolute paths and traversal
  if (isAbsolute(relativePath)) {
    throw new FridaySafeOpenError("invalid-path", `Path must be relative: ${relativePath}`);
  }

  const segments = relativePath.split(/[/\\]/);
  if (segments.includes("..") || segments.includes(".")) {
    throw new FridaySafeOpenError("invalid-path", `Path contains traversal segments: ${relativePath}`);
  }

  const resolvedRoot = fs.realpathSync(rootDir);
  const resolvedFull = resolve(resolvedRoot, relativePath);

  // Use path.relative containment check
  if (!isWithinBase(resolvedRoot, resolvedFull)) {
    throw new FridaySafeOpenError("invalid-path", `Path escapes root directory: ${relativePath}`);
  }

  // Ancestor realpath containment: resolve the directory portion via realpath
  // to detect symlinks in ancestor components that could escape the root.
  const dirPortion = dirname(resolvedFull);
  try {
    const realDir = fs.realpathSync(dirPortion);
    if (!isWithinBase(resolvedRoot, realDir)) {
      throw new FridaySafeOpenError("invalid-path", `Path escapes root directory (ancestor symlink): ${relativePath}`);
    }
  } catch (err) {
    if (err instanceof FridaySafeOpenError) throw err;
    // Directory doesn't exist — walk up to nearest existing ancestor
    let ancestor = dirPortion;
    let tail = "";
    while (true) {
      try {
        const realAncestor = fs.realpathSync(ancestor);
        const realFull = tail ? join(realAncestor, tail) : realAncestor;
        if (!isWithinBase(resolvedRoot, realFull)) {
          throw new FridaySafeOpenError("invalid-path", `Path escapes root directory (ancestor symlink): ${relativePath}`);
        }
        break;
      } catch (innerErr) {
        if (innerErr instanceof FridaySafeOpenError) throw innerErr;
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        const segment = ancestor.slice(parent.length + 1);
        tail = tail ? join(segment, tail) : segment;
        ancestor = parent;
      }
    }
  }

  // Platform-aware O_NOFOLLOW: only use on non-Windows
  const supportsNoFollow = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
  const flagsWithNoFollow = fsConstants.O_RDONLY | (supportsNoFollow ? fsConstants.O_NOFOLLOW : 0);

  let fd: number;
  try {
    fd = fs.openSync(resolvedFull, flagsWithNoFollow);
  } catch (err) {
    if (isNodeError(err)) {
      const code = err.code;

      if (NOT_FOUND_CODES.has(code ?? "")) {
        throw new FridaySafeOpenError("not-found", `File not found: ${relativePath}`);
      }
      if (code === "ELOOP") {
        throw new FridaySafeOpenError("invalid-path", `Path is a symlink (rejected): ${relativePath}`);
      }
      if (code === "EISDIR") {
        throw new FridaySafeOpenError("invalid-path", `Path is a directory, not a file: ${relativePath}`);
      }

      // EINVAL/ENOTSUP: retry without O_NOFOLLOW + explicit symlink check
      if (SYMLINK_OPEN_CODES.has(code ?? "") && supportsNoFollow) {
        try {
          // Check if it's a symlink explicitly
          const lstat = fs.lstatSync(resolvedFull);
          if (lstat.isSymbolicLink()) {
            throw new FridaySafeOpenError("invalid-path", `Path is a symlink (rejected): ${relativePath}`);
          }
          // Retry without O_NOFOLLOW
          fd = fs.openSync(resolvedFull, fsConstants.O_RDONLY);
        } catch (retryErr) {
          if (retryErr instanceof FridaySafeOpenError) throw retryErr;
          const retryCode = isNodeError(retryErr) ? retryErr.code : undefined;
          throw new FridaySafeOpenError(
            FridaySafeOpenError.kindFromErrno(retryCode),
            `Cannot open file: ${relativePath} (${retryCode ?? "unknown"})`,
          );
        }
      } else {
        throw new FridaySafeOpenError(
          FridaySafeOpenError.kindFromErrno(code),
          `Cannot open file: ${relativePath} (${code})`,
        );
      }
    } else {
      throw new FridaySafeOpenError("not-found", `Cannot open file: ${relativePath}`);
    }
  }

  // Verify the opened fd: check it's a file (not a directory) and verify identity
  try {
    const fdStat = fs.fstatSync(fd);
    if (fdStat.isDirectory()) {
      fs.closeSync(fd);
      throw new FridaySafeOpenError("invalid-path", `Path is a directory, not a file: ${relativePath}`);
    }
    const fileStat = fs.statSync(resolvedFull);
    if (fdStat.ino !== fileStat.ino || fdStat.dev !== fileStat.dev) {
      fs.closeSync(fd);
      throw new FridaySafeOpenError("invalid-path", `File identity mismatch (TOCTOU): ${relativePath}`);
    }
  } catch (err) {
    if (err instanceof FridaySafeOpenError) throw err;
    fs.closeSync(fd);
    throw new FridaySafeOpenError("not-found", `Cannot verify file: ${relativePath}`);
  }

  return { fd, resolvedPath: resolvedFull };
}
