/**
 * Fixture Manager — load, cache, and manage test fixtures and mock data.
 *
 * Provides a type-safe in-memory store for test fixtures used by
 * acceptance tests. Fixtures are keyed by a unique identifier and
 * can be loaded individually or in bulk. Supports cache invalidation
 * and namespace isolation.
 *
 * @module acceptance/engine
 */

import type { JsonObject, JsonValue } from "../../rules/model/friday-rules-engine.types.js";
import type { FridayAcceptanceArtifactType } from "../model/friday-acceptance.types.js";

// ─── Types ───

/**
 * A test fixture containing artifact content and optional metadata.
 */
export interface AcceptanceFixture {
  /** Unique fixture identifier. */
  id: string;
  /** Human-readable fixture name. */
  name: string;
  /** Artifact type this fixture represents. */
  artifactType: FridayAcceptanceArtifactType;
  /** The fixture content (artifact payload). */
  content: JsonValue;
  /** Optional metadata for test context. */
  metadata?: JsonObject;
}

/**
 * Options for loading fixtures into the manager.
 */
export interface FixtureLoadOptions {
  /** Namespace to scope fixtures under. Defaults to "default". */
  namespace?: string;
  /** If true, overwrite existing fixtures with the same ID. */
  overwrite?: boolean;
}

/**
 * Statistics about the fixture manager's cache state.
 */
export interface FixtureManagerStats {
  /** Total number of fixtures across all namespaces. */
  totalFixtures: number;
  /** Number of namespaces in use. */
  namespaceCount: number;
  /** Breakdown of fixture count per namespace. */
  perNamespace: Record<string, number>;
}

// ─── Default Namespace ───

const DEFAULT_NAMESPACE = "default";

// ─── Fixture Manager ───

/**
 * In-memory fixture store with namespace isolation and caching.
 *
 * Fixtures are organized by namespace, then keyed by fixture ID.
 * This allows test suites to isolate their fixtures from one another.
 */
export class AcceptanceFixtureManager {
  /** namespace → (fixtureId → fixture) */
  private readonly store = new Map<string, Map<string, AcceptanceFixture>>();

  /**
   * Load a single fixture into the store.
   *
   * @param fixture - Fixture to load.
   * @param options - Load options (namespace, overwrite).
   * @throws If a fixture with the same ID exists and overwrite is false.
   */
  load(fixture: AcceptanceFixture, options?: FixtureLoadOptions): void {
    const ns = options?.namespace ?? DEFAULT_NAMESPACE;
    const overwrite = options?.overwrite ?? false;

    let nsMap = this.store.get(ns);
    if (!nsMap) {
      nsMap = new Map();
      this.store.set(ns, nsMap);
    }

    if (!overwrite && nsMap.has(fixture.id)) {
      throw new Error(`Fixture "${fixture.id}" already exists in namespace "${ns}". Use overwrite: true to replace.`);
    }

    nsMap.set(fixture.id, fixture);
  }

  /**
   * Load multiple fixtures in bulk.
   *
   * @param fixtures - Array of fixtures to load.
   * @param options - Load options applied to all fixtures.
   */
  loadBulk(fixtures: AcceptanceFixture[], options?: FixtureLoadOptions): void {
    for (const fixture of fixtures) {
      this.load(fixture, options);
    }
  }

  /**
   * Get a fixture by ID.
   *
   * @param fixtureId - Fixture identifier.
   * @param namespace - Namespace to search in. Defaults to "default".
   * @returns The fixture, or `undefined` if not found.
   */
  get(fixtureId: string, namespace?: string): AcceptanceFixture | undefined {
    const ns = namespace ?? DEFAULT_NAMESPACE;
    return this.store.get(ns)?.get(fixtureId);
  }

  /**
   * Get all fixtures for a given artifact type.
   *
   * @param artifactType - Artifact type to filter by.
   * @param namespace - Namespace to search in. Defaults to "default".
   * @returns Array of matching fixtures.
   */
  getByArtifactType(artifactType: FridayAcceptanceArtifactType, namespace?: string): AcceptanceFixture[] {
    const ns = namespace ?? DEFAULT_NAMESPACE;
    const nsMap = this.store.get(ns);
    if (!nsMap) return [];

    const results: AcceptanceFixture[] = [];
    for (const fixture of nsMap.values()) {
      if (fixture.artifactType === artifactType) {
        results.push(fixture);
      }
    }
    return results;
  }

  /**
   * Check if a fixture exists.
   *
   * @param fixtureId - Fixture identifier.
   * @param namespace - Namespace to search in. Defaults to "default".
   */
  has(fixtureId: string, namespace?: string): boolean {
    const ns = namespace ?? DEFAULT_NAMESPACE;
    return this.store.get(ns)?.has(fixtureId) ?? false;
  }

  /**
   * Remove a fixture from the store.
   *
   * @param fixtureId - Fixture identifier.
   * @param namespace - Namespace to remove from. Defaults to "default".
   * @returns `true` if the fixture was found and removed.
   */
  remove(fixtureId: string, namespace?: string): boolean {
    const ns = namespace ?? DEFAULT_NAMESPACE;
    const nsMap = this.store.get(ns);
    if (!nsMap) return false;

    const removed = nsMap.delete(fixtureId);
    if (nsMap.size === 0) {
      this.store.delete(ns);
    }
    return removed;
  }

  /**
   * Clear all fixtures in a namespace.
   *
   * @param namespace - Namespace to clear. If omitted, clears all namespaces.
   */
  clear(namespace?: string): void {
    if (namespace !== undefined) {
      this.store.delete(namespace);
    } else {
      this.store.clear();
    }
  }

  /**
   * List all fixture IDs in a namespace.
   *
   * @param namespace - Namespace to list. Defaults to "default".
   */
  listIds(namespace?: string): string[] {
    const ns = namespace ?? DEFAULT_NAMESPACE;
    const nsMap = this.store.get(ns);
    return nsMap ? Array.from(nsMap.keys()) : [];
  }

  /**
   * List all namespaces that contain at least one fixture.
   */
  listNamespaces(): string[] {
    return Array.from(this.store.keys());
  }

  /**
   * Get cache statistics.
   */
  stats(): FixtureManagerStats {
    let totalFixtures = 0;
    const perNamespace: Record<string, number> = {};

    for (const [ns, nsMap] of this.store) {
      perNamespace[ns] = nsMap.size;
      totalFixtures += nsMap.size;
    }

    return {
      totalFixtures,
      namespaceCount: this.store.size,
      perNamespace,
    };
  }
}
