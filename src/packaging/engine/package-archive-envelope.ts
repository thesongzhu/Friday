/**
 * Helpers for the JSON package archive envelope accepted by the opt-in
 * `/v1/packages` publish route.
 *
 * The package signature model says the archive digest covers package contents
 * excluding the signature file.  The envelope mirrors that by hashing the
 * canonical `{ manifest, files }` payload and never the `signature` object.
 */

import * as crypto from "node:crypto";

import { FridayDomainError } from "../../errors/friday-domain-error.js";
import { parseManifestJson } from "./manifest-parser.js";
import type {
  FridayPackageManifest,
  FridayPackageSignature,
} from "../model/friday-packaging.types.js";

export interface FridayPackageArchiveEnvelope {
  readonly manifest: FridayPackageManifest;
  readonly signature: FridayPackageSignature;
  readonly files?: Record<string, string>;
}

export interface DecodedFridayPackageArchiveEnvelope {
  readonly manifest: FridayPackageManifest;
  readonly signature: FridayPackageSignature;
  readonly files: Record<string, string>;
  readonly manifestDigest: string;
  readonly archiveDigest: string;
  readonly archiveSizeBytes: number;
}

function sha256Digest(content: string | Buffer): string {
  return "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
}

function stableCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableCanonicalJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableCanonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function computeFridayPackageManifestDigest(manifest: FridayPackageManifest): string {
  return sha256Digest(JSON.stringify(manifest));
}

export function computeFridayPackageArchiveDigest(input: {
  readonly manifest: FridayPackageManifest;
  readonly files?: Record<string, string>;
}): string {
  return sha256Digest(stableCanonicalJson({
    files: input.files ?? {},
    manifest: input.manifest,
  }));
}

export function decodeFridayPackageArchiveEnvelope(
  archive: string,
): DecodedFridayPackageArchiveEnvelope {
  let archiveBuffer: Buffer;
  try {
    archiveBuffer = Buffer.from(archive, "base64");
  } catch (e) {
    throw new FridayDomainError("VALIDATION_ERROR", `Archive is not valid base64: ${(e as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(archiveBuffer.toString("utf8"));
  } catch (e) {
    throw new FridayDomainError("VALIDATION_ERROR", `Archive must contain JSON envelope with manifest and signature: ${(e as Error).message}`);
  }

  const envelope = parsed as Partial<FridayPackageArchiveEnvelope>;
  if (!envelope || typeof envelope !== "object" || !envelope.manifest || !envelope.signature) {
    throw new FridayDomainError("VALIDATION_ERROR", "Archive envelope must include manifest and signature");
  }
  if (envelope.files !== undefined && (typeof envelope.files !== "object" || envelope.files === null || Array.isArray(envelope.files))) {
    throw new FridayDomainError("VALIDATION_ERROR", "Archive envelope files must be an object when provided");
  }

  const parseResult = parseManifestJson(JSON.stringify(envelope.manifest));
  if (!parseResult.success || !parseResult.manifest) {
    throw new FridayDomainError("VALIDATION_ERROR", `Invalid manifest: ${parseResult.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  }

  const manifest = parseResult.manifest;
  const files = envelope.files ?? {};
  return {
    manifest,
    signature: envelope.signature,
    files,
    manifestDigest: computeFridayPackageManifestDigest(manifest),
    archiveDigest: computeFridayPackageArchiveDigest({ manifest, files }),
    archiveSizeBytes: archiveBuffer.length,
  };
}
