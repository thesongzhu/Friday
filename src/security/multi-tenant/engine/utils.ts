/**
 * Shared utilities for the multi-tenant security engine.
 *
 * Pure, dependency-free helpers: UUID generation, timestamps, etag generation.
 *
 * @module security/multi-tenant/engine/utils
 */

import { randomBytes, randomUUID } from "node:crypto";

import type { ISODateTime, UUID } from "../model/friday-multi-tenant-security.types.js";

/** Generate a new v4 UUID. */
export function generateId(): UUID {
  return randomUUID();
}

/** Return the current time as an ISO 8601 string. */
export function now(): ISODateTime {
  return new Date().toISOString();
}

/** Generate a random etag for optimistic concurrency. */
export function generateEtag(): string {
  return randomBytes(16).toString("hex");
}

/** Deep-freeze an object graph in-place. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Object.isFrozen(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value);
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    deepFreeze(record[key]);
  }
  return Object.freeze(value);
}

/**
 * Return an immutable deep-cloned snapshot of a value.
 *
 * Prevents callers from mutating internal engine state through returned objects.
 */
export function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

/**
 * Typed error class for multi-tenant security engine operations.
 *
 * Carries a standardised error `code` from the API error codes,
 * enabling callers to map errors to HTTP status codes.
 */
export class SecurityEngineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SecurityEngineError";
  }
}
