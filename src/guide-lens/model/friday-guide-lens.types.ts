import type { FridaySystemSnapshot } from "../../system/model/friday-system.types.js";

export type ISODateTime = string;
export type UUID = string;

export const FRIDAY_GUIDE_LENS_SURFACES = [
  "native_desktop",
  "browser",
  "friday_web",
  "remote_session",
  "screenshot",
] as const;

export const FRIDAY_GUIDE_LENS_STATUSES = [
  "idle",
  "looking",
  "guiding",
  "waiting_for_user",
  "checking",
  "blocked",
  "completed",
] as const;

export const FRIDAY_GUIDE_LENS_ELEMENT_SOURCES = [
  "accessibility",
  "ocr",
  "dom",
  "system_window",
  "parser",
  "manual",
] as const;

export const FRIDAY_GUIDE_LENS_OVERLAY_MODES = [
  "avatar_bubble",
  "focus_frame",
  "cursor_ghost",
  "speech_bubble",
  "scroll_hint",
  "page_transition",
  "numbered_marks",
  "candidate_picker",
  "confirm_step",
  "blocked",
  "clear",
] as const;

export const FRIDAY_GUIDE_LENS_AVATAR_KINDS = [
  "default_f",
  "profile_image",
  "local_image",
] as const;

export const FRIDAY_GUIDE_LENS_MUTATING_ACTIONS = [
  "click",
  "double_click",
  "right_click",
  "type",
  "keypress",
  "hotkey",
  "scroll",
  "drag",
  "drop",
  "clipboard_write",
  "file_write",
  "file_delete",
  "file_move",
  "launch_app",
  "close_app",
  "open_url",
  "approve",
  "deny",
  "notification_act",
] as const;

export type FridayGuideLensSurface = (typeof FRIDAY_GUIDE_LENS_SURFACES)[number];
export type FridayGuideLensStatus = (typeof FRIDAY_GUIDE_LENS_STATUSES)[number];
export type FridayGuideLensElementSource = (typeof FRIDAY_GUIDE_LENS_ELEMENT_SOURCES)[number];
export type FridayGuideLensOverlayMode = (typeof FRIDAY_GUIDE_LENS_OVERLAY_MODES)[number];
export type FridayGuideLensAvatarKind = (typeof FRIDAY_GUIDE_LENS_AVATAR_KINDS)[number];
export type FridayGuideLensMutatingAction = (typeof FRIDAY_GUIDE_LENS_MUTATING_ACTIONS)[number];

export interface FridayGuideLensBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FridayGuideLensScreen {
  width: number;
  height: number;
  scaleFactor?: number;
}

export interface FridayGuideLensAvatarPreference {
  kind: FridayGuideLensAvatarKind;
  imageUrl?: string;
  localPath?: string;
  initials?: string;
  sizePx: number;
}

export interface FridayGuideLensPreferences {
  enabled: boolean;
  triggerPolicy: "manual" | "confirm_first" | "trusted_context_auto";
  defaultSurface: FridayGuideLensSurface;
  overlayStyle: "restrained_premium";
  focusColor: "blue";
  dimBackground: false;
  clickThroughOverlay: true;
  bubbleControlsEnabled: true;
  sensitiveScreenConfirm: true;
  localOnlyByDefault: true;
  screenshotAutoAnalyze: "manual_upload_only" | "trusted_opt_in_watch";
  chatboxPolicy: "ask_when_ambiguous" | "always_after_screenshot" | "never_auto_open";
  parserProvider: "local_none" | "omniparser" | "midscene" | "custom";
  avatar: FridayGuideLensAvatarPreference;
}

export interface FridayGuideLensElement {
  id: string;
  role: string;
  label?: string;
  text?: string;
  description?: string;
  bounds?: FridayGuideLensBounds;
  source: FridayGuideLensElementSource;
  confidence: number;
  interactable: boolean;
  enabled?: boolean;
  focused?: boolean;
  sensitive?: boolean;
  appId?: string;
  windowId?: string;
  metadata?: Record<string, unknown>;
}

