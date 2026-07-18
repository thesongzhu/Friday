import type { FridaySqliteLayer } from "#state";
import type { FridayOutboxMessageRepository, FridaySatelliteHeartbeatRepository, FridaySatellitePairingRequestRepository } from "#satellites";
import type { FridayLearningEventLedger, FridaySkillRunStore } from "#ledger";
// Type-only import (erased at compile) — avoids a runtime jobs->api edge; the
// concrete repo is injected by the wiring layer (see friday-satellite-runtime).
import type { FridaySetupBootstrapNonceRepository } from "../../api/persistence/friday-setup-bootstrap-nonce-repository.js";
import type {
  CategoryRetention,
  FridayRetentionJobResult,
  FridayRetentionPolicy,
} from "./friday-retention.types.js";
import {
  FRIDAY_BOOTSTRAP_NONCE_SWEEP_BATCH_LIMIT,
  FRIDAY_DEFAULT_RETENTION_POLICY,
} from "./friday-retention.types.js";
import { createFridayRetentionReceiptRepository } from "./friday-retention-receipt-repository.js";

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
  /**
   * Static startup policy. Retained for existing callers; when `loadPolicy` is
   * provided it takes precedence and this is ignored.
   */
  policy?: FridayRetentionPolicy;
  /**
   * RETENTION-R3a live-revocation fix. When provided, the reaper re-reads the
   * CURRENT persisted retention policy at the START of EVERY sweep instead of
   * capturing a startup snapshot. This makes an owner's opt-in/opt-OUT
   * authoritative for the already-running reaper WITHOUT a process restart
   * (DATA-RETENTION-001): setting a category back to permanent stops the very
   * next sweep from deleting it. Must fail closed — return all-permanent on any
   * read failure; the job additionally guards the call with try/catch so a throw
   * or nullish result also resolves to all-permanent (delete nothing).
   */
  loadPolicy?: () => FridayRetentionPolicy;
  nowIso: () => string;
}

function subtractDays(isoDate: string, days: number): string {
  const ms = new Date(isoDate).getTime() - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

/**
 * Fail-closed cutoff evaluator for a CONTENT retention category.
 *
 * DATA-RETENTION-001 / U9-DATA-RETENTION: content is default-PERMANENT and any
 * auto-deletion must be explicitly enabled AND well-formed. This is the ONLY
 * gate the per-category DELETE statements consult.
 *
 * Returns:
 *   - `null` for `{mode:'permanent'}` → caller SKIPS deletion (retain forever).
 *   - the ISO cutoff string for a valid `{mode:'after_days', days:n}` where `n`
 *     is a positive finite integer that yields an in-range date.
 *   - `null` for ANY invalid input — missing/undefined/null, non-object,
 *     unknown mode, days ≤ 0, non-integer, NaN, Infinity, or an overflowing /
 *     out-of-range date. Invalid ⇒ treat as PERMANENT (delete nothing) = FAIL
 *     CLOSED. Never throws; never deletes on uncertainty.
 */
export function resolveCutoff(
  nowIso: string,
  categoryRetention: CategoryRetention | null | undefined,
): string | null {
  if (categoryRetention === null || typeof categoryRetention !== "object") {
    return null; // missing / non-object → fail closed
  }
  const mode = (categoryRetention as { mode?: unknown }).mode;
  if (mode === "permanent") return null; // retain forever
  if (mode !== "after_days") return null; // unknown mode → fail closed
  const days = (categoryRetention as { days?: unknown }).days;
  if (typeof days !== "number") return null; // missing / non-number → fail closed
  if (!Number.isInteger(days)) return null; // NaN, Infinity, 1.5, … → fail closed
  if (days <= 0) return null; // 0 / negative → fail closed
  const nowMs = new Date(nowIso).getTime();
  if (!Number.isFinite(nowMs)) return null; // bad nowIso → fail closed
  const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(cutoffMs)) return null; // overflow → fail closed
  const cutoff = new Date(cutoffMs);
  if (Number.isNaN(cutoff.getTime())) return null; // out-of-range date → fail closed
  return cutoff.toISOString();
}

