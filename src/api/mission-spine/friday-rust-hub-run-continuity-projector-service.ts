import type Database from "better-sqlite3";

import { FridayDomainError } from "#errors";

/**
 * WIRED into the production read-only Rust agent-run route (`routeStartRun` →
 * `composeRustReadOnlyAgentRun` in friday-api-runtime.ts) as of B1-compose — this is the
 * `projector` passed to compose and its `project(...)` runs on the live route path. NOT yet
 * live in default prod: that route is GATED DEFAULT-OFF (`FRIDAY_ROUTE_AGENT_RUN_VIA_RUST`,
 * operator cutover pending). Rust→TS CONTINUITY PROJECTOR for the `executeRun`-replacement
 * (executeRun-replace slice 2, fork ii). `rust_wired_dev` ceiling — narrow (read-only /
 * refs-only, no fabricated token totals); NOT a full executeRun replacement; confers no v1 GO.
 *
 * ## Why this exists
 * The executeRun-replacement routes production agent-runs through the Rust Hub loop.
 * The Rust loop writes its OWN narrow Hub SQLite (`agent_run` = run_id/task/state/
 * created_at/updated_at, the answer body in a separate result store) and its OWN
 * `token_ledger` (`bill_model_call`). But the TS READ surface (getRun/listRuns) and the
 * TS usage/cost ledger (`llm_usage_records`, read by `querySummary`) speak the RICH TS
 * `friday_agent_runs` schema. So when a Rust run completes, SOMETHING must make it
 * VISIBLE + BILLED on the TS side.
 *
 * The operator's fork decision (ii): a TS-side PROJECTOR reads a Rust run RECEIPT and
 * writes the TS continuity rows — NOT Rust writing directly into TS tables. This file is
 * that projector.
 *
 * ## Truth labels (read before trusting this)
 * - **WIRED into the production route handler, gated DEFAULT-OFF.** As of B1-compose this
 *   projector IS imported + constructed by friday-api-runtime.ts and its `project(...)` runs
 *   inside `composeRustReadOnlyAgentRun` on the live `routeStartRun` path — so the prior
 *   "no production route consumes this / unreferenced by any barrel/route" claim is no longer
 *   true. It does NOT execute in default prod: the route branch is gated DEFAULT-OFF behind
 *   `FRIDAY_ROUTE_AGENT_RUN_VIA_RUST` (operator cutover pending), and even when on it only
 *   fires for a qualifying read-only Rust run. In tests it is also driven by a STATIC FIXTURE
 *   receipt.
 * - **`rust_wired` ceiling**: this projects a Rust-produced receipt; it is NOT a full product
 *   path and confers no v1 GO.
 * - **Usage token source wiring is DEFERRED to the composition slice.** This dark slice
 *   models the receipt as ALREADY carrying the token totals as a fixture field
 *   ({@link FridayRustHubRunReceipt.usagePromptTokens} / `usageCompletionTokens` /
 *   `usageTotalTokens}`). In production those totals live in the Rust `token_ledger`
 *   (`bill_model_call`); plumbing the real Rust token source onto the receipt is the
 *   composition slice's job, NOT this slice's.
 *
 * ## Hard contracts enforced here (the load-bearing invariants)
 * 1. **No double-count** — the projector is the SOLE TS-VISIBLE usage writer per Rust
 *    run. It writes EXACTLY ONE `llm_usage_records` row per run, keyed on a PK
 *    DETERMINISTICALLY derived from `run_id` ({@link usageLedgerIdForRun}). The Rust-side
 *    `bill_model_call`/`token_ledger` row stays Rust-internal; the TS cost READ route
 *    (`querySummary`) reads this projected row, never re-deriving usage from the receipt.
 *    Re-projecting the same `run_id` adds NO second ledger row.
 * 2. **Idempotent on run_id** — both writes are `INSERT … ON CONFLICT DO NOTHING`
 *    keyed on a deterministic PK (`friday_agent_runs.id` = `run_id`;
 *    `llm_usage_records.id` = {@link usageLedgerIdForRun}). Projecting the same receipt
 *    twice yields the SAME single set of rows.
 * 3. **No body** — the projected row NEVER carries the answer body. `task` is a
 *    non-body placeholder, `responseText` is a body REF (the receipt's
 *    `finalMessageSha256` + len), never the body text. The body stays owner-gated
 *    (slice 3).
 */

