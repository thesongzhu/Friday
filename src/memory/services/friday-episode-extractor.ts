/**
 * Episode Extractor — converts raw agent run events into structured
 * FridayEpisode records for world model readiness.
 *
 * Extracts tool_start/tool_end event pairs from the durable event log
 * and compresses them into ordered FridayEpisodeStep sequences.
 * Only non-sensitive summaries are captured (tool name, category,
 * output shape — never raw arguments or result content).
 */

import type Database from "better-sqlite3";
import type { FridaySqliteLayer } from "#state";
import type {
  FridayEpisode,
  FridayEpisodeOutcome,
  FridayEpisodeStep,
  FridayEpisodeStepCategory,
} from "../../agent/model/friday-agent-world-state.types.js";
import { safeJsonParse } from "#utilities";
import { isFridaySensitiveLearningCandidate } from "../../learning/services/friday-sensitive-learning-guard.js";
import { assertTsDurableMemoryWriteEnabled } from "../guard/friday-ts-durable-memory-write-guard.js";

// ─── Deps ───────────────────────────────────────────────────────

export interface CreateFridayEpisodeExtractorDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  tsMemoryWritesEnabled?: boolean;
}

// ─── Public interface ───────────────────────────────────────────

export interface FridayEpisodeExtractor {
  /** Build an episode from a completed/failed agent run. Returns null only when the run record does not exist. */
  extractFromRun(runId: string, userId: string): Promise<FridayEpisode | null>;
}

// ─── Raw row types ──────────────────────────────────────────────

interface RunEventRow {
  event_name: string;
  payload_json: string;
  seq: number;
}

interface RunRow {
  task: string;
  status: string;
  duration_ms: number | null;
  task_profile_json: string | null;
  context_cost_summary_json: string | null;
}

// ─── Factory ────────────────────────────────────────────────────

