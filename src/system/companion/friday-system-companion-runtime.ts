import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FridayDomainError } from "#errors";
import { toAppleScriptIdentifierLiteral } from "../friday-applescript.js";

import type { FridayDesktopPlatform } from "../../desktop/model/friday-desktop.types.js";
import type {
  FridaySystemAppRef,
  FridaySystemBounds,
  FridaySystemCapabilityAvailability,
  FridaySystemCompanionActionCapabilities,
  FridaySystemCompanionRuntimeKind,
  FridaySystemCompanionStatus,
  FridaySystemNotificationRef,
  FridaySystemPermissionGrant,
  FridaySystemWindowLayout,
  FridaySystemWindowRef,
  ISODateTime,
} from "../model/friday-system.types.js";
import type {
  FridaySystemCompanionFocusTargetInput,
  FridaySystemCompanionFocusTargetResult,
  FridaySystemCompanionLaunchAppResult,
  FridaySystemCompanionNotificationActionInput,
  FridaySystemCompanionNotificationActionResult,
  FridaySystemCompanionOpenProjectResult,
  FridaySystemCompanionOpenUrlResult,
  FridaySystemCompanionOverlayState,
  FridaySystemCompanionSnapshot,
  FridaySystemCompanionWindowArrangementResult,
} from "./friday-system-companion.types.js";

const execFileAsync = promisify(execFile);

export interface FridaySystemCompanionRuntimeOptions {
  id: string;
  platform: FridayDesktopPlatform | "unknown";
  nowIso: () => ISODateTime;
  runtimeKind?: FridaySystemCompanionRuntimeKind;
  launchAtLoginEnabled: boolean;
  panicHotkey: string;
  socketPath?: string;
  pipeName?: string;
  menuBarEnabled?: boolean;
  overlayEnabled?: boolean;
  appCollector?: () => Promise<FridaySystemAppRef[]>;
  windowCollector?: (apps: FridaySystemAppRef[]) => Promise<FridaySystemWindowRef[]>;
  notificationCollector?: () => Promise<FridaySystemNotificationRef[]>;
  permissionCollector?: () => Promise<FridaySystemPermissionGrant[]>;
  windowArranger?: (
    snapshot: FridaySystemCompanionSnapshot,
    layout?: FridaySystemWindowLayout,
  ) => Promise<FridaySystemCompanionWindowArrangementResult | null>;
  launchAppHandler?: (appIdentifier: string) => Promise<FridaySystemCompanionLaunchAppResult | null>;
  focusTargetHandler?: (
    input: FridaySystemCompanionFocusTargetInput,
    snapshot: FridaySystemCompanionSnapshot,
  ) => Promise<FridaySystemCompanionFocusTargetResult | null>;
  openUrlHandler?: (url: string) => Promise<FridaySystemCompanionOpenUrlResult | null>;
  openProjectHandler?: (projectPath: string) => Promise<FridaySystemCompanionOpenProjectResult | null>;
  notificationActionHandler?: (
    input: FridaySystemCompanionNotificationActionInput,
    notification: FridaySystemNotificationRef,
  ) => Promise<FridaySystemCompanionNotificationActionResult | null>;
  overlayVisibilityHandler?: (visible: boolean) => Promise<FridaySystemCompanionOverlayState>;
}

export async function collectDarwinApps(): Promise<FridaySystemAppRef[]> {
  const script = "tell application \"System Events\" to get name of every application process whose background only is false";
  const { stdout } = await execFileAsync("osascript", ["-e", script]);
  const frontmostScript = "tell application \"System Events\" to get name of first application process whose frontmost is true";
  const frontmostResult = await execFileAsync("osascript", ["-e", frontmostScript]).catch(() => ({ stdout: "" }));
  const frontmost = frontmostResult.stdout.trim();
  return stdout
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((name) => ({
      id: `app:${name.toLowerCase().replace(/\s+/g, "-")}`,
      name,
      bundleId: name,
      running: true,
      frontmost: name === frontmost,
    }));
}

