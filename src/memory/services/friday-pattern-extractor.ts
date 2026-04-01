/**
 * Pattern Extractor — analyzes episode trajectories to discover
 * recurring tool sequences, failure modes, and temporal patterns.
 *
 * Results are persisted to `friday_learned_patterns` and injected
 * into the agent system prompt for context-aware decision-making.
 */

import type { FridaySqliteLayer } from "#state";
import type { FridayLearnedPattern } from "../../agent/model/friday-agent-world-state.types.js";
import { safeJsonParse } from "#utilities";

// ─── Deps ───────────────────────────────────────────────────────

export interface CreateFridayPatternExtractorDeps {
  db: FridaySqliteLayer;
  idGenerator?: () => string;
  nowIso?: () => string;
}

// ─── Public interface ───────────────────────────────────────────

export interface FridayPatternExtractor {
  /** Extract patterns from recent episodes for a user. */
  extractPatterns(userId: string, limit?: number): Promise<FridayLearnedPattern[]>;
}

// ─── Internal row types ─────────────────────────────────────────

interface EpisodeRow {
  id: string;
  user_id: string;
  task_intent: string;
  outcome: string;
  steps_json: string;
  tool_sequence_json: string;
  created_at: string;
}

interface PatternRow {
  id: string;
  user_id: string;
  kind: string;
  description: string;
  pattern_json: string;
  confidence: number;
  sample_count: number;
  last_updated: string;
  created_at: string;
}

// ─── Factory ────────────────────────────────────────────────────

