import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { FridayDomainError } from "#errors";
import type { FridayAuthPrincipal } from "../model/friday-api-common.types.js";
import type { FridayStartRunRequest } from "../model/friday-api-workflow.types.js";
import type { FridayWorkflowRunEntity, WorkflowRunStatus } from "#workflows";

const execFileAsync = promisify(execFile);

export interface FridayRustHubWorkflowRunBridgeService {
  startRun(
    input: FridayStartRunRequest,
    principal: FridayAuthPrincipal | null,
  ): Promise<{ run: FridayWorkflowRunEntity }>;
  getRun(
    runId: string,
    principal: FridayAuthPrincipal | null,
  ): Promise<{ run: FridayWorkflowRunEntity }>;
}

export interface CreateFridayRustHubWorkflowRunBridgeServiceOptions {
  readonly repoRoot?: string;
  readonly dbPath?: string;
  readonly workspaceRoot?: string;
  readonly runBin?: string;
  readonly readbackBin?: string;
  readonly timeoutMs?: number;
}

interface RustWorkflowRunProjection {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly status: WorkflowRunStatus;
  readonly triggerType: string;
  readonly startedAt: string;
  readonly pausedAt?: string;
  readonly finishedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly proofRequired?: boolean;
  readonly evidenceStatus: "available";
  readonly completionVerification: "verified" | "proof_pending" | "blocked";
  readonly failure?: {
    readonly code: string;
    readonly message: string;
  };
}

function unavailable(message: string): FridayDomainError {
  return new FridayDomainError("TS_RUNTIME_WORKFLOW_RUN_RUST_BRIDGE_UNAVAILABLE", message, {
    httpStatus: 503,
    details: {
      classification: "fail_closed",
      replacement: "rust_owned_workflow_run_entrypoint_required",
      bridge: "rust_wired_dev",
      proofOnly: true,
    },
  });
}

function resolveDefaultRepoRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, "../../..");
}

function readTimeoutMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePrebuiltBin(
  explicitBin: string | undefined,
  rustCoreRoot: string,
  name: string,
): string | undefined {
  if (explicitBin) return resolve(explicitBin);
  const releaseBin = resolve(rustCoreRoot, "target", "release", name);
  return existsSync(releaseBin) ? releaseBin : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function reqString(root: Record<string, unknown>, key: string): string {
  const value = root[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw unavailable(`Rust workflow-run bridge payload is missing ${key}.`);
  }
  return value;
}

function reqNumber(root: Record<string, unknown>, key: string): number {
  const value = root[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw unavailable(`Rust workflow-run bridge payload is missing ${key}.`);
  }
  return value;
}

function optNumber(root: Record<string, unknown>, key: string): number | undefined {
  const value = root[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function mapStatus(status: string): WorkflowRunStatus {
  if (status === "done" || status === "completed") return "completed";
  if (status === "failed") return status;
  if (status === "awaiting_checkpoint") return "paused";
  throw unavailable("Rust workflow-run bridge returned an unsupported status.");
}

function parseStartRefs(payload: unknown): {
  runId: string;
  workflowId: string;
  workflowVersionId: string;
  triggerType: string;
} {
  const root = asRecord(payload);
  if (!root) {
    throw unavailable("Rust workflow-run bridge returned a non-object payload.");
  }
  if (root.ok !== true || root.truth_label !== "rust_wired_dev" || root.proof_only !== true) {
    throw unavailable("Rust workflow-run bridge did not return an ok rust_wired_dev proof receipt.");
  }
  return {
    runId: reqString(root, "run_id"),
    workflowId: reqString(root, "workflow_id"),
    workflowVersionId: `rust-version:${String(reqNumber(root, "version"))}`,
    triggerType: "manual",
  };
}

function parseProjection(
  payload: unknown,
  fallback: {
    workflowId?: string;
    workflowVersionId?: string;
    triggerType?: string;
    proofRequired?: boolean;
  } = {},
): RustWorkflowRunProjection {
  const root = asRecord(payload);
  if (!root) {
    throw unavailable("Rust workflow-run bridge returned a non-object payload.");
  }
  if (root.ok !== true || root.truth_label !== "rust_wired_dev" || root.proof_only !== true) {
    throw unavailable("Rust workflow-run bridge did not return an ok rust_wired_dev proof receipt.");
  }
  const runId = reqString(root, "run_id");
  const workflowId = typeof fallback.workflowId === "string" && fallback.workflowId
    ? fallback.workflowId
    : reqString(root, "workflow_id");
  const version = typeof fallback.workflowVersionId === "string" && fallback.workflowVersionId
    ? fallback.workflowVersionId
    : `rust-version:${String(reqNumber(root, "version"))}`;
  const statusRaw = typeof root.status === "string" && root.status.trim() !== ""
    ? root.status
    : reqString(root, "run_state");
  const status = mapStatus(statusRaw);
  const createdAtMs = reqNumber(root, "created_at_ms");
  const updatedAtMs = reqNumber(root, "updated_at_ms");
  const firstPendingSeq = optNumber(root, "first_pending_seq");
  const failure = status === "failed"
    ? { code: "RUST_WORKFLOW_RUN_FAILED", message: "redacted" }
    : undefined;
  return {
    runId,
    workflowId,
    workflowVersionId: version,
    status,
    triggerType: fallback.triggerType ?? "manual",
    startedAt: isoFromMs(createdAtMs),
    pausedAt: statusRaw === "awaiting_checkpoint" ? isoFromMs(updatedAtMs) : undefined,
    finishedAt: status === "completed" || status === "failed" ? isoFromMs(updatedAtMs) : undefined,
    createdAt: isoFromMs(createdAtMs),
    updatedAt: isoFromMs(updatedAtMs),
    proofRequired: fallback.proofRequired,
    evidenceStatus: "available",
    completionVerification: status === "completed"
      ? "verified"
      : firstPendingSeq === undefined || firstPendingSeq === null
        ? "blocked"
        : "proof_pending",
    failure,
  };
}

function toRunEntity(projection: RustWorkflowRunProjection): FridayWorkflowRunEntity {
  return {
    id: projection.runId,
    workflowId: projection.workflowId,
    workflowVersionId: projection.workflowVersionId,
    status: projection.status,
    triggerType: projection.triggerType,
    startedAt: projection.startedAt,
    pausedAt: projection.pausedAt,
    finishedAt: projection.finishedAt,
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
    proofRequired: projection.proofRequired,
    evidenceStatus: projection.evidenceStatus,
    completionVerification: projection.completionVerification,
    failure: projection.failure,
  };
}

async function runJsonBin(
  bin: string | undefined,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<unknown> {
  if (!bin) {
    throw unavailable("Rust workflow-run bridge requires a prebuilt binary.");
  }
  let stdout = "";
  try {
    const result = await execFileAsync(bin, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, RUST_BACKTRACE: "0" },
    });
    stdout = result.stdout;
  } catch {
    throw unavailable("Rust workflow-run bridge could not produce a refs-only receipt.");
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw unavailable("Rust workflow-run bridge returned invalid JSON.");
  }
}

export function createFridayRustHubWorkflowRunBridgeService(
  options: CreateFridayRustHubWorkflowRunBridgeServiceOptions = {},
): FridayRustHubWorkflowRunBridgeService {
  const repoRoot = resolve(
    options.repoRoot ?? process.env.FRIDAY_REPO_ROOT ?? resolveDefaultRepoRoot(),
  );
  const rustCoreRoot = resolve(
    process.env.FRIDAY_MISSION_SPINE_RUST_CORE_ROOT ?? join(repoRoot, "rust-core"),
  );
  const dbPathRaw = options.dbPath
    ?? process.env.FRIDAY_HUB_WORKFLOW_RUN_DB_PATH
    ?? process.env.FRIDAY_HUB_WORKFLOW_CATALOG_DB_PATH;
  const workspaceRootRaw = options.workspaceRoot ?? process.env.FRIDAY_WORKSPACE_ROOT;
  const runBin = resolvePrebuiltBin(
    options.runBin ?? process.env.FRIDAY_HUB_WORKFLOW_RUN_BIN,
    rustCoreRoot,
    "hub_workflow_run",
  );
  const readbackBin = resolvePrebuiltBin(
    options.readbackBin ?? process.env.FRIDAY_HUB_WORKFLOW_RUN_READBACK_BIN,
    rustCoreRoot,
    "hub_workflow_run_readback",
  );
  const timeoutMs =
    options.timeoutMs ?? readTimeoutMs(process.env.FRIDAY_HUB_WORKFLOW_RUN_TIMEOUT_MS, 120_000);
  const metadataByRunId = new Map<string, {
    workflowId: string;
    workflowVersionId: string;
    triggerType: string;
    proofRequired?: boolean;
  }>();

  function requireDbPath(): string {
    if (!dbPathRaw) {
      throw unavailable("Rust workflow-run bridge requires a DB path.");
    }
    const dbPath = resolve(dbPathRaw);
    if (!existsSync(dbPath)) {
      throw unavailable("Rust workflow-run bridge DB is not present for this runtime.");
    }
    return dbPath;
  }

  function requireWorkspaceRoot(): string {
    if (!workspaceRootRaw) {
      throw unavailable("Rust workflow-run bridge requires a workspace root.");
    }
    const workspaceRoot = resolve(workspaceRootRaw);
    if (!existsSync(workspaceRoot)) {
      throw unavailable("Rust workflow-run bridge workspace root is not present.");
    }
    return workspaceRoot;
  }

  return {
    async startRun(input) {
      if (input.workflowVersionId) {
        throw unavailable("Rust workflow-run bridge does not accept TypeScript workflowVersionId values.");
      }
      const dbPath = requireDbPath();
      const workspaceRoot = requireWorkspaceRoot();
      const args = [
        "--db",
        dbPath,
        "--workspace",
        workspaceRoot,
        "--workflow-id",
        input.workflowId,
      ];
      const parsed = await runJsonBin(runBin, args, { cwd: repoRoot, timeoutMs });
      const refs = parseStartRefs(parsed);
      const metadata = {
        workflowId: refs.workflowId,
        workflowVersionId: refs.workflowVersionId,
        triggerType: input.triggerType ?? refs.triggerType,
        proofRequired: input.proofRequired,
      };
      metadataByRunId.set(refs.runId, metadata);
      const readback = await runJsonBin(readbackBin, [
        "--db",
        dbPath,
        "--run-id",
        refs.runId,
      ], { cwd: repoRoot, timeoutMs });
      return { run: toRunEntity(parseProjection(readback, metadata)) };
    },
    async getRun(runId) {
      const metadata = metadataByRunId.get(runId);
      if (!metadata) {
        throw unavailable("Rust workflow-run readback requires start-run metadata in this runtime.");
      }
      const dbPath = requireDbPath();
      const parsed = await runJsonBin(readbackBin, [
        "--db",
        dbPath,
        "--run-id",
        runId,
      ], { cwd: repoRoot, timeoutMs });
      return { run: toRunEntity(parseProjection(parsed, metadata)) };
    },
  };
}
