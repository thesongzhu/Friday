import type Database from "better-sqlite3";

import {
  buildDefaultFridayBriefConfig,
  type FridayBriefConfig,
  FridayBriefConfigSchema,
  normalizeFridayBriefFallbackOrder,
} from "./friday-brief-config.types.js";

const SINGLETON_ID = "singleton";

interface ConfigRow {
  id: string;
  enabled: number;
  cron_expression: string;
  timezone: string;
  length: string;
  include_transcript: number;
  language_override: string;
  fallback_order_json: string;
  sources_json: string;
  channels_json: string;
  tts_json: string;
  updated_at: string;
}

export interface FridayBriefConfigRepository {
  get(db: Database.Database): FridayBriefConfig;
  upsert(db: Database.Database, input: FridayBriefConfig, nowIso: string): FridayBriefConfig;
}

function rowToConfig(row: ConfigRow): FridayBriefConfig {
  const rawFallbackOrder = JSON.parse(row.fallback_order_json) as unknown;
  const fallbackOrder = normalizeFridayBriefFallbackOrder(
    Array.isArray(rawFallbackOrder) ? (rawFallbackOrder as string[]) : undefined,
  );
  const merged = FridayBriefConfigSchema.parse({
    enabled: row.enabled === 1,
    cronExpression: row.cron_expression,
    timezone: row.timezone,
    length: row.length,
    includeTranscript: row.include_transcript === 1,
    languageOverride: row.language_override,
    fallbackOrder,
    sources: JSON.parse(row.sources_json),
    channels: JSON.parse(row.channels_json),
    tts: JSON.parse(row.tts_json),
    updatedAt: row.updated_at,
  });
  return merged;
}

export function createFridayBriefConfigRepository(): FridayBriefConfigRepository {
  return {
    get(db) {
      const row = db
        .prepare("SELECT * FROM friday_brief_config WHERE id = ?")
        .get(SINGLETON_ID) as ConfigRow | undefined;
      if (!row) {
        return buildDefaultFridayBriefConfig();
      }
      return rowToConfig(row);
    },

    upsert(db, input, nowIso) {
      const normalized = FridayBriefConfigSchema.parse({
        ...input,
        fallbackOrder: normalizeFridayBriefFallbackOrder(input.fallbackOrder),
        updatedAt: nowIso,
      });
      db.prepare(
        `INSERT INTO friday_brief_config (
           id, enabled, cron_expression, timezone, length, include_transcript,
           language_override, fallback_order_json, sources_json, channels_json,
           tts_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           enabled = excluded.enabled,
           cron_expression = excluded.cron_expression,
           timezone = excluded.timezone,
           length = excluded.length,
           include_transcript = excluded.include_transcript,
           language_override = excluded.language_override,
           fallback_order_json = excluded.fallback_order_json,
           sources_json = excluded.sources_json,
           channels_json = excluded.channels_json,
           tts_json = excluded.tts_json,
           updated_at = excluded.updated_at`,
      ).run(
        SINGLETON_ID,
        normalized.enabled ? 1 : 0,
        normalized.cronExpression,
        normalized.timezone,
        normalized.length,
        normalized.includeTranscript ? 1 : 0,
        normalized.languageOverride,
        JSON.stringify(normalized.fallbackOrder),
        JSON.stringify(normalized.sources),
        JSON.stringify(normalized.channels),
        JSON.stringify(normalized.tts),
        nowIso,
      );
      return normalized;
    },
  };
}
