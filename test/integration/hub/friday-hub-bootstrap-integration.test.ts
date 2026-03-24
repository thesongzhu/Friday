import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { createFridayHub } from "#hub";
import type { FridayHub } from "#hub";
import { initializeFridayState } from "#state";

describe("FridayHub Bootstrap Integration", () => {
  const tmpDirs: string[] = [];
  const hubs: FridayHub[] = [];
  let lastStateDir: string | null = null;

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
    const hub = await createFridayHub({
      stateDir,
      skillDirs: [bundledSkillsDir, managedSkillsDir],
    });
    hubs.push(hub);
    return hub;
  }

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

    hub.satelliteRuntime.sync.push({
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

  it("registers autofix-dispatch scheduler job on startup", async () => {
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
});
