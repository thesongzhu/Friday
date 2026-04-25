import type { Database } from "better-sqlite3";

import type { FridayLearningEventLedger } from "../../ledger/learning/friday-learning-event-ledger.js";
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import {
  buildSkippedCollectionResult,
  runCollectorSafely,
  type FridayBriefCollector,
  type FridayBriefCollectorContext,
} from "./friday-brief-collector.types.js";
import type { FridayBriefEvent } from "../friday-brief.types.js";

const HEARTBEAT_TASK_PREFIX = "Run a proactive system heartbeat check";
const MAX_EVENTS_PER_RUN = 120;

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function truncate(text: string, n: number): string {
  const s = text.trim();
  return s.length > n ? `${s.slice(0, n).trim()}…` : s;
}

function taskBucketKey(task: string): string {
  return truncate(task, 70);
}

interface AgentRunRow {
  task: string | null;
  status: string | null;
  summary: string | null;
  response_text: string | null;
  created_at: string;
}

function collectAgentRuns(db: Database, fromIso: string, toIso: string): FridayBriefEvent[] {
  const rows = db
    .prepare(
      `SELECT task, status, summary, response_text, created_at
         FROM friday_agent_runs
        WHERE created_at >= ? AND created_at < ?
          AND task IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 2000`,
    )
    .all(fromIso, toIso) as AgentRunRow[];

  if (rows.length === 0) return [];

  const buckets = new Map<
    string,
    {
      task: string;
      count: number;
      completed: number;
      failed: number;
      firstAt: string;
      lastAt: string;
      sampleReply: string | null;
      isHeartbeat: boolean;
    }
  >();

  for (const row of rows) {
    const task = (row.task ?? "").trim();
    if (task.length === 0) continue;
    const isHeartbeat = task.startsWith(HEARTBEAT_TASK_PREFIX);
    const key = isHeartbeat ? "__heartbeat__" : taskBucketKey(task);
    const bucket = buckets.get(key) ?? {
      task: isHeartbeat ? "System heartbeat checks" : taskBucketKey(task),
      count: 0,
      completed: 0,
      failed: 0,
      firstAt: row.created_at,
      lastAt: row.created_at,
      sampleReply: null,
      isHeartbeat,
    };
    bucket.count += 1;
    if (row.status === "completed") bucket.completed += 1;
    else if (row.status === "failed" || row.status === "error") bucket.failed += 1;
    if (row.created_at < bucket.firstAt) bucket.firstAt = row.created_at;
    if (row.created_at > bucket.lastAt) bucket.lastAt = row.created_at;
    if (!bucket.sampleReply) {
      const reply = (row.summary ?? row.response_text ?? "").trim();
      if (reply.length > 0) bucket.sampleReply = truncate(reply, 220);
    }
    buckets.set(key, bucket);
  }

  const events: FridayBriefEvent[] = [];
  let bucketIdx = 0;
  for (const [key, bucket] of buckets.entries()) {
    const extId = `agent_runs:${bucketIdx++}:${key.slice(0, 24)}`;
    if (bucket.isHeartbeat) {
      events.push({
        source: "friday_history",
        occurredAt: bucket.lastAt,
        externalId: extId,
        summary: `Heartbeat agent cycles: ${bucket.count} runs (${bucket.completed} completed, ${bucket.failed} failed)`,
        detail: bucket.sampleReply
          ? `Last reply sample: ${bucket.sampleReply}`
          : undefined,
        tags: ["agent_run", "heartbeat"],
      });
      continue;
    }
    const statusTail = bucket.failed > 0
      ? `${bucket.completed}/${bucket.count} completed, ${bucket.failed} failed`
      : `${bucket.completed}/${bucket.count} completed`;
    events.push({
      source: "friday_history",
      occurredAt: bucket.lastAt,
      externalId: extId,
      summary: `Agent task ×${bucket.count}: "${bucket.task}" — ${statusTail}`,
      detail: bucket.sampleReply ? `Sample reply: ${bucket.sampleReply}` : undefined,
      tags: ["agent_run"],
    });
  }
  return events;
}

