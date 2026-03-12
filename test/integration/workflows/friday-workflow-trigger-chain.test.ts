import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayWorkflowRuntime,
  createFridayWorkflowTriggerRepository,
} from "#workflows";
import type { FridayWorkflowRuntime, FridayCompiledWorkflowGraphV2 } from "#workflows";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";

/**
 * Waits for a run to reach a terminal status.
 */
async function waitForRunSettled(
  runtime: FridayWorkflowRuntime,
  runId: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  const terminal = new Set(["completed", "failed", "cancelled"]);
  while (Date.now() - start < timeoutMs) {
    const run = runtime.execution.getRun(runId);
    if (run && terminal.has(run.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("Workflow Trigger Chain (Integration)", () => {
  let db: FridaySqliteLayer;
  let runtime: FridayWorkflowRuntime;
  let invokeSkill: ReturnType<typeof vi.fn>;
  const NOW = "2026-02-18T10:00:00.000Z";

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
        edges: [
          { id: "e1", sourceNodeId: "trigger", targetNodeId: "action1" },
        ],
      },
      failurePolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
      checksum: "placeholder",
    };
  }

  beforeEach(() => {
    db = createTestDb();
    invokeSkill = vi.fn().mockResolvedValue({ result: "ok" });

    runtime = createFridayWorkflowRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      computeChecksum: (content: string) =>
        createHash("sha256").update(content).digest("hex"),
      resolveSkill: () => ({ id: "test-skill" }),
      invokeSkill,
      triggerRepo: createFridayWorkflowTriggerRepository({ db }),
    });
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    db.close();
  });

  function createAndPublishWorkflow(slug = "trigger-wf"): {
    workflowId: string;
    versionId: string;
  } {
    const wf = runtime.crud.createWorkflow({ slug, name: "Trigger WF" });
    const version = runtime.crud.createVersion(wf.id, makeGraph(wf.id, "placeholder"));
    runtime.crud.publishVersion(wf.id, version.versionNumber);
    return { workflowId: wf.id, versionId: version.id };
  }

  // ─── Register triggers (in-memory) ───

  describe("register triggers", () => {
    it("registers a manual trigger", () => {
      const { workflowId, versionId } = createAndPublishWorkflow();

      const reg = runtime.triggers.register(workflowId, versionId, {
        type: "manual",
      });

      expect(reg.workflowId).toBe(workflowId);
      expect(reg.trigger.type).toBe("manual");
      expect(reg.enabled).toBe(true);
    });

    it("registers a cron trigger", () => {
      const { workflowId, versionId } = createAndPublishWorkflow("cron-wf");

      const reg = runtime.triggers.register(workflowId, versionId, {
        type: "schedule",
        cron: "0 * * * *",
        timezone: "UTC",
      });

      expect(reg.workflowId).toBe(workflowId);
      expect(reg.trigger.type).toBe("schedule");
    });

    it("registers an event trigger", () => {
      const { workflowId, versionId } = createAndPublishWorkflow("event-wf");

      const reg = runtime.triggers.register(workflowId, versionId, {
        type: "event",
        source: "test-system",
        event: "item.created",
      });

      expect(reg.workflowId).toBe(workflowId);
      expect(reg.trigger.type).toBe("event");
    });
  });

  // ─── Fire manual trigger ───

  describe("fire manual trigger", () => {
    it("creates a run via manual trigger", async () => {
      const { workflowId, versionId } = createAndPublishWorkflow("manual-fire");

      runtime.triggers.register(workflowId, versionId, { type: "manual" });

      const runId = await runtime.triggers.fireManual({
        workflowId,
        workflowVersionId: versionId,
        triggerType: "manual",
        triggerPayload: { data: "hello" },
      });

      await waitForRunSettled(runtime, runId);

      const run = runtime.execution.getRun(runId);
      expect(run).not.toBeNull();
      expect(run!.workflowId).toBe(workflowId);
    });
  });

  // ─── Handle webhook ───

  describe("handle webhook", () => {
    it("returns not accepted for unknown webhook path token", async () => {
      createAndPublishWorkflow("webhook-wf");

      const result = await runtime.triggers.handleWebhook({
        pathToken: "random-nonexistent-token",
        body: { key: "value" },
      });
      expect(result.accepted).toBe(false);
    });
  });

  // ─── Handle event ───

  describe("handle event", () => {
    it("fires event triggers matching source and event", async () => {
      const { workflowId, versionId } = createAndPublishWorkflow("event-fire");

      runtime.triggers.register(workflowId, versionId, {
        type: "event",
        source: "test-system",
        event: "item.created",
      });

      const runIds = await runtime.triggers.matchEvent({
        source: "test-system",
        event: "item.created",
        payload: { itemId: "123" },
      });

      expect(runIds.length).toBeGreaterThanOrEqual(1);

      // Wait for the triggered run to settle
      for (const runId of runIds) {
        await waitForRunSettled(runtime, runId);
      }
    });

    it("does not fire for non-matching events", async () => {
      const { workflowId, versionId } = createAndPublishWorkflow("event-nomatch");

      runtime.triggers.register(workflowId, versionId, {
        type: "event",
        source: "test-system",
        event: "item.created",
      });

      const runIds = await runtime.triggers.matchEvent({
        source: "other-system",
        event: "item.deleted",
        payload: {},
      });

      expect(runIds).toHaveLength(0);
    });
  });

  // ─── Trigger persistence after sync ───

  describe("trigger persistence after sync", () => {
    it("syncs and reloads from published versions", async () => {
      const { workflowId } = createAndPublishWorkflow("persist-wf");

      await runtime.triggers.syncPublishedVersionTriggers(workflowId);
      const regs = runtime.triggers.listRegistrations(workflowId);
      expect(regs).toBeDefined();

      // Reload all published triggers (simulating a hub restart)
      await runtime.triggers.reloadFromPublishedVersions();
      const allRegs = runtime.triggers.listAllRegistrations();
      expect(allRegs).toBeDefined();
    });
  });
});
