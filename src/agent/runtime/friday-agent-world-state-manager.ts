/**
 * World State Manager — maintains a structured representation
 * of the user's digital world and personal context.
 *
 * Initial implementation provides basic entity tracking from
 * episode task intents and recent action history. Future versions
 * will use LLM or world model for richer entity extraction.
 */

import type Database from "better-sqlite3";
import type { FridaySqliteLayer } from "#state";
import type {
  FridayEpisode,
  FridayEpisodeStep,
  FridayWorldEntity,
  FridayWorldState,
} from "../model/friday-agent-world-state.types.js";
import { safeJsonParse } from "#utilities";

// ─── Deps ───────────────────────────────────────────────────────

export interface CreateFridayWorldStateManagerDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
}

// ─── Public interface ───────────────────────────────────────────

export interface FridayWorldStateManager {
  /** Load the latest world state for a user, or create an empty one. */
  loadState(userId: string): Promise<FridayWorldState>;

  /** Update world state based on a completed episode. */
  updateFromEpisode(userId: string, episode: FridayEpisode): Promise<void>;

  /** Persist a world state snapshot. */
  saveSnapshot(state: FridayWorldState): Promise<void>;

  /** Get recent episodes for a user. */
  getRecentEpisodes(userId: string, limit?: number): Promise<FridayEpisode[]>;
}

// ─── Row types ──────────────────────────────────────────────────

interface WorldStateSnapshotRow {
  state_json: string;
}

interface WorldEntityRow {
  id: string;
  user_id: string;
  type: string;
  name: string;
  attributes_json: string;
  relations_json: string;
  last_mentioned: string;
  mention_count: number;
}

interface EpisodeRow {
  id: string;
  user_id: string;
  run_id: string;
  task_intent: string;
  task_profile: string | null;
  outcome: string;
  steps_json: string;
  tool_sequence_json: string;
  duration_ms: number;
  context_files_json: string;
  created_at: string;
}

// ─── Factory ────────────────────────────────────────────────────

