import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createFridayHub } from "#hub";
import type { FridayHub } from "#hub";

describe("Friday hub runtime identity", () => {
  let hub: FridayHub | null = null;
  let stateDir: string | null = null;
  let bundledSkillsDir: string | null = null;
  let managedSkillsDir: string | null = null;

  afterEach(async () => {
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

  it("surfaces the live runtime state dir and launch cwd through config.get", async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-runtime-identity-"));
    bundledSkillsDir = path.join(stateDir, "skills-empty");
    managedSkillsDir = path.join(stateDir, "managed-skills-empty");
    await fs.mkdir(bundledSkillsDir, { recursive: true });
    await fs.mkdir(managedSkillsDir, { recursive: true });

    hub = await createFridayHub({
      skillDirs: [bundledSkillsDir, managedSkillsDir],
      stateDir,
    });

    const route = hub.apiRuntime.routes.getRoutes().find((entry) => entry.operationId === "config.get");
    expect(route).toBeDefined();

    const result = await route!.handler({
      requestId: "req-runtime-config",
      receivedAt: "2026-04-19T20:30:00.000Z",
      params: {},
      query: {},
      body: null,
      headers: {},
      principal: { userId: "admin-001", role: "admin" } as never,
    }) as {
      currentConfig: {
        runtimeStateDir?: string;
        launchCwd?: string;
      };
    };

    expect(result.currentConfig.runtimeStateDir).toBe(stateDir);
    expect(result.currentConfig.launchCwd).toBe(process.cwd());
  });

  it("surfaces FRIDAY_WORKSPACE_ROOT separately from FRIDAY_STATE_DIR", async () => {
    const originalWorkspaceRoot = process.env.FRIDAY_WORKSPACE_ROOT;
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "friday-runtime-workspace-"));
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-runtime-state-"));
    bundledSkillsDir = path.join(stateDir, "skills-empty");
    managedSkillsDir = path.join(stateDir, "managed-skills-empty");
    await fs.mkdir(bundledSkillsDir, { recursive: true });
    await fs.mkdir(managedSkillsDir, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "# Friday\n", "utf8");

    try {
      process.env.FRIDAY_WORKSPACE_ROOT = workspaceRoot;
      hub = await createFridayHub({
        skillDirs: [bundledSkillsDir, managedSkillsDir],
        stateDir,
      });
      const route = hub.apiRuntime.routes.getRoutes().find((entry) => entry.operationId === "config.get");
      expect(route).toBeDefined();

      const result = await route!.handler({
        requestId: "req-runtime-config-workspace-root",
        receivedAt: "2026-05-12T00:00:00.000Z",
        params: {},
        query: {},
        body: null,
        headers: {},
        principal: { userId: "admin-001", role: "admin" } as never,
      }) as {
        currentConfig: {
          runtimeStateDir?: string;
          workspaceRoot?: string;
        };
      };

      expect(result.currentConfig.runtimeStateDir).toBe(stateDir);
      expect(result.currentConfig.workspaceRoot).toBe(workspaceRoot);
    } finally {
      if (originalWorkspaceRoot === undefined) {
        delete process.env.FRIDAY_WORKSPACE_ROOT;
      } else {
        process.env.FRIDAY_WORKSPACE_ROOT = originalWorkspaceRoot;
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