export interface FridayGuideLensRedaction {
  kind: "api_key" | "password" | "token" | "secret" | "sensitive_text";
  replacement: string;
  source: "visible_text" | "screenshot_text" | "element_text";
  count: number;
}

export interface FridayGuideLensParserStats {
  provider: FridayGuideLensPreferences["parserProvider"];
  used: boolean;
  latencyMs?: number;
  tokenEstimate: number;
  fallbackReason?: string;
}

export interface FridayGuideLensParserRequest {
  provider: Exclude<FridayGuideLensPreferences["parserProvider"], "local_none">;
  snapshot: FridayGuideLensSnapshotRequest;
}

export interface FridayGuideLensParserResult {
  provider?: FridayGuideLensPreferences["parserProvider"];
  used?: boolean;
  visibleText?: string;
  screenshotText?: string;
  elements?: FridayGuideLensElement[];
  latencyMs?: number;
  fallbackReason?: string;
  metadata?: Record<string, unknown>;
}

export interface FridayGuideLensParserAdapter {
  parse(req: FridayGuideLensParserRequest): Promise<FridayGuideLensParserResult>;
}

export interface FridayGuideLensUiMap {
  id: UUID;
  capturedAt: ISODateTime;
  surface: FridayGuideLensSurface;
  objective?: string;
  screen?: FridayGuideLensScreen;
  app?: {
    id?: string;
    name?: string;
    bundleId?: string;
  };
  window?: {
    id?: string;
    title?: string;
    bounds?: FridayGuideLensBounds;
  };
  visibleText: string;
  elements: FridayGuideLensElement[];
  redactions: FridayGuideLensRedaction[];
  parserStats: FridayGuideLensParserStats;
  systemSnapshot?: Pick<
    FridaySystemSnapshot,
    "capturedAt" | "platform" | "frontmostAppId" | "frontmostWindowId"
  >;
}

export interface FridayGuideLensOverlayStep {
  index: number;
  total?: number;
  label?: string;
  done?: boolean;
}

export interface FridayGuideLensOverlayCandidate {
  elementId: string;
  label: string;
  bounds?: FridayGuideLensBounds;
  confidence: number;
}

export interface FridayGuideLensOverlayCommand {
  id: UUID;
  sessionId: UUID;
  mode: FridayGuideLensOverlayMode;
  surface: FridayGuideLensSurface;
  message: string;
  targetElementId?: string;
  targetBounds?: FridayGuideLensBounds;
  candidates?: FridayGuideLensOverlayCandidate[];
  step?: FridayGuideLensOverlayStep;
  avatar: FridayGuideLensAvatarPreference;
  tone: "calm" | "checking" | "blocked" | "success";
  focusColor: "blue";
  dimBackground: false;
  clickThrough: true;
  bubbleControlsEnabled: boolean;
  createdAt: ISODateTime;
  expiresAt?: ISODateTime;
  metadata?: Record<string, unknown>;
}

export interface FridayGuideLensSession {
  id: UUID;
  status: FridayGuideLensStatus;
  surface: FridayGuideLensSurface;
  objective?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  uiMap?: FridayGuideLensUiMap;
  overlay?: FridayGuideLensOverlayCommand;
  awaitingUser?: {
    action: "click" | "type" | "scroll" | "open_page" | "confirm" | "clarify";
    reason: string;
    targetElementId?: string;
  };
  lastVerification?: FridayGuideLensVerificationResult;
  events: FridayGuideLensEvent[];
}

export interface FridayGuideLensEvent {
  id: UUID;
  sessionId: UUID;
  event:
    | "guide_lens.session.started"
    | "guide_lens.snapshot.captured"
    | "guide_lens.target.resolved"
    | "guide_lens.overlay.shown"
    | "guide_lens.overlay.cleared"
    | "guide_lens.screenshot.analyzed"
    | "guide_lens.verification.completed"
    | "guide_lens.blocked";
  emittedAt: ISODateTime;
  payload: Record<string, unknown>;
}

