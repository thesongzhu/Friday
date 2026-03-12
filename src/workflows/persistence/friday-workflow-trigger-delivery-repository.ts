import type {
  FridayWorkflowTriggerDeliveryEntity,
  FridayWorkflowTriggerDeliveryRow,
  FridayWorkflowTriggerDeliveryStatus,
} from "../model/friday-workflow-engine.types.js";
import type { FridaySqliteLayer } from "#state";

// ─── Interface ───

export interface FridayWorkflowTriggerDeliveryRepository {
  tryInsert(
    input: {
      id: string;
      triggerRegistrationId: string;
      dedupeKey: string;
      status: FridayWorkflowTriggerDeliveryStatus;
      deliveredAt: string;
    },
  ): boolean;

  markAccepted(
    triggerRegistrationId: string,
    dedupeKey: string,
    runId: string,
  ): void;

  markFailed(
    triggerRegistrationId: string,
    dedupeKey: string,
    code: string,
    message: string,
  ): void;
}

// ─── Row mapper ───

function mapDeliveryRow(
  row: FridayWorkflowTriggerDeliveryRow,
): FridayWorkflowTriggerDeliveryEntity {
  return {
    id: row.id,
    triggerRegistrationId: row.trigger_registration_id,
    dedupeKey: row.dedupe_key,
    runId: row.run_id ?? undefined,
    status: row.status as FridayWorkflowTriggerDeliveryStatus,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
  };
}

// ─── Constraint name for dedupe UNIQUE(trigger_registration_id, dedupe_key) ───

const FRIDAY_WORKFLOW_DELIVERY_DEDUPE_COLUMNS =
  "workflow_trigger_deliveries.trigger_registration_id, workflow_trigger_deliveries.dedupe_key";

// ─── Factory ───

export interface CreateFridayWorkflowTriggerDeliveryRepositoryDeps {
  db: FridaySqliteLayer;
  nowIso: () => string;
}

export function createFridayWorkflowTriggerDeliveryRepository(
  deps: CreateFridayWorkflowTriggerDeliveryRepositoryDeps,
): FridayWorkflowTriggerDeliveryRepository & {
  /** Implementation-only helper for verification; not part of the interface contract. */
  getByDedupeKey(
    triggerRegistrationId: string,
    dedupeKey: string,
  ): FridayWorkflowTriggerDeliveryEntity | null;
} {
  const { db, nowIso } = deps;

  return {
    tryInsert(input) {
      return db.withWriteTransaction((conn) => {
        try {
          conn.prepare(
            `INSERT INTO workflow_trigger_deliveries (
              id, trigger_registration_id, dedupe_key, run_id, status,
              error_code, error_message, delivered_at, created_at
            ) VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, ?)`,
          ).run(
            input.id,
            input.triggerRegistrationId,
            input.dedupeKey,
            input.status,
            input.deliveredAt,
            nowIso(),
          );
          return true;
        } catch (err: unknown) {
          if (
            err instanceof Error &&
            err.message.includes("UNIQUE constraint failed") &&
            err.message.includes(FRIDAY_WORKFLOW_DELIVERY_DEDUPE_COLUMNS)
          ) {
            return false;
          }
          throw err;
        }
      });
    },

    markAccepted(triggerRegistrationId, dedupeKey, runId) {
      db.withWriteTransaction((conn) => {
        conn.prepare(
          `UPDATE workflow_trigger_deliveries
           SET status = 'accepted', run_id = ?
           WHERE trigger_registration_id = ? AND dedupe_key = ?`,
        ).run(runId, triggerRegistrationId, dedupeKey);
      });
    },

    markFailed(triggerRegistrationId, dedupeKey, code, message) {
      db.withWriteTransaction((conn) => {
        conn.prepare(
          `UPDATE workflow_trigger_deliveries
           SET status = 'failed', error_code = ?, error_message = ?
           WHERE trigger_registration_id = ? AND dedupe_key = ?`,
        ).run(code, message, triggerRegistrationId, dedupeKey);
      });
    },

    getByDedupeKey(triggerRegistrationId, dedupeKey) {
      return db.withReadConnection((conn) => {
        const row = conn
          .prepare(
            `SELECT * FROM workflow_trigger_deliveries
             WHERE trigger_registration_id = ? AND dedupe_key = ?`,
          )
          .get(triggerRegistrationId, dedupeKey) as
          | FridayWorkflowTriggerDeliveryRow
          | undefined;
        return row ? mapDeliveryRow(row) : null;
      });
    },
  };
}
