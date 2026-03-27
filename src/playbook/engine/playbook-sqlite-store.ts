import type Database from "better-sqlite3";
import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";

import type {
  FridayPlaybook,
  FridayPlaybookCandidate,
  FridayPlaybookCandidateRow,
  FridayPlaybookCandidateStatus,
  FridayPlaybookCostDimensions,
  FridayPlaybookLifecycleEvent,
  FridayPlaybookLifecycleEventRow,
  FridayPlaybookMatch,
  FridayPlaybookRow,
  FridayPlaybookScore,
  FridayPlaybookScoreRow,
  FridayPlaybookSelectionRow,
  FridayPlaybookStatus,
  FridayPlaybookVersion,
  FridayPlaybookVersionRow,
  FridayPromotionDecision,
  FridayPromotionDecisionRow,
  JsonObject,
  JsonValue,
  UUID,
} from "../model/friday-playbook.types.js";
import type { PlaybookStore } from "./playbook-store.js";

interface SqlitePlaybookStoreDeps {
  db: Pick<FridaySqliteLayer, "withReadConnection" | "withWriteTransaction">;
}

function parseJsonValue(raw: string | null | undefined): JsonValue {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as JsonValue;
  } catch (err) {
    console.warn("[friday][playbook-sqlite-store] JSON parse failed:", err instanceof Error ? err.message : String(err));
    return {};
  }
}

function parseJsonObject(raw: string | null | undefined): JsonObject {
  const parsed = parseJsonValue(raw);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as JsonObject
    : {};
}

