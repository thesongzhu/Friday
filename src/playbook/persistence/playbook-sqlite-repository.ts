/**
 * Playbook SQLite Repository — Durable persistence for all playbook entities.
 *
 * Implements the `PlaybookStore` interface using SQLite, replacing the
 * in-memory store for production use. Row mappers convert between the
 * `*Row` types (snake_case, JSON strings) and domain entity types.
 *
 * @module playbook/persistence
 */

import type { Database } from "better-sqlite3";
import { safeJsonParse } from "#utilities";
import type { PlaybookStore } from "../engine/playbook-store.js";
import type {
  FridayPlaybook,
  FridayPlaybookCandidate,
  FridayPlaybookCandidateRow,
  FridayPlaybookCandidateStatus,
  FridayPlaybookCostDimensions,
  FridayPlaybookLifecycleEvent,
  FridayPlaybookLifecycleEventRow,
  FridayPlaybookLifecycleEventType,
  FridayPlaybookMatch,
  FridayPlaybookMatchReason,
  FridayPlaybookRow,
  FridayPlaybookScore,
  FridayPlaybookScoreRow,
  FridayPlaybookSelectionRow,
  FridayPlaybookSelector,
  FridayPlaybookStatus,
  FridayPlaybookVersion,
  FridayPlaybookVersionRow,
  FridayPromotionDecision,
  FridayPromotionDecisionOutcome,
  FridayPromotionDecisionRow,
  FridayPromotionRuleResult,
  ISODateTime,
  JsonObject,
  UUID,
} from "../model/friday-playbook.types.js";
import type { FridayEvaluationResult } from "../../rules/model/friday-rules-engine.types.js";

// ─── Row Mappers ───

function mapPlaybookRow(row: FridayPlaybookRow): FridayPlaybook {
  return {
    id: row.id as UUID,
    name: row.name,
    description: row.description ?? undefined,
    workflowType: row.workflow_type,
    tags: safeJsonParse<string[]>(row.tags_json) ?? [],
    status: row.status as FridayPlaybookStatus,
    activeVersionNumber: row.active_version_number,
    sourceCandidateId: row.source_candidate_id as UUID,
    compositeScore: row.composite_score,
    totalUses: row.total_uses,
    totalSuccesses: row.total_successes,
    lastUsedAt: (row.last_used_at ?? undefined) as ISODateTime | undefined,
    lastSuccessfulAt: (row.last_successful_at ?? undefined) as ISODateTime | undefined,
    etag: row.etag,
    createdAt: row.created_at as ISODateTime,
    updatedAt: row.updated_at as ISODateTime,
    archivedAt: (row.archived_at ?? undefined) as ISODateTime | undefined,
  };
}

function mapCandidateRow(row: FridayPlaybookCandidateRow): FridayPlaybookCandidate {
  return {
    id: row.id as UUID,
    fingerprint: row.fingerprint,
    workflowType: row.workflow_type,
    tags: safeJsonParse<string[]>(row.tags_json) ?? [],
    pattern: safeJsonParse<JsonObject>(row.pattern_json) ?? {},
    status: row.status as FridayPlaybookCandidateStatus,
    evidenceCount: row.evidence_count,
    successCount: row.success_count,
    failureCount: row.failure_count,
    totalDurationMs: row.total_duration_ms,
    totalCost: safeJsonParse<FridayPlaybookCostDimensions>(row.total_cost_json) ?? { tokenCost: 0, apiCallCost: 0, latencyMs: 0 },
    sourceRunIds: safeJsonParse<UUID[]>(row.source_run_ids_json) ?? [],
    promotedPlaybookId: (row.promoted_playbook_id ?? undefined) as UUID | undefined,
    firstObservedAt: row.first_observed_at as ISODateTime,
    lastObservedAt: row.last_observed_at as ISODateTime,
    createdAt: row.created_at as ISODateTime,
    updatedAt: row.updated_at as ISODateTime,
  };
}

function mapVersionRow(row: FridayPlaybookVersionRow): FridayPlaybookVersion {
  return {
    id: row.id as UUID,
    playbookId: row.playbook_id as UUID,
    versionNumber: row.version_number,
    fingerprint: row.fingerprint,
    pattern: safeJsonParse<JsonObject>(row.pattern_json) ?? {},
    candidateId: row.candidate_id as UUID,
    changeNote: row.change_note ?? undefined,
    createdAt: row.created_at as ISODateTime,
  };
}

