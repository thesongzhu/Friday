/**
 * Public types for the ENDBAR evidence-reference resolver.
 *
 * GOV-EVIDENCE-REFERENCE-RESOLUTION-001 (P0).
 *
 * A resolver maps a typed selector reference to EXACTLY ONE on-disk evidence
 * artifact and returns its cryptographically verified content — or throws a
 * typed rejection. See {@link ./errors} for the failure taxonomy.
 */

/**
 * A typed selector reference. Both fields participate in identity: an evidence
 * artifact is addressed by the pair `(type, id)`, never by path.
 */
export interface TypedSelector {
  /** Selector namespace, e.g. `"screenshot"`, `"ci-log"`, `"attestation"`. */
  readonly type: string;
  /** Selector identity within its `type`, e.g. `"login-flow"`. */
  readonly id: string;
}

/**
 * One manifest entry. An entry is EITHER a terminal artifact (`path` + `sha256`)
 * OR an alias (`ref`) that points at another selector. An entry that is both, or
 * neither, is rejected as an invalid manifest.
 */
export interface EvidenceManifestEntry {
  /** Selector namespace this entry answers for. */
  readonly type: string;
  /** Selector identity this entry answers for. */
  readonly id: string;
  /** Repo-relative path of the artifact, relative to {@link EvidenceManifest.root}. */
  readonly path?: string;
  /** Expected lowercase-hex sha256 of the artifact bytes. */
  readonly sha256?: string;
  /** Alias target: resolving this entry continues from the referenced selector. */
  readonly ref?: TypedSelector;
}

/** An evidence manifest: a fixed root plus the set of addressable entries. */
export interface EvidenceManifest {
  /** Absolute path to the evidence root. All artifact paths resolve under it. */
  readonly root: string;
  /** The addressable entries. */
  readonly entries: readonly EvidenceManifestEntry[];
}

/** A successfully resolved + verified evidence artifact. */
export interface ResolvedEvidence {
  /** The terminal selector that addressed the artifact (after alias following). */
  readonly selector: TypedSelector;
  /** The terminal manifest entry that was resolved. */
  readonly entry: EvidenceManifestEntry;
  /** The absolute path that was actually opened (guaranteed inside root). */
  readonly realPath: string;
  /** The verified lowercase-hex sha256 of the bytes that were read. */
  readonly sha256: string;
  /** The verified artifact bytes (hashed from the same fd they were read from). */
  readonly bytes: Buffer;
}

/** Optional resolver knobs. */
export interface ResolveOptions {
  /** Backstop on alias-chain length before a cycle rejection. Default 64. */
  readonly maxRefDepth?: number;
}
