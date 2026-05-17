/**
 * Phase 13.5A task workflow repository.
 *
 * Stores task workflow records, revisions, claims, evidence refs,
 * supervisor cursor, and closeout receipts in additive SQLite tables.
 * The repository is a thin persistence layer — all enforcement (required
 * gate undisable, claim matrix truth, whole-repo refusal) lives in
 * `friday-task-workflow-service.ts`.
 *
 * @module task-workflows/friday-task-workflow-repository
 */

import type Database from "better-sqlite3";

import type {
  FridayTaskWorkflowChannelCommandRecord,
  FridayTaskWorkflowChannelCommandStatus,
  FridayTaskWorkflowChannelIntentKind,
  FridayTaskWorkflowClaimKind,
  FridayTaskWorkflowClaimRecord,
  FridayTaskWorkflowClaimStatus,
  FridayTaskWorkflowCliBackendId,
  FridayTaskWorkflowCliCapabilityLabel,
  FridayTaskWorkflowCliHandoffRecord,
  FridayTaskWorkflowCliHandoffStatus,
  FridayTaskWorkflowCloseoutGateOutcome,
  FridayTaskWorkflowCloseoutReceipt,
  FridayTaskWorkflowContextPackage,
  FridayTaskWorkflowEvidenceExplorerQuery,
  FridayTaskWorkflowEvidenceRefRecord,
  FridayTaskWorkflowEvidenceSource,
  FridayTaskWorkflowFallbackAvailability,
  FridayTaskWorkflowGatePlanEntry,
  FridayTaskWorkflowLaneIndependence,
  FridayTaskWorkflowLaneKind,
  FridayTaskWorkflowLaneRecord,
  FridayTaskWorkflowLaneRole,
  FridayTaskWorkflowLaneStatus,
  FridayTaskWorkflowRecord,
  FridayTaskWorkflowRevisionRecord,
  FridayTaskWorkflowRisk,
  FridayTaskWorkflowStage,
  FridayTaskWorkflowSupervisorCursorRecord,
  FridayTaskWorkflowSupervisorMode,
} from "./friday-task-workflow.types.js";

