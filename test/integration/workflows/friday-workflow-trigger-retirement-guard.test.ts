import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayWorkflowRuntime,
  createFridayWorkflowTriggerRepository,
} from "#workflows";
import type {
  FridayWorkflowRuntime,
  FridayWorkflowTriggerRepository,
  FridayCompiledWorkflowGraphV2,
} from "#workflows";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";

/**
 * Phase 3 guard-placement fix (POST_TS_RECONCILIATION_LEDGER §1).
 *
 * TS Runtime Retirement was ROUTE-only: POST /v1/workflow-runs fails closed at the
 * HTTP route wrapper, but the underlying `workflowExecution.startRun` METHOD had no
 * retirement guard. Non-route callers — the default-on 60s cron scheduler, webhook
 * ingress, event ingress, and direct manual fire — reach `startRun` directly,
 * bypassing the route guard.
 *
 * These tests prove the guard now lives on the METHOD: in default/live config
 * (test-oracle flag unset) every non-route trigger vector fails closed and creates
 * NO workflow_runs row — even when a valid published, triggered workflow exists
 * (the exact §1 firing condition). With the explicit test-oracle flag enabled, the
 * legacy path still works (so existing harnesses are preserved).
 */

const NOW = "2026-02-18T10:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z"; // ensures cron registration is "due" at NOW
const RETIRED_CODE = "TS_RUNTIME_WORKFLOW_RUNS_RETIRED";
const WEBHOOK_TOKEN = "tok_phase3_guard_placement_webhook_token_value";
const WEBHOOK_SECRET_REF = "ref://workflow-webhook-secret"; // pragma: allowlist secret
const WEBHOOK_SECRET = "phase3-guard-placement-webhook-shared-secret"; // pragma: allowlist secret

function makeGraph(
  workflowId: string,
  versionId: string,
): FridayCompiledWorkflowGraphV2 {
  return {
    schemaVersion: "2.0",
    workflowId,
    workflowVersionId: versionId,
    sourceSpecSchemaVersion: "1.0",
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", label: "Trigger", config: {} },
        {
          id: "action1",
          type: "action",
          label: "Action 1",
          config: { skillId: "test-skill" },
        },
      ],
      edges: [{ id: "e1", sourceNodeId: "trigger", targetNodeId: "action1" }],
    },
    failurePolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    checksum: "placeholder",
  };
}