export async function collectDarwinWindows(
  apps: FridaySystemAppRef[],
): Promise<FridaySystemWindowRef[]> {
  const windows: FridaySystemWindowRef[] = [];
  for (const app of apps) {
    const script =
      `tell application "System Events" to tell process "${app.name}" to get name of every window`;
    const result = await execFileAsync("osascript", ["-e", script]).catch(() => ({ stdout: "" }));
    const names = result.stdout
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    windows.push(...names.map((title, index) => ({
      id: `${app.id}:window:${index + 1}`,
      appId: app.id,
      title,
      focused: app.frontmost && index === 0,
    })));
  }
  return windows;
}

function resolveAppCollector(
  options: FridaySystemCompanionRuntimeOptions,
): () => Promise<FridaySystemAppRef[]> {
  return options.appCollector
    ?? (options.platform === "darwin" ? collectDarwinApps : async () => []);
}

function resolveWindowCollector(
  options: FridaySystemCompanionRuntimeOptions,
): (apps: FridaySystemAppRef[]) => Promise<FridaySystemWindowRef[]> {
  return options.windowCollector
    ?? (options.platform === "darwin" ? collectDarwinWindows : async () => []);
}

function resolveNotificationCollector(
  options: FridaySystemCompanionRuntimeOptions,
): () => Promise<FridaySystemNotificationRef[]> {
  return options.notificationCollector ?? (async () => []);
}

function resolvePermissionCollector(
  options: FridaySystemCompanionRuntimeOptions,
): () => Promise<FridaySystemPermissionGrant[]> {
  return options.permissionCollector ?? (async () => []);
}

function resolveWindowArranger(
  options: FridaySystemCompanionRuntimeOptions,
): (
  snapshot: FridaySystemCompanionSnapshot,
  layout?: FridaySystemWindowLayout,
) => Promise<FridaySystemCompanionWindowArrangementResult | null> {
  return options.windowArranger
    ?? (options.platform === "darwin" ? arrangeDarwinWindows : async () => null);
}

function resolveLaunchAppHandler(
  options: FridaySystemCompanionRuntimeOptions,
): (appIdentifier: string) => Promise<FridaySystemCompanionLaunchAppResult | null> {
  return options.launchAppHandler
    ?? (options.platform === "darwin" ? launchDarwinApp : async () => null);
}

function resolveFocusTargetHandler(
  options: FridaySystemCompanionRuntimeOptions,
): (
  input: FridaySystemCompanionFocusTargetInput,
  snapshot: FridaySystemCompanionSnapshot,
) => Promise<FridaySystemCompanionFocusTargetResult | null> {
  return options.focusTargetHandler
    ?? (options.platform === "darwin" ? focusDarwinTarget : async () => null);
}

function resolveOpenUrlHandler(
  options: FridaySystemCompanionRuntimeOptions,
): (url: string) => Promise<FridaySystemCompanionOpenUrlResult | null> {
  return options.openUrlHandler
    ?? (options.platform === "darwin" ? openDarwinUrl : async () => null);
}

function resolveOpenProjectHandler(
  options: FridaySystemCompanionRuntimeOptions,
): (projectPath: string) => Promise<FridaySystemCompanionOpenProjectResult | null> {
  return options.openProjectHandler
    ?? (options.platform === "darwin" ? openDarwinProject : async () => null);
}

function resolveNotificationActionHandler(
  options: FridaySystemCompanionRuntimeOptions,
): (
  input: FridaySystemCompanionNotificationActionInput,
  notification: FridaySystemNotificationRef,
) => Promise<FridaySystemCompanionNotificationActionResult | null> {
  return options.notificationActionHandler
    ?? (options.platform === "darwin" ? defaultNotificationActionHandler : async () => null);
}

function resolveOverlayVisibilityHandler(
  options: FridaySystemCompanionRuntimeOptions,
): (visible: boolean) => Promise<FridaySystemCompanionOverlayState> {
  return options.overlayVisibilityHandler
    ?? (async (visible: boolean) => ({
      visible,
      changedAt: options.nowIso(),
    }));
}

