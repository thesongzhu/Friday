import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { FridayDomainError } from "#errors";

/**
 * PROOF-ONLY (Rust-wired-DEV) TS->Rust READ bridge for the S2 `hub_run_readback`
 * read-bridge. The read-only sibling of the S0 `hub_run_task` write bridge: it lets
 * the TS side SEE a completed Rust run's result by `run_id`, refs-only.
 *
 * It clones the READ-ONLY execFile shape from
 * `friday-rust-hub-workbench-projection-service` / `friday-rust-hub-run-task-bridge-service`
 * to prove a Rust run's outcome can be projected to TS WITHOUT ever transporting a
 * body/secret/PII. It is NOT a replacement for any TS run-result read path, registers
 * NO production route, and confers no v1 GO.
 *
 * Every value it returns is REFS-ONLY: the run id + a `state` label (NEVER the run
 * `task` text), timestamps, a derived loop-status label, turn/tool counts, the ordered
 * list of event `kind` strings, and the audit-chain-verified bool. The bridge fails
 * CLOSED (503) on any non-zero exit, timeout, parse failure, invalid shape, or any
 * payload that carries a raw run/message body (the boundary this slice exists to prove).
 *
 * Token totals are surfaced as `dbWideToken*` and are DB-WIDE, NOT run-attributable
 * (the agent loop does not ledger tokens, and `token_ledger` has no `run_id`).
 */
const execFileAsync = promisify(execFile);

/** Refs-only readback receipt — no run/message body, no secrets, no PII. */
export interface FridayRustHubRunReadbackReceipt {
  /** Always the dev tier — this is NOT a product/proven receipt. */
  readonly truthLabel: "rust_wired_dev";
  /** Always true — a loud reminder this is a dev bridge, not a product path. */
  readonly proofOnly: true;
  readonly runId: string;
  /** The persisted PlanState label (e.g. `awaiting_clarification`) — NOT the task text. */
  readonly runState: string;
  readonly createdAtMs?: number;
  readonly updatedAtMs?: number;
  /**
   * Coarse loop-status label DERIVED from the event log by the Rust bin (one of
   * `finished` | `errored` | `bounded` | `paused` | `blocked` | `no_events` |
   * `in_progress`). Reconstructed from terminal markers; never a raw event slice.
   */
  readonly loopStatusDerived?: string;
  readonly turnCount: number;
  readonly executedToolCount: number;
  readonly eventCount: number;
  /**
   * The ORDERED list of event `kind` strings (`plan.none`, `agent.finished`, ...).
   * These are safe labels; a `tool.executed:` kind may embed a RELATIVE filename
   * (accepted). The Rust bin already fails closed on any absolute-path/secret marker
   * before emitting, and this service re-checks the no-body boundary defensively.
   */
  readonly eventKinds: readonly string[];
  readonly auditChainVerified: boolean;
  /** DB-wide token totals (NOT run-attributable — see the file header). */
  readonly dbWideTokenPromptTotal: number;
  readonly dbWideTokenCompletionTotal: number;
  readonly dbWideTokenTotal: number;
}

export interface FridayRustHubRunReadbackInput {
  /** Hub DB path to read the run back from (must exist; opened read-only by the bin). */
  readonly dbPath: string;
  /** The run id to read back. */
  readonly runId: string;
}

export interface CreateFridayRustHubRunReadbackServiceOptions {
  readonly repoRoot?: string;
  /** Path to a prebuilt `hub_run_readback` binary; falls back to `cargo run --bin` when absent. */
  readonly adapterBin?: string;
  readonly timeoutMs?: number;
}

export interface FridayRustHubRunReadbackService {
  readRun(input: FridayRustHubRunReadbackInput): Promise<FridayRustHubRunReadbackReceipt>;
}

