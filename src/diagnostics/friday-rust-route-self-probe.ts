// ─── F1.5 — Headless in-product Rust-route self-probe diagnostic (DARK, DEFAULT-OFF) ───
//
// WHAT THIS IS (read this before the reviewer reads anything else):
//   A read-only, product-purposed *self-probe* diagnostic. WHEN — and only when — an
//   operator explicitly enables it via the kill-switch env flag, it periodically lands ONE
//   qualifying read-only agent-run through the LIVE Rust read-only agent-run route, which
//   produces a REAL `token_ledger` row in rust-hub.sqlite (provider_kind='deepseek',
//   fallback=0, total_tokens>0, session_id=run_id). Its purpose is a real in-product health
//   signal: "does a non-synthetic product component still reach Rust end-to-end?" — its last
//   outcome is surfaced as a diagnostic, not discarded into a bare cron.
//
// HONEST LABELING (DO NOT upgrade this):
//   This is the OPTION-1 / H-b mechanism from TRUE_TRAFFIC_INGRESS_OPTIONS_20260610.md. It
//   earns a "recurring REAL token_ledger row" — real DeepSeek spend, real tokens — but it is
//   **WEAKLY organic (system-initiated)**, NOT strictly organic. It is the harness shape
//   reframed as a product diagnostic; it does NOT move the qualifier-breadth / transport / S6
//   gaps. NEVER report it as "organic" unqualified. (Design FACT/HONESTY-CRUX, file lines 36-52.)
//
// INGRESS = H-b ONLY (design lines 45-46, 11):
//   In-process loopback `POST http://127.0.0.1:<hubPort>/v1/agent/runs` with a self-minted
//   `admin-001` bearer — the EXACT slice6 path. It goes through the REAL HTTP + auth +
//   route-wrapper chain (clause-1 `invokedFromHttpStartRunRoute` is hardcoded-true inside
//   `routeStartRun`, reachable ONLY from this HTTP handler). It does NOT import/call
//   `routeStartRun` directly and opens NO new trust surface. H-a (a direct in-process caller
//   that asserts admin without a token) was REJECTED by the design (line 46) because it
//   creates an "assert admin without a token" surface; we do not build it.
//
// SECURITY — the self-mint is the sensitive part (scope it tightly; flag it for review):
//   `mintDiagnosticAdminBearer` hand-constructs an access-token claim set with
//   `principalId:"admin-001"` and HMAC-signs it with the hub's EXISTING `tokenSecret` via the
//   already-shipped `encodeToken` (no new secret, no new un-authed admin path). The token is:
//     • SESSIONLESS (no `sid`) — so the validator's `lookupSessionTokenState` short-circuits to
//       "active" with NO DB lookup and the mint persists NOTHING (no session row, no issued-
//       token row). This is what makes it single-use + never-persisted by construction. We do
//       NOT use the auth-service login/`generateTokenPair` path precisely because that DOES
//       persist a session + issued-token row.
//     • SHORT-LIVED (smallest viable TTL — default 60s; auth validates once at request receipt,
//       not mid-run, so 60s covers loopback + validation with margin).
//     • MINIMALLY SCOPED — only `["agent.run"]`, NOT the full admin scope set. GAP A (the Rust
//       owner-allowlist) is satisfied by `principalId==="admin-001"` ALONE; the Rust server only
//       checks principalId, never scopes. The probe never reads the ledger (the operator does,
//       via SQL), so no `agent.read`. If this token ever leaked it cannot perform admin writes.
//     • NEVER LOGGED — not in success, not in error paths, not in the last-outcome holder.
//   REVIEWER: scrutinize that this self-mint cannot be reached except from the scheduler job it
//   is colocated with — `mintDiagnosticAdminBearer` is intentionally NOT re-exported from any
//   barrel; only the bootstrap wiring + the colocated test import it. A broadly-importable
//   sessionless admin minter would re-create the H-a trust surface through a side door.
//
// KILL-SWITCH (DEFAULT-OFF):
//   The ENTIRE scheduler registration + firing is gated behind `FRIDAY_RUST_ROUTE_DIAGNOSTIC_ENABLED`.
//   Unset / anything-but-"true" ⇒ the job is NEVER built, NEVER registered, NEVER fires (mirrors
//   the `envEqualsTrue` posture in friday-capability-gates.ts). Enabling = recurring REAL DeepSeek
//   spend (operator gate; pick a low cadence). Interval is configurable via
//   `FRIDAY_RUST_ROUTE_DIAGNOSTIC_INTERVAL_MS` (default hourly, clamped to a 5-min floor); it only
//   matters when the flag is on.

import * as crypto from "node:crypto";

import { encodeToken } from "#api";
import type { FridayProviderService } from "#providers";