function resolveCapabilityAvailability(
  supported: boolean,
  fallback: boolean,
): FridaySystemCapabilityAvailability {
  if (supported) {
    return "supported";
  }
  if (fallback) {
    return "fallback";
  }
  return "unsupported";
}

function buildFridaySystemCompanionActionCapabilities(
  options: FridaySystemCompanionRuntimeOptions,
): FridaySystemCompanionActionCapabilities {
  const darwinDefaults = options.platform === "darwin";
  const hasLaunchHandler = darwinDefaults || options.launchAppHandler !== undefined;
  const hasFocusHandler = darwinDefaults || options.focusTargetHandler !== undefined;
  const hasUrlHandler = darwinDefaults || options.openUrlHandler !== undefined;
  const hasProjectHandler = darwinDefaults || options.openProjectHandler !== undefined;
  const hasWindowArranger = darwinDefaults || options.windowArranger !== undefined;
  const hasNotificationCollector = options.notificationCollector !== undefined;
  const hasNotificationActionHandler =
    hasNotificationCollector && (darwinDefaults || options.notificationActionHandler !== undefined);

  return {
    snapshot: "supported",
    launch_app: resolveCapabilityAvailability(hasLaunchHandler, true),
    focus: resolveCapabilityAvailability(hasFocusHandler, hasLaunchHandler),
    open_url: resolveCapabilityAvailability(hasUrlHandler, true),
    open_project: resolveCapabilityAvailability(hasProjectHandler, true),
    handoff_to_browser: resolveCapabilityAvailability(hasUrlHandler, true),
    handoff_to_terminal: resolveCapabilityAvailability(hasLaunchHandler, true),
    arrange_windows: resolveCapabilityAvailability(hasWindowArranger, false),
    notification_list: resolveCapabilityAvailability(hasNotificationCollector, false),
    read_notification: resolveCapabilityAvailability(hasNotificationCollector, false),
    notification_act: resolveCapabilityAvailability(hasNotificationActionHandler, false),
    recover_ui: "supported",
  };
}

function parseWindowIndex(windowId: string): number | null {
  const match = /:window:(\d+)$/.exec(windowId);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1]!, 10);
}

async function readDarwinDesktopBounds(): Promise<FridaySystemBounds> {
  const script = "tell application \"Finder\" to get bounds of window of desktop";
  const { stdout } = await execFileAsync("osascript", ["-e", script]);
  const values = stdout
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value));
  if (values.length !== 4) {
    throw new FridayDomainError("INTERNAL_ERROR", "Unable to read desktop bounds", { httpStatus: 500 });
  }
  return {
    x: values[0]!,
    y: values[1]!,
    width: values[2]! - values[0]!,
    height: values[3]! - values[1]!,
  };
}

async function runOpenCommand(args: string[]): Promise<void> {
  await execFileAsync("open", args);
}

async function launchDarwinApp(appIdentifier: string): Promise<FridaySystemCompanionLaunchAppResult> {
  await runOpenCommand(["-a", appIdentifier]);
  return {
    appIdentifier,
    launchedAt: new Date().toISOString(),
  };
}

async function openDarwinUrl(url: string): Promise<FridaySystemCompanionOpenUrlResult> {
  await runOpenCommand([url]);
  return {
    url,
    openedAt: new Date().toISOString(),
  };
}

async function openDarwinProject(projectPath: string): Promise<FridaySystemCompanionOpenProjectResult> {
  await runOpenCommand([projectPath]);
  return {
    projectPath,
    openedAt: new Date().toISOString(),
  };
}

