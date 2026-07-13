/**
 * Hardened evidence-reference resolver.
 *
 * GOV-EVIDENCE-REFERENCE-RESOLUTION-001 (P0).
 *
 * Resolves a typed selector to EXACTLY ONE on-disk evidence artifact and returns
 * its cryptographically verified content, or throws a typed rejection. It FAILS
 * CLOSED -- it never returns unverified bytes.
 *
 * Hardening controls (each with a matching negative control test):
 *  1. Path-traversal containment -- resolve+normalize against a fixed root and
 *     reject anything that escapes it (`..`, absolute, normalized-out).
 *  2. No symlink following -- reject a symlink at ANY path component below root
 *     (lstat walk) and open the final component with `O_NOFOLLOW`.
 *  3. Open-once / no TOCTOU -- open the file ONCE to a stable fd, then `fstat`
 *     and read+hash from THAT SAME fd; never re-open by path.
 *  4. Content-hash verification -- sha256 of the read bytes must equal the
 *     manifest's expected hash (constant-time compare).
 *  5. Single typed-selector resolution -- a selector must match exactly one
 *     entry; duplicates reject (ambiguous), no match rejects (dangling).
 *  6. Cycle & ambiguity rejection -- an alias cycle terminates with a typed
 *     rejection instead of looping / overflowing the stack.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { isAbsolute, resolve as resolvePath, sep } from "node:path";
import {
  EvidenceArtifactUnreadableError,
  EvidenceHashMismatchError,
  EvidenceManifestInvalidError,
  EvidenceNotRegularFileError,
  EvidencePathEscapeError,
  EvidenceReferenceCycleError,
  EvidenceSelectorAmbiguousError,
  EvidenceSelectorDanglingError,
  EvidenceSymlinkRejectedError,
} from "./errors.js";
import type {
  EvidenceManifest,
  EvidenceManifestEntry,
  ResolvedEvidence,
  ResolveOptions,
  TypedSelector,
} from "./types.js";

const DEFAULT_MAX_REF_DEPTH = 64;
const HASH_HEX_RE = /^[0-9a-f]{64}$/;
const READ_CHUNK = 64 * 1024;

/** Collision-resistant, pure-ASCII identity key for a typed selector. */
function selectorKey(s: TypedSelector): string {
  return JSON.stringify([s.type, s.id]);
}

function selectorLabel(s: TypedSelector): string {
  return `${s.type}:${s.id}`;
}

/** Enforce exactly-one matching entry (control 5). */
function findUnique(
  manifest: EvidenceManifest,
  selector: TypedSelector,
): EvidenceManifestEntry {
  const matches = manifest.entries.filter(
    (e) => e.type === selector.type && e.id === selector.id,
  );
  if (matches.length === 0) {
    throw new EvidenceSelectorDanglingError(
      `no manifest entry for selector ${selectorLabel(selector)}`,
    );
  }
  if (matches.length > 1) {
    throw new EvidenceSelectorAmbiguousError(
      `selector ${selectorLabel(selector)} matches ${matches.length} entries`,
    );
  }
  return matches[0];
}

/** Reject a symlink at any path component strictly below root (control 2). */
function assertNoSymlinkComponents(root: string, abs: string): void {
  const rel = abs.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const part of rel) {
    current = resolvePath(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      // Component missing/unreadable: let the single open() below fail closed.
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new EvidenceSymlinkRejectedError(
        `symlink component rejected at ${current}`,
      );
    }
  }
}

/** Constant-time compare of two equal-length lowercase hex digests. */
function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Read the entire file sequentially from a single open fd (control 3). */
function readAllFromFd(fd: number): Buffer {
  const chunks: Buffer[] = [];
  const buf = Buffer.allocUnsafe(READ_CHUNK);
  for (;;) {
    // position=null -> sequential read from the fd's own offset; never re-opens.
    const bytesRead = readSync(fd, buf, 0, buf.length, null);
    if (bytesRead <= 0) {
      break;
    }
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks);
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/** Contain the path, open once, fstat + hash from the same fd (controls 1-4). */
function openAndVerify(
  root: string,
  entry: EvidenceManifestEntry,
  selector: TypedSelector,
): ResolvedEvidence {
  if (typeof entry.path !== "string" || entry.path.length === 0) {
    throw new EvidenceManifestInvalidError(
      `terminal entry ${selectorLabel(selector)} is missing a path`,
    );
  }
  const expected = (entry.sha256 ?? "").toLowerCase();
  if (!HASH_HEX_RE.test(expected)) {
    throw new EvidenceManifestInvalidError(
      `terminal entry ${selectorLabel(selector)} has an invalid sha256`,
    );
  }

  // Control 1: path-traversal containment.
  if (isAbsolute(entry.path)) {
    throw new EvidencePathEscapeError(
      `absolute path rejected for ${selectorLabel(selector)}`,
    );
  }
  const abs = resolvePath(root, entry.path);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new EvidencePathEscapeError(
      `path escapes evidence root for ${selectorLabel(selector)}`,
    );
  }

  // Control 2: no symlink component below root.
  assertNoSymlinkComponents(root, abs);

  // Controls 2-4: open ONCE (O_NOFOLLOW), fstat + read + hash from that fd.
  let fd: number | undefined;
  try {
    fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    if (isErrnoException(err) && err.code === "ELOOP") {
      throw new EvidenceSymlinkRejectedError(
        `symlink final component rejected at ${abs}`,
      );
    }
    throw new EvidenceArtifactUnreadableError(
      `cannot open artifact for ${selectorLabel(selector)}: ${
        isErrnoException(err) ? err.code : "unknown"
      }`,
    );
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new EvidenceNotRegularFileError(
        `artifact for ${selectorLabel(selector)} is not a regular file`,
      );
    }
    const bytes = readAllFromFd(fd);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (!hexEqual(actual, expected)) {
      throw new EvidenceHashMismatchError(
        `sha256 mismatch for ${selectorLabel(selector)}: expected ${expected}, got ${actual}`,
      );
    }
    return { selector, entry, realPath: abs, sha256: actual, bytes };
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolve a typed selector to a single verified evidence artifact.
 *
 * @throws {@link EvidenceResolutionError} (fail-closed) on any control failure.
 */
export function resolveEvidence(
  manifest: EvidenceManifest,
  selector: TypedSelector,
  options?: ResolveOptions,
): ResolvedEvidence {
  const maxDepth = options?.maxRefDepth ?? DEFAULT_MAX_REF_DEPTH;
  const root = resolvePath(manifest.root);
  const seen = new Set<string>();

  let current = selector;
  for (let depth = 0; depth <= maxDepth; depth++) {
    const key = selectorKey(current);
    if (seen.has(key)) {
      throw new EvidenceReferenceCycleError(
        `alias cycle detected at ${selectorLabel(current)}`,
      );
    }
    seen.add(key);

    const entry = findUnique(manifest, current);
    if (entry.ref !== undefined) {
      if (entry.path !== undefined || entry.sha256 !== undefined) {
        throw new EvidenceManifestInvalidError(
          `entry ${selectorLabel(current)} is both an alias and a terminal artifact`,
        );
      }
      current = entry.ref;
      continue;
    }
    return openAndVerify(root, entry, current);
  }

  throw new EvidenceReferenceCycleError(
    `alias chain exceeded max depth ${maxDepth}`,
  );
}
