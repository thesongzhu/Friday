import type {
  FridayWorkflowEngineTriggerType,
  FridayWorkflowTriggerRegistrationEntity,
  FridayWorkflowTriggerRegistrationRow,
} from "../model/friday-workflow-engine.types.js";
import type { FridaySqliteLayer } from "#state";

// ─── Interface ───

export interface FridayWorkflowTriggerRepository {
  upsertManyForVersion(
    input: FridayWorkflowTriggerRegistrationEntity[],
  ): void;

  listByWorkflow(
    workflowId: string,
  ): FridayWorkflowTriggerRegistrationEntity[];

  listDueCron(
    nowIso: string,
    limit: number,
  ): FridayWorkflowTriggerRegistrationEntity[];

  getByWebhookToken(
    pathToken: string,
  ): FridayWorkflowTriggerRegistrationEntity | null;

  listByEvent(
    source: string,
    event: string,
  ): FridayWorkflowTriggerRegistrationEntity[];

  markFired(
    id: string,
    firedAt: string,
    nextFireAt?: string,
  ): void;

  setEnabled(
    id: string,
    enabled: boolean,
    nowIso: string,
  ): void;

  deleteByWorkflowVersion(
    workflowVersionId: string,
  ): void;

  deleteByWorkflow(
    workflowId: string,
  ): void;
}

// ─── Row mapper ───

