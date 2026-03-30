import type { FridaySqliteLayer } from "#state";
import type { FridayOutboxMessageRepository, FridaySatelliteHeartbeatRepository, FridaySatellitePairingRequestRepository } from "#satellites";
import type { FridayLearningEventLedger, FridaySkillRunStore } from "#ledger";
import type {
  FridayRetentionJobResult,
  FridayRetentionPolicy,
} from "./friday-retention.types.js";
import { FRIDAY_DEFAULT_RETENTION_POLICY } from "./friday-retention.types.js";

export interface FridayRetentionJob {
  run(nowIso?: string): FridayRetentionJobResult;
}

export interface CreateRetentionJobDeps {
  db: FridaySqliteLayer;
  pairingRequestRepo: FridaySatellitePairingRequestRepository;
  heartbeatRepo: FridaySatelliteHeartbeatRepository;
  outboxRepo: FridayOutboxMessageRepository;
  learningLedger: FridayLearningEventLedger;
  skillRunStore: FridaySkillRunStore;
  policy?: FridayRetentionPolicy;
  nowIso: () => string;
}

function subtractDays(isoDate: string, days: number): string {
  const ms = new Date(isoDate).getTime() - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

export function createFridayRetentionJob(deps: CreateRetentionJobDeps): FridayRetentionJob {
  const policy = deps.policy ?? FRIDAY_DEFAULT_RETENTION_POLICY;

  return {
    run(nowIsoOverride?) {
      const nowIso = nowIsoOverride ?? deps.nowIso();

      // All cleanup runs in one write transaction for atomicity
      const result = deps.db.withWriteTransaction((db) => {
        // 1. Mark stale pending pairing requests as expired
        const pairingCutoff = nowIso;
        const staleRequests = deps.pairingRequestRepo.listPendingExpiredBefore(db, pairingCutoff);
        for (const req of staleRequests) {
          deps.pairingRequestRepo.updateStatus(db, req.id, "expired", null, nowIso);
        }
        const markedPairingExpired = staleRequests.length;

        // 2. Delete old resolved pairing requests
        const pairingDeleteCutoff = subtractDays(nowIso, policy.pairingRequestsDays);
        const deletedPairingRequests = deps.pairingRequestRepo.deleteResolvedBefore(
          db,
          pairingDeleteCutoff,
        );

        // 3. Delete old heartbeat rows
        const heartbeatCutoff = subtractDays(nowIso, policy.heartbeatsDays);
        const deletedHeartbeats = deps.heartbeatRepo.deleteBefore(db, heartbeatCutoff);

        // 4. Mark TTL-breached outbox rows as expired
        const markedOutboxExpired = deps.outboxRepo.expireByTtl(db, nowIso);

        // 5. Delete old terminal outbox rows
        const outboxDeleteCutoff = subtractDays(nowIso, policy.outboxTerminalDays);
        const deletedOutboxTerminal = deps.outboxRepo.deleteTerminalBefore(db, outboxDeleteCutoff);

        // 6. Delete old learning events
        const learningCutoff = subtractDays(nowIso, policy.learningEventsDays);
        const deletedLearningEvents = db
          .prepare("DELETE FROM learning_events WHERE ts < ?")
          .run(learningCutoff).changes;

        // 7. Delete terminal skill run snapshots
        const skillRunCutoff = subtractDays(nowIso, policy.skillRunTerminalDays);
        let deletedSkillRuns = 0;
        for (const status of ["completed", "failed", "cancelled"]) {
          const result = db
            .prepare(
              "DELETE FROM memory_items WHERE namespace = 'skill_runs' AND tags_json LIKE ? AND updated_at < ?",
            )
            .run(`%"status:${status}"%`, skillRunCutoff);
          deletedSkillRuns += result.changes;
        }

        // 8. Delete old audit logs
        const auditCutoff = subtractDays(nowIso, policy.auditLogsDays);
        const deletedAuditLogs = db
          .prepare("DELETE FROM audit_logs WHERE ts < ?")
          .run(auditCutoff).changes;

        // 9. Delete old terminal agent runs (events cascade via ON DELETE CASCADE)
        const agentRunCutoff = subtractDays(nowIso, policy.agentRunsDays);
        const deletedAgentRuns = db
          .prepare(
            "DELETE FROM friday_agent_runs WHERE created_at < ? AND status IN ('completed', 'failed', 'cancelled')",
          )
          .run(agentRunCutoff).changes;

        // 10. Delete old LLM usage records
        const llmUsageCutoff = subtractDays(nowIso, policy.llmUsageRecordsDays);
        const deletedLlmUsageRecords = db
          .prepare("DELETE FROM llm_usage_records WHERE created_at < ?")
          .run(llmUsageCutoff).changes;

        // 11. Delete old resolved error incidents
        const errorCutoff = subtractDays(nowIso, policy.errorIncidentsDays);
        const deletedErrorIncidents = db
          .prepare(
            "DELETE FROM error_incidents WHERE status = 'resolved' AND updated_at < ?",
          )
          .run(errorCutoff).changes;

        return {
          markedPairingExpired,
          deletedPairingRequests,
          deletedHeartbeats,
          markedOutboxExpired,
          deletedOutboxTerminal,
          deletedLearningEvents,
          deletedSkillRuns,
          deletedAuditLogs,
          deletedAgentRuns,
          deletedLlmUsageRecords,
          deletedErrorIncidents,
        };
      });

      // Run PRAGMA optimize after cleanup to update query planner statistics
      try {
        deps.db.optimize();
      } catch {
        // Non-fatal: optimize failure should not cause retention job to fail
      }

      return result;
    },
  };
}
