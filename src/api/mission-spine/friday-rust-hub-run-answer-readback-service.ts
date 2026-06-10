import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { FridayDomainError } from "#errors";

/**
 * WIRED into the production read-only Rust agent-run route, gated DEFAULT-OFF — TS->Rust
 * OWNER-GATED ANSWER-BODY readback bridge for the S3 `hub_run_answer_readback` bin. As of
 * B1-compose this bridge IS imported + constructed by friday-api-runtime.ts and its
 * `readAnswer(...)` is the authoritative body source inside `composeRustReadOnlyAgentRun`
 * (and on the idempotency-replay branch) on the live `routeStartRun` path — so the prior
 * "no production route consumes this / registers NO production route / imported by no
 * barrel/index" claim is no longer true. It does NOT run in default prod: the route branch is
 * gated DEFAULT-OFF behind `FRIDAY_ROUTE_AGENT_RUN_VIA_RUST` (operator cutover pending) and
 * only fires for a qualifying read-only run. `rust_wired_dev` ceiling — confers no v1 GO.
 *
 * This is the OWNER-GATED BODY sibling of the REFS-ONLY
 * `friday-rust-hub-run-readback-service`, and it is deliberately a SEPARATE path: the
 * refs-only bridge STRUCTURALLY rejects any body (its `parseReceipt` 503s on
 * `task`/`final_message`/`finalMessage`), while THIS bridge's whole reason to exist is
 * to return the agent-run ANSWER BODY back to the AUTHENTICATED OWNER — the future
 * `executeRun`-replacement's owner-scoped body-return readback.
 *
 * It clones the execFile shape from `friday-rust-hub-run-readback-service` but drives
 * the owner-gated body bin: given a `runId` + a TRUSTED `callerPrincipal`, the Rust
 * primitive `friday_storage::get_run_answer_for_principal` releases the body ONLY when
 * `caller == the run's bound owner`. The bin emits one of three outcomes:
 *
 *   - `delivered` — caller IS the owner: the receipt carries the answer BODY (+ its
 *     sha256/len fingerprint + status);
 *   - `denied` — non-owner / anonymous caller / NO bound owner: NO body, only a coarse
 *     `denyReason` label (owner-free);
 *   - `not_found` — no stored result for the run: NO body.
 *
 * TRUSTED-PRINCIPAL CONTRACT (not authentication): `callerPrincipal` is passed through
 * as a TRUSTED argument. The Rust primitive enforces the ownership MATCH only; it does
 * NOT authenticate the caller. The trusted principal is now supplied by the live route's
 * compose step (`composeRustReadOnlyAgentRun` passes the normalized owner principalId as
 * `callerPrincipal`); this bridge still performs NO authentication of its own. It does not
 * (yet) replace any TS read path and confers no v1 GO; the route that drives it is gated
 * DEFAULT-OFF (operator cutover pending).
 *
 * The bridge fails CLOSED (503) on any non-zero exit, timeout, parse failure, invalid
 * shape, or any `delivered` outcome that arrives WITHOUT the body refs it claims. The
 * refs-only stdout guard and its `final_message`/`task` rejects are UNTOUCHED — the body
 * comes back ONLY through this owner-gated path.
 */
const execFileAsync = promisify(execFile);

/** The owner-gating outcome label emitted by the Rust bin. */
export type FridayRustHubRunAnswerOutcome = "delivered" | "denied" | "not_found";

/** Why an owner-gated body read was denied (owner-free, closed vocabulary). */
export type FridayRustHubRunAnswerDenyReason =
  | "no_owner_principal"
  | "anonymous_caller"
  | "principal_mismatch";

/**
 * Owner-gated answer-body receipt. The `answer` body is present ONLY when
 * `outcome === "delivered"` (caller == owner); every other outcome is body-free.
 */
export type FridayRustHubRunAnswerReadbackReceipt =
  | {
      readonly truthLabel: "rust_wired_dev";
      readonly proofOnly: true;
      readonly outcome: "delivered";
      readonly runId: string;
      readonly status: string;
      /** The OWNER-GATED answer body — released ONLY to the matching owner principal. */
      readonly answer: string;
      readonly answerSha256: string;
      readonly answerLen: number;
    }
  | {
      readonly truthLabel: "rust_wired_dev";
      readonly proofOnly: true;
      readonly outcome: "denied";
      readonly runId: string;
      /** Coarse, owner-free deny reason. NO body, NO owner principal. */
      readonly denyReason: FridayRustHubRunAnswerDenyReason;
    }
  | {
      readonly truthLabel: "rust_wired_dev";
      readonly proofOnly: true;
      readonly outcome: "not_found";
      readonly runId: string;
    };

export interface FridayRustHubRunAnswerReadbackInput {
  /** Hub DB path to read the run back from (must exist; opened read-only by the bin). */
  readonly dbPath: string;
  /** The run id whose answer body to read back. */
  readonly runId: string;
  /**
   * The TRUSTED caller principal. The Rust primitive enforces the ownership MATCH
   * (`caller == owner`); it does NOT authenticate this value (see the file header).
   */
  readonly callerPrincipal: string;
}

export interface CreateFridayRustHubRunAnswerReadbackServiceOptions {
  readonly repoRoot?: string;
  /** Path to a prebuilt `hub_run_answer_readback` binary; falls back to `cargo run --bin` when absent. */
  readonly adapterBin?: string;
  readonly timeoutMs?: number;
}

export interface FridayRustHubRunAnswerReadbackService {
  readAnswer(
    input: FridayRustHubRunAnswerReadbackInput,
  ): Promise<FridayRustHubRunAnswerReadbackReceipt>;
}

