/**
 * Audit Trail — Immutable audit log with tamper-evident hash chain.
 *
 * NOTE: This module provides in-memory audit entry construction and hash-chain
 * integrity. Entries are NOT persisted to disk by this module — durability is
 * the responsibility of the consuming service (e.g. hub audit log writer).
 * This is a deliberate design choice to keep the audit trail composable.
 *
 * Records all significant operations as append-only audit entries.
 * Each entry includes a SHA-256 integrity hash computed over the previous
 * entry's hash concatenated with the canonical serialization of the current
 * entry, forming a tamper-evident chain.
 *
 * Canonical serialization follows RFC §6.6:
 * - Sorted JSON keys (recursive)
 * - No whitespace
 * - UTF-8 encoded
 * - Null values preserved
 * - Array order preserved
 * - `integrityHash` field excluded
 *
 * @module observability/engine
 */

import type {
  FridayAuditActionCategory,
  FridayAuditActor,
  FridayAuditEntry,
  FridayAuditOutcome,
  FridayAuditResource,
  FridayCanonicalizeAuditEntry,
  FridayObservabilityModule,
  FridayRetentionCheckpoint,
  ISODateTime,
  JsonObject,
  JsonValue,
  UUID,
} from "../model/friday-observability.types.js";

import { FRIDAY_AUDIT_GENESIS_HASH } from "../model/friday-observability.types.js";

// ─── Canonical Serialization ───

/**
 * Canonicalize a JSON value: sort object keys recursively,
 * preserve nulls, preserve array order, no whitespace.
 */
function canonicalizeValue(value: JsonValue | undefined): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalizeValue(v)).join(",") + "]";
  }
  // Object — sort keys
  const obj = value as Record<string, JsonValue>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalizeValue(obj[k]));
  return "{" + parts.join(",") + "}";
}

/**
 * Canonicalize an audit entry for hash computation.
 * Excludes the `integrityHash` field (would be circular).
 * Converts the entry to a plain JSON object, then applies canonical serialization.
 */
export const canonicalizeAuditEntry: FridayCanonicalizeAuditEntry = (entry) => {
  const plain: Record<string, JsonValue> = {
    id: entry.id,
    sequenceNumber: entry.sequenceNumber,
    actor: entry.actor as unknown as JsonValue,
    actionCategory: entry.actionCategory,
    action: entry.action,
    resource: entry.resource as unknown as JsonValue,
    outcome: entry.outcome,
    description: entry.description,
    module: entry.module,
    previousHash: entry.previousHash,
    recordedAt: entry.recordedAt,
  };

  if (entry.errorCode !== undefined) plain.errorCode = entry.errorCode;
  if (entry.errorMessage !== undefined) plain.errorMessage = entry.errorMessage;
  if (entry.traceId !== undefined) plain.traceId = entry.traceId;
  if (entry.spanId !== undefined) plain.spanId = entry.spanId;
  if (entry.metadata !== undefined) plain.metadata = entry.metadata as unknown as JsonValue;

  return canonicalizeValue(plain);
};

// ─── SHA-256 Hashing ───

/** Compute SHA-256 hash of a UTF-8 string, returned as lowercase hex. */
async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const buffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Recursively freeze objects/arrays to enforce runtime immutability. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested !== null && typeof nested === "object") {
      deepFreeze(nested);
    }
  }

  return Object.freeze(value);
}

/** Clone a value and return a deeply frozen copy. */
function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

// ─── Append Options ───

/** Options for appending an audit entry. */
export interface AppendAuditEntryOptions {
  /** Who performed the action. */
  readonly actor: FridayAuditActor;
  /** High-level action category. */
  readonly actionCategory: FridayAuditActionCategory;
  /** Specific action (dot-namespaced, e.g., "rules.create"). */
  readonly action: string;
  /** The resource acted upon. */
  readonly resource: FridayAuditResource;
  /** The outcome of the action. */
  readonly outcome: FridayAuditOutcome;
  /** Human-readable description. */
  readonly description: string;
  /** Source module. */
  readonly module: FridayObservabilityModule;
  /** Error code (when outcome is failure/denied/error). */
  readonly errorCode?: string;
  /** Error message (when outcome is failure/denied/error). */
  readonly errorMessage?: string;
  /** Trace ID for correlation. */
  readonly traceId?: string;
  /** Span ID for correlation. */
  readonly spanId?: string;
  /** Arbitrary metadata. */
  readonly metadata?: JsonObject;
}

// ─── UUID Generation ───

