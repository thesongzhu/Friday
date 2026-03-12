import type Database from "better-sqlite3";
import type { FridaySatelliteCapabilityEntry } from "../model/friday-satellite.types.js";

export interface FridaySatelliteCapabilityRow {
  id: string;
  satellite_id: string;
  key: string;
  available: number;
  metadata_json: string | null;
  limits_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface FridaySatelliteCapabilityRepository {
  upsertCapabilities(
    db: Database.Database,
    satelliteId: string,
    capabilities: FridaySatelliteCapabilityEntry[],
    nowIso: string,
    idGenerator: () => string,
  ): void;
  listBySatellite(db: Database.Database, satelliteId: string): FridaySatelliteCapabilityRow[];
}

export function createFridaySatelliteCapabilityRepository(): FridaySatelliteCapabilityRepository {
  return {
    upsertCapabilities(db, satelliteId, capabilities, nowIso, idGenerator) {
      const upsert = db.prepare(
        `INSERT INTO satellite_capabilities (id, satellite_id, key, available, metadata_json, limits_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(satellite_id, key) DO UPDATE SET
           available = excluded.available,
           metadata_json = excluded.metadata_json,
           limits_json = excluded.limits_json,
           updated_at = excluded.updated_at`,
      );

      for (const cap of capabilities) {
        upsert.run(
          idGenerator(),
          satelliteId,
          cap.key,
          cap.available ? 1 : 0,
          cap.metadata ? JSON.stringify(cap.metadata) : null,
          cap.limits ? JSON.stringify(cap.limits) : null,
          nowIso,
          nowIso,
        );
      }
    },

    listBySatellite(db, satelliteId) {
      return db
        .prepare("SELECT * FROM satellite_capabilities WHERE satellite_id = ? ORDER BY key")
        .all(satelliteId) as FridaySatelliteCapabilityRow[];
    },
  };
}
