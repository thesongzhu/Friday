import { describe, it, expect } from "vitest";
import { resolveFridayDaemonPaths } from "../../../src/daemon/friday-daemon-paths.js";

describe("resolveFridayDaemonPaths", () => {
  it("creates paths under daemon subdirectory", () => {
    const paths = resolveFridayDaemonPaths("/home/user/.friday");

    expect(paths.runtimeDir).toBe("/home/user/.friday/daemon");
    expect(paths.pidFile).toBe("/home/user/.friday/daemon/friday.pid");
    expect(paths.stdoutLog).toBe("/home/user/.friday/daemon/stdout.log");
    expect(paths.stderrLog).toBe("/home/user/.friday/daemon/stderr.log");
  });

  it("handles trailing slash in state dir", () => {
    const paths = resolveFridayDaemonPaths("/var/lib/friday");

    expect(paths.runtimeDir).toBe("/var/lib/friday/daemon");
    expect(paths.pidFile).toContain("friday.pid");
  });
});