/** Generate a v4-style UUID using crypto. */
function generateUUID(): UUID {
  const hex = Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "4" + hex.slice(13, 16),
    ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

// ─── Audit Trail ───

/**
 * Immutable, append-only audit trail with tamper-evident hash chain.
 *
 * Usage:
 * ```ts
 * const trail = new FridayAuditTrail();
 * const entry = await trail.append({
 *   actor: { type: "user", id: "u1", displayName: "Alice" },
 *   actionCategory: "create",
 *   action: "rules.create",
 *   resource: { type: "rule", id: "r1" },
 *   outcome: "success",
 *   description: "Created rule r1",
 *   module: "rules",
 * });
 * const valid = await trail.verifyChain();
 * ```
 */
export class FridayAuditTrail {
  private readonly entries: FridayAuditEntry[] = [];
  private readonly checkpoints: FridayRetentionCheckpoint[] = [];
  private nextSequenceNumber = 1;

  /** Get the hash of the last entry, or genesis hash if empty. */
  private getLastHash(): string {
    if (this.entries.length === 0) {
      // Use checkpoint boundary hash if available
      if (this.checkpoints.length > 0) {
        return this.checkpoints[this.checkpoints.length - 1].boundaryHash;
      }
      return FRIDAY_AUDIT_GENESIS_HASH;
    }
    return this.entries[this.entries.length - 1].integrityHash;
  }

  /** Append a new audit entry to the trail. Returns the created entry. */
  async append(options: AppendAuditEntryOptions): Promise<FridayAuditEntry> {
    const id = generateUUID();
    const sequenceNumber = this.nextSequenceNumber++;
    const previousHash = this.getLastHash();
    const recordedAt = new Date().toISOString();

    // Build entry without integrityHash first
    const entryWithoutHash: Omit<FridayAuditEntry, "integrityHash"> = {
      id,
      sequenceNumber,
      actor: structuredClone(options.actor),
      actionCategory: options.actionCategory,
      action: options.action,
      resource: structuredClone(options.resource),
      outcome: options.outcome,
      description: options.description,
      module: options.module,
      previousHash,
      recordedAt,
    };

    if (options.errorCode !== undefined) {
      (entryWithoutHash as Record<string, unknown>).errorCode = options.errorCode;
    }
    if (options.errorMessage !== undefined) {
      (entryWithoutHash as Record<string, unknown>).errorMessage = options.errorMessage;
    }
    if (options.traceId !== undefined) {
      (entryWithoutHash as Record<string, unknown>).traceId = options.traceId;
    }
    if (options.spanId !== undefined) {
      (entryWithoutHash as Record<string, unknown>).spanId = options.spanId;
    }
    if (options.metadata !== undefined) {
      (entryWithoutHash as Record<string, unknown>).metadata = structuredClone(options.metadata);
    }

    // Compute integrity hash: SHA-256(previousHash + canonicalize(entry))
    const canonical = canonicalizeAuditEntry(entryWithoutHash);
    const integrityHash = await sha256(previousHash + canonical);

    const entry = deepFreeze<FridayAuditEntry>({
      ...entryWithoutHash,
      integrityHash,
    });

    this.entries.push(entry);
    return cloneAndFreeze(entry);
  }

  /**
   * Verify the integrity of the hash chain.
   * Returns an object with verification result and the index of the first broken link.
   */
  async verifyChain(): Promise<{ valid: boolean; brokenAt?: number }> {
    // Determine the anchor hash for the first entry
    let expectedPreviousHash: string;
    if (this.checkpoints.length > 0) {
      expectedPreviousHash = this.checkpoints[this.checkpoints.length - 1].boundaryHash;
    } else {
      expectedPreviousHash = FRIDAY_AUDIT_GENESIS_HASH;
    }

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];

      // Verify previous hash linkage
      if (entry.previousHash !== expectedPreviousHash && !(i === 0 && entry.previousHash === null)) {
        // Allow null previousHash only for the very first entry with genesis
        if (!(i === 0 && entry.previousHash === null && expectedPreviousHash === FRIDAY_AUDIT_GENESIS_HASH)) {
          return { valid: false, brokenAt: i };
        }
      }

      // Recompute hash
      const { integrityHash: _, ...rest } = entry;
      const canonical = canonicalizeAuditEntry(rest as Omit<FridayAuditEntry, "integrityHash">);
      const prevHash = entry.previousHash ?? FRIDAY_AUDIT_GENESIS_HASH;
      const expectedHash = await sha256(prevHash + canonical);

      if (entry.integrityHash !== expectedHash) {
        return { valid: false, brokenAt: i };
      }

      expectedPreviousHash = entry.integrityHash;
    }

    return { valid: true };
  }

  /**
   * Verify a single entry's integrity hash.
   * Requires the previous entry's hash (or genesis hash for the first entry).
   */
  async verifyEntry(entry: FridayAuditEntry, previousHash: string | null): Promise<boolean> {
    const prevHash = previousHash ?? FRIDAY_AUDIT_GENESIS_HASH;
    const { integrityHash: _, ...rest } = entry;
    const canonical = canonicalizeAuditEntry(rest as Omit<FridayAuditEntry, "integrityHash">);
    const expectedHash = await sha256(prevHash + canonical);
    return entry.integrityHash === expectedHash;
  }

  /** Get all entries. */
  getEntries(): readonly FridayAuditEntry[] {
    return cloneAndFreeze(this.entries);
  }

  /** Get an entry by ID. */
  getEntry(id: UUID): FridayAuditEntry | null {
    const entry = this.entries.find((e) => e.id === id);
    return entry ? cloneAndFreeze(entry) : null;
  }

  /** Get an entry by sequence number. */
  getEntryBySequence(sequenceNumber: number): FridayAuditEntry | null {
    const entry = this.entries.find((e) => e.sequenceNumber === sequenceNumber);
    return entry ? cloneAndFreeze(entry) : null;
  }

  /** Get the total number of entries. */
  getEntryCount(): number {
    return this.entries.length;
  }

  /**
   * Apply a retention policy: delete entries with sequence number <= boundary.
   * Records a retention checkpoint for chain continuity.
   */
  async applyRetention(maxSequenceNumber: number, reason: string): Promise<FridayRetentionCheckpoint | null> {
    const toDelete = this.entries.filter((e) => e.sequenceNumber <= maxSequenceNumber);
    if (toDelete.length === 0) return null;

    const lastDeleted = toDelete[toDelete.length - 1];
    const firstRetained = this.entries.find((e) => e.sequenceNumber > maxSequenceNumber);

    const checkpoint = deepFreeze<FridayRetentionCheckpoint>({
      id: generateUUID(),
      lastDeletedSequenceNumber: lastDeleted.sequenceNumber,
      boundaryHash: lastDeleted.integrityHash,
      firstRetainedSequenceNumber: firstRetained?.sequenceNumber ?? lastDeleted.sequenceNumber + 1,
      createdAt: new Date().toISOString(),
      reason,
    });

    // Remove deleted entries
    const remaining = this.entries.filter((e) => e.sequenceNumber > maxSequenceNumber);
    this.entries.length = 0;
    this.entries.push(...remaining);

    this.checkpoints.push(checkpoint);
    return cloneAndFreeze(checkpoint);
  }

  /** Get all retention checkpoints. */
  getCheckpoints(): readonly FridayRetentionCheckpoint[] {
    return cloneAndFreeze(this.checkpoints);
  }

  /** Query entries with filters. */
  query(filters: {
    actorId?: string;
    actionCategory?: FridayAuditActionCategory;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    outcome?: FridayAuditOutcome;
    module?: FridayObservabilityModule;
    traceId?: string;
    after?: ISODateTime;
    before?: ISODateTime;
  }): FridayAuditEntry[] {
    const matching = this.entries.filter((entry) => {
      if (filters.actorId && entry.actor.id !== filters.actorId) return false;
      if (filters.actionCategory && entry.actionCategory !== filters.actionCategory) return false;
      if (filters.action && entry.action !== filters.action) return false;
      if (filters.resourceType && entry.resource.type !== filters.resourceType) return false;
      if (filters.resourceId && entry.resource.id !== filters.resourceId) return false;
      if (filters.outcome && entry.outcome !== filters.outcome) return false;
      if (filters.module && entry.module !== filters.module) return false;
      if (filters.traceId && entry.traceId !== filters.traceId) return false;
      if (filters.after && entry.recordedAt < filters.after) return false;
      if (filters.before && entry.recordedAt >= filters.before) return false;
      return true;
    });

    return cloneAndFreeze(matching);
  }

  /** Reset all state (for testing). */
  reset(): void {
    this.entries.length = 0;
    this.checkpoints.length = 0;
    this.nextSequenceNumber = 1;
  }

  // ─── SIEM Export Adapters ───

  /**
   * Export all entries as JSONL (JSON Lines) string.
   * Each line is a self-contained JSON object suitable for SIEM ingestion.
   */
  exportJsonl(filters?: Parameters<FridayAuditTrail["query"]>[0]): string {
    const entries = filters ? this.query(filters) : this.getEntries();
    return entries.map((entry) => JSON.stringify(entry)).join("\n");
  }

  /**
   * Export entries via HTTP webhook POST.
   * Sends a batch of entries as a JSON array to the given URL.
   * Returns the number of entries sent.
   */
  async exportWebhook(
    url: string,
    options?: {
      filters?: Parameters<FridayAuditTrail["query"]>[0];
      headers?: Record<string, string>;
      batchSize?: number;
    },
  ): Promise<{ sent: number; batches: number }> {
    const entries = options?.filters ? this.query(options.filters) : this.getEntries();
    const batchSize = options?.batchSize ?? 100;
    let sent = 0;
    let batches = 0;

    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...options?.headers,
        },
        body: JSON.stringify({ entries: batch, exportedAt: new Date().toISOString() }),
      });
      if (!response.ok) {
        throw new Error(`SIEM webhook export failed: ${String(response.status)} ${response.statusText}`);
      }
      sent += batch.length;
      batches += 1;
    }

    return { sent, batches };
  }
}