export function createFridayEpisodeExtractor(
  deps: CreateFridayEpisodeExtractorDeps,
): FridayEpisodeExtractor {
  const { db, idGenerator, nowIso } = deps;
  const tsMemoryWritesEnabled = deps.tsMemoryWritesEnabled === true;

  return {
    async extractFromRun(runId, userId) {
      // 1. Read run record for task/status/profile.
      const run = db.withReadConnection((conn) =>
        conn
          .prepare(
            `SELECT task, status, duration_ms, task_profile_json, context_cost_summary_json
             FROM friday_agent_runs
             WHERE id = ?`,
          )
          .get(runId) as RunRow | undefined,
      );

      if (!run) return null;
      if (isFridaySensitiveLearningCandidate(run.task) || isFridayUntrustedSourceLearningCandidate(run.task)) {
        return null;
      }

      // 2. Read tool events (best-effort; a run with no tool events still
      // produces a minimal episode so world-model readiness is visible in
      // real end-to-end flows).
      const events = db.withReadConnection((conn) =>
        conn
          .prepare(
            `SELECT event_name, payload_json, seq
             FROM friday_agent_run_events
             WHERE run_id = ? AND event_name IN ('agent.run.tool_start', 'agent.run.tool_end')
             ORDER BY seq`,
          )
          .all(runId) as RunEventRow[],
      );

      // 3. Pair tool_start → tool_end into steps
      const steps = events.length > 0 ? buildSteps(events) : [];

      // 4. Derive outcome
      const outcome = deriveOutcome(run.status);

      // 5. Extract task profile
      const profileJson = run.task_profile_json
        ? safeJsonParse<Record<string, unknown>>(run.task_profile_json)
        : null;
      const taskProfile = profileJson?.id as string | undefined;

      // 6. Extract context file names
      const contextFiles = extractContextFiles(run.context_cost_summary_json);

      // 7. Build episode
      const episode: FridayEpisode = {
        id: idGenerator(),
        userId,
        runId,
        taskIntent: run.task,
        taskProfile,
        outcome,
        steps,
        toolSequence: steps.map((s) => s.action),
        durationMs: run.duration_ms ?? 0,
        contextFiles,
        createdAt: nowIso(),
      };

      // 8. Persist and prune old episodes
      assertTsDurableMemoryWriteEnabled(tsMemoryWritesEnabled, "memory.episodeExtractor.persist");
      db.withWriteTransaction((conn) => {
        insertEpisode(conn, episode);

        // Keep last 500 episodes per user
        conn
          .prepare(
            `DELETE FROM friday_episodes
             WHERE user_id = ? AND id NOT IN (
               SELECT id FROM friday_episodes
               WHERE user_id = ? ORDER BY created_at DESC LIMIT 500
             )`,
          )
          .run(userId, userId);
      });

      return episode;
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function buildSteps(events: RunEventRow[]): FridayEpisodeStep[] {
  const steps: FridayEpisodeStep[] = [];
  const pending = new Map<string, { toolName: string; seq: number }>();

  let stepSeq = 0;

  for (const evt of events) {
    const payload = safeJsonParse<Record<string, unknown>>(evt.payload_json) ?? {};

    if (evt.event_name === "agent.run.tool_start") {
      const toolCallId = payload.toolCallId as string | undefined;
      const toolName = payload.toolName as string | undefined;
      if (toolCallId && toolName) {
        pending.set(toolCallId, { toolName, seq: evt.seq });
      }
    } else if (evt.event_name === "agent.run.tool_end") {
      const toolCallId = payload.toolCallId as string | undefined;
      const toolName = (payload.toolName as string) ?? "unknown";
      const durationMs = (payload.durationMs as number) ?? 0;
      const isError = (payload.isError as boolean) ?? false;

      // Get tool call summary if available
      const summary = payload.toolCallSummary as Record<string, unknown> | undefined;
      const category = (summary?.toolCategory as FridayEpisodeStepCategory) ?? classifyTool(toolName);
      const outputShape = (summary?.outputShape as string) ?? "text";

      if (toolCallId) pending.delete(toolCallId);

      steps.push({
        seq: stepSeq++,
        action: toolName,
        category,
        observation: isError ? `error:${outputShape}` : outputShape,
        durationMs,
      });
    }
  }

  return steps;
}

function deriveOutcome(status: string): FridayEpisodeOutcome {
  if (status === "completed") return "success";
  if (status === "failed" || status === "cancelled") return "failure";
  return "partial";
}

function extractContextFiles(contextCostSummaryJson: string | null): string[] {
  if (!contextCostSummaryJson) return [];
  const summary = safeJsonParse<Record<string, unknown>>(contextCostSummaryJson);
  if (!summary) return [];
  // Extract file names from context cost summary blocks
  const blocks = summary.blocks as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(blocks)) return [];
  return blocks
    .map((b) => b.name as string | undefined)
    .filter((n): n is string => typeof n === "string");
}

const EXTERNAL_SOURCE_REVIEW_WORLD_MODEL_PATTERN =
  /\b(?:source[-\s]?review|recommendation|recommendations|evaluate|review|compare)\b[\s\S]{0,240}\b(?:web_fetch|fetch|fetched|source|url|urls|https?:\/\/)\b|\b(?:web_fetch|fetch|fetched|source|url|urls|https?:\/\/)\b[\s\S]{0,240}\b(?:source[-\s]?review|recommendation|recommendations|evaluate|review|compare)\b/i;

const UNTRUSTED_SOURCE_WORLD_MODEL_PATTERNS = [
  /\bfetched\s+(?:page\s+)?bodies?\s+as\s+untrusted\b/i,
  /\buntrusted\s+(?:web|source|page|document|tool)\s+content\b/i,
  /\bprompt\s+injection\b/i,
  /\bignore\s+(?:all|previous|prior)\s+instructions\b/i,
  /\bsystem\s+override\b/i,
  /\bmemory_store\b/i,
  /\bfeedback\b[\s\S]{0,120}\bpersist\b/i,
  /\blong[- ]term preferences?\b/i,
];

function isFridayUntrustedSourceLearningCandidate(task: string): boolean {
  return EXTERNAL_SOURCE_REVIEW_WORLD_MODEL_PATTERN.test(task)
    && UNTRUSTED_SOURCE_WORLD_MODEL_PATTERNS.some((pattern) => pattern.test(task));
}

const READ_TOOLS = new Set(["read", "glob", "grep", "web_fetch", "web_search", "skills_list"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const QUERY_TOOLS = new Set(["system", "todo_read"]);
const NAVIGATE_TOOLS = new Set(["browser", "canvas", "desktop"]);
const MUTATE_TOOLS = new Set(["exec", "shell", "skill_run", "workflow_run", "todo_write"]);

function classifyTool(toolName: string): FridayEpisodeStepCategory {
  if (READ_TOOLS.has(toolName)) return "read";
  if (WRITE_TOOLS.has(toolName)) return "write";
  if (QUERY_TOOLS.has(toolName)) return "query";
  if (NAVIGATE_TOOLS.has(toolName)) return "navigate";
  if (MUTATE_TOOLS.has(toolName)) return "mutate";
  return "other";
}

function insertEpisode(db: Database.Database, ep: FridayEpisode): void {
  db.prepare(
    `INSERT INTO friday_episodes
       (id, user_id, run_id, task_intent, task_profile, outcome,
        steps_json, tool_sequence_json, duration_ms, context_files_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ep.id,
    ep.userId,
    ep.runId,
    ep.taskIntent,
    ep.taskProfile ?? null,
    ep.outcome,
    JSON.stringify(ep.steps),
    JSON.stringify(ep.toolSequence),
    ep.durationMs,
    JSON.stringify(ep.contextFiles),
    ep.createdAt,
  );
}