function unavailable(message: string): FridayDomainError {
  return new FridayDomainError("MISSION_SPINE_RUST_RUN_ANSWER_READBACK_UNAVAILABLE", message, {
    httpStatus: 503,
    details: {
      surface: "service:rust_hub_run_answer_readback",
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

function asIntOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const DENY_REASONS: ReadonlySet<string> = new Set([
  "no_owner_principal",
  "anonymous_caller",
  "principal_mismatch",
]);

/**
 * Validate + normalize the Rust bin's stdout into an owner-gated receipt. Fails closed on
 * any shape violation. The `answer` body is accepted ONLY inside a `delivered` outcome;
 * a `denied` / `not_found` outcome that pathologically carried a body field is rejected.
 */
function parseReceipt(payload: unknown): FridayRustHubRunAnswerReadbackReceipt {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw unavailable("Rust hub_run_answer_readback bridge returned a non-object payload.");
  }
  const root = payload as Record<string, unknown>;

  if (root.truth_label !== "rust_wired_dev") {
    throw unavailable(
      "Rust hub_run_answer_readback bridge payload is not labeled rust_wired_dev.",
    );
  }
  if (root.ok === false) {
    throw unavailable("Rust hub_run_answer_readback bridge reported a fail-closed readback.");
  }

  const runId = asString(root.run_id);
  if (!runId) {
    throw unavailable("Rust hub_run_answer_readback bridge payload is missing the run id.");
  }

  const outcome = root.outcome;

  if (outcome === "delivered") {
    const status = asString(root.status);
    const answerSha256 = asString(root.answer_sha256);
    // The owner-gated body. `answer` may legitimately be the empty string (a Finished run
    // with no final message), so it is validated as a string, not as truthy.
    const answer = root.answer;
    if (typeof answer !== "string" || !status || !answerSha256) {
      throw unavailable(
        "Rust hub_run_answer_readback bridge claimed delivered but is missing the body refs.",
      );
    }
    return {
      truthLabel: "rust_wired_dev",
      proofOnly: true,
      outcome: "delivered",
      runId,
      status,
      answer,
      answerSha256,
      answerLen: asIntOrZero(root.answer_len),
    };
  }

  if (outcome === "denied") {
    // A denied outcome is BODY-FREE: any body field is a contract violation → fail closed.
    if ("answer" in root || "task" in root || "final_message" in root || "finalMessage" in root) {
      throw unavailable(
        "Rust hub_run_answer_readback denied outcome carried a body field (rejected).",
      );
    }
    const denyReason = root.deny_reason;
    if (typeof denyReason !== "string" || !DENY_REASONS.has(denyReason)) {
      throw unavailable("Rust hub_run_answer_readback denied outcome has an invalid deny reason.");
    }
    return {
      truthLabel: "rust_wired_dev",
      proofOnly: true,
      outcome: "denied",
      runId,
      denyReason: denyReason as FridayRustHubRunAnswerDenyReason,
    };
  }

  if (outcome === "not_found") {
    if ("answer" in root || "task" in root || "final_message" in root || "finalMessage" in root) {
      throw unavailable(
        "Rust hub_run_answer_readback not_found outcome carried a body field (rejected).",
      );
    }
    return {
      truthLabel: "rust_wired_dev",
      proofOnly: true,
      outcome: "not_found",
      runId,
    };
  }

  throw unavailable("Rust hub_run_answer_readback bridge payload has an unknown outcome.");
}

export function createFridayRustHubRunAnswerReadbackService(
  options: CreateFridayRustHubRunAnswerReadbackServiceOptions = {},
): FridayRustHubRunAnswerReadbackService {
  const repoRoot = resolve(
    options.repoRoot ?? process.env.FRIDAY_REPO_ROOT ?? resolveDefaultRepoRoot(),
  );
  const rustCoreRoot = resolve(
    process.env.FRIDAY_MISSION_SPINE_RUST_CORE_ROOT ?? join(repoRoot, "rust-core"),
  );
  const adapterBin = options.adapterBin ?? process.env.FRIDAY_HUB_RUN_ANSWER_READBACK_BIN;
  const timeoutMs =
    options.timeoutMs ??
    readTimeoutMs(process.env.FRIDAY_HUB_RUN_ANSWER_READBACK_TIMEOUT_MS, 120_000);

  return {
    async readAnswer(
      input: FridayRustHubRunAnswerReadbackInput,
    ): Promise<FridayRustHubRunAnswerReadbackReceipt> {
      const dbPath = resolve(input.dbPath);
      if (!existsSync(dbPath)) {
        throw unavailable("Rust hub_run_answer_readback DB is not present for this runtime.");
      }
      if (!input.runId) {
        throw unavailable("Rust hub_run_answer_readback requires a run id.");
      }
      // A missing/empty caller principal must FAIL CLOSED here — never default to an
      // anonymous principal that the bin would then deny anyway, and never spawn without it.
      if (!input.callerPrincipal) {
        throw unavailable("Rust hub_run_answer_readback requires a caller principal.");
      }

      const adapterArgs = [
        "--db",
        dbPath,
        "--run-id",
        input.runId,
        "--caller-principal",
        input.callerPrincipal,
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
            "hub_run_answer_readback",
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
        throw unavailable(
          "Rust hub_run_answer_readback bridge could not produce an owner-gated readback.",
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw unavailable("Rust hub_run_answer_readback bridge returned invalid JSON.");
      }
      return parseReceipt(parsed);
    },
  };
}
