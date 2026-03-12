/**
 * SQLite-backed repository for plugin dependency edges.
 */

import type Database from "better-sqlite3";

import type {
  FridayPluginDependencyEntity,
  FridayUpsertPluginDependencyInput,
} from "../model/friday-plugin.types.js";

// ─── Types ───

export interface FridayPluginDependencyRepository {
  upsert(db: Database.Database, input: FridayUpsertPluginDependencyInput): void;
  listByPlugin(db: Database.Database, pluginId: string): FridayPluginDependencyEntity[];
  listByDependency(db: Database.Database, dependencyPluginId: string): FridayPluginDependencyEntity[];
  deleteByPlugin(db: Database.Database, pluginId: string): void;
  deleteOne(db: Database.Database, pluginId: string, dependencyPluginId: string): void;
}

// ─── Row Mapping ───

interface FridayPluginDependencyRow {
  plugin_id: string;
  dependency_plugin_id: string;
  semver_range: string;
  optional: number;
  created_at: string;
  updated_at: string;
}

function rowToEntity(row: FridayPluginDependencyRow): FridayPluginDependencyEntity {
  return {
    pluginId: row.plugin_id,
    dependencyPluginId: row.dependency_plugin_id,
    semverRange: row.semver_range,
    optional: row.optional === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export function createFridayPluginDependencyRepository(): FridayPluginDependencyRepository {
  return {
    upsert(db: Database.Database, input: FridayUpsertPluginDependencyInput): void {
      db.prepare(`
        INSERT INTO plugin_dependencies (
          plugin_id, dependency_plugin_id, semver_range, optional, created_at, updated_at
        ) VALUES (
          @plugin_id, @dependency_plugin_id, @semver_range, @optional, @created_at, @updated_at
        )
        ON CONFLICT(plugin_id, dependency_plugin_id) DO UPDATE SET
          semver_range = excluded.semver_range,
          optional = excluded.optional,
          updated_at = excluded.updated_at
      `).run({
        plugin_id: input.pluginId,
        dependency_plugin_id: input.dependencyPluginId,
        semver_range: input.semverRange,
        optional: input.optional ? 1 : 0,
        created_at: input.nowIso,
        updated_at: input.nowIso,
      });
    },

    listByPlugin(db: Database.Database, pluginId: string): FridayPluginDependencyEntity[] {
      const rows = db.prepare(
        "SELECT * FROM plugin_dependencies WHERE plugin_id = ? ORDER BY dependency_plugin_id",
      ).all(pluginId) as FridayPluginDependencyRow[];
      return rows.map(rowToEntity);
    },

    listByDependency(db: Database.Database, dependencyPluginId: string): FridayPluginDependencyEntity[] {
      const rows = db.prepare(
        "SELECT * FROM plugin_dependencies WHERE dependency_plugin_id = ? ORDER BY plugin_id",
      ).all(dependencyPluginId) as FridayPluginDependencyRow[];
      return rows.map(rowToEntity);
    },

    deleteByPlugin(db: Database.Database, pluginId: string): void {
      db.prepare("DELETE FROM plugin_dependencies WHERE plugin_id = ?").run(pluginId);
    },

    deleteOne(db: Database.Database, pluginId: string, dependencyPluginId: string): void {
      db.prepare(
        "DELETE FROM plugin_dependencies WHERE plugin_id = ? AND dependency_plugin_id = ?",
      ).run(pluginId, dependencyPluginId);
    },
  };
}
