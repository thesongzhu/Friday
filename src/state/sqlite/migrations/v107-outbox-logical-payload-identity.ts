import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V107_OUTBOX_LOGICAL_PAYLOAD_IDENTITY_SQL = `
-- V107: Outbox payload-bound idempotency identity (DUR-OPERATION-JOURNAL-001 follow-up #4).
-- The v100 outbox \`payload_digest\` is a ROUTING-only digest and cannot distinguish a reused
-- idempotency_key carrying a DIFFERENT logical operation payload. Add a digest over the STABLE
-- logical payload (excluding volatile transport/timestamp fields), computed by the caller before
-- encryption, so a same-key/different-payload enqueue is a typed conflict. Nullable + additive:
-- existing (pre-v107) rows are NULL and are treated as legacy → fail-closed on re-enqueue (their
-- original logical-payload identity is not reconstructable).
ALTER TABLE outbox_messages ADD COLUMN logical_payload_digest TEXT;
`;

const V107_CHECKSUM = computeFridayMigrationChecksum(V107_OUTBOX_LOGICAL_PAYLOAD_IDENTITY_SQL);

export const V107_OUTBOX_LOGICAL_PAYLOAD_IDENTITY_MIGRATION: FridaySqliteMigration = {
  version: 107,
  name: "v107-outbox-logical-payload-identity",
  sql: V107_OUTBOX_LOGICAL_PAYLOAD_IDENTITY_SQL,
  checksum: V107_CHECKSUM,
};
