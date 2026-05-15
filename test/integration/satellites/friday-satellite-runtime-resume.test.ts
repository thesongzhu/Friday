import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridaySatelliteRuntime } from "#satellites";
import type { FridaySatelliteResumeSignal } from "#satellites";
import { createTestDb, createTestIdGenerator } from "../../unit/satellites/_helpers/create-test-db.helper.js";

function insertSatellite(
  db: FridaySqliteLayer,
  id: string,
  status: string,
  createdAt: string,
  lastSeenAt: string | null = null,
) {
  db.writer
    .prepare(
      `INSERT INTO satellites (
         id, type, display_name, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version,
         tags_json, last_seen_at, created_at, updated_at
       ) VALUES (?, 'phone', 'Test', ?, 'standard', 'pk-1', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?, ?)`,
    )
    .run(id, status, lastSeenAt, createdAt, createdAt);
}

function insertOutboxMessage(
  db: FridaySqliteLayer,
  id: string,
  satelliteId: string,
  status: "queued" | "leased" | "acked" | "expired",
  createdAt = "2026-05-15T09:59:00.000Z",
) {
  const existing = db.writer
    .prepare("SELECT id FROM satellites WHERE id = ?")
    .get(satelliteId) as { id: string } | undefined;
  if (!existing) {
    throw new Error(`Test setup: insert satellite ${satelliteId} before outbox message`);
  }
  db.writer
    .prepare(
      `INSERT INTO outbox_messages (
         id, satellite_id, queue_key, message_type, payload_ciphertext,
         nonce, key_id, idempotency_key, status, max_attempts,
         deliver_after, expires_at, created_at, updated_at
       ) VALUES (?, ?, 'workflow:run-x', 'workflow.node.execute', 'cipher', 'nonce', 'inline:v1', ?, ?, 10, NULL, NULL, ?, ?)`,
    )
    .run(id, satelliteId, `idem-${id}`, status, createdAt, createdAt);
}

describe("FridaySatelliteRuntime offline -> resume integration", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("emits a resume-eligible signal when an offline satellite heartbeats back to online with pending outbox", () => {
    insertSatellite(db, "sat-A", "offline", "2026-05-15T09:00:00.000Z", null);
    insertOutboxMessage(db, "msg-1", "sat-A", "queued");
    insertOutboxMessage(db, "msg-2", "sat-A", "queued");

    let nowIso = "2026-05-15T10:00:00.000Z";
    const onStatusTransition = vi.fn();
    const resumeSignals: FridaySatelliteResumeSignal[] = [];
    const onSatelliteResumeEligible = (signal: FridaySatelliteResumeSignal) => {
      resumeSignals.push(signal);
    };

    const runtime = createFridaySatelliteRuntime({
      db,
      cursorSecret: "cursor-secret-x",
      tokenSecret: "token-secret-x",
      idGenerator: createTestIdGenerator(),
      nowIso: () => nowIso,
      onStatusTransition,
      onSatelliteResumeEligible,
    });

    expect(runtime.resumeCoordinator).toBeDefined();

    runtime.heartbeat.recordHeartbeat({
      satelliteId: "sat-A",
      ts: nowIso,
    });

    expect(onStatusTransition).toHaveBeenCalled();
    expect(resumeSignals).toHaveLength(1);
    expect(resumeSignals[0]).toMatchObject({
      satelliteId: "sat-A",
      toStatus: "online",
      pendingOutboxCount: 2,
    });
  });

  it("does not emit a resume-eligible signal for online -> degraded transition", () => {
    insertSatellite(db, "sat-B", "online", "2026-05-15T09:00:00.000Z", "2026-05-15T09:58:00.000Z");
    insertOutboxMessage(db, "msg-1", "sat-B", "queued");

    const nowIso = "2026-05-15T10:00:00.000Z";
    const resumeSignals: FridaySatelliteResumeSignal[] = [];

    const runtime = createFridaySatelliteRuntime({
      db,
      cursorSecret: "cursor-secret-y",
      tokenSecret: "token-secret-y",
      idGenerator: createTestIdGenerator(),
      nowIso: () => nowIso,
      onSatelliteResumeEligible: (signal) => resumeSignals.push(signal),
    });

    runtime.offlineSweeper.sweep(nowIso);

    expect(resumeSignals).toHaveLength(0);
  });
});
