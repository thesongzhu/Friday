import type Database from "better-sqlite3";
import type { FridaySatellitePairingStatus } from "#satellites";

// ─── Aggregation result types ───

export interface FridaySatelliteWithHeartbeatRow {
  id: string;
  type: string;
  display_name: string;
  pairing_status: string;
  trust_level: string;
  tags_json: string;
  last_seen_at: string | null;
  hb_ts: string | null;
  cpu_percent: number | null;
  memory_percent: number | null;
  load_avg_1m: number | null;
  queue_depth: number | null;
  active_runs: number | null;
}

export interface FridayQueueStatsRow {
  satellite_id: string;
  queued_count: number;
  leased_count: number;
  failed_count: number;
  dead_letter_count: number;
}

export interface FridayWorkflowLoadRow {
  satellite_id: string;
  queued_nodes: number;
  running_nodes: number;
  retrying_nodes: number;
  blocked_offline_nodes: number;
}

export interface FridayPairingStatusCountRow {
  pairing_status: string;
  count: number;
}

export interface FridayGlobalQueueStatsRow {
  queued_count: number;
  leased_count: number;
  failed_count: number;
  dead_letter_count: number;
}

export interface FridayWorkflowRunStatsRow {
  active_runs: number;
  completed_1h: number;
  failed_1h: number;
}

// ─── Repository interface ───

export interface FridayFleetDashboardRepository {
  listSatellitesWithHeartbeat(db: Database.Database): FridaySatelliteWithHeartbeatRow[];
  getQueueStatsBySatellite(db: Database.Database, satelliteId: string): FridayQueueStatsRow | null;
  getGlobalQueueStats(db: Database.Database): FridayGlobalQueueStatsRow;
  getWorkflowLoadBySatellite(db: Database.Database, satelliteId: string): FridayWorkflowLoadRow | null;
  getPairingStatusCounts(db: Database.Database): FridayPairingStatusCountRow[];
  getWorkflowRunStats(db: Database.Database, oneHourAgo: string): FridayWorkflowRunStatsRow;
  getCapabilities(db: Database.Database, satelliteId: string): Array<{
    key: string;
    available: number;
    limits_json: string | null;
    metadata_json: string | null;
  }>;
  getDeadLetterCount(db: Database.Database, satelliteId: string): number;
  getFailedNodeCount1h(db: Database.Database, satelliteId: string, oneHourAgo: string): number;
  getTotalNodeCount1h(db: Database.Database, satelliteId: string, oneHourAgo: string): number;
}

// ─── Factory ───

export function createFridayFleetDashboardRepository(): FridayFleetDashboardRepository {
  return {
    listSatellitesWithHeartbeat(db) {
      return db
        .prepare(
          `WITH latest AS (
             SELECT satellite_id, MAX(ts) AS max_ts
             FROM satellite_heartbeats
             GROUP BY satellite_id
           )
           SELECT s.id, s.display_name, s.type, s.pairing_status, s.trust_level, s.tags_json,
                  s.last_seen_at,
                  h.ts AS hb_ts, h.cpu_percent, h.memory_percent, h.load_avg_1m, h.queue_depth, h.active_runs
           FROM satellites s
           LEFT JOIN latest l ON l.satellite_id = s.id
           LEFT JOIN satellite_heartbeats h ON h.satellite_id = l.satellite_id AND h.ts = l.max_ts
           WHERE s.deleted_at IS NULL`,
        )
        .all() as FridaySatelliteWithHeartbeatRow[];
    },

    getQueueStatsBySatellite(db, satelliteId) {
      return (
        (db
          .prepare(
            `SELECT satellite_id,
               SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
               SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased_count,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
               SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter_count
             FROM outbox_messages
             WHERE satellite_id = ?
             GROUP BY satellite_id`,
          )
          .get(satelliteId) as FridayQueueStatsRow | undefined) ?? null
      );
    },

    getGlobalQueueStats(db) {
      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
             SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased_count,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
             SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter_count
           FROM outbox_messages`,
        )
        .get() as FridayGlobalQueueStatsRow | undefined;
      return row ?? { queued_count: 0, leased_count: 0, failed_count: 0, dead_letter_count: 0 };
    },

    getWorkflowLoadBySatellite(db, satelliteId) {
      return (
        (db
          .prepare(
            `WITH latest_attempt AS (
               SELECT run_id, node_id, MAX(attempt) AS max_attempt
               FROM workflow_run_nodes
               GROUP BY run_id, node_id
             )
             SELECT n.satellite_id,
               SUM(CASE WHEN n.status='queued' THEN 1 ELSE 0 END) AS queued_nodes,
               SUM(CASE WHEN n.status='running' THEN 1 ELSE 0 END) AS running_nodes,
               SUM(CASE WHEN n.status='retrying' THEN 1 ELSE 0 END) AS retrying_nodes,
               SUM(CASE WHEN n.status='blocked_offline' THEN 1 ELSE 0 END) AS blocked_offline_nodes
             FROM workflow_run_nodes n
             JOIN latest_attempt la
               ON la.run_id=n.run_id AND la.node_id=n.node_id AND la.max_attempt=n.attempt
             WHERE n.satellite_id = ?
             GROUP BY n.satellite_id`,
          )
          .get(satelliteId) as FridayWorkflowLoadRow | undefined) ?? null
      );
    },

    getPairingStatusCounts(db) {
      return db
        .prepare(
          `SELECT pairing_status, COUNT(*) AS count
           FROM satellites
           WHERE deleted_at IS NULL
           GROUP BY pairing_status`,
        )
        .all() as FridayPairingStatusCountRow[];
    },

    getWorkflowRunStats(db, oneHourAgo) {
      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN status IN ('queued','running','pausing','paused','compensating') THEN 1 ELSE 0 END) AS active_runs,
             SUM(CASE WHEN status = 'completed' AND finished_at >= ? THEN 1 ELSE 0 END) AS completed_1h,
             SUM(CASE WHEN status = 'failed' AND finished_at >= ? THEN 1 ELSE 0 END) AS failed_1h
           FROM workflow_runs`,
        )
        .get(oneHourAgo, oneHourAgo) as FridayWorkflowRunStatsRow | undefined;
      return row ?? { active_runs: 0, completed_1h: 0, failed_1h: 0 };
    },

    getCapabilities(db, satelliteId) {
      return db
        .prepare(
          "SELECT key, available, limits_json, metadata_json FROM satellite_capabilities WHERE satellite_id = ?",
        )
        .all(satelliteId) as Array<{
        key: string;
        available: number;
        limits_json: string | null;
        metadata_json: string | null;
      }>;
    },

    getDeadLetterCount(db, satelliteId) {
      const row = db
        .prepare(
          "SELECT COUNT(*) as count FROM outbox_messages WHERE satellite_id = ? AND status = 'dead_letter'",
        )
        .get(satelliteId) as { count: number };
      return row.count;
    },

    getFailedNodeCount1h(db, satelliteId, oneHourAgo) {
      const row = db
        .prepare(
          "SELECT COUNT(*) as count FROM workflow_run_nodes WHERE satellite_id = ? AND status = 'failed' AND finished_at >= ?",
        )
        .get(satelliteId, oneHourAgo) as { count: number };
      return row.count;
    },

    getTotalNodeCount1h(db, satelliteId, oneHourAgo) {
      const row = db
        .prepare(
          "SELECT COUNT(*) as count FROM workflow_run_nodes WHERE satellite_id = ? AND finished_at >= ?",
        )
        .get(satelliteId, oneHourAgo) as { count: number };
      return row.count;
    },
  };
}
