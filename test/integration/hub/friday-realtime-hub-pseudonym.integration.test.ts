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
import { resetMasterKeyCache } from "#providers";

const PII = "alice@example.com";
const NO_KEY_PII = "no-key-owner-canary@example.com";
const OWNER = "admin-001";

const hubs: FridayHub[] = [];
let savedMasterKey: string | undefined;
let savedMasterKeySource: string | undefined;
let savedMasterKeyFile: string | undefined;
let envSaved = false;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "friday-rt-pseudo-"));
}

function saveMasterKeyEnvOnce(): void {
  if (envSaved) return;
  savedMasterKey = process.env.FRIDAY_MASTER_KEY;
  savedMasterKeySource = process.env.FRIDAY_MASTER_KEY_SOURCE;
  savedMasterKeyFile = process.env.FRIDAY_MASTER_KEY_FILE;
  envSaved = true;
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  for (const hub of hubs.splice(0)) {
    try {
      await hub.stop();
    } catch {
      // best-effort teardown
    }
  }
  if (envSaved) {
    restore("FRIDAY_MASTER_KEY", savedMasterKey);
    restore("FRIDAY_MASTER_KEY_SOURCE", savedMasterKeySource);
    restore("FRIDAY_MASTER_KEY_FILE", savedMasterKeyFile);
    envSaved = false;
    resetMasterKeyCache();
  }
});

describe("SEC-EVENT-REDACTION-001 P0-A — real Hub eventBus sink enforces pseudonymization", () => {
  it("the Hub's direct eventBus.publish persists an OPAQUE, owner-stamped, PII-free realtime_events row", async () => {
    saveMasterKeyEnvOnce();
    // Provision the durable encryption root so the pseudonymizer is ACTIVE.
    process.env.FRIDAY_MASTER_KEY = crypto.randomBytes(32).toString("hex");
    resetMasterKeyCache();

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

  // SEC-REALTIME-EVENT-PII-BY-VALUE / round-6 P0-1 — the production sink must FAIL
  // CLOSED (never fall open to raw at rest) when NO durable master key is resolvable.
  it("with NO durable master key, the Hub's eventBus.publish REFUSES to persist (fail-closed) — the canary reaches NEITHER sink", async () => {
    saveMasterKeyEnvOnce();
    // Neutralize EVERY durable key source so no provisioned key can be resolved:
    // no env key, no keychain, and a master-key FILE path that does not exist (this
    // also masks the dev machine's ambient ~/.friday/master.key, mirroring CI).
    delete process.env.FRIDAY_MASTER_KEY;
    delete process.env.FRIDAY_MASTER_KEY_SOURCE;
    process.env.FRIDAY_MASTER_KEY_FILE = path.join(makeTmpDir(), "absent", "master.key");
    resetMasterKeyCache();

    const stateDir = makeTmpDir();
    const hub = await createFridayHub({ stateDir, skillDirs: [makeTmpDir(), makeTmpDir()] });
    hubs.push(hub);
    await hub.start();

    // The exact production bypass vector, now with no key: the sink must THROW rather
    // than degrade to an identity pseudonymizer and persist the raw canary at rest.
    expect(() =>
      hub.apiRuntime.eventBus.publish(
        `run:${NO_KEY_PII}`,
        "workflow.run.started" as never,
        { runId: NO_KEY_PII, workflowId: "wf-1", workflowVersionId: "v-1" } as never,
      ),
    ).toThrow(/pseudonymization is unavailable|fail-closed/i);

    // The canary is absent from BOTH at-rest sinks (stream_id AND payload_json): no row
    // for that stream was persisted at all.
    const state = initializeFridayState({ env: { ...process.env, FRIDAY_STATE_DIR: stateDir } });
    try {
      const rows = state.sqlite.withReadConnection((db) =>
        db
          .prepare("SELECT stream_id, payload_json FROM realtime_events")
          .all() as Array<{ stream_id: string; payload_json: string }>,
      );
      for (const row of rows) {
        expect(row.stream_id).not.toContain(NO_KEY_PII);
        expect(row.payload_json).not.toContain(NO_KEY_PII);
      }
      expect(rows.some((r) => r.stream_id.includes(NO_KEY_PII))).toBe(false);
    } finally {
      state.close();
    }
  }, 60_000);
});
