import type { FridaySqliteLayer } from "#state";
import { safeJsonParse } from "#utilities";

import type {
  FridayAuditEntry,
  FridayAuditEntryRow,
  FridayRetentionCheckpoint,
  FridayRetentionCheckpointRow,
  JsonObject,
} from "../model/friday-observability.types.js";
import type {
  FridayAuditTrailPersistenceSnapshot,
  FridayAuditTrailStore,
} from "../engine/audit-trail.js";

export interface CreateFridayObservabilityAuditRepositoryDeps {
  db: FridaySqliteLayer;
}

function parseRequiredJson<T>(value: string, fieldName: string): T {
  const parsed = safeJsonParse<T>(value);
  if (parsed === undefined) {
    throw new Error(`Invalid persisted observability audit JSON in ${fieldName}`);
  }
  return parsed;
}

function mapAuditEntryRow(row: FridayAuditEntryRow): FridayAuditEntry {
  return {
    id: row.id,
    sequenceNumber: row.sequence_number,
    actor: parseRequiredJson<FridayAuditEntry["actor"]>(row.actor_json, "obs_audit_entries.actor_json"),
    actionCategory: row.action_category as FridayAuditEntry["actionCategory"],
    action: row.action,
    resource: parseRequiredJson<FridayAuditEntry["resource"]>(
      row.resource_json,
      "obs_audit_entries.resource_json",
    ),
    outcome: row.outcome as FridayAuditEntry["outcome"],
    description: row.description,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    module: row.module as FridayAuditEntry["module"],
    traceId: row.trace_id ?? undefined,
    spanId: row.span_id ?? undefined,
    integrityHash: row.integrity_hash,
    previousHash: row.previous_hash,
    metadata: row.metadata_json
      ? safeJsonParse<JsonObject>(row.metadata_json) ?? undefined
      : undefined,
    recordedAt: row.recorded_at,
  };
}

function mapRetentionCheckpointRow(
  row: FridayRetentionCheckpointRow,
): FridayRetentionCheckpoint {
  return {
    id: row.id,
    lastDeletedSequenceNumber: row.last_deleted_sequence_number,
    boundaryHash: row.boundary_hash,
    firstRetainedSequenceNumber: row.first_retained_sequence_number,
    createdAt: row.created_at,
    reason: row.reason,
  };
}

export function createFridayObservabilityAuditRepository(
  deps: CreateFridayObservabilityAuditRepositoryDeps,
): FridayAuditTrailStore {
  const { db } = deps;

  return {
    loadSnapshot(): FridayAuditTrailPersistenceSnapshot {
      return db.withReadConnection((conn) => {
        const entryRows = conn
          .prepare("SELECT * FROM obs_audit_entries ORDER BY sequence_number ASC")
          .all() as FridayAuditEntryRow[];
        const checkpointRows = conn
          .prepare(
            "SELECT * FROM obs_retention_checkpoints ORDER BY last_deleted_sequence_number ASC",
          )
          .all() as FridayRetentionCheckpointRow[];

        return {
          entries: entryRows.map(mapAuditEntryRow),
          checkpoints: checkpointRows.map(mapRetentionCheckpointRow),
        };
      });
    },

    appendEntry(entry): void {
      db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO obs_audit_entries (
            id,
            sequence_number,
            actor_json,
            action_category,
            action,
            resource_json,
            outcome,
            description,
            error_code,
            error_message,
            module,
            trace_id,
            span_id,
            integrity_hash,
            previous_hash,
            metadata_json,
            recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          entry.id,
          entry.sequenceNumber,
          JSON.stringify(entry.actor),
          entry.actionCategory,
          entry.action,
          JSON.stringify(entry.resource),
          entry.outcome,
          entry.description,
          entry.errorCode ?? null,
          entry.errorMessage ?? null,
          entry.module,
          entry.traceId ?? null,
          entry.spanId ?? null,
          entry.integrityHash,
          entry.previousHash ?? null,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
          entry.recordedAt,
        );
      });
    },

    recordRetention(checkpoint): void {
      db.withWriteTransaction((conn) => {
        conn.prepare(
          "DELETE FROM obs_audit_entries WHERE sequence_number <= ?",
        ).run(checkpoint.lastDeletedSequenceNumber);

        conn.prepare(
          `INSERT INTO obs_retention_checkpoints (
            id,
            last_deleted_sequence_number,
            boundary_hash,
            first_retained_sequence_number,
            created_at,
            reason
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          checkpoint.id,
          checkpoint.lastDeletedSequenceNumber,
          checkpoint.boundaryHash,
          checkpoint.firstRetainedSequenceNumber,
          checkpoint.createdAt,
          checkpoint.reason,
        );
      });
    },
  };
}
