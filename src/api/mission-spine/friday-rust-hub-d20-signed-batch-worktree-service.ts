import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { FridayDomainError } from "#errors";

const execFileAsync = promisify(execFile);

export const FRIDAY_D20_SIGNED_BATCH_WORKTREE_FLAG = "FRIDAY_D20_SIGNED_BATCH_WORKTREE_VIA_RUST";

export interface FridayD20SignedBatchWorktreeInput {
  readonly signedBatch: unknown;
  readonly action: unknown;
  readonly workspaceRoot: string;
}

export interface FridayD20SignedBatchWorktreeReceipt {
  readonly truthLabel: "d20_worktree_signed_batch_artifact";
  readonly proofOnly: true;
  readonly ok: boolean;
  readonly executed: boolean;
  readonly resultStatus: string;
  readonly action?: string;
  readonly summary?: string;
  readonly reason?: string;
  readonly batchSignId?: string;
  readonly auditChainVerified?: boolean;
}

export interface CreateFridayD20SignedBatchWorktreeServiceOptions {
  readonly repoRoot?: string;
  readonly dbPath?: string;
  readonly operatorVkPath?: string;
  readonly adapterBin?: string;
  readonly timeoutMs?: number;
}

export interface FridayD20SignedBatchWorktreeService {
  dispatch(
    input: FridayD20SignedBatchWorktreeInput,
  ): Promise<FridayD20SignedBatchWorktreeReceipt>;
}

function unavailable(message: string): FridayDomainError {
  return new FridayDomainError("D20_SIGNED_BATCH_WORKTREE_UNAVAILABLE", message, {
    httpStatus: 503,
    details: {
      surface: "service:d20_signed_batch_worktree",
      truthLabel: "d20_worktree_signed_batch_artifact",
      proofOnly: true,
    },
  });
}

function readTimeoutMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveDefaultRepoRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, "../../..");
}

function requireExistingFile(path: string | undefined, label: string): string {
  const resolved = path ? resolve(path) : "";
  if (!resolved || !existsSync(resolved) || !statSync(resolved).isFile()) {
    throw unavailable(`${label} is not provisioned.`);
  }
  return resolved;
}

function requireExistingDirectory(path: string, label: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw unavailable(`${label} is not present.`);
  }
  return resolved;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseReceipt(payload: unknown): FridayD20SignedBatchWorktreeReceipt {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw unavailable("D20 signed-batch worktree bridge returned a non-object payload.");
  }
  const root = payload as Record<string, unknown>;
  if (root.truth_label !== "d20_worktree_signed_batch_artifact") {
    throw unavailable("D20 signed-batch worktree bridge returned the wrong truth label.");
  }
  if (root.proof_only !== true) {
    throw unavailable("D20 signed-batch worktree bridge did not preserve proof_only.");
  }
  const ok = asBoolean(root.ok);
  const executed = asBoolean(root.executed);
  const resultStatus = asString(root.result_status);
  if (ok === undefined || executed === undefined || !resultStatus) {
    throw unavailable("D20 signed-batch worktree bridge payload is missing required refs.");
  }
  return {
    truthLabel: "d20_worktree_signed_batch_artifact",
    proofOnly: true,
    ok,
    executed,
    resultStatus,
    action: asString(root.action),
    summary: asString(root.summary),
    reason: asString(root.reason),
    batchSignId: asString(root.batch_sign_id),
    auditChainVerified: asBoolean(root.audit_chain_verified),
  };
}

export function createFridayD20SignedBatchWorktreeService(
  options: CreateFridayD20SignedBatchWorktreeServiceOptions = {},
): FridayD20SignedBatchWorktreeService {
  const repoRoot = resolve(
    options.repoRoot ?? process.env.FRIDAY_REPO_ROOT ?? resolveDefaultRepoRoot(),
  );
  const rustCoreRoot = resolve(
    process.env.FRIDAY_MISSION_SPINE_RUST_CORE_ROOT ?? join(repoRoot, "rust-core"),
  );
  const adapterBin = options.adapterBin ?? process.env.FRIDAY_D20_SIGNED_BATCH_WORKTREE_BIN;
  const dbPath = options.dbPath ?? process.env.FRIDAY_HUB_AGENT_RUN_DB_PATH;
  const operatorVkPath =
    options.operatorVkPath ?? process.env.FRIDAY_OPERATOR_APPROVAL_VERIFY_KEY_PATH;
  const timeoutMs =
    options.timeoutMs
    ?? readTimeoutMs(process.env.FRIDAY_D20_SIGNED_BATCH_WORKTREE_TIMEOUT_MS, 120_000);

  return {
    async dispatch(
      input: FridayD20SignedBatchWorktreeInput,
    ): Promise<FridayD20SignedBatchWorktreeReceipt> {
      const db = requireExistingFile(dbPath, "D20 signed-batch hub DB");
      const vk = requireExistingFile(operatorVkPath, "D20 operator verify key");
      const workspace = requireExistingDirectory(input.workspaceRoot, "D20 active worktree");
      const scratch = await mkdtemp(join(tmpdir(), "friday-d20-batch-"));
      try {
        const signedPath = join(scratch, "signed-batch.json");
        const actionPath = join(scratch, "action.json");
        await writeFile(signedPath, JSON.stringify(input.signedBatch), "utf8");
        await writeFile(actionPath, JSON.stringify(input.action), "utf8");

        const adapterArgs = [
          "--db",
          db,
          "--workspace",
          workspace,
          "--signed-batch-json",
          signedPath,
          "--action-json",
          actionPath,
          "--operator-vk-path",
          vk,
        ];
        const command = adapterBin ?? "cargo";
        const args = adapterBin
          ? adapterArgs
          : [
              "run",
              "--quiet",
              "--manifest-path",
              join(rustCoreRoot, "Cargo.toml"),
              "-p",
              "friday-hub",
              "--bin",
              "hub_d20_signed_batch_worktree",
              "--",
              ...adapterArgs,
            ];

        let stdout = "";
        try {
          const result = await execFileAsync(command, args, {
            cwd: repoRoot,
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024,
            env: {
              ...process.env,
              RUST_BACKTRACE: "0",
            },
          });
          stdout = result.stdout;
        } catch {
          throw unavailable("D20 signed-batch worktree bridge could not produce a refs-only receipt.");
        }
        try {
          return parseReceipt(JSON.parse(stdout));
        } catch (err) {
          if (err instanceof FridayDomainError) throw err;
          throw unavailable("D20 signed-batch worktree bridge returned invalid JSON.");
        }
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
