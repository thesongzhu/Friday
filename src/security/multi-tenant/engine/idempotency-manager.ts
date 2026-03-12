/**
 * Tenant-scoped idempotency key manager.
 *
 * Tracks idempotency keys with composite scope: (principalId, tenantId, operationId, key).
 * Prevents cross-tenant idempotency collisions (SEC-FIX-R5-02).
 *
 * @module security/multi-tenant/engine/idempotency-manager
 */

import { createHash } from "node:crypto";

import type { UUID } from "../model/friday-multi-tenant-security.types.js";

import {
  FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES,
  FRIDAY_SECURITY_IDEMPOTENCY_TTL_HOURS,
} from "../api/friday-multi-tenant-security-api.types.js";

import { cloneAndFreeze, SecurityEngineError } from "./utils.js";

// ─── Types ───

interface IdempotencyRecord {
  readonly compositeKey: string;
  readonly payloadHash: string;
  readonly response: unknown;
  readonly createdAt: number;
}

// ─── Idempotency Manager ───

export class IdempotencyManager {
  private readonly records = new Map<string, IdempotencyRecord>();
  private readonly ttlMs: number;

  constructor(ttlHours: number = FRIDAY_SECURITY_IDEMPOTENCY_TTL_HOURS) {
    this.ttlMs = ttlHours * 60 * 60 * 1000;
  }

  /**
   * Build the composite idempotency key.
   *
   * Scope: (principalId, tenantId, operationId, key) — tenant-isolated
   * to prevent cross-tenant collisions.
   */
  private buildCompositeKey(
    principalId: string,
    tenantId: UUID,
    operationId: string,
    key: string,
  ): string {
    return `${principalId}:${tenantId}:${operationId}:${key}`;
  }

  /** Recursively sort object keys for deterministic payload hashing. */
  private canonicalizePayload(value: unknown): unknown {
    if (value === null || typeof value !== "object") {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.canonicalizePayload(item));
    }

    const sortedEntries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, this.canonicalizePayload(entryValue)] as const);

    return Object.fromEntries(sortedEntries);
  }

  /** Hash a payload for comparison. */
  private hashPayload(payload: unknown): string {
    const canonicalizedPayload = this.canonicalizePayload(payload);
    const serialised = JSON.stringify(canonicalizedPayload) ?? "null";
    return createHash("sha256").update(serialised).digest("hex");
  }

  /** Evict expired records. */
  private evictExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, record] of this.records) {
      if (record.createdAt <= cutoff) {
        this.records.delete(key);
      }
    }
  }

  /**
   * Check an idempotency key before executing an operation.
   *
   * @returns The cached response if the key was already used with the same payload,
   *          or `undefined` if this is a new key.
   * @throws SecurityEngineError with IDEMPOTENCY_KEY_CONFLICT if the key was used
   *         with a different payload.
   */
  check<T>(
    principalId: string,
    tenantId: UUID,
    operationId: string,
    key: string,
    payload: unknown,
  ): T | undefined {
    this.evictExpired();

    const compositeKey = this.buildCompositeKey(principalId, tenantId, operationId, key);
    const existing = this.records.get(compositeKey);
    if (!existing) return undefined;

    const payloadHash = this.hashPayload(payload);
    if (existing.payloadHash === payloadHash) {
      return cloneAndFreeze(existing.response) as T;
    }

    throw new SecurityEngineError(
      FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
      `Idempotency key '${key}' was already used with a different payload for operation '${operationId}'.`,
    );
  }

  /**
   * Record a completed operation's response for future idempotency replay.
   */
  record(
    principalId: string,
    tenantId: UUID,
    operationId: string,
    key: string,
    payload: unknown,
    response: unknown,
  ): void {
    const compositeKey = this.buildCompositeKey(principalId, tenantId, operationId, key);
    const payloadHash = this.hashPayload(payload);
    this.records.set(compositeKey, {
      compositeKey,
      payloadHash,
      response: cloneAndFreeze(response),
      createdAt: Date.now(),
    });
  }

  /** Get the number of active (non-expired) records. */
  get size(): number {
    this.evictExpired();
    return this.records.size;
  }
}
