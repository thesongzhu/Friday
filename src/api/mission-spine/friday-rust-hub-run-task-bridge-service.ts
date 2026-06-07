import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { FridayDomainError } from "#errors";

/**
 * PROOF-ONLY (Rust-wired-DEV) TS→Rust bridge for the S0 `hub_run_task` write-bridge.
 *
 * This clones the READ-ONLY `friday-rust-hub-workbench-projection-service` execFile shape
 * to prove the Rust agent loop (`HubRuntime::run_task`) is reachable end-to-end for a
 * READ-MOSTLY task. It is NOT a replacement for the (now fail-closed-fenced) TS
 * `executeRun`/`startRun`, it registers NO production route, and it confers no v1 GO.
 * Every value it returns is REFS-ONLY: a sha256 hash + length of the final message
 * (never the body text), plus safe identifiers. The bridge fails CLOSED (503) on any
 * non-zero exit, timeout, parse failure, invalid shape, or any payload that carries a
 * raw message body.
 *
 * The single live proof (real DeepSeek call, spends quota) is a SEPARATE operator step —
 * this service inherits `FRIDAY_DEEPSEEK_API_KEY` from the ambient env (it never reads or
 * constructs a secret itself) and the Rust bin reads it via `DeepSeekClient::from_env`.
 */
const execFileAsync = promisify(execFile);

/** Refs-only receipt — no message body, no secrets, no PII. */
export interface FridayRustHubRunTaskBridgeReceipt {
  /** Always the dev tier — this is NOT a product/proven receipt. */
  readonly truthLabel: "rust_wired_dev";
  /** Always true — a loud reminder this is a dev bridge, not a product path. */
  readonly proofOnly: true;
  readonly runId: string;
  readonly routeId: string;
  readonly providerId?: string;
  readonly model?: string;
  readonly modelSize?: string;
  readonly backendKind?: string;
  readonly loopStatus?: string;
  /**
   * Bounded, refs-only error-category token (one of `parse_error` | `timeout` |
   * `provider_http_error` | `agent_error_other`). Present ONLY when the loop ran but a turn
   * errored (`loopStatus === "Errored"`); absent otherwise. NEVER carries raw model text —
   * the Rust bin emits a fixed token, never `outcome.detail`.
   */
  readonly errorCategory?: string;
  readonly turns?: number;
  readonly executedTools?: number;
  /** sha256 of the final message body (the body itself is never transported). */
  readonly finalMessageSha256: string;
  readonly finalMessageLen: number;
  readonly auditChainVerified: boolean;
}

export interface FridayRustHubRunTaskBridgeInput {
  /** The read-mostly task prompt to drive through the Rust agent loop. */
  readonly task: string;
  /** Workspace root the loop's fs tools are contained to (must exist). */
  readonly workspaceRoot: string;
  /** Optional Hub DB path; the bin derives an isolated dev DB under the workspace if absent. */
  readonly dbPath?: string;
  readonly runId?: string;
  readonly maxTurns?: number;
}

export interface CreateFridayRustHubRunTaskBridgeServiceOptions {
  readonly repoRoot?: string;
  /** Path to a prebuilt `hub_run_task` binary; falls back to `cargo run --bin` when absent. */
  readonly adapterBin?: string;
  readonly timeoutMs?: number;
}

export interface FridayRustHubRunTaskBridgeService {
  runReadMostlyTask(
    input: FridayRustHubRunTaskBridgeInput,
  ): Promise<FridayRustHubRunTaskBridgeReceipt>;
}

