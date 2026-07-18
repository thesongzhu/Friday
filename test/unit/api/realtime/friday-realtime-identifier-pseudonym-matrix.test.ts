/**
 * SEC-EVENT-REDACTION-001 / FINDING 1 — end-to-end identifier-pseudonym matrix.
 *
 * Replicates the production write transform (`publishWorkflowRealtimeEvent`:
 * pseudonymize streamId + payload id fields, content-redact, publish) and the
 * production read path (subscription-service with the SAME pseudonymizer resolving
 * the client's raw-constructed streamId), then proves the Advisor's requirements:
 *   - two distinct PII-shaped identifiers stay DISTINCT;
 *   - raw values are ABSENT from every sink (stream_id + payload_json);
 *   - benign identifiers remain usable (distinct + stable);
 *   - pseudonym mappings survive restart (deterministic — new instance, same key);
 *   - SYMMETRIC read: a client subscribes/pulls with a RAW streamId and still gets
 *     its events (clients are unaffected; nothing raw is persisted);
 *   - cross-owner access fails.
 */

import { describe, it, expect } from "vitest";

import type { FridaySqliteLayer } from "#state";
import {
  createFridayRealtimeEventBus,
  createFridayRealtimeEventRepository,
  createFridayRealtimeCheckpointRepository,
  createFridayRealtimeSubscriptionService,
} from "#api";
import type { FridayAuthPrincipal, FridayRealtimeSubscription } from "#api";
import { createFridayRealtimePseudonymizer } from "../../../../src/api/realtime/friday-realtime-pseudonym.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

const OWNER = "admin-001";
const KEY = "durable-master-derived-pseudonym-key-abc123"; // pragma: allowlist secret
const NOW = "2026-02-25T12:00:00.000Z";
const EMAIL_A = "alice@example.com";
const EMAIL_B = "bob@example.com";

function principal(userId: string): FridayAuthPrincipal {
  return {
    principalType: "user",
    principalId: userId,
    userId,
    role: "admin",
    scopes: ["workflow.read"],
    tokenId: `tok-${userId}`,
    tokenKind: "access",
    issuedAt: NOW,
  };
}

function makePseudonymizer(key = KEY, owner = OWNER) {
  return createFridayRealtimePseudonymizer({ resolveOwnerId: () => owner, key });
}

interface Harness {
  db: FridaySqliteLayer;
  writeWorkflowEvent: (rawStreamId: string, rawPayload: Record<string, unknown>) => void;
  service: ReturnType<typeof createFridayRealtimeSubscriptionService>;
}

function makeHarness(key = KEY): Harness {
  const db = createTestDb();
  const pseudo = makePseudonymizer(key);
  const eventRepo = createFridayRealtimeEventRepository({ resolveOwnerId: () => OWNER });
  let seq = 0;
  // Sink enforcement: the bus is wired with the pseudonymizer, so publishing the RAW
  // streamId + payload is pseudonymized+redacted AT the sink (no manual transform).
  const bus = createFridayRealtimeEventBus({
    idGenerator: () => `evt-${++seq}`,
    nowIso: () => NOW,
    db,
    eventRepo,
    pseudonymizer: pseudo,
  });
  const writeWorkflowEvent = (rawStreamId: string, rawPayload: Record<string, unknown>) => {
    bus.publish(rawStreamId, "workflow.run.started" as never, rawPayload as never);
  };
  const service = createFridayRealtimeSubscriptionService({
    db,
    eventRepo,
    checkpointRepo: createFridayRealtimeCheckpointRepository(),
    nowIso: () => NOW,
    currentEpoch: 1,
    resolveCanonicalOwnerId: () => OWNER,
    pseudonymizeStreamId: (s) => pseudo.streamId(s),
  });
  return { db, writeWorkflowEvent, service };
}

function rawRows(db: FridaySqliteLayer): Array<{ stream_id: string; payload_json: string }> {
  return db.withReadConnection((r) =>
    r
      .prepare("SELECT stream_id, payload_json FROM realtime_events ORDER BY seq")
      .all() as Array<{ stream_id: string; payload_json: string }>,
  );
}

