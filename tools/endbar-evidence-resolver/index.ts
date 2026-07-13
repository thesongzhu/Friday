/**
 * ENDBAR evidence-reference resolver — public API surface.
 *
 * GOV-EVIDENCE-REFERENCE-RESOLUTION-001 (P0).
 *
 * @example
 * ```ts
 * import { resolveEvidence, EvidenceResolutionError } from "./index.js";
 *
 * try {
 *   const artifact = resolveEvidence(manifest, { type: "screenshot", id: "login" });
 *   // artifact.bytes are verified against manifest.sha256
 * } catch (err) {
 *   if (err instanceof EvidenceResolutionError) {
 *     // typed, fail-closed rejection — inspect err.code
 *   }
 * }
 * ```
 */

export { resolveEvidence } from "./resolver.js";
export type {
  EvidenceManifest,
  EvidenceManifestEntry,
  ResolveOptions,
  ResolvedEvidence,
  TypedSelector,
} from "./types.js";
export {
  EvidenceArtifactUnreadableError,
  EvidenceHashMismatchError,
  EvidenceManifestInvalidError,
  EvidenceNotRegularFileError,
  EvidencePathEscapeError,
  EvidenceReferenceCycleError,
  EvidenceResolutionError,
  EvidenceSelectorAmbiguousError,
  EvidenceSelectorDanglingError,
  EvidenceSymlinkRejectedError,
} from "./errors.js";
export type { EvidenceErrorCode } from "./errors.js";
