import type Database from "better-sqlite3";
import type { FridaySatelliteHeartbeatInput } from "../model/friday-satellite.types.js";

export interface FridaySatelliteHeartbeatRow {
  id: string;
  satellite_id: string;
  ts: string;
  status: string;
  cpu_percent: number | null;
  memory_percent: number | null;
  load_avg_1m: number | null;
  queue_depth: number | null;
  active_runs: number | null;
  details_json: string | null;
}

export interface FridaySatelliteHeartbeatRepository {
  insertHeartbeat(
    db: Database.Database,
    id: string,
    input: FridaySatelliteHeartbeatInput,
    computedStatus: string,
  ): void;
  getLatestBySatellite(
    db: Database.Database,
    satelliteId: string,
  ): FridaySatelliteHeartbeatRow | undefined;
  deleteBefore(db: Database.Database, cutoffIso: string): number;
}

export function createFridaySatelliteHeartbeatRepository(): FridaySatelliteHeartbeatRepository {
  return {
    insertHeartbeat(db, id, input, computedStatus) {
      db.prepare(
        `INSERT INTO satellite_heartbeats (
          id, satellite_id, ts, status, cpu_percent, memory_percent,
          load_avg_1m, queue_depth, active_runs, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.satelliteId,
        input.ts,
        computedStatus,
        input.metrics?.cpuPercent ?? null,
        input.metrics?.memoryPercent ?? null,
        input.metrics?.loadAvg1m ?? null,
        input.queueDepth ?? null,
        input.activeRuns ?? null,
        input.details ? JSON.stringify(input.details) : null,
      );
    },

    getLatestBySatellite(db, satelliteId) {
      return db
        .prepare(
          "SELECT * FROM satellite_heartbeats WHERE satellite_id = ? ORDER BY ts DESC LIMIT 1",
        )
        .get(satelliteId) as FridaySatelliteHeartbeatRow | undefined;
    },

    deleteBefore(db, cutoffIso) {
      const result = db
        .prepare("DELETE FROM satellite_heartbeats WHERE ts < ?")
        .run(cutoffIso);
      return result.changes;
    },
  };
}