describe("SEC-EVENT-REDACTION-001 identifier-pseudonym matrix (FINDING 1)", () => {
  it("two distinct PII-shaped identifiers stay DISTINCT with NO raw bytes at any sink", () => {
    const h = makeHarness();
    try {
      h.writeWorkflowEvent(`run:${EMAIL_A}`, { runId: EMAIL_A, workflowId: "wf-1" });
      h.writeWorkflowEvent(`run:${EMAIL_B}`, { runId: EMAIL_B, workflowId: "wf-1" });

      const rows = rawRows(h.db);
      expect(rows).toHaveLength(2);
      // Distinct opaque stream_ids (no collapse to one marker).
      expect(rows[0].stream_id).not.toBe(rows[1].stream_id);
      // Raw PII absent from EVERY persisted sink.
      for (const row of rows) {
        expect(row.stream_id).not.toContain(EMAIL_A);
        expect(row.stream_id).not.toContain(EMAIL_B);
        expect(row.payload_json).not.toContain(EMAIL_A);
        expect(row.payload_json).not.toContain(EMAIL_B);
        expect(row.stream_id.startsWith("run:")).toBe(true); // topic prefix preserved
      }
    } finally {
      h.db.close();
    }
  });

  it("SYMMETRIC read — a client pulls with its RAW-constructed streamId and still gets its event", () => {
    const h = makeHarness();
    try {
      h.writeWorkflowEvent(`run:${EMAIL_A}`, { runId: EMAIL_A });
      h.writeWorkflowEvent(`run:${EMAIL_B}`, { runId: EMAIL_B });

      // The canonical owner pulls with the RAW streamId it constructed client-side.
      const aliceEvents = h.service.pullEvents(`run:${EMAIL_A}`, 0, 50);
      const bobEvents = h.service.pullEvents(`run:${EMAIL_B}`, 0, 50);
      expect(aliceEvents).toHaveLength(1);
      expect(bobEvents).toHaveLength(1);
      // Distinct streams resolve to distinct persisted events (no cross-contamination).
      expect(aliceEvents[0].eventId).not.toBe(bobEvents[0].eventId);
      // The event the client receives carries the OPAQUE stream_id (never raw).
      expect(aliceEvents[0].streamId).not.toContain(EMAIL_A);
    } finally {
      h.db.close();
    }
  });

  it("benign identifiers remain usable (distinct + stable), and mappings survive restart", () => {
    const h = makeHarness();
    try {
      h.writeWorkflowEvent("run:run-123", { runId: "run-123" });
      h.writeWorkflowEvent("run:run-456", { runId: "run-456" });

      const r1 = h.service.pullEvents("run:run-123", 0, 50);
      const r2 = h.service.pullEvents("run:run-456", 0, 50);
      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
      expect(r1[0].eventId).not.toBe(r2[0].eventId); // distinct benign ids → distinct

      // Restart: a NEW pseudonymizer with the SAME secret+owner is deterministic, so a
      // read after "restart" still resolves the same stream (no stored raw mapping).
      // (evt-1 is the run-123 event; seq is per-stream so both events share seq 1.)
      const afterRestart = makePseudonymizer();
      const persistedStreamId = h.db.withReadConnection((r) =>
        (r.prepare("SELECT stream_id FROM realtime_events WHERE event_id = ?").get("evt-1") as { stream_id: string }).stream_id,
      );
      expect(afterRestart.streamId("run:run-123")).toBe(persistedStreamId);
    } finally {
      h.db.close();
    }
  });

  it("cross-owner access fails even with matching scope + a known raw streamId", () => {
    const h = makeHarness();
    try {
      h.writeWorkflowEvent(`run:${EMAIL_A}`, { runId: EMAIL_A });
      const stranger = principal("admin-999");
      expect(h.service.isStreamAuthorized(stranger, `run:${EMAIL_A}`)).toBe(false);
      const validated = h.service.validateSubscriptions(
        [{ subscriptionId: "s1", streamId: `run:${EMAIL_A}`, topic: "workflow.run" } as FridayRealtimeSubscription],
        stranger,
      );
      expect(validated.accepted).toHaveLength(0);
      expect(validated.rejected[0].code).toBe("NOT_CANONICAL_OWNER");
    } finally {
      h.db.close();
    }
  });
});
