import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { beforeEach, describe, it, expect, afterEach, vi } from "vitest";
import { createFridayHub } from "#hub";
import type { FridayHub } from "#hub";
import { FridayAuthError } from "#api";

describe("createFridayHub", () => {
  let hub: FridayHub | null = null;
  let stateDir: string | null = null;
  let bundledSkillsDir: string | null = null;
  let managedSkillsDir: string | null = null;
  const originalSuppression = process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS;

  async function createIsolatedHub(): Promise<FridayHub> {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-hub-bootstrap-"));
    bundledSkillsDir = path.join(stateDir, "skills-empty");
    managedSkillsDir = path.join(stateDir, "managed-skills-empty");
    await fs.mkdir(bundledSkillsDir, { recursive: true });
    await fs.mkdir(managedSkillsDir, { recursive: true });
    hub = await createFridayHub({
      skillDirs: [bundledSkillsDir, managedSkillsDir],
      stateDir,
    });
    return hub;
  }

  beforeEach(() => {
    process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS = "1";
  });

  afterEach(async () => {
    if (originalSuppression === undefined) {
      delete process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS;
    } else {
      process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS = originalSuppression;
    }
    if (hub) {
      await hub.stop();
      hub = null;
    }
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
      stateDir = null;
    }
    bundledSkillsDir = null;
    managedSkillsDir = null;
  });

  it("creates a hub with default config", async () => {
    hub = await createIsolatedHub();
    expect(hub).toBeDefined();
    expect(hub.skills).toBeDefined();
    expect(hub.executor).toBeDefined();
  });

  it("starts in stopped state", async () => {
    hub = await createIsolatedHub();
    const status = hub.status();
    expect(status.state).toBe("stopped");
    expect(status.skillCount).toBe(0);
    expect(status.upSince).toBeNull();
  });

  it("transitions to running after start()", async () => {
    hub = await createIsolatedHub();
    await hub.start();
    const status = hub.status();
    expect(status.state).toBe("running");
    expect(status.upSince).not.toBeNull();
  });

  it("transitions to stopped after stop()", async () => {
    hub = await createIsolatedHub();
    await hub.start();
    await hub.stop();
    hub = null; // already stopped
    // Can't check status after stop since sqlite is closed
  });

  it("returns skillCount 0 with no skill dirs", async () => {
    hub = await createIsolatedHub();
    await hub.start();
    const status = hub.status();
    expect(status.skillCount).toBe(0);
  });

  it("wires observability routes into the API runtime", async () => {
    hub = await createIsolatedHub();
    const operationIds = hub.apiRuntime.routes.getRoutes().map((route) => route.operationId);
    expect(operationIds).toContain("version.get");
    expect(operationIds).toContain("config.get");
    expect(operationIds).toContain("secrets.list");
    expect(operationIds).toContain("observability.overview");
    expect(operationIds).toContain("observability.time.series");
    expect(operationIds).toContain("agent.loop.policy.get");
  });

  it("deduplicates expected startup warnings across repeated hub bootstraps", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      hub = await createIsolatedHub();
      await hub.stop();
      hub = null;
      if (stateDir) {
        await fs.rm(stateDir, { recursive: true, force: true });
        stateDir = null;
      }
      bundledSkillsDir = null;
      managedSkillsDir = null;

      hub = await createIsolatedHub();

      const warnings = warnSpy.mock.calls.map(([message]) => String(message));
      // The admin-user warning now always prints via console.warn (no longer
      // deduplicated by warnOnce), so each hub bootstrap emits it once.
      const adminWarnings = warnings.filter((message) => message.includes("Created default admin user"));
      expect(adminWarnings.length).toBe(2);
      expect(warnings.filter((message) => message.includes("No model routing configured"))).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("always emits passwordless admin warning regardless of test security warning suppression", async () => {
    process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS = "1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      hub = await createIsolatedHub();
      const warnings = warnSpy.mock.calls.map(([message]) => String(message));
      // Suppression env var no longer prevents the admin warning from being emitted
      expect(warnings.filter((message) => message.includes("Created default admin user"))).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("executor returns failed for unknown skill", async () => {
    hub = await createIsolatedHub();
    await hub.start();

    const handle = hub.executor.execute({
      skillId: "nonexistent-skill",
      input: {},
      sessionId: "test-session",
      userId: "test-user",
      channel: "test",
    });

    const result = await handle.result;
    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("not found");
  });

  it("does not allow local bypass login from remote IP (allowLocalBypassLogin defaults to false)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      hub = await createIsolatedHub();
      hub!.apiRuntime.auth.login({ local: true }, "203.0.113.20");
      throw new Error("expected local bypass login to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayAuthError);
      expect((err as FridayAuthError).code).toBe("PASSWORDLESS_LOCALHOST_ONLY");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
