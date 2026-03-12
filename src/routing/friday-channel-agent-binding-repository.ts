/**
 * OC-017: Channel-to-agent routing binding repository.
 *
 * Resolves which agent configuration key should handle messages from a
 * given channel kind + channel ID. Falls back to wildcard `*` bindings,
 * then to the default `"default"` agent config key.
 */

import type Database from "better-sqlite3";

// ─── Types ───

export interface ChannelAgentBinding {
  id: string;
  channelKind: string;
  channelId: string;
  agentConfigKey: string;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ChannelAgentBindingRow {
  id: string;
  channel_kind: string;
  channel_id: string;
  agent_config_key: string;
  priority: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

// ─── Row mapper ───

function rowToBinding(row: ChannelAgentBindingRow): ChannelAgentBinding {
  return {
    id: row.id,
    channelKind: row.channel_kind,
    channelId: row.channel_id,
    agentConfigKey: row.agent_config_key,
    priority: row.priority,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Repository interface ───

export interface FridayChannelAgentBindingRepository {
  /** Resolve the agent config key for a given channel kind + channel ID. */
  resolve(db: Database.Database, channelKind: string, channelId: string): string;
  /** List all bindings. */
  list(db: Database.Database): ChannelAgentBinding[];
  /** Upsert a binding. */
  upsert(db: Database.Database, binding: Omit<ChannelAgentBinding, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }): ChannelAgentBinding;
  /** Remove a binding by ID. */
  remove(db: Database.Database, id: string): boolean;
}

// ─── Factory ───

export function createFridayChannelAgentBindingRepository(): FridayChannelAgentBindingRepository {
  return {
    resolve(db, channelKind, channelId): string {
      // 1. Exact match: channel_kind + channel_id
      const exact = db
        .prepare(
          `SELECT agent_config_key FROM channel_agent_bindings
           WHERE channel_kind = ? AND channel_id = ? AND enabled = 1
           ORDER BY priority DESC LIMIT 1`,
        )
        .get(channelKind, channelId) as { agent_config_key: string } | undefined;

      if (exact) return exact.agent_config_key;

      // 2. Wildcard match: channel_kind + '*'
      const wildcard = db
        .prepare(
          `SELECT agent_config_key FROM channel_agent_bindings
           WHERE channel_kind = ? AND channel_id = '*' AND enabled = 1
           ORDER BY priority DESC LIMIT 1`,
        )
        .get(channelKind) as { agent_config_key: string } | undefined;

      if (wildcard) return wildcard.agent_config_key;

      // 3. Default fallback
      return "default";
    },

    list(db): ChannelAgentBinding[] {
      const rows = db
        .prepare(
          `SELECT * FROM channel_agent_bindings ORDER BY channel_kind, priority DESC`,
        )
        .all() as ChannelAgentBindingRow[];
      return rows.map(rowToBinding);
    },

    upsert(db, binding): ChannelAgentBinding {
      const now = binding.updatedAt ?? new Date().toISOString();
      const createdAt = binding.createdAt ?? now;

      db.prepare(
        `INSERT INTO channel_agent_bindings (id, channel_kind, channel_id, agent_config_key, priority, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_kind, channel_id) DO UPDATE SET
           agent_config_key = excluded.agent_config_key,
           priority = excluded.priority,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      ).run(
        binding.id,
        binding.channelKind,
        binding.channelId,
        binding.agentConfigKey,
        binding.priority,
        binding.enabled ? 1 : 0,
        createdAt,
        now,
      );

      return {
        ...binding,
        enabled: binding.enabled,
        createdAt,
        updatedAt: now,
      };
    },

    remove(db, id): boolean {
      const result = db
        .prepare(`DELETE FROM channel_agent_bindings WHERE id = ?`)
        .run(id);
      return result.changes > 0;
    },
  };
}