function unavailable(message: string): FridayDomainError {
  return new FridayDomainError("MISSION_SPINE_RUST_RUN_READBACK_UNAVAILABLE", message, {
    httpStatus: 503,
    details: {
      surface: "service:rust_hub_run_readback",
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

function asIntOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Validate + normalize the Rust bin's refs-only stdout into a receipt. Fails closed on
 * any shape violation AND on any attempt to carry a raw run/message body (the boundary
 * this slice exists to prove).
 */
function parseReceipt(payload: unknown): FridayRustHubRunReadbackReceipt {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw unavailable("Rust hub_run_readback bridge returned a non-object payload.");
  }
  const root = payload as Record<string, unknown>;

  // Hard boundary: a run/message body must NEVER cross the bridge — only labels/refs may.
  if ("task" in root || "final_message" in root || "finalMessage" in root) {
    throw unavailable("Rust hub_run_readback bridge payload carried a raw body (rejected).");
  }
  if (root.truth_label !== "rust_wired_dev") {
    throw unavailable("Rust hub_run_readback bridge payload is not labeled rust_wired_dev.");
  }
  if (root.ok === false) {
    throw unavailable("Rust hub_run_readback bridge reported a fail-closed readback.");
  }

  const runId = asString(root.run_id);
  const runState = asString(root.run_state);
  const auditChainVerified = root.audit_chain_verified;
  const eventKindsRaw = root.event_kinds;

  if (!runId || !runState) {
    throw unavailable("Rust hub_run_readback bridge payload is missing required refs.");
  }
  if (typeof auditChainVerified !== "boolean") {
    throw unavailable("Rust hub_run_readback bridge payload is missing audit_chain_verified.");
  }
  if (!Array.isArray(eventKindsRaw) || !eventKindsRaw.every((kind) => typeof kind === "string")) {
    throw unavailable("Rust hub_run_readback bridge payload has an invalid event_kinds list.");
  }
  const eventKinds = eventKindsRaw as string[];

  return {
    truthLabel: "rust_wired_dev",
    proofOnly: true,
    runId,
    runState,
    createdAtMs: asNumber(root.created_at_ms),
    updatedAtMs: asNumber(root.updated_at_ms),
    loopStatusDerived: asString(root.loop_status_derived),
    turnCount: asIntOrZero(root.turn_count),
    executedToolCount: asIntOrZero(root.executed_tool_count),
    eventCount: asIntOrZero(root.event_count),
    eventKinds,
    auditChainVerified,
    dbWideTokenPromptTotal: asIntOrZero(root.db_wide_token_prompt_total),
    dbWideTokenCompletionTotal: asIntOrZero(root.db_wide_token_completion_total),
    dbWideTokenTotal: asIntOrZero(root.db_wide_token_total),
  };
}

export function createFridayRustHubRunReadbackService(
  options: CreateFridayRustHubRunReadbackServiceOptions = {},
): FridayRustHubRunReadbackService {
  const repoRoot = resolve(
    options.repoRoot ?? process.env.FRIDAY_REPO_ROOT ?? resolveDefaultRepoRoot(),
  );
  const rustCoreRoot = resolve(
    process.env.FRIDAY_MISSION_SPINE_RUST_CORE_ROOT ?? join(repoRoot, "rust-core"),
  );
  const adapterBin = options.adapterBin ?? process.env.FRIDAY_HUB_RUN_READBACK_BIN;
  const timeoutMs =
    options.timeoutMs ?? readTimeoutMs(process.env.FRIDAY_HUB_RUN_READBACK_TIMEOUT_MS, 120_000);

  return {
    async readRun(
      input: FridayRustHubRunReadbackInput,
    ): Promise<FridayRustHubRunReadbackReceipt> {
      const dbPath = resolve(input.dbPath);
      if (!existsSync(dbPath)) {
        throw unavailable("Rust hub_run_readback DB is not present for this runtime.");
      }
      if (!input.runId) {
        throw unavailable("Rust hub_run_readback requires a run id.");
      }

      const adapterArgs = ["--db", dbPath, "--run-id", input.runId];

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
            "hub_run_readback",
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
        throw unavailable("Rust hub_run_readback bridge could not produce a refs-only readback.");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw unavailable("Rust hub_run_readback bridge returned invalid JSON.");
      }
      return parseReceipt(parsed);
    },
  };
}
