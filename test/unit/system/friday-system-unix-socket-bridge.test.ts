import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
});
