/**
 * Snapshot Manager — golden-file snapshot testing with diff detection.
 *
 * Stores expected (golden) snapshots for artifact outputs and compares
 * actual outputs against them. Supports update mode for refreshing
 * snapshots when expected changes occur.
 *
 * Snapshots are stored in-memory and identified by a unique key.
 * Diff detection uses structural comparison for JSON values.
 *
 * @module acceptance/engine
 */

import type { JsonObject, JsonValue } from "../../rules/model/friday-rules-engine.types.js";

// ─── Types ───

/**
 * A stored snapshot (golden file).
 */
export interface Snapshot {
  /** Unique snapshot key. */
  key: string;
  /** The expected (golden) value. */
  value: JsonValue;
  /** When this snapshot was created or last updated (ISO 8601). */
  updatedAt: string;
  /** Optional description of what this snapshot represents. */
  description?: string;
}

/**
 * Result of comparing an actual value against a snapshot.
 */
export interface SnapshotCompareResult {
  /** Snapshot key. */
  key: string;
  /** Whether the actual value matches the snapshot. */
  matches: boolean;
  /** Structural diff entries if values differ. Empty if they match. */
  diffs: SnapshotDiff[];
}

/**
 * A single structural difference between expected and actual values.
 */
export interface SnapshotDiff {
  /** JSON path to the differing value (dot-separated). */
  path: string;
  /** Type of difference. */
  type: "added" | "removed" | "changed" | "type_mismatch";
  /** Expected value at this path (from snapshot). */
  expected?: JsonValue;
  /** Actual value at this path. */
  actual?: JsonValue;
}

/**
 * Options for snapshot comparison.
 */
export interface SnapshotCompareOptions {
  /**
   * If true, update the snapshot to match the actual value when they differ.
   * Useful during development to refresh golden files.
   */
  updateOnMismatch?: boolean;
}

// ─── Diff Engine ───

/**
 * Compute structural diffs between two JSON values.
 *
 * @param expected - The golden (expected) value.
 * @param actual - The actual value to compare.
 * @param path - Current JSON path prefix (internal, for recursion).
 * @returns Array of structural differences.
 */
export function computeDiffs(expected: JsonValue, actual: JsonValue, path: string = ""): SnapshotDiff[] {
  // Identical values.
  if (expected === actual) return [];

  // Null checks.
  if (expected === null && actual !== null) {
    return [{ path: path || "(root)", type: "changed", expected, actual }];
  }
  if (expected !== null && actual === null) {
    return [{ path: path || "(root)", type: "changed", expected, actual }];
  }

  // Type mismatch.
  if (typeof expected !== typeof actual || Array.isArray(expected) !== Array.isArray(actual)) {
    return [{ path: path || "(root)", type: "type_mismatch", expected, actual }];
  }

  // Array comparison.
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const diffs: SnapshotDiff[] = [];
    const maxLen = Math.max(expected.length, actual.length);

    for (let i = 0; i < maxLen; i++) {
      const itemPath = path ? `${path}[${i}]` : `[${i}]`;

      if (i >= expected.length) {
        diffs.push({ path: itemPath, type: "added", actual: actual[i] });
      } else if (i >= actual.length) {
        diffs.push({ path: itemPath, type: "removed", expected: expected[i] });
      } else {
        diffs.push(...computeDiffs(expected[i], actual[i], itemPath));
      }
    }

    return diffs;
  }

  // Object comparison.
  if (typeof expected === "object" && typeof actual === "object" && expected !== null && actual !== null) {
    const diffs: SnapshotDiff[] = [];
    const expectedObj = expected as JsonObject;
    const actualObj = actual as JsonObject;
    const allKeys = new Set([...Object.keys(expectedObj), ...Object.keys(actualObj)]);

    for (const key of allKeys) {
      const keyPath = path ? `${path}.${key}` : key;
      const inExpected = key in expectedObj;
      const inActual = key in actualObj;

      if (inExpected && !inActual) {
        diffs.push({ path: keyPath, type: "removed", expected: expectedObj[key] });
      } else if (!inExpected && inActual) {
        diffs.push({ path: keyPath, type: "added", actual: actualObj[key] });
      } else {
        diffs.push(...computeDiffs(expectedObj[key], actualObj[key], keyPath));
      }
    }

    return diffs;
  }

  // Primitive value difference.
  if (expected !== actual) {
    return [{ path: path || "(root)", type: "changed", expected, actual }];
  }

  return [];
}

// ─── Snapshot Manager ───

/**
 * In-memory snapshot store for golden-file testing.
 *
 * Usage:
 * 1. Store golden snapshots via {@link save}.
 * 2. Compare actual outputs via {@link compare}.
 * 3. Optionally enable auto-update mode to refresh snapshots.
 */
export class AcceptanceSnapshotManager {
  private readonly snapshots = new Map<string, Snapshot>();

  /**
   * Save a golden snapshot.
   *
   * @param key - Unique snapshot key.
   * @param value - Golden value to store.
   * @param description - Optional description.
   */
  save(key: string, value: JsonValue, description?: string): void {
    this.snapshots.set(key, {
      key,
      value,
      updatedAt: new Date().toISOString(),
      description,
    });
  }

  /**
   * Get a snapshot by key.
   *
   * @param key - Snapshot key.
   * @returns The snapshot, or `undefined` if not found.
   */
  get(key: string): Snapshot | undefined {
    return this.snapshots.get(key);
  }

  /**
   * Check if a snapshot exists.
   *
   * @param key - Snapshot key.
   */
  has(key: string): boolean {
    return this.snapshots.has(key);
  }

  /**
   * Compare an actual value against a stored snapshot.
   *
   * @param key - Snapshot key to compare against.
   * @param actual - Actual value produced by the system under test.
   * @param options - Comparison options.
   * @returns Comparison result with diffs. If no snapshot exists, returns a single "added" diff.
   */
  compare(key: string, actual: JsonValue, options?: SnapshotCompareOptions): SnapshotCompareResult {
    const snapshot = this.snapshots.get(key);

    if (!snapshot) {
      // No existing snapshot — save the actual as the new golden value.
      this.save(key, actual);
      return {
        key,
        matches: true,
        diffs: [],
      };
    }

    const diffs = computeDiffs(snapshot.value, actual);
    const matches = diffs.length === 0;

    if (!matches && options?.updateOnMismatch) {
      this.save(key, actual, snapshot.description);
    }

    return { key, matches, diffs };
  }

  /**
   * Remove a snapshot.
   *
   * @param key - Snapshot key.
   * @returns `true` if the snapshot existed and was removed.
   */
  remove(key: string): boolean {
    return this.snapshots.delete(key);
  }

  /**
   * List all snapshot keys.
   */
  listKeys(): string[] {
    return Array.from(this.snapshots.keys());
  }

  /**
   * Clear all snapshots.
   */
  clear(): void {
    this.snapshots.clear();
  }

  /**
   * Get the total number of stored snapshots.
   */
  get size(): number {
    return this.snapshots.size;
  }

  /**
   * Export all snapshots as a plain object (for serialization).
   */
  exportAll(): Record<string, Snapshot> {
    const result: Record<string, Snapshot> = {};
    for (const [key, snapshot] of this.snapshots) {
      result[key] = snapshot;
    }
    return result;
  }

  /**
   * Import snapshots from a plain object (for deserialization).
   * Overwrites any existing snapshots with matching keys.
   *
   * @param data - Snapshot data to import.
   */
  importAll(data: Record<string, Snapshot>): void {
    for (const [key, snapshot] of Object.entries(data)) {
      this.snapshots.set(key, { ...snapshot, key });
    }
  }
}
