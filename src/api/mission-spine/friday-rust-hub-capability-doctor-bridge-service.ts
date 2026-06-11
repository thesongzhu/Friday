import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { FridayDomainError } from "#errors";

/**
 * TS->Rust REFS-ONLY bridge for the merged `hub_capability_doctor` bin (#658). It
 * surfaces the (now 503) `providers.doctor` / `providers.validate` / `capabilities.doctor`
 * surfaces at the Rust layer by spawning the bin and parsing its refs-only JSON.
 *
 * It clones the read-only execFile shape from the run-readback siblings. It is DARK:
 * the routes that drive it (`providers.doctor`/`providers.validate`/`capabilities.doctor`
 * in friday-provider-routes.ts) consult this bridge ONLY when the cut-over flag
 * `FRIDAY_ROUTE_PROVIDERS_VIA_RUST` is ON; with the flag OFF those routes stay
 * byte-identical to today's fail-closed 503. It registers no production route on its
 * own and confers no v1 GO.
 *
 * ## QUOTA SAFETY — the key posture
 * The bin's live key-validation arm spends LIVE Anthropic quota (~1-2 tokens) on a
 * minimal `POST /v1/messages max_tokens=1`. That arm runs ONLY when the bin is passed
 * `--validate-keys`. This bridge passes `--validate-keys` ONLY when the caller sets
 * `input.validateKeys === true` (operator-gated). The DEFAULT (`validateKeys`
 * unset/false) runs the ZERO-quota CLI-detect-only path; the key section comes back
 * honestly `null` / not-probed (NOT a fabricated all-missing).
 *
 * ## SURFACE-SHAPE NOTE (deliberate, not a fabrication)
 * The legacy TS `providers.validate`/`providers.doctor` are per-`:providerId` probes;
 * `capabilities.doctor` accepts a providerIds filter. `hub_capability_doctor` has NO
 * providerId input — it is a fixed codex/claude (CLI) + deepseek/anthropic (key)
 * doctor. When the flag is ON the routes return THIS refs-only composite — they do NOT
 * synthesize the old per-providerId shapes. That contract change is surfaced (PR body +
 * operator question), not blind-filled.
 *
 * ## Output contract — REFS ONLY (no bodies, no secrets, no account info)
 * The bin emits ONLY secret-safe fields (strips raw CLI stdout/stderr; the key
 * outcomes are already coarse label/status; runs its own `reject_forbidden_output`
 * guard before printing). This bridge re-validates the shape and fails CLOSED (503) on
 * any non-zero exit, timeout, parse failure, wrong truth label, `ok:false`, or invalid
 * shape.
 *
 * NEITHER bin takes `--db` — this bridge spawns with (at most) `--validate-keys` only.
 */
const execFileAsync = promisify(execFile);

/** One per-CLI-provider refs-only detection entry — the four safe fields ONLY. */
export interface FridayRustCapabilityCliEntry {
  /** Safe provider label (`codex` | `claude`). */
  readonly provider: string;
  readonly installed: boolean;
  readonly authenticated: boolean;
  /** Coarse static detail: `logged_in` | `not_logged_in` | `not_installed`. */
  readonly detail: string;
}

/** One per-credential refs-only key-validation entry — the coarse safe fields ONLY. */
export interface FridayRustCapabilityKeyEntry {
  /** Safe credential label (`deepseek` | `anthropic`). */
  readonly provider: string;
  /** Coarse outcome label: `valid` | `invalid` | `unavailable` | `credential_missing`. */
  readonly label: string;
  /** Coarse HTTP status (present only for `invalid`); otherwise null. */
  readonly status: number | null;
  /** Coarse static detail (present only for `unavailable`); otherwise null. */
  readonly detail: string | null;
}