/**
 * A completed Rust run RECEIPT, REFS-ONLY (no body, no secrets, no PII).
 *
 * This mirrors the `hub_run_task` Rust bin's refs-only stdout
 * (rust-core/crates/friday-hub/src/bin/hub_run_task.rs) and ADDITIONALLY models the
 * per-run token totals as fixture fields — see the file header: wiring the real Rust
 * `token_ledger` (`bill_model_call`) source onto these fields is the composition slice's
 * job, deferred here.
 */
export interface FridayRustHubRunReceipt {
  /** Always the dev tier — this is NOT a product/proven receipt. */
  readonly truthLabel: "rust_wired_dev";
  /** Always true — a loud reminder this is a dev bridge, not a product path. */
  readonly proofOnly: true;
  readonly ok: true;
  readonly runId: string;
  /** Non-secret composite of provider + model (`provider_id:model`). */
  readonly routeId: string;
  readonly providerId: string;
  readonly model: string;
  /** Debug-formatted model size token from the Rust selection (e.g. `Flash`). */
  readonly modelSize?: string;
  /** Debug-formatted backend kind from the Rust selection (e.g. `Http`). */
  readonly backendKind?: string;
  /**
   * Debug-formatted Rust `LoopStatus` (`Finished` | `Errored` | `Bounded` | `Paused`
   * | `Blocked`). Mapped to a terminal TS run status by {@link mapLoopStatusToTsStatus}.
   */
  readonly loopStatus: string;
  /** Bounded refs-only error category when the loop errored, else `null`/omitted. */
  readonly errorCategory?: string | null;
  readonly turns: number;
  readonly executedTools: number;
  /** sha256 of the answer body — a REF, NEVER the body text. */
  readonly finalMessageSha256: string;
  /** Length (bytes) of the answer body — a measure, NEVER the body text. */
  readonly finalMessageLen: number;
  readonly auditChainVerified: boolean;
  /**
   * Per-run prompt token total. FIXTURE field for this dark slice — in production this
   * comes from the Rust `token_ledger` (`bill_model_call`); see file header.
   */
  readonly usagePromptTokens: number;
  /** Per-run completion token total. FIXTURE field — see {@link usagePromptTokens}. */
  readonly usageCompletionTokens: number;
  /** Per-run total tokens. FIXTURE field — see {@link usagePromptTokens}. */
  readonly usageTotalTokens: number;
  /** ISO timestamp the Rust run completed (drives the TS continuity timestamps). */
  readonly completedAtIso: string;
}

/** What the projector wrote/found (refs-only — no body). */
export interface FridayRustHubRunProjectionResult {
  readonly runId: string;
  /** The TS `friday_agent_runs.id` (== `run_id`). */
  readonly agentRunId: string;
  /** The deterministic `llm_usage_records.id` for this run. */
  readonly usageLedgerId: string;
  /** Terminal TS run status the loop status mapped to. */
  readonly status: string;
  /** True when THIS call inserted the agent_run row (false ⇒ already present). */
  readonly insertedAgentRun: boolean;
  /** True when THIS call inserted the usage ledger row (false ⇒ already present). */
  readonly insertedUsageLedger: boolean;
}

export interface FridayRustHubRunContinuityProjectorService {
  /**
   * Project a completed Rust run receipt onto the TS continuity surfaces. Idempotent on
   * `run_id`: a second call with the same receipt makes no second row. Body-free.
   */
  project(
    db: Database.Database,
    receipt: FridayRustHubRunReceipt,
  ): FridayRustHubRunProjectionResult;
}

/**
 * The DETERMINISTIC primary key for this run's TS usage-ledger row. `llm_usage_records`
 * has NO `run_id` column, so a deterministic PK derived from `run_id` is the SOLE dedup
 * mechanism that enforces the no-double-count invariant — a random id would silently add
 * a second ledger row on re-projection. The `run_id` is ALSO stashed in `metadata_json`
 * for traceability, but the PK is what guarantees one-row-per-run.
 */