export interface FridayTaskWorkflowRepository {
  insertWorkflow(db: Database.Database, record: FridayTaskWorkflowRecord): void;
  updateWorkflowAfterRevision(
    db: Database.Database,
    record: FridayTaskWorkflowRecord,
  ): void;
  getWorkflow(
    db: Database.Database,
    workflowId: string,
  ): FridayTaskWorkflowRecord | null;
  listWorkflows(
    db: Database.Database,
    options?: { limit?: number },
  ): readonly FridayTaskWorkflowRecord[];
  insertRevision(
    db: Database.Database,
    record: FridayTaskWorkflowRevisionRecord,
  ): void;
  listRevisions(
    db: Database.Database,
    workflowId: string,
  ): readonly FridayTaskWorkflowRevisionRecord[];
  insertClaim(
    db: Database.Database,
    record: FridayTaskWorkflowClaimRecord,
  ): void;
  getClaim(
    db: Database.Database,
    claimId: string,
  ): FridayTaskWorkflowClaimRecord | null;
  listClaims(
    db: Database.Database,
    workflowId: string,
  ): readonly FridayTaskWorkflowClaimRecord[];
  updateClaim(
    db: Database.Database,
    record: FridayTaskWorkflowClaimRecord,
  ): void;
  incrementEvidenceRefCount(
    db: Database.Database,
    claimId: string,
    nowIso: string,
  ): void;
  insertEvidenceRef(
    db: Database.Database,
    record: FridayTaskWorkflowEvidenceRefRecord,
  ): void;
  listEvidenceRefs(
    db: Database.Database,
    claimId: string,
  ): readonly FridayTaskWorkflowEvidenceRefRecord[];
  upsertSupervisorCursor(
    db: Database.Database,
    record: FridayTaskWorkflowSupervisorCursorRecord,
  ): void;
  getSupervisorCursor(
    db: Database.Database,
    workflowId: string,
  ): FridayTaskWorkflowSupervisorCursorRecord | null;
  insertCloseoutReceipt(
    db: Database.Database,
    record: FridayTaskWorkflowCloseoutReceipt,
  ): void;
  getLatestCloseoutReceipt(
    db: Database.Database,
    workflowId: string,
  ): FridayTaskWorkflowCloseoutReceipt | null;
  insertLane(
    db: Database.Database,
    record: FridayTaskWorkflowLaneRecord,
  ): void;
  updateLane(
    db: Database.Database,
    record: FridayTaskWorkflowLaneRecord,
  ): void;
  getLane(
    db: Database.Database,
    laneId: string,
  ): FridayTaskWorkflowLaneRecord | null;
  listLanes(
    db: Database.Database,
    workflowId: string,
  ): readonly FridayTaskWorkflowLaneRecord[];
  insertCliHandoff(
    db: Database.Database,
    record: FridayTaskWorkflowCliHandoffRecord,
  ): void;
  getCliHandoff(
    db: Database.Database,
    handoffId: string,
  ): FridayTaskWorkflowCliHandoffRecord | null;
  listCliHandoffsByLane(
    db: Database.Database,
    laneId: string,
  ): readonly FridayTaskWorkflowCliHandoffRecord[];
  listCliHandoffsByWorkflow(
    db: Database.Database,
    workflowId: string,
  ): readonly FridayTaskWorkflowCliHandoffRecord[];
  insertChannelCommand(
    db: Database.Database,
    record: FridayTaskWorkflowChannelCommandRecord,
  ): void;
  updateChannelCommand(
    db: Database.Database,
    record: FridayTaskWorkflowChannelCommandRecord,
  ): void;
  getChannelCommand(
    db: Database.Database,
    commandId: string,
  ): FridayTaskWorkflowChannelCommandRecord | null;
  getChannelCommandByToken(
    db: Database.Database,
    confirmationToken: string,
  ): FridayTaskWorkflowChannelCommandRecord | null;
  listChannelCommandsByWorkflow(
    db: Database.Database,
    workflowId: string,
  ): readonly FridayTaskWorkflowChannelCommandRecord[];
  /**
   * Cross-workflow evidence ref index used by the Global Evidence
   * Explorer. The repository performs only metadata projection; the
   * service layer is responsible for joining claim status / kind.
   */
  queryEvidenceRefs(
    db: Database.Database,
    query: FridayTaskWorkflowEvidenceExplorerQuery,
  ): readonly FridayTaskWorkflowEvidenceRefRecord[];
  /** Fetch evidence ref by id when the gated drilldown route needs the
   *  raw row to feed the redactor. */
  getEvidenceRefById(
    db: Database.Database,
    evidenceRefId: string,
  ): FridayTaskWorkflowEvidenceRefRecord | null;
}