function resolveFocusedAppName(
  snapshot: FridaySystemCompanionSnapshot,
  input: FridaySystemCompanionFocusTargetInput,
): string | undefined {
  if (input.appIdentifier) {
    const app = snapshot.apps.find((candidate) =>
      candidate.id === input.appIdentifier
      || candidate.bundleId === input.appIdentifier
      || candidate.name === input.appIdentifier,
    );
    return app?.name ?? input.appIdentifier;
  }
  if (input.windowId) {
    const window = snapshot.windows.find((candidate) => candidate.id === input.windowId);
    if (!window) {
      return undefined;
    }
    return snapshot.apps.find((candidate) => candidate.id === window.appId)?.name;
  }
  return undefined;
}

async function focusDarwinTarget(
  input: FridaySystemCompanionFocusTargetInput,
  snapshot: FridaySystemCompanionSnapshot,
): Promise<FridaySystemCompanionFocusTargetResult | null> {
  const appName = resolveFocusedAppName(snapshot, input);
  if (!appName) {
    return null;
  }
  const script =
    `tell application ${toAppleScriptIdentifierLiteral(appName, "app identifier")} to activate`;
  await execFileAsync("osascript", ["-e", script]);
  return {
    appIdentifier: input.appIdentifier ?? appName,
    windowId: input.windowId,
    focused: true,
    focusedAt: new Date().toISOString(),
  };
}

function computeArrangementBounds(
  count: number,
  desktop: FridaySystemBounds,
): FridaySystemBounds[] {
  const margin = 24;
  const x = desktop.x + margin;
  const y = desktop.y + margin;
  const width = Math.max(640, desktop.width - margin * 2);
  const height = Math.max(480, desktop.height - margin * 2);
  if (count <= 1) {
    return [{ x, y, width, height }];
  }
  if (count === 2) {
    const halfWidth = Math.floor((width - margin) / 2);
    return [
      { x, y, width: halfWidth, height },
      { x: x + halfWidth + margin, y, width: width - halfWidth - margin, height },
    ];
  }
  const leftWidth = Math.floor(width * 0.58);
  const rightWidth = width - leftWidth - margin;
  const rightHeight = Math.floor((height - margin) / 2);
  return [
    { x, y, width: leftWidth, height },
    { x: x + leftWidth + margin, y, width: rightWidth, height: rightHeight },
    {
      x: x + leftWidth + margin,
      y: y + rightHeight + margin,
      width: rightWidth,
      height: height - rightHeight - margin,
    },
  ];
}

async function arrangeDarwinWindows(
  snapshot: FridaySystemCompanionSnapshot,
  layout?: FridaySystemWindowLayout,
): Promise<FridaySystemCompanionWindowArrangementResult | null> {
  const appNames = new Map(snapshot.apps.map((app) => [app.id, app.name]));
  const orderedWindows = [...snapshot.windows].sort((left, right) => Number(right.focused) - Number(left.focused));
  const targetCount = layout === "single_focus"
    ? 1
    : layout === "dual_pane"
      ? 2
      : 3;
  const targetWindows = orderedWindows
    .filter((window) => appNames.has(window.appId))
    .slice(0, targetCount);
  if (targetWindows.length === 0) {
    return null;
  }

  const desktop = await readDarwinDesktopBounds();
  const bounds = computeArrangementBounds(targetWindows.length, desktop);
  const lines = targetWindows.flatMap((window, index) => {
    const appName = appNames.get(window.appId);
    const windowIndex = parseWindowIndex(window.id);
    const target = bounds[index]!;
    if (!appName || !windowIndex) {
      return [];
    }
    return [
      `tell application "System Events"`,
      `  tell process ${toAppleScriptIdentifierLiteral(appName, "app identifier")}`,
      `    set position of window ${windowIndex} to {${target.x}, ${target.y}}`,
      `    set size of window ${windowIndex} to {${target.width}, ${target.height}}`,
      "  end tell",
      "end tell",
    ];
  });

  if (lines.length === 0) {
    return null;
  }

  await execFileAsync("osascript", ["-e", lines.join("\n")]);
  const arrangedLayout = targetWindows.length === 1
    ? "single_focus"
    : targetWindows.length === 2
      ? "dual_pane"
      : "triad";
  return {
    arrangedWindowIds: targetWindows.map((window) => window.id),
    layout: layout ?? arrangedLayout,
    arrangedAt: new Date().toISOString(),
  };
}

