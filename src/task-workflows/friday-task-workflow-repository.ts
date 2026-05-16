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
  FridayTaskWorkflowClaimKind,
  FridayTaskWorkflowClaimRecord,
  FridayTaskWorkflowClaimStatus,
  FridayTaskWorkflowCloseoutGateOutcome,
  FridayTaskWorkflowCloseoutReceipt,
  FridayTaskWorkflowContextPackage,
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
           claim_summary_json, blockers_json, gate_outcomes_json, created_at
         ) VALUES (
           @id, @workflowId, @specHash, @status,
           @claimSummaryJson, @blockersJson, @gateOutcomesJson, @createdAt
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