export function createFridayRetentionJob(deps: CreateRetentionJobDeps): FridayRetentionJob {
  // RETENTION-R3d: the governed recovery-receipt store's deletion seam (stateless
  // SQL helpers). The reaper's auditLogs-category sweep uses `deleteExpiredBefore`
  // so the receipt-expiry SQL has ONE source of truth shared with the store.
  const receiptRepo = createFridayRetentionReceiptRepository();

  // RETENTION-R3a: resolve the governing policy PER SWEEP (not once at
  // construction) so live owner opt-in/opt-OUT changes are authoritative for the
  // running reaper. FAIL-CLOSED: any error / nullish live read ⇒ all-permanent ⇒
  // delete nothing.
  function resolvePolicy(): FridayRetentionPolicy {
    if (deps.loadPolicy) {
      try {
        return deps.loadPolicy() ?? FRIDAY_DEFAULT_RETENTION_POLICY;
      } catch {
        return FRIDAY_DEFAULT_RETENTION_POLICY;
      }
    }
    return deps.policy ?? FRIDAY_DEFAULT_RETENTION_POLICY;
  }

  return {
    run(nowIsoOverride?) {
      const nowIso = nowIsoOverride ?? deps.nowIso();
      const policy = resolvePolicy();

      const result: FridayRetentionJobResult = {
        markedPairingExpired: 0,
        deletedPairingRequests: 0,
        deletedHeartbeats: 0,
        markedOutboxExpired: 0,
        deletedOutboxTerminal: 0,
        deletedLearningEvents: 0,
        deletedSkillRuns: 0,
        deletedAuditLogs: 0,
        deletedRetentionReceipts: 0,
        quarantinedIntegrityReceipts: 0,
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

      // CONTENT category (derived): default-permanent, fail-closed.
      const heartbeatCutoff = resolveCutoff(nowIso, policy.heartbeats);
      result.deletedHeartbeats =
        heartbeatCutoff === null
          ? 0
          : deps.db.withWriteTransaction((db) =>
              deps.heartbeatRepo.deleteBefore(db, heartbeatCutoff),
            );

      result.markedOutboxExpired = deps.db.withWriteTransaction((db) =>
        deps.outboxRepo.expireByTtl(db, nowIso),
      );

      result.deletedOutboxTerminal = deps.db.withWriteTransaction((db) => {
        const outboxDeleteCutoff = subtractDays(nowIso, policy.outboxTerminalDays);
        return deps.outboxRepo.deleteTerminalBefore(db, outboxDeleteCutoff);
      });

      // CONTENT category (canonical): default-permanent, fail-closed.
      const learningCutoff = resolveCutoff(nowIso, policy.learningEvents);
      result.deletedLearningEvents =
        learningCutoff === null
          ? 0
          : deps.db.withWriteTransaction(
              (db) =>
                db
                  .prepare("DELETE FROM learning_events WHERE ts < ?")
                  .run(learningCutoff).changes,
            );

      // CONTENT category (canonical): default-permanent, fail-closed.
      const skillRunCutoff = resolveCutoff(nowIso, policy.skillRunTerminal);
      result.deletedSkillRuns =
        skillRunCutoff === null
          ? 0
          : deps.skillRunStore.pruneTerminalRunsBefore(skillRunCutoff);

      // CONTENT category (canonical): default-permanent, fail-closed.
      // audit_logs permanence is a hard requirement — never auto-delete by default.
      // The SAME `auditLogs` category governs the retention RECOVERY-RECEIPT store
      // (`retention_recovery_receipts`, RETENTION-R3d): the full user receipt lives
      // there (only a content-free linkage/digest anchor stays in
      // `security_audit_log`), so honoring the user's auditLogs deletion policy MUST
      // expire aged receipts too — otherwise an aged receipt would silently survive
      // a finite-retention advance (the U9/DATA-RETENTION-001 violation this fixes).
      // Both deletions run under the SAME cutoff, in ONE transaction, so they stay
      // consistent; default-permanent + fail-closed (auditCutoff === null ⇒ delete
      // nothing, quarantine nothing) is preserved for BOTH.
      //
      // WHOLE-ROW INVARIANT (RETENTION-R3d) — DOCUMENTED SAFE QUARANTINE: a receipt
      // whose persisted `created_at` is NON-CANONICAL cannot be dated, so the
      // lexicographic `created_at < cutoff` compare would let it SILENTLY SURVIVE
      // this finite window (a DATA-RETENTION-001 truthfulness break — "a successful
      // zero-deletion sweep silently surviving a finite retention policy"). Its
      // content category is opted into deletion, so the finite sweep QUARANTINE-
      // deletes exactly those un-datable rows and surfaces a TYPED integrity incident
      // (`quarantinedIntegrityReceipts`) so the sweep is never a silent zero-deletion
      // success. It does NOT abort the sweep — one corrupt row must not block reaping
      // valid rows. This is the ONE operator-locked (DATA-RETENTION-001) design fork,
      // implemented as the Advisor-authorized "documented safe quarantine strategy";
      // under default-permanent (auditCutoff === null) the un-datable row is RETAINED
      // (never served — the read path fails closed on it) until the owner opts in.
      const auditCutoff = resolveCutoff(nowIso, policy.auditLogs);
      if (auditCutoff === null) {
        result.deletedAuditLogs = 0;
        result.deletedRetentionReceipts = 0;
        result.quarantinedIntegrityReceipts = 0;
      } else {
        const swept = deps.db.withWriteTransaction((db) => ({
          logs: db.prepare("DELETE FROM audit_logs WHERE ts < ?").run(auditCutoff).changes,
          receipts: receiptRepo.deleteExpiredBefore(db, auditCutoff),
          quarantined: receiptRepo.quarantineNonCanonicalCreatedAt(db),
        }));
        result.deletedAuditLogs = swept.logs;
        result.deletedRetentionReceipts = swept.receipts;
        result.quarantinedIntegrityReceipts = swept.quarantined;
      }

      // CONTENT category (canonical): default-permanent, fail-closed.
      const agentRunCutoff = resolveCutoff(nowIso, policy.agentRuns);
      result.deletedAgentRuns =
        agentRunCutoff === null
          ? 0
          : deps.db.withWriteTransaction(
              (db) =>
                db
                  .prepare(
                    "DELETE FROM friday_agent_runs WHERE created_at < ? AND status IN ('completed', 'failed', 'cancelled')",
                  )
                  .run(agentRunCutoff).changes,
            );

      // CONTENT category (canonical): default-permanent, fail-closed.
      const llmUsageCutoff = resolveCutoff(nowIso, policy.llmUsageRecords);
      result.deletedLlmUsageRecords =
        llmUsageCutoff === null
          ? 0
          : deps.db.withWriteTransaction(
              (db) =>
                db
                  .prepare("DELETE FROM llm_usage_records WHERE created_at < ?")
                  .run(llmUsageCutoff).changes,
            );

      // CONTENT category (canonical): default-permanent, fail-closed.
      const errorCutoff = resolveCutoff(nowIso, policy.errorIncidents);
      result.deletedErrorIncidents =
        errorCutoff === null
          ? 0
          : deps.db.withWriteTransaction(
              (db) =>
                db
                  .prepare(
                    "DELETE FROM error_incidents WHERE status = 'resolved' AND updated_at < ?",
                  )
                  .run(errorCutoff).changes,
            );

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
