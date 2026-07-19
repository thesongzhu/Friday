/**
 * DUR-OPERATION-JOURNAL-001 follow-up #4 — outbox payload-bound idempotency identity (v107).
 *
 * The v100 outbox `payload_digest` is a ROUTING-only digest
 * (`{satelliteId, queueKey, messageType, keyId}`) that EXCLUDES the operation payload, so a
 * reused `idempotency_key` carrying a DIFFERENT logical operation was silently resolved to the
 * existing row (Advisor HIGH: launders a different effect payload). And a legacy pre-v107 row
 * (no logical digest) short-circuited the guard. The fix binds outbox idempotency to a STABLE
 * `logical_payload_digest` computed by the caller before encryption and persisted; legacy
 * (NULL) rows fail closed.
 *
 * RED-FIRST: cases (i) [same key + DIFFERENT logical payload, SAME routing] and (iii) [legacy
 * NULL digest] BOTH pass on the new guard but FAIL if the outbox service guard is reverted to
 * main's routing-digest form — the routing digest is identical in both cases, so it cannot see
 * the divergence and never raises the 409. Cases (ii) and (iv) encode the no-degrade contract
 * (a legit re-dispatch stays idempotent; a fresh enqueue stamps the digest).
 *
 * The projector describe encodes change #7: a legacy NULL-digest projected row now fails closed
 * (the whole-receipt digest is not reconstructable from persisted columns), where main silently
 * swallowed it via INSERT OR IGNORE.
 */

import { describe, expect, it } from "vitest";

import type { FridayDomainError } from "#errors";
import {
  createFridayOutboxMessageRepository,
  createFridayOutboxQueueService,
  type FridayOutboxEnqueueInput,
} from "#satellites";
import { createTestDb, createTestIdGenerator } from "../../unit/satellites/_helpers/create-test-db.helper.js";
import {
  createFridayRustHubRunContinuityProjectorService,
  usageLedgerIdForRun,
  type FridayRustHubRunReceipt,
} from "../../../src/api/mission-spine/friday-rust-hub-run-continuity-projector-service.js";

const NOW = "2026-07-19T10:00:00.000Z";
const SAT = "sat-payload-bound-1";

function isConflict(err: unknown): err is FridayDomainError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "SECURITY_IDEMPOTENCY_KEY_CONFLICT"
  );
}

