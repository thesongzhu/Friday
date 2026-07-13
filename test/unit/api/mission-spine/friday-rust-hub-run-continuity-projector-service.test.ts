import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { createFridayAgentRunRepository } from "#agent";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayRustHubRunContinuityProjectorService,
  usageLedgerIdForRun,
  mapLoopStatusToTsStatus,
  type FridayRustHubRunReceipt,
} from "../../../../src/api/mission-spine/friday-rust-hub-run-continuity-projector-service.js";

// A STATIC FIXTURE Rust run receipt — this slice is DARK/fixture-driven: no production
// route produces or consumes it. Refs-only: it carries the answer body sha256/len, NEVER
// the body text.
const FIXTURE_RECEIPT: FridayRustHubRunReceipt = {
  truthLabel: "rust_wired_dev",
  proofOnly: true,
  ok: true,
  runId: "hub_run_task_dev_42_1717800000000000000",
  routeId: "deepseek:deepseek-v4-flash",
  providerId: "deepseek",
  model: "deepseek-v4-flash",
  modelSize: "Flash",
  backendKind: "Http",
  loopStatus: "Finished",
  errorCategory: null,
  turns: 3,
  executedTools: 2,
  finalMessageSha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", // pragma: allowlist secret
  finalMessageLen: 128,
  auditChainVerified: true,
  usagePromptTokens: 1500,
  usageCompletionTokens: 420,
  usageTotalTokens: 1920,
  completedAtIso: "2026-06-08T12:00:00.000Z",
};

interface AgentRunRow {
  id: string;
  task: string;
  status: string;
  session_key: string;
  provider_id: string | null;
  model: string | null;
  usage_input: number | null;
  usage_output: number | null;
  response_text: string | null;
  summary: string | null;
  metadata_json: string | null;
  context_cost_summary_json: string | null;
}

function countAgentRuns(db: Database.Database, runId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM friday_agent_runs WHERE id = ?").get(runId) as { n: number }).n;
}

function countUsageRows(db: Database.Database, usageId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM llm_usage_records WHERE id = ?").get(usageId) as { n: number }).n;
}