export function createFridayTaskWorkflowRepository(): FridayTaskWorkflowRepository {
  return {
    insertWorkflow(db, record) {
      db.prepare(
        `INSERT INTO task_workflows (
           id, charter, spec_hash, parent_spec_hash, task_kind, risk,
           supervisor_mode, budget, stage,
           context_package_json, gate_plan_json, boundary_refs_json,
           metadata_json, created_at, updated_at
         ) VALUES (
           @id, @charter, @specHash, @parentSpecHash, @taskKind, @risk,
           @supervisorMode, @budget, @stage,
           @contextPackageJson, @gatePlanJson, @boundaryRefsJson,
           @metadataJson, @createdAt, @updatedAt
         )`,
      ).run({
        id: record.id,
        charter: record.charter,
        specHash: record.specHash,
        parentSpecHash: record.parentSpecHash,
        taskKind: record.taskKind,
        risk: record.risk,
        supervisorMode: record.supervisorMode,
        budget: record.budget,
        stage: record.stage,
        contextPackageJson: JSON.stringify(record.contextPackage),
        gatePlanJson: JSON.stringify(record.gatePlan),
        boundaryRefsJson: JSON.stringify(record.boundaryRefs),
        metadataJson: JSON.stringify(record.metadata),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    },

    updateWorkflowAfterRevision(db, record) {
      db.prepare(
        `UPDATE task_workflows SET
           charter = @charter,
           spec_hash = @specHash,
           parent_spec_hash = @parentSpecHash,
           supervisor_mode = @supervisorMode,
           budget = @budget,
           stage = @stage,
           context_package_json = @contextPackageJson,
           gate_plan_json = @gatePlanJson,
           boundary_refs_json = @boundaryRefsJson,
           metadata_json = @metadataJson,
           updated_at = @updatedAt
         WHERE id = @id`,
      ).run({
        id: record.id,
        charter: record.charter,
        specHash: record.specHash,
        parentSpecHash: record.parentSpecHash,
        supervisorMode: record.supervisorMode,
        budget: record.budget,
        stage: record.stage,
        contextPackageJson: JSON.stringify(record.contextPackage),
        gatePlanJson: JSON.stringify(record.gatePlan),
        boundaryRefsJson: JSON.stringify(record.boundaryRefs),
        metadataJson: JSON.stringify(record.metadata),
        updatedAt: record.updatedAt,
      });
    },

    getWorkflow(db, workflowId) {
      const row = db
        .prepare(`SELECT * FROM task_workflows WHERE id = ?`)
        .get(workflowId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return rowToWorkflow(row);
    },

    listWorkflows(db, options) {
      const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
      const rows = db
        .prepare(`SELECT * FROM task_workflows ORDER BY created_at DESC LIMIT ?`)
        .all(limit) as Record<string, unknown>[];
      return rows.map(rowToWorkflow);
    },

    insertRevision(db, record) {
      db.prepare(
        `INSERT INTO task_workflow_revisions (
           id, workflow_id, spec_hash, parent_spec_hash, charter, reason, created_at
         ) VALUES (@id, @workflowId, @specHash, @parentSpecHash, @charter, @reason, @createdAt)`,
      ).run({
        id: record.id,
        workflowId: record.workflowId,
        specHash: record.specHash,
        parentSpecHash: record.parentSpecHash,
        charter: record.charter,
        reason: record.reason,
        createdAt: record.createdAt,
      });
    },

    listRevisions(db, workflowId) {
      const rows = db
        .prepare(
          `SELECT * FROM task_workflow_revisions
           WHERE workflow_id = ?
           ORDER BY created_at ASC`,
        )
        .all(workflowId) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: String(row.id),
        workflowId: String(row.workflow_id),
        specHash: String(row.spec_hash),
        parentSpecHash:
          row.parent_spec_hash === null ? null : String(row.parent_spec_hash),
        charter: String(row.charter),
        reason: String(row.reason),
        createdAt: String(row.created_at),
      }));
    },

    insertClaim(db, record) {
      db.prepare(
        `INSERT INTO task_workflow_claims (
           id, workflow_id, spec_hash, claim_text, claim_kind, status,
           reason, verifier_verdict, verifier_lane_id,
           evidence_ref_count, created_at, updated_at
         ) VALUES (
           @id, @workflowId, @specHash, @claimText, @claimKind, @status,
           @reason, @verifierVerdict, @verifierLaneId,
           @evidenceRefCount, @createdAt, @updatedAt
         )`,
      ).run({
        id: record.id,
        workflowId: record.workflowId,
        specHash: record.specHash,
        claimText: record.claimText,
        claimKind: record.claimKind,
        status: record.status,
        reason: record.reason,
        verifierVerdict: record.verifierVerdict,
        verifierLaneId: record.verifierLaneId,
        evidenceRefCount: record.evidenceRefCount,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    },

    getClaim(db, claimId) {
      const row = db
        .prepare(`SELECT * FROM task_workflow_claims WHERE id = ?`)
        .get(claimId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return rowToClaim(row);
    },

    listClaims(db, workflowId) {
      const rows = db
        .prepare(
          `SELECT * FROM task_workflow_claims
           WHERE workflow_id = ?
           ORDER BY created_at ASC`,
        )
        .all(workflowId) as Record<string, unknown>[];
      return rows.map(rowToClaim);
    },

    updateClaim(db, record) {
      db.prepare(
        `UPDATE task_workflow_claims SET
           status = @status,
           reason = @reason,
           verifier_verdict = @verifierVerdict,
           verifier_lane_id = @verifierLaneId,
           evidence_ref_count = @evidenceRefCount,
           updated_at = @updatedAt
         WHERE id = @id`,
      ).run({
        id: record.id,
        status: record.status,
        reason: record.reason,
        verifierVerdict: record.verifierVerdict,
        verifierLaneId: record.verifierLaneId,
        evidenceRefCount: record.evidenceRefCount,
        updatedAt: record.updatedAt,
      });
    },

    incrementEvidenceRefCount(db, claimId, nowIso) {
      db.prepare(
        `UPDATE task_workflow_claims SET
           evidence_ref_count = evidence_ref_count + 1,
           updated_at = @updatedAt
         WHERE id = @id`,
      ).run({ id: claimId, updatedAt: nowIso });
    },

    insertEvidenceRef(db, record) {
      db.prepare(
        `INSERT INTO task_workflow_evidence_refs (
           id, workflow_id, claim_id, ref_kind, ref_id, ref_hash, ref_source, created_at
         ) VALUES (
           @id, @workflowId, @claimId, @refKind, @refId, @refHash, @refSource, @createdAt
         )`,
      ).run({
        id: record.id,
        workflowId: record.workflowId,
        claimId: record.claimId,
        refKind: record.refKind,
        refId: record.refId,
        refHash: record.refHash,
        refSource: record.refSource,
        createdAt: record.createdAt,
      });
    },

    listEvidenceRefs(db, claimId) {
      const rows = db
        .prepare(
          `SELECT * FROM task_workflow_evidence_refs
           WHERE claim_id = ?
           ORDER BY created_at ASC`,
        )
        .all(claimId) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: String(row.id),
        workflowId: String(row.workflow_id),
        claimId: String(row.claim_id),
        refKind: String(row.ref_kind),
        refId: String(row.ref_id),
        refHash: row.ref_hash === null ? null : String(row.ref_hash),
        refSource: row.ref_source as FridayTaskWorkflowEvidenceSource,
        createdAt: String(row.created_at),
      }));
    },

    upsertSupervisorCursor(db, record) {
      db.prepare(
        `INSERT INTO task_workflow_supervisor_cursor (
           workflow_id, current_stage, blockers_json, last_event_ref, updated_at
         ) VALUES (@workflowId, @currentStage, @blockersJson, @lastEventRef, @updatedAt)
         ON CONFLICT(workflow_id) DO UPDATE SET
           current_stage = excluded.current_stage,
           blockers_json = excluded.blockers_json,
           last_event_ref = excluded.last_event_ref,
           updated_at = excluded.updated_at`,
      ).run({
        workflowId: record.workflowId,
        currentStage: record.currentStage,
        blockersJson: JSON.stringify(record.blockers),
        lastEventRef: record.lastEventRef,
        updatedAt: record.updatedAt,
      });
    },

    getSupervisorCursor(db, workflowId) {
      const row = db
        .prepare(`SELECT * FROM task_workflow_supervisor_cursor WHERE workflow_id = ?`)
        .get(workflowId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        workflowId: String(row.workflow_id),
        currentStage: row.current_stage as FridayTaskWorkflowStage,
        blockers: JSON.parse(String(row.blockers_json)) as string[],
        lastEventRef:
          row.last_event_ref === null ? null : String(row.last_event_ref),
        updatedAt: String(row.updated_at),
      };
    },

    insertCloseoutReceipt(db, record) {
      db.prepare(
        `INSERT INTO task_workflow_closeout_receipts (
           id, workflow_id, spec_hash, status,
           claim_summary_json, blockers_json, gate_outcomes_json, created_at,
           evidence_durability, proof_claimable
         ) VALUES (
           @id, @workflowId, @specHash, @status,
           @claimSummaryJson, @blockersJson, @gateOutcomesJson, @createdAt,
           @evidenceDurability, @proofClaimable
         )`,
      ).run({
        id: record.id,
        workflowId: record.workflowId,
        specHash: record.specHash,
        status: record.status,
        claimSummaryJson: JSON.stringify(record.claimSummary),
        blockersJson: JSON.stringify(record.blockers),
        gateOutcomesJson: JSON.stringify(record.gateOutcomes),
        createdAt: record.createdAt,
        evidenceDurability: record.evidenceDurability,
        proofClaimable: record.proofClaimable ? 1 : 0,
      });
    },

    getLatestCloseoutReceipt(db, workflowId) {
      const row = db
        .prepare(
          `SELECT * FROM task_workflow_closeout_receipts
           WHERE workflow_id = ?
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get(workflowId) as Record<string, unknown> | undefined;
      if (!row) return null;
      const evidenceDurability =
        typeof row.evidence_durability === "string"
          ? (row.evidence_durability as "available" | "degraded" | "unavailable")
          : "available";
      const proofClaimable =
        row.proof_claimable === 1 || row.proof_claimable === "1";
      return {
        id: String(row.id),
        workflowId: String(row.workflow_id),
        specHash: String(row.spec_hash),
        status: row.status as "complete" | "partial" | "blocked",
        claimSummary: JSON.parse(String(row.claim_summary_json)) as {
          draft: number;
          unverified: number;
          verified: number;
          blocked: number;
        },
        blockers: JSON.parse(String(row.blockers_json)) as string[],
        gateOutcomes: JSON.parse(
          String(row.gate_outcomes_json ?? "[]"),
        ) as FridayTaskWorkflowCloseoutGateOutcome[],
        createdAt: String(row.created_at),
        evidenceDurability,
        proofClaimable,
      };
    },

    insertLane(db, record) {
      db.prepare(
        `INSERT INTO task_workflow_lanes (
           id, workflow_id, lane_kind, lane_role, parent_lane_id,
           status, independence, executor_run_ref, provider_id,
           route_trace_ref, context_snapshot_hash, context_snapshot_spec_hash,
           fallback_availability, blocker, created_at, updated_at
         ) VALUES (
           @id, @workflowId, @laneKind, @laneRole, @parentLaneId,
           @status, @independence, @executorRunRef, @providerId,
           @routeTraceRef, @contextSnapshotHash, @contextSnapshotSpecHash,
           @fallbackAvailability, @blocker, @createdAt, @updatedAt
         )`,
      ).run({
        id: record.id,
        workflowId: record.workflowId,
        laneKind: record.laneKind,
        laneRole: record.laneRole,
        parentLaneId: record.parentLaneId,
        status: record.status,
        independence: record.independence,
        executorRunRef: record.executorRunRef,
        providerId: record.providerId,
        routeTraceRef: record.routeTraceRef,
        contextSnapshotHash: record.contextSnapshotHash,
        contextSnapshotSpecHash: record.contextSnapshotSpecHash,
        fallbackAvailability: record.fallbackAvailability,
        blocker: record.blocker,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    },

    updateLane(db, record) {
      db.prepare(
        `UPDATE task_workflow_lanes SET
           status = @status,
           independence = @independence,
           executor_run_ref = @executorRunRef,
           provider_id = @providerId,
           route_trace_ref = @routeTraceRef,
           fallback_availability = @fallbackAvailability,
           blocker = @blocker,
           updated_at = @updatedAt
         WHERE id = @id`,
      ).run({
        id: record.id,
        status: record.status,
        independence: record.independence,
        executorRunRef: record.executorRunRef,
        providerId: record.providerId,
        routeTraceRef: record.routeTraceRef,
        fallbackAvailability: record.fallbackAvailability,
        blocker: record.blocker,
        updatedAt: record.updatedAt,
      });
    },

    getLane(db, laneId) {
      const row = db
        .prepare(`SELECT * FROM task_workflow_lanes WHERE id = ?`)
        .get(laneId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return rowToLane(row);
    },

    listLanes(db, workflowId) {
      const rows = db
        .prepare(
          `SELECT * FROM task_workflow_lanes
           WHERE workflow_id = ?
           ORDER BY created_at ASC`,
        )
        .all(workflowId) as Record<string, unknown>[];
      return rows.map(rowToLane);
    },

    insertCliHandoff(db, record) {
      db.prepare(
        `INSERT INTO task_workflow_cli_handoffs (
           id, workflow_id, lane_id, backend_id, status, summary_draft,
           capability_label_json, repair_attempts, elapsed_ms,
           failure_reason, produced_at, created_at
         ) VALUES (
           @id, @workflowId, @laneId, @backendId, @status, @summaryDraft,
           @capabilityLabelJson, @repairAttempts, @elapsedMs,
           @failureReason, @producedAt, @createdAt
         )`,
      ).run({
        id: record.id,
        workflowId: record.workflowId,
        laneId: record.laneId,
        backendId: record.backendId,
        status: record.status,
        summaryDraft: record.summaryDraft,
        capabilityLabelJson: JSON.stringify(record.capabilityLabel),
        repairAttempts: record.repairAttempts,
        elapsedMs: record.elapsedMs,
        failureReason: record.failureReason,
        producedAt: record.producedAt,
        createdAt: record.createdAt,
      });
    },

    getCliHandoff(db, handoffId) {
      const row = db
        .prepare(`SELECT * FROM task_workflow_cli_handoffs WHERE id = ?`)
        .get(handoffId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return rowToCliHandoff(row);
    },

    listCliHandoffsByLane(db, laneId) {
      const rows = db
        .prepare(
          `SELECT * FROM task_workflow_cli_handoffs
           WHERE lane_id = ?
           ORDER BY created_at ASC`,
        )
        .all(laneId) as Record<string, unknown>[];
      return rows.map(rowToCliHandoff);
    },

    listCliHandoffsByWorkflow(db, workflowId) {
      const rows = db
        .prepare(
          `SELECT * FROM task_workflow_cli_handoffs
           WHERE workflow_id = ?
           ORDER BY created_at ASC`,
        )
        .all(workflowId) as Record<string, unknown>[];
      return rows.map(rowToCliHandoff);
    },

    insertChannelCommand(db, record) {
      db.prepare(
        `INSERT INTO task_workflow_channel_commands (
           id, workflow_id, channel_kind, channel_chat_hash,
           channel_message_hash, sender_hash, intent_kind,
           confirmation_token, status, dispatched_action,
           declined_reason, issued_at, confirmed_at, dispatched_at,
           expires_at, created_at
         ) VALUES (
           @id, @workflowId, @channelKind, @channelChatHash,
           @channelMessageHash, @senderHash, @intentKind,
           @confirmationToken, @status, @dispatchedAction,
           @declinedReason, @issuedAt, @confirmedAt, @dispatchedAt,
           @expiresAt, @createdAt
         )`,
      ).run({
        id: record.id,
        workflowId: record.workflowId,
        channelKind: record.channelKind,
        channelChatHash: record.channelChatHash,
        channelMessageHash: record.channelMessageHash,
        senderHash: record.senderHash,
        intentKind: record.intentKind,
        confirmationToken: record.confirmationToken,
        status: record.status,
        dispatchedAction: record.dispatchedAction,
        declinedReason: record.declinedReason,
        issuedAt: record.issuedAt,
        confirmedAt: record.confirmedAt,
        dispatchedAt: record.dispatchedAt,
        expiresAt: record.expiresAt,
        createdAt: record.createdAt,
      });
    },

    updateChannelCommand(db, record) {
      db.prepare(
        `UPDATE task_workflow_channel_commands SET
           status = @status,
           dispatched_action = @dispatchedAction,
           declined_reason = @declinedReason,
           confirmed_at = @confirmedAt,
           dispatched_at = @dispatchedAt
         WHERE id = @id`,
      ).run({
        id: record.id,
        status: record.status,
        dispatchedAction: record.dispatchedAction,
        declinedReason: record.declinedReason,
        confirmedAt: record.confirmedAt,
        dispatchedAt: record.dispatchedAt,
      });
    },

    getChannelCommand(db, commandId) {
      const row = db
        .prepare(`SELECT * FROM task_workflow_channel_commands WHERE id = ?`)
        .get(commandId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return rowToChannelCommand(row);
    },

    getChannelCommandByToken(db, confirmationToken) {
      const row = db
        .prepare(
          `SELECT * FROM task_workflow_channel_commands WHERE confirmation_token = ?`,
        )
        .get(confirmationToken) as Record<string, unknown> | undefined;
      if (!row) return null;
      return rowToChannelCommand(row);
    },

    listChannelCommandsByWorkflow(db, workflowId) {
      const rows = db
        .prepare(
          `SELECT * FROM task_workflow_channel_commands
           WHERE workflow_id = ?
           ORDER BY created_at ASC`,
        )
        .all(workflowId) as Record<string, unknown>[];
      return rows.map(rowToChannelCommand);
    },

    queryEvidenceRefs(db, query) {
      const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
      const filters: string[] = [];
      const params: Record<string, unknown> = {};
      if (query.workflowId) {
        filters.push("e.workflow_id = @workflowId");
        params.workflowId = query.workflowId;
      }
      if (query.claimId) {
        filters.push("e.claim_id = @claimId");
        params.claimId = query.claimId;
      }
      if (query.refSource) {
        filters.push("e.ref_source = @refSource");
        params.refSource = query.refSource;
      }
      if (query.refKind) {
        filters.push("e.ref_kind = @refKind");
        params.refKind = query.refKind;
      }
      if (query.claimKind) {
        filters.push("c.claim_kind = @claimKind");
        params.claimKind = query.claimKind;
      }
      const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `SELECT e.*
             FROM task_workflow_evidence_refs e
             INNER JOIN task_workflow_claims c ON c.id = e.claim_id
             ${where}
             ORDER BY e.created_at DESC
             LIMIT @limit`,
        )
        .all({ ...params, limit }) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: String(row.id),
        workflowId: String(row.workflow_id),
        claimId: String(row.claim_id),
        refKind: String(row.ref_kind),
        refId: String(row.ref_id),
        refHash: row.ref_hash === null ? null : String(row.ref_hash),
        refSource: row.ref_source as FridayTaskWorkflowEvidenceSource,
        createdAt: String(row.created_at),
      }));
    },

    getEvidenceRefById(db, evidenceRefId) {
      const row = db
        .prepare(`SELECT * FROM task_workflow_evidence_refs WHERE id = ?`)
        .get(evidenceRefId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: String(row.id),
        workflowId: String(row.workflow_id),
        claimId: String(row.claim_id),
        refKind: String(row.ref_kind),
        refId: String(row.ref_id),
        refHash: row.ref_hash === null ? null : String(row.ref_hash),
        refSource: row.ref_source as FridayTaskWorkflowEvidenceSource,
        createdAt: String(row.created_at),
      };
    },
  };
}

function rowToWorkflow(row: Record<string, unknown>): FridayTaskWorkflowRecord {
  return {
    id: String(row.id),
    charter: String(row.charter),
    specHash: String(row.spec_hash),
    parentSpecHash:
      row.parent_spec_hash === null ? null : String(row.parent_spec_hash),
    taskKind: String(row.task_kind),
    risk: row.risk as FridayTaskWorkflowRisk,
    supervisorMode: row.supervisor_mode as FridayTaskWorkflowSupervisorMode,
    budget: Number(row.budget),
    stage: row.stage as FridayTaskWorkflowStage,
    contextPackage: JSON.parse(
      String(row.context_package_json),
    ) as FridayTaskWorkflowContextPackage,
    gatePlan: JSON.parse(String(row.gate_plan_json)) as FridayTaskWorkflowGatePlanEntry[],
    boundaryRefs: JSON.parse(String(row.boundary_refs_json)) as string[],
    metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToClaim(row: Record<string, unknown>): FridayTaskWorkflowClaimRecord {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    specHash: String(row.spec_hash),
    claimText: String(row.claim_text),
    claimKind: row.claim_kind as FridayTaskWorkflowClaimKind,
    status: row.status as FridayTaskWorkflowClaimStatus,
    reason: row.reason === null ? null : String(row.reason),
    verifierVerdict:
      row.verifier_verdict === null ? null : String(row.verifier_verdict),
    verifierLaneId:
      row.verifier_lane_id === null || row.verifier_lane_id === undefined
        ? null
        : String(row.verifier_lane_id),
    evidenceRefCount: Number(row.evidence_ref_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToLane(row: Record<string, unknown>): FridayTaskWorkflowLaneRecord {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    laneKind: row.lane_kind as FridayTaskWorkflowLaneKind,
    laneRole: row.lane_role as FridayTaskWorkflowLaneRole,
    parentLaneId:
      row.parent_lane_id === null || row.parent_lane_id === undefined
        ? null
        : String(row.parent_lane_id),
    status: row.status as FridayTaskWorkflowLaneStatus,
    independence: row.independence as FridayTaskWorkflowLaneIndependence,
    executorRunRef:
      row.executor_run_ref === null || row.executor_run_ref === undefined
        ? null
        : String(row.executor_run_ref),
    providerId:
      row.provider_id === null || row.provider_id === undefined
        ? null
        : String(row.provider_id),
    routeTraceRef:
      row.route_trace_ref === null || row.route_trace_ref === undefined
        ? null
        : String(row.route_trace_ref),
    contextSnapshotHash: String(row.context_snapshot_hash),
    contextSnapshotSpecHash: String(row.context_snapshot_spec_hash),
    fallbackAvailability:
      row.fallback_availability === null || row.fallback_availability === undefined
        ? null
        : (row.fallback_availability as FridayTaskWorkflowFallbackAvailability),
    blocker:
      row.blocker === null || row.blocker === undefined
        ? null
        : String(row.blocker),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToChannelCommand(
  row: Record<string, unknown>,
): FridayTaskWorkflowChannelCommandRecord {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    channelKind: String(row.channel_kind),
    channelChatHash: String(row.channel_chat_hash),
    channelMessageHash: String(row.channel_message_hash),
    senderHash: String(row.sender_hash),
    intentKind: row.intent_kind as FridayTaskWorkflowChannelIntentKind,
    confirmationToken: String(row.confirmation_token),
    status: row.status as FridayTaskWorkflowChannelCommandStatus,
    dispatchedAction:
      row.dispatched_action === null || row.dispatched_action === undefined
        ? null
        : String(row.dispatched_action),
    declinedReason:
      row.declined_reason === null || row.declined_reason === undefined
        ? null
        : String(row.declined_reason),
    issuedAt: String(row.issued_at),
    confirmedAt:
      row.confirmed_at === null || row.confirmed_at === undefined
        ? null
        : String(row.confirmed_at),
    dispatchedAt:
      row.dispatched_at === null || row.dispatched_at === undefined
        ? null
        : String(row.dispatched_at),
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
  };
}

function rowToCliHandoff(
  row: Record<string, unknown>,
): FridayTaskWorkflowCliHandoffRecord {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    laneId: String(row.lane_id),
    backendId: row.backend_id as FridayTaskWorkflowCliBackendId,
    status: row.status as FridayTaskWorkflowCliHandoffStatus,
    summaryDraft: String(row.summary_draft),
    capabilityLabel: JSON.parse(
      String(row.capability_label_json),
    ) as FridayTaskWorkflowCliCapabilityLabel,
    repairAttempts: Number(row.repair_attempts),
    elapsedMs: Number(row.elapsed_ms),
    failureReason:
      row.failure_reason === null || row.failure_reason === undefined
        ? null
        : String(row.failure_reason),
    producedAt: String(row.produced_at),
    createdAt: String(row.created_at),
  };
}
