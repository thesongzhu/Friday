import type {
  FridaySystemCompanionBridge,
} from "./friday-system-companion.types.js";
import {
  FRIDAY_SYSTEM_COMPANION_ACTIONS,
  type FridaySystemCompanionActionCapabilities,
  type FridaySystemCompanionStatus,
  type FridaySystemCompanionSurfaceCapabilities,
} from "../model/friday-system.types.js";
import {
  buildFridaySystemCompanionStatus,
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

export function createFridaySystemUnavailableCompanionBridge(
  options: CreateFridaySystemLocalCompanionBridgeOptions & { unavailableReason?: string },
): FridaySystemCompanionBridge {
  const unavailableMessage = options.unavailableReason ?? "System companion is unavailable";
  const fail = async (): Promise<never> => {
    throw new Error(unavailableMessage);
  };
  const unsupportedActions = Object.fromEntries(
    FRIDAY_SYSTEM_COMPANION_ACTIONS.map((action) => [action, "unsupported"]),
  ) as FridaySystemCompanionActionCapabilities;
  const unsupportedSurfaces: FridaySystemCompanionSurfaceCapabilities = {
    launchAtLogin: false,
    menuBar: false,
    overlay: false,
    globalHotkey: false,
    windowInventory: false,
    notificationIntake: false,
    screenCapture: false,
  };
  const buildUnavailableStatus = async (): Promise<FridaySystemCompanionStatus> => {
    const status = await buildFridaySystemCompanionStatus(options, {
      connected: false,
      authenticated: false,
      transportMode: "unix_socket",
      lastHeartbeatAt: options.nowIso(),
    });
    return {
      ...status,
      capabilities: {
        surfaces: unsupportedSurfaces,
        actions: unsupportedActions,
      },
    };
  };

  const unavailableOperation = async (): Promise<never> => {
    throw new Error(unavailableMessage);
  };

  return {
    connect: fail,
    async disconnect(): Promise<void> {},
    isConnected(): boolean {
      return false;
    },
    ping: fail,
    async getStatus() {
      return buildUnavailableStatus();
    },
    captureSnapshot: unavailableOperation,
    arrangeWindows: unavailableOperation,
    launchApp: unavailableOperation,
    focusTarget: unavailableOperation,
    openUrl: unavailableOperation,
    openProject: unavailableOperation,
    listNotifications: unavailableOperation,
    actOnNotification: unavailableOperation,
    setOverlayVisible: unavailableOperation,
    showGuideOverlay: unavailableOperation,
    clearGuideOverlay: unavailableOperation,
  };
}
