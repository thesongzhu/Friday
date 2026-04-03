/**
 * Episode Extractor — converts raw agent run events into structured
 * FridayEpisode records for world model readiness.
 *
 * Extracts tool_end events from the durable event log and compresses
 * them into ordered FridayEpisodeStep sequences.
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

// ─── Deps ───────────────────────────────────────────────────────

export interface CreateFridayEpisodeExtractorDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
}

// ─── Public interface ───────────────────────────────────────────

export interface FridayEpisodeExtractor {
  /** Build an episode from a completed/failed agent run. Returns null only when the run record does not exist. */
  extractFromRun(runId: string, userId: string): Promise<FridayEpisode | null>;
}

// ─── Raw row types ──────────────────────────────────────────────

interface RunEventRow {
  payload_json: string;
  seq: number;
}

interface RunRow {
  task: string;
  status: string;
  duration_ms: number | null;
  task_profile_json: string | null;
  context_cost_summary_json: string | null;
  response_text: string | null;
}

// ─── Factory ────────────────────────────────────────────────────

export function createFridayEpisodeExtractor(
  deps: CreateFridayEpisodeExtractorDeps,
): FridayEpisodeExtractor {
  const { db, idGenerator, nowIso } = deps;

  return {
    async extractFromRun(runId, userId) {
      // 1. Read run record for task/status/profile.
      const run = db.withReadConnection((conn) =>
        conn
          .prepare(
            `SELECT task, status, duration_ms, task_profile_json, context_cost_summary_json, response_text
             FROM friday_agent_runs
             WHERE id = ?`,
          )
          .get(runId) as RunRow | undefined,
      );

      if (!run) return null;

      // 2. Read tool events. Zero-tool completed runs are skipped later because
      // they add world-model write cost without any tool-grounded evidence.
      const events = db.withReadConnection((conn) =>
        conn
          .prepare(
            `SELECT payload_json, seq
             FROM friday_agent_run_events
             WHERE run_id = ? AND event_name = 'agent.run.tool_end'
             ORDER BY seq`,
          )
          .all(runId) as RunEventRow[],
      );

      // 3. Convert tool_end events directly into steps
      const steps = events.length > 0 ? buildSteps(events) : [];

      const trimmedResponse = run.response_text?.trim() ?? "";
      const shouldSkipLowValueEpisode =
        run.status === "completed"
        && steps.length === 0
        && (trimmedResponse.length === 0 || !trimmedResponse.startsWith("ERROR:"));
      if (shouldSkipLowValueEpisode) {
        return null;
      }

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
  for (let stepSeq = 0; stepSeq < events.length; stepSeq += 1) {
    const evt = events[stepSeq]!;
    const payload = safeJsonParse<Record<string, unknown>>(evt.payload_json) ?? {};
    const toolName = (payload.toolName as string) ?? "unknown";
    const durationMs = (payload.durationMs as number) ?? 0;
    const isError = (payload.isError as boolean) ?? false;

    // Get tool call summary if available
    const summary = payload.toolCallSummary as Record<string, unknown> | undefined;
    const category = (summary?.toolCategory as FridayEpisodeStepCategory) ?? classifyTool(toolName);
    const outputShape = (summary?.outputShape as string) ?? "text";

    steps.push({
      seq: stepSeq,
      action: toolName,
      category,
      observation: isError ? `error:${outputShape}` : outputShape,
      durationMs,
    });
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
  const components = Array.isArray(summary.components)
    ? summary.components as Array<Record<string, unknown>>
    : Array.isArray(summary.blocks)
      ? summary.blocks as Array<Record<string, unknown>>
      : [];
  return components
    .map((entry) => entry.name as string | undefined)
    .filter((n): n is string => typeof n === "string");
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
