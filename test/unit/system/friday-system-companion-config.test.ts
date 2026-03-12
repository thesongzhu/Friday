import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveFridaySystemCompanionAuthToken,
  resolveFridaySystemCompanionAuthTokenFilePath,
  resolveFridaySystemCompanionPipeName,
  resolveFridaySystemCompanionServerMode,
} from "../../../src/system/companion/friday-system-companion-config.js";

describe("Friday system companion runtime config", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    while (cleanupPaths.length > 0) {
      await fs.rm(cleanupPaths.pop()!, { recursive: true, force: true });
    }
  });

  it("uses external mode only when explicitly requested", () => {
    expect(resolveFridaySystemCompanionServerMode({
      platform: "darwin",
      transportMode: "unix_socket",
      explicitServerMode: "external",
      nativeCompanionMode: "auto",
    })).toBe("external");
  });

  it("keeps embedded mode when external mode is not explicitly requested", () => {
    expect(resolveFridaySystemCompanionServerMode({
      platform: "linux",
      transportMode: "unix_socket",
      nativeCompanionMode: "auto",
    })).toBe("embedded");
    expect(resolveFridaySystemCompanionServerMode({
      platform: "darwin",
      transportMode: "unix_socket",
      nativeCompanionMode: "swift",
    })).toBe("embedded");
    expect(resolveFridaySystemCompanionServerMode({
      platform: "darwin",
      transportMode: "unix_socket",
      nativeCompanionMode: "node",
    })).toBe("embedded");
    expect(resolveFridaySystemCompanionServerMode({
      platform: "darwin",
      transportMode: "in_process",
      nativeCompanionMode: "swift",
    })).toBe("embedded");
  });

  it("forces external mode for named-pipe and non-embedded native companions", () => {
    expect(resolveFridaySystemCompanionServerMode({
      platform: "win32",
      transportMode: "named_pipe",
      nativeCompanionMode: "dotnet",
    })).toBe("external");
    expect(resolveFridaySystemCompanionServerMode({
      platform: "linux",
      transportMode: "unix_socket",
      nativeCompanionMode: "rust",
    })).toBe("external");
  });

  it("derives a stable named pipe name from the workspace", () => {
    const first = resolveFridaySystemCompanionPipeName("/tmp/friday-workspace");
    const second = resolveFridaySystemCompanionPipeName("/tmp/friday-workspace");

    expect(first).toBe(second);
    expect(first).toMatch(/^\\\\\.\\pipe\\friday-system-companion-/);
  });

  it("writes and reuses a stable auth token file", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "friday-companion-config-"));
    cleanupPaths.push(workspaceRoot);
    const tokenFilePath = resolveFridaySystemCompanionAuthTokenFilePath(workspaceRoot);

    const first = await resolveFridaySystemCompanionAuthToken({
      workspaceRoot,
      randomBytes: () => Buffer.from("a".repeat(64), "hex"),
    });
    const second = await resolveFridaySystemCompanionAuthToken({ workspaceRoot });

    expect(first.tokenFilePath).toBe(tokenFilePath);
    expect(first.token).toHaveLength(64);
    expect(second.token).toBe(first.token);
    await expect(fs.readFile(tokenFilePath, "utf8")).resolves.toBe(first.token);
  });

  it("persists an explicit auth token to the shared token file", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "friday-companion-config-"));
    cleanupPaths.push(workspaceRoot);

    const resolved = await resolveFridaySystemCompanionAuthToken({
      workspaceRoot,
      explicitToken: "manual-secret",
    });

    expect(resolved.token).toBe("manual-secret");
    await expect(fs.readFile(resolved.tokenFilePath, "utf8")).resolves.toBe("manual-secret");
  });
});