// The qualifying body's read-tool grant must be EXACTLY these four (clause-4). We re-declare the
// literal here (rather than import the runtime constant) to keep the diagnostic module free of a
// heavy runtime import; the colocated test asserts this set is byte-identical to the predicate's
// `RUST_ROUTE_READ_TOOL_ALLOWLIST` AND that the produced body satisfies `qualifiesForRustReadOnlyRoute`.
export const RUST_ROUTE_DIAGNOSTIC_READ_TOOLS = [
  "read_file",
  "list_dir",
  "stat_file",
  "search",
] as const;

/** DeepSeek-flash model literal — clause-3 (`model:"deepseek-v4-flash"`). */
export const RUST_ROUTE_DIAGNOSTIC_MODEL = "deepseek-v4-flash";

/** The seeded admin owner the Rust server's `--owner admin-001` allowlist requires (GAP A). */
export const RUST_ROUTE_DIAGNOSTIC_PRINCIPAL_ID = "admin-001";

/** Env flag names (documented in the module header). */
export const RUST_ROUTE_DIAGNOSTIC_ENABLED_ENV = "FRIDAY_RUST_ROUTE_DIAGNOSTIC_ENABLED";
export const RUST_ROUTE_DIAGNOSTIC_INTERVAL_ENV = "FRIDAY_RUST_ROUTE_DIAGNOSTIC_INTERVAL_MS";

/** Default cadence when enabled: hourly (low cadence per the spend heads-up). */
export const RUST_ROUTE_DIAGNOSTIC_DEFAULT_INTERVAL_MS = 3_600_000;
/** Floor on the interval so a mis-set env can never busy-spend (5 min). */
export const RUST_ROUTE_DIAGNOSTIC_MIN_INTERVAL_MS = 300_000;
/** Smallest viable bearer TTL in SECONDS (validated once at receipt; 60s covers loopback). */
export const RUST_ROUTE_DIAGNOSTIC_BEARER_TTL_SEC = 60;
/** The stable scheduler job id. */
export const RUST_ROUTE_DIAGNOSTIC_JOB_ID = "rust-route-self-probe";

// ─── Config resolution (pure) ───

export interface RustRouteDiagnosticConfig {
  enabled: boolean;
  intervalMs: number;
}

/**
 * Resolve the diagnostic's enable + interval from the environment. DEFAULT-OFF: `enabled` is
 * true ONLY when the flag is exactly the string "true" (mirrors `envEqualsTrue`). The interval
 * is clamped to a 5-min floor and is only consulted when enabled.
 */
export function resolveRustRouteDiagnosticConfig(
  env: NodeJS.ProcessEnv = process.env,
): RustRouteDiagnosticConfig {
  const enabled = env[RUST_ROUTE_DIAGNOSTIC_ENABLED_ENV] === "true";
  const raw = Number(env[RUST_ROUTE_DIAGNOSTIC_INTERVAL_ENV] ?? String(RUST_ROUTE_DIAGNOSTIC_DEFAULT_INTERVAL_MS));
  const intervalMs = Math.max(
    RUST_ROUTE_DIAGNOSTIC_MIN_INTERVAL_MS,
    Number.isFinite(raw) ? Math.trunc(raw) : RUST_ROUTE_DIAGNOSTIC_DEFAULT_INTERVAL_MS,
  );
  return { enabled, intervalMs };
}

// ─── Bearer self-mint (security-sensitive; module-private by convention) ───

/**
 * Hand-mint a SESSIONLESS, SHORT-LIVED, MINIMALLY-SCOPED `admin-001` access token signed with
 * the hub's existing `tokenSecret`. Reuses the shipped `encodeToken` (HMAC-SHA256). Persists
 * NOTHING. See the module header for the full security rationale.
 *
 * NOT re-exported from any barrel — importing this broadly would re-create the rejected H-a
 * "assert admin without a token" trust surface. Only the bootstrap wiring + the colocated test
 * import it.
 *
 * @returns the raw `Bearer`-ready token string. NEVER log it.
 */
export function mintDiagnosticAdminBearer(deps: {
  tokenSecret: string;
  nowMs: () => number;
  idGenerator: () => string;
  ttlSec?: number;
}): string {
  const ttlSec = deps.ttlSec ?? RUST_ROUTE_DIAGNOSTIC_BEARER_TTL_SEC;
  const nowSec = Math.floor(deps.nowMs() / 1000);
  // Minimal claims: admin-001 principal (GAP A), ONLY agent.run scope, sessionless (no `sid`),
  // short exp. `tokenId` is a fresh uuid never inserted into the revocation table ⇒ not revoked.
  const claims = {
    tokenId: deps.idGenerator(),
    principalType: "user" as const,
    principalId: RUST_ROUTE_DIAGNOSTIC_PRINCIPAL_ID,
    userId: RUST_ROUTE_DIAGNOSTIC_PRINCIPAL_ID,
    role: "admin" as const,
    scopes: ["agent.run" as const],
    iat: nowSec,
    exp: nowSec + ttlSec,
    // intentionally NO `sid` — keeps `lookupSessionTokenState` short-circuited to "active"
    // (no DB lookup, no persistence).
  };
  return encodeToken(claims, deps.tokenSecret);
}

