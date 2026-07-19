import { createHash } from "node:crypto";

import { FridayDomainError } from "#errors";

export interface FridayApiRequestIdempotencyMetadata {
  operationId: string;
  idempotencyKey: string;
  payloadHash: string;
  receivedAt: string;
  principalId?: string;
}

function canonicalizeIdempotencyPayload(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeIdempotencyPayload(entry));
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => [key, canonicalizeIdempotencyPayload(entryValue)] as const);

  return Object.fromEntries(entries);
}

export function hashIdempotencyPayload(payload: unknown): string {
  const canonicalPayload = canonicalizeIdempotencyPayload(payload);
  const serializedPayload = JSON.stringify(canonicalPayload) ?? "null";
  return createHash("sha256").update(serializedPayload).digest("hex");
}

export function readIdempotencyKeyHeader(
  headers?: Record<string, string | undefined> | null,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const raw = headers["idempotency-key"];
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function readStoredIdempotencyPayloadHash(
  metadata: { apiRequest?: unknown } | undefined,
): string | undefined {
  if (!metadata) {
    return undefined;
  }
  const apiRequest = metadata.apiRequest;
  if (!apiRequest || typeof apiRequest !== "object" || Array.isArray(apiRequest)) {
    return undefined;
  }
  const payloadHash = (apiRequest as { payloadHash?: unknown }).payloadHash;
  return typeof payloadHash === "string" && payloadHash.trim().length > 0
    ? payloadHash.trim()
    : undefined;
}

export function throwIdempotencyConflict(
  key: string,
  operationId: string,
): never {
  throw new FridayDomainError(
    "SECURITY_IDEMPOTENCY_KEY_CONFLICT",
    `Idempotency-Key '${key}' was already used with a different payload for operation '${operationId}'.`,
    { httpStatus: 409 },
  );
}

/** What a caller must do to the persisted store after {@link reconcileLegacyBackfillDigest}. */
export type FridayLegacyDigestReconcileOutcome =
  /** No pre-existing row — proceed with the normal INSERT (which stamps the digest). */
  | "insert"
  /** Pre-existing LEGACY row (NULL digest) whose identity matches — BACKFILL the digest onto it. */
  | "backfill"
  /** Pre-existing row whose digest already matches — idempotent no-op; do not re-stamp. */
  | "match";

/**
 * The SINGLE cross-store rule for reconciling a digest-bearing write against a pre-existing row,
 * INCLUDING legacy rows written before the v100 migration added the (nullable) `payload_digest`
 * column. Every cross-store idempotency site (HTTP journal, Rust continuity projector, satellite
 * outbox) routes through this one primitive so their legacy handling can never drift apart.
 *
 * A legacy row has no stored digest to compare against, so this must NEVER blindly stamp the
 * incoming digest — that would LAUNDER a divergent write (same key reused for a DIFFERENT identity)
 * into "the canonical digest". Instead the caller supplies a `contentIdentity` recomputed
 * SYMMETRICALLY over the row's persisted columns and over the incoming write's values; equality
 * proves the incoming write reproduces the bytes ALREADY PERSISTED. Decisions:
 *   - no existing row              → `insert` (caller's INSERT stamps the digest).
 *   - legacy NULL + identity MATCH → `backfill` (caller stamps the digest first-write-only).
 *   - legacy NULL + identity DIFF  → throwIdempotencyConflict (genuine divergence; nothing stamped).
 *   - non-null digest match        → `match` (idempotent no-op).
 *   - non-null digest mismatch     → throwIdempotencyConflict.
 * The throw is raised BEFORE any stamp so the caller's transaction rolls back divergence
 * data-loss-free (the existing row is preserved).
 */
export function reconcileLegacyBackfillDigest(params: {
  existing: { payloadDigest: string | null; contentIdentity: string } | undefined;
  incomingDigest: string;
  incomingContentIdentity: string;
  conflictKey: string;
  conflictOperationId: string;
}): FridayLegacyDigestReconcileOutcome {
  const { existing } = params;
  if (!existing) {
    return "insert";
  }
  if (existing.payloadDigest === null) {
    if (existing.contentIdentity !== params.incomingContentIdentity) {
      throwIdempotencyConflict(params.conflictKey, params.conflictOperationId);
    }
    return "backfill";
  }
  if (existing.payloadDigest !== params.incomingDigest) {
    throwIdempotencyConflict(params.conflictKey, params.conflictOperationId);
  }
  return "match";
}
