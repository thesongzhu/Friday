/**
 * ⚠️ DELIBERATELY NAIVE / INSECURE BASELINE — RED-FIRST PHASE ONLY. ⚠️
 *
 * This is the naive first implementation used to prove the negative-control
 * test matrix is RED *behaviorally* (the resolver returns content / follows the
 * symlink / recurses without bound) before the hardened resolver replaces it.
 *
 * DO NOT SHIP. It has NO path-traversal containment, NO symlink guard, NO
 * open-once/TOCTOU discipline, NO hash verification, NO ambiguity/dangling
 * rejection, and NO cycle guard. It is overwritten by the hardened resolver in
 * the GREEN commit.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  EvidenceManifest,
  ResolveOptions,
  ResolvedEvidence,
  TypedSelector,
} from "./types.js";

export function resolveEvidence(
  manifest: EvidenceManifest,
  selector: TypedSelector,
  _options?: ResolveOptions,
): ResolvedEvidence {
  // No ambiguity check: take the first match. No dangling check: silently fall
  // back to the first entry, so a dangling selector resolves to SOME artifact.
  const entry =
    manifest.entries.find(
      (e) => e.type === selector.type && e.id === selector.id,
    ) ?? manifest.entries[0];

  // No cycle guard: follow aliases recursively until the stack overflows.
  if (entry.ref) {
    return resolveEvidence(manifest, entry.ref, _options);
  }

  // No traversal containment, no symlink guard, no open-once, no hash check:
  // just join and read whatever is on disk.
  const abs = join(manifest.root, entry.path ?? "");
  const bytes = readFileSync(abs);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { selector, entry, realPath: abs, sha256, bytes };
}
