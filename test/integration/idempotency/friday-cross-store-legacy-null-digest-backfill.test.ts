/**
 * DUR-OPERATION-JOURNAL-001 — follow-up defect #4: legacy-NULL digest reconciliation (integration).
 *
 * The cross-store digest-conflict guards added by the merged PR (#1623) short-circuit when the
 * EXISTING row's `payload_digest` is NULL — the state of every row written BEFORE the v100
 * migration added the (nullable) `payload_digest` column. Because the guard only fired on a
 * NON-NULL divergent digest, a divergent re-projection / re-enqueue that targets a legacy row was
 * neither recorded nor flagged: silently swallowed by `INSERT OR IGNORE` / resolved to the existing
 * id. The fix closes that gap — but a legacy row must NEVER be stamped with a digest we cannot
 * validate, or a divergent first-write gets laundered into "the canonical digest".
 *
 * Two site classes, per whether the row's ORIGINAL identity is exactly reconstructable:
 *
 *  • PROJECTOR (friday_agent_runs + llm_usage_records): the digest is over the WHOLE receipt, which
 *    is NOT persisted, and several inserted columns / unpersisted receipt fields (task,
 *    provider_kind, modelSize, backendKind, …) cannot be recovered. The original identity CANNOT be
 *    reconstructed, so the projector FAILS CLOSED: any digest-bearing projection onto a legacy
 *    (NULL-digest) row raises the typed 409 (SECURITY_IDEMPOTENCY_KEY_CONFLICT) and stamps NOTHING.
 *    (`null !== incomingDigest` is always true.) This still closes the silent-swallow — divergence
 *    now surfaces loudly. A non-null EXACT digest match is the idempotent no-op (unchanged).
 *
 *  • OUTBOX (outbox_messages): the digest is over the stable routing identity
 *    {satelliteId, queueKey, messageType, keyId}, ALL persisted columns, so a legacy row's identity
 *    IS exactly reconstructable. The outbox recomputes the canonical digest from the row's own
 *    stored columns and BACKFILLS on an exact match (no over-fail for a legitimate same-identity
 *    re-enqueue), or raises the typed 409 on a mismatch — never laundering a divergent write.
 *
 * RED-FIRST (vs the prior head 4c4859f5, which compared only SELECTED projector columns): a legacy
 * projector row whose divergence lives in an OMITTED column (task / provider_kind) or an UNPERSISTED
 * receipt field (modelSize) was ACCEPTED and stamped there; here each such case must 409 and leave
 * payload_digest NULL. The outbox exact-recompute cases are unchanged.
 */

import { describe, expect, it } from "vitest";

import type { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayOutboxMessageRepository,
  createFridayOutboxQueueService,
  type FridayOutboxEnqueueInput,
} from "#satellites";
import { hashIdempotencyPayload } from "../../../src/api/http/routes/friday-route-idempotency.js";
import { createTestDb, createTestIdGenerator } from "../../unit/satellites/_helpers/create-test-db.helper.js";
import {
  createFridayRustHubRunContinuityProjectorService,
  usageLedgerIdForRun,
  type FridayRustHubRunReceipt,
} from "../../../src/api/mission-spine/friday-rust-hub-run-continuity-projector-service.js";

const NOW = "2026-07-12T10:00:00.000Z";

const BASE_RECEIPT: FridayRustHubRunReceipt = {
  truthLabel: "rust_wired_dev",
  proofOnly: true,
  ok: true,
  runId: "hub_run_task_dev_legacy_1720000000000000000",
  routeId: "deepseek:deepseek-v4-flash",
  providerId: "deepseek",
  model: "deepseek-v4-flash",
  modelSize: "Flash",
  backendKind: "Http",
  loopStatus: "Finished",
  errorCategory: null,
  turns: 3,
  executedTools: 2,
  finalMessageSha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", // pragma: allowlist secret
  finalMessageLen: 128,
  auditChainVerified: true,
  usagePromptTokens: 1500,
  usageCompletionTokens: 420,
  usageTotalTokens: 1920,
  completedAtIso: NOW,
};

function isConflict(err: unknown): err is FridayDomainError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "SECURITY_IDEMPOTENCY_KEY_CONFLICT"
  );
}