export function usageLedgerIdForRun(runId: string): string {
  return `rust-continuity-usage:${runId}`;
}

/**
 * Map a Rust `LoopStatus` debug token to a TERMINAL TS run status. The TS projection is
 * a completed Rust run, so only terminal statuses are produced (never an active one).
 */
export function mapLoopStatusToTsStatus(loopStatus: string): string {
  switch (loopStatus) {
    case "Finished":
      return "completed";
    case "Paused":
      // Owner-approval pause: the loop stopped resumably, but the projected TS row is a
      // terminal snapshot of THIS receipt — surface it as cancelled (non-error stop).
      return "cancelled";
    case "Bounded":
      // max_turns reached without finishing — an incomplete terminal stop.
      return "failed";
    case "Blocked":
    case "Errored":
    default:
      return "failed";
  }
}

/** Reject a receipt that carries (or smuggles) a raw body. Fails closed (500). */
function rejectBodyBearingReceipt(receipt: FridayRustHubRunReceipt): void {
  const root = receipt as unknown as Record<string, unknown>;
  if ("task" in root || "final_message" in root || "finalMessage" in root) {
    throw new FridayDomainError(
      "MISSION_SPINE_RUST_CONTINUITY_BODY_REJECTED",
      "Rust run receipt carried a raw body — refused to project.",
      {
        httpStatus: 500,
        details: {
          surface: "service:rust_hub_run_continuity_projector",
          bridge: "rust_wired_dev",
          proofOnly: true,
        },
      },
    );
  }
}

/**
 * Render the body REF stored in `responseText`. NEVER the body — only the receipt's
 * sha256 fingerprint + byte length, which the owner-gated slice-3 readback can later
 * resolve to the real answer for the bound owner.
 */
function bodyRefFromReceipt(receipt: FridayRustHubRunReceipt): string {
  return `rust-run-body-ref:sha256=${receipt.finalMessageSha256};len=${receipt.finalMessageLen}`;
}

