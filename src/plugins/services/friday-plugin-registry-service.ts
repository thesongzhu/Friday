/**
 * Plugin registry: manages installed plugins, dedup, and source precedence.
 */

import type { FridaySqliteLayer } from "#state";

import { FridayDomainError } from "#errors";

import type {
  FridayPluginEntity,
  FridayPluginListQuery,
  FridayPluginStatus,
  FridayRegisteredPlugin,
  FridayUpsertPluginInput,
} from "../model/friday-plugin.types.js";
import {
  FRIDAY_CORE_CHANNEL_PLUGIN_IDS,
  FRIDAY_PLUGIN_ERROR_CODES,
  FRIDAY_PLUGIN_SOURCE_PRECEDENCE,
} from "../model/friday-plugin.types.js";
import type { FridayPluginRepository } from "../persistence/friday-plugin-repository.js";

// ─── Types ───

export interface FridayPluginRegistryService {
  /** Install or update a plugin in the registry. */
  upsert(input: FridayUpsertPluginInput): FridayPluginEntity;
  /** Get a specific plugin by ID. */
  get(pluginId: string): FridayPluginEntity | null;
  /** List plugins with optional filtering. */
  list(query?: FridayPluginListQuery): FridayPluginEntity[];
  /** Update a plugin's status. */
  setStatus(pluginId: string, status: FridayPluginStatus, nowIso: string): void;
  /** Enable or disable a plugin. */
  setEnabled(pluginId: string, enabled: boolean, nowIso: string): void;
  /** Record an error on a plugin. */
  setError(pluginId: string, errorCode: string, errorMessage: string, nowIso: string): void;
  /** Remove a plugin from the registry. */
  remove(pluginId: string): void;
  /** Returns deduplicated plugins based on source precedence. */
  resolveRuntimePlugins(): FridayRegisteredPlugin[];
}

export interface CreateFridayPluginRegistryServiceDeps {
  sqlite: FridaySqliteLayer;
  pluginRepository: FridayPluginRepository;
}

// ─── Factory ───

export function createFridayPluginRegistryService(
  deps: CreateFridayPluginRegistryServiceDeps,
): FridayPluginRegistryService {
  const { sqlite, pluginRepository } = deps;

  function entityToRegistered(entity: FridayPluginEntity): FridayRegisteredPlugin {
    return {
      id: entity.id,
      version: entity.version,
      source: entity.source,
      manifest: entity.manifest,
      entity,
    };
  }

  const coreIds = new Set<string>(FRIDAY_CORE_CHANNEL_PLUGIN_IDS);

  return {
    upsert(input: FridayUpsertPluginInput): FridayPluginEntity {
      // Reject non-bundled writes to core plugin IDs
      if (coreIds.has(input.id) && input.source !== "bundled") {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.CORE_PLUGIN_PROTECTED,
          `Cannot register core plugin "${input.id}" from source "${input.source}"; only "bundled" source is allowed`,
          { httpStatus: 403, details: { pluginId: input.id, source: input.source } },
        );
      }
      return sqlite.withWriteTransaction((db) =>
        pluginRepository.upsertPlugin(db, input),
      );
    },

    get(pluginId: string): FridayPluginEntity | null {
      return sqlite.withReadConnection((db) =>
        pluginRepository.getById(db, pluginId),
      );
    },

    list(query?: FridayPluginListQuery): FridayPluginEntity[] {
      return sqlite.withReadConnection((db) =>
        pluginRepository.list(db, query),
      );
    },

    setStatus(pluginId: string, status: FridayPluginStatus, nowIso: string): void {
      sqlite.withWriteTransaction((db) =>
        pluginRepository.setStatus(db, pluginId, status, nowIso),
      );
    },

    setEnabled(pluginId: string, enabled: boolean, nowIso: string): void {
      sqlite.withWriteTransaction((db) =>
        pluginRepository.setEnabled(db, pluginId, enabled, nowIso),
      );
    },

    setError(pluginId: string, errorCode: string, errorMessage: string, nowIso: string): void {
      sqlite.withWriteTransaction((db) =>
        pluginRepository.setError(db, pluginId, errorCode, errorMessage, nowIso),
      );
    },

    remove(pluginId: string): void {
      if (coreIds.has(pluginId)) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.CORE_PLUGIN_PROTECTED,
          `Cannot remove core plugin "${pluginId}"`,
          { httpStatus: 403, details: { pluginId } },
        );
      }
      sqlite.withWriteTransaction((db) =>
        pluginRepository.deletePlugin(db, pluginId),
      );
    },

    resolveRuntimePlugins(): FridayRegisteredPlugin[] {
      const allPlugins = sqlite.withReadConnection((db) =>
        pluginRepository.list(db),
      );

      // Group by ID and pick best source by precedence.
      // With a single-PK schema only one row per ID exists, but the grouping
      // is kept as defensive code in case the storage model changes.
      const byId = new Map<string, FridayPluginEntity[]>();
      for (const plugin of allPlugins) {
        const existing = byId.get(plugin.id) ?? [];
        existing.push(plugin);
        byId.set(plugin.id, existing);
      }

      const result: FridayRegisteredPlugin[] = [];

      for (const [id, plugins] of byId) {
        if (coreIds.has(id)) {
          // Core plugins: only bundled source allowed
          const bundled = plugins.find((p) => p.source === "bundled");
          if (bundled) {
            result.push(entityToRegistered(bundled));
          }
          continue;
        }

        // Sort by source precedence (higher index = higher priority)
        const sorted = [...plugins].sort((a, b) => {
          const aIdx = FRIDAY_PLUGIN_SOURCE_PRECEDENCE.indexOf(a.source);
          const bIdx = FRIDAY_PLUGIN_SOURCE_PRECEDENCE.indexOf(b.source);
          return bIdx - aIdx;
        });

        if (sorted[0]) {
          result.push(entityToRegistered(sorted[0]));
        }
      }

      return result.sort((a, b) => a.id.localeCompare(b.id));
    },
  };
}