/** Run `fn`, returning whatever it threw (or `undefined` if it did not throw). */
function capture(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

function expectConflict(caught: unknown): void {
  expect(isConflict(caught)).toBe(true);
  expect((caught as FridayDomainError).httpStatus).toBe(409);
}

/**
 * Drive the REAL projector exactly as production does: inside a write transaction
 * (`composeRustReadOnlyAgentRun` runs `project()` in `withWriteTransaction`), so a thrown
 * conflict rolls back any partial insert — faithful atomicity, not a bare handle.
 */
function project(layer: FridaySqliteLayer, receipt: FridayRustHubRunReceipt) {
  const projector = createFridayRustHubRunContinuityProjectorService();
  return layer.withWriteTransaction((db) => projector.project(db, receipt));
}

function agentRunDigest(layer: FridaySqliteLayer, runId: string): string | null {
  const row = layer.writer
    .prepare("SELECT payload_digest FROM friday_agent_runs WHERE id = ?")
    .get(runId) as { payload_digest: string | null } | undefined;
  return row ? row.payload_digest : null;
}

function usageDigest(layer: FridaySqliteLayer, usageId: string): string | null {
  const row = layer.writer
    .prepare("SELECT payload_digest FROM llm_usage_records WHERE id = ?")
    .get(usageId) as { payload_digest: string | null } | undefined;
  return row ? row.payload_digest : null;
}

/** Simulate the pre-v100 state: NULL out the digest columns the migration added as nullable. */
function makeLegacy(layer: FridaySqliteLayer, runId: string): void {
  layer.writer.prepare("UPDATE friday_agent_runs SET payload_digest = NULL WHERE id = ?").run(runId);
  layer.writer
    .prepare("UPDATE llm_usage_records SET payload_digest = NULL WHERE id = ?")
    .run(usageLedgerIdForRun(runId));
}

describe("legacy-NULL digest FAIL-CLOSED — Rust projector (friday_agent_runs, site 1)", () => {
  it("a digest-bearing projection onto a legacy NULL-digest row raises the typed 409 and stamps nothing", () => {
    const layer = createTestDb();
    try {
      const runId = BASE_RECEIPT.runId;
      project(layer, BASE_RECEIPT);
      makeLegacy(layer, runId);
      expect(agentRunDigest(layer, runId)).toBe(null); // precondition: legacy NULL

      // Even the SAME receipt cannot prove the legacy row's original identity (the raw receipt is
      // not stored), so it fails closed rather than stamping an unvalidatable digest. This is the
      // intended fail-closed over-fail; in practice the pre-v100 projected-row population is empty
      // (the projector post-dates v100 and is gated DEFAULT-OFF).
      expectConflict(capture(() => project(layer, BASE_RECEIPT)));
      expect(agentRunDigest(layer, runId)).toBe(null); // nothing stamped; throw rolled back
    } finally {
      layer.close();
    }
  });

  it("a legacy row whose OMITTED column (task) diverges is NOT laundered — 409, digest stays null", () => {
    const layer = createTestDb();
    try {
      const runId = BASE_RECEIPT.runId;
      project(layer, BASE_RECEIPT);
      // A legacy row whose `task` differs from what the projection would write. `task` was omitted
      // from the prior head's content-identity, so it MATCHED there and got backfilled (laundered).
      layer.writer
        .prepare("UPDATE friday_agent_runs SET task = 'a genuinely different task', payload_digest = NULL WHERE id = ?")
        .run(runId);
      expect(agentRunDigest(layer, runId)).toBe(null);

      expectConflict(capture(() => project(layer, BASE_RECEIPT)));
      expect(agentRunDigest(layer, runId)).toBe(null);
    } finally {
      layer.close();
    }
  });

  it("a receipt differing only in the UNPERSISTED modelSize is NOT laundered — 409, digest stays null", () => {
    const layer = createTestDb();
    try {
      const runId = BASE_RECEIPT.runId;
      project(layer, BASE_RECEIPT);
      makeLegacy(layer, runId);
      expect(agentRunDigest(layer, runId)).toBe(null);

      // modelSize/backendKind are never persisted to any column, so the prior head's content-identity
      // could not see this divergence and stamped the incoming whole-receipt digest. Fail-closed 409.
      const modelSizeVariant: FridayRustHubRunReceipt = { ...BASE_RECEIPT, modelSize: "Pro" };
      expect(hashIdempotencyPayload(modelSizeVariant)).not.toBe(hashIdempotencyPayload(BASE_RECEIPT)); // whole-receipt digest DID diverge
      expectConflict(capture(() => project(layer, modelSizeVariant)));
      expect(agentRunDigest(layer, runId)).toBe(null);
    } finally {
      layer.close();
    }
  });

  it("a non-null EXACT digest match stays an idempotent no-op (happy path unchanged)", () => {
    const layer = createTestDb();
    try {
      const runId = BASE_RECEIPT.runId;
      const dBase = hashIdempotencyPayload(BASE_RECEIPT);
      project(layer, BASE_RECEIPT);
      expect(agentRunDigest(layer, runId)).toBe(dBase); // fresh insert stamped the digest

      // Re-project the same receipt (digest NON-null): exact match → no throw, no dup.
      expect(() => project(layer, BASE_RECEIPT)).not.toThrow();
      expect(agentRunDigest(layer, runId)).toBe(dBase);
      const count = layer.writer
        .prepare("SELECT COUNT(*) AS n FROM friday_agent_runs WHERE id = ?")
        .get(runId) as { n: number };
      expect(count.n).toBe(1);
    } finally {
      layer.close();
    }
  });

  it("a non-null DIFFERENT digest raises the typed 409 (unchanged #1623 behavior)", () => {
    const layer = createTestDb();
    try {
      project(layer, BASE_RECEIPT);
      // Digest is now non-null; a divergent receipt for the same run_id → typed 409.
      const divergent: FridayRustHubRunReceipt = { ...BASE_RECEIPT, usagePromptTokens: 9999, usageTotalTokens: 10_419 };
      expectConflict(capture(() => project(layer, divergent)));
    } finally {
      layer.close();
    }
  });
});

describe("legacy-NULL digest FAIL-CLOSED — Rust projector (llm_usage_records, site 2)", () => {
  // Site 2 is the SOLE divergence check when the terminal agent_run row was reaped (the retention
  // reaper deletes completed/failed agent_runs) while the longer-retained usage/cost ledger row
  // survives: the re-projection re-inserts the agent_run fresh (no conflict at site 1) and the usage
  // guard is reached. We drive the REAL projector against exactly that partial-legacy shape.
  it("a legacy usage row (agent_run reaped) whose OMITTED column (provider_kind) diverges is NOT laundered — 409, digest stays null", () => {
    const layer = createTestDb();
    try {
      const runId = BASE_RECEIPT.runId;
      const usageId = usageLedgerIdForRun(runId);

      project(layer, BASE_RECEIPT);
      // A legacy usage row whose `provider_kind` differs from the projection's constant ('unknown').
      // provider_kind was omitted from the prior head's usage content-identity → matched → laundered.
      layer.writer
        .prepare("UPDATE llm_usage_records SET provider_kind = 'deepseek', payload_digest = NULL WHERE id = ?")
        .run(usageId);
      layer.writer.prepare("DELETE FROM friday_agent_runs WHERE id = ?").run(runId); // reap → reach site 2
      expect(usageDigest(layer, usageId)).toBe(null);

      expectConflict(capture(() => project(layer, BASE_RECEIPT)));
      expect(usageDigest(layer, usageId)).toBe(null);
    } finally {
      layer.close();
    }
  });

  it("a plain legacy usage row (agent_run reaped) fails closed on any digest-bearing projection — 409, digest stays null", () => {
    const layer = createTestDb();
    try {
      const runId = BASE_RECEIPT.runId;
      const usageId = usageLedgerIdForRun(runId);

      project(layer, BASE_RECEIPT);
      layer.writer.prepare("UPDATE llm_usage_records SET payload_digest = NULL WHERE id = ?").run(usageId);
      layer.writer.prepare("DELETE FROM friday_agent_runs WHERE id = ?").run(runId);
      expect(usageDigest(layer, usageId)).toBe(null);

      expectConflict(capture(() => project(layer, BASE_RECEIPT)));
      expect(usageDigest(layer, usageId)).toBe(null);
    } finally {
      layer.close();
    }
  });
});

describe("legacy-NULL digest EXACT-RECOMPUTE backfill — satellite outbox enqueue (site 3)", () => {
  const SAT = "sat-outbox-legacy-1";

  function insertSatellite(layer: FridaySqliteLayer, id: string): void {
    layer.writer
      .prepare(
        `INSERT INTO satellites (id, type, display_name, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json, created_at, updated_at)
         VALUES (?, 'phone', 'Test', 'online', 'restricted', 'pk', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?)`,
      )
      .run(id, NOW, NOW);
  }

  function makeService(layer: FridaySqliteLayer) {
    return createFridayOutboxQueueService({
      db: layer,
      outboxRepo: createFridayOutboxMessageRepository(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });
  }

  const base: FridayOutboxEnqueueInput = {
    satelliteId: SAT,
    queueKey: "workflow:run-1",
    messageType: "workflow.node.execute",
    payloadCiphertext: "cipher-A",
    nonce: "nonce-A",
    keyId: "inline-transport:v1",
    idempotencyKey: "idem-legacy-1",
  };

  function digestOf(input: FridayOutboxEnqueueInput): string {
    return hashIdempotencyPayload({
      satelliteId: input.satelliteId,
      queueKey: input.queueKey,
      messageType: input.messageType,
      keyId: input.keyId,
    });
  }

  function rowDigest(layer: FridaySqliteLayer, satelliteId: string, idempotencyKey: string): string | null {
    const row = layer.writer
      .prepare(
        "SELECT payload_digest FROM outbox_messages WHERE satellite_id = ? AND idempotency_key = ?",
      )
      .get(satelliteId, idempotencyKey) as { payload_digest: string | null } | undefined;
    return row ? row.payload_digest : null;
  }

  function rowCount(layer: FridaySqliteLayer, satelliteId: string, idempotencyKey: string): number {
    return (
      layer.writer
        .prepare("SELECT COUNT(*) AS n FROM outbox_messages WHERE satellite_id = ? AND idempotency_key = ?")
        .get(satelliteId, idempotencyKey) as { n: number }
    ).n;
  }

  function makeLegacyRow(layer: FridaySqliteLayer, satelliteId: string, idempotencyKey: string): void {
    layer.writer
      .prepare(
        "UPDATE outbox_messages SET payload_digest = NULL WHERE satellite_id = ? AND idempotency_key = ?",
      )
      .run(satelliteId, idempotencyKey);
  }

  it("REJECTS a DIVERGENT enqueue against a legacy row on first contact — never launders its digest", () => {
    const layer = createTestDb();
    try {
      insertSatellite(layer, SAT);
      const service = makeService(layer);

      const first = service.enqueue(base);
      expect(first.id).toBeTruthy();
      makeLegacyRow(layer, SAT, base.idempotencyKey);
      expect(rowDigest(layer, SAT, base.idempotencyKey)).toBe(null); // precondition: legacy NULL

      // Different routing identity (DIFFERENT message_type) — the recompute over the row's stored
      // routing columns will not match → typed 409 (not a stamp/resolve). All four digest inputs are
      // persisted columns, so this comparison is exact.
      const divergent: FridayOutboxEnqueueInput = { ...base, messageType: "skill.execute" };
      expectConflict(capture(() => service.enqueue(divergent)));
      expect(rowCount(layer, SAT, base.idempotencyKey)).toBe(1);
      expect(rowDigest(layer, SAT, base.idempotencyKey)).toBe(null);
    } finally {
      layer.close();
    }
  });

  it("BACKFILLS a legacy row on a SAME-identity re-enqueue (no over-fail), then conflicts when a later enqueue diverges", () => {
    const layer = createTestDb();
    try {
      insertSatellite(layer, SAT);
      const service = makeService(layer);
      const dSame = digestOf(base);

      const first = service.enqueue(base);
      makeLegacyRow(layer, SAT, base.idempotencyKey);
      expect(rowDigest(layer, SAT, base.idempotencyKey)).toBe(null);

      // Same routing identity + key, re-encoded transport body (fresh nonce/ciphertext): the routing
      // digest recomputed from stored columns matches → resolves to the original id (no-degrade) and
      // backfills the canonical digest. Exact reconstruction ⇒ safe to stamp.
      const retry = service.enqueue({ ...base, payloadCiphertext: "cipher-A-reencoded", nonce: "nonce-A2" });
      expect(retry.id).toBe(first.id);
      expect(rowDigest(layer, SAT, base.idempotencyKey)).toBe(dSame);
      expect(rowCount(layer, SAT, base.idempotencyKey)).toBe(1);

      // Legacy gap now closed: a LATER enqueue with a different identity → typed 409.
      expectConflict(capture(() => service.enqueue({ ...base, messageType: "channel.deliver" })));
      expect(rowDigest(layer, SAT, base.idempotencyKey)).toBe(dSame);
    } finally {
      layer.close();
    }
  });

  it("a fresh enqueue (no existing row) inserts and stamps its digest (happy path unchanged)", () => {
    const layer = createTestDb();
    try {
      insertSatellite(layer, SAT);
      const service = makeService(layer);

      const res = service.enqueue(base);
      expect(res.id).toBeTruthy();
      expect(rowDigest(layer, SAT, base.idempotencyKey)).toBe(digestOf(base));
    } finally {
      layer.close();
    }
  });
});
