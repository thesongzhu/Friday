/**
 * Typed failure taxonomy for the ENDBAR evidence-reference resolver.
 *
 * Every rejection is an instance of {@link EvidenceResolutionError} carrying a
 * stable, machine-readable `code`. The resolver FAILS CLOSED: it never returns
 * unverified content, so any non-success outcome is one of these throws.
 *
 * The first six codes are the required hardening controls. The remaining three
 * are defensive extras that keep every other failure mode typed and fail-closed
 * (malformed manifest, non-regular file, unreadable artifact) rather than
 * surfacing a raw errno.
 */

export type EvidenceErrorCode =
  // ── Required hardening controls ──
  | "EVIDENCE_PATH_ESCAPE"
  | "EVIDENCE_SYMLINK_REJECTED"
  | "EVIDENCE_HASH_MISMATCH"
  | "EVIDENCE_SELECTOR_AMBIGUOUS"
  | "EVIDENCE_SELECTOR_DANGLING"
  | "EVIDENCE_REFERENCE_CYCLE"
  // ── Defensive extras (still typed, still fail-closed) ──
  | "EVIDENCE_MANIFEST_INVALID"
  | "EVIDENCE_NOT_REGULAR_FILE"
  | "EVIDENCE_ARTIFACT_UNREADABLE";

/** Base class for every typed evidence-resolution rejection. */
export abstract class EvidenceResolutionError extends Error {
  /** Stable machine-readable failure code. */
  abstract readonly code: EvidenceErrorCode;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A path escaped the fixed evidence root (`..`, absolute, or normalized-out). */
export class EvidencePathEscapeError extends EvidenceResolutionError {
  readonly code = "EVIDENCE_PATH_ESCAPE";
}

/** A symlink component was encountered anywhere in the resolved path. */
export class EvidenceSymlinkRejectedError extends EvidenceResolutionError {
  readonly code = "EVIDENCE_SYMLINK_REJECTED";
}

/** The bytes read did not match the manifest's expected sha256. */
export class EvidenceHashMismatchError extends EvidenceResolutionError {
  readonly code = "EVIDENCE_HASH_MISMATCH";
}

/** A selector matched more than one manifest entry. */
export class EvidenceSelectorAmbiguousError extends EvidenceResolutionError {
  readonly code = "EVIDENCE_SELECTOR_AMBIGUOUS";
}

/** A selector matched no manifest entry. */
export class EvidenceSelectorDanglingError extends EvidenceResolutionError {
  readonly code = "EVIDENCE_SELECTOR_DANGLING";
}

/** The alias chain formed a cycle (or exceeded the depth backstop). */
export class EvidenceReferenceCycleError extends EvidenceResolutionError {
  readonly code = "EVIDENCE_REFERENCE_CYCLE";
}

/** A manifest entry was neither a valid terminal artifact nor a valid alias. */
export class EvidenceManifestInvalidError extends EvidenceResolutionError {
  readonly code = "EVIDENCE_MANIFEST_INVALID";
}

/** The resolved path was not a regular file (dir, fifo, device, ...). */
export class EvidenceNotRegularFileError extends EvidenceResolutionError {
  readonly code = "EVIDENCE_NOT_REGULAR_FILE";
}

/** The artifact could not be opened/read (missing, permission, ...). */
export class EvidenceArtifactUnreadableError extends EvidenceResolutionError {
  readonly code = "EVIDENCE_ARTIFACT_UNREADABLE";
}
