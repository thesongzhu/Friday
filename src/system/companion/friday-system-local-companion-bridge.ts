import type {
  FridaySystemCompanionBridge,
} from "./friday-system-companion.types.js";
import {
  createFridaySystemCompanionRuntimeController,
  type FridaySystemCompanionRuntimeOptions,
} from "./friday-system-companion-runtime.js";

export interface CreateFridaySystemLocalCompanionBridgeOptions
  extends FridaySystemCompanionRuntimeOptions {}

export function createFridaySystemLocalCompanionBridge(
  options: CreateFridaySystemLocalCompanionBridgeOptions,
): FridaySystemCompanionBridge {
  let connected = false;
  let lastHeartbeatAt = options.nowIso();
  const controller = createFridaySystemCompanionRuntimeController(options);

  return {
    async connect(): Promise<void> {
      connected = true;
      lastHeartbeatAt = options.nowIso();
    },

    async disconnect(): Promise<void> {
      connected = false;
      lastHeartbeatAt = options.nowIso();
    },

    isConnected(): boolean {
      return connected;
    },

    async ping() {
      lastHeartbeatAt = options.nowIso();
      return controller.ping();
    },

    async getStatus() {
      lastHeartbeatAt = options.nowIso();
      return controller.getStatus({
        connected,
        authenticated: true,
        transportMode: "in_process",
        lastHeartbeatAt,
      });
    },

    async captureSnapshot() {
      lastHeartbeatAt = options.nowIso();
      return controller.captureSnapshot();
    },

    async arrangeWindows(layout) {
      lastHeartbeatAt = options.nowIso();
      return controller.arrangeWindows(layout);
    },

    async launchApp(appIdentifier) {
      lastHeartbeatAt = options.nowIso();
      return controller.launchApp(appIdentifier);
    },

    async focusTarget(input) {
      lastHeartbeatAt = options.nowIso();
      return controller.focusTarget(input);
    },

    async openUrl(url) {
      lastHeartbeatAt = options.nowIso();
      return controller.openUrl(url);
    },

    async openProject(projectPath) {
      lastHeartbeatAt = options.nowIso();
      return controller.openProject(projectPath);
    },

    async listNotifications() {
      lastHeartbeatAt = options.nowIso();
      return controller.listNotifications();
    },

    async actOnNotification(input) {
      lastHeartbeatAt = options.nowIso();
      return controller.actOnNotification(input);
    },

    async setOverlayVisible(visible) {
      lastHeartbeatAt = options.nowIso();
      return controller.setOverlayVisible(visible);
    },

    async showGuideOverlay(command) {
      lastHeartbeatAt = options.nowIso();
      return controller.showGuideOverlay(command);
    },

    async clearGuideOverlay() {
      lastHeartbeatAt = options.nowIso();
      return controller.clearGuideOverlay();
    },
  };
}
