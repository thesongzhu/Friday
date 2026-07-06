import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFridayRustHubWorkflowRunBridgeService } from "../../../../src/api/mission-spine/friday-rust-hub-workflow-run-bridge-service.js";
import type { FridayAuthPrincipal } from "../../../../src/api/model/friday-api-auth.types.js";

function writeJsonBin(path: string, payload: Record<string, unknown>): void {
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      `console.log(${JSON.stringify(JSON.stringify(payload))});`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o755);
}

describe("FridayRustHubWorkflowRunBridgeService", () => {
  it("maps start + readback refs-only receipts into public run entities", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-wf-run-bridge-"));
    try {
      const dbPath = join(dir, "friday.db");
      const workspaceRoot = join(dir, "workspace");
      const runBin = join(dir, "hub_workflow_run");
      const readbackBin = join(dir, "hub_workflow_run_readback");
      writeFileSync(dbPath, "", "utf8");
      mkdirSync(workspaceRoot);

      writeJsonBin(runBin, {
        truth_label: "rust_wired_dev",
        proof_only: true,
        ok: true,
        run_id: "rust-run-1",
        workflow_id: "wf-1",
        version: 1,
        status: "completed",
      });
      writeJsonBin(readbackBin, {
        truth_label: "rust_wired_dev",
        proof_only: true,
        ok: true,
        run_id: "rust-run-1",
        run_state: "done",
        created_at_ms: 1_700_000_000_000,
        updated_at_ms: 1_700_000_001_000,
        first_pending_seq: null,
        step_count: 1,
      });

      const service = createFridayRustHubWorkflowRunBridgeService({
        dbPath,
        workspaceRoot,
        runBin,
        readbackBin,
      });
      const owner: FridayAuthPrincipal = {
        principalType: "user",
        principalId: "tenant-a",
        tenantId: "tenant-a",
        userId: "user-a",
        role: "operator",
        scopes: ["workflow.write", "workflow.read"],
        tokenId: "token-owner",
        tokenKind: "access",
        issuedAt: "2026-07-06T00:00:00.000Z",
      };

      const started = await service.startRun({
        workflowId: "wf-1",
        triggerType: "manual",
      }, owner);
      expect(started.run).toMatchObject({
        id: "rust-run-1",
        workflowId: "wf-1",
        workflowVersionId: "rust-version:1",
        status: "completed",
      });

      const read = await service.getRun("rust-run-1", owner);
      expect(read.run).toMatchObject({
        id: "rust-run-1",
        workflowId: "wf-1",
        workflowVersionId: "rust-version:1",
        status: "completed",
      });

      await expect(service.getRun("rust-run-1", {
        principalType: "user",
        principalId: "tenant-b",
        tenantId: "tenant-b",
        userId: "user-b",
        role: "viewer",
        scopes: ["workflow.read"],
        tokenId: "token-other",
        tokenKind: "access",
        issuedAt: "2026-07-06T00:00:00.000Z",
      })).rejects.toMatchObject({
        code: "WORKFLOW_RUN_FORBIDDEN",
        httpStatus: 403,
      });

      await expect(service.startRun({
        workflowId: "wf-1",
        triggerType: "manual",
        dryRun: true,
      }, owner)).rejects.toMatchObject({
        code: "TS_RUNTIME_WORKFLOW_RUN_RUST_BRIDGE_UNAVAILABLE",
        httpStatus: 503,
      });

      await expect(service.startRun({
        workflowId: "wf-1",
        triggerType: "webhook",
      }, owner)).rejects.toMatchObject({
        code: "TS_RUNTIME_WORKFLOW_RUN_RUST_BRIDGE_UNAVAILABLE",
        httpStatus: 503,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
