import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V054_MARKETPLACE_REQUEST_BOARD_SQL = `
CREATE TABLE IF NOT EXISTS marketplace_requests (
  id TEXT PRIMARY KEY,
  asset_kind TEXT NOT NULL,
  requester_tenant_id TEXT NOT NULL,
  requester_principal_id TEXT NOT NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  desired_outcome TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  budget_support_intent TEXT,
  privacy TEXT NOT NULL,
  publishability TEXT NOT NULL,
  risk_notes TEXT,
  status TEXT NOT NULL,
  accepted_response_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_marketplace_requests_status_updated
  ON marketplace_requests (status, updated_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_requests_requester
  ON marketplace_requests (requester_principal_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_request_responses (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  responder_tenant_id TEXT NOT NULL,
  responder_principal_id TEXT NOT NULL,
  responder_creator_id TEXT,
  message TEXT NOT NULL,
  proposal TEXT,
  deliverable_asset_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marketplace_request_responses_request
  ON marketplace_request_responses (request_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_marketplace_request_responses_creator
  ON marketplace_request_responses (responder_creator_id, created_at DESC);
`;

const V054_CHECKSUM = computeFridayMigrationChecksum(
  V054_MARKETPLACE_REQUEST_BOARD_SQL,
);

export const V054_MARKETPLACE_REQUEST_BOARD_MIGRATION: FridaySqliteMigration = {
  version: 54,
  name: "v054-marketplace-request-board",
  sql: V054_MARKETPLACE_REQUEST_BOARD_SQL,
  checksum: V054_CHECKSUM,
};