interface WorkflowRunRow {
  status: string;
  started_at: string;
  finished_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  workflow_name: string | null;
}

function collectWorkflowRuns(db: Database, fromIso: string, toIso: string): FridayBriefEvent[] {
  const rows = db
    .prepare(
      `SELECT wr.status, wr.started_at, wr.finished_at,
              wr.failure_code, wr.failure_message,
              COALESCE(w.name, wr.workflow_id) AS workflow_name
         FROM workflow_runs wr
         LEFT JOIN workflows w ON w.id = wr.workflow_id
        WHERE wr.started_at >= ? AND wr.started_at < ?
        ORDER BY wr.started_at DESC
        LIMIT 60`,
    )
    .all(fromIso, toIso) as WorkflowRunRow[];

  if (rows.length === 0) return [];

  const buckets = new Map<
    string,
    { name: string; status: string; count: number; lastAt: string; lastFailure: string | null }
  >();
  for (const row of rows) {
    const name = row.workflow_name ?? "unnamed workflow";
    const key = `${name}|${row.status}`;
    const bucket = buckets.get(key) ?? {
      name,
      status: row.status,
      count: 0,
      lastAt: row.started_at,
      lastFailure: null,
    };
    bucket.count += 1;
    if (row.started_at > bucket.lastAt) bucket.lastAt = row.started_at;
    if (row.failure_message && !bucket.lastFailure) {
      bucket.lastFailure = truncate(row.failure_message, 220);
    }
    buckets.set(key, bucket);
  }

  const events: FridayBriefEvent[] = [];
  let idx = 0;
  for (const [key, bucket] of buckets.entries()) {
    const suffix = bucket.count > 1 ? ` ×${bucket.count}` : "";
    events.push({
      source: "friday_history",
      occurredAt: bucket.lastAt,
      externalId: `workflow:${idx++}:${key.slice(0, 32)}`,
      summary: `Workflow "${bucket.name}" ${bucket.status}${suffix}`,
      detail: bucket.lastFailure ?? undefined,
      tags: ["workflow_run", bucket.status],
    });
  }
  return events;
}

interface IncidentRow {
  incident_id: string;
  ts: string;
  category: string;
  severity: string;
  signature: string;
  context_json: string;
  status: string;
  auto_fix_eligible: number;
}

interface AutoFixRow {
  incident_id: string;
  status: string;
  outcome: string | null;
}

interface DiagnosisRow {
  incident_id: string | null;
  confidence: number;
  diagnosis_json: string;
}

function collectIncidents(
  db: Database,
  userId: string,
  fromIso: string,
  toIso: string,
): FridayBriefEvent[] {
  const incidents = db
    .prepare(
      `SELECT incident_id, ts, category, severity, signature, context_json, status, auto_fix_eligible
         FROM error_incidents
        WHERE user_id = ? AND ts >= ? AND ts < ?
        ORDER BY ts DESC
        LIMIT 30`,
    )
    .all(userId, fromIso, toIso) as IncidentRow[];

  if (incidents.length === 0) return [];

  const ids = incidents.map((i) => i.incident_id);
  const placeholders = ids.map(() => "?").join(",");
  const fixes = db
    .prepare(
      `SELECT incident_id, status, outcome FROM auto_fix_actions
        WHERE incident_id IN (${placeholders})`,
    )
    .all(...ids) as AutoFixRow[];
  const diagnoses = db
    .prepare(
      `SELECT incident_id, confidence, diagnosis_json FROM diagnosis_records
        WHERE incident_id IN (${placeholders})`,
    )
    .all(...ids) as DiagnosisRow[];

  const fixByIncident = new Map<string, AutoFixRow>();
  for (const f of fixes) fixByIncident.set(f.incident_id, f);
  const diagByIncident = new Map<string, DiagnosisRow>();
  for (const d of diagnoses) if (d.incident_id) diagByIncident.set(d.incident_id, d);

  const events: FridayBriefEvent[] = [];
  for (const inc of incidents) {
    const ctx = parseJson<{ message?: string; errorCode?: string; errorMessage?: string }>(
      inc.context_json,
    );
    const headline = ctx?.message ?? ctx?.errorMessage ?? inc.signature;
    const fix = fixByIncident.get(inc.incident_id);
    const diag = diagByIncident.get(inc.incident_id);
    const diagCause = diag ? parseJson<{ cause?: string; fix?: string }>(diag.diagnosis_json) : null;

    const tailParts: string[] = [];
    if (fix) {
      tailParts.push(
        `auto-fix ${fix.status}${fix.outcome ? ` (${fix.outcome})` : ""}`,
      );
    }
    if (diagCause?.cause) tailParts.push(`diagnosis: ${truncate(diagCause.cause, 140)}`);
    if (diagCause?.fix) tailParts.push(`recommended fix: ${truncate(diagCause.fix, 140)}`);

    events.push({
      source: "friday_history",
      occurredAt: inc.ts,
      externalId: `incident:${inc.incident_id}`,
      actor: "friday",
      summary: `Incident (${inc.category}/${inc.severity}, ${inc.status}): ${truncate(headline ?? "unknown", 180)}`,
      detail: tailParts.length > 0 ? tailParts.join(" · ") : undefined,
      tags: ["incident", inc.category, inc.severity, inc.status],
    });
  }
  return events;
}

