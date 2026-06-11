import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { FridayDomainError } from "#errors";

/**
 * TS->Rust REFS-ONLY bridge for the merged `hub_providers_detect` bin (#591/#639).
 * It surfaces the (now 503) `providers.detect` onboarding question — "which provider
 * CLIs report themselves installed + logged-in?" — at the Rust layer by spawning the
 * bin and parsing its refs-only JSON.
 *
 * It clones the read-only execFile shape from
 * `friday-rust-hub-run-readback-service` / `friday-rust-hub-run-answer-readback-service`.
 * It is DARK: the route that drives it (`providers.detect` in friday-setup-routes.ts)
 * only consults this bridge when the cut-over flag `FRIDAY_ROUTE_PROVIDERS_VIA_RUST`
 * is ON; with the flag OFF the route stays byte-identical to today's fail-closed 503.
 * It registers no production route on its own and confers no v1 GO.
 *
 * ## SURFACE-SHAPE NOTE (deliberate, not a fabrication)
 * The legacy TS `providers.detect` is a BYOK probe (apiKey/kind/baseUrl ->
 * provider /v1/models -> availableModels/validated). `hub_providers_detect` answers
 * a DIFFERENT question: the codex/claude CLI login status, with input `--probe
 * codex|claude|both` (default `both`). When the flag is ON the route returns THIS
 * refs-only payload — it does NOT synthesize the old BYOK fields. That contract change
 * is surfaced (PR body + operator question), not blind-filled.
 *
 * ## Output contract — REFS ONLY (no bodies, no secrets, no account info)
 * The bin emits ONLY secret-safe fields (it strips raw CLI stdout/stderr and runs its
 * own `reject_forbidden_output` guard before printing). This bridge re-validates the
 * shape and fails CLOSED (503) on any non-zero exit, timeout, parse failure, wrong
 * truth label, `ok:false`, or invalid shape.
 *
 * NEITHER bin takes `--db` — this bridge spawns with `--probe <selection>` only (no
 * `existsSync(dbPath)` guard, unlike the run-readback siblings which read a hub DB).
 */
const execFileAsync = promisify(execFile);

/** Provider selection the bin understands (`--probe` value). Default `both`. */
export type FridayRustProvidersDetectProbe = "codex" | "claude" | "both";

/** One per-provider refs-only detection entry — the four safe fields ONLY. */
export interface FridayRustProvidersDetectEntry {
  /** Safe provider label (`codex` | `claude`). */
  readonly provider: string;
  readonly installed: boolean;
  readonly authenticated: boolean;
  /** Coarse static detail: `logged_in` | `not_logged_in` | `not_installed`. */
  readonly detail: string;
}

/** Refs-only providers-detect receipt — no bodies, no secrets, no account info. */
export interface FridayRustProvidersDetectReceipt {
  /** The bin's truth label — proof/dev tier, NOT a product/proven receipt. */
  readonly truthLabel: "rust_providers_detect";
  /** Always true — a loud reminder this is a dev bridge, not a product path. */
  readonly proofOnly: true;
  /** Per-provider detection entries (provider label + booleans + static detail). */
  readonly detected: readonly FridayRustProvidersDetectEntry[];
  /** Safe labels of providers that are installed AND authenticated (no fallback). */
  readonly readyProviders: readonly string[];
  /** Aggregate onboarding-readiness booleans (provider labels + booleans only). */
  readonly anyAuthenticated: boolean;
  readonly allAuthenticated: boolean;
}

export interface FridayRustProvidersDetectInput {
  /** Which provider CLIs to probe. Defaults to `both` when omitted. */
  readonly probe?: FridayRustProvidersDetectProbe;
}

export interface CreateFridayRustHubProvidersDetectServiceOptions {
  readonly repoRoot?: string;
  /** Path to a prebuilt `hub_providers_detect` binary; falls back to `cargo run --bin` when absent. */
  readonly adapterBin?: string;
  readonly timeoutMs?: number;
}

export interface FridayRustHubProvidersDetectService {
  detect(input?: FridayRustProvidersDetectInput): Promise<FridayRustProvidersDetectReceipt>;
}

