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
  headers: Record<string, string | undefined>,
): string | undefined {
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
