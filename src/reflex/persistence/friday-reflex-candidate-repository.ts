import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
import type {
  FridayReflexCandidate,
  FridayReflexCandidateInput,
  FridayReflexCandidateKind,
  FridayReflexCandidateStatus,
} from "../model/friday-reflex.types.js";

interface CandidateRow {
  id: string;
  user_id: string;
  kind: string;
  status: string;
  origin: string;
  source_run_id: string | null;
  session_key: string | null;
  channel_kind: string | null;
  channel_user_id: string | null;
  title: string;
  summary: string;
  payload_json: string;
  evidence_json: string;
  confidence: number;
  risk_tier: number;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

export interface FridayReflexCandidateRepository {
  insert(
    db: Database.Database,
    input: FridayReflexCandidateInput & { id: string; nowIso: string },
  ): FridayReflexCandidate;
  list(db: Database.Database, input: {
    userId: string;
    status?: FridayReflexCandidateStatus;
    kind?: FridayReflexCandidateKind;
    limit?: number;
  }): FridayReflexCandidate[];
  getById(db: Database.Database, input: { userId: string; id: string }): FridayReflexCandidate | null;
  updateStatus(db: Database.Database, input: {
    userId: string;
    id: string;
    status: FridayReflexCandidateStatus;
    evidence?: Record<string, unknown>;
    nowIso: string;
  }): FridayReflexCandidate | null;
  updateEvidence(db: Database.Database, input: {
    userId: string;
    id: string;
    evidence: Record<string, unknown>;
    nowIso: string;
  }): FridayReflexCandidate | null;
}

const TERMINAL_STATUSES = new Set<FridayReflexCandidateStatus>([
  "approved",
  "rejected",
  "dismissed",
  "failed",
  "superseded",
]);

const ALLOWED_TRANSITIONS: Record<FridayReflexCandidateStatus, readonly FridayReflexCandidateStatus[]> = {
  proposed: ["testing", "ready_for_review", "approved", "rejected", "dismissed", "failed", "superseded"],
  testing: ["ready_for_review", "failed", "dismissed", "superseded"],
  ready_for_review: ["approved", "rejected", "dismissed", "testing", "failed", "superseded"],
  approved: [],
  rejected: [],
  dismissed: [],
  failed: ["testing", "dismissed", "superseded"],
  superseded: [],
};

function parseJsonObject(value: string): Record<string, never> | Record<string, unknown> {
  const parsed = safeJsonParse<Record<string, unknown>>(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function mapRow(row: CandidateRow): FridayReflexCandidate {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as FridayReflexCandidate["kind"],
    status: row.status as FridayReflexCandidate["status"],
    origin: row.origin as FridayReflexCandidate["origin"],
    ...(row.source_run_id ? { sourceRunId: row.source_run_id } : {}),
    ...(row.session_key ? { sessionKey: row.session_key } : {}),
    ...(row.channel_kind ? { channelKind: row.channel_kind } : {}),
    ...(row.channel_user_id ? { channelUserId: row.channel_user_id } : {}),
    title: row.title,
    summary: row.summary,
    payload: parseJsonObject(row.payload_json) as FridayReflexCandidate["payload"],
    evidence: parseJsonObject(row.evidence_json) as FridayReflexCandidate["evidence"],
    confidence: row.confidence,
    riskTier: row.risk_tier,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
  };
}

export function createFridayReflexCandidateRepository(): FridayReflexCandidateRepository {
  return {
    insert(db, input) {
      const status = input.status ?? "proposed";
      db.prepare(
        `INSERT INTO friday_reflex_candidates (
          id, user_id, kind, status, origin, source_run_id, session_key,
          channel_kind, channel_user_id, title, summary, payload_json,
          evidence_json, confidence, risk_tier, created_at, updated_at, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.userId,
        input.kind,
        status,
        input.origin,
        input.sourceRunId ?? null,
        input.sessionKey ?? null,
        input.channelKind ?? null,
        input.channelUserId ?? null,
        input.title,
        input.summary,
        JSON.stringify(input.payload ?? {}),
        JSON.stringify(input.evidence ?? {}),
        input.confidence ?? 0,
        input.riskTier ?? 0,
        input.nowIso,
        input.nowIso,
        TERMINAL_STATUSES.has(status) ? input.nowIso : null,
      );
      return this.getById(db, { userId: input.userId, id: input.id })!;
    },

    list(db, input) {
      const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
      const where = ["user_id = ?"];
      const args: unknown[] = [input.userId];
      if (input.status) {
        where.push("status = ?");
        args.push(input.status);
      }
      if (input.kind) {
        where.push("kind = ?");
        args.push(input.kind);
      }
      const rows = db.prepare(
        `SELECT * FROM friday_reflex_candidates
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT ?`,
      ).all(...args, limit) as CandidateRow[];
      return rows.map(mapRow);
    },

    getById(db, input) {
      const row = db.prepare(
        `SELECT * FROM friday_reflex_candidates
         WHERE user_id = ? AND id = ?`,
      ).get(input.userId, input.id) as CandidateRow | undefined;
      return row ? mapRow(row) : null;
    },

    updateStatus(db, input) {
      const current = this.getById(db, { userId: input.userId, id: input.id });
      if (!current) return null;
      if (!ALLOWED_TRANSITIONS[current.status].includes(input.status)) {
        throw new Error(`Invalid reflex candidate transition ${current.status} -> ${input.status}`);
      }
      const evidence = input.evidence
        ? { ...current.evidence, ...input.evidence }
        : current.evidence;
      db.prepare(
        `UPDATE friday_reflex_candidates
         SET status = ?, evidence_json = ?, updated_at = ?, decided_at = ?
         WHERE user_id = ? AND id = ?`,
      ).run(
        input.status,
        JSON.stringify(evidence),
        input.nowIso,
        TERMINAL_STATUSES.has(input.status) ? input.nowIso : current.decidedAt ?? null,
        input.userId,
        input.id,
      );
      return this.getById(db, { userId: input.userId, id: input.id });
    },

    updateEvidence(db, input) {
      const current = this.getById(db, { userId: input.userId, id: input.id });
      if (!current) return null;
      const evidence = { ...current.evidence, ...input.evidence };
      db.prepare(
        `UPDATE friday_reflex_candidates
         SET evidence_json = ?, updated_at = ?
         WHERE user_id = ? AND id = ?`,
      ).run(
        JSON.stringify(evidence),
        input.nowIso,
        input.userId,
        input.id,
      );
      return this.getById(db, { userId: input.userId, id: input.id });
    },
  };
}