function unavailable(message: string): FridayDomainError {
  return new FridayDomainError("MISSION_SPINE_RUST_RUN_TASK_BRIDGE_UNAVAILABLE", message, {
    httpStatus: 503,
    details: {
      surface: "service:rust_hub_run_task_bridge",
      bridge: "rust_wired_dev",
      proofOnly: true,
      proofReady: false,
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Validate + normalize the Rust bin's refs-only stdout into a receipt. Fails closed on
 * any shape violation AND on any attempt to carry a raw message body (the boundary this
 * slice exists to prove).
 */
function parseReceipt(payload: unknown): FridayRustHubRunTaskBridgeReceipt {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw unavailable("Rust hub_run_task bridge returned a non-object payload.");
  }
  const root = payload as Record<string, unknown>;

  // Hard boundary: the body text must NEVER cross the bridge — only a hash/length may.
  if ("final_message" in root || "finalMessage" in root) {
    throw unavailable("Rust hub_run_task bridge payload carried a raw message body (rejected).");
  }
  if (root.truth_label !== "rust_wired_dev") {
    throw unavailable("Rust hub_run_task bridge payload is not labeled rust_wired_dev.");
  }
  if (root.ok === false) {
    throw unavailable("Rust hub_run_task bridge reported a fail-closed run.");
  }

  const runId = asString(root.run_id);
  const routeId = asString(root.route_id);
  // sha256/len are validated as a non-empty string / finite number ONLY — NOT for
  // high-entropy hex shape (keeps test fixtures off detect-secrets' entropy heuristics).
  const finalMessageSha256 = asString(root.final_message_sha256);
  const finalMessageLen = asNumber(root.final_message_len);
  const auditChainVerified = root.audit_chain_verified;

  if (!runId || !routeId || !finalMessageSha256) {
    throw unavailable("Rust hub_run_task bridge payload is missing required refs.");
  }
  if (finalMessageLen === undefined) {
    throw unavailable("Rust hub_run_task bridge payload is missing final_message_len.");
  }
  if (typeof auditChainVerified !== "boolean") {
    throw unavailable("Rust hub_run_task bridge payload is missing audit_chain_verified.");
  }

  return {
    truthLabel: "rust_wired_dev",
    proofOnly: true,
    runId,
    routeId,
    providerId: asString(root.provider_id),
    model: asString(root.model),
    modelSize: asString(root.model_size),
    backendKind: asString(root.backend_kind),
    loopStatus: asString(root.loop_status),
    // Optional bounded token; coerced to undefined unless a non-empty string is present.
    errorCategory: asString(root.error_category),
    turns: asNumber(root.turns),
    executedTools: asNumber(root.executed_tools),
    finalMessageSha256,
    finalMessageLen,
    auditChainVerified,
  };
}

export function createFridayRustHubRunTaskBridgeService(
  options: CreateFridayRustHubRunTaskBridgeServiceOptions = {},
): FridayRustHubRunTaskBridgeService {
  const repoRoot = resolve(
    options.repoRoot ?? process.env.FRIDAY_REPO_ROOT ?? resolveDefaultRepoRoot(),
  );
  const rustCoreRoot = resolve(
    process.env.FRIDAY_MISSION_SPINE_RUST_CORE_ROOT ?? join(repoRoot, "rust-core"),
  );
  const adapterBin = options.adapterBin ?? process.env.FRIDAY_HUB_RUN_TASK_BRIDGE_BIN;
  const timeoutMs =
    options.timeoutMs ??
    readTimeoutMs(process.env.FRIDAY_HUB_RUN_TASK_BRIDGE_TIMEOUT_MS, 120_000);

  return {
    async runReadMostlyTask(
      input: FridayRustHubRunTaskBridgeInput,
    ): Promise<FridayRustHubRunTaskBridgeReceipt> {
      const workspaceRoot = resolve(input.workspaceRoot);
      if (!existsSync(workspaceRoot)) {
        throw unavailable("Rust hub_run_task bridge workspace root is not present.");
      }

      const adapterArgs = ["--task", input.task, "--workspace", workspaceRoot];
      if (input.dbPath) {
        adapterArgs.push("--db", resolve(input.dbPath));
      }
      if (input.runId) {
        adapterArgs.push("--run-id", input.runId);
      }
      if (typeof input.maxTurns === "number") {
        adapterArgs.push("--max-turns", String(input.maxTurns));
      }

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
            "hub_run_task",
            "--",
            ...adapterArgs,
          ];

      let stdout = "";
      try {
        const result = await execFileAsync(command, args, {
          cwd: repoRoot,
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          env: {
            ...process.env,
            RUST_BACKTRACE: "0",
          },
        });
        stdout = result.stdout;
      } catch {
        // Non-zero exit, timeout, or spawn failure → fail closed (no detail surfaced).
        throw unavailable("Rust hub_run_task bridge could not produce a refs-only receipt.");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw unavailable("Rust hub_run_task bridge returned invalid JSON.");
      }
      return parseReceipt(parsed);
    },
  };
}
