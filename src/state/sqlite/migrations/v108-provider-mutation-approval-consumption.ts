import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V108_PROVIDER_MUTATION_APPROVAL_CONSUMPTION_SQL = `
-- ============================================================
-- V108: Durable single-use ledger for canonical mutating-action approvals
-- (SEC-APPROVAL-AUTHORITY-001 · CORE-A round-3 Lane B · Advisor round-2 finding #3).
-- ADDITIVE — creates ONE new table, removes/disables NOTHING.
-- ============================================================
--
-- Advisor finding #3: provider-approval single-use lived ONLY in a process-local
-- in-memory Set (\`consumedCanonicalApprovalKeys\` in the mutating-action gate) plus the
-- in-memory \`providerMutationPlans\` confirmed marker. Both die on restart, so a fresh
-- process re-admitted the SAME device-authored approval — the signed \`deviceProof\` is
-- re-verified asymmetrically, so a captured confirmed approval could be replayed after a
-- restart to drive a SECOND provider mutation. This durable ledger closes that: the
-- canonical approval USE KEY (approvalId:actionDigest:issuer:hmac:deviceSignature — see
-- \`createCanonicalApprovalUseKey\`) is the PRIMARY KEY, so a replayed approval hits a PK
-- conflict and is refused as \`canonical_approval_already_used\` across restarts and across
-- concurrent processes. It is a SEPARATE table from the append-only audit ledger and from
-- the http_operation_journal (v100); the two guard different keys (approval use key vs.
-- principal:operation:idempotencyKey).

CREATE TABLE IF NOT EXISTS provider_mutation_approval_consumption (
  -- The canonical approval USE KEY (createCanonicalApprovalUseKey): approvalId, the exact
  -- recomputed action digest, the issuer, the normalized symmetric HMAC (if any) AND the
  -- raw device P-1363 signature. A replay of the identical signed approval reproduces this
  -- key EXACTLY and so collides on the PK.
  use_key TEXT PRIMARY KEY,
  action_digest TEXT NOT NULL,
  idempotency_key TEXT,
  -- The mutating action this approval was consumed for (e.g. 'providers.create'), for
  -- provenance/observability only — it is NOT part of the single-use key.
  mutation_operation_id TEXT NOT NULL,
  -- 'in_flight'    = a two-phase reservation whose paired mutation has not yet committed
  --                  (the consume completes to 'consumed' in the SAME write transaction as
  --                  the provider mutation, so a rollback unwinds BOTH). A crash between the
  --                  reserve and that commit leaves an 'in_flight' orphan.
  -- 'consumed'     = the approval was durably spent (single-INSERT inline, or two-phase
  --                  completion committed atomically with the mutation).
  -- 'indeterminate'= an 'in_flight' orphan reconciled at boot: fail-closed, never re-admitted.
  -- ALL three statuses collide on the PK, so a replay is refused regardless of status.
  status TEXT NOT NULL DEFAULT 'consumed'
    CHECK (status IN ('in_flight', 'consumed', 'indeterminate')),
  consumed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL
);

-- Supports the boot-time reconcile scan (mark orphaned in_flight rows indeterminate).
CREATE INDEX IF NOT EXISTS idx_provider_mutation_approval_consumption_status
  ON provider_mutation_approval_consumption (status);
`;

const V108_CHECKSUM = computeFridayMigrationChecksum(V108_PROVIDER_MUTATION_APPROVAL_CONSUMPTION_SQL);

export const V108_PROVIDER_MUTATION_APPROVAL_CONSUMPTION_MIGRATION: FridaySqliteMigration = {
  version: 108,
  name: "v108-provider-mutation-approval-consumption",
  sql: V108_PROVIDER_MUTATION_APPROVAL_CONSUMPTION_SQL,
  checksum: V108_CHECKSUM,
};
