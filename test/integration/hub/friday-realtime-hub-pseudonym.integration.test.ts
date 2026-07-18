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
const CORR_PII = "correlation-owner@example.com";
const ZWSP = "​"; // zero-width space (Cf) — the round-7 F2 obfuscation vector
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

  // SEC-REALTIME-EVENT-PII-BY-VALUE / round-7 F1 — the envelope `correlationId` used to
  // be copied VERBATIM into realtime_events.correlation_id AND the delivered envelope.
  it("the Hub's eventBus.publish pseudonymizes correlationId — NEITHER the raw column NOR the delivered envelope carries the PII, and it stays DETERMINISTIC", async () => {
    saveMasterKeyEnvOnce();
    process.env.FRIDAY_MASTER_KEY = crypto.randomBytes(32).toString("hex");
    resetMasterKeyCache();

    const stateDir = makeTmpDir();
    const hub = await createFridayHub({ stateDir, skillDirs: [makeTmpDir(), makeTmpDir()] });
    hubs.push(hub);
    await hub.start();

    const delivered: Array<{ correlationId?: string }> = [];
    const unsubscribe = hub.apiRuntime.eventBus.subscribe((env) => delivered.push(env));

    hub.apiRuntime.eventBus.publish(
      "run:corr-1",
      "workflow.run.started" as never,
      { runId: "corr-1", workflowId: "wf-1", workflowVersionId: "v-1" } as never,
      CORR_PII,
    );
    hub.apiRuntime.eventBus.publish(
      "run:corr-2",
      "workflow.run.started" as never,
      { runId: "corr-2", workflowId: "wf-1", workflowVersionId: "v-1" } as never,
      CORR_PII,
    );
    unsubscribe();

    // Delivered (WS/listener) envelopes carry ONLY the opaque, deterministic correlationId.
    expect(delivered.length).toBeGreaterThanOrEqual(2);
    for (const env of delivered) {
      expect(env.correlationId).toBeDefined();
      expect(env.correlationId).not.toContain(CORR_PII);
      expect(env.correlationId).toMatch(/^o\d+_[0-9a-f]{8,}$/);
    }
    expect(delivered[0].correlationId).toBe(delivered[1].correlationId); // deterministic

    const state = initializeFridayState({ env: { ...process.env, FRIDAY_STATE_DIR: stateDir } });
    try {
      const rows = state.sqlite.withReadConnection((db) =>
        db
          .prepare("SELECT correlation_id FROM realtime_events WHERE stream_id LIKE 'run:%'")
          .all() as Array<{ correlation_id: string | null }>,
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        expect(row.correlation_id).not.toBeNull();
        expect(row.correlation_id!).not.toContain(CORR_PII);
        expect(row.correlation_id!).toMatch(/^o\d+_[0-9a-f]{8,}$/);
      }
      // Same raw correlationId → identical opaque at rest (correlation survives).
      const distinct = new Set(rows.map((r) => r.correlation_id));
      expect(distinct.size).toBe(1);
    } finally {
      state.close();
    }
  }, 60_000);

  // SEC-REALTIME-EVENT-PII-BY-VALUE / round-7 F2 — a Unicode-obfuscated secret
  // (`sk-<U+200B>…`) in a CONTENT field used to survive RAW in payload_json + on the wire.
  it("the Hub's eventBus.publish redacts a zero-width-split sk- secret at rest AND on the delivered envelope", async () => {
    saveMasterKeyEnvOnce();
    process.env.FRIDAY_MASTER_KEY = crypto.randomBytes(32).toString("hex");
    resetMasterKeyCache();

    const stateDir = makeTmpDir();
    const hub = await createFridayHub({ stateDir, skillDirs: [makeTmpDir(), makeTmpDir()] });
    hubs.push(hub);
    await hub.start();

    const secretBody = "a5canaryhubunicodesecret00000000"; // pragma: allowlist secret
    const obfuscated = `sk-${ZWSP}${secretBody}`; // pragma: allowlist secret

    const delivered: Array<{ payload: unknown }> = [];
    const unsubscribe = hub.apiRuntime.eventBus.subscribe((env) => delivered.push(env));
    hub.apiRuntime.eventBus.publish(
      "run:unicode-secret",
      "workflow.run.failed" as never,
      { runId: "unicode-secret", error: { message: `stderr leaked ${obfuscated}` } } as never,
    );
    unsubscribe();

    // On the wire: the delivered envelope carries no raw secret body.
    expect(delivered.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(delivered[delivered.length - 1].payload)).not.toContain(secretBody);

    const state = initializeFridayState({ env: { ...process.env, FRIDAY_STATE_DIR: stateDir } });
    try {
      const row = state.sqlite.withReadConnection((db) =>
        db
          .prepare("SELECT payload_json FROM realtime_events WHERE stream_id LIKE 'run:%'")
          .get() as { payload_json: string } | undefined,
      );
      expect(row).toBeDefined();
      expect(row!.payload_json).not.toContain(secretBody);
      expect(row!.payload_json).toContain("[REDACTED]");
    } finally {
      state.close();
    }
  }, 60_000);
});