// ─── Qualifying body (the FIXED slice6 shape) ───

export interface RustRouteSelfProbeBody {
  task: string;
  providerId: string;
  model: string;
  constraints: { readOnly: true };
  allowedRustRouteTools: string[];
}

/**
 * Build the EXACT qualifying body for the Rust read-only route. `providerId` MUST be the
 * RESOLVED enabled-deepseek provider id (a prod UUID; slice6 proved the literal "deepseek" is a
 * test/RGG seed shape only — on prod the row carries a UUID whose kind==="deepseek"). The caller
 * resolves it at probe time via {@link resolveEnabledDeepseekProviderId}.
 *
 * Sends NONE of: sessionKey, requireReview, planReviewOverride, taskProfile.* — every one of
 * those disqualifies. A read-only repo/config self-probe prompt; the run only reads.
 */
export function buildRustRouteSelfProbeBody(providerId: string): RustRouteSelfProbeBody {
  return {
    task:
      "Read-only self-probe: confirm the repository is reachable. "
      + "Use a read tool (e.g. list the working directory or stat a file) to confirm you can "
      + "read the repo, then reply with exactly: PROBE_OK",
    providerId,
    model: RUST_ROUTE_DIAGNOSTIC_MODEL,
    constraints: { readOnly: true },
    allowedRustRouteTools: [...RUST_ROUTE_DIAGNOSTIC_READ_TOOLS],
  };
}

/**
 * Resolve the id of the single enabled provider whose kind is "deepseek". Returns undefined when
 * none is enabled (the probe then no-ops with a clear outcome rather than firing a doomed call).
 */
export async function resolveEnabledDeepseekProviderId(
  providerService: Pick<FridayProviderService, "listProviders">,
): Promise<string | undefined> {
  const providers = await providerService.listProviders();
  return providers.find((p) => p.kind === "deepseek" && p.enabled === true)?.id;
}

// ─── Loopback transport (injected for testability — never a real call in CI) ───

export interface RustRouteLoopbackTransport {
  /**
   * Perform the loopback `POST /v1/agent/runs`. Returns the HTTP status + (optional) parsed runId.
   * The implementation MUST attach `Authorization: Bearer <bearer>` and `Content-Type:
   * application/json`. Injected so unit tests can mock it (no network in CI).
   */
  postAgentRun(input: {
    bearer: string;
    body: RustRouteSelfProbeBody;
  }): Promise<{ httpStatus: number; runId?: string }>;
}