function mapScoreRow(row: FridayPlaybookScoreRow): FridayPlaybookScore {
  return {
    id: row.id as UUID,
    playbookId: (row.playbook_id ?? null) as UUID | null,
    versionNumber: row.version_number ?? null,
    compositeScore: row.composite_score,
    successRate: row.success_rate,
    speedScore: row.speed_score,
    costEfficiencyScore: row.cost_efficiency_score,
    satisfactionScore: row.satisfaction_score,
    sampleSize: row.sample_size,
    calculatedAt: row.calculated_at as ISODateTime,
  };
}

function mapSelectionRow(row: FridayPlaybookSelectionRow): FridayPlaybookMatch {
  return {
    id: row.id as UUID,
    runId: row.run_id as UUID,
    workflowId: row.workflow_id as UUID,
    playbookId: (row.playbook_id ?? null) as UUID | null,
    versionNumber: row.version_number ?? null,
    matchScore: row.match_score ?? null,
    similarity: row.similarity ?? null,
    reason: row.reason as FridayPlaybookMatchReason,
    context: safeJsonParse<FridayPlaybookSelector>(row.context_json) ?? ({} as FridayPlaybookSelector),
    selectedAt: row.selected_at as ISODateTime,
  };
}

function mapDecisionRow(row: FridayPromotionDecisionRow): FridayPromotionDecision {
  return {
    id: row.id as UUID,
    candidateId: row.candidate_id as UUID,
    decision: row.decision as FridayPromotionDecisionOutcome,
    reason: row.reason,
    ruleResults: safeJsonParse<FridayPromotionRuleResult[]>(row.rule_results_json) ?? [],
    rulesResult: safeJsonParse<FridayEvaluationResult>(row.rules_result_json),
    scoreSnapshot: safeJsonParse<FridayPlaybookScore>(row.score_snapshot_json) ?? ({} as FridayPlaybookScore),
    decidedAt: row.decided_at as ISODateTime,
  };
}

function mapLifecycleEventRow(row: FridayPlaybookLifecycleEventRow): FridayPlaybookLifecycleEvent {
  return {
    id: row.id as UUID,
    playbookId: row.playbook_id as UUID,
    type: row.type as FridayPlaybookLifecycleEventType,
    reason: row.reason,
    fromVersionNumber: row.from_version_number,
    toVersionNumber: row.to_version_number,
    occurredAt: row.occurred_at as ISODateTime,
  };
}

// ─── Dependencies ───

export interface CreatePlaybookSqliteRepositoryDeps {
  db: { writer: Database; withReadConnection: <T>(fn: (db: Database) => T) => T };
}

// ─── Factory ───

/**
 * Create a SQLite-backed `PlaybookStore`.
 *
 * Uses the writer handle for mutations and the read pool for queries.
 * All UPSERT operations use INSERT OR REPLACE for simplicity since
 * the store interface is save-based (callers own concurrency checks).
 */