export function createFridayPatternExtractor(
  deps: CreateFridayPatternExtractorDeps,
): FridayPatternExtractor {
  const { db } = deps;
  const idGen = deps.idGenerator ?? defaultIdGenerator;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());

  return {
    async extractPatterns(userId, limit = 100) {
      // 1. Fetch recent episodes
      const episodes = db.withReadConnection((conn) =>
        conn
          .prepare(
            `SELECT id, user_id, task_intent, outcome, steps_json, tool_sequence_json, created_at
             FROM friday_episodes
             WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(userId, limit) as EpisodeRow[],
      );

      if (episodes.length === 0) return [];

      // 2. Extract three pattern types
      const toolSeqPatterns = extractToolSequencePatterns(episodes);
      const failurePatterns = extractFailureModePatterns(episodes);
      const temporalPatterns = extractTemporalPatterns(episodes);
      const preferencePatterns = extractPreferencePatterns(episodes);

      const allExtracted = [
        ...toolSeqPatterns,
        ...failurePatterns,
        ...temporalPatterns,
        ...preferencePatterns,
      ];
      if (allExtracted.length === 0) return [];

      // 3. Upsert into friday_learned_patterns
      const now = nowIso();
      const results: FridayLearnedPattern[] = [];

      db.withWriteTransaction((conn) => {
        const upsert = conn.prepare(
          `INSERT INTO friday_learned_patterns (id, user_id, kind, description, pattern_json, confidence, sample_count, last_updated, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             description = excluded.description,
             pattern_json = excluded.pattern_json,
             confidence = excluded.confidence,
             sample_count = excluded.sample_count,
             last_updated = excluded.last_updated`,
        );

        for (const p of allExtracted) {
          const id = buildPatternId(userId, p.kind, p.key);
          upsert.run(
            id,
            userId,
            p.kind,
            p.description,
            JSON.stringify(p.pattern),
            p.confidence,
            p.sampleCount,
            now,
            now,
          );
          results.push({
            id,
            userId,
            kind: p.kind as FridayLearnedPattern["kind"],
            description: p.description,
            pattern: p.pattern,
            confidence: p.confidence,
            sampleCount: p.sampleCount,
            lastUpdated: now,
            createdAt: now,
          });
        }
      });

      // 4. Also load any existing patterns not just extracted
      //    (e.g. previously extracted patterns still valid)
      const stored = db.withReadConnection((conn) =>
        conn
          .prepare(
            `SELECT * FROM friday_learned_patterns
             WHERE user_id = ? ORDER BY confidence DESC LIMIT 50`,
          )
          .all(userId) as PatternRow[],
      );

      return stored.map(rowToPattern);
    },
  };
}

// ─── Tool Sequence Pattern Extraction ───────────────────────────

interface ExtractedPattern {
  kind: string;
  key: string;
  description: string;
  pattern: Record<string, unknown>;
  confidence: number;
  sampleCount: number;
}

/**
 * Find most common 3-tool (trigram) sequences across episodes.
 * A sequence that appears in ≥2 episodes is considered a pattern.
 */
function extractToolSequencePatterns(episodes: EpisodeRow[]): ExtractedPattern[] {
  const trigramCounts = new Map<string, { count: number; tools: string[] }>();

  for (const ep of episodes) {
    const tools = safeJsonParse<string[]>(ep.tool_sequence_json) ?? [];
    if (tools.length < 3) continue;

    // Track unique trigrams per episode to avoid over-counting loops
    const seen = new Set<string>();
    for (let i = 0; i <= tools.length - 3; i++) {
      const trigram = [tools[i], tools[i + 1], tools[i + 2]];
      const key = trigram.join(" → ");
      if (seen.has(key)) continue;
      seen.add(key);

      const existing = trigramCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        trigramCounts.set(key, { count: 1, tools: trigram });
      }
    }
  }

  const results: ExtractedPattern[] = [];
  for (const [key, data] of trigramCounts) {
    if (data.count < 2) continue;
    const confidence = Math.min(0.95, 0.3 + data.count * 0.1);
    results.push({
      kind: "tool_sequence",
      key,
      description: `Frequent tool sequence: ${key} (observed ${data.count} times)`,
      pattern: { sequence: data.tools, frequency: data.count },
      confidence,
      sampleCount: data.count,
    });
  }

  // Return top 10 by frequency
  results.sort((a, b) => b.sampleCount - a.sampleCount);
  return results.slice(0, 10);
}

// ─── Failure Mode Clustering ────────────────────────────────────

/**
 * Cluster failures by taskIntent + last error observation.
 * Episodes with same intent prefix and similar error → single pattern.
 */
function extractFailureModePatterns(episodes: EpisodeRow[]): ExtractedPattern[] {
  const failures = episodes.filter((e) => e.outcome === "failure");
  if (failures.length === 0) return [];

  // Group by normalized intent prefix (first 3 words)
  const clusters = new Map<string, { intents: string[]; errors: string[]; count: number }>();

  for (const ep of failures) {
    const intentPrefix = normalizeIntent(ep.task_intent);
    const steps = safeJsonParse<Array<{ observation?: string }>>(ep.steps_json) ?? [];
    const lastError = steps.length > 0
      ? (steps[steps.length - 1].observation ?? "unknown")
      : "unknown";

    const clusterKey = intentPrefix;
    const existing = clusters.get(clusterKey);
    if (existing) {
      existing.count++;
      if (!existing.errors.includes(lastError.slice(0, 100))) {
        existing.errors.push(lastError.slice(0, 100));
      }
      if (!existing.intents.includes(ep.task_intent.slice(0, 80))) {
        existing.intents.push(ep.task_intent.slice(0, 80));
      }
    } else {
      clusters.set(clusterKey, {
        intents: [ep.task_intent.slice(0, 80)],
        errors: [lastError.slice(0, 100)],
        count: 1,
      });
    }
  }

  const results: ExtractedPattern[] = [];
  for (const [key, data] of clusters) {
    if (data.count < 2) continue;
    const confidence = Math.min(0.9, 0.2 + data.count * 0.15);
    results.push({
      kind: "failure_mode",
      key: `fail:${key}`,
      description: `Recurring failure for "${key}" tasks (${data.count} occurrences)`,
      pattern: {
        intentPrefix: key,
        sampleIntents: data.intents.slice(0, 3),
        observedErrors: data.errors.slice(0, 5),
        occurrences: data.count,
      },
      confidence,
      sampleCount: data.count,
    });
  }

  results.sort((a, b) => b.sampleCount - a.sampleCount);
  return results.slice(0, 10);
}

// ─── Temporal Pattern Extraction ────────────────────────────────

/**
 * Bucket episodes by hour-of-day to find when the user is most active,
 * and correlate with task types.
 */
function extractTemporalPatterns(episodes: EpisodeRow[]): ExtractedPattern[] {
  if (episodes.length < 5) return []; // need enough data

  const hourBuckets = new Map<number, { count: number; intents: string[] }>();

  for (const ep of episodes) {
    const date = new Date(ep.created_at);
    if (isNaN(date.getTime())) continue;
    const hour = date.getUTCHours();

    const existing = hourBuckets.get(hour);
    if (existing) {
      existing.count++;
      const intent = normalizeIntent(ep.task_intent);
      if (!existing.intents.includes(intent)) {
        existing.intents.push(intent);
      }
    } else {
      hourBuckets.set(hour, { count: 1, intents: [normalizeIntent(ep.task_intent)] });
    }
  }

  // Find peak hours (top 3 by activity)
  const sorted = [...hourBuckets.entries()].sort((a, b) => b[1].count - a[1].count);
  if (sorted.length === 0) return [];

  const peakHours = sorted.slice(0, 3);
  const totalEpisodes = episodes.length;

  const results: ExtractedPattern[] = [];

  // Overall activity pattern
  const hourDistribution: Record<string, number> = {};
  for (const [hour, data] of hourBuckets) {
    hourDistribution[String(hour)] = data.count;
  }

  results.push({
    kind: "temporal",
    key: "activity_hours",
    description: `Most active hours: ${peakHours.map(([h]) => `${h}:00 UTC`).join(", ")}`,
    pattern: {
      peakHours: peakHours.map(([h, d]) => ({ hour: h, count: d.count, topIntents: d.intents.slice(0, 3) })),
      distribution: hourDistribution,
      totalEpisodes,
    },
    confidence: Math.min(0.85, 0.3 + totalEpisodes * 0.01),
    sampleCount: totalEpisodes,
  });

  return results;
}

// ─── Successful Execution Preference Patterns ───────────────────

/**
 * Capture repeated successful task + tool-sequence combinations as execution
 * preferences. These are intentionally lightweight and only require two
 * matching successful episodes so the world model can learn from real usage
 * earlier than the higher-threshold trigram and temporal patterns.
 */
function extractPreferencePatterns(episodes: EpisodeRow[]): ExtractedPattern[] {
  const successful = episodes.filter((episode) => episode.outcome === "success");
  if (successful.length < 2) return [];

  const counts = new Map<string, {
    count: number;
    intentPrefix: string;
    toolSequence: string[];
  }>();

  for (const episode of successful) {
    const intentPrefix = normalizeIntent(episode.task_intent);
    const toolSequence = safeJsonParse<string[]>(episode.tool_sequence_json) ?? [];
    const stableSequence = toolSequence.slice(0, 3);
    const sequenceKey = stableSequence.length > 0 ? stableSequence.join(" → ") : "no-tools";
    const key = `${intentPrefix}::${sequenceKey}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, {
        count: 1,
        intentPrefix,
        toolSequence: stableSequence,
      });
    }
  }

  const results: ExtractedPattern[] = [];
  for (const [key, data] of counts) {
    if (data.count < 2) continue;
    results.push({
      kind: "preference",
      key: `pref:${key}`,
      description: `Repeated successful execution preference for "${data.intentPrefix}" tasks (${data.count} occurrences)`,
      pattern: {
        taskFingerprint: data.intentPrefix,
        preferredToolSequence: data.toolSequence,
        outcome: "success",
        occurrences: data.count,
      },
      confidence: Math.min(0.9, 0.35 + data.count * 0.1),
      sampleCount: data.count,
    });
  }

  results.sort((left, right) => right.sampleCount - left.sampleCount);
  return results.slice(0, 10);
}

// ─── Helpers ────────────────────────────────────────────────────

/** Normalize intent to first 3 lowercase words for clustering. */
function normalizeIntent(intent: string): string {
  return intent
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .slice(0, 3)
    .join(" ")
    .trim() || "unknown";
}

/** Deterministic pattern ID based on user + kind + key. */
function buildPatternId(userId: string, kind: string, key: string): string {
  // Simple hash to create a stable ID for upsert
  let hash = 0;
  const str = `${userId}:${kind}:${key}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return `pat_${kind}_${Math.abs(hash).toString(36)}`;
}

function defaultIdGenerator(): string {
  return `pat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function rowToPattern(row: PatternRow): FridayLearnedPattern {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as FridayLearnedPattern["kind"],
    description: row.description,
    pattern: safeJsonParse<Record<string, unknown>>(row.pattern_json) ?? {},
    confidence: row.confidence,
    sampleCount: row.sample_count,
    lastUpdated: row.last_updated,
    createdAt: row.created_at,
  };
}
