import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V046_SYSTEM_REMOTE_DEVICE_PLATFORMS_SQL = `
ALTER TABLE friday_system_remote_devices
  ADD COLUMN platform TEXT NOT NULL DEFAULT 'browser';

CREATE INDEX IF NOT EXISTS idx_friday_system_remote_devices_platform
  ON friday_system_remote_devices (platform, status, registered_at DESC);
`;

const V046_CHECKSUM = computeFridayMigrationChecksum(V046_SYSTEM_REMOTE_DEVICE_PLATFORMS_SQL);

export const V046_SYSTEM_REMOTE_DEVICE_PLATFORMS_MIGRATION: FridaySqliteMigration = {
  version: 46,
  name: "v046-system-remote-device-platforms",
  sql: V046_SYSTEM_REMOTE_DEVICE_PLATFORMS_SQL,
  checksum: V046_CHECKSUM,
};
