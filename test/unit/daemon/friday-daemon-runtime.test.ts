import { describe, expect, it } from "vitest";

import {
  formatFridayDaemonStatus,
  resolveFridayDaemonLaunchSpec,
} from "../../../src/daemon/friday-daemon-runtime.js";

describe("Friday daemon runtime helpers", () => {
  it("resolves the operational runner from a source CLI module URL", () => {
    const spec = resolveFridayDaemonLaunchSpec({
      moduleUrl: "file:///repo/src/cli/friday-cli.ts",
      env: { TEST_ENV: "1" },
    });

    expect(spec.repoRoot).toBe("/repo");
    expect(spec.runnerPath).toBe("/repo/scripts/ops/friday-service-run.sh");
    expect(spec.command).toBe("bash");
    expect(spec.args).toEqual([
      "/repo/scripts/ops/friday-service-run.sh",
      "/repo",
    ]);
    expect(spec.cwd).toBe("/repo");
    expect(spec.env.TEST_ENV).toBe("1");
  });

  it("resolves the operational runner from a built CLI module URL", () => {
    const spec = resolveFridayDaemonLaunchSpec({
      moduleUrl: "file:///repo/dist/cli/friday-cli.js",
    });

    expect(spec.repoRoot).toBe("/repo");
    expect(spec.runnerPath).toBe("/repo/scripts/ops/friday-service-run.sh");
    expect(spec.args).toEqual([
      "/repo/scripts/ops/friday-service-run.sh",
      "/repo",
    ]);
  });

  it("formats running daemon status consistently", () => {
    expect(formatFridayDaemonStatus({
      running: true,
      pid: 4321,
      startedAt: "2026-03-24T00:00:00.000Z",
      uptime: 61000,
    })).toBe("Friday daemon: running (PID 4321, uptime 61s)");
  });

  it("formats stopped daemon status consistently", () => {
    expect(formatFridayDaemonStatus({
      running: false,
      pid: null,
      startedAt: null,
      uptime: null,
    })).toBe("Friday daemon: stopped");
  });
});
