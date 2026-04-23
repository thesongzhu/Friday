import * as crypto from "node:crypto";

import { FridayDomainError } from "#errors";

export interface FridayEphemeralSecretHandle {
  handleId: string;
  expiresAtMs: number;
  metadata?: Record<string, string | undefined>;
}

export interface FridayEphemeralSecretHandleRegistry {
  issue(value: string, metadata?: Record<string, string | undefined>): FridayEphemeralSecretHandle;
  use<T>(
    handleId: string,
    consumer: (credential: string) => T | Promise<T>,
  ): Promise<T>;
  revoke(handleId: string): boolean;
  size(): number;
}

export interface CreateFridayEphemeralSecretHandleRegistryDeps {
  nowMs?: () => number;
  idGenerator?: () => string;
  ttlMs?: number;
}

interface FridaySecretHandleEntry {
  material: Buffer;
  expiresAtMs: number;
  metadata?: Record<string, string | undefined>;
}

const DEFAULT_HANDLE_TTL_MS = 30_000;

function zeroize(entry: FridaySecretHandleEntry): void {
  entry.material.fill(0);
}

export function createFridayEphemeralSecretHandleRegistry(
  deps: CreateFridayEphemeralSecretHandleRegistryDeps = {},
): FridayEphemeralSecretHandleRegistry {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
  const ttlMs = deps.ttlMs ?? DEFAULT_HANDLE_TTL_MS;
  const handles = new Map<string, FridaySecretHandleEntry>();

  function revoke(handleId: string): boolean {
    const entry = handles.get(handleId);
    if (!entry) return false;
    zeroize(entry);
    handles.delete(handleId);
    return true;
  }

  function pruneExpired(): void {
    const now = nowMs();
    for (const [handleId, entry] of handles.entries()) {
      if (entry.expiresAtMs <= now) {
        revoke(handleId);
      }
    }
  }

  return {
    issue(value, metadata) {
      pruneExpired();
      const handleId = idGenerator();
      const expiresAtMs = nowMs() + ttlMs;
      handles.set(handleId, {
        material: Buffer.from(value, "utf8"),
        expiresAtMs,
        ...(metadata ? { metadata: { ...metadata } } : {}),
      });
      return {
        handleId,
        expiresAtMs,
        ...(metadata ? { metadata: { ...metadata } } : {}),
      };
    },

    async use(handleId, consumer) {
      const entry = handles.get(handleId);
      if (!entry) {
        throw new FridayDomainError(
          "SECRET_HANDLE_NOT_FOUND",
          "Ephemeral secret handle was not found or was already consumed",
          { httpStatus: 401 },
        );
      }
      handles.delete(handleId);
      if (entry.expiresAtMs <= nowMs()) {
        zeroize(entry);
        throw new FridayDomainError(
          "SECRET_HANDLE_EXPIRED",
          "Ephemeral secret handle expired before use",
          { httpStatus: 401 },
        );
      }
      const credential = entry.material.toString("utf8");
      try {
        return await consumer(credential);
      } finally {
        zeroize(entry);
      }
    },

    revoke,

    size() {
      pruneExpired();
      return handles.size;
    },
  };
}
