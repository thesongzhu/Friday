import type Database from "better-sqlite3";

import { FridayDomainError } from "#errors";
import {
  hashIdempotencyPayload,
  throwIdempotencyConflict,
} from "../http/routes/friday-route-idempotency.js";

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
  /**
   * (S6 mutating-chat) The run's BOUND OWNER principal — stamped onto the projected row's
   * `metadata.apiRequest.principalId` (the SAME shape the delivered idempotency stamp + the read
   * routes use) so a LATER owner-gated control op (the resume route) can match the authenticated
   * caller to the run's owner. OPTIONAL + additive: absent ⇒ no owner stamp (byte-identical to
   * today — the delivered-finished branch still stamps owner via its own idempotency merge, and a
   * sessionless/ownerless run stays ownerless). Set by the PAUSED compose branch (which previously
   * returned BEFORE any owner stamp, leaving a paused row ownerless) so a paused mutating run has a
   * real owner to authorize its resume against. NEVER the body — a principal id is a ref.
   */
  readonly ownerPrincipalId?: string;
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
 * Map a Rust `LoopStatus` debug token to a TS run status. Every GENUINELY-terminal loop
 * status maps to a terminal TS status (Finished→completed; Bounded/Blocked/Errored/default
 * →failed). The ONE exception is `Paused`: an owner-approval pause is NONTERMINAL — the run
 * is AWAITING APPROVAL, not finished — so it maps to the nonterminal `awaiting_approval`
 * (ENDBAR RUN-AWAITING-APPROVAL-001). Surfacing a paused run as `cancelled`/terminal would
 * wrongly make a resumable run look done and expose it to the terminal-only retention reaper.
 */
export function mapLoopStatusToTsStatus(loopStatus: string): string {
  switch (loopStatus) {
    case "Finished":
      return "completed";
    case "Paused":
      // Owner-approval pause: the loop stopped RESUMABLY pending approval. This is NONTERMINAL —
      // the run is awaiting approval, not cancelled/completed — so it maps to `awaiting_approval`
      // (the reaper deletes only terminal completed/failed/cancelled rows, so a paused run is
      // preserved for its later resume). NEVER a terminal cancelled here.
      return "awaiting_approval";
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
        // (S6 mutating-chat) Stamp the bound OWNER under the SAME `apiRequest.principalId` shape
        // the delivered-finished idempotency merge + the read routes use, so the resume route can
        // authorize an owner-gated control op against the run's owner. Conditional ⇒ omitted when
        // absent (byte-identical to the pre-S6 row). A principal id is a ref, never a body.
        ...(receipt.ownerPrincipalId
          ? { apiRequest: { principalId: receipt.ownerPrincipalId } }
          : {}),
      });

      // NOTE: `context_cost_summary_json` is left UNSET. That column is read via
      // `safeJsonParse<FridayAgentContextCostSummary>` ({ totalEstimatedChars,
      // totalEstimatedInputTokens, components }) — a system-prompt context-cost summary the
      // refs-only receipt does NOT carry. Writing a non-conforming shape there would be a
      // type-lie; the per-run token totals already live on usage_input/usage_output and in
      // the projected ledger row. Leave it null rather than fabricate a conforming summary.

      // A sha ref over the WHOLE refs-only receipt (never a body). Two projections of the
      // same run_id that carry the SAME receipt share this digest and stay idempotent; a
      // projection that reuses the run_id with a DIFFERENT receipt diverges here.
      const payloadDigest = hashIdempotencyPayload(receipt);

      // ── (1) ONE TS agent_run row — idempotent on run_id (PK). ──
      // INSERT OR IGNORE: a second projection of the same run_id with the SAME receipt is a
      // no-op (no dup, no throw). `create()` in the agent-run repo is a plain INSERT hardcoded
      // to 'pending', so it cannot be reused for an idempotent terminal projected row.
      //
      // Digest guard: a pre-existing row whose stored digest DIFFERS is a genuine cross-store
      // idempotency conflict (the same run_id projected from a divergent receipt), NOT a
      // replay. INSERT OR IGNORE alone would silently drop the divergent projection; instead
      // surface the SAME typed 409 the HTTP idempotency layer raises.
      const existingAgentRunDigest = db
        .prepare("SELECT payload_digest FROM friday_agent_runs WHERE id = ?")
        .get(runId) as { payload_digest: string | null } | undefined;
      if (existingAgentRunDigest) {
        if (existingAgentRunDigest.payload_digest === null) {
          // Legacy pre-v100 row (its `payload_digest` predates the digest column, so it is NULL):
          // BACKFILL the canonical digest onto the row on the FIRST digest-bearing projection so a
          // SUBSEQUENT projection of the same run_id with a DIFFERENT digest then hits the non-null
          // typed-409 branch below. Without this the null short-circuits the guard, so a divergent
          // re-projection is neither recorded nor flagged — it is silently dropped by INSERT OR
          // IGNORE (the row already exists). Scoped to `payload_digest IS NULL` so it stamps a
          // legacy row exactly once and never overwrites an already-stamped digest; atomic with the
          // conflict decision inside the caller's write transaction (composeRustReadOnlyAgentRun
          // runs project() in withWriteTransaction). Does NOT touch row content or the insert path.
          db
            .prepare("UPDATE friday_agent_runs SET payload_digest = ? WHERE id = ? AND payload_digest IS NULL")
            .run(payloadDigest, runId);
        } else if (existingAgentRunDigest.payload_digest !== payloadDigest) {
          throwIdempotencyConflict(runId, "mission_spine.rust_continuity_projection");
        }
      }

      const agentRunInsert = db
        .prepare(
          `INSERT OR IGNORE INTO friday_agent_runs (
             id, task, status, session_key, provider_id, model,
             attempt, max_attempts, created_at, started_at, completed_at,
             duration_ms, usage_input, usage_output,
             error_code, response_text, summary,
             metadata_json, payload_digest
           ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          payloadDigest,
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
      // Digest guard (companion to the agent_run guard): a pre-existing usage row for this
      // run whose stored digest DIFFERS is the same divergent-receipt conflict — surface the
      // typed 409 rather than silently dropping via INSERT OR IGNORE.
      const existingUsageDigest = db
        .prepare("SELECT payload_digest FROM llm_usage_records WHERE id = ?")
        .get(usageLedgerId) as { payload_digest: string | null } | undefined;
      if (existingUsageDigest) {
        if (existingUsageDigest.payload_digest === null) {
          // Legacy pre-v100 usage row (NULL digest): BACKFILL the canonical digest so a later
          // divergent projection conflicts (via the non-null branch below) instead of being
          // silently dropped by INSERT OR IGNORE. Companion to the agent_run backfill above;
          // `payload_digest IS NULL` keeps it a first-write-only stamp, atomic with the conflict
          // decision in the caller's transaction. Does NOT touch row content or the insert path.
          db
            .prepare("UPDATE llm_usage_records SET payload_digest = ? WHERE id = ? AND payload_digest IS NULL")
            .run(payloadDigest, usageLedgerId);
        } else if (existingUsageDigest.payload_digest !== payloadDigest) {
          throwIdempotencyConflict(runId, "mission_spine.rust_continuity_projection");
        }
      }

      const usageInsert = db
        .prepare(
          `INSERT OR IGNORE INTO llm_usage_records (
             id, occurred_at, usage_day, usage_month, provider_id, provider_kind,
             provider_api, model, route_strategy, task_complexity,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             total_tokens, cost_usd, currency, metadata_json, created_at, payload_digest
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'configured', 'medium', ?, ?, 0, 0, ?, 0, 'USD', ?, ?, ?)`,
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
          payloadDigest,
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
