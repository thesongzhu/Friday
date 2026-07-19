/**
 * DUR-OPERATION-JOURNAL-001 — follow-up defect #4: legacy-NULL digest backfill (integration).
 *
 * The cross-store digest-conflict guards added by the merged PR (#1623) short-circuit when the
 * EXISTING row's `payload_digest` is NULL — the state of every row written BEFORE the v100
 * migration added the (nullable) `payload_digest` column. Because the guard only fires on a
 * NON-NULL divergent digest, a divergent re-projection / re-enqueue that targets a legacy row is
 * neither recorded nor flagged: it is silently swallowed by `INSERT OR IGNORE` (projector / outbox
 * insert is a no-op — the row already exists) or silently resolved to the existing id (outbox).
 *
 * The fix does NOT blindly stamp the incoming digest onto a legacy row — that would LAUNDER a
 * divergent write (same key reused for a DIFFERENT identity) into "the canonical digest". Instead,
 * on a legacy (NULL-digest) row it PROVES the incoming write reproduces the bytes ALREADY
 * PERSISTED before stamping:
 *   - outbox: recompute the canonical routing-identity digest from the row's OWN persisted columns
 *     (`satellite_id, queue_key, message_type, key_id`) and compare;
 *   - projector: recompute a content-identity over the row's persisted content columns and compare.
 * Then:
 *   - MATCH  ⇒ same identity → BACKFILL the canonical digest (first-write-only via
 *     `payload_digest IS NULL`) so a LATER divergent write hits the now-non-null typed-409 branch;
 *   - MISMATCH ⇒ genuine divergence → the SAME typed 409 (SECURITY_IDEMPOTENCY_KEY_CONFLICT) the
 *     non-null path raises, BEFORE any stamp (data-loss-free: the row is preserved, nothing
 *     laundered).
 *
 * RED-FIRST: on the pre-fix (blind-stamp) code, a DIVERGENT write against a legacy row on FIRST
 * contact is silently accepted (stamped / resolved, no throw) — the `toThrow`/409 negative-control
 * assertions FAIL. After the prove-then-stamp fix they pass, and the same-identity backfill +
 * happy paths (non-null matching = no-op, non-null different = conflict, fresh insert stamps its
 * digest, idempotent replay resolves to the existing id) remain UNCHANGED (covered here and in
 * `friday-cross-store-digest-conflict.test.ts`).
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

describe("legacy-NULL digest backfill — Rust run-continuity projector (friday_agent_runs, site 1)", () => {
  it("REJECTS a DIVERGENT projection against a legacy row on first contact — never launders its digest", () => {
    const layer = createTestDb();
    try {
      const runId = BASE_RECEIPT.runId;
      const usageId = usageLedgerIdForRun(runId);

      // Seed a pre-v100 legacy row (digest column NULL) from BASE_RECEIPT's content.
      project(layer, BASE_RECEIPT);
      makeLegacy(layer, runId);
      expect(agentRunDigest(layer, runId)).toBe(null); // precondition: legacy NULL
      expect(usageDigest(layer, usageId)).toBe(null);

      // A DIVERGENT receipt (different usage content) is the same run_id reused for a DIFFERENT
      // projection. On the FIRST digest-bearing contact the guard has no stored digest to compare,
      // so it must PROVE identity against the persisted content — which differs — and raise the
      // typed 409 rather than stamping the divergent digest. (RED on the blind-stamp code: it
      // stamps + no-ops with no throw.)
      const divergent: FridayRustHubRunReceipt = {
        ...BASE_RECEIPT,
        usagePromptTokens: 9999,
        usageTotalTokens: 10_419,
      };
      const caught = capture(() => project(layer, divergent));
      expect(isConflict(caught)).toBe(true);
      expect((caught as FridayDomainError).httpStatus).toBe(409);

      // The rejected write laundered nothing: the legacy digest is still NULL (throw rolled back
      // before any UPDATE), so the divergent receipt's digest was NOT adopted as canonical.
      expect(agentRunDigest(layer, runId)).toBe(null);
    } finally {
      layer.close();
    }
  });

  it("backfills a legacy row on a SAME-identity re-projection, then conflicts when a later projection diverges", () => {
    const layer = createTestDb();
    try {
      const runId = BASE_RECEIPT.runId;
      const usageId = usageLedgerIdForRun(runId);
      const dSame = hashIdempotencyPayload(BASE_RECEIPT);

      project(layer, BASE_RECEIPT);
      makeLegacy(layer, runId);
      expect(agentRunDigest(layer, runId)).toBe(null);

      // Same run re-projected onto the legacy row: content matches → BACKFILL the canonical digest
      // (both the agent_run row AND its companion usage row), never throwing (no over-fail).
      expect(() => project(layer, BASE_RECEIPT)).not.toThrow();
      expect(agentRunDigest(layer, runId)).toBe(dSame);
      expect(usageDigest(layer, usageId)).toBe(dSame);

      // Still exactly one row (backfill never inserts).
      const count = layer.writer
        .prepare("SELECT COUNT(*) AS n FROM friday_agent_runs WHERE id = ?")
        .get(runId) as { n: number };
      expect(count.n).toBe(1);

      // The legacy gap is now closed: a LATER divergent projection hits the non-null typed 409.
      const divergent: FridayRustHubRunReceipt = {
        ...BASE_RECEIPT,
        usagePromptTokens: 5555,
        usageTotalTokens: 6000,
      };
      const caught = capture(() => project(layer, divergent));
      expect(isConflict(caught)).toBe(true);
      expect((caught as FridayDomainError).httpStatus).toBe(409);
      // The backfilled digest is unchanged by the rejected divergent write (guard threw first).
      expect(agentRunDigest(layer, runId)).toBe(dSame);
    } finally {
      layer.close();
    }
  });
});

describe("legacy-NULL digest backfill — Rust run-continuity projector (llm_usage_records, site 2)", () => {
  // The usage-records guard is defense-in-depth BEHIND the agent_run guard: both derive from the
  // SAME per-receipt digest and the agent_run guard is checked first, so a plain divergent
  // re-projection conflicts at site 1 before site 2 is reached. Its guard genuinely matters when
  // the agent_run row was REAPED (the terminal-run retention reaper deletes completed/failed
  // agent_runs) while the longer-retained usage/cost ledger row survives — a re-projection then
  // re-inserts the agent_run fresh (no conflict) and the usage guard is the sole divergence check.
  // We drive the REAL projector against exactly that partial-legacy shape.
  it("REJECTS a divergent usage projection (agent_run reaped) on first contact — never launders its digest", () => {
    const layer = createTestDb();
    try {
      const runId = BASE_RECEIPT.runId;
      const usageId = usageLedgerIdForRun(runId);

      // Seed both rows, mark the usage row legacy (NULL), and simulate the agent_run reaper having
      // deleted the terminal agent_run row — leaving only the surviving legacy usage ledger row.
      project(layer, BASE_RECEIPT);
      layer.writer.prepare("UPDATE llm_usage_records SET payload_digest = NULL WHERE id = ?").run(usageId);
      layer.writer.prepare("DELETE FROM friday_agent_runs WHERE id = ?").run(runId);
      expect(usageDigest(layer, usageId)).toBe(null); // precondition: legacy NULL usage row

      // Divergent re-projection: agent_run absent → re-inserted fresh (no throw at site 1); the
      // legacy usage row's content differs from the divergent projection → site 2 must raise the
      // typed 409 rather than stamp. (RED on the blind-stamp code.)
      const divergent: FridayRustHubRunReceipt = {
        ...BASE_RECEIPT,
        usagePromptTokens: 1,
        usageTotalTokens: 2,
      };
      const caught = capture(() => project(layer, divergent));
      expect(isConflict(caught)).toBe(true);
      expect((caught as FridayDomainError).httpStatus).toBe(409);
      // Nothing laundered: the usage row's digest is still NULL (throw rolled back the projection).
      expect(usageDigest(layer, usageId)).toBe(null);
    } finally {
      layer.close();
    }
  });

  it("backfills a legacy usage row (agent_run reaped) on a SAME-identity re-projection, then conflicts on divergence", () => {
    const layer = createTestDb();
    try {
      const runId = BASE_RECEIPT.runId;
      const usageId = usageLedgerIdForRun(runId);
      const dBase = hashIdempotencyPayload(BASE_RECEIPT);

      project(layer, BASE_RECEIPT);
      layer.writer.prepare("UPDATE llm_usage_records SET payload_digest = NULL WHERE id = ?").run(usageId);
      layer.writer.prepare("DELETE FROM friday_agent_runs WHERE id = ?").run(runId);
      expect(usageDigest(layer, usageId)).toBe(null);

      // First re-projection (same receipt): agent_run absent → re-inserted fresh (no throw at
      // site 1); legacy usage row content matches → BACKFILLED to the canonical digest at site 2.
      expect(() => project(layer, BASE_RECEIPT)).not.toThrow();
      expect(usageDigest(layer, usageId)).toBe(dBase);

      // Reap the agent_run again so the NEXT divergent write passes site 1 and reaches site 2.
      layer.writer.prepare("DELETE FROM friday_agent_runs WHERE id = ?").run(runId);

      // Divergent re-projection: agent_run re-inserts fresh (no conflict) but the usage row's
      // now-non-null digest diverges → the usage guard raises the typed 409.
      const divergent: FridayRustHubRunReceipt = {
        ...BASE_RECEIPT,
        usagePromptTokens: 1,
        usageTotalTokens: 2,
      };
      const caught = capture(() => project(layer, divergent));
      expect(isConflict(caught)).toBe(true);
      expect((caught as FridayDomainError).httpStatus).toBe(409);
      // The usage row's backfilled digest survives the rejected write (guard threw before its insert).
      expect(usageDigest(layer, usageId)).toBe(dBase);
    } finally {
      layer.close();
    }
  });
});

describe("legacy-NULL digest backfill — satellite outbox enqueue (site 3)", () => {
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

      // Seed a pre-v100 legacy row (digest column NULL).
      const first = service.enqueue(base);
      expect(first.id).toBeTruthy();
      makeLegacyRow(layer, SAT, base.idempotencyKey);
      expect(rowDigest(layer, SAT, base.idempotencyKey)).toBe(null); // precondition: legacy NULL

      // A DIVERGENT enqueue (same key, DIFFERENT message identity) on FIRST contact must PROVE
      // identity against the persisted routing columns — which differ — and raise the typed 409
      // rather than stamp the divergent digest and resolve to the existing id. (RED on the
      // blind-stamp code: it stamps + resolves with no throw.)
      const divergent: FridayOutboxEnqueueInput = { ...base, messageType: "skill.execute" };
      const caught = capture(() => service.enqueue(divergent));
      expect(isConflict(caught)).toBe(true);
      expect((caught as FridayDomainError).httpStatus).toBe(409);

      // Nothing laundered: still one row, digest still NULL (the divergent digest was NOT adopted).
      expect(rowCount(layer, SAT, base.idempotencyKey)).toBe(1);
      expect(rowDigest(layer, SAT, base.idempotencyKey)).toBe(null);
    } finally {
      layer.close();
    }
  });

  it("backfills a legacy row on a SAME-identity re-enqueue, then conflicts when a later enqueue diverges", () => {
    const layer = createTestDb();
    try {
      insertSatellite(layer, SAT);
      const service = makeService(layer);
      const dSame = digestOf(base);

      const first = service.enqueue(base);
      makeLegacyRow(layer, SAT, base.idempotencyKey);
      expect(rowDigest(layer, SAT, base.idempotencyKey)).toBe(null);

      // Same routing identity + key, re-encoded transport body (fresh nonce/ciphertext): identity
      // matches → resolves to the original id (no-degrade) and BACKFILLS the canonical digest.
      const retry = service.enqueue({ ...base, payloadCiphertext: "cipher-A-reencoded", nonce: "nonce-A2" });
      expect(retry.id).toBe(first.id);
      expect(rowDigest(layer, SAT, base.idempotencyKey)).toBe(dSame); // backfilled, not NULL
      expect(rowCount(layer, SAT, base.idempotencyKey)).toBe(1);

      // The legacy gap is now closed: a LATER enqueue with a different identity → typed 409.
      const caught = capture(() => service.enqueue({ ...base, messageType: "channel.deliver" }));
      expect(isConflict(caught)).toBe(true);
      expect((caught as FridayDomainError).httpStatus).toBe(409);
      // Digest unchanged by the rejected write.
      expect(rowDigest(layer, SAT, base.idempotencyKey)).toBe(dSame);
    } finally {
      layer.close();
    }
  });

  it("stays an idempotent no-op when the legacy row is re-enqueued with the SAME identity (no over-fail)", () => {
    const layer = createTestDb();
    try {
      insertSatellite(layer, SAT);
      const service = makeService(layer);
      const dSame = digestOf(base);

      const first = service.enqueue(base);
      makeLegacyRow(layer, SAT, base.idempotencyKey);

      const retry = service.enqueue({ ...base, payloadCiphertext: "cipher-A-reencoded", nonce: "nonce-A2" });
      expect(retry.id).toBe(first.id);
      expect(rowDigest(layer, SAT, base.idempotencyKey)).toBe(dSame);
      expect(rowCount(layer, SAT, base.idempotencyKey)).toBe(1);
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
      // Fresh insert records the digest (non-null) — the exactly-once/insert path is unchanged.
      expect(rowDigest(layer, SAT, base.idempotencyKey)).toBe(digestOf(base));
    } finally {
      layer.close();
    }
  });
});
