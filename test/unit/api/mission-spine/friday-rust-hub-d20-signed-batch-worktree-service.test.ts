import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createFridayD20SignedBatchWorktreeService } from "#api";

const scratchDirs: string[] = [];

async function makeScratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "friday-d20-service-test-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createFridayD20SignedBatchWorktreeService", () => {
  it("runs the configured adapter with temp signed-batch/action files and parses refs-only output", async () => {
    const dir = await makeScratch();
    const dbPath = join(dir, "hub.db");
    const vkPath = join(dir, "operator.vk");
    const workspaceRoot = join(dir, "worktree");
    const adapterBin = join(dir, "fake-adapter.mjs");
    await writeFile(dbPath, "", "utf8");
    await writeFile(vkPath, "verify-key", "utf8");
    const actualWorkspace = await mkdtemp(`${workspaceRoot}-`);
    scratchDirs.push(actualWorkspace);
    await writeFile(adapterBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const fs = await import("node:fs");
JSON.parse(fs.readFileSync(value("--signed-batch-json"), "utf8"));
JSON.parse(fs.readFileSync(value("--action-json"), "utf8"));
if (!fs.existsSync(value("--db")) || !fs.existsSync(value("--operator-vk-path"))) process.exit(7);
if (value("--workspace") !== ${JSON.stringify(actualWorkspace)}) process.exit(8);
console.log(JSON.stringify({
  truth_label: "d20_worktree_signed_batch_artifact",
  proof_only: true,
  ok: true,
  executed: false,
  result_status: "requires_approval",
  batch_sign_id: "batch-1",
  audit_chain_verified: true
}));
`, "utf8");
    await chmod(adapterBin, 0o755);

    const service = createFridayD20SignedBatchWorktreeService({
      repoRoot: dir,
      dbPath,
      operatorVkPath: vkPath,
      adapterBin,
      timeoutMs: 5_000,
    });

    await expect(service.dispatch({
      workspaceRoot: actualWorkspace,
      signedBatch: { decision: "allow" },
      action: { action: "write_file", principal_id: "owner:alice", params: [] },
    })).resolves.toMatchObject({
      truthLabel: "d20_worktree_signed_batch_artifact",
      proofOnly: true,
      ok: true,
      executed: false,
      resultStatus: "requires_approval",
      batchSignId: "batch-1",
      auditChainVerified: true,
    });
  });

  it("fails closed when the operator verify key is not provisioned", async () => {
    const dir = await makeScratch();
    const dbPath = join(dir, "hub.db");
    await writeFile(dbPath, "", "utf8");
    const service = createFridayD20SignedBatchWorktreeService({
      repoRoot: dir,
      dbPath,
      operatorVkPath: join(dir, "missing.vk"),
    });

    await expect(service.dispatch({
      workspaceRoot: dir,
      signedBatch: { decision: "allow" },
      action: { action: "write_file", principal_id: "owner:alice", params: [] },
    })).rejects.toMatchObject({
      code: "D20_SIGNED_BATCH_WORKTREE_UNAVAILABLE",
      httpStatus: 503,
    });
  });
});
