import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridaySatelliteResumeCoordinator } from "#satellites";
import { createTestDb } from "../_helpers/create-test-db.helper.js";

const SATELLITES_SEEN = new Set<string>();

function ensureSatellite(db: FridaySqliteLayer, id: string) {
  if (SATELLITES_SEEN.has(id)) return;
  db.writer
    .prepare(
      `INSERT OR IGNORE INTO satellites (
         id, type, display_name, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version,
         tags_json, last_seen_at, created_at, updated_at
       ) VALUES (?, 'phone', ?, 'paired', 'standard', 'pk', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', '[]', NULL, ?, ?)`,
    )
    .run(id, `Satellite ${id}`, "2026-05-15T09:00:00.000Z", "2026-05-15T09:00:00.000Z");
  SATELLITES_SEEN.add(id);
}

function insertOutboxMessage(
  db: FridaySqliteLayer,
  id: string,
  satelliteId: string,
  status: "queued" | "leased" | "acked" | "expired",
  options: { deliverAfter?: string; expiresAt?: string; createdAt?: string } = {},
) {
  ensureSatellite(db, satelliteId);
  db.writer
    .prepare(
      `INSERT INTO outbox_messages (
         id, satellite_id, queue_key, message_type, payload_ciphertext,
         nonce, key_id, idempotency_key, status, max_attempts,
         deliver_after, expires_at, created_at, updated_at
       ) VALUES (?, ?, 'workflow:run-x', 'workflow.node.execute', 'cipher', 'nonce', 'inline:v1', ?, ?, 10, ?, ?, ?, ?)`,
    )
    .run(
      id,
      satelliteId,
      `idem-${id}`,
      status,
      options.deliverAfter ?? null,
      options.expiresAt ?? null,
      options.createdAt ?? "2026-05-15T09:59:00.000Z",
      options.createdAt ?? "2026-05-15T09:59:00.000Z",
    );
}

describe("FridaySatelliteResumeCoordinator", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
    SATELLITES_SEEN.clear();
  });

  afterEach(() => {
    db.close();
  });

  it("emits a resume-eligible signal with pending outbox count on offline->online transition", () => {
    insertOutboxMessage(db, "msg-1", "sat-a", "queued");
    insertOutboxMessage(db, "msg-2", "sat-a", "queued");
    insertOutboxMessage(db, "msg-3", "sat-other", "queued");
    insertOutboxMessage(db, "msg-4", "sat-a", "acked");

    const onResumeEligible = vi.fn();
    const coordinator = createFridaySatelliteResumeCoordinator({ db, onResumeEligible });

    const signal = coordinator.handleStatusTransition({
      satelliteId: "sat-a",
      fromStatus: "offline",
      toStatus: "online",
      at: "2026-05-15T10:00:00.000Z",
    });

    expect(signal).toEqual({
      satelliteId: "sat-a",
      fromStatus: "offline",
      toStatus: "online",
      at: "2026-05-15T10:00:00.000Z",
      pendingOutboxCount: 2,
    });
    expect(onResumeEligible).toHaveBeenCalledWith(signal);
  });

  it("emits a resume-eligible signal on degraded->online transition", () => {
    insertOutboxMessage(db, "msg-1", "sat-b", "queued");

    const onResumeEligible = vi.fn();
    const coordinator = createFridaySatelliteResumeCoordinator({ db, onResumeEligible });

    const signal = coordinator.handleStatusTransition({
      satelliteId: "sat-b",
      fromStatus: "degraded",
      toStatus: "online",
      at: "2026-05-15T10:00:00.000Z",
    });

    expect(signal).not.toBeNull();
    expect(signal?.pendingOutboxCount).toBe(1);
    expect(onResumeEligible).toHaveBeenCalledTimes(1);
  });

  it("does not emit a signal when transitioning online->degraded (not a resume event)", () => {
    insertOutboxMessage(db, "msg-1", "sat-c", "queued");
    const onResumeEligible = vi.fn();
    const coordinator = createFridaySatelliteResumeCoordinator({ db, onResumeEligible });

    const signal = coordinator.handleStatusTransition({
      satelliteId: "sat-c",
      fromStatus: "online",
      toStatus: "degraded",
      at: "2026-05-15T10:00:00.000Z",
    });

    expect(signal).toBeNull();
    expect(onResumeEligible).not.toHaveBeenCalled();
  });

  it("does not emit a signal when transitioning revoked->online (terminal state preserved)", () => {
    const onResumeEligible = vi.fn();
    const coordinator = createFridaySatelliteResumeCoordinator({ db, onResumeEligible });

    const signal = coordinator.handleStatusTransition({
      satelliteId: "sat-d",
      fromStatus: "revoked" as never,
      toStatus: "online",
      at: "2026-05-15T10:00:00.000Z",
    });

    // revoked is not in OFFLINE_LIKE, so coordinator must not treat as resume.
    expect(signal).toBeNull();
    expect(onResumeEligible).not.toHaveBeenCalled();
  });

  it("excludes expired and not-yet-deliverable outbox messages from pending count", () => {
    insertOutboxMessage(db, "msg-future", "sat-e", "queued", {
      deliverAfter: "2026-05-15T11:00:00.000Z",
    });
    insertOutboxMessage(db, "msg-expired", "sat-e", "queued", {
      expiresAt: "2026-05-15T09:00:00.000Z",
    });
    insertOutboxMessage(db, "msg-ready", "sat-e", "queued");

    const coordinator = createFridaySatelliteResumeCoordinator({ db });
    const signal = coordinator.handleStatusTransition({
      satelliteId: "sat-e",
      fromStatus: "offline",
      toStatus: "online",
      at: "2026-05-15T10:00:00.000Z",
    });

    expect(signal?.pendingOutboxCount).toBe(1);
  });

  it("exposes a direct pending-count query without altering placement", () => {
    insertOutboxMessage(db, "msg-1", "sat-f", "queued");
    insertOutboxMessage(db, "msg-2", "sat-f", "queued");
    const coordinator = createFridaySatelliteResumeCoordinator({ db });
    expect(coordinator.getPendingOutboxCount("sat-f", "2026-05-15T10:00:00.000Z")).toBe(2);
    expect(coordinator.getPendingOutboxCount("sat-empty", "2026-05-15T10:00:00.000Z")).toBe(0);
  });
});
