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
    await expect(fs.stat(path.dirname(tokenFilePath))).resolves.toMatchObject({
      mode: expect.any(Number),
    });
    expect((await fs.stat(path.dirname(tokenFilePath))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(tokenFilePath)).mode & 0o777).toBe(0o600);
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
    expect((await fs.stat(resolved.tokenFilePath)).mode & 0o777).toBe(0o600);
  });

  it("repairs token file mode when reusing an existing token", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "friday-companion-config-"));
    cleanupPaths.push(workspaceRoot);
    const tokenFilePath = resolveFridaySystemCompanionAuthTokenFilePath(workspaceRoot);
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true, mode: 0o755 });
    await fs.chmod(path.dirname(tokenFilePath), 0o755);
    await fs.writeFile(tokenFilePath, "existing-token", { encoding: "utf8", mode: 0o644 });
    await fs.chmod(tokenFilePath, 0o644);

    const resolved = await resolveFridaySystemCompanionAuthToken({ workspaceRoot });

    expect(resolved.token).toBe("existing-token");
    expect((await fs.stat(path.dirname(tokenFilePath))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(tokenFilePath)).mode & 0o777).toBe(0o600);
  });

  it("rotates the companion token only when explicitly requested", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "friday-companion-config-"));
    cleanupPaths.push(workspaceRoot);
    const tokenFilePath = resolveFridaySystemCompanionAuthTokenFilePath(workspaceRoot);
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true });
    await fs.writeFile(tokenFilePath, "old-token", { encoding: "utf8", mode: 0o600 });

    const resolved = await resolveFridaySystemCompanionAuthToken({
      workspaceRoot,
      forceRotate: true,
      randomBytes: () => Buffer.from("b".repeat(64), "hex"),
    });

    expect(resolved.token).not.toBe("old-token");
    expect(resolved.token).toBe("b".repeat(64));
    await expect(fs.readFile(tokenFilePath, "utf8")).resolves.toBe("b".repeat(64));
  });

  it("does not chmod an explicit token file parent directory as a private run directory", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "friday-companion-config-"));
    const externalTokenDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-companion-external-token-"));
    cleanupPaths.push(workspaceRoot, externalTokenDir);
    await fs.chmod(externalTokenDir, 0o755);
    const explicitTokenFilePath = path.join(externalTokenDir, "companion.token");

    const resolved = await resolveFridaySystemCompanionAuthToken({
      workspaceRoot,
      explicitToken: "external-token",
      explicitTokenFilePath,
    });

    expect(resolved.tokenFilePath).toBe(explicitTokenFilePath);
    expect((await fs.stat(externalTokenDir)).mode & 0o777).toBe(0o755);
    expect((await fs.stat(explicitTokenFilePath)).mode & 0o777).toBe(0o600);
  });
});