describe("Workflow trigger/scheduler retirement guard (method-level, §1)", () => {
  let db: FridaySqliteLayer;
  let triggerRepo: FridayWorkflowTriggerRepository;
  let invokeSkill: ReturnType<typeof vi.fn>;

  function buildRuntime(opts: { allowTestOnly: boolean }): FridayWorkflowRuntime {
    return createFridayWorkflowRuntime({
      // The whole point of §1: production leaves this unset → method fail-closed.
      ...(opts.allowTestOnly ? { allowTestOnlyWorkflowRunExecution: true } : {}),
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      computeChecksum: (content: string) =>
        createHash("sha256").update(content).digest("hex"),
      resolveSkill: () => ({ id: "test-skill" }),
      invokeSkill,
      triggerRepo,
      resolveWebhookSecretRef: (ref: string) =>
        ref === WEBHOOK_SECRET_REF ? WEBHOOK_SECRET : null,
    });
  }

  function publishWorkflow(runtime: FridayWorkflowRuntime, slug: string): {
    workflowId: string;
    versionId: string;
  } {
    const wf = runtime.crud.createWorkflow({ slug, name: slug });
    const version = runtime.crud.createVersion(wf.id, makeGraph(wf.id, "placeholder"));
    runtime.crud.publishVersion(wf.id, version.versionNumber);
    return { workflowId: wf.id, versionId: version.id };
  }

  function persistCronReg(workflowId: string, versionId: string): void {
    triggerRepo.upsertManyForVersion([
      {
        id: `cron-${workflowId}`,
        workflowId,
        workflowVersionId: versionId,
        triggerNodeId: "trigger",
        triggerType: "cron",
        enabled: true,
        cronExpression: "* * * * *",
        dedupeWindowSec: 0,
        nextFireAt: PAST,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
  }

  function persistEventReg(workflowId: string, versionId: string): void {
    triggerRepo.upsertManyForVersion([
      {
        id: `event-${workflowId}`,
        workflowId,
        workflowVersionId: versionId,
        triggerNodeId: "trigger",
        triggerType: "event",
        enabled: true,
        eventSource: "sys",
        eventName: "thing.happened",
        dedupeWindowSec: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
  }

  function persistWebhookReg(workflowId: string, versionId: string): void {
    triggerRepo.upsertManyForVersion([
      {
        id: `webhook-${workflowId}`,
        workflowId,
        workflowVersionId: versionId,
        triggerNodeId: "trigger",
        triggerType: "webhook",
        enabled: true,
        webhookPathToken: WEBHOOK_TOKEN,
        webhookSecretRef: WEBHOOK_SECRET_REF,
        dedupeWindowSec: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
  }

  function signedWebhookInput() {
    const body = { hello: "world" };
    const rawBody = JSON.stringify(body);
    const signature =
      "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
    return {
      pathToken: WEBHOOK_TOKEN,
      body,
      rawBody,
      headers: { "x-hub-signature-256": signature },
    };
  }

  function runRowCount(): number {
    return db.withReadConnection(
      (conn) =>
        (conn.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get() as { n: number }).n,
    );
  }

  beforeEach(() => {
    db = createTestDb();
    triggerRepo = createFridayWorkflowTriggerRepository({ db });
    invokeSkill = vi.fn().mockResolvedValue({ result: "ok" });
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    db.close();
  });

  // ─── Default/live config (flag unset): every non-route vector fails closed ───

  describe("default config (test-oracle flag UNSET) — fail closed, no mutation", () => {
    it("direct startRun method throws retired error and creates NO run row", async () => {
      const runtime = buildRuntime({ allowTestOnly: false });
      const { workflowId, versionId } = publishWorkflow(runtime, "direct-wf");

      await expect(
        runtime.execution.startRun({
          workflowId,
          workflowVersionId: versionId,
          triggerType: "manual",
        }),
      ).rejects.toMatchObject({ code: RETIRED_CODE });

      expect(runRowCount()).toBe(0);
      expect(runtime.execution.listActiveRuns()).toHaveLength(0);
    });

    it("cron scheduler tick (the default-on 60s path) starts 0 runs and creates NO run row even with a due, published, triggered workflow", async () => {
      const runtime = buildRuntime({ allowTestOnly: false });
      const { workflowId, versionId } = publishWorkflow(runtime, "cron-wf");
      persistCronReg(workflowId, versionId);

      const started = await runtime.triggers.tickCron(NOW);

      expect(started).toBe(0);
      expect(runRowCount()).toBe(0);
    });

    it("event ingress (DB handleEvent + in-memory matchEvent) starts 0 runs and creates NO run row", async () => {
      const runtime = buildRuntime({ allowTestOnly: false });
      const { workflowId, versionId } = publishWorkflow(runtime, "event-wf");
      persistEventReg(workflowId, versionId);
      runtime.triggers.register(workflowId, versionId, {
        type: "event",
        source: "sys",
        event: "thing.happened",
      });

      const dbStarted = await runtime.triggers.handleEvent({
        source: "sys",
        event: "thing.happened",
        payload: { itemId: "1" },
      });
      const inMemRunIds = await runtime.triggers.matchEvent({
        source: "sys",
        event: "thing.happened",
        payload: { itemId: "1" },
      });

      expect(dbStarted).toBe(0);
      expect(inMemRunIds).toHaveLength(0);
      expect(runRowCount()).toBe(0);
    });

    it("webhook ingress (valid HMAC signature) is not accepted and creates NO run row", async () => {
      const runtime = buildRuntime({ allowTestOnly: false });
      const { workflowId, versionId } = publishWorkflow(runtime, "webhook-wf");
      persistWebhookReg(workflowId, versionId);

      const result = await runtime.triggers.handleWebhook(signedWebhookInput());

      // Reaches startRun past the HMAC gate, then fails closed → not accepted.
      expect(result.accepted).toBe(false);
      expect(result.runId).toBeUndefined();
      expect(runRowCount()).toBe(0);
    });

    it("manual fire throws retired error and creates NO run row", async () => {
      const runtime = buildRuntime({ allowTestOnly: false });
      const { workflowId, versionId } = publishWorkflow(runtime, "manual-wf");

      await expect(
        runtime.triggers.fireManual({
          workflowId,
          workflowVersionId: versionId,
          triggerType: "manual",
        }),
      ).rejects.toMatchObject({ code: RETIRED_CODE });

      expect(runRowCount()).toBe(0);
    });

    // ─── G4: run-control siblings of startRun (resume/retry/cancel) ───
    // Reached off-route via dispatchManagedAsync ← channel orchestration and
    // workflow-approval approve → resumeRun. Each must fail closed at the METHOD
    // boundary BEFORE any DB read (getRunById) or write, so the guard fires even
    // for a non-existent runId (proving it precedes the WORKFLOW_RUN_NOT_FOUND
    // lookup). No run row is created.
    it("direct resumeRun method throws retired error before any DB read", async () => {
      const runtime = buildRuntime({ allowTestOnly: false });
      publishWorkflow(runtime, "resume-wf");

      await expect(
        runtime.execution.resumeRun("00000000-0000-0000-0000-000000000001"),
      ).rejects.toMatchObject({ code: RETIRED_CODE });

      expect(runRowCount()).toBe(0);
    });

    it("direct retryRun method throws retired error before any DB read", async () => {
      const runtime = buildRuntime({ allowTestOnly: false });
      publishWorkflow(runtime, "retry-wf");

      await expect(
        runtime.execution.retryRun("00000000-0000-0000-0000-000000000002"),
      ).rejects.toMatchObject({ code: RETIRED_CODE });

      expect(runRowCount()).toBe(0);
    });

    it("direct cancelRun method throws retired error before any DB read", async () => {
      const runtime = buildRuntime({ allowTestOnly: false });
      publishWorkflow(runtime, "cancel-wf");

      await expect(
        runtime.execution.cancelRun("00000000-0000-0000-0000-000000000003"),
      ).rejects.toMatchObject({ code: RETIRED_CODE });

      expect(runRowCount()).toBe(0);
    });
  });

  // ─── Explicit test-oracle flag ON: legacy path still works ───

  describe("test-oracle flag ON — legacy path preserved", () => {
    it("direct startRun creates a run row", async () => {
      const runtime = buildRuntime({ allowTestOnly: true });
      const { workflowId, versionId } = publishWorkflow(runtime, "oracle-direct-wf");

      const run = await runtime.execution.startRun({
        workflowId,
        workflowVersionId: versionId,
        triggerType: "manual",
      });

      expect(run).not.toBeNull();
      expect(run.workflowId).toBe(workflowId);
      expect(runRowCount()).toBeGreaterThanOrEqual(1);
    });

    it("cron scheduler tick starts the due run", async () => {
      const runtime = buildRuntime({ allowTestOnly: true });
      const { workflowId, versionId } = publishWorkflow(runtime, "oracle-cron-wf");
      persistCronReg(workflowId, versionId);

      const started = await runtime.triggers.tickCron(NOW);

      expect(started).toBe(1);
      expect(runRowCount()).toBeGreaterThanOrEqual(1);
    });

    // G4: with the flag ON, the run-control siblings pass the retirement guard
    // and reach their bodies — proven by the DOWNSTREAM not-found error (NOT the
    // retirement code), confirming the guard is the only thing fenced by the flag.
    it("resume/retry/cancel reach the body (downstream not-found, NOT retired) when flag is on", async () => {
      const runtime = buildRuntime({ allowTestOnly: true });
      publishWorkflow(runtime, "oracle-control-wf");

      await expect(
        runtime.execution.resumeRun("00000000-0000-0000-0000-0000000000a1"),
      ).rejects.toMatchObject({ code: "WORKFLOW_RUN_NOT_FOUND" });
      await expect(
        runtime.execution.retryRun("00000000-0000-0000-0000-0000000000a2"),
      ).rejects.toMatchObject({ code: "WORKFLOW_RUN_NOT_FOUND" });
      await expect(
        runtime.execution.cancelRun("00000000-0000-0000-0000-0000000000a3"),
      ).rejects.toMatchObject({ code: "WORKFLOW_RUN_NOT_FOUND" });
    });
  });
});
