import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFridayRustHubRunAnswerReadbackService } from "../../../../src/api/mission-spine/friday-rust-hub-run-answer-readback-service.js";

/**
 * PROOF-ONLY (Rust-wired-DEV), DARK owner-gated answer-BODY readback bridge test.
 * Spawns a SCRIPTED MOCK bin (no real DB, no DeepSeek call, no quota, no secret) so it
 * runs in CI hermetically, mirroring the proven chmod-0o755 shebang-mock idiom from the
 * refs-only readback bridge test. The mock stands in for the Rust
 * `hub_run_answer_readback` bin's three owner-gating outcomes.
 *
 * The mock bin is supplied as `adapterBin`, AND a real (empty) file is created at
 * `dbPath` so the service's `existsSync(dbPath)` precondition passes before the mock is
 * spawned. The OWNER-GATING decision itself is proven in the Rust bin's own unit tests
 * (against a real fixture DB); these tests prove the TS bridge faithfully transports the
 * delivered body to the owner and fails closed on every non-delivered / malformed case.
 */
describe("friday-rust-hub-run-answer-readback-service (S3 dark owner-gated body)", () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
      scratch = undefined;
    }
  });

  function setup(mockSource: string): { binPath: string; dbPath: string } {
    scratch = mkdtempSync(join(tmpdir(), "friday-hub-run-answer-readback-"));
    const binPath = join(scratch, "hub_run_answer_readback_mock.mjs");
    writeFileSync(binPath, `#!/usr/bin/env node\n${mockSource}`);
    chmodSync(binPath, 0o755);
    const dbPath = join(scratch, "rust-hub.sqlite");
    writeFileSync(dbPath, "mock");
    return { binPath, dbPath };
  }

  it("delivers the answer body to the owner on a delivered outcome", async () => {
    const { binPath, dbPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev",
        proof_only: true,
        ok: true,
        outcome: "delivered",
        run_id: "answer_probe_run",
        status: "finished",
        answer: "the durable final answer body",
        answer_sha256: "0".repeat(64),
        answer_len: 29,
      }));
    `);
    const service = createFridayRustHubRunAnswerReadbackService({ adapterBin: binPath });

    const receipt = await service.readAnswer({
      dbPath,
      runId: "answer_probe_run",
      callerPrincipal: "principal:owner-alice",
    });

    expect(receipt).toMatchObject({
      truthLabel: "rust_wired_dev",
      proofOnly: true,
      outcome: "delivered",
      runId: "answer_probe_run",
      status: "finished",
      answer: "the durable final answer body",
    });
  });

  it("transports a marker-bearing owner body verbatim (no over-block)", async () => {
    // The OWNER's own answer may legitimately contain path/secret-LOOKING substrings; the
    // bridge must NOT withhold or mangle them for the delivered owner.
    const { binPath, dbPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev",
        proof_only: true,
        ok: true,
        outcome: "delivered",
        run_id: "r",
        status: "finished",
        answer: "see /Users/alice/report and use Bearer tok-xyz",
        answer_sha256: "a".repeat(64),
        answer_len: 47,
      }));
    `);
    const service = createFridayRustHubRunAnswerReadbackService({ adapterBin: binPath });

    const receipt = await service.readAnswer({
      dbPath,
      runId: "r",
      callerPrincipal: "principal:owner-alice",
    });

    expect(receipt.outcome).toBe("delivered");
    if (receipt.outcome === "delivered") {
      expect(receipt.answer).toBe("see /Users/alice/report and use Bearer tok-xyz");
    }
  });

  it("returns a body-free denied receipt for a non-owner (no body, no owner)", async () => {
    const { binPath, dbPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev",
        proof_only: true,
        ok: true,
        outcome: "denied",
        run_id: "r",
        deny_reason: "principal_mismatch",
      }));
    `);
    const service = createFridayRustHubRunAnswerReadbackService({ adapterBin: binPath });

    const receipt = await service.readAnswer({
      dbPath,
      runId: "r",
      callerPrincipal: "principal:intruder-bob",
    });

    expect(receipt).toEqual({
      truthLabel: "rust_wired_dev",
      proofOnly: true,
      outcome: "denied",
      runId: "r",
      denyReason: "principal_mismatch",
    });
    expect((receipt as Record<string, unknown>).answer).toBeUndefined();
  });

  it("maps a no-owner-bound run to a denied (no_owner_principal) receipt", async () => {
    const { binPath, dbPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev",
        proof_only: true,
        ok: true,
        outcome: "denied",
        run_id: "r",
        deny_reason: "no_owner_principal",
      }));
    `);
    const service = createFridayRustHubRunAnswerReadbackService({ adapterBin: binPath });

    const receipt = await service.readAnswer({
      dbPath,
      runId: "r",
      callerPrincipal: "principal:owner-alice",
    });

    expect(receipt.outcome).toBe("denied");
    if (receipt.outcome === "denied") {
      expect(receipt.denyReason).toBe("no_owner_principal");
    }
  });

  it("returns a body-free not_found receipt for an unknown run", async () => {
    const { binPath, dbPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev",
        proof_only: true,
        ok: true,
        outcome: "not_found",
        run_id: "missing",
      }));
    `);
    const service = createFridayRustHubRunAnswerReadbackService({ adapterBin: binPath });

    const receipt = await service.readAnswer({
      dbPath,
      runId: "missing",
      callerPrincipal: "principal:owner-alice",
    });

    expect(receipt).toEqual({
      truthLabel: "rust_wired_dev",
      proofOnly: true,
      outcome: "not_found",
      runId: "missing",
    });
  });

  it("fails closed (503) when a denied outcome pathologically carries a body", async () => {
    // A denied outcome MUST be body-free; a body field on it is a contract violation.
    const { binPath, dbPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev",
        ok: true,
        outcome: "denied",
        run_id: "r",
        deny_reason: "principal_mismatch",
        answer: "leaked body that should never ride a denied outcome",
      }));
    `);
    const service = createFridayRustHubRunAnswerReadbackService({ adapterBin: binPath });

    await expect(
      service.readAnswer({ dbPath, runId: "r", callerPrincipal: "principal:intruder-bob" }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_RUN_ANSWER_READBACK_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed when a delivered outcome is missing its body refs", async () => {
    const { binPath, dbPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev",
        ok: true,
        outcome: "delivered",
        run_id: "r",
        status: "finished",
      }));
    `);
    const service = createFridayRustHubRunAnswerReadbackService({ adapterBin: binPath });

    await expect(
      service.readAnswer({ dbPath, runId: "r", callerPrincipal: "principal:owner-alice" }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_RUN_ANSWER_READBACK_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed on an unknown outcome label", async () => {
    const { binPath, dbPath } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev",
        ok: true,
        outcome: "something_else",
        run_id: "r",
      }));
    `);
    const service = createFridayRustHubRunAnswerReadbackService({ adapterBin: binPath });

    await expect(
      service.readAnswer({ dbPath, runId: "r", callerPrincipal: "principal:owner-alice" }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_RUN_ANSWER_READBACK_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("requires a caller principal (fails closed without spawning)", async () => {
    const { binPath, dbPath } = setup(`process.stdout.write("UNREACHABLE");`);
    const service = createFridayRustHubRunAnswerReadbackService({ adapterBin: binPath });

    await expect(
      service.readAnswer({ dbPath, runId: "r", callerPrincipal: "" }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_RUN_ANSWER_READBACK_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed (503) on a non-zero exit", async () => {
    const { binPath, dbPath } = setup(`
      process.stderr.write("hub_run_answer_readback_unavailable: open_failed");
      process.exit(2);
    `);
    const service = createFridayRustHubRunAnswerReadbackService({ adapterBin: binPath });

    await expect(
      service.readAnswer({ dbPath, runId: "r", callerPrincipal: "principal:owner-alice" }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_RUN_ANSWER_READBACK_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed on malformed JSON", async () => {
    const { binPath, dbPath } = setup(`process.stdout.write("not json {");`);
    const service = createFridayRustHubRunAnswerReadbackService({ adapterBin: binPath });

    await expect(
      service.readAnswer({ dbPath, runId: "r", callerPrincipal: "principal:owner-alice" }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_RUN_ANSWER_READBACK_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed on timeout", async () => {
    const { binPath, dbPath } = setup(`setTimeout(() => process.stdout.write("late"), 5000);`);
    const service = createFridayRustHubRunAnswerReadbackService({
      adapterBin: binPath,
      timeoutMs: 200,
    });

    await expect(
      service.readAnswer({ dbPath, runId: "r", callerPrincipal: "principal:owner-alice" }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_RUN_ANSWER_READBACK_UNAVAILABLE",
      httpStatus: 503,
    });
  });
});