describe("outbox payload-bound idempotency identity (v107)", () => {
  function insertSatellite(layer: ReturnType<typeof createTestDb>, id: string): void {
    layer.writer
      .prepare(
        `INSERT INTO satellites (id, type, display_name, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json, created_at, updated_at)
         VALUES (?, 'phone', 'Test', 'online', 'restricted', 'pk', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?)`,
      )
      .run(id, NOW, NOW);
  }

  function makeService(layer: ReturnType<typeof createTestDb>) {
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
    idempotencyKey: "idem-1",
    logicalPayloadDigest: "logical-A",
  };

  it("(i) same key + DIFFERENT logical payload (SAME routing) → typed 409, original row unchanged", () => {
    const layer = createTestDb();
    try {
      insertSatellite(layer, SAT);
      const service = makeService(layer);

      const first = service.enqueue(base);
      expect(first.id).toBeTruthy();

      // ALL routing fields (satelliteId/queueKey/messageType/keyId) identical — only the logical
      // payload diverges (and the transport body is re-encoded). The routing digest is therefore
      // identical; only the payload-bound identity catches this.
      let caught: unknown;
      try {
        service.enqueue({
          ...base,
          logicalPayloadDigest: "logical-B",
          payloadCiphertext: "cipher-B",
          nonce: "nonce-B",
        });
      } catch (err) {
        caught = err;
      }
      expect(isConflict(caught)).toBe(true);
      expect((caught as FridayDomainError).httpStatus).toBe(409);

      // Original row is untouched (guard threw before any divergent write).
      const rows = layer.writer
        .prepare(
          "SELECT id, payload_ciphertext, logical_payload_digest FROM outbox_messages WHERE satellite_id = ? AND idempotency_key = ?",
        )
        .all(SAT, base.idempotencyKey) as Array<{
        id: string;
        payload_ciphertext: string;
        logical_payload_digest: string | null;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(first.id);
      expect(rows[0]!.payload_ciphertext).toBe("cipher-A");
      expect(rows[0]!.logical_payload_digest).toBe("logical-A");
    } finally {
      layer.close();
    }
  });

  it("(ii) same logical payload + DIFFERENT nonce/ciphertext → resolves to original id, exactly one row", () => {
    const layer = createTestDb();
    try {
      insertSatellite(layer, SAT);
      const service = makeService(layer);

      const first = service.enqueue(base);
      // A legit re-dispatch of the SAME node execution: fresh timestamp → different ciphertext +
      // nonce, but the SAME logical-payload digest + key. Must stay an idempotent no-op.
      const retry = service.enqueue({
        ...base,
        payloadCiphertext: "cipher-A-reencoded",
        nonce: "nonce-A2",
      });
      expect(retry.id).toBe(first.id);

      const count = layer.writer
        .prepare("SELECT COUNT(*) AS n FROM outbox_messages WHERE satellite_id = ? AND idempotency_key = ?")
        .get(SAT, base.idempotencyKey) as { n: number };
      expect(count.n).toBe(1);

      // The idempotent resolve does NOT overwrite the original body.
      const row = layer.writer
        .prepare("SELECT payload_ciphertext FROM outbox_messages WHERE id = ?")
        .get(first.id) as { payload_ciphertext: string };
      expect(row.payload_ciphertext).toBe("cipher-A");
    } finally {
      layer.close();
    }
  });

  it("(iii) legacy NULL-digest row + any enqueue → typed 409 fail-closed, digest stays NULL", () => {
    const layer = createTestDb();
    try {
      insertSatellite(layer, SAT);
      const service = makeService(layer);

      const first = service.enqueue(base);
      // Simulate a legacy pre-v107 row: its logical-payload identity was never recorded.
      layer.writer
        .prepare(
          "UPDATE outbox_messages SET logical_payload_digest = NULL WHERE satellite_id = ? AND idempotency_key = ?",
        )
        .run(SAT, base.idempotencyKey);

      // Any re-enqueue on this key — even one carrying the identical logical digest — must fail
      // closed: the legacy row's identity cannot be reconstructed, so resolving would launder a
      // possibly-divergent payload.
      let caught: unknown;
      try {
        service.enqueue(base);
      } catch (err) {
        caught = err;
      }
      expect(isConflict(caught)).toBe(true);
      expect((caught as FridayDomainError).httpStatus).toBe(409);

      const row = layer.writer
        .prepare(
          "SELECT logical_payload_digest FROM outbox_messages WHERE satellite_id = ? AND idempotency_key = ?",
        )
        .get(SAT, base.idempotencyKey) as { logical_payload_digest: string | null };
      expect(row.logical_payload_digest).toBeNull();

      const count = layer.writer
        .prepare("SELECT COUNT(*) AS n FROM outbox_messages WHERE satellite_id = ? AND idempotency_key = ?")
        .get(SAT, base.idempotencyKey) as { n: number };
      expect(count.n).toBe(1);
      expect(first.id).toBeTruthy();
    } finally {
      layer.close();
    }
  });

  it("(iv) fresh enqueue (no existing row) inserts and stamps logical_payload_digest (non-null)", () => {
    const layer = createTestDb();
    try {
      insertSatellite(layer, SAT);
      const service = makeService(layer);

      const { id } = service.enqueue(base);

      const row = layer.writer
        .prepare("SELECT status, logical_payload_digest FROM outbox_messages WHERE id = ?")
        .get(id) as { status: string; logical_payload_digest: string | null };
      expect(row.status).toBe("queued");
      expect(row.logical_payload_digest).toBe("logical-A");
    } finally {
      layer.close();
    }
  });
});

const BASE_RECEIPT: FridayRustHubRunReceipt = {
  truthLabel: "rust_wired_dev",
  proofOnly: true,
  ok: true,
  runId: "hub_run_task_dev_107_1720000000000000000",
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

describe("projector fail-closed on legacy NULL payload_digest", () => {
  it("re-project after NULLing friday_agent_runs.payload_digest → typed 409, digest stays NULL", () => {
    const layer = createTestDb();
    try {
      const projector = createFridayRustHubRunContinuityProjectorService();
      const first = projector.project(layer.writer, BASE_RECEIPT);
      expect(first.insertedAgentRun).toBe(true);

      // Simulate a legacy row whose whole-receipt digest was never recorded — it is NOT
      // reconstructable from the persisted columns, so it must fail closed rather than be
      // silently treated as a replay.
      layer.writer
        .prepare("UPDATE friday_agent_runs SET payload_digest = NULL WHERE id = ?")
        .run(BASE_RECEIPT.runId);

      let caught: unknown;
      try {
        projector.project(layer.writer, BASE_RECEIPT);
      } catch (err) {
        caught = err;
      }
      expect(isConflict(caught)).toBe(true);
      expect((caught as FridayDomainError).httpStatus).toBe(409);

      const row = layer.writer
        .prepare("SELECT payload_digest FROM friday_agent_runs WHERE id = ?")
        .get(BASE_RECEIPT.runId) as { payload_digest: string | null };
      expect(row.payload_digest).toBeNull();
    } finally {
      layer.close();
    }
  });

  it("re-project after NULLing llm_usage_records.payload_digest → typed 409 at the usage guard, digest stays NULL", () => {
    const layer = createTestDb();
    try {
      const projector = createFridayRustHubRunContinuityProjectorService();
      const first = projector.project(layer.writer, BASE_RECEIPT);
      expect(first.insertedUsageLedger).toBe(true);

      // Leave the agent_runs digest intact (it matches → first guard passes) and NULL ONLY the
      // usage row so the companion usage guard is the one that must fail closed.
      const usageId = usageLedgerIdForRun(BASE_RECEIPT.runId);
      layer.writer
        .prepare("UPDATE llm_usage_records SET payload_digest = NULL WHERE id = ?")
        .run(usageId);

      let caught: unknown;
      try {
        projector.project(layer.writer, BASE_RECEIPT);
      } catch (err) {
        caught = err;
      }
      expect(isConflict(caught)).toBe(true);
      expect((caught as FridayDomainError).httpStatus).toBe(409);

      const row = layer.writer
        .prepare("SELECT payload_digest FROM llm_usage_records WHERE id = ?")
        .get(usageId) as { payload_digest: string | null };
      expect(row.payload_digest).toBeNull();
    } finally {
      layer.close();
    }
  });
});