async function defaultNotificationActionHandler(
  input: FridaySystemCompanionNotificationActionInput,
  notification: FridaySystemNotificationRef,
): Promise<FridaySystemCompanionNotificationActionResult | null> {
  if (input.action === "open") {
    if (notification.deepLinkUrl) {
      await openDarwinUrl(notification.deepLinkUrl);
    } else if (notification.sourceApp) {
      await launchDarwinApp(notification.sourceApp);
    }
  }
  return {
    notification,
    action: input.action,
    actedAt: new Date().toISOString(),
  };
}

export async function buildFridaySystemCompanionStatus(
  options: FridaySystemCompanionRuntimeOptions,
  input: {
    connected: boolean;
    authenticated: boolean;
    transportMode: "in_process" | "unix_socket" | "named_pipe";
    lastHeartbeatAt: ISODateTime;
    safeMode?: boolean;
    overlayVisible?: boolean;
  },
): Promise<FridaySystemCompanionStatus> {
  const permissions = await resolvePermissionCollector(options)().catch(() => []);
  const runtimeKind = options.runtimeKind
    ?? (input.transportMode === "in_process" ? "embedded" : "node_daemon");
  return {
    id: options.id,
    platform: options.platform,
    runtimeKind,
    connected: input.connected,
    transport: {
      mode: input.transportMode,
      protocol: "jsonrpc-2.0",
      authenticated: input.authenticated,
      socketPath: options.socketPath,
      pipeName: options.pipeName,
    },
    launchAtLoginEnabled: options.launchAtLoginEnabled,
    panicHotkey: options.panicHotkey,
    safeMode: input.safeMode ?? false,
    overlayVisible: input.overlayVisible ?? (options.overlayEnabled ?? false),
    lastHeartbeatAt: input.lastHeartbeatAt,
    capabilities: {
      surfaces: {
        launchAtLogin: options.launchAtLoginEnabled,
        menuBar: options.menuBarEnabled ?? false,
        overlay: options.overlayEnabled ?? false,
        globalHotkey: true,
        windowInventory: true,
        notificationIntake: options.notificationCollector !== undefined,
        screenCapture: true,
      },
      actions: buildFridaySystemCompanionActionCapabilities(options),
    },
    permissions,
  };
}

export async function captureFridaySystemCompanionSnapshot(
  options: FridaySystemCompanionRuntimeOptions,
): Promise<FridaySystemCompanionSnapshot> {
  const apps = await resolveAppCollector(options)().catch(() => []);
  const windows = await resolveWindowCollector(options)(apps).catch(() => []);
  const notifications = await resolveNotificationCollector(options)().catch(() => []);
  return {
    apps,
    windows,
    notifications,
    frontmostAppId: apps.find((app) => app.frontmost)?.id,
    frontmostWindowId: windows.find((window) => window.focused)?.id,
  };
}

export async function arrangeFridaySystemCompanionWindows(
  options: FridaySystemCompanionRuntimeOptions,
  layout?: FridaySystemWindowLayout,
): Promise<FridaySystemCompanionWindowArrangementResult | null> {
  const snapshot = await captureFridaySystemCompanionSnapshot(options);
  return resolveWindowArranger(options)(snapshot, layout);
}