/** Refs-only capability-doctor receipt — no bodies, no secrets, no account info. */
export interface FridayRustCapabilityDoctorReceipt {
  /** The bin's truth label — proof/dev tier, NOT a product/proven receipt. */
  readonly truthLabel: "rust_capability_doctor";
  /** Always true — a loud reminder this is a dev bridge, not a product path. */
  readonly proofOnly: true;
  /** CLI-detect section: per-provider entries (the codex/claude login question). */
  readonly cliDetected: readonly FridayRustCapabilityCliEntry[];
  /** Safe labels of the CLI providers reporting logged-in (no fallback). */
  readonly cliLoggedIn: readonly string[];
  /** True iff `--validate-keys` was passed (the live, quota-spending arm ran). */
  readonly keyValidationProbed: boolean;
  /**
   * Live key-validation section, present ONLY when probed; `null` (honest absence)
   * when the zero-quota default path ran.
   */
  readonly keyValidation: readonly FridayRustCapabilityKeyEntry[] | null;
  /**
   * Credentials a live round-trip CONFIRMED valid (only `valid` counts); `null` when
   * not probed.
   */
  readonly confirmedValidKeys: readonly string[] | null;
}

export interface FridayRustCapabilityDoctorInput {
  /**
   * Run the LIVE key-validation arm (`--validate-keys`). DEFAULT false (zero quota).
   * Setting true spends ~1-2 live Anthropic tokens — operator-gated at the call site.
   */
  readonly validateKeys?: boolean;
}

export interface CreateFridayRustHubCapabilityDoctorServiceOptions {
  readonly repoRoot?: string;
  /** Path to a prebuilt `hub_capability_doctor` binary; falls back to `cargo run --bin` when absent. */
  readonly adapterBin?: string;
  readonly timeoutMs?: number;
}

export interface FridayRustHubCapabilityDoctorService {
  doctor(input?: FridayRustCapabilityDoctorInput): Promise<FridayRustCapabilityDoctorReceipt>;
}

function unavailable(message: string): FridayDomainError {
  return new FridayDomainError("MISSION_SPINE_RUST_CAPABILITY_DOCTOR_UNAVAILABLE", message, {
    httpStatus: 503,
    details: {
      surface: "service:rust_hub_capability_doctor",
      bridge: "rust_capability_doctor",
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

const KEY_LABELS: ReadonlySet<string> = new Set([
  "valid",
  "invalid",
  "unavailable",
  "credential_missing",
]);

/** Validate + normalize one CLI-detect entry. Fails closed on any shape violation. */
function parseCliEntry(value: unknown): FridayRustCapabilityCliEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw unavailable("Rust hub_capability_doctor cli entry is not an object.");
  }
  const entry = value as Record<string, unknown>;
  if ("stdout" in entry || "stderr" in entry) {
    throw unavailable("Rust hub_capability_doctor cli entry carried a raw CLI stream field (rejected).");
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
    throw unavailable("Rust hub_capability_doctor cli entry has an invalid shape.");
  }
  return { provider, installed, authenticated, detail };
}

/** Validate + normalize one key-validation entry. Fails closed on any shape violation. */
function parseKeyEntry(value: unknown): FridayRustCapabilityKeyEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw unavailable("Rust hub_capability_doctor key entry is not an object.");
  }
  const entry = value as Record<string, unknown>;
  const provider = entry.provider;
  const label = entry.label;
  if (
    typeof provider !== "string" ||
    provider.length === 0 ||
    typeof label !== "string" ||
    !KEY_LABELS.has(label)
  ) {
    throw unavailable("Rust hub_capability_doctor key entry has an invalid shape.");
  }
  // `status` is a coarse HTTP code on `invalid`, else null/absent; `detail` is a coarse
  // static label on `unavailable`, else null/absent. Both validated permissively as
  // (number|null) / (string|null) — never a body.
  const statusRaw = entry.status;
  const status =
    typeof statusRaw === "number" && Number.isFinite(statusRaw) ? statusRaw : null;
  const detailRaw = entry.detail;
  const detail = typeof detailRaw === "string" && detailRaw.length > 0 ? detailRaw : null;
  return { provider, label, status, detail };
}

/**
 * Validate + normalize the bin's refs-only stdout into a receipt. Fails closed on any
 * shape violation. Enforces the bin's honesty contract: the key section is present iff
 * `key_validation_probed` is true (and `null` otherwise).
 */