function mapTriggerRow(
  row: FridayWorkflowTriggerRegistrationRow,
): FridayWorkflowTriggerRegistrationEntity {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    triggerNodeId: row.trigger_node_id,
    triggerType: row.trigger_type as FridayWorkflowEngineTriggerType,
    enabled: row.enabled === 1,
    cronExpression: row.cron_expression ?? undefined,
    cronTimezone: row.cron_timezone ?? undefined,
    webhookPathToken: row.webhook_path_token ?? undefined,
    webhookSecretRef: row.webhook_secret_ref ?? undefined,
    webhookSignatureHeader: row.webhook_signature_header ?? undefined,
    eventSource: row.event_source ?? undefined,
    eventName: row.event_name ?? undefined,
    eventFilterExpr: row.event_filter_expr ?? undefined,
    pluginId: row.plugin_id ?? undefined,
    dedupeWindowSec: row.dedupe_window_sec,
    lastFiredAt: row.last_fired_at ?? undefined,
    nextFireAt: row.next_fire_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export interface CreateFridayWorkflowTriggerRepositoryDeps {
  db: FridaySqliteLayer;
}

export function createFridayWorkflowTriggerRepository(
  deps: CreateFridayWorkflowTriggerRepositoryDeps,
): FridayWorkflowTriggerRepository {
  const { db } = deps;

  return {
    upsertManyForVersion(input) {
      db.withWriteTransaction((conn) => {
        const stmt = conn.prepare(
          `INSERT INTO workflow_trigger_registrations (
            id, workflow_id, workflow_version_id, trigger_node_id, trigger_type,
            enabled, cron_expression, cron_timezone, webhook_path_token,
            webhook_secret_ref, webhook_signature_header, event_source,
            event_name, event_filter_expr, plugin_id, dedupe_window_sec,
            last_fired_at, next_fire_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workflow_version_id, trigger_node_id) DO UPDATE SET
            trigger_type = excluded.trigger_type,
            enabled = excluded.enabled,
            cron_expression = excluded.cron_expression,
            cron_timezone = excluded.cron_timezone,
            webhook_path_token = COALESCE(workflow_trigger_registrations.webhook_path_token, excluded.webhook_path_token),
            webhook_secret_ref = excluded.webhook_secret_ref,
            webhook_signature_header = excluded.webhook_signature_header,
            event_source = excluded.event_source,
            event_name = excluded.event_name,
            event_filter_expr = excluded.event_filter_expr,
            plugin_id = excluded.plugin_id,
            dedupe_window_sec = excluded.dedupe_window_sec,
            next_fire_at = excluded.next_fire_at,
            updated_at = excluded.updated_at`,
        );

        for (const entity of input) {
          stmt.run(
            entity.id,
            entity.workflowId,
            entity.workflowVersionId,
            entity.triggerNodeId,
            entity.triggerType,
            entity.enabled ? 1 : 0,
            entity.cronExpression ?? null,
            entity.cronTimezone ?? null,
            entity.webhookPathToken ?? null,
            entity.webhookSecretRef ?? null,
            entity.webhookSignatureHeader ?? null,
            entity.eventSource ?? null,
            entity.eventName ?? null,
            entity.eventFilterExpr ?? null,
            entity.pluginId ?? null,
            entity.dedupeWindowSec,
            entity.lastFiredAt ?? null,
            entity.nextFireAt ?? null,
            entity.createdAt,
            entity.updatedAt,
          );
        }
      });
    },

    listByWorkflow(workflowId) {
      return db.withReadConnection((conn) => {
        const rows = conn
          .prepare(
            "SELECT * FROM workflow_trigger_registrations WHERE workflow_id = ? ORDER BY created_at",
          )
          .all(workflowId) as FridayWorkflowTriggerRegistrationRow[];
        return rows.map(mapTriggerRow);
      });
    },

    listDueCron(nowIso, limit) {
      return db.withReadConnection((conn) => {
        const rows = conn
          .prepare(
            `SELECT * FROM workflow_trigger_registrations
             WHERE trigger_type = 'cron'
               AND enabled = 1
               AND next_fire_at IS NOT NULL
               AND next_fire_at <= ?
             ORDER BY next_fire_at ASC
             LIMIT ?`,
          )
          .all(nowIso, limit) as FridayWorkflowTriggerRegistrationRow[];
        return rows.map(mapTriggerRow);
      });
    },

    getByWebhookToken(pathToken) {
      return db.withReadConnection((conn) => {
        const row = conn
          .prepare(
            "SELECT * FROM workflow_trigger_registrations WHERE webhook_path_token = ? AND enabled = 1",
          )
          .get(pathToken) as FridayWorkflowTriggerRegistrationRow | undefined;
        return row ? mapTriggerRow(row) : null;
      });
    },

    listByEvent(source, event) {
      return db.withReadConnection((conn) => {
        const rows = conn
          .prepare(
            `SELECT * FROM workflow_trigger_registrations
             WHERE trigger_type = 'event'
               AND enabled = 1
               AND event_source = ?
               AND event_name = ?`,
          )
          .all(source, event) as FridayWorkflowTriggerRegistrationRow[];
        return rows.map(mapTriggerRow);
      });
    },

    markFired(id, firedAt, nextFireAt) {
      db.withWriteTransaction((conn) => {
        conn.prepare(
          `UPDATE workflow_trigger_registrations
           SET last_fired_at = ?, next_fire_at = ?, updated_at = ?
           WHERE id = ?`,
        ).run(firedAt, nextFireAt ?? null, firedAt, id);
      });
    },

    setEnabled(id, enabled, nowIso) {
      db.withWriteTransaction((conn) => {
        conn.prepare(
          `UPDATE workflow_trigger_registrations
           SET enabled = ?, updated_at = ?
           WHERE id = ?`,
        ).run(enabled ? 1 : 0, nowIso, id);
      });
    },

    deleteByWorkflowVersion(workflowVersionId) {
      db.withWriteTransaction((conn) => {
        conn.prepare(
          "DELETE FROM workflow_trigger_registrations WHERE workflow_version_id = ?",
        ).run(workflowVersionId);
      });
    },

    deleteByWorkflow(workflowId) {
      db.withWriteTransaction((conn) => {
        conn.prepare(
          "DELETE FROM workflow_trigger_registrations WHERE workflow_id = ?",
        ).run(workflowId);
      });
    },
  };
}