interface HeartbeatRow {
  status: string;
  reason: string | null;
  action_required: number;
  response_text: string | null;
  started_at: string;
}

function collectHeartbeats(db: Database, fromIso: string, toIso: string): FridayBriefEvent[] {
  const rows = db
    .prepare(
      `SELECT status, reason, action_required, response_text, started_at
         FROM friday_heartbeat_runs
        WHERE started_at >= ? AND started_at < ?
        ORDER BY started_at DESC
        LIMIT 500`,
    )
    .all(fromIso, toIso) as HeartbeatRow[];

  if (rows.length === 0) return [];

  let ok = 0;
  let error = 0;
  let skipped = 0;
  let actionRequired = 0;
  const skipReasons = new Map<string, number>();
  let lastActionText: string | null = null;
  let lastActionAt: string | null = null;
  let lastAt = rows[0].started_at;

  for (const row of rows) {
    if (row.started_at > lastAt) lastAt = row.started_at;
    if (row.status === "ok") ok += 1;
    else if (row.status === "error") error += 1;
    else if (row.status === "skipped") {
      skipped += 1;
      const reason = row.reason ?? "unknown";
      skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
    }
    if (row.action_required === 1) {
      actionRequired += 1;
      if (!lastActionText && row.response_text) {
        lastActionText = truncate(row.response_text, 240);
        lastActionAt = row.started_at;
      }
    }
  }

  const skipDetail = skipReasons.size > 0
    ? Array.from(skipReasons.entries())
        .map(([reason, count]) => `${reason}×${count}`)
        .join(", ")
    : null;
  const detailParts: string[] = [];
  if (skipDetail) detailParts.push(`skip reasons: ${skipDetail}`);
  if (lastActionText) detailParts.push(`latest action-required reply: ${lastActionText}`);

  return [
    {
      source: "friday_history",
      occurredAt: lastActionAt ?? lastAt,
      externalId: `heartbeat_summary:${fromIso}`,
      actor: "friday",
      summary: `Heartbeats: ${ok} ok, ${error} error, ${skipped} skipped${actionRequired > 0 ? `, ${actionRequired} flagged action-required` : ""}`,
      detail: detailParts.length > 0 ? detailParts.join(" · ") : undefined,
      tags: ["heartbeat"],
    },
  ];
}

interface LessonRow {
  title: string;
  cause: string;
  fix: string;
  occurrences: number;
  last_seen_at: string;
  created_at: string;
}