function parseReceipt(payload: unknown): FridayRustCapabilityDoctorReceipt {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw unavailable("Rust hub_capability_doctor bridge returned a non-object payload.");
  }
  const root = payload as Record<string, unknown>;

  if (root.truth_label !== "rust_capability_doctor") {
    throw unavailable("Rust hub_capability_doctor bridge payload is not labeled rust_capability_doctor.");
  }
  if (root.ok === false) {
    throw unavailable("Rust hub_capability_doctor bridge reported a fail-closed doctor.");
  }

  const cliRaw = root.cli_detected;
  if (!Array.isArray(cliRaw)) {
    throw unavailable("Rust hub_capability_doctor bridge payload is missing the cli_detected array.");
  }
  const cliDetected = cliRaw.map(parseCliEntry);

  const loggedInRaw = root.cli_logged_in;
  if (!Array.isArray(loggedInRaw) || !loggedInRaw.every((p) => typeof p === "string")) {
    throw unavailable("Rust hub_capability_doctor bridge payload has an invalid cli_logged_in list.");
  }
  const cliLoggedIn = loggedInRaw as string[];

  const keyValidationProbed = root.key_validation_probed;
  if (typeof keyValidationProbed !== "boolean") {
    throw unavailable("Rust hub_capability_doctor bridge payload is missing key_validation_probed.");
  }

  if (keyValidationProbed) {
    const keyRaw = root.key_validation;
    if (!Array.isArray(keyRaw)) {
      throw unavailable(
        "Rust hub_capability_doctor bridge claimed probed keys but is missing the key_validation array.",
      );
    }
    const keyValidation = keyRaw.map(parseKeyEntry);
    const confirmedRaw = root.confirmed_valid_keys;
    if (!Array.isArray(confirmedRaw) || !confirmedRaw.every((p) => typeof p === "string")) {
      throw unavailable(
        "Rust hub_capability_doctor bridge probed keys but has an invalid confirmed_valid_keys list.",
      );
    }
    return {
      truthLabel: "rust_capability_doctor",
      proofOnly: true,
      cliDetected,
      cliLoggedIn,
      keyValidationProbed: true,
      keyValidation,
      confirmedValidKeys: confirmedRaw as string[],
    };
  }

  // NOT probed: the key section MUST be the honest null (never a fabricated array).
  if (root.key_validation !== null && root.key_validation !== undefined) {
    throw unavailable(
      "Rust hub_capability_doctor reported not-probed but carried a non-null key section (rejected).",
    );
  }
  return {
    truthLabel: "rust_capability_doctor",
    proofOnly: true,
    cliDetected,
    cliLoggedIn,
    keyValidationProbed: false,
    keyValidation: null,
    confirmedValidKeys: null,
  };
}

export function createFridayRustHubCapabilityDoctorService(
  options: CreateFridayRustHubCapabilityDoctorServiceOptions = {},
): FridayRustHubCapabilityDoctorService {
  const repoRoot = resolve(
    options.repoRoot ?? process.env.FRIDAY_REPO_ROOT ?? resolveDefaultRepoRoot(),
  );
  const rustCoreRoot = resolve(
    process.env.FRIDAY_MISSION_SPINE_RUST_CORE_ROOT ?? join(repoRoot, "rust-core"),
  );
  const adapterBin = options.adapterBin ?? process.env.FRIDAY_HUB_CAPABILITY_DOCTOR_BIN;
  const timeoutMs =
    options.timeoutMs ?? readTimeoutMs(process.env.FRIDAY_HUB_CAPABILITY_DOCTOR_TIMEOUT_MS, 120_000);

  let warnedCargoFallback = false;

  return {
    async doctor(
      input: FridayRustCapabilityDoctorInput = {},
    ): Promise<FridayRustCapabilityDoctorReceipt> {
      // QUOTA GATE: pass `--validate-keys` ONLY on an explicit true. Any other value
      // (false/undefined) runs the bin's zero-quota CLI-detect-only default.
      const validateKeys = input.validateKeys === true;
      const adapterArgs = validateKeys ? ["--validate-keys"] : [];

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
            "hub_capability_doctor",
            "--",
            ...adapterArgs,
          ];
      if (!adapterBin && !warnedCargoFallback) {
        warnedCargoFallback = true;
        console.warn(
          "[friday][rust-capability-doctor] FRIDAY_HUB_CAPABILITY_DOCTOR_BIN is not set — " +
            "falling back to `cargo run` in the request hot path (compiles per cold start; " +
            "adds latency and a failure surface). Set it to a prebuilt hub_capability_doctor " +
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
        throw unavailable("Rust hub_capability_doctor bridge could not produce a refs-only doctor.");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw unavailable("Rust hub_capability_doctor bridge returned invalid JSON.");
      }
      return parseReceipt(parsed);
    },
  };
}
