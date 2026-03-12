import { describe, expect, it } from "vitest";

import { createFridaySystemLocalCompanionBridge } from "../../../src/system/companion/friday-system-local-companion-bridge.js";

function createNowIso() {
  let tick = 0;
  const start = Date.parse("2026-03-06T12:00:00.000Z");
  return () => new Date(start + tick++ * 1000).toISOString();
}

describe("createFridaySystemLocalCompanionBridge", () => {
  it("connects, captures snapshots, and advances heartbeat metadata", async () => {
    const nowIso = createNowIso();
    const bridge = createFridaySystemLocalCompanionBridge({
      id: "companion-test",
      platform: "darwin",
      nowIso,
      launchAtLoginEnabled: true,
      panicHotkey: "cmd+shift+escape",
      menuBarEnabled: true,
      overlayEnabled: true,
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

    await bridge.connect();
    const ping = await bridge.ping();
    const statusAfterConnect = await bridge.getStatus();
    const snapshot = await bridge.captureSnapshot();
    const notifications = await bridge.listNotifications();
    const acted = await bridge.actOnNotification({
      notificationId: "notif-1",
      action: "mark_read",
    });
    const arrangement = await bridge.arrangeWindows("single_focus");
    const focus = await bridge.focusTarget({ appIdentifier: "Finder" });
    const launch = await bridge.launchApp("Finder");
    const openedUrl = await bridge.openUrl("https://example.com");
    const openedProject = await bridge.openProject("/tmp/friday-system-test-workspace");
    const overlay = await bridge.setOverlayVisible(false);
    const statusAfterSnapshot = await bridge.getStatus();

    expect(bridge.isConnected()).toBe(true);
    expect(ping.ok).toBe(true);
    expect(statusAfterConnect.connected).toBe(true);
    expect(statusAfterConnect.runtimeKind).toBe("embedded");
    expect(statusAfterConnect.capabilities.surfaces.menuBar).toBe(true);
    expect(statusAfterConnect.capabilities.actions.arrange_windows).toBe("supported");
    expect(statusAfterConnect.safeMode).toBe(false);
    expect(statusAfterConnect.permissions).toEqual([]);
    expect(snapshot.frontmostAppId).toBe("app:finder");
    expect(snapshot.frontmostWindowId).toBe("window:finder:1");
    expect(snapshot.notifications).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    expect(acted?.notification.read).toBe(true);
    expect(arrangement?.arrangedWindowIds).toEqual(["window:finder:1"]);
    expect(focus?.focused).toBe(true);
    expect(launch?.appIdentifier).toBe("Finder");
    expect(openedUrl?.url).toBe("https://example.com");
    expect(openedProject?.projectPath).toBe("/tmp/friday-system-test-workspace");
    expect(overlay.visible).toBe(false);
    expect(statusAfterSnapshot.overlayVisible).toBe(false);
    expect(statusAfterSnapshot.lastHeartbeatAt).not.toBe(statusAfterConnect.lastHeartbeatAt);
  });

  it("disconnects cleanly", async () => {
    const bridge = createFridaySystemLocalCompanionBridge({
      id: "companion-test",
      platform: "darwin",
      nowIso: createNowIso(),
      launchAtLoginEnabled: true,
      panicHotkey: "cmd+shift+escape",
    });

    await bridge.connect();
    await bridge.disconnect();
    const status = await bridge.getStatus();

    expect(bridge.isConnected()).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.runtimeKind).toBe("embedded");
  });
});
