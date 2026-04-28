import type {
  FridaySystemAppRef,
  FridaySystemCompanionStatus,
  FridaySystemNotificationAction,
  FridaySystemNotificationRef,
  FridaySystemWindowLayout,
  FridaySystemWindowRef,
} from "../model/friday-system.types.js";
import type { FridayGuideLensOverlayCommand } from "../../guide-lens/model/friday-guide-lens.types.js";

export interface FridaySystemCompanionSnapshot {
  apps: FridaySystemAppRef[];
  windows: FridaySystemWindowRef[];
  notifications: FridaySystemNotificationRef[];
  frontmostAppId?: string;
  frontmostWindowId?: string;
}

export interface FridaySystemCompanionWindowArrangementResult {
  arrangedWindowIds: string[];
  layout: FridaySystemWindowLayout;
  arrangedAt: string;
}

export interface FridaySystemCompanionFocusTargetInput {
  appIdentifier?: string;
  windowId?: string;
}

export interface FridaySystemCompanionFocusTargetResult {
  appIdentifier?: string;
  windowId?: string;
  focused: boolean;
  focusedAt: string;
}

export interface FridaySystemCompanionLaunchAppResult {
  appIdentifier: string;
  launchedAt: string;
}

export interface FridaySystemCompanionOpenUrlResult {
  url: string;
  openedAt: string;
}

export interface FridaySystemCompanionOpenProjectResult {
  projectPath: string;
  openedAt: string;
}

export interface FridaySystemCompanionNotificationActionInput {
  notificationId: string;
  action: FridaySystemNotificationAction;
}

export interface FridaySystemCompanionNotificationActionResult {
  notification: FridaySystemNotificationRef;
  action: FridaySystemNotificationAction;
  actedAt: string;
}

export interface FridaySystemCompanionOverlayState {
  visible: boolean;
  changedAt: string;
  guideOverlay?: FridayGuideLensOverlayCommand;
}

export interface FridaySystemCompanionBridge {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  ping(): Promise<{ ok: boolean; serverTime: string }>;
  getStatus(): Promise<FridaySystemCompanionStatus>;
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
  showGuideOverlay(command: FridayGuideLensOverlayCommand): Promise<FridaySystemCompanionOverlayState>;
  clearGuideOverlay(): Promise<FridaySystemCompanionOverlayState>;
}
