import { beforeEach, describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { createFridayHub } from "#hub";
import type { FridayHub } from "#hub";
import { initializeFridayState } from "#state";
import {
  createFridayAgentRunRepository,
  createFridaySubagentRunRepository,
} from "#agent";
import { buildFridaySubagentSessionKey } from "#sessions";
import type { FridayCompiledWorkflowGraphV2 } from "#workflows";
import {
  clearAutoDetectProviderEnv,
  restoreAutoDetectProviderEnv,
  type FridayAutoDetectProviderEnvSnapshot,
} from "../../_helpers/auto-detect-provider-env.js";

describe("FridayHub Bootstrap Integration", () => {
  const tmpDirs: string[] = [];
  const hubs: FridayHub[] = [];
  let lastStateDir: string | null = null;
  let autoDetectEnvSnapshot: FridayAutoDetectProviderEnvSnapshot | null = null;

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-hub-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  async function createIsolatedHub(): Promise<FridayHub> {
    const stateDir = makeTmpDir();
    lastStateDir = stateDir;
    const bundledSkillsDir = makeTmpDir();
    const managedSkillsDir = makeTmpDir();
    const hub = await createHubForDirs(stateDir, bundledSkillsDir, managedSkillsDir);
    return hub;
  }

  async function createHubForDirs(
    stateDir: string,
    bundledSkillsDir: string,
    managedSkillsDir: string,
  ): Promise<FridayHub> {
    const hub = await createFridayHub({
      stateDir,
      skillDirs: [bundledSkillsDir, managedSkillsDir],
    });
    hubs.push(hub);
    return hub;
  }

  async function withAutoFixDispatcherEnabled<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.FRIDAY_AUTOFIX_DISPATCHER_ENABLED;
    process.env.FRIDAY_AUTOFIX_DISPATCHER_ENABLED = "true";
    try {
      return await fn();
    } finally {
      if (previous === undefined) {
        delete process.env.FRIDAY_AUTOFIX_DISPATCHER_ENABLED;
      } else {
        process.env.FRIDAY_AUTOFIX_DISPATCHER_ENABLED = previous;
      }
    }
  }

  function makeApprovalOnlyGraph(
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
            id: "approval1",
            type: "approval",
            label: "Approval Gate",
            config: {
              approverRole: "admin",
              message: "Please approve restart durability",
              timeoutMs: 3_600_000,
            },
          },
        ],
        edges: [
          { id: "e1", sourceNodeId: "trigger", targetNodeId: "approval1" },
        ],
      },
      failurePolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
      checksum: "placeholder",
    };
  }

  function makeFailingActionGraph(
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
            label: "Broken Action",
            config: {
              skillId: "missing-skill",
            },
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

  async function waitForWorkflowRunStable(
    hub: FridayHub,
    runId: string,
    timeoutMs = 5_000,
  ): Promise<string> {
    const start = Date.now();
    const transient = new Set(["queued", "running"]);
    while (Date.now() - start < timeoutMs) {
      const run = hub.workflowRuntime.execution.getRun(runId);
      if (run && !transient.has(run.status)) {
        return run.status;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const run = hub.workflowRuntime.execution.getRun(runId);
    return run?.status ?? "unknown";
  }

  beforeEach(() => {
    autoDetectEnvSnapshot = clearAutoDetectProviderEnv();
  });

  afterEach(async () => {
    for (const hub of hubs) {
      try {
        await hub.stop();
      } catch {
        // ignore cleanup errors
      }
    }
    hubs.length = 0;

    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tmpDirs.length = 0;
    lastStateDir = null;
    if (autoDetectEnvSnapshot) {
      restoreAutoDetectProviderEnv(autoDetectEnvSnapshot);
      autoDetectEnvSnapshot = null;
    }
  });

  // ─── Wires all services ───

  it("creates a hub with all expected service handles", async () => {
    const hub = await createIsolatedHub();

    expect(hub.skills).toBeDefined();
    expect(hub.executor).toBeDefined();
    expect(hub.providerService).toBeDefined();
    expect(hub.skillGenerator).toBeDefined();
    expect(hub.converterService).toBeDefined();
    expect(hub.workflowGenerator).toBeDefined();
    expect(hub.workflowRuntime).toBeDefined();
    expect(hub.apiRuntime).toBeDefined();
    expect(hub.workflowRuntime.crud).toBeDefined();
    expect(hub.workflowRuntime.execution).toBeDefined();
    expect(hub.workflowRuntime.triggers).toBeDefined();
    expect(hub.workflowRuntime.approval).toBeDefined();
  });

  it("blocks legacy system approval-rule mutation route in the live hub", async () => {
    const previousEnabled = process.env.FRIDAY_SYSTEM_ENABLED;
    const previousTransport = process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT;
    process.env.FRIDAY_SYSTEM_ENABLED = "true";
    process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT = "in_process";
    try {
      const hub = await createIsolatedHub();
      const route = hub.apiRuntime.routes.getRoutes()
        .find((entry) => entry.operationId === "system.approvals.update");

      expect(route).toBeDefined();
      await expect(route!.handler({
        requestId: "req-system-approval-1",
        receivedAt: new Date().toISOString(),
        params: { approvalId: "approval-1" },
        query: {},
        body: { decision: "allow", idempotencyKey: "approval-update-1" },
        headers: {},
        principal: null,
      } as never)).rejects.toMatchObject({
        code: "SYSTEM_CANONICAL_APPROVAL_REQUIRED",
      });
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.FRIDAY_SYSTEM_ENABLED;
      } else {
        process.env.FRIDAY_SYSTEM_ENABLED = previousEnabled;
      }
      if (previousTransport === undefined) {
        delete process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT;
      } else {
        process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT = previousTransport;
      }
    }
  });

  // ─── start() transitions to running ───

  it("transitions to 'running' after start()", async () => {
    const hub = await createIsolatedHub();

    expect(hub.status().state).toBe("stopped");

    await hub.start();

    const status = hub.status();
    expect(status.state).toBe("running");
    expect(status.upSince).toBeTruthy();
    expect(status.skillCount).toBe(0); // no skill dirs configured
  });

  it("starts successfully when desktop runtime is enabled", async () => {
    const prevDesktopEnabled = process.env.FRIDAY_DESKTOP_ENABLED;
    const prevSandboxRoots = process.env.FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS;
    process.env.FRIDAY_DESKTOP_ENABLED = "true";
    try {
      const hub = await createIsolatedHub();
      process.env.FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS = lastStateDir ?? process.cwd();
      await hub.start();
      expect(hub.status().state).toBe("running");
    } finally {
      if (prevDesktopEnabled === undefined) {
        delete process.env.FRIDAY_DESKTOP_ENABLED;
      } else {
        process.env.FRIDAY_DESKTOP_ENABLED = prevDesktopEnabled;
      }
      if (prevSandboxRoots === undefined) {
        delete process.env.FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS;
      } else {
        process.env.FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS = prevSandboxRoots;
      }
    }
  }, 30_000);

  it("registers late-bound setup tools on the top-level agent runtime", async () => {
    const prevMcpServerEnabled = process.env.FRIDAY_MCP_SERVER_ENABLED;
    process.env.FRIDAY_MCP_SERVER_ENABLED = "true";

    try {
      const hub = await createIsolatedHub();
      const tools = await Promise.resolve(hub.apiRuntime.mcpServer!.listTools());
      const toolNames = tools.map((tool) => tool.name);

      // MCP self-server now defaults to a curated safe catalog.
      // Unsafe tools (autonomous, setup, setup_assistant) are no longer
      // exposed by default — only safe read-only tools are listed.
      expect(toolNames).toContain("capabilities");
      expect(toolNames).toContain("task_status");
      expect(toolNames).toContain("read");
      expect(toolNames).not.toContain("sessions");
      expect(toolNames).not.toContain("autonomous");
      expect(toolNames).not.toContain("setup");
      expect(toolNames).not.toContain("exec");
    } finally {
      if (prevMcpServerEnabled === undefined) {
        delete process.env.FRIDAY_MCP_SERVER_ENABLED;
      } else {
        process.env.FRIDAY_MCP_SERVER_ENABLED = prevMcpServerEnabled;
      }
    }
  });

  // ─── stop() cleans up ───

  it("transitions to 'stopped' after stop()", async () => {
    const hub = await createIsolatedHub();

    await hub.start();
    expect(hub.status().state).toBe("running");

    await hub.stop();

    const status = hub.status();
    expect(status.state).toBe("stopped");
    expect(status.upSince).toBeNull();
  });

  // ─── SQLite DB file created ───

  it("creates friday.db in the stateDir", async () => {
    const stateDir = makeTmpDir();
    const bundledSkillsDir = makeTmpDir();
    const managedSkillsDir = makeTmpDir();
    const hub = await createFridayHub({
      stateDir,
      skillDirs: [bundledSkillsDir, managedSkillsDir],
    });
    hubs.push(hub);

    const dbPath = path.join(stateDir, "friday.db");
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("loads setup wizard channel config when explicit channels are not provided", async () => {
    const stateDir = makeTmpDir();
    const bundledSkillsDir = makeTmpDir();
    const managedSkillsDir = makeTmpDir();

    const stateRuntime = initializeFridayState({
      env: {
        ...process.env,
        FRIDAY_STATE_DIR: stateDir,
      },
    });

    const now = new Date().toISOString();
    stateRuntime.sqlite.withWriteTransaction((db) => {
      db.prepare(
        `INSERT OR IGNORE INTO friday_setup_state (id, created_at, updated_at)
         VALUES ('singleton', ?, ?)`,
      ).run(now, now);
      db.prepare(
        `UPDATE friday_setup_state
         SET channels_json = ?, updated_at = ?
         WHERE id = 'singleton'`,
      ).run(
        JSON.stringify([
          {
            kind: "webchat",
            enabled: true,
            controlConfirmed: true,
            controlConfirmedAt: now,
            config: {
              wsPath: "/ws/friday",
              authMode: "none",
            },
          },
        ]),
        now,
      );
    });
    stateRuntime.close();

    const hub = await createFridayHub({
      stateDir,
      skillDirs: [bundledSkillsDir, managedSkillsDir],
    });
    hubs.push(hub);

    await hub.start();

    expect(hub.channelRegistry.list()).toContain("webchat");
    expect(hub.channelRegistry.status("webchat")).toBe("connected");
  });

  it("disables plaintext-secret channels under strict policy by default", async () => {
    const stateDir = makeTmpDir();
    const bundledSkillsDir = makeTmpDir();
    const managedSkillsDir = makeTmpDir();

    const hub = await createFridayHub({
      stateDir,
      skillDirs: [bundledSkillsDir, managedSkillsDir],
      channels: {
        enabled: true,
        instances: [
          {
            kind: "discord",
            enabled: true,
            token: "plaintext-token-should-not-load",
          },
        ],
      },
    });
    hubs.push(hub);

    expect(hub.channelRegistry.list()).not.toContain("discord");
  });

  it("routes satellite local events through self-learning pipeline", async () => {
    const hub = await createIsolatedHub();
    const now = new Date().toISOString();
    const eventId = `evt-local-${Date.now()}`;

    await hub.satelliteRuntime.sync.push({
      satelliteId: "sat-1",
      acks: [],
      localEvents: [
        {
          eventId,
          ts: now,
          userId: "admin-001",
          kind: "user_message",
          payload: { text: "call me captain" },
        },
      ],
    });

    const dbPath = path.join(lastStateDir ?? "", "friday.db");
    const db = new Database(dbPath);
    try {
      const eventRow = db
        .prepare("SELECT event_id FROM learning_events WHERE event_id = ?")
        .get(eventId) as { event_id: string } | undefined;
      expect(eventRow?.event_id).toBe(eventId);

      const factRow = db
        .prepare("SELECT value_json FROM preference_facts WHERE user_id = ? AND key = ?")
        .get("admin-001", "pref:display_name") as { value_json: string } | undefined;
      expect(factRow).toBeDefined();
      expect(JSON.parse(factRow!.value_json)).toBe("captain");
    } finally {
      db.close();
    }
  });

  it("routes agent runtime failures through self-learning pipeline and diagnosis storage", async () => {
    const hub = await createIsolatedHub();
    const runId = `agent-run-${Date.now()}`;

    hub.apiRuntime.agentRuntime!.emitRunEvent("agent.run.failed", {
      runId,
      error: {
        code: "AGENT_LLM_ERROR",
        message: "Synthetic agent learning bridge failure",
      },
      durationMs: 123,
    }, runId);

    const dbPath = path.join(lastStateDir ?? "", "friday.db");
    const db = new Database(dbPath);
    try {
      const eventRow = db
        .prepare("SELECT kind, payload_json FROM learning_events WHERE payload_json LIKE ? ORDER BY ts DESC LIMIT 1")
        .get(`%${runId}%`) as { kind: string; payload_json: string } | undefined;
      expect(eventRow?.kind).toBe("error_incident");
      expect(JSON.parse(eventRow!.payload_json).agentRunId).toBe(runId);

      const incident = db.prepare(
        "SELECT category, severity, context_json FROM error_incidents WHERE context_json LIKE ? ORDER BY created_at DESC LIMIT 1",
      ).get(`%${runId}%`) as
        | { category: string; severity: string; context_json: string }
        | undefined;
      expect(incident).toBeDefined();
      expect(incident!.category).toBe("tool");
      expect(incident!.severity).toBe("medium");
      expect(JSON.parse(incident!.context_json).agentRunId).toBe(runId);
    } finally {
      db.close();
    }
  });

  it("backs runtime config APIs with persisted revisions and rollback", async () => {
    const hub = await createIsolatedHub();
    const routes = hub.apiRuntime.routes.getRoutes();
    const getConfig = routes.find((route) => route.operationId === "config.get")!;
    const updateConfig = routes.find((route) => route.operationId === "config.update")!;
    const listRevisions = routes.find((route) => route.operationId === "config.revisions.list")!;
    const revertConfig = routes.find((route) => route.operationId === "config.revisions.revert")!;

    const baseCtx = {
      requestId: "req-config-1",
      receivedAt: new Date().toISOString(),
      params: {},
      query: {},
      body: null,
      headers: {},
      principal: null,
    };

    const initial = await getConfig.handler({
      ...baseCtx,
      query: { keys: "database.busyTimeoutMs" },
    } as never) as { revision: number; settings: Record<string, unknown> };

    expect(initial.revision).toBe(1);
    expect(initial.settings["database.busyTimeoutMs"]).toBe(5000);

    const updated = await updateConfig.handler({
      ...baseCtx,
      body: {
        expectedRevision: initial.revision,
        patch: { database: { busyTimeoutMs: 6000 } },
        reason: "integration config update",
      },
    } as never) as { revision: number; changedKeys: string[] };

    expect(updated.revision).toBe(2);
    expect(updated.changedKeys).toContain("database.busyTimeoutMs");

    const afterUpdate = await getConfig.handler({
      ...baseCtx,
      query: { keys: "database.busyTimeoutMs" },
    } as never) as { revision: number; settings: Record<string, unknown> };
    expect(afterUpdate.revision).toBe(2);
    expect(afterUpdate.settings["database.busyTimeoutMs"]).toBe(6000);

    const revisions = await listRevisions.handler(baseCtx as never) as {
      items: Array<{ revision: number; changedKeys: string[] }>;
    };
    expect(revisions.items.map((revision) => revision.revision)).toEqual([2, 1]);

    const reverted = await revertConfig.handler({
      ...baseCtx,
      body: { toRevision: 1 },
    } as never) as { revision: number; revertedFrom: number; changedKeys: string[] };
    expect(reverted).toMatchObject({ revision: 3, revertedFrom: 2 });
    expect(reverted.changedKeys).toContain("database.busyTimeoutMs");

    const afterRevert = await getConfig.handler({
      ...baseCtx,
      query: { keys: "database.busyTimeoutMs" },
    } as never) as { revision: number; settings: Record<string, unknown> };
    expect(afterRevert.revision).toBe(3);
    expect(afterRevert.settings["database.busyTimeoutMs"]).toBe(5000);

    expect(fs.existsSync(path.join(lastStateDir ?? "", "friday.config.json5"))).toBe(true);
  });

  it("registers autofix-dispatch scheduler job on startup", async () => {
    await withAutoFixDispatcherEnabled(async () => {
      const hub = await createIsolatedHub();
      await hub.start();

      const dbPath = path.join(lastStateDir ?? "", "friday.db");
      const db = new Database(dbPath);
      try {
        const row = db
          .prepare("SELECT id, interval_ms, enabled FROM friday_scheduler_jobs WHERE id = 'autofix-dispatch'")
          .get() as { id: string; interval_ms: number; enabled: number } | undefined;
        expect(row).toBeDefined();
        expect(row!.id).toBe("autofix-dispatch");
        expect(row!.interval_ms).toBe(60_000);
        expect(row!.enabled).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  it("registers the agent-loop cooldown sweep job on startup", async () => {
    const hub = await createIsolatedHub();
    await hub.start();

    const dbPath = path.join(lastStateDir ?? "", "friday.db");
    const db = new Database(dbPath);
    try {
      const row = db
        .prepare("SELECT id, interval_ms, enabled FROM friday_scheduler_jobs WHERE id = 'agent-loop-cooldown-sweep'")
        .get() as { id: string; interval_ms: number; enabled: number } | undefined;
      expect(row).toBeDefined();
      expect(row!.id).toBe("agent-loop-cooldown-sweep");
      expect(row!.interval_ms).toBe(60_000);
      expect(row!.enabled).toBe(1);
    } finally {
      db.close();
    }
  });

  it("exposes hub-registered scheduler jobs through /v1/jobs", async () => {
    await withAutoFixDispatcherEnabled(async () => {
      const hub = await createIsolatedHub();
      await hub.start();

      const route = hub.apiRuntime.routes.getRoutes().find((entry) => entry.operationId === "tui.jobs.list");
      expect(route).toBeDefined();

      const jobs = await route!.handler({
        params: {},
        query: {},
        body: null,
        headers: {},
        principal: {
          principalType: "user",
          principalId: "scheduler-admin",
          role: "admin",
          scopes: ["hub.admin"],
          tokenId: "token-scheduler-admin",
          tokenKind: "access",
          issuedAt: "2026-04-23T00:00:00.000Z",
        },
        requestId: "req-scheduler-jobs",
        receivedAt: "2026-04-23T00:00:00.000Z",
      } as never) as Array<{
        jobId: string;
        status: string;
        nextRunAt: string | null;
      }>;

      const jobById = new Map(jobs.map((job) => [job.jobId, job]));
      expect(jobById.get("workflow-timeout-sweep")).toMatchObject({
        jobId: "workflow-timeout-sweep",
        status: expect.stringMatching(/^(scheduled|pending|idle)$/),
      });
      expect(jobById.get("autofix-dispatch")).toMatchObject({
        jobId: "autofix-dispatch",
        status: expect.stringMatching(/^(scheduled|pending|idle)$/),
      });
      expect(jobById.get("agent-loop-cooldown-sweep")).toMatchObject({
        jobId: "agent-loop-cooldown-sweep",
        status: expect.stringMatching(/^(scheduled|pending|idle)$/),
      });
    });
  });

  it("replays persisted scheduled automations onto the scheduler after restart", async () => {
    const stateDir = makeTmpDir();
    lastStateDir = stateDir;
    const bundledSkillsDir = makeTmpDir();
    const managedSkillsDir = makeTmpDir();
    const dbPath = path.join(stateDir, "friday.db");

    const firstHub = await createHubForDirs(stateDir, bundledSkillsDir, managedSkillsDir);
    await firstHub.start();

    const automation = firstHub.apiRuntime.agentAutomationService!.save({
      name: "Restarted automation",
      taskTemplate: "Summarize the latest workspace state",
      schedule: {
        type: "cron",
        cron: "* * * * *",
        timezone: "UTC",
      },
    });
    const jobId = `agent-automation:${automation.id}`;

    let db = new Database(dbPath);
    try {
      db.prepare("DELETE FROM friday_scheduler_jobs WHERE id = ?").run(jobId);
    } finally {
      db.close();
    }

    await firstHub.stop();

    const secondHub = await createHubForDirs(stateDir, bundledSkillsDir, managedSkillsDir);
    await secondHub.start();

    db = new Database(dbPath);
    try {
      const row = db
        .prepare(
          `SELECT id, enabled, schedule_kind, schedule_cron_expr, schedule_tz, next_run_at
           FROM friday_scheduler_jobs
           WHERE id = ?`,
        )
        .get(jobId) as
          | {
              id: string;
              enabled: number;
              schedule_kind: string;
              schedule_cron_expr: string | null;
              schedule_tz: string | null;
              next_run_at: string | null;
            }
          | undefined;
      expect(row).toBeDefined();
      expect(row!.id).toBe(jobId);
      expect(row!.enabled).toBe(1);
      expect(row!.schedule_kind).toBe("cron");
      expect(row!.schedule_cron_expr).toBe("* * * * *");
      expect(row!.schedule_tz).toBe("UTC");
      expect(row!.next_run_at).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("preserves pending workflow approvals across restart and resumes on approval", async () => {
    const stateDir = makeTmpDir();
    lastStateDir = stateDir;
    const bundledSkillsDir = makeTmpDir();
    const managedSkillsDir = makeTmpDir();

    const firstHub = await createHubForDirs(stateDir, bundledSkillsDir, managedSkillsDir);
    await firstHub.start();

    const workflow = firstHub.workflowRuntime.crud.createWorkflow({
      slug: "restart-approval-proof",
      name: "Restart Approval Proof",
    });
    const version = firstHub.workflowRuntime.crud.createVersion(
      workflow.id,
      makeApprovalOnlyGraph(workflow.id, "placeholder"),
    );
    firstHub.workflowRuntime.crud.publishVersion(workflow.id, version.versionNumber);

    const run = await firstHub.workflowRuntime.execution.startRun({
      workflowId: workflow.id,
      workflowVersionId: version.id,
      triggerType: "manual",
    });

    const firstStatus = await waitForWorkflowRunStable(firstHub, run.id);
    expect(["waiting_for_approval", "paused", "blocked", "pause_for_approval"]).toContain(firstStatus);

    const firstPending = firstHub.workflowRuntime.approval.listPending({});
    const approval = firstPending.find((item) => item.runId === run.id);
    expect(approval).toBeDefined();
    expect(approval!.status).toBe("pending");

    await firstHub.stop();

    const secondHub = await createHubForDirs(stateDir, bundledSkillsDir, managedSkillsDir);
    await secondHub.start();

    const restartedPending = secondHub.workflowRuntime.approval.listPending({});
    const restartedApproval = restartedPending.find((item) => item.id === approval!.id);
    expect(restartedApproval).toBeDefined();
    expect(restartedApproval!.status).toBe("pending");
    expect(restartedApproval!.runId).toBe(run.id);

    const approvalResult = await secondHub.workflowRuntime.approval.approve({
      approvalId: restartedApproval!.id,
      decidedByUserId: "admin-001",
      comment: "Resume after restart",
    });
    expect(approvalResult.approval.status).toBe("approved");
    expect(approvalResult.resumed).toBe(true);

    const finalStatus = await waitForWorkflowRunStable(secondHub, run.id);
    expect(finalStatus).toBe("completed");
  });

  it("marks persisted stale agent and subagent runs as failed on startup", async () => {
    const stateDir = makeTmpDir();
    lastStateDir = stateDir;
    const bundledSkillsDir = makeTmpDir();
    const managedSkillsDir = makeTmpDir();
    const dbPath = path.join(stateDir, "friday.db");
    const nowIso = new Date().toISOString();
    const agentRunRepo = createFridayAgentRunRepository();
    const subagentRunRepo = createFridaySubagentRunRepository();

    const seedHub = await createHubForDirs(stateDir, bundledSkillsDir, managedSkillsDir);

    let db = new Database(dbPath);
    try {
      agentRunRepo.create(db, {
        id: "stale-agent-run",
        task: "Resume me after reboot",
        sessionKey: "agent:run:stale-agent-run",
        maxAttempts: 3,
        nowIso,
      });
      agentRunRepo.update(db, {
        id: "stale-agent-run",
        status: "executing",
      });

      agentRunRepo.create(db, {
        id: "parent-run",
        task: "Parent completed run",
        sessionKey: "agent:run:parent-run",
        maxAttempts: 3,
        nowIso,
      });
      agentRunRepo.update(db, {
        id: "parent-run",
        status: "completed",
        completedAt: nowIso,
      });

      subagentRunRepo.create(db, {
        id: "stale-subagent-run",
        parentRunId: "parent-run",
        parentSessionKey: "agent:run:parent-run",
        childRunId: "child-run-stale",
        childSessionKey: buildFridaySubagentSessionKey("agent:run:parent-run", "child-run-stale"),
        task: "Child run left mid-flight",
        depth: 1,
        nowIso,
      });
      subagentRunRepo.update(db, {
        id: "stale-subagent-run",
        status: "running",
        startedAt: nowIso,
      });
    } finally {
      db.close();
    }

    await seedHub.stop();

    const restartedHub = await createHubForDirs(stateDir, bundledSkillsDir, managedSkillsDir);
    await restartedHub.start();

    db = new Database(dbPath);
    try {
      const staleAgent = agentRunRepo.getById(db, "stale-agent-run");
      const parentRun = agentRunRepo.getById(db, "parent-run");
      const staleSubagent = subagentRunRepo.getById(db, "stale-subagent-run");

      expect(staleAgent?.status).toBe("failed");
      expect(staleAgent?.errorCode).toBe("AGENT_RUN_INTERRUPTED");
      expect(staleAgent?.errorMessage).toContain("system restarted");

      expect(parentRun?.status).toBe("completed");

      expect(staleSubagent?.status).toBe("failed");
      expect(staleSubagent?.outcome?.status).toBe("failed");
      expect(staleSubagent?.outcome?.response).toContain("system restarted");
    } finally {
      db.close();
    }
  });

  it("turns satellite degradation into a self-healing incident and loop run", async () => {
    const hub = await createIsolatedHub();
    await hub.start();

    const registration = hub.satelliteRuntime.registration.register({
      type: "phone",
      displayName: "Field node",
      publicKey: "pk-sat-field",
      runtime: {
        platform: "darwin",
        arch: "arm64",
        appVersion: "1.0.0",
        nodeVersion: "22.0.0",
      },
      transport: "ws",
    });

    hub.satelliteRuntime.heartbeat.recordHeartbeat({
      satelliteId: registration.satelliteId,
      ts: new Date().toISOString(),
      failureRate1m: 0.9,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const dbPath = path.join(lastStateDir ?? "", "friday.db");
    const db = new Database(dbPath);
    try {
      const incident = db.prepare(
        "SELECT category, severity, context_json FROM error_incidents ORDER BY created_at DESC LIMIT 1",
      ).get() as
        | { category: string; severity: string; context_json: string }
        | undefined;
      expect(incident).toBeDefined();
      expect(incident!.category).toBe("config");
      expect(incident!.severity).toBe("medium");
      let loopRun = db.prepare(
        "SELECT status, risk_tier, approval_required FROM friday_agent_loop_runs ORDER BY created_at DESC LIMIT 1",
      ).get() as { status: string; risk_tier: number; approval_required: number } | undefined;
      if (!loopRun) {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          loopRun = db.prepare(
            "SELECT status, risk_tier, approval_required FROM friday_agent_loop_runs ORDER BY created_at DESC LIMIT 1",
          ).get() as { status: string; risk_tier: number; approval_required: number } | undefined;
          if (loopRun) {
            break;
          }
        }
      }
      expect(loopRun).toBeDefined();
      expect(loopRun!.risk_tier).toBeGreaterThanOrEqual(0);
      expect(["verified", "awaiting_approval", "paused", "cooldown", "running", "failed", "halted"]).toContain(
        loopRun!.status,
      );
    } finally {
      db.close();
    }
  });

  it("turns naturally failed workflow runs into self-healing incidents and loop runs", async () => {
    const hub = await createIsolatedHub();
    await hub.start();

    const workflow = hub.workflowRuntime.crud.createWorkflow({
      slug: "workflow-self-healing-proof",
      name: "Workflow Self Healing Proof",
    });
    const version = hub.workflowRuntime.crud.createVersion(
      workflow.id,
      makeFailingActionGraph(workflow.id, "placeholder"),
    );
    hub.workflowRuntime.crud.publishVersion(workflow.id, version.versionNumber);

    const run = await hub.workflowRuntime.execution.startRun({
      workflowId: workflow.id,
      workflowVersionId: version.id,
      triggerType: "manual",
      startedByUserId: "admin-001",
    });

    const finalStatus = await waitForWorkflowRunStable(hub, run.id, 10_000);
    expect(finalStatus).toBe("failed");

    const dbPath = path.join(lastStateDir ?? "", "friday.db");
    const db = new Database(dbPath);
    try {
      let incident:
        | {
            category: string;
            severity: string;
            node_id: string | null;
            context_json: string;
          }
        | undefined;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        incident = db.prepare(
          `SELECT category, severity, node_id, context_json
           FROM error_incidents
           WHERE run_id = ?
           ORDER BY created_at DESC
           LIMIT 1`,
        ).get(run.id) as
          | {
              category: string;
              severity: string;
              node_id: string | null;
              context_json: string;
            }
          | undefined;
        if (incident) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(incident).toBeDefined();
      expect(incident!.category).toBe("workflow");
      expect(incident!.severity).toBe("medium");
      expect(incident!.node_id).toBe("action1");

      const incidentCount = db.prepare(
        "SELECT COUNT(*) AS count FROM error_incidents WHERE run_id = ?",
      ).get(run.id) as { count: number };
      expect(incidentCount.count).toBe(1);

      const context = JSON.parse(incident!.context_json) as Record<string, unknown>;
      expect(context["source"]).toBe("workflow_runtime");
      expect(context["workflowId"]).toBe(workflow.id);
      expect(context["failedNodeId"]).toBe("action1");

      let loopRun = db.prepare(
        "SELECT status, risk_tier, approval_required FROM friday_agent_loop_runs ORDER BY created_at DESC LIMIT 1",
      ).get() as { status: string; risk_tier: number; approval_required: number } | undefined;
      if (!loopRun) {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          loopRun = db.prepare(
            "SELECT status, risk_tier, approval_required FROM friday_agent_loop_runs ORDER BY created_at DESC LIMIT 1",
          ).get() as { status: string; risk_tier: number; approval_required: number } | undefined;
          if (loopRun) {
            break;
          }
        }
      }

      expect(loopRun).toBeDefined();
      expect(loopRun!.risk_tier).toBeGreaterThanOrEqual(0);
      expect(["verified", "awaiting_approval", "paused", "cooldown", "running", "failed", "halted"]).toContain(
        loopRun!.status,
      );
    } finally {
      db.close();
    }
  });

  // ─── DeepSeek auto-detect from env ───

  it("auto-registers DeepSeek provider with V4 defaults when DEEPSEEK_API_KEY is set", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key-not-validated"; // pragma: allowlist secret
    const hub = await createIsolatedHub();
    await hub.start();

    const providers = await hub.providerService.listProviders();
    const deepseek = providers.find((p) => p.kind === "deepseek");

    expect(deepseek).toBeDefined();
    expect(deepseek!.defaultModel).toBe("deepseek-v4-pro");
    expect(deepseek!.config.supportedModels).toEqual(
      expect.arrayContaining(["deepseek-v4-pro", "deepseek-v4-flash"]),
    );
    expect(deepseek!.baseUrl).toBe("https://api.deepseek.com");
    expect(deepseek!.config.api).toBe("openai-completions");
    expect(deepseek!.config.keySource).toMatchObject({
      kind: "env-ref",
      envVar: "DEEPSEEK_API_KEY",
    });

    const routing = await hub.providerService.getRoutingConfig();
    expect(routing.defaultProviderId).toBe(deepseek!.id);
    expect(routing.defaultModel).toBe("deepseek-v4-pro");
  });

  it("auto-registers DeepSeek provider when only FRIDAY_DEEPSEEK_API_KEY is set", async () => {
    process.env.FRIDAY_DEEPSEEK_API_KEY = "test-friday-deepseek-key"; // pragma: allowlist secret
    const hub = await createIsolatedHub();
    await hub.start();

    const providers = await hub.providerService.listProviders();
    const deepseek = providers.find((p) => p.kind === "deepseek");

    expect(deepseek).toBeDefined();
    expect(deepseek!.defaultModel).toBe("deepseek-v4-pro");
    expect(deepseek!.config.keySource).toMatchObject({
      kind: "env-ref",
      envVar: "FRIDAY_DEEPSEEK_API_KEY",
    });
  });

  it("does not register DeepSeek when no DeepSeek env var is present", async () => {
    const hub = await createIsolatedHub();
    await hub.start();

    const providers = await hub.providerService.listProviders();
    expect(providers.find((p) => p.kind === "deepseek")).toBeUndefined();
  });
});