function parseStringArray(raw: string | null | undefined): string[] {
  const parsed = parseJsonValue(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

function parseCostDimensions(raw: string | null | undefined): FridayPlaybookCostDimensions {
  const parsed = parseJsonObject(raw);
  return {
    tokenCost: typeof parsed.tokenCost === "number" ? parsed.tokenCost : 0,
    apiCallCost: typeof parsed.apiCallCost === "number" ? parsed.apiCallCost : 0,
    latencyMs: typeof parsed.latencyMs === "number" ? parsed.latencyMs : 0,
  };
}

function asNullableString(value: string | undefined): string | null {
  return value ?? null;
}

function mapPlaybookRow(row: FridayPlaybookRow): FridayPlaybook {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    workflowType: row.workflow_type,
    tags: parseStringArray(row.tags_json),
    status: row.status as FridayPlaybookStatus,
    activeVersionNumber: row.active_version_number,
    sourceCandidateId: row.source_candidate_id,
    compositeScore: row.composite_score,
    totalUses: row.total_uses,
    totalSuccesses: row.total_successes,
    lastUsedAt: row.last_used_at ?? undefined,
    lastSuccessfulAt: row.last_successful_at ?? undefined,
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
  };
}

function mapCandidateRow(row: FridayPlaybookCandidateRow): FridayPlaybookCandidate {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    workflowType: row.workflow_type,
    tags: parseStringArray(row.tags_json),
    pattern: parseJsonObject(row.pattern_json),
    status: row.status as FridayPlaybookCandidateStatus,
    evidenceCount: row.evidence_count,
    successCount: row.success_count,
    failureCount: row.failure_count,
    totalDurationMs: row.total_duration_ms,
    totalCost: parseCostDimensions(row.total_cost_json),
    sourceRunIds: parseStringArray(row.source_run_ids_json),
    promotedPlaybookId: row.promoted_playbook_id ?? undefined,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersionRow(row: FridayPlaybookVersionRow): FridayPlaybookVersion {
  return {
    id: row.id,
    playbookId: row.playbook_id,
    versionNumber: row.version_number,
    fingerprint: row.fingerprint,
    pattern: parseJsonObject(row.pattern_json),
    candidateId: row.candidate_id,
    changeNote: row.change_note ?? undefined,
    createdAt: row.created_at,
  };
}

function mapScoreRow(row: FridayPlaybookScoreRow): FridayPlaybookScore {
  return {
    id: row.id,
    playbookId: row.playbook_id,
    versionNumber: row.version_number,
    compositeScore: row.composite_score,
    successRate: row.success_rate,
    speedScore: row.speed_score,
    costEfficiencyScore: row.cost_efficiency_score,
    satisfactionScore: row.satisfaction_score,
    sampleSize: row.sample_size,
    calculatedAt: row.calculated_at,
  };
}

function mapSelectionRow(row: FridayPlaybookSelectionRow): FridayPlaybookMatch {
  return {
    id: row.id,
    runId: row.run_id,
    workflowId: row.workflow_id,
    playbookId: row.playbook_id,
    versionNumber: row.version_number,
    matchScore: row.match_score,
    similarity: row.similarity,
    reason: row.reason as FridayPlaybookMatch["reason"],
    context: parseJsonObject(row.context_json) as unknown as FridayPlaybookMatch["context"],
    selectedAt: row.selected_at,
  };
}

function mapDecisionRow(row: FridayPromotionDecisionRow): FridayPromotionDecision {
  const serializedRuleResults = row.rule_results_json ?? row.rules_result_json ?? "[]";
  return {
    id: row.id,
    candidateId: row.candidate_id,
    decision: row.decision as FridayPromotionDecision["decision"],
    reason: row.reason,
    ruleResults: (parseJsonValue(serializedRuleResults) as unknown as FridayPromotionDecision["ruleResults"]) ?? [],
    scoreSnapshot: parseJsonObject(row.score_snapshot_json) as unknown as FridayPlaybookScore,
    decidedAt: row.decided_at,
  };
}

function mapLifecycleEventRow(row: FridayPlaybookLifecycleEventRow): FridayPlaybookLifecycleEvent {
  return {
    id: row.id,
    playbookId: row.playbook_id,
    type: row.type as FridayPlaybookLifecycleEvent["type"],
    reason: row.reason,
    fromVersionNumber: row.from_version_number,
    toVersionNumber: row.to_version_number,
    occurredAt: row.occurred_at,
  };
}

function hasPlaybookTables(db: Database.Database): boolean {
  const tables = [
    "playbook_candidates",
    "playbooks",
    "playbook_versions",
    "playbook_scores",
    "playbook_selections",
    "promotion_decisions",
    "playbook_lifecycle_events",
  ];
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN (${tables.map(() => "?").join(",")})`,
  ).get(...tables) as { count: number };
  return row.count === tables.length;
}

export function createSqlitePlaybookStore(deps: SqlitePlaybookStoreDeps): PlaybookStore {
  deps.db.withReadConnection((db) => {
    if (!hasPlaybookTables(db)) {
      throw new FridayDomainError("NOT_INITIALIZED", "PLAYBOOK_TABLES_NOT_AVAILABLE", { httpStatus: 503 });
    }
  });

  return {
    getPlaybook(id) {
      return deps.db.withReadConnection((db) => {
        const row = db.prepare(
          `SELECT * FROM playbooks WHERE id = ?`,
        ).get(id) as FridayPlaybookRow | undefined;
        return row ? mapPlaybookRow(row) : undefined;
      });
    },

    getPlaybooksByWorkflowType(workflowType, status) {
      return deps.db.withReadConnection((db) => {
        const rows = status === undefined
          ? db.prepare(
            `SELECT * FROM playbooks WHERE workflow_type = ? ORDER BY updated_at DESC, id ASC`,
          ).all(workflowType)
          : db.prepare(
            `SELECT * FROM playbooks WHERE workflow_type = ? AND status = ? ORDER BY updated_at DESC, id ASC`,
          ).all(workflowType, status);
        return (rows as FridayPlaybookRow[]).map((row) => mapPlaybookRow(row));
      });
    },

    getAllPlaybooks(status) {
      return deps.db.withReadConnection((db) => {
        const rows = status === undefined
          ? db.prepare(
            `SELECT * FROM playbooks ORDER BY updated_at DESC, id ASC`,
          ).all()
          : db.prepare(
            `SELECT * FROM playbooks WHERE status = ? ORDER BY updated_at DESC, id ASC`,
          ).all(status);
        return (rows as FridayPlaybookRow[]).map((row) => mapPlaybookRow(row));
      });
    },

    savePlaybook(playbook) {
      deps.db.withWriteTransaction((db) => {
        db.prepare(`
          INSERT INTO playbooks (
            id, name, description, workflow_type, tags_json, status,
            active_version_number, source_candidate_id, composite_score,
            total_uses, total_successes, last_used_at, last_successful_at,
            etag, created_at, updated_at, archived_at
          )
          VALUES (
            @id, @name, @description, @workflow_type, @tags_json, @status,
            @active_version_number, @source_candidate_id, @composite_score,
            @total_uses, @total_successes, @last_used_at, @last_successful_at,
            @etag, @created_at, @updated_at, @archived_at
          )
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            workflow_type = excluded.workflow_type,
            tags_json = excluded.tags_json,
            status = excluded.status,
            active_version_number = excluded.active_version_number,
            source_candidate_id = excluded.source_candidate_id,
            composite_score = excluded.composite_score,
            total_uses = excluded.total_uses,
            total_successes = excluded.total_successes,
            last_used_at = excluded.last_used_at,
            last_successful_at = excluded.last_successful_at,
            etag = excluded.etag,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            archived_at = excluded.archived_at
        `).run({
          id: playbook.id,
          name: playbook.name,
          description: asNullableString(playbook.description),
          workflow_type: playbook.workflowType,
          tags_json: JSON.stringify(playbook.tags),
          status: playbook.status,
          active_version_number: playbook.activeVersionNumber,
          source_candidate_id: playbook.sourceCandidateId,
          composite_score: playbook.compositeScore,
          total_uses: playbook.totalUses,
          total_successes: playbook.totalSuccesses,
          last_used_at: asNullableString(playbook.lastUsedAt),
          last_successful_at: asNullableString(playbook.lastSuccessfulAt),
          etag: playbook.etag,
          created_at: playbook.createdAt,
          updated_at: playbook.updatedAt,
          archived_at: asNullableString(playbook.archivedAt),
        });
      });
    },

    deletePlaybook(id) {
      return deps.db.withWriteTransaction((db) => {
        db.prepare(`DELETE FROM playbook_selections WHERE playbook_id = ?`).run(id);
        db.prepare(`DELETE FROM playbook_scores WHERE playbook_id = ?`).run(id);
        db.prepare(`DELETE FROM playbook_versions WHERE playbook_id = ?`).run(id);
        db.prepare(`DELETE FROM playbook_lifecycle_events WHERE playbook_id = ?`).run(id);
        db.prepare(`UPDATE playbook_candidates SET promoted_playbook_id = NULL WHERE promoted_playbook_id = ?`).run(id);
        const result = db.prepare(`DELETE FROM playbooks WHERE id = ?`).run(id);
        return result.changes > 0;
      });
    },

    getCandidate(id) {
      return deps.db.withReadConnection((db) => {
        const row = db.prepare(
          `SELECT * FROM playbook_candidates WHERE id = ?`,
        ).get(id) as FridayPlaybookCandidateRow | undefined;
        return row ? mapCandidateRow(row) : undefined;
      });
    },

    getCandidateByFingerprint(fingerprint, workflowType) {
      return deps.db.withReadConnection((db) => {
        const row = workflowType === undefined
          ? db.prepare(
            `SELECT * FROM playbook_candidates
             WHERE fingerprint = ?
             ORDER BY updated_at DESC, rowid DESC
             LIMIT 1`,
          ).get(fingerprint)
          : db.prepare(
            `SELECT * FROM playbook_candidates
             WHERE fingerprint = ? AND workflow_type = ?
             ORDER BY updated_at DESC, rowid DESC
             LIMIT 1`,
          ).get(fingerprint, workflowType);
        return row ? mapCandidateRow(row as FridayPlaybookCandidateRow) : undefined;
      });
    },

    getCandidatesByStatus(status) {
      return deps.db.withReadConnection((db) => {
        const rows = db.prepare(
          `SELECT * FROM playbook_candidates
           WHERE status = ?
           ORDER BY updated_at DESC, id ASC`,
        ).all(status) as FridayPlaybookCandidateRow[];
        return rows.map((row) => mapCandidateRow(row));
      });
    },

    getCandidatesByWorkflowType(workflowType) {
      return deps.db.withReadConnection((db) => {
        const rows = db.prepare(
          `SELECT * FROM playbook_candidates
           WHERE workflow_type = ?
           ORDER BY updated_at DESC, id ASC`,
        ).all(workflowType) as FridayPlaybookCandidateRow[];
        return rows.map((row) => mapCandidateRow(row));
      });
    },

    saveCandidate(candidate) {
      deps.db.withWriteTransaction((db) => {
        db.prepare(`
          INSERT INTO playbook_candidates (
            id, fingerprint, workflow_type, tags_json, pattern_json, status,
            evidence_count, success_count, failure_count, total_duration_ms,
            total_cost_json, source_run_ids_json, promoted_playbook_id,
            first_observed_at, last_observed_at, created_at, updated_at
          )
          VALUES (
            @id, @fingerprint, @workflow_type, @tags_json, @pattern_json, @status,
            @evidence_count, @success_count, @failure_count, @total_duration_ms,
            @total_cost_json, @source_run_ids_json, @promoted_playbook_id,
            @first_observed_at, @last_observed_at, @created_at, @updated_at
          )
          ON CONFLICT(id) DO UPDATE SET
            fingerprint = excluded.fingerprint,
            workflow_type = excluded.workflow_type,
            tags_json = excluded.tags_json,
            pattern_json = excluded.pattern_json,
            status = excluded.status,
            evidence_count = excluded.evidence_count,
            success_count = excluded.success_count,
            failure_count = excluded.failure_count,
            total_duration_ms = excluded.total_duration_ms,
            total_cost_json = excluded.total_cost_json,
            source_run_ids_json = excluded.source_run_ids_json,
            promoted_playbook_id = excluded.promoted_playbook_id,
            first_observed_at = excluded.first_observed_at,
            last_observed_at = excluded.last_observed_at,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        `).run({
          id: candidate.id,
          fingerprint: candidate.fingerprint,
          workflow_type: candidate.workflowType,
          tags_json: JSON.stringify(candidate.tags),
          pattern_json: JSON.stringify(candidate.pattern),
          status: candidate.status,
          evidence_count: candidate.evidenceCount,
          success_count: candidate.successCount,
          failure_count: candidate.failureCount,
          total_duration_ms: candidate.totalDurationMs,
          total_cost_json: JSON.stringify(candidate.totalCost),
          source_run_ids_json: JSON.stringify(candidate.sourceRunIds),
          promoted_playbook_id: asNullableString(candidate.promotedPlaybookId),
          first_observed_at: candidate.firstObservedAt,
          last_observed_at: candidate.lastObservedAt,
          created_at: candidate.createdAt,
          updated_at: candidate.updatedAt,
        });
      });
    },

    deleteCandidate(id) {
      return deps.db.withWriteTransaction((db) => {
        const result = db.prepare(`DELETE FROM playbook_candidates WHERE id = ?`).run(id);
        return result.changes > 0;
      });
    },

    getVersion(id) {
      return deps.db.withReadConnection((db) => {
        const row = db.prepare(
          `SELECT * FROM playbook_versions WHERE id = ?`,
        ).get(id) as FridayPlaybookVersionRow | undefined;
        return row ? mapVersionRow(row) : undefined;
      });
    },

    getVersionsByPlaybookId(playbookId) {
      return deps.db.withReadConnection((db) => {
        const rows = db.prepare(
          `SELECT * FROM playbook_versions
           WHERE playbook_id = ?
           ORDER BY version_number ASC`,
        ).all(playbookId) as FridayPlaybookVersionRow[];
        return rows.map((row) => mapVersionRow(row));
      });
    },

    getVersionByNumber(playbookId, versionNumber) {
      return deps.db.withReadConnection((db) => {
        const row = db.prepare(
          `SELECT * FROM playbook_versions
           WHERE playbook_id = ? AND version_number = ?
           LIMIT 1`,
        ).get(playbookId, versionNumber) as FridayPlaybookVersionRow | undefined;
        return row ? mapVersionRow(row) : undefined;
      });
    },

    getLatestVersion(playbookId) {
      return deps.db.withReadConnection((db) => {
        const row = db.prepare(
          `SELECT * FROM playbook_versions
           WHERE playbook_id = ?
           ORDER BY version_number DESC
           LIMIT 1`,
        ).get(playbookId) as FridayPlaybookVersionRow | undefined;
        return row ? mapVersionRow(row) : undefined;
      });
    },

    saveVersion(version) {
      deps.db.withWriteTransaction((db) => {
        db.prepare(`
          INSERT INTO playbook_versions (
            id, playbook_id, version_number, fingerprint, pattern_json,
            candidate_id, change_note, created_at
          )
          VALUES (
            @id, @playbook_id, @version_number, @fingerprint, @pattern_json,
            @candidate_id, @change_note, @created_at
          )
          ON CONFLICT(id) DO UPDATE SET
            playbook_id = excluded.playbook_id,
            version_number = excluded.version_number,
            fingerprint = excluded.fingerprint,
            pattern_json = excluded.pattern_json,
            candidate_id = excluded.candidate_id,
            change_note = excluded.change_note,
            created_at = excluded.created_at
        `).run({
          id: version.id,
          playbook_id: version.playbookId,
          version_number: version.versionNumber,
          fingerprint: version.fingerprint,
          pattern_json: JSON.stringify(version.pattern),
          candidate_id: version.candidateId,
          change_note: asNullableString(version.changeNote),
          created_at: version.createdAt,
        });
      });
    },

    getScore(id) {
      return deps.db.withReadConnection((db) => {
        const row = db.prepare(
          `SELECT * FROM playbook_scores WHERE id = ?`,
        ).get(id) as FridayPlaybookScoreRow | undefined;
        return row ? mapScoreRow(row) : undefined;
      });
    },

    getScoresByPlaybookId(playbookId) {
      return deps.db.withReadConnection((db) => {
        const rows = db.prepare(
          `SELECT * FROM playbook_scores
           WHERE playbook_id = ?
           ORDER BY calculated_at ASC, id ASC`,
        ).all(playbookId) as FridayPlaybookScoreRow[];
        return rows.map((row) => mapScoreRow(row));
      });
    },

    getLatestScore(playbookId) {
      return deps.db.withReadConnection((db) => {
        const row = db.prepare(
          `SELECT * FROM playbook_scores
           WHERE playbook_id = ?
           ORDER BY calculated_at DESC, id DESC
           LIMIT 1`,
        ).get(playbookId) as FridayPlaybookScoreRow | undefined;
        return row ? mapScoreRow(row) : undefined;
      });
    },

    saveScore(score) {
      if (!score.playbookId || score.versionNumber === null) {
        return;
      }
      deps.db.withWriteTransaction((db) => {
        db.prepare(`
          INSERT INTO playbook_scores (
            id, playbook_id, version_number, composite_score,
            success_rate, speed_score, cost_efficiency_score,
            satisfaction_score, sample_size, calculated_at
          )
          VALUES (
            @id, @playbook_id, @version_number, @composite_score,
            @success_rate, @speed_score, @cost_efficiency_score,
            @satisfaction_score, @sample_size, @calculated_at
          )
          ON CONFLICT(id) DO UPDATE SET
            playbook_id = excluded.playbook_id,
            version_number = excluded.version_number,
            composite_score = excluded.composite_score,
            success_rate = excluded.success_rate,
            speed_score = excluded.speed_score,
            cost_efficiency_score = excluded.cost_efficiency_score,
            satisfaction_score = excluded.satisfaction_score,
            sample_size = excluded.sample_size,
            calculated_at = excluded.calculated_at
        `).run({
          id: score.id,
          playbook_id: score.playbookId,
          version_number: score.versionNumber,
          composite_score: score.compositeScore,
          success_rate: score.successRate,
          speed_score: score.speedScore,
          cost_efficiency_score: score.costEfficiencyScore,
          satisfaction_score: score.satisfactionScore,
          sample_size: score.sampleSize,
          calculated_at: score.calculatedAt,
        });
      });
    },

    getMatch(id) {
      return deps.db.withReadConnection((db) => {
        const row = db.prepare(
          `SELECT * FROM playbook_selections WHERE id = ?`,
        ).get(id) as FridayPlaybookSelectionRow | undefined;
        return row ? mapSelectionRow(row) : undefined;
      });
    },

    getMatchesByPlaybookId(playbookId) {
      return deps.db.withReadConnection((db) => {
        const rows = db.prepare(
          `SELECT * FROM playbook_selections
           WHERE playbook_id = ?
           ORDER BY selected_at ASC, id ASC`,
        ).all(playbookId) as FridayPlaybookSelectionRow[];
        return rows.map((row) => mapSelectionRow(row));
      });
    },

    getMatchesByRunId(runId) {
      return deps.db.withReadConnection((db) => {
        const rows = db.prepare(
          `SELECT * FROM playbook_selections
           WHERE run_id = ?
           ORDER BY selected_at ASC, id ASC`,
        ).all(runId) as FridayPlaybookSelectionRow[];
        return rows.map((row) => mapSelectionRow(row));
      });
    },

    saveMatch(match) {
      deps.db.withWriteTransaction((db) => {
        db.prepare(`
          INSERT INTO playbook_selections (
            id, run_id, workflow_id, playbook_id, version_number,
            match_score, similarity, reason, context_json, selected_at
          )
          VALUES (
            @id, @run_id, @workflow_id, @playbook_id, @version_number,
            @match_score, @similarity, @reason, @context_json, @selected_at
          )
          ON CONFLICT(id) DO UPDATE SET
            run_id = excluded.run_id,
            workflow_id = excluded.workflow_id,
            playbook_id = excluded.playbook_id,
            version_number = excluded.version_number,
            match_score = excluded.match_score,
            similarity = excluded.similarity,
            reason = excluded.reason,
            context_json = excluded.context_json,
            selected_at = excluded.selected_at
        `).run({
          id: match.id,
          run_id: match.runId,
          workflow_id: match.workflowId,
          playbook_id: match.playbookId,
          version_number: match.versionNumber,
          match_score: match.matchScore,
          similarity: match.similarity,
          reason: match.reason,
          context_json: JSON.stringify(match.context),
          selected_at: match.selectedAt,
        });
      });
    },

    getDecision(id) {
      return deps.db.withReadConnection((db) => {
        const row = db.prepare(
          `SELECT * FROM promotion_decisions WHERE id = ?`,
        ).get(id) as FridayPromotionDecisionRow | undefined;
        return row ? mapDecisionRow(row) : undefined;
      });
    },

    getDecisionsByCandidateId(candidateId) {
      return deps.db.withReadConnection((db) => {
        const rows = db.prepare(
          `SELECT * FROM promotion_decisions
           WHERE candidate_id = ?
           ORDER BY decided_at ASC, id ASC`,
        ).all(candidateId) as FridayPromotionDecisionRow[];
        return rows.map((row) => mapDecisionRow(row));
      });
    },

    saveDecision(decision) {
      deps.db.withWriteTransaction((db) => {
        const serializedRuleResults = JSON.stringify(decision.ruleResults);
        db.prepare(`
          INSERT INTO promotion_decisions (
            id, candidate_id, decision, reason, rule_results_json,
            rules_result_json, score_snapshot_json, decided_at
          )
          VALUES (
            @id, @candidate_id, @decision, @reason, @rule_results_json,
            @rules_result_json, @score_snapshot_json, @decided_at
          )
          ON CONFLICT(id) DO UPDATE SET
            candidate_id = excluded.candidate_id,
            decision = excluded.decision,
            reason = excluded.reason,
            rule_results_json = excluded.rule_results_json,
            rules_result_json = excluded.rules_result_json,
            score_snapshot_json = excluded.score_snapshot_json,
            decided_at = excluded.decided_at
        `).run({
          id: decision.id,
          candidate_id: decision.candidateId,
          decision: decision.decision,
          reason: decision.reason,
          rule_results_json: serializedRuleResults,
          rules_result_json: serializedRuleResults,
          score_snapshot_json: JSON.stringify(decision.scoreSnapshot),
          decided_at: decision.decidedAt,
        });
      });
    },

    getLifecycleEvent(id) {
      return deps.db.withReadConnection((db) => {
        const row = db.prepare(
          `SELECT * FROM playbook_lifecycle_events WHERE id = ?`,
        ).get(id) as FridayPlaybookLifecycleEventRow | undefined;
        return row ? mapLifecycleEventRow(row) : undefined;
      });
    },

    getLifecycleEventsByPlaybookId(playbookId) {
      return deps.db.withReadConnection((db) => {
        const rows = db.prepare(
          `SELECT * FROM playbook_lifecycle_events
           WHERE playbook_id = ?
           ORDER BY occurred_at ASC, id ASC`,
        ).all(playbookId) as FridayPlaybookLifecycleEventRow[];
        return rows.map((row) => mapLifecycleEventRow(row));
      });
    },

    saveLifecycleEvent(event) {
      deps.db.withWriteTransaction((db) => {
        db.prepare(`
          INSERT INTO playbook_lifecycle_events (
            id, playbook_id, type, reason,
            from_version_number, to_version_number, occurred_at
          )
          VALUES (
            @id, @playbook_id, @type, @reason,
            @from_version_number, @to_version_number, @occurred_at
          )
          ON CONFLICT(id) DO UPDATE SET
            playbook_id = excluded.playbook_id,
            type = excluded.type,
            reason = excluded.reason,
            from_version_number = excluded.from_version_number,
            to_version_number = excluded.to_version_number,
            occurred_at = excluded.occurred_at
        `).run({
          id: event.id,
          playbook_id: event.playbookId,
          type: event.type,
          reason: event.reason,
          from_version_number: event.fromVersionNumber,
          to_version_number: event.toVersionNumber,
          occurred_at: event.occurredAt,
        });
      });
    },
  };
}