export function createFridayRustHubRunContinuityProjectorService(): FridayRustHubRunContinuityProjectorService {
  return {
    project(db, receipt) {
      if (receipt.truthLabel !== "rust_wired_dev") {
        throw new FridayDomainError(
          "MISSION_SPINE_RUST_CONTINUITY_NOT_DEV",
          "Rust run receipt is not labeled rust_wired_dev — refused to project.",
          { httpStatus: 500 },
        );
      }
      rejectBodyBearingReceipt(receipt);

      const runId = receipt.runId;
      if (!runId) {
        throw new FridayDomainError(
          "MISSION_SPINE_RUST_CONTINUITY_MISSING_RUN_ID",
          "Rust run receipt is missing a run id — refused to project.",
          { httpStatus: 500 },
        );
      }

      const status = mapLoopStatusToTsStatus(receipt.loopStatus);
      const usageLedgerId = usageLedgerIdForRun(runId);
      const completedAtIso = receipt.completedAtIso;
      // Synthesize a deterministic session key — the refs-only receipt carries none.
      const sessionKey = `rust-projection:${runId}`;
      // `task` is NOT NULL and body-class: NEVER the real task text. A fixed placeholder.
      const taskPlaceholder = "[rust-projected run]";
      const responseTextRef = bodyRefFromReceipt(receipt);
      const summary = `Projected Rust run (${receipt.loopStatus}) — refs-only, body owner-gated.`;
      const errorCode = status === "completed" ? null : (receipt.errorCategory ?? "rust_loop_non_finished");

      // Continuity telemetry that fits the existing `metadata_json` (an open JSON column).
      // We do NOT widen the typed FridayAgentRunMetadata interface — these refs live as
      // JSON only, alongside the `surface` label the typed interface already carries.
      const metadataJson = JSON.stringify({
        surface: "rust_continuity_projection",
        rustContinuity: {
          truthLabel: receipt.truthLabel,
          routeId: receipt.routeId,
          loopStatus: receipt.loopStatus,
          turns: receipt.turns,
          executedTools: receipt.executedTools,
          auditChainVerified: receipt.auditChainVerified,
          finalMessageSha256: receipt.finalMessageSha256,
          finalMessageLen: receipt.finalMessageLen,
          ...(receipt.errorCategory ? { errorCategory: receipt.errorCategory } : {}),
        },
      });

      // NOTE: `context_cost_summary_json` is left UNSET. That column is read via
      // `safeJsonParse<FridayAgentContextCostSummary>` ({ totalEstimatedChars,
      // totalEstimatedInputTokens, components }) — a system-prompt context-cost summary the
      // refs-only receipt does NOT carry. Writing a non-conforming shape there would be a
      // type-lie; the per-run token totals already live on usage_input/usage_output and in
      // the projected ledger row. Leave it null rather than fabricate a conforming summary.

      // ── (1) ONE TS agent_run row — idempotent on run_id (PK). ──
      // INSERT OR IGNORE: a second projection of the same run_id is a no-op (no dup, no
      // throw). `create()` in the agent-run repo is a plain INSERT hardcoded to
      // 'pending', so it cannot be reused for an idempotent terminal projected row.
      const agentRunInsert = db
        .prepare(
          `INSERT OR IGNORE INTO friday_agent_runs (
             id, task, status, session_key, provider_id, model,
             attempt, max_attempts, created_at, started_at, completed_at,
             duration_ms, usage_input, usage_output,
             error_code, response_text, summary,
             metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          taskPlaceholder,
          status,
          sessionKey,
          receipt.providerId,
          receipt.model,
          completedAtIso,
          completedAtIso,
          completedAtIso,
          // duration_ms: 0 PLACEHOLDER — the refs-only receipt carries `completedAtIso`
          // but NO start time, so a real duration is not derivable here.
          0,
          receipt.usagePromptTokens,
          receipt.usageCompletionTokens,
          errorCode,
          responseTextRef,
          summary,
          metadataJson,
        );

      // ── (2) ONE TS-visible usage/cost ledger row — idempotent + no double-count. ──
      // Deterministic PK derived from run_id is the ONLY dedup key (`llm_usage_records`
      // has no run_id column). INSERT OR IGNORE ⇒ exactly one ledger row per run, even on
      // re-projection. This projected row is the SOLE TS-visible usage write for the run;
      // the Rust-side bill_model_call/token_ledger row stays Rust-internal and the TS cost
      // read route (querySummary) reads THIS row, never re-deriving from the receipt.
      const usageDay = completedAtIso.slice(0, 10);
      const usageMonth = completedAtIso.slice(0, 7);
      const usageMetadataJson = JSON.stringify({
        source: "rust_continuity_projection",
        runId,
        routeId: receipt.routeId,
        // Truth signal: cost was NOT resolved from a pricing catalog here (token source
        // wiring is deferred), so pricing is unresolved by definition.
        pricingResolved: false,
      });
      const usageInsert = db
        .prepare(
          `INSERT OR IGNORE INTO llm_usage_records (
             id, occurred_at, usage_day, usage_month, provider_id, provider_kind,
             provider_api, model, route_strategy, task_complexity,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             total_tokens, cost_usd, currency, metadata_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'configured', 'medium', ?, ?, 0, 0, ?, 0, 'USD', ?, ?)`,
        )
        .run(
          usageLedgerId,
          completedAtIso,
          usageDay,
          usageMonth,
          receipt.providerId,
          // provider_kind: the receipt carries a provider_id, not a typed kind — record
          // the honest "unknown" rather than fabricating a kind attribution.
          "unknown",
          // provider_api: DeepSeek (the Rust loop's only provider) speaks the
          // openai-completions wire API.
          "openai-completions",
          receipt.model,
          receipt.usagePromptTokens,
          receipt.usageCompletionTokens,
          receipt.usageTotalTokens,
          usageMetadataJson,
          completedAtIso,
        );

      return {
        runId,
        agentRunId: runId,
        usageLedgerId,
        status,
        insertedAgentRun: agentRunInsert.changes > 0,
        insertedUsageLedger: usageInsert.changes > 0,
      };
    },
  };
}
