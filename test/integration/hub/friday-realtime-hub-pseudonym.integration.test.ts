/**
 * SEC-EVENT-REDACTION-001 / P0-A -- REAL Hub end-to-end proof that the identifier
 * pseudonymization is enforced at the unavoidable event-bus SINK, so the Hub's
 * DIRECT `apiRuntime.eventBus.publish` (the exact production bypass the Advisor
 * found: friday-hub-bootstrap wires its realtime publisher straight to
 * eventBus.publish) persists NO raw identifier bytes.
 *
 * Drives the REAL `createFridayHub` (real SQLite + migrations + api-runtime) with a
 * provisioned master key, publishes an event carrying a PII-shaped identifier through
 * the Hub's own eventBus, then reads the on-disk `realtime_events` raw -- proving the
 * stream_id + payload are opaque, owner-stamped, and free of the raw PII, WITHOUT
 * manually reproducing the transform.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createFridayHub } from "#hub";
import type { FridayHub } from "#hub";
import { initializeFridayState } from "#state";

const PII = "alice@example.com";
const OWNER = "admin-001";

const hubs: FridayHub[] = [];
let savedMasterKey: string | undefined;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "friday-rt-pseudo-"));
}

afterEach(async () => {
  for (const hub of hubs.splice(0)) {
    try {
      await hub.stop();
    } catch {
      // best-effort teardown
    }
  }
  if (savedMasterKey === undefined) delete process.env.FRIDAY_MASTER_KEY;
  else process.env.FRIDAY_MASTER_KEY = savedMasterKey;
});

describe("SEC-EVENT-REDACTION-001 P0-A — real Hub eventBus sink enforces pseudonymization", () => {
  it("the Hub's direct eventBus.publish persists an OPAQUE, owner-stamped, PII-free realtime_events row", async () => {
    savedMasterKey = process.env.FRIDAY_MASTER_KEY;
    // Provision the durable encryption root so the pseudonymizer is ACTIVE.
    process.env.FRIDAY_MASTER_KEY = crypto.randomBytes(32).toString("hex");

    const stateDir = makeTmpDir();
    const hub = await createFridayHub({ stateDir, skillDirs: [makeTmpDir(), makeTmpDir()] });
    hubs.push(hub);
    await hub.start();

    // The EXACT bypass vector: publish directly through the Hub's own eventBus with a
    // PII-shaped identifier, as friday-hub-bootstrap's realtime publisher does.
    hub.apiRuntime.eventBus.publish(
      `run:${PII}`,
      "workflow.run.started" as never,
      { runId: PII, workflowId: "wf-1", workflowVersionId: "v-1" } as never,
    );

    // Read the on-disk realtime_events RAW (separate connection to the hub's DB).
    const state = initializeFridayState({ env: { ...process.env, FRIDAY_STATE_DIR: stateDir } });
    try {
      const rows = state.sqlite.withReadConnection((db) =>
        db
          .prepare("SELECT stream_id, payload_json, owner_id FROM realtime_events")
          .all() as Array<{ stream_id: string; payload_json: string; owner_id: string | null }>,
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const row = rows.find((r) => r.stream_id.startsWith("run:"))!;
      expect(row).toBeDefined();

      // No raw PII bytes at rest, in EITHER the stream_id or the payload.
      expect(row.stream_id).not.toContain(PII);
      expect(row.payload_json).not.toContain(PII);
      // The stream id is in the opaque namespace (topic prefix preserved).
      expect(row.stream_id).toMatch(/^run:o\d+_[0-9a-f]{8,}$/);
      // Owner-stamped to the canonical hub owner (P0#2).
      expect(row.owner_id).toBe(OWNER);
    } finally {
      state.close();
    }
  }, 60_000);
});
