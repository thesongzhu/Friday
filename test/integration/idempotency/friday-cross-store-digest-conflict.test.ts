/**
 * DUR-OPERATION-JOURNAL-001 — cross-store digest-conflict guards (integration).
 *
 * Two durable cross-store idempotency surfaces silently swallowed a genuine
 * payload divergence when a key/PK was reused with DIFFERENT content:
 *
 *  1. The Rust→TS run-continuity PROJECTOR used `INSERT OR IGNORE` keyed on
 *     `friday_agent_runs.id` (== run_id) and `llm_usage_records.id` (deterministic
 *     from run_id). Re-projecting the SAME run_id with a DIFFERENT receipt was a
 *     silent no-op — the divergent projection was dropped with no signal.
 *
 *  2. The satellite OUTBOX enqueue used `INSERT OR IGNORE` on the
 *     `(satellite_id, idempotency_key)` unique index and then resolved the
 *     no-op to the EXISTING row id — so the same key reused with a DIFFERENT
 *     logical operation payload silently returned the wrong (original) id.
 *     Its idempotency identity is now the caller-computed `logical_payload_digest`
 *     (v107) — the digest over the STABLE logical payload — NOT the routing-only
 *     `payload_digest`, which excludes the operation payload.
 *
 * The fix adds a durable digest guard on each: a pre-existing row with a DIFFERENT
 * digest raises the SAME typed 409 SECURITY_IDEMPOTENCY_KEY_CONFLICT the HTTP
 * idempotency layer raises. An IDENTICAL re-submit stays idempotent.
 *
 * RED-FIRST: on the unmodified code both "different content, same key" cases are
 * silent no-ops — the `toThrow` assertions FAIL. The idempotent-replay assertions
 * pass on both old and new code (they encode the no-degrade contract).
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
  type FridayRustHubRunReceipt,
} from "../../../src/api/mission-spine/friday-rust-hub-run-continuity-projector-service.js";

const NOW = "2026-07-12T10:00:00.000Z";

const BASE_RECEIPT: FridayRustHubRunReceipt = {
  truthLabel: "rust_wired_dev",
  proofOnly: true,
  ok: true,
  runId: "hub_run_task_dev_99_1720000000000000000",
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

describe("cross-store digest-conflict guard — Rust run-continuity projector", () => {
  it("raises a typed 409 conflict when the same run_id is re-projected with a DIFFERENT receipt", () => {
    const layer = createTestDb();
    try {
      const projector = createFridayRustHubRunContinuityProjectorService();

      const first = projector.project(layer.writer, BASE_RECEIPT);
      expect(first.insertedAgentRun).toBe(true);
      expect(first.insertedUsageLedger).toBe(true);

      // Same run_id, DIFFERENT content (token totals diverge) → must conflict.
      const divergent: FridayRustHubRunReceipt = {
        ...BASE_RECEIPT,
        usagePromptTokens: 9999,
        usageTotalTokens: 10_419,
      };

      let caught: unknown;
      try {
        projector.project(layer.writer, divergent);
      } catch (err) {
        caught = err;
      }
      expect(isConflict(caught)).toBe(true);
      expect((caught as FridayDomainError).httpStatus).toBe(409);

      // The original projection is untouched (guard threw before any divergent write).
      const row = layer.writer
        .prepare("SELECT usage_input FROM friday_agent_runs WHERE id = ?")
        .get(BASE_RECEIPT.runId) as { usage_input: number };
      expect(row.usage_input).toBe(1500);
    } finally {
      layer.close();
    }
  });

  it("stays idempotent (no throw, no dup) when the SAME receipt is re-projected", () => {
    const layer = createTestDb();
    try {
      const projector = createFridayRustHubRunContinuityProjectorService();
      const first = projector.project(layer.writer, BASE_RECEIPT);
      expect(first.insertedAgentRun).toBe(true);

      const second = projector.project(layer.writer, BASE_RECEIPT);
      expect(second.insertedAgentRun).toBe(false);
      expect(second.insertedUsageLedger).toBe(false);

      const count = layer.writer
        .prepare("SELECT COUNT(*) AS n FROM friday_agent_runs WHERE id = ?")
        .get(BASE_RECEIPT.runId) as { n: number };
      expect(count.n).toBe(1);
    } finally {
      layer.close();
    }
  });
});

describe("cross-store digest-conflict guard — satellite outbox enqueue", () => {
  const SAT = "sat-outbox-1";

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
    idempotencyKey: "idem-conflict-1",
    logicalPayloadDigest: "logical-A",
  };

  it("raises a typed 409 conflict when the same key is reused with a DIFFERENT logical payload", () => {
    const layer = createTestDb();
    try {
      insertSatellite(layer, SAT);
      const service = makeService(layer);

      const first = service.enqueue(base);
      expect(first.id).toBeTruthy();

      // Same key + same routing (messageType unchanged), but a DIFFERENT logical-payload digest
      // → must conflict. The routing digest alone cannot see this divergence; the payload-bound
      // identity does.
      let caught: unknown;
      try {
        service.enqueue({ ...base, logicalPayloadDigest: "logical-B" });
      } catch (err) {
        caught = err;
      }
      expect(isConflict(caught)).toBe(true);
      expect((caught as FridayDomainError).httpStatus).toBe(409);

      const count = layer.writer
        .prepare("SELECT COUNT(*) AS n FROM outbox_messages WHERE satellite_id = ? AND idempotency_key = ?")
        .get(SAT, base.idempotencyKey) as { n: number };
      expect(count.n).toBe(1);
    } finally {
      layer.close();
    }
  });

  it("stays idempotent (no throw) when the same key retries the SAME logical payload with a re-encoded body", () => {
    const layer = createTestDb();
    try {
      insertSatellite(layer, SAT);
      const service = makeService(layer);

      const first = service.enqueue(base);
      // A legitimate re-dispatch re-encodes the transport body (fresh timestamp →
      // different ciphertext/nonce) but keeps the SAME logical-payload digest + key. This MUST
      // remain an idempotent no-op resolving to the original id (no-degrade).
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
    } finally {
      layer.close();
    }
  });
});