export interface FridaySystemCompanionRuntimeController {
  ping(): Promise<{ ok: true; serverTime: ISODateTime }>;
  getStatus(input: {
    connected: boolean;
    authenticated: boolean;
    transportMode: "in_process" | "unix_socket" | "named_pipe";
    lastHeartbeatAt: ISODateTime;
  }): Promise<FridaySystemCompanionStatus>;
  captureSnapshot(): Promise<FridaySystemCompanionSnapshot>;
  arrangeWindows(layout?: FridaySystemWindowLayout): Promise<FridaySystemCompanionWindowArrangementResult | null>;
  launchApp(appIdentifier: string): Promise<FridaySystemCompanionLaunchAppResult | null>;
  focusTarget(input: FridaySystemCompanionFocusTargetInput): Promise<FridaySystemCompanionFocusTargetResult | null>;
  openUrl(url: string): Promise<FridaySystemCompanionOpenUrlResult | null>;
  openProject(projectPath: string): Promise<FridaySystemCompanionOpenProjectResult | null>;
  listNotifications(): Promise<FridaySystemNotificationRef[]>;
  actOnNotification(
    input: FridaySystemCompanionNotificationActionInput,
  ): Promise<FridaySystemCompanionNotificationActionResult | null>;
  setOverlayVisible(visible: boolean): Promise<FridaySystemCompanionOverlayState>;
}

export function createFridaySystemCompanionRuntimeController(
  options: FridaySystemCompanionRuntimeOptions,
): FridaySystemCompanionRuntimeController {
  const notificationState = new Map<string, { read: boolean; dismissed: boolean }>();
  let overlayVisible = options.overlayEnabled ?? false;
  let safeMode = false;

  function mergeNotifications(
    notifications: readonly FridaySystemNotificationRef[],
  ): FridaySystemNotificationRef[] {
    const visible: FridaySystemNotificationRef[] = [];
    for (const notification of notifications) {
      const state = notificationState.get(notification.id);
      if (state?.dismissed) {
        continue;
      }
      visible.push({
        ...notification,
        read: state?.read ?? notification.read,
      });
    }
    return visible;
  }

  async function captureSnapshotWithState(): Promise<FridaySystemCompanionSnapshot> {
    const snapshot = await captureFridaySystemCompanionSnapshot(options);
    return {
      ...snapshot,
      notifications: mergeNotifications(snapshot.notifications),
    };
  }

  async function listNotificationsWithState(): Promise<FridaySystemNotificationRef[]> {
    const snapshot = await captureSnapshotWithState();
    return snapshot.notifications;
  }

  return {
    async ping() {
      return {
        ok: true,
        serverTime: options.nowIso(),
      };
    },

    async getStatus(input) {
      return buildFridaySystemCompanionStatus(options, {
        ...input,
        safeMode,
        overlayVisible,
      });
    },

    async captureSnapshot() {
      return captureSnapshotWithState();
    },

    async arrangeWindows(layout) {
      return arrangeFridaySystemCompanionWindows(options, layout);
    },

    async launchApp(appIdentifier) {
      return resolveLaunchAppHandler(options)(appIdentifier);
    },

    async focusTarget(input) {
      const snapshot = await captureSnapshotWithState();
      return resolveFocusTargetHandler(options)(input, snapshot);
    },

    async openUrl(url) {
      return resolveOpenUrlHandler(options)(url);
    },

    async openProject(projectPath) {
      return resolveOpenProjectHandler(options)(projectPath);
    },

    async listNotifications() {
      return listNotificationsWithState();
    },

    async actOnNotification(input) {
      const notifications = await listNotificationsWithState();
      const notification = notifications.find((item) => item.id === input.notificationId);
      if (!notification) {
        return null;
      }
      const current = notificationState.get(notification.id) ?? {
        read: notification.read,
        dismissed: false,
      };
      if (input.action === "mark_read" || input.action === "open") {
        current.read = true;
      }
      if (input.action === "dismiss") {
        current.dismissed = true;
        current.read = true;
      }
      notificationState.set(notification.id, current);
      const updatedNotification: FridaySystemNotificationRef = {
        ...notification,
        read: current.read,
      };
      return resolveNotificationActionHandler(options)(input, updatedNotification);
    },

    async setOverlayVisible(visible) {
      safeMode = false;
      overlayVisible = visible;
      const result = await resolveOverlayVisibilityHandler(options)(visible);
      overlayVisible = result.visible;
      return result;
    },
  };
}