function collectLessons(db: Database, fromIso: string, toIso: string): FridayBriefEvent[] {
  const rows = db
    .prepare(
      `SELECT title, cause, fix, occurrences, last_seen_at, created_at
         FROM learned_lessons
        WHERE (created_at >= ? AND created_at < ?) OR (last_seen_at >= ? AND last_seen_at < ?)
        ORDER BY last_seen_at DESC
        LIMIT 20`,
    )
    .all(fromIso, toIso, fromIso, toIso) as LessonRow[];

  return rows.map((row, idx) => ({
    source: "friday_history" as const,
    occurredAt: row.last_seen_at ?? row.created_at,
    externalId: `lesson:${idx}:${truncate(row.title, 32)}`,
    actor: "friday",
    summary: `Friday learned: ${truncate(row.title, 140)} (seen ${row.occurrences}×)`,
    detail: `cause: ${truncate(row.cause, 160)} · fix: ${truncate(row.fix, 160)}`,
    tags: ["learned_lesson"],
  }));
}

interface UserTurnRow {
  content_text: string | null;
  content_json: string | null;
  created_at: string;
  session_id: string;
}

function collectUserTurns(db: Database, fromIso: string, toIso: string): FridayBriefEvent[] {
  const rows = db
    .prepare(
      `SELECT content_text, content_json, created_at, session_id
         FROM session_messages
        WHERE role = 'user'
          AND created_at >= ? AND created_at < ?
        ORDER BY created_at DESC
        LIMIT 200`,
    )
    .all(fromIso, toIso) as UserTurnRow[];

  const buckets = new Map<
    string,
    { sample: string; count: number; lastAt: string; sessions: Set<string> }
  >();

  for (const row of rows) {
    const raw = row.content_text ?? row.content_json ?? "";
    const text = raw.trim();
    if (text.length === 0) continue;
    if (text.toLowerCase().includes("heartbeat")) continue;
    const key = truncate(text, 80).toLowerCase();
    const bucket = buckets.get(key) ?? {
      sample: truncate(text, 220),
      count: 0,
      lastAt: row.created_at,
      sessions: new Set<string>(),
    };
    bucket.count += 1;
    if (row.created_at > bucket.lastAt) bucket.lastAt = row.created_at;
    bucket.sessions.add(row.session_id);
    buckets.set(key, bucket);
  }

  const events: FridayBriefEvent[] = [];
  let idx = 0;
  for (const [key, bucket] of buckets.entries()) {
    const suffix = bucket.count > 1 ? ` ×${bucket.count}` : "";
    events.push({
      source: "friday_history",
      occurredAt: bucket.lastAt,
      externalId: `user_turn:${idx++}:${key.slice(0, 32)}`,
      actor: "user",
      summary: `You asked${suffix}: ${bucket.sample}`,
      tags: ["user_message"],
    });
  }
  return events;
}

export interface FridayBriefFridayHistoryCollectorDeps {
  ledger: FridayLearningEventLedger;
  stateDb?: FridaySqliteLayer;
}

export function createFridayBriefFridayHistoryCollector(
  deps: FridayBriefFridayHistoryCollectorDeps,
): FridayBriefCollector {
  return {
    source: "friday_history",
    isEnabled(config) {
      return config.sources.friday_history.enabled;
    },
    async collect(ctx: FridayBriefCollectorContext) {
      const cfg = ctx.config.sources.friday_history;
      if (!cfg.enabled) return buildSkippedCollectionResult("friday_history", "source_disabled");

      return runCollectorSafely("friday_history", async () => {
        const events: FridayBriefEvent[] = [];
        if (deps.stateDb) {
          deps.stateDb.withReadConnection((db) => {
            events.push(...collectAgentRuns(db, ctx.fromIso, ctx.toIso));
            events.push(...collectWorkflowRuns(db, ctx.fromIso, ctx.toIso));
            events.push(...collectIncidents(db, ctx.userId, ctx.fromIso, ctx.toIso));
            events.push(...collectHeartbeats(db, ctx.fromIso, ctx.toIso));
            events.push(...collectLessons(db, ctx.fromIso, ctx.toIso));
            events.push(...collectUserTurns(db, ctx.fromIso, ctx.toIso));
          });
        }
        events.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
        return { events: events.slice(0, MAX_EVENTS_PER_RUN) };
      });
    },
  };
}