function unavailable(message: string): FridayDomainError {
  return new FridayDomainError("MISSION_SPINE_RUST_PROVIDERS_DETECT_UNAVAILABLE", message, {
    httpStatus: 503,
    details: {
      surface: "service:rust_hub_providers_detect",
      bridge: "rust_providers_detect",
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

const VALID_PROBES: ReadonlySet<string> = new Set(["codex", "claude", "both"]);

/**
 * Validate + normalize one per-provider entry. Accepts ONLY the four safe fields,
 * fails closed on a missing/mis-typed field, and rejects any raw-stream field name as
 * a defensive backstop (the bin already strips them).
 */
function parseEntry(value: unknown): FridayRustProvidersDetectEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw unavailable("Rust hub_providers_detect entry is not an object.");
  }
  const entry = value as Record<string, unknown>;
  if ("stdout" in entry || "stderr" in entry) {
    throw unavailable("Rust hub_providers_detect entry carried a raw CLI stream field (rejected).");
  }
  const provider = entry.provider;
  const installed = entry.installed;
  const authenticated = entry.authenticated;
  const detail = entry.detail;
  if (
    typeof provider !== "string" ||
    provider.length === 0 ||
    typeof installed !== "boolean" ||
    typeof authenticated !== "boolean" ||
    typeof detail !== "string" ||
    detail.length === 0
  ) {
    throw unavailable("Rust hub_providers_detect entry has an invalid shape.");
  }
  return { provider, installed, authenticated, detail };
}

/**
 * Validate + normalize the bin's refs-only stdout into a receipt. Fails closed on any
 * shape violation. Mirrors the readback siblings' defensive parsing.
 */
function parseReceipt(payload: unknown): FridayRustProvidersDetectReceipt {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw unavailable("Rust hub_providers_detect bridge returned a non-object payload.");
  }
  const root = payload as Record<string, unknown>;

  if (root.truth_label !== "rust_providers_detect") {
    throw unavailable("Rust hub_providers_detect bridge payload is not labeled rust_providers_detect.");
  }
  if (root.ok === false) {
    throw unavailable("Rust hub_providers_detect bridge reported a fail-closed detect.");
  }

  const detectedRaw = root.detected;
  if (!Array.isArray(detectedRaw)) {
    throw unavailable("Rust hub_providers_detect bridge payload is missing the detected array.");
  }
  const detected = detectedRaw.map(parseEntry);

  const readyRaw = root.ready_providers;
  if (!Array.isArray(readyRaw) || !readyRaw.every((p) => typeof p === "string")) {
    throw unavailable("Rust hub_providers_detect bridge payload has an invalid ready_providers list.");
  }
  const readyProviders = readyRaw as string[];

  if (typeof root.any_authenticated !== "boolean" || typeof root.all_authenticated !== "boolean") {
    throw unavailable("Rust hub_providers_detect bridge payload is missing the readiness booleans.");
  }

  return {
    truthLabel: "rust_providers_detect",
    proofOnly: true,
    detected,
    readyProviders,
    anyAuthenticated: root.any_authenticated,
    allAuthenticated: root.all_authenticated,
  };
}

export function createFridayRustHubProvidersDetectService(
  options: CreateFridayRustHubProvidersDetectServiceOptions = {},
): FridayRustHubProvidersDetectService {
  const repoRoot = resolve(
    options.repoRoot ?? process.env.FRIDAY_REPO_ROOT ?? resolveDefaultRepoRoot(),
  );
  const rustCoreRoot = resolve(
    process.env.FRIDAY_MISSION_SPINE_RUST_CORE_ROOT ?? join(repoRoot, "rust-core"),
  );
  const adapterBin = options.adapterBin ?? process.env.FRIDAY_HUB_PROVIDERS_DETECT_BIN;
  const timeoutMs =
    options.timeoutMs ?? readTimeoutMs(process.env.FRIDAY_HUB_PROVIDERS_DETECT_TIMEOUT_MS, 120_000);

  // One-time loud warning when the cargo-run fallback (compiles in the request hot
  // path) is taken — mirrors the run-answer-readback sibling.
  let warnedCargoFallback = false;

  return {
    async detect(
      input: FridayRustProvidersDetectInput = {},
    ): Promise<FridayRustProvidersDetectReceipt> {
      const probe = input.probe ?? "both";
      // Defensive: only the closed vocabulary the bin accepts may be passed; anything
      // else would `bad_args`/exit 2 the bin anyway → fail closed before spawning.
      if (!VALID_PROBES.has(probe)) {
        throw unavailable("Rust hub_providers_detect received an unsupported probe selection.");
      }

      const adapterArgs = ["--probe", probe];

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
            "hub_providers_detect",
            "--",
            ...adapterArgs,
          ];
      if (!adapterBin && !warnedCargoFallback) {
        warnedCargoFallback = true;
        console.warn(
          "[friday][rust-providers-detect] FRIDAY_HUB_PROVIDERS_DETECT_BIN is not set — " +
            "falling back to `cargo run` in the request hot path (compiles per cold start; " +
            "adds latency and a failure surface). Set it to a prebuilt hub_providers_detect " +
            "binary at deploy time.",
        );
      }

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
        throw unavailable("Rust hub_providers_detect bridge could not produce a refs-only detect.");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw unavailable("Rust hub_providers_detect bridge returned invalid JSON.");
      }
      return parseReceipt(parsed);
    },
  };
}
