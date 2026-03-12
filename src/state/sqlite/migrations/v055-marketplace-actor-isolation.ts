import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V055_MARKETPLACE_ACTOR_ISOLATION_SQL = `
-- V055: quarantine legacy marketplace request/support rows with unverifiable tenant attribution.

ALTER TABLE marketplace_support_events
  ADD COLUMN actor_schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE marketplace_support_events
  ADD COLUMN actor_quarantined INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketplace_support_events
  ADD COLUMN actor_quarantine_reason TEXT;

UPDATE marketplace_support_events
   SET actor_schema_version = 2
 WHERE TRIM(COALESCE(supporter_tenant_id, '')) <> ''
   AND TRIM(COALESCE(supporter_principal_id, '')) <> ''
   AND supporter_tenant_id <> supporter_principal_id;

UPDATE marketplace_support_events
   SET actor_quarantined = 1,
       actor_quarantine_reason = COALESCE(actor_quarantine_reason, 'legacy_actor_tenant_unverifiable')
 WHERE actor_schema_version = 1;

CREATE INDEX IF NOT EXISTS idx_marketplace_support_events_actor_quarantined
  ON marketplace_support_events (actor_quarantined, created_at DESC);

ALTER TABLE marketplace_requests
  ADD COLUMN actor_schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE marketplace_requests
  ADD COLUMN actor_quarantined INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketplace_requests
  ADD COLUMN actor_quarantine_reason TEXT;

UPDATE marketplace_requests
   SET actor_schema_version = 2
 WHERE TRIM(COALESCE(requester_tenant_id, '')) <> ''
   AND TRIM(COALESCE(requester_principal_id, '')) <> ''
   AND requester_tenant_id <> requester_principal_id;

UPDATE marketplace_requests
   SET actor_quarantined = 1,
       actor_quarantine_reason = COALESCE(actor_quarantine_reason, 'legacy_actor_tenant_unverifiable')
 WHERE actor_schema_version = 1;

CREATE INDEX IF NOT EXISTS idx_marketplace_requests_actor_quarantined
  ON marketplace_requests (actor_quarantined, updated_at DESC, created_at DESC);

ALTER TABLE marketplace_request_responses
  ADD COLUMN actor_schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE marketplace_request_responses
  ADD COLUMN actor_quarantined INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketplace_request_responses
  ADD COLUMN actor_quarantine_reason TEXT;

UPDATE marketplace_request_responses
   SET actor_schema_version = 2
 WHERE TRIM(COALESCE(responder_tenant_id, '')) <> ''
   AND TRIM(COALESCE(responder_principal_id, '')) <> ''
   AND responder_tenant_id <> responder_principal_id;

UPDATE marketplace_request_responses
   SET actor_quarantined = 1,
       actor_quarantine_reason = COALESCE(actor_quarantine_reason, 'legacy_actor_tenant_unverifiable')
 WHERE actor_schema_version = 1;

CREATE INDEX IF NOT EXISTS idx_marketplace_request_responses_actor_quarantined
  ON marketplace_request_responses (actor_quarantined, request_id, created_at ASC);
`;

const V055_CHECKSUM = computeFridayMigrationChecksum(
  V055_MARKETPLACE_ACTOR_ISOLATION_SQL,
);

export const V055_MARKETPLACE_ACTOR_ISOLATION_MIGRATION: FridaySqliteMigration = {
  version: 55,
  name: "v055-marketplace-actor-isolation",
  sql: V055_MARKETPLACE_ACTOR_ISOLATION_SQL,
  checksum: V055_CHECKSUM,
};
