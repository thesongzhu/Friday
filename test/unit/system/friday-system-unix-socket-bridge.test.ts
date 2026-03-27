import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createFridaySystemUnixSocketCompanionServer } from "../../../src/system/companion/friday-system-unix-socket-companion-server.js";
import { createFridaySystemUnixSocketBridge } from "../../../src/system/companion/friday-system-unix-socket-bridge.js";

function createNowIso() {
  let tick = 0;
  const start = Date.parse("2026-03-06T12:00:00.000Z");
  return () => new Date(start + tick++ * 1000).toISOString();
}

describe("Friday system unix socket companion transport", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    while (cleanupPaths.length > 0) {
      const dir = cleanupPaths.pop()!;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("authenticates over a unix socket and returns status and snapshots", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-system-socket-"));
    cleanupPaths.push(tempDir);
    const socketPath = path.join(tempDir, "companion.sock");
    const nowIso = createNowIso();
    const server = createFridaySystemUnixSocketCompanionServer({
      id: "companion-socket",
      platform: "darwin",
      nowIso,
      authToken: "secret-token",
      socketPath,
      launchAtLoginEnabled: true,
      panicHotkey: "cmd+shift+escape",
      menuBarEnabled: true,
      overlayEnabled: true,
      permissionCollector: async () => [
        {
          id: "perm-1",
          permission: "accessibility",
          status: "granted",
        },
      ],
      appCollector: async () => [
        {
          id: "app:finder",
          name: "Finder",
          bundleId: "com.apple.finder",
          running: true,
          frontmost: true,
        },
      ],
      windowCollector: async () => [
        {
          id: "window:finder:1",
          appId: "app:finder",
          title: "Workspace",
          focused: true,
        },
      ],
      notificationCollector: async () => [
        {
          id: "notif-1",
          sourceApp: "Finder",
          title: "Build finished",
          receivedAt: "2026-03-06T12:00:00.000Z",
          read: false,
        },
      ],
      windowArranger: async () => ({
        arrangedWindowIds: ["window:finder:1"],
        layout: "single_focus",
        arrangedAt: "2026-03-06T12:00:00.000Z",
      }),
      launchAppHandler: async (appIdentifier: string) => ({
        appIdentifier,
        launchedAt: "2026-03-06T12:00:00.000Z",
      }),
      focusTargetHandler: async (input) => ({
        appIdentifier: input.appIdentifier,
        windowId: input.windowId,
        focused: true,
        focusedAt: "2026-03-06T12:00:00.000Z",
      }),
      openUrlHandler: async (url: string) => ({
        url,
        openedAt: "2026-03-06T12:00:00.000Z",
      }),
      openProjectHandler: async (projectPath: string) => ({
        projectPath,
        openedAt: "2026-03-06T12:00:00.000Z",
      }),
      overlayVisibilityHandler: async (visible: boolean) => ({
        visible,
        changedAt: "2026-03-06T12:00:00.000Z",
      }),
    });

    await server.start();
    const bridge = createFridaySystemUnixSocketBridge({
      id: "companion-socket",
      platform: "darwin",
      nowIso,
      authToken: "secret-token",
      socketPath,
      launchAtLoginEnabled: true,
      panicHotkey: "cmd+shift+escape",
      menuBarEnabled: true,
      overlayEnabled: true,
    });

    await bridge.connect();
    const ping = await bridge.ping();
    const status = await bridge.getStatus();
    const snapshot = await bridge.captureSnapshot();
    const notifications = await bridge.listNotifications();
    const acted = await bridge.actOnNotification({
      notificationId: "notif-1",
      action: "dismiss",
    });
    const arrangement = await bridge.arrangeWindows("single_focus");
    const launch = await bridge.launchApp("Finder");
    const focus = await bridge.focusTarget({ appIdentifier: "Finder" });
    const openedUrl = await bridge.openUrl("https://example.com");
    const openedProject = await bridge.openProject("/tmp/friday-system-test-workspace");
    const overlay = await bridge.setOverlayVisible(false);

    expect(bridge.isConnected()).toBe(true);
    expect(ping.ok).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.runtimeKind).toBe("node_daemon");
    expect(status.transport.mode).toBe("unix_socket");
    expect(status.transport.authenticated).toBe(true);
    expect(status.safeMode).toBe(false);
    expect(status.permissions[0]?.permission).toBe("accessibility");
    expect(snapshot.frontmostAppId).toBe("app:finder");
    expect(snapshot.frontmostWindowId).toBe("window:finder:1");
    expect(notifications).toHaveLength(1);
    expect(acted?.action).toBe("dismiss");
    expect(arrangement?.layout).toBe("single_focus");
    expect(launch?.appIdentifier).toBe("Finder");
    expect(focus?.focused).toBe(true);
    expect(openedUrl?.url).toBe("https://example.com");
    expect(openedProject?.projectPath).toBe("/tmp/friday-system-test-workspace");
    expect(overlay.visible).toBe(false);
    expect((await bridge.getStatus()).overlayVisible).toBe(false);

    await bridge.disconnect();
    await server.stop();
  });

  it("surfaces an unauthenticated degraded status when the auth token is wrong", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-system-socket-"));
    cleanupPaths.push(tempDir);
    const socketPath = path.join(tempDir, "companion.sock");
    const nowIso = createNowIso();
    const server = createFridaySystemUnixSocketCompanionServer({
      id: "companion-socket",
      platform: "darwin",
      nowIso,
      authToken: "expected-token",
      socketPath,
      launchAtLoginEnabled: true,
      panicHotkey: "cmd+shift+escape",
    });

    await server.start();
    const bridge = createFridaySystemUnixSocketBridge({
      id: "companion-socket",
      platform: "darwin",
      nowIso,
      authToken: "wrong-token",
      socketPath,
      launchAtLoginEnabled: true,
      panicHotkey: "cmd+shift+escape",
    });

    await expect(bridge.connect()).rejects.toThrow("Unauthorized");
    const status = await bridge.getStatus();
    const snapshot = await bridge.captureSnapshot();

    expect(bridge.isConnected()).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.runtimeKind).toBe("node_daemon");
    expect(status.transport.authenticated).toBe(false);
    expect(snapshot.apps).toEqual([]);

    await server.stop();
  });

  it("deduplicates repeated captureSnapshot warnings for the same transport error", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-system-socket-"));
    cleanupPaths.push(tempDir);
    const socketPath = path.join(tempDir, "companion.sock");
    const nowIso = createNowIso();
    const server = createFridaySystemUnixSocketCompanionServer({
      id: "companion-socket",
      platform: "darwin",
      nowIso,
      authToken: "expected-token",
      socketPath,
      launchAtLoginEnabled: true,
      panicHotkey: "cmd+shift+escape",
    });
    await server.start();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const bridge = createFridaySystemUnixSocketBridge({
        id: "companion-socket",
        platform: "darwin",
        nowIso,
        authToken: "wrong-token",
        socketPath,
        launchAtLoginEnabled: true,
        panicHotkey: "cmd+shift+escape",
      });

      await bridge.captureSnapshot();
      await bridge.captureSnapshot();

      expect(
        warnSpy.mock.calls.filter(([message]) =>
          String(message).includes("[friday][unix-socket-bridge] captureSnapshot: Unauthorized"),
        ),
      ).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
      await server.stop();
    }
  });

  it("silently falls back to an empty snapshot when captureSnapshot times out", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-system-socket-"));
    cleanupPaths.push(tempDir);
    const socketPath = path.join(tempDir, "companion.sock");
    const nowIso = createNowIso();
    const openSockets = new Set<net.Socket>();
    const hangingServer = net.createServer((socket) => {
      openSockets.add(socket);
      socket.on("close", () => {
        openSockets.delete(socket);
      });
      // Intentionally never respond so the bridge exercises its timeout fallback.
    });
    await new Promise<void>((resolve, reject) => {
      hangingServer.once("error", reject);
      hangingServer.listen(socketPath, () => resolve());
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const bridge = createFridaySystemUnixSocketBridge({
        id: "companion-socket",
        platform: "darwin",
        nowIso,
        authToken: "secret-token",
        socketPath,
        launchAtLoginEnabled: true,
        panicHotkey: "cmd+shift+escape",
        requestTimeoutMs: 10,
      });

      const snapshot = await bridge.captureSnapshot();

      expect(snapshot).toEqual({
        apps: [],
        windows: [],
        notifications: [],
      });
      expect(
        warnSpy.mock.calls.filter(([message]) =>
          String(message).includes("[friday][unix-socket-bridge] captureSnapshot:"),
        ),
      ).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
      for (const socket of openSockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        hangingServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("deduplicates repeated getStatus warnings for missing sockets with different temp paths", async () => {
    const tempDirA = await fs.mkdtemp(path.join(os.tmpdir(), "friday-system-socket-"));
    const tempDirB = await fs.mkdtemp(path.join(os.tmpdir(), "friday-system-socket-"));
    cleanupPaths.push(tempDirA, tempDirB);
    const nowIso = createNowIso();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const bridgeA = createFridaySystemUnixSocketBridge({
        id: "companion-socket-a",
        platform: "darwin",
        nowIso,
        authToken: "secret-token",
        socketPath: path.join(tempDirA, "companion.sock"),
        launchAtLoginEnabled: true,
        panicHotkey: "cmd+shift+escape",
      });
      const bridgeB = createFridaySystemUnixSocketBridge({
        id: "companion-socket-b",
        platform: "darwin",
        nowIso,
        authToken: "secret-token",
        socketPath: path.join(tempDirB, "companion.sock"),
        launchAtLoginEnabled: true,
        panicHotkey: "cmd+shift+escape",
      });

      await bridgeA.getStatus();
      await bridgeB.getStatus();

      expect(
        warnSpy.mock.calls.filter(([message]) =>
          String(message).includes("[friday][unix-socket-bridge] getStatus: connect ENOENT"),
        ),
      ).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
