import type { FridaySqliteLayer } from "#state";
import type { FridayOutboxMessageRepository, FridaySatelliteHeartbeatRepository, FridaySatellitePairingRequestRepository } from "#satellites";
import type { FridayLearningEventLedger, FridaySkillRunStore } from "#ledger";
// Type-only import (erased at compile) — avoids a runtime jobs->api edge; the
// concrete repo is injected by the wiring layer (see friday-satellite-runtime).
import type { FridaySetupBootstrapNonceRepository } from "../../api/persistence/friday-setup-bootstrap-nonce-repository.js";
import type {
  FridayRetentionJobResult,
  FridayRetentionPolicy,
} from "./friday-retention.types.js";
import {
  FRIDAY_BOOTSTRAP_NONCE_SWEEP_BATCH_LIMIT,
  FRIDAY_DEFAULT_RETENTION_POLICY,
} from "./friday-retention.types.js";

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
  bootstrapNonceRepo: FridaySetupBootstrapNonceRepository;
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

      const result: FridayRetentionJobResult = {
        markedPairingExpired: 0,
        deletedPairingRequests: 0,
        deletedHeartbeats: 0,
        markedOutboxExpired: 0,
        deletedOutboxTerminal: 0,
        deletedLearningEvents: 0,
        deletedSkillRuns: 0,
        deletedAuditLogs: 0,
        deletedAgentRuns: 0,
        deletedLlmUsageRecords: 0,
        deletedErrorIncidents: 0,
        deletedExpiredBootstrapNonces: 0,
        deletedConsumedBootstrapNonces: 0,
      };

      result.markedPairingExpired = deps.db.withWriteTransaction((db) => {
        const pairingCutoff = nowIso;
        const staleRequests = deps.pairingRequestRepo.listPendingExpiredBefore(db, pairingCutoff);
        for (const req of staleRequests) {
          deps.pairingRequestRepo.updateStatus(db, req.id, "expired", null, nowIso);
        }
        return staleRequests.length;
      });

      result.deletedPairingRequests = deps.db.withWriteTransaction((db) => {
        const pairingDeleteCutoff = subtractDays(nowIso, policy.pairingRequestsDays);
        return deps.pairingRequestRepo.deleteResolvedBefore(
          db,
          pairingDeleteCutoff,
        );
      });

      result.deletedHeartbeats = deps.db.withWriteTransaction((db) => {
        const heartbeatCutoff = subtractDays(nowIso, policy.heartbeatsDays);
        return deps.heartbeatRepo.deleteBefore(db, heartbeatCutoff);
      });

      result.markedOutboxExpired = deps.db.withWriteTransaction((db) =>
        deps.outboxRepo.expireByTtl(db, nowIso),
      );

      result.deletedOutboxTerminal = deps.db.withWriteTransaction((db) => {
        const outboxDeleteCutoff = subtractDays(nowIso, policy.outboxTerminalDays);
        return deps.outboxRepo.deleteTerminalBefore(db, outboxDeleteCutoff);
      });

      result.deletedLearningEvents = deps.db.withWriteTransaction((db) => {
        const learningCutoff = subtractDays(nowIso, policy.learningEventsDays);
        return db
          .prepare("DELETE FROM learning_events WHERE ts < ?")
          .run(learningCutoff).changes;
      });

      const skillRunCutoff = subtractDays(nowIso, policy.skillRunTerminalDays);
      result.deletedSkillRuns =
        deps.skillRunStore.pruneTerminalRunsBefore(skillRunCutoff);

      result.deletedAuditLogs = deps.db.withWriteTransaction((db) => {
        const auditCutoff = subtractDays(nowIso, policy.auditLogsDays);
        return db
          .prepare("DELETE FROM audit_logs WHERE ts < ?")
          .run(auditCutoff).changes;
      });

      result.deletedAgentRuns = deps.db.withWriteTransaction((db) => {
        const agentRunCutoff = subtractDays(nowIso, policy.agentRunsDays);
        return db
          .prepare(
            "DELETE FROM friday_agent_runs WHERE created_at < ? AND status IN ('completed', 'failed', 'cancelled')",
          )
          .run(agentRunCutoff).changes;
      });

      result.deletedLlmUsageRecords = deps.db.withWriteTransaction((db) => {
        const llmUsageCutoff = subtractDays(nowIso, policy.llmUsageRecordsDays);
        return db
          .prepare("DELETE FROM llm_usage_records WHERE created_at < ?")
          .run(llmUsageCutoff).changes;
      });

      result.deletedErrorIncidents = deps.db.withWriteTransaction((db) => {
        const errorCutoff = subtractDays(nowIso, policy.errorIncidentsDays);
        return db
          .prepare(
            "DELETE FROM error_incidents WHERE status = 'resolved' AND updated_at < ?",
          )
          .run(errorCutoff).changes;
      });

      // Setup-bootstrap install-nonce reaper (OBS-2). Bounded per pass; reaps
      // expired UNCONSUMED nonces (dead weight / DoS vector) and CONSUMED nonces
      // past their retention horizon. No-degrade: never touches a live
      // unconsumed-unexpired nonce nor the owner slot.
      {
        const bootstrapNonceCutoff = subtractDays(nowIso, policy.bootstrapNoncesConsumedDays);
        const swept = deps.db.withWriteTransaction((db) =>
          deps.bootstrapNonceRepo.sweepExpiredAndRetired(db, {
            nowIso,
            consumedRetentionCutoffIso: bootstrapNonceCutoff,
            batchLimit: FRIDAY_BOOTSTRAP_NONCE_SWEEP_BATCH_LIMIT,
          }),
        );
        result.deletedExpiredBootstrapNonces = swept.deletedExpiredUnconsumed;
        result.deletedConsumedBootstrapNonces = swept.deletedConsumedRetired;
      }

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