/** Build the default loopback transport that hits the hub's bound loopback port via `fetch`. */
export function createRustRouteLoopbackTransport(deps: {
  host: string;
  port: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): RustRouteLoopbackTransport {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 120_000;
  return {
    async postAgentRun({ bearer, body }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`http://${deps.host}:${deps.port}/v1/agent/runs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Bearer is attached here and ONLY here; never logged.
            Authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        let runId: string | undefined;
        try {
          const json = (await res.json()) as { runId?: unknown; id?: unknown };
          if (typeof json.runId === "string") {
            runId = json.runId;
          } else if (typeof json.id === "string") {
            runId = json.id;
          }
        } catch {
          // Non-JSON / empty body — status alone is the outcome signal.
        }
        return { httpStatus: res.status, runId };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ─── Last-probe outcome (the in-product diagnostic surface) ───

export interface RustRouteProbeOutcome {
  /** "ok" = loopback returned 2xx; "skipped" = no enabled deepseek provider; "error" = threw / non-2xx. */
  status: "ok" | "skipped" | "error";
  /** ISO timestamp of the probe attempt. */
  at: string;
  /** HTTP status when the loopback call was made (undefined for skipped). */
  httpStatus?: number;
  /** runId echoed by the route (acceptance is the rust-hub.sqlite token_ledger row, not this). */
  runId?: string;
  /** Short human reason (never contains the bearer). */
  detail?: string;
}

/** A tiny, documented holder for the last-probe outcome (the diagnostic readback surface). */
export interface RustRouteProbeOutcomeHolder {
  get(): RustRouteProbeOutcome | undefined;
  set(outcome: RustRouteProbeOutcome): void;
}

export function createRustRouteProbeOutcomeHolder(): RustRouteProbeOutcomeHolder {
  let last: RustRouteProbeOutcome | undefined;
  return {
    get: () => last,
    set: (outcome) => {
      last = outcome;
    },
  };
}

// ─── The probe runner (one tick) ───

export interface RustRouteSelfProbeDeps {
  tokenSecret: string;
  nowIso: () => string;
  idGenerator: () => string;
  providerService: Pick<FridayProviderService, "listProviders">;
  transport: RustRouteLoopbackTransport;
  outcomeHolder: RustRouteProbeOutcomeHolder;
  /** Injected logger (defaults to console). NEVER receives the bearer. */
  logger?: Pick<Console, "warn" | "info">;
  ttlSec?: number;
}

/**
 * Run ONE probe tick: resolve the enabled deepseek provider → mint a fresh short-lived bearer →
 * loopback POST the fixed qualifying body → record the outcome. LOG-AND-CONTINUE on any failure
 * (never throws) so the recurring scheduler job cannot become a crash/fail-loop. The terminal
 * acceptance (a real token_ledger row) is verified out-of-band by the operator via SQL.
 */
export async function runRustRouteSelfProbe(deps: RustRouteSelfProbeDeps): Promise<RustRouteProbeOutcome> {
  const logger = deps.logger ?? console;
  const at = deps.nowIso();
  try {
    const providerId = await resolveEnabledDeepseekProviderId(deps.providerService);
    if (!providerId) {
      const outcome: RustRouteProbeOutcome = {
        status: "skipped",
        at,
        detail: "no enabled deepseek provider; probe skipped",
      };
      deps.outcomeHolder.set(outcome);
      logger.info?.(`[friday][rust-route-self-probe] ${outcome.detail}`);
      return outcome;
    }

    // Mint a fresh bearer PER PROBE (single-use). Never logged.
    const bearer = mintDiagnosticAdminBearer({
      tokenSecret: deps.tokenSecret,
      nowMs: () => new Date(deps.nowIso()).getTime(),
      idGenerator: deps.idGenerator,
      ttlSec: deps.ttlSec,
    });
    const body = buildRustRouteSelfProbeBody(providerId);
    const { httpStatus, runId } = await deps.transport.postAgentRun({ bearer, body });

    const ok = httpStatus >= 200 && httpStatus < 300;
    const outcome: RustRouteProbeOutcome = {
      status: ok ? "ok" : "error",
      at,
      httpStatus,
      runId,
      detail: ok
        ? "loopback agent-run accepted; verify the real token_ledger row in rust-hub.sqlite"
        : `loopback agent-run returned HTTP ${httpStatus}`,
    };
    deps.outcomeHolder.set(outcome);
    if (ok) {
      logger.info?.(
        `[friday][rust-route-self-probe] ${outcome.detail}${runId ? ` (runId=${runId})` : ""}`,
      );
    } else {
      logger.warn?.(`[friday][rust-route-self-probe] ${outcome.detail}`);
    }
    return outcome;
  } catch (err) {
    // LOG-AND-CONTINUE: never crash the scheduler loop. Error message is from our own code /
    // fetch, never the bearer.
    const detail = err instanceof Error ? err.message : String(err);
    const outcome: RustRouteProbeOutcome = { status: "error", at, detail };
    deps.outcomeHolder.set(outcome);
    logger.warn?.(`[friday][rust-route-self-probe] probe failed (log-and-continue): ${detail}`);
    return outcome;
  }
}

// ─── Scheduler job builder (pure; off ⇒ null) ───

export interface RustRouteSelfProbeJob {
  id: string;
  intervalMs: number;
  timeoutMs: number;
  catchUpRuns: number;
  run: () => Promise<unknown>;
}

/**
 * Build the scheduler job definition for the self-probe — or `null` when the kill-switch is off.
 * Pure + DI'd so the bootstrap wiring stays a one-liner and the off→null / on→def behavior is
 * unit-testable without booting the hub.
 *
 * IMPORTANT: when `config.enabled` is false this returns `null` ⇒ the bootstrap never pushes a
 * job ⇒ the scheduler never registers it ⇒ it NEVER fires. DEFAULT-OFF by construction.
 */
export function maybeBuildRustRouteSelfProbeJob(
  config: RustRouteDiagnosticConfig,
  probeDeps: RustRouteSelfProbeDeps,
): RustRouteSelfProbeJob | null {
  if (!config.enabled) {
    return null;
  }
  return {
    id: RUST_ROUTE_DIAGNOSTIC_JOB_ID,
    intervalMs: config.intervalMs,
    // The real run can take ~20s (slice6: 19s). Generous timeout; still well under the
    // scheduler default. catchUpRuns:1 — never burst multiple real (spending) runs on startup.
    timeoutMs: 120_000,
    catchUpRuns: 1,
    // log-and-continue: runRustRouteSelfProbe never throws, so a failed probe is recorded and the
    // recurring job survives (no crash/fail-loop). Reuses the scheduler's own backoff for the
    // pathological case where the run handler itself somehow rejects.
    run: async () => runRustRouteSelfProbe(probeDeps),
  };
}