describe("FridayRustHubRunContinuityProjector (executeRun-replace slice 2, fork ii, dark)", () => {
  const layers: ReturnType<typeof createTestDb>[] = [];

  function freshDb(): Database.Database {
    const layer = createTestDb();
    layers.push(layer);
    return layer.writer;
  }

  afterEach(() => {
    for (const layer of layers) {
      try {
        layer.close();
      } catch {
        // no-op
      }
    }
    layers.length = 0;
  });

  it("loop-status → TS status mapping: Paused is the NONTERMINAL awaiting_approval, the rest terminal", () => {
    expect(mapLoopStatusToTsStatus("Finished")).toBe("completed");
    // ENDBAR RUN-AWAITING-APPROVAL-001: an owner-approval pause is NONTERMINAL — the run is
    // awaiting approval, not cancelled/terminal. It must map to `awaiting_approval`.
    expect(mapLoopStatusToTsStatus("Paused")).toBe("awaiting_approval");
    expect(mapLoopStatusToTsStatus("Bounded")).toBe("failed");
    expect(mapLoopStatusToTsStatus("Blocked")).toBe("failed");
    expect(mapLoopStatusToTsStatus("Errored")).toBe("failed");
    // Paused must NOT be a terminal status (negative_control: Paused appears cancelled/terminal ⇒ fail).
    // The reaper deletes only these terminal states — awaiting_approval must be none of them.
    expect(["completed", "failed", "cancelled"]).not.toContain(mapLoopStatusToTsStatus("Paused"));
    // Every GENUINELY-terminal loop status still maps to a terminal TS status (no-degrade).
    for (const s of ["Finished", "Bounded", "Blocked", "Errored", "anything"]) {
      expect(["completed", "failed", "cancelled"]).toContain(mapLoopStatusToTsStatus(s));
    }
  });

  it("projects a Paused receipt to a NONTERMINAL awaiting_approval row that the reaper never deletes", () => {
    const db = freshDb();
    const projector = createFridayRustHubRunContinuityProjectorService();

    const paused: FridayRustHubRunReceipt = {
      ...FIXTURE_RECEIPT,
      runId: "hub_run_task_dev_paused_approval",
      loopStatus: "Paused",
    };
    const result = projector.project(db, paused);
    // ENDBAR RUN-AWAITING-APPROVAL-001: the projected status is the NONTERMINAL awaiting_approval,
    // never a terminal cancelled/completed/failed.
    expect(result.status).toBe("awaiting_approval");

    const run = db
      .prepare("SELECT status FROM friday_agent_runs WHERE id = ?")
      .get(paused.runId) as { status: string };
    expect(run.status).toBe("awaiting_approval");

    // The retention reaper deletes ONLY terminal rows (`status IN ('completed','failed','cancelled')`).
    // A run awaiting approval must be OUTSIDE that set — otherwise a resumable run would be reaped.
    const reaped = db
      .prepare(
        "SELECT COUNT(*) AS n FROM friday_agent_runs WHERE id = ? AND status IN ('completed','failed','cancelled')",
      )
      .get(paused.runId) as { n: number };
    expect(reaped.n).toBe(0);
  });

  it("projects ONE agent_run + ONE usage row with the correct Rust→TS column mapping", () => {
    const db = freshDb();
    const projector = createFridayRustHubRunContinuityProjectorService();

    const result = projector.project(db, FIXTURE_RECEIPT);
    expect(result.insertedAgentRun).toBe(true);
    expect(result.insertedUsageLedger).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.agentRunId).toBe(FIXTURE_RECEIPT.runId);
    expect(result.usageLedgerId).toBe(usageLedgerIdForRun(FIXTURE_RECEIPT.runId));

    // Exactly one agent_run row.
    expect(countAgentRuns(db, FIXTURE_RECEIPT.runId)).toBe(1);
    const run = db
      .prepare("SELECT * FROM friday_agent_runs WHERE id = ?")
      .get(FIXTURE_RECEIPT.runId) as AgentRunRow;
    expect(run.status).toBe("completed");
    expect(run.session_key).toBe(`rust-projection:${FIXTURE_RECEIPT.runId}`);
    expect(run.provider_id).toBe("deepseek");
    expect(run.model).toBe("deepseek-v4-flash");
    // The per-run mirror onto the agent_run row matches the receipt totals.
    expect(run.usage_input).toBe(1500);
    expect(run.usage_output).toBe(420);

    // Exactly one ledger row, keyed on the deterministic run-derived PK.
    const usageId = usageLedgerIdForRun(FIXTURE_RECEIPT.runId);
    expect(countUsageRows(db, usageId)).toBe(1);
    const usage = db
      .prepare("SELECT * FROM llm_usage_records WHERE id = ?")
      .get(usageId) as {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      provider_id: string;
      provider_api: string;
      route_strategy: string;
      task_complexity: string;
      model: string;
    };
    // Usage totals MATCH the receipt — no double-count, no re-derivation.
    expect(usage.input_tokens).toBe(1500);
    expect(usage.output_tokens).toBe(420);
    expect(usage.total_tokens).toBe(1920);
    expect(usage.provider_id).toBe("deepseek");
    expect(usage.provider_api).toBe("openai-completions");
    expect(usage.route_strategy).toBe("configured");
    expect(usage.task_complexity).toBe("medium");
    expect(usage.model).toBe("deepseek-v4-flash");
  });

  it("is idempotent on run_id — re-projecting adds NO second agent_run or usage row", () => {
    const db = freshDb();
    const projector = createFridayRustHubRunContinuityProjectorService();
    const usageId = usageLedgerIdForRun(FIXTURE_RECEIPT.runId);

    const first = projector.project(db, FIXTURE_RECEIPT);
    expect(first.insertedAgentRun).toBe(true);
    expect(first.insertedUsageLedger).toBe(true);

    // Re-project the SAME receipt — must NOT throw and must be a no-op insert.
    const second = projector.project(db, FIXTURE_RECEIPT);
    expect(second.insertedAgentRun).toBe(false);
    expect(second.insertedUsageLedger).toBe(false);

    // Still exactly one row in EACH surface.
    expect(countAgentRuns(db, FIXTURE_RECEIPT.runId)).toBe(1);
    expect(countUsageRows(db, usageId)).toBe(1);

    // And the SOLE ledger row's totals are unchanged (no additive double-count).
    const total = db
      .prepare("SELECT SUM(total_tokens) AS t FROM llm_usage_records WHERE id = ?")
      .get(usageId) as { t: number };
    expect(total.t).toBe(1920);
  });

  it("is the SOLE TS-visible usage writer per run — one ledger row across the whole table", () => {
    const db = freshDb();
    const projector = createFridayRustHubRunContinuityProjectorService();

    projector.project(db, FIXTURE_RECEIPT);
    projector.project(db, FIXTURE_RECEIPT);
    projector.project(db, FIXTURE_RECEIPT);

    // The cost READ route (querySummary) reads llm_usage_records; assert the WHOLE table
    // has exactly one row for this run — the no-double-count invariant at the read surface.
    const all = db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total_tokens), 0) AS t FROM llm_usage_records")
      .get() as { n: number; t: number };
    expect(all.n).toBe(1);
    expect(all.t).toBe(1920);
  });

  it("getRun (repository getById) and listRuns (list) read the projected row back", () => {
    const db = freshDb();
    const projector = createFridayRustHubRunContinuityProjectorService();
    projector.project(db, FIXTURE_RECEIPT);

    const repo = createFridayAgentRunRepository();

    // getRun path.
    const got = repo.getById(db, FIXTURE_RECEIPT.runId);
    expect(got).not.toBeNull();
    expect(got?.id).toBe(FIXTURE_RECEIPT.runId);
    expect(got?.status).toBe("completed");
    expect(got?.usageInput).toBe(1500);
    expect(got?.usageOutput).toBe(420);

    // listRuns path.
    const listed = repo.list(db, { limit: 50 });
    expect(listed.some((r) => r.id === FIXTURE_RECEIPT.runId)).toBe(true);
  });

  it("(S6 mutating-chat) an ownerPrincipalId receipt round-trips to metadata.apiRequest.principalId through the REAL read path", () => {
    // This pins the seam the resume route's owner-binding gate depends on: a paused projection
    // stamps the bound owner, and the SAME repository read the route uses (getById → rowToRecord →
    // parseRunMetadata) must deserialize it back to `record.metadata.apiRequest.principalId`. A
    // PARTIAL `apiRequest` (only `principalId`) must survive — `parseRunMetadata` does no schema
    // strip — so the route has a real owner to authorize the resume against (a regression here would
    // 403 EVERY legitimate resume in prod while every mocked test stayed green).
    const db = freshDb();
    const projector = createFridayRustHubRunContinuityProjectorService();
    projector.project(db, { ...FIXTURE_RECEIPT, runId: "owned-paused-run", ownerPrincipalId: "owner:alice" });

    const repo = createFridayAgentRunRepository();
    const got = repo.getById(db, "owned-paused-run");
    expect(got).not.toBeNull();
    expect(got?.metadata?.apiRequest?.principalId).toBe("owner:alice");

    // A receipt WITHOUT an owner stamps NO apiRequest (byte-identical to the pre-S6 row).
    projector.project(db, { ...FIXTURE_RECEIPT, runId: "unowned-run" });
    const unowned = repo.getById(db, "unowned-run");
    expect(unowned?.metadata?.apiRequest).toBeUndefined();
  });

  it("the projected row carries NO answer body — responseText is a ref, never the body", () => {
    const db = freshDb();
    const projector = createFridayRustHubRunContinuityProjectorService();
    projector.project(db, FIXTURE_RECEIPT);

    const run = db
      .prepare("SELECT * FROM friday_agent_runs WHERE id = ?")
      .get(FIXTURE_RECEIPT.runId) as AgentRunRow;

    // task is a non-body placeholder — NEVER the real task text.
    expect(run.task).toBe("[rust-projected run]");

    // responseText is a body REF (sha256 + len), never the body.
    expect(run.response_text).toContain("rust-run-body-ref");
    expect(run.response_text).toContain(FIXTURE_RECEIPT.finalMessageSha256);
    expect(run.response_text).toContain(String(FIXTURE_RECEIPT.finalMessageLen));

    // No column in the projected row carries a `final_message`/body field, and the metadata
    // carries only refs (sha/len), not the body text.
    const serialized = JSON.stringify(run);
    expect(serialized).not.toContain("final_message\"");
    expect(serialized).not.toContain("finalMessage\"");
  });

  it("maps a non-Finished receipt to a terminal failed status with an error code", () => {
    const db = freshDb();
    const projector = createFridayRustHubRunContinuityProjectorService();

    const errored: FridayRustHubRunReceipt = {
      ...FIXTURE_RECEIPT,
      runId: "hub_run_task_dev_99_errored",
      loopStatus: "Errored",
      errorCategory: "provider_http_error",
    };
    const result = projector.project(db, errored);
    expect(result.status).toBe("failed");

    const run = db
      .prepare("SELECT status, error_code FROM friday_agent_runs WHERE id = ?")
      .get(errored.runId) as { status: string; error_code: string | null };
    expect(run.status).toBe("failed");
    expect(run.error_code).toBe("provider_http_error");
  });

  it("refuses to project a receipt that smuggles a raw body (fails closed)", () => {
    const db = freshDb();
    const projector = createFridayRustHubRunContinuityProjectorService();

    const bodyBearing = {
      ...FIXTURE_RECEIPT,
      runId: "hub_run_task_dev_body_smuggle",
      // A smuggled raw body field that must never be projected.
      final_message: "the secret answer body",
    } as unknown as FridayRustHubRunReceipt;

    expect(() => projector.project(db, bodyBearing)).toThrow();
    // Nothing was written — fail-closed leaves no partial rows.
    expect(countAgentRuns(db, "hub_run_task_dev_body_smuggle")).toBe(0);
  });
});
