import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFridayRustHubRunReadbackService } from "../../../../src/api/mission-spine/friday-rust-hub-run-readback-service.js";

/**
 * PROOF-ONLY (Rust-wired-DEV) readback bridge test. Spawns a SCRIPTED MOCK bin (no real
 * DB, no DeepSeek call, no quota, no secret) so it runs in CI hermetically, mirroring the
 * proven chmod-0o755 shebang-mock idiom from the S0 run-task bridge test. Covers: happy
 * path, non-zero exit, malformed JSON, timeout, and a raw-body-leak rejection.
 *
 * The mock bin is supplied as `adapterBin`, AND a real (empty) file is created at `dbPath`
 * so the service's `existsSync(dbPath)` precondition passes before the mock is spawned.
 */
describe("friday-rust-hub-run-readback-service (S2 dev read-bridge)", () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
      scratch = undefined;
    }
  });

  function setup(mockSource: string): { binPath: string; dbPath: string } {
    scratch = mkdtempSync(join(tmpdir(), "friday-hub-run-readback-"));
    const binPath = join(scratch, "hub_run_readback_mock.mjs");
    writeFileSync(binPath, `#!/usr/bin/env node\n${mockSource}`);
    chmodSync(binPath, 0o755);
    // A present (content-irrelevant) DB file so the existsSync precondition passes; the
    // mock bin never opens it.
    const dbPath = join(scratch, "rust-hub.sqlite");
    writeFileSync(dbPath, "mock");
    return { binPath, dbPath };
  }

  it("parses a valid refs-only readback on the happy path", async () => {
    const { binPath, dbPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev",
        proof_only: true,
        ok: true,
        run_id: "readback_probe_run",
        run_state: "awaiting_clarification",
        created_at_ms: 1000,
        updated_at_ms: 1004,
        loop_status_derived: "finished",
        turn_count: 2,
        executed_tool_count: 1,
        event_count: 4,
        event_kinds: [
          "plan.none",
          "tool.executed:read 15 bytes from notes.md",
          "plan.none",
          "agent.finished",
        ],
        audit_chain_verified: true,
        db_wide_token_prompt_total: 0,
        db_wide_token_completion_total: 0,
        db_wide_token_total: 0,
      }));
    `);
    const service = createFridayRustHubRunReadbackService({ adapterBin: binPath });

    const receipt = await service.readRun({ dbPath, runId: "readback_probe_run" });

    expect(receipt).toMatchObject({
      truthLabel: "rust_wired_dev",
      proofOnly: true,
      runId: "readback_probe_run",
      runState: "awaiting_clarification",
      loopStatusDerived: "finished",
      turnCount: 2,
      executedToolCount: 1,
      eventCount: 4,
      auditChainVerified: true,
      dbWideTokenTotal: 0,
    });
    // The ordered event-kind list is preserved verbatim (a relative filename is allowed).
    expect(receipt.eventKinds).toEqual([
      "plan.none",
      "tool.executed:read 15 bytes from notes.md",
      "plan.none",
      "agent.finished",
    ]);
    // The run task body must never appear on the receipt.
    expect((receipt as Record<string, unknown>).task).toBeUndefined();
  });

  it("fails closed (503) on a non-zero exit", async () => {
    const { binPath, dbPath } = setup(`
      process.stderr.write("hub_run_readback_unavailable: run_not_found");
      process.exit(2);
    `);
    const service = createFridayRustHubRunReadbackService({ adapterBin: binPath });

    await expect(service.readRun({ dbPath, runId: "nope" })).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_RUN_READBACK_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed on malformed JSON", async () => {
    const { binPath, dbPath } = setup(`process.stdout.write("not json {");`);
    const service = createFridayRustHubRunReadbackService({ adapterBin: binPath });

    await expect(service.readRun({ dbPath, runId: "r" })).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_RUN_READBACK_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed on timeout", async () => {
    const { binPath, dbPath } = setup(`setTimeout(() => process.stdout.write("late"), 5000);`);
    const service = createFridayRustHubRunReadbackService({ adapterBin: binPath, timeoutMs: 200 });

    await expect(service.readRun({ dbPath, runId: "r" })).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_RUN_READBACK_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("rejects a payload that carries a raw run body (no-body boundary)", async () => {
    const { binPath, dbPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev",
        ok: true,
        run_id: "leak",
        run_state: "awaiting_clarification",
        task: "the raw run task body that must never cross the bridge",
        turn_count: 0,
        executed_tool_count: 0,
        event_count: 0,
        event_kinds: [],
        audit_chain_verified: true,
      }));
    `);
    const service = createFridayRustHubRunReadbackService({ adapterBin: binPath });

    await expect(service.readRun({ dbPath, runId: "leak" })).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_RUN_READBACK_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed on an invalid event_kinds shape", async () => {
    const { binPath, dbPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev",
        ok: true,
        run_id: "bad",
        run_state: "awaiting_clarification",
        event_kinds: [1, 2, 3],
        audit_chain_verified: true,
      }));
    `);
    const service = createFridayRustHubRunReadbackService({ adapterBin: binPath });

    await expect(service.readRun({ dbPath, runId: "bad" })).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_RUN_READBACK_UNAVAILABLE",
      httpStatus: 503,
    });
  });
});