export interface FridayGuideLensSnapshotRequest {
  sessionId?: UUID;
  surface?: FridayGuideLensSurface;
  objective?: string;
  visibleText?: string;
  screenshotText?: string;
  screen?: FridayGuideLensScreen;
  elements?: FridayGuideLensElement[];
  systemSnapshot?: FridaySystemSnapshot;
  parser?: {
    provider?: FridayGuideLensPreferences["parserProvider"];
    used?: boolean;
    latencyMs?: number;
    fallbackReason?: string;
  };
}

export interface FridayGuideLensResolveTargetRequest {
  sessionId?: UUID;
  instruction: string;
  uiMap?: FridayGuideLensUiMap;
  maxCandidates?: number;
}

export interface FridayGuideLensTargetResolution {
  status: "resolved" | "ambiguous" | "not_found";
  instruction: string;
  target?: FridayGuideLensElement;
  alternatives: FridayGuideLensElement[];
  confidence: number;
  reason: string;
  overlay: FridayGuideLensOverlayCommand;
  requiredUserAction?: FridayGuideLensSession["awaitingUser"];
}

export interface FridayGuideLensShowOverlayRequest {
  sessionId?: UUID;
  mode?: FridayGuideLensOverlayMode;
  message: string;
  targetElementId?: string;
  targetBounds?: FridayGuideLensBounds;
  candidates?: FridayGuideLensOverlayCandidate[];
  step?: FridayGuideLensOverlayStep;
  tone?: FridayGuideLensOverlayCommand["tone"];
  surface?: FridayGuideLensSurface;
  expiresInMs?: number;
}

export interface FridayGuideLensScreenshotIntakeRequest {
  sessionId?: UUID;
  question?: string;
  screenshotText?: string;
  visibleText?: string;
  source?: "upload" | "paste" | "drag_drop" | "trusted_watcher";
}

export interface FridayGuideLensScreenshotIntakeResult {
  sessionId: UUID;
  intent:
    | "setup"
    | "error"
    | "permission"
    | "form"
    | "navigation"
    | "sensitive"
    | "question"
    | "unknown";
  summary: string;
  needsChatbox: boolean;
  chatboxPrompt?: string;
  suggestedGuideMode: FridayGuideLensOverlayMode;
  redactedText: string;
  redactions: FridayGuideLensRedaction[];
  confidence: number;
}

export interface FridayGuideLensVerificationRequest {
  sessionId?: UUID;
  uiMap?: FridayGuideLensUiMap;
  expected?: {
    textIncludes?: string;
    textExcludes?: string;
    elementLabel?: string;
    appName?: string;
    windowTitleIncludes?: string;
  };
}

export interface FridayGuideLensVerificationResult {
  status: "passed" | "failed" | "unknown";
  checkedAt: ISODateTime;
  confidence: number;
  reason: string;
  evidence: string[];
}

export interface FridayGuideLensState {
  preferences: FridayGuideLensPreferences;
  activeSession?: FridayGuideLensSession;
  sessions: FridayGuideLensSession[];
}

export interface FridayGuideLensService {
  getState(): FridayGuideLensState;
  updatePreferences(patch: Partial<FridayGuideLensPreferences>): FridayGuideLensPreferences;
  updateAvatar(avatar: Partial<FridayGuideLensAvatarPreference>): FridayGuideLensAvatarPreference;
  captureSnapshot(req?: FridayGuideLensSnapshotRequest): Promise<{ session: FridayGuideLensSession; uiMap: FridayGuideLensUiMap }>;
  resolveTarget(req: FridayGuideLensResolveTargetRequest): Promise<FridayGuideLensTargetResolution>;
  showOverlay(req: FridayGuideLensShowOverlayRequest): Promise<FridayGuideLensOverlayCommand>;
  clearOverlay(sessionId?: UUID): Promise<{ cleared: boolean; sessionId?: UUID; clearedAt: ISODateTime }>;
  analyzeScreenshot(req: FridayGuideLensScreenshotIntakeRequest): Promise<FridayGuideLensScreenshotIntakeResult>;
  verify(req: FridayGuideLensVerificationRequest): Promise<FridayGuideLensVerificationResult>;
  assertReadOnlyAction(action: string): void;
}