export function createPlaybookSqliteRepository(
  deps: CreatePlaybookSqliteRepositoryDeps,
): PlaybookStore {
  const { db } = deps;
  const writer = db.writer;

  return {
    // ─── Playbooks ───

    getPlaybook(id: UUID): FridayPlaybook | undefined {
      return db.withReadConnection((rd) => {
        const row = rd
          .prepare("SELECT * FROM playbooks WHERE id = ?")
          .get(id) as FridayPlaybookRow | undefined;
        return row ? mapPlaybookRow(row) : undefined;
      });
    },

    getPlaybooksByWorkflowType(workflowType: string, status?: FridayPlaybookStatus): FridayPlaybook[] {
      return db.withReadConnection((rd) => {
        if (status !== undefined) {
          const rows = rd
            .prepare("SELECT * FROM playbooks WHERE workflow_type = ? AND status = ?")
            .all(workflowType, status) as FridayPlaybookRow[];
          return rows.map(mapPlaybookRow);
        }
        const rows = rd
          .prepare("SELECT * FROM playbooks WHERE workflow_type = ?")
          .all(workflowType) as FridayPlaybookRow[];
        return rows.map(mapPlaybookRow);
      });
    },

    getAllPlaybooks(status?: FridayPlaybookStatus): FridayPlaybook[] {
      return db.withReadConnection((rd) => {
        if (status !== undefined) {
          const rows = rd
            .prepare("SELECT * FROM playbooks WHERE status = ?")
            .all(status) as FridayPlaybookRow[];
          return rows.map(mapPlaybookRow);
        }
        const rows = rd.prepare("SELECT * FROM playbooks").all() as FridayPlaybookRow[];
        return rows.map(mapPlaybookRow);
      });
    },

    savePlaybook(playbook: FridayPlaybook): void {
      writer
        .prepare(
          `INSERT OR REPLACE INTO playbooks (
            id, name, description, workflow_type, tags_json, status,
            active_version_number, source_candidate_id, composite_score,
            total_uses, total_successes, last_used_at, last_successful_at,
            etag, created_at, updated_at, archived_at
          ) VALUES (
            @id, @name, @description, @workflow_type, @tags_json, @status,
            @active_version_number, @source_candidate_id, @composite_score,
            @total_uses, @total_successes, @last_used_at, @last_successful_at,
            @etag, @created_at, @updated_at, @archived_at
          )`,
        )
        .run({
          id: playbook.id,
          name: playbook.name,
          description: playbook.description ?? null,
          workflow_type: playbook.workflowType,
          tags_json: JSON.stringify(playbook.tags),
          status: playbook.status,
          active_version_number: playbook.activeVersionNumber,
          source_candidate_id: playbook.sourceCandidateId,
          composite_score: playbook.compositeScore,
          total_uses: playbook.totalUses,
          total_successes: playbook.totalSuccesses,
          last_used_at: playbook.lastUsedAt ?? null,
          last_successful_at: playbook.lastSuccessfulAt ?? null,
          etag: playbook.etag,
          created_at: playbook.createdAt,
          updated_at: playbook.updatedAt,
          archived_at: playbook.archivedAt ?? null,
        });
    },

    deletePlaybook(id: UUID): boolean {
      const result = writer
        .prepare("DELETE FROM playbooks WHERE id = ?")
        .run(id);
      return result.changes > 0;
    },

    // ─── Candidates ───

    getCandidate(id: UUID): FridayPlaybookCandidate | undefined {
      return db.withReadConnection((rd) => {
        const row = rd
          .prepare("SELECT * FROM playbook_candidates WHERE id = ?")
          .get(id) as FridayPlaybookCandidateRow | undefined;
        return row ? mapCandidateRow(row) : undefined;
      });
    },

    getCandidateByFingerprint(
      fingerprint: string,
      workflowType?: string,
    ): FridayPlaybookCandidate | undefined {
      return db.withReadConnection((rd) => {
        if (workflowType !== undefined) {
          const row = rd
            .prepare(
              "SELECT * FROM playbook_candidates WHERE workflow_type = ? AND fingerprint = ?",
            )
            .get(workflowType, fingerprint) as FridayPlaybookCandidateRow | undefined;
          return row ? mapCandidateRow(row) : undefined;
        }
        const row = rd
          .prepare("SELECT * FROM playbook_candidates WHERE fingerprint = ? LIMIT 1")
          .get(fingerprint) as FridayPlaybookCandidateRow | undefined;
        return row ? mapCandidateRow(row) : undefined;
      });
    },

    getCandidatesByStatus(status: FridayPlaybookCandidateStatus): FridayPlaybookCandidate[] {
      return db.withReadConnection((rd) => {
        const rows = rd
          .prepare("SELECT * FROM playbook_candidates WHERE status = ?")
          .all(status) as FridayPlaybookCandidateRow[];
        return rows.map(mapCandidateRow);
      });
    },

    getCandidatesByWorkflowType(workflowType: string): FridayPlaybookCandidate[] {
      return db.withReadConnection((rd) => {
        const rows = rd
          .prepare("SELECT * FROM playbook_candidates WHERE workflow_type = ?")
          .all(workflowType) as FridayPlaybookCandidateRow[];
        return rows.map(mapCandidateRow);
      });
    },

    saveCandidate(candidate: FridayPlaybookCandidate): void {
      writer
        .prepare(
          `INSERT OR REPLACE INTO playbook_candidates (
            id, fingerprint, workflow_type, tags_json, pattern_json, status,
            evidence_count, success_count, failure_count, total_duration_ms,
            total_cost_json, source_run_ids_json, promoted_playbook_id,
            first_observed_at, last_observed_at, created_at, updated_at
          ) VALUES (
            @id, @fingerprint, @workflow_type, @tags_json, @pattern_json, @status,
            @evidence_count, @success_count, @failure_count, @total_duration_ms,
            @total_cost_json, @source_run_ids_json, @promoted_playbook_id,
            @first_observed_at, @last_observed_at, @created_at, @updated_at
          )`,
        )
        .run({
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
          promoted_playbook_id: candidate.promotedPlaybookId ?? null,
          first_observed_at: candidate.firstObservedAt,
          last_observed_at: candidate.lastObservedAt,
          created_at: candidate.createdAt,
          updated_at: candidate.updatedAt,
        });
    },

    deleteCandidate(id: UUID): boolean {
      const result = writer
        .prepare("DELETE FROM playbook_candidates WHERE id = ?")
        .run(id);
      return result.changes > 0;
    },

    // ─── Versions ───

    getVersion(id: UUID): FridayPlaybookVersion | undefined {
      return db.withReadConnection((rd) => {
        const row = rd
          .prepare("SELECT * FROM playbook_versions WHERE id = ?")
          .get(id) as FridayPlaybookVersionRow | undefined;
        return row ? mapVersionRow(row) : undefined;
      });
    },

    getVersionsByPlaybookId(playbookId: UUID): FridayPlaybookVersion[] {
      return db.withReadConnection((rd) => {
        const rows = rd
          .prepare(
            "SELECT * FROM playbook_versions WHERE playbook_id = ? ORDER BY version_number ASC",
          )
          .all(playbookId) as FridayPlaybookVersionRow[];
        return rows.map(mapVersionRow);
      });
    },

    getVersionByNumber(
      playbookId: UUID,
      versionNumber: number,
    ): FridayPlaybookVersion | undefined {
      return db.withReadConnection((rd) => {
        const row = rd
          .prepare(
            "SELECT * FROM playbook_versions WHERE playbook_id = ? AND version_number = ?",
          )
          .get(playbookId, versionNumber) as FridayPlaybookVersionRow | undefined;
        return row ? mapVersionRow(row) : undefined;
      });
    },

    getLatestVersion(playbookId: UUID): FridayPlaybookVersion | undefined {
      return db.withReadConnection((rd) => {
        const row = rd
          .prepare(
            "SELECT * FROM playbook_versions WHERE playbook_id = ? ORDER BY version_number DESC LIMIT 1",
          )
          .get(playbookId) as FridayPlaybookVersionRow | undefined;
        return row ? mapVersionRow(row) : undefined;
      });
    },

    saveVersion(version: FridayPlaybookVersion): void {
      writer
        .prepare(
          `INSERT OR REPLACE INTO playbook_versions (
            id, playbook_id, version_number, fingerprint,
            pattern_json, candidate_id, change_note, created_at
          ) VALUES (
            @id, @playbook_id, @version_number, @fingerprint,
            @pattern_json, @candidate_id, @change_note, @created_at
          )`,
        )
        .run({
          id: version.id,
          playbook_id: version.playbookId,
          version_number: version.versionNumber,
          fingerprint: version.fingerprint,
          pattern_json: JSON.stringify(version.pattern),
          candidate_id: version.candidateId,
          change_note: version.changeNote ?? null,
          created_at: version.createdAt,
        });
    },

    // ─── Scores ───

    getScore(id: UUID): FridayPlaybookScore | undefined {
      return db.withReadConnection((rd) => {
        const row = rd
          .prepare("SELECT * FROM playbook_scores WHERE id = ?")
          .get(id) as FridayPlaybookScoreRow | undefined;
        return row ? mapScoreRow(row) : undefined;
      });
    },

    getScoresByPlaybookId(playbookId: UUID): FridayPlaybookScore[] {
      return db.withReadConnection((rd) => {
        const rows = rd
          .prepare(
            "SELECT * FROM playbook_scores WHERE playbook_id = ? ORDER BY calculated_at ASC",
          )
          .all(playbookId) as FridayPlaybookScoreRow[];
        return rows.map(mapScoreRow);
      });
    },

    getLatestScore(playbookId: UUID): FridayPlaybookScore | undefined {
      return db.withReadConnection((rd) => {
        const row = rd
          .prepare(
            "SELECT * FROM playbook_scores WHERE playbook_id = ? ORDER BY calculated_at DESC LIMIT 1",
          )
          .get(playbookId) as FridayPlaybookScoreRow | undefined;
        return row ? mapScoreRow(row) : undefined;
      });
    },

    saveScore(score: FridayPlaybookScore): void {
      writer
        .prepare(
          `INSERT OR REPLACE INTO playbook_scores (
            id, playbook_id, version_number, composite_score,
            success_rate, speed_score, cost_efficiency_score,
            satisfaction_score, sample_size, calculated_at
          ) VALUES (
            @id, @playbook_id, @version_number, @composite_score,
            @success_rate, @speed_score, @cost_efficiency_score,
            @satisfaction_score, @sample_size, @calculated_at
          )`,
        )
        .run({
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
    },

    // ─── Matches (Selections) ───

    getMatch(id: UUID): FridayPlaybookMatch | undefined {
      return db.withReadConnection((rd) => {
        const row = rd
          .prepare("SELECT * FROM playbook_selections WHERE id = ?")
          .get(id) as FridayPlaybookSelectionRow | undefined;
        return row ? mapSelectionRow(row) : undefined;
      });
    },

    getMatchesByPlaybookId(playbookId: UUID): FridayPlaybookMatch[] {
      return db.withReadConnection((rd) => {
        const rows = rd
          .prepare("SELECT * FROM playbook_selections WHERE playbook_id = ?")
          .all(playbookId) as FridayPlaybookSelectionRow[];
        return rows.map(mapSelectionRow);
      });
    },

    getMatchesByRunId(runId: UUID): FridayPlaybookMatch[] {
      return db.withReadConnection((rd) => {
        const rows = rd
          .prepare("SELECT * FROM playbook_selections WHERE run_id = ?")
          .all(runId) as FridayPlaybookSelectionRow[];
        return rows.map(mapSelectionRow);
      });
    },

    saveMatch(match: FridayPlaybookMatch): void {
      writer
        .prepare(
          `INSERT OR REPLACE INTO playbook_selections (
            id, run_id, workflow_id, playbook_id, version_number,
            match_score, similarity, reason, context_json, selected_at
          ) VALUES (
            @id, @run_id, @workflow_id, @playbook_id, @version_number,
            @match_score, @similarity, @reason, @context_json, @selected_at
          )`,
        )
        .run({
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
    },

    // ─── Promotion Decisions ───

    getDecision(id: UUID): FridayPromotionDecision | undefined {
      return db.withReadConnection((rd) => {
        const row = rd
          .prepare("SELECT * FROM promotion_decisions WHERE id = ?")
          .get(id) as FridayPromotionDecisionRow | undefined;
        return row ? mapDecisionRow(row) : undefined;
      });
    },

    getDecisionsByCandidateId(candidateId: UUID): FridayPromotionDecision[] {
      return db.withReadConnection((rd) => {
        const rows = rd
          .prepare(
            "SELECT * FROM promotion_decisions WHERE candidate_id = ? ORDER BY decided_at ASC",
          )
          .all(candidateId) as FridayPromotionDecisionRow[];
        return rows.map(mapDecisionRow);
      });
    },

    saveDecision(decision: FridayPromotionDecision): void {
      writer
        .prepare(
          `INSERT OR REPLACE INTO promotion_decisions (
            id, candidate_id, decision, reason,
            rule_results_json, rules_result_json,
            score_snapshot_json, decided_at
          ) VALUES (
            @id, @candidate_id, @decision, @reason,
            @rule_results_json, @rules_result_json,
            @score_snapshot_json, @decided_at
          )`,
        )
        .run({
          id: decision.id,
          candidate_id: decision.candidateId,
          decision: decision.decision,
          reason: decision.reason,
          rule_results_json: JSON.stringify(decision.ruleResults),
          rules_result_json: decision.rulesResult
            ? JSON.stringify(decision.rulesResult)
            : null,
          score_snapshot_json: JSON.stringify(decision.scoreSnapshot),
          decided_at: decision.decidedAt,
        });
    },

    // ─── Lifecycle Events ───

    getLifecycleEvent(id: UUID): FridayPlaybookLifecycleEvent | undefined {
      return db.withReadConnection((rd) => {
        const row = rd
          .prepare("SELECT * FROM playbook_lifecycle_events WHERE id = ?")
          .get(id) as FridayPlaybookLifecycleEventRow | undefined;
        return row ? mapLifecycleEventRow(row) : undefined;
      });
    },

    getLifecycleEventsByPlaybookId(playbookId: UUID): FridayPlaybookLifecycleEvent[] {
      return db.withReadConnection((rd) => {
        const rows = rd
          .prepare(
            "SELECT * FROM playbook_lifecycle_events WHERE playbook_id = ? ORDER BY occurred_at ASC",
          )
          .all(playbookId) as FridayPlaybookLifecycleEventRow[];
        return rows.map(mapLifecycleEventRow);
      });
    },

    saveLifecycleEvent(event: FridayPlaybookLifecycleEvent): void {
      writer
        .prepare(
          `INSERT OR REPLACE INTO playbook_lifecycle_events (
            id, playbook_id, type, reason,
            from_version_number, to_version_number, occurred_at
          ) VALUES (
            @id, @playbook_id, @type, @reason,
            @from_version_number, @to_version_number, @occurred_at
          )`,
        )
        .run({
          id: event.id,
          playbook_id: event.playbookId,
          type: event.type,
          reason: event.reason,
          from_version_number: event.fromVersionNumber,
          to_version_number: event.toVersionNumber,
          occurred_at: event.occurredAt,
        });
    },
  };
}
