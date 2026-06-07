import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFridayRustHubRunTaskBridgeService } from "../../../../src/api/mission-spine/friday-rust-hub-run-task-bridge-service.js";

/**
 * PROOF-ONLY (Rust-wired-DEV) bridge test. Spawns a SCRIPTED MOCK bin (no real DeepSeek
 * call, no quota, no secret) so it runs in CI hermetically, mirroring the proven
 * chmod-0o755 shebang-mock idiom from friday-provider-cli-backend.test.ts. Covers: happy
 * path, non-zero exit, malformed JSON, timeout, and a raw-body-leak rejection.
 */
describe("friday-rust-hub-run-task-bridge-service (S0 dev write-bridge)", () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
      scratch = undefined;
    }
  });

  function setup(mockSource: string): { binPath: string; workspaceRoot: string } {
    scratch = mkdtempSync(join(tmpdir(), "friday-hub-run-task-bridge-"));
    const binPath = join(scratch, "hub_run_task_mock.mjs");
    writeFileSync(binPath, `#!/usr/bin/env node\n${mockSource}`);
    chmodSync(binPath, 0o755);
    const workspaceRoot = join(scratch, "ws");
    mkdirSync(workspaceRoot, { recursive: true });
    return { binPath, workspaceRoot };
  }

  it("parses a valid refs-only receipt on the happy path", async () => {
    const { binPath, workspaceRoot } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev",
        proof_only: true,
        ok: true,
        run_id: "hub_run_task_dev_mock",
        route_id: "deepseek:deepseek-v4-flash",
        provider_id: "deepseek",
        model: "deepseek-v4-flash",
        model_size: "Small",
        backend_kind: "Http",
        loop_status: "Finished",
        turns: 2,
        executed_tools: 1,
        final_message_sha256: "0".repeat(64),
        final_message_len: 42,
        audit_chain_verified: true,
      }));
    `);
    const service = createFridayRustHubRunTaskBridgeService({ adapterBin: binPath });

    const receipt = await service.runReadMostlyTask({
      task: "read the file notes.md and summarize it",
      workspaceRoot,
    });

    expect(receipt).toMatchObject({
      truthLabel: "rust_wired_dev",
      proofOnly: true,
      runId: "hub_run_task_dev_mock",
      routeId: "deepseek:deepseek-v4-flash",
      providerId: "deepseek",
      loopStatus: "Finished",
      turns: 2,
      executedTools: 1,
      finalMessageLen: 42,
      auditChainVerified: true,
    });
    expect(receipt.finalMessageSha256).toBe("0".repeat(64));
    // The body text must never appear on the receipt.
    expect((receipt as Record<string, unknown>).finalMessage).toBeUndefined();
  });

  it("fails closed (503) on a non-zero exit", async () => {
    const { binPath, workspaceRoot } = setup(`
      process.stderr.write("hub_run_task_unavailable: init_failed");
      process.exit(2);
    `);
    const service = createFridayRustHubRunTaskBridgeService({ adapterBin: binPath });

    await expect(
      service.runReadMostlyTask({ task: "do a thing", workspaceRoot }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_RUN_TASK_BRIDGE_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed on malformed JSON", async () => {
    const { binPath, workspaceRoot } = setup(`process.stdout.write("not json {");`);
    const service = createFridayRustHubRunTaskBridgeService({ adapterBin: binPath });

    await expect(
      service.runReadMostlyTask({ task: "do a thing", workspaceRoot }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_RUN_TASK_BRIDGE_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("fails closed on timeout", async () => {
    const { binPath, workspaceRoot } = setup(`setTimeout(() => process.stdout.write("late"), 5000);`);
    const service = createFridayRustHubRunTaskBridgeService({ adapterBin: binPath, timeoutMs: 200 });

    await expect(
      service.runReadMostlyTask({ task: "do a thing", workspaceRoot }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_RUN_TASK_BRIDGE_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("rejects a payload that carries a raw message body (no-body boundary)", async () => {
    const { binPath, workspaceRoot } = setup(`
      process.stdout.write(JSON.stringify({
        truth_label: "rust_wired_dev",
        ok: true,
        run_id: "leak",
        route_id: "deepseek:deepseek-v4-flash",
        final_message: "the raw model output that must never cross the bridge",
        final_message_sha256: "0".repeat(64),
        final_message_len: 51,
        audit_chain_verified: true,
      }));
    `);
    const service = createFridayRustHubRunTaskBridgeService({ adapterBin: binPath });

    await expect(
      service.runReadMostlyTask({ task: "do a thing", workspaceRoot }),
    ).rejects.toMatchObject({
      code: "MISSION_SPINE_RUST_RUN_TASK_BRIDGE_UNAVAILABLE",
      httpStatus: 503,
    });
  });
});