export function createFridayWorldStateManager(
  deps: CreateFridayWorldStateManagerDeps,
): FridayWorldStateManager {
  const { db, idGenerator, nowIso } = deps;

  return {
    async loadState(userId) {
      // Try loading latest snapshot
      const row = db.withReadConnection((conn) =>
        conn
          .prepare(
            `SELECT state_json FROM friday_world_state_snapshots
             WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
          )
          .get(userId) as WorldStateSnapshotRow | undefined,
      );

      if (row) {
        const parsed = safeJsonParse<FridayWorldState>(row.state_json);
        if (parsed) return parsed;
      }

      // Load entities from dedicated table
      const entities = loadEntities(db, userId);

      // Load recent actions from episodes
      const recentSteps = loadRecentSteps(db, userId, 20);

      return {
        userId,
        entities,
        recentActions: recentSteps,
        activeGoals: [],
        preferences: {},
        environmentFacts: {},
        lastUpdated: nowIso(),
      };
    },

    async updateFromEpisode(userId, episode) {
      // Update recent actions (keep last 20 steps across episodes)
      // Entity extraction: simple keyword extraction from task intent
      // This is intentionally simple — future versions will use LLM/world model
      const now = nowIso();

      db.withWriteTransaction((conn) => {
        // Extract and upsert entities from the task intent
        const entityNames = extractSimpleEntities(episode.taskIntent);
        for (const name of entityNames) {
          upsertEntity(conn, {
            id: idGenerator(),
            userId,
            type: "concept",
            name,
            now,
          });
        }
      });
    },

    async saveSnapshot(state) {
      const now = nowIso();
      db.withWriteTransaction((conn) => {
        conn
          .prepare(
            `INSERT INTO friday_world_state_snapshots (id, user_id, state_json, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(idGenerator(), state.userId, JSON.stringify(state), now);

        // Keep only the last 10 snapshots per user
        conn
          .prepare(
            `DELETE FROM friday_world_state_snapshots
             WHERE user_id = ? AND id NOT IN (
               SELECT id FROM friday_world_state_snapshots
               WHERE user_id = ? ORDER BY created_at DESC LIMIT 10
             )`,
          )
          .run(state.userId, state.userId);
      });
    },

    async getRecentEpisodes(userId, limit = 20) {
      const rows = db.withReadConnection((conn) =>
        conn
          .prepare(
            `SELECT * FROM friday_episodes
             WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(userId, limit) as EpisodeRow[],
      );

      return rows.map(rowToEpisode);
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function loadEntities(
  db: FridaySqliteLayer,
  userId: string,
): FridayWorldEntity[] {
  const rows = db.withReadConnection((conn) =>
    conn
      .prepare(
        `SELECT * FROM friday_world_entities
         WHERE user_id = ? ORDER BY mention_count DESC LIMIT 50`,
      )
      .all(userId) as WorldEntityRow[],
  );

  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    type: row.type as FridayWorldEntity["type"],
    name: row.name,
    attributes: safeJsonParse<Record<string, unknown>>(row.attributes_json) ?? {},
    relations: safeJsonParse<FridayWorldEntity["relations"]>(row.relations_json) ?? [],
    lastMentioned: row.last_mentioned,
    mentionCount: row.mention_count,
  }));
}

function loadRecentSteps(
  db: FridaySqliteLayer,
  userId: string,
  limit: number,
): FridayEpisodeStep[] {
  const rows = db.withReadConnection((conn) =>
    conn
      .prepare(
        `SELECT steps_json FROM friday_episodes
         WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`,
      )
      .all(userId) as Array<{ steps_json: string }>,
  );

  const allSteps: FridayEpisodeStep[] = [];
  for (const row of rows) {
    const steps = safeJsonParse<FridayEpisodeStep[]>(row.steps_json) ?? [];
    allSteps.push(...steps);
    if (allSteps.length >= limit) break;
  }

  return allSteps.slice(0, limit);
}

/**
 * Simple entity extraction from task intent text.
 * Extracts capitalized multi-word phrases and quoted strings.
 * This is intentionally basic — future versions will use NLP/LLM.
 */
function extractSimpleEntities(text: string): string[] {
  const entities = new Set<string>();

  // Extract quoted strings (likely project/file names)
  const quoted = text.match(/["']([^"']{2,40})["']/g);
  if (quoted) {
    for (const q of quoted) {
      entities.add(q.replace(/["']/g, "").trim());
    }
  }

  // Extract capitalized words that aren't sentence starters (likely proper nouns)
  // Skip first word of sentences
  const words = text.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const word = words[i].replace(/[.,!?;:]/g, "");
    if (word.length >= 2 && /^[A-Z][a-z]/.test(word) && !COMMON_WORDS.has(word)) {
      entities.add(word);
    }
  }

  return [...entities].slice(0, 5);
}

const COMMON_WORDS = new Set([
  "The", "This", "That", "These", "Those", "What", "When", "Where",
  "Which", "How", "Why", "Can", "Could", "Would", "Should", "Will",
  "Please", "Make", "Create", "Update", "Delete", "Add", "Remove",
  "Fix", "Build", "Run", "Test", "Check", "Set", "Get", "Let",
  "Use", "Try", "Find", "Show", "Help", "Write", "Read", "Send",
  "Also", "But", "And", "Not", "Yes", "Now", "Here", "There",
]);

function upsertEntity(
  conn: Database.Database,
  input: { id: string; userId: string; type: string; name: string; now: string },
): void {
  // Try update first
  const updated = conn
    .prepare(
      `UPDATE friday_world_entities
       SET mention_count = mention_count + 1,
           last_mentioned = ?,
           updated_at = ?
       WHERE user_id = ? AND name = ?`,
    )
    .run(input.now, input.now, input.userId, input.name);

  if (updated.changes === 0) {
    conn
      .prepare(
        `INSERT INTO friday_world_entities
           (id, user_id, type, name, attributes_json, relations_json,
            last_mentioned, mention_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, '{}', '[]', ?, 1, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.type,
        input.name,
        input.now,
        input.now,
        input.now,
      );
  }
}

function rowToEpisode(row: EpisodeRow): FridayEpisode {
  return {
    id: row.id,
    userId: row.user_id,
    runId: row.run_id,
    taskIntent: row.task_intent,
    taskProfile: row.task_profile ?? undefined,
    outcome: row.outcome as FridayEpisode["outcome"],
    steps: safeJsonParse<FridayEpisodeStep[]>(row.steps_json) ?? [],
    toolSequence: safeJsonParse<string[]>(row.tool_sequence_json) ?? [],
    durationMs: row.duration_ms,
    contextFiles: safeJsonParse<string[]>(row.context_files_json) ?? [],
    createdAt: row.created_at,
  };
}
