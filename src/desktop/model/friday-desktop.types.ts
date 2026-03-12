/**
 * Desktop Control Runtime — Domain Model and Data Contract.
 *
 * Canonical types for the Friday Desktop Control system: platform adapters,
 * desktop actions (discriminated union), action execution, recording,
 * policy, permissions, element targeting, and persistence schema types.
 *
 * @module desktop/model
 */

import type { FridayAttributes } from "../../observability/model/index.js";

// ─── Foundational Value Types (local; mirrors packaging/rules/observability pattern) ───

/** UUID string identifier. */
export type UUID = string;

/** ISO 8601 date-time string. */
export type ISODateTime = string;

/** JSON-safe primitive value. */
export type JsonPrimitive = string | number | boolean | null;

/** Recursive JSON-safe value. */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/** JSON-safe object. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

// ═══════════════════════════════════════════════════════════════════════
// OBSERVABILITY BRIDGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Typed span attribute contract for desktop action traces.
 *
 * These attribute keys/values are written onto `FridaySpan.attributes`
 * when `module` is `"desktop"`. Using this type instead of raw
 * `FridayAttributes` ensures consistent attribute naming across the
 * codebase and enables compile-time checks.
 */
export type FridayDesktopSpanAttributes = FridayAttributes & {
  /** Desktop action type tag (e.g. `"click"`, `"file_operation"`). */
  readonly "friday.desktop.action_type": string;
  /** Platform the action was executed on. */
  readonly "friday.desktop.platform": string;
  /** App bundle ID / executable targeted (if applicable). */
  readonly "friday.desktop.app_bundle_id"?: string;
  /** Element role targeted (if applicable). */
  readonly "friday.desktop.element_role"?: string;
  /** Element name targeted (if applicable). */
  readonly "friday.desktop.element_name"?: string;
  /** Action execution status. */
  readonly "friday.desktop.status": string;
  /** Policy rule ID that matched (if any). */
  readonly "friday.desktop.policy_rule_id"?: string;
  /** Permission decision ID (if human confirmation occurred). */
  readonly "friday.desktop.permission_decision_id"?: string;
  /** Risk level classified by the policy evaluator. */
  readonly "friday.desktop.risk_level"?: string;
  /** Recording ID (if action was captured during a recording). */
  readonly "friday.desktop.recording_id"?: string;
  /** Action duration in milliseconds. */
  readonly "friday.desktop.duration_ms": number;
};

// ═══════════════════════════════════════════════════════════════════════
// RULES ENGINE BRIDGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Desktop-specific actions mapped to the Rules Engine `FridayRuleAction` type.
 *
 * Derived from `FridayDesktopActionType` so the two sets can never drift
 * apart. Adding a new variant to `FRIDAY_DESKTOP_ACTION_TYPES` will cause
 * a compile error here until the Rules Engine mapping is updated.
 */
export type FridayDesktopRuleAction = FridayDesktopActionType;

/**
 * Typed evaluation context for desktop → Rules Engine delegation.
 *
 * Callers construct this type before invoking `FridayEvaluationContext`.
 * It narrows `resource` to `"desktop"` and `action` to the desktop action set,
 * and adds desktop-specific attributes so no `as` casts are required.
 */
export interface FridayDesktopRuleEvaluationContext {
  /** Always `"desktop"` for desktop actions. */
  readonly resource: "desktop";
  /** Desktop action type being evaluated. */
  readonly action: FridayDesktopRuleAction;
  /** Desktop-specific attributes for condition evaluation. */
  readonly args: JsonObject & {
    /** Platform the action targets. */
    readonly platform: FridayDesktopPlatform;
    /** App bundle ID / executable targeted by the action (if applicable). */
    readonly appBundleId?: string;
    /** File path targeted by the action (if applicable). */
    readonly filePath?: string;
    /** Granular operation within the action (e.g. clipboard operation, file operation). */
    readonly operationType?: string;
    /** Risk level assigned by the desktop policy evaluator. */
    readonly riskLevel?: FridayDesktopRiskLevel;
  };
  /** Source system. */
  readonly source: "agent" | "workflow" | "api" | "system";
  /** Principal performing the action. */
  readonly principalId?: string;
  /** Current agent run ID. */
  readonly runId?: string;
  /** Session ID. */
  readonly sessionId?: string;
  /** Additional metadata. */
  readonly metadata?: JsonObject;
  /** Restrict evaluation to specific policy bundles. */
  readonly policyBundleIds?: string[];
}

// ═══════════════════════════════════════════════════════════════════════
// PLATFORM ADAPTERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Supported desktop platforms.
 */
export const FRIDAY_DESKTOP_PLATFORMS = [
  "darwin",
  "win32",
  "linux",
] as const;

/** Desktop platform union type. */
export type FridayDesktopPlatform =
  (typeof FRIDAY_DESKTOP_PLATFORMS)[number];

/**
 * Capabilities that a platform adapter may support.
 */
export const FRIDAY_DESKTOP_CAPABILITIES = [
  "click",
  "type",
  "keypress",
  "scroll",
  "drag",
  "screenshot",
  "read_element",
  "launch_app",
  "close_app",
  "clipboard_read",
  "clipboard_write",
  "file_read",
  "file_write",
  "file_move",
  "file_copy",
  "file_delete",
  "file_list",
  "file_stat",
  "element_search",
  "element_tree",
  "headless",
  "multi_monitor",
  "accessibility_api",
  "scripting_bridge",
] as const;

/** Desktop capability union type. */
export type FridayDesktopCapability =
  (typeof FRIDAY_DESKTOP_CAPABILITIES)[number];

/**
 * Metadata describing a platform adapter's runtime state (DTO-safe).
 *
 * This interface carries only serialisable metadata and is used in API
 * responses and persistence. For the runtime method contract that
 * adapter implementations must satisfy, see {@link FridayDesktopAdapterRuntime}.
 */
export interface FridayDesktopAdapter {
  /** Unique adapter identifier (e.g. "darwin-accessibility-v1"). */
  readonly id: string;
  /** Platform this adapter targets. */
  readonly platform: FridayDesktopPlatform;
  /** Human-readable display name. */
  readonly displayName: string;
  /** Adapter version string. */
  readonly version: string;
  /** Capabilities supported by this adapter on the current OS. */
  readonly capabilities: readonly FridayDesktopCapability[];
  /** OS version range this adapter supports (e.g. ">=14.0"). */
  readonly supportedOsVersions: string;
  /** Current OS version detected. */
  readonly detectedOsVersion: string;
  /** Whether the adapter is fully operational. */
  readonly healthy: boolean;
  /** Human-readable status message. */
  readonly statusMessage: string;
  /** When the adapter was initialized. */
  readonly initializedAt: ISODateTime;
}

/**
 * Runtime interface that platform adapter implementations must satisfy.
 *
 * Each platform (macOS, Windows, Linux) provides an implementation of this
 * interface. The metadata-only {@link FridayDesktopAdapter} is exposed via
 * the `metadata` accessor; all other members are runtime methods.
 */
export interface FridayDesktopAdapterRuntime {
  /** Serialisable adapter metadata (for API responses / persistence). */
  readonly metadata: FridayDesktopAdapter;

  /** Execute a desktop action. */
  execute(action: FridayDesktopAction): Promise<FridayDesktopActionResult>;

  /** Inspect a specific element by selector. */
  inspectElement(
    selector: FridayDesktopElementSelector,
  ): Promise<FridayDesktopElement | null>;

  /** Search for elements matching a text query. */
  searchElements(
    query: string,
    appBundleId?: string,
  ): Promise<FridayDesktopElement[]>;

  /** Return the capabilities supported by this adapter. */
  getCapabilities(): FridayDesktopCapability[];

  /** Check OS-level permissions required by this adapter. */
  checkPermissions(): Promise<FridayDesktopPermission[]>;
}

// ═══════════════════════════════════════════════════════════════════════
// TARGET ELEMENTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Selector strategies for locating desktop UI elements.
 */
export const FRIDAY_DESKTOP_SELECTOR_STRATEGIES = [
  "accessibility_id",
  "role_and_name",
  "xpath",
  "coordinates",
  "app_menu_path",
  "window_title",
] as const;

/** Element selector strategy union type. */
export type FridayDesktopSelectorStrategy =
  (typeof FRIDAY_DESKTOP_SELECTOR_STRATEGIES)[number];

/**
 * A selector used to locate a UI element on the desktop.
 */
export interface FridayDesktopElementSelector {
  /** Selector strategy. */
  readonly strategy: FridayDesktopSelectorStrategy;
  /** Strategy-specific value (e.g., accessibility ID, XPath, role name). */
  readonly value: string;
  /** Optional app bundle ID / executable to scope the search. */
  readonly appBundleId?: string;
  /** Optional window title to scope the search. */
  readonly windowTitle?: string;
  /** Display index for multi-monitor setups (0-based). */
  readonly displayIndex?: number;
  /** Fallback selectors tried in order if primary fails. */
  readonly fallbacks?: readonly FridayDesktopElementSelector[];
}

/**
 * A discovered UI element on the desktop.
 */
export interface FridayDesktopElement {
  /** Unique element identifier (runtime-scoped, not persistent). */
  readonly elementId: string;
  /** Accessibility role (e.g., "button", "textField", "menu"). */
  readonly role: string;
  /** Accessible name / label. */
  readonly name: string;
  /** Current value (for inputs, checkboxes, etc.). */
  readonly value?: string;
  /** Element description (accessibility description). */
  readonly description?: string;
  /** Whether the element is enabled / interactable. */
  readonly enabled: boolean;
  /** Whether the element is focused. */
  readonly focused: boolean;
  /** Whether the element is visible on screen. */
  readonly visible: boolean;
  /** Bounding rectangle in screen coordinates. */
  readonly bounds: FridayDesktopBounds;
  /** App bundle ID / executable that owns this element. */
  readonly appBundleId: string;
  /** Window title containing this element. */
  readonly windowTitle?: string;
  /** Display index (0-based). */
  readonly displayIndex: number;
  /** Child element count (for tree traversal). */
  readonly childCount: number;
  /** Platform-specific attributes (opaque). */
  readonly platformAttributes: JsonObject;
}

/**
 * Bounding rectangle in screen coordinates.
 */
export interface FridayDesktopBounds {
  /** X coordinate of top-left corner. */
  readonly x: number;
  /** Y coordinate of top-left corner. */
  readonly y: number;
  /** Width in pixels. */
  readonly width: number;
  /** Height in pixels. */
  readonly height: number;
}

// ═══════════════════════════════════════════════════════════════════════
// DESKTOP ACTIONS (discriminated union)
// ═══════════════════════════════════════════════════════════════════════

/**
 * All desktop action type tags.
 */
export const FRIDAY_DESKTOP_ACTION_TYPES = [
  "click",
  "type",
  "keypress",
  "scroll",
  "drag",
  "screenshot",
  "read_element",
  "launch_app",
  "close_app",
  "clipboard",
  "file_operation",
] as const;

/** Desktop action type union. */
export type FridayDesktopActionType =
  (typeof FRIDAY_DESKTOP_ACTION_TYPES)[number];

/**
 * Mouse button types.
 */
export const FRIDAY_DESKTOP_MOUSE_BUTTONS = [
  "left",
  "right",
  "middle",
] as const;

/** Mouse button union type. */
export type FridayDesktopMouseButton =
  (typeof FRIDAY_DESKTOP_MOUSE_BUTTONS)[number];

/**
 * Modifier keys.
 */
export const FRIDAY_DESKTOP_MODIFIER_KEYS = [
  "shift",
  "control",
  "alt",
  "meta",
  "command",
] as const;

/** Modifier key union type. */
export type FridayDesktopModifierKey =
  (typeof FRIDAY_DESKTOP_MODIFIER_KEYS)[number];

/**
 * Click action type (single, double, triple).
 */
export const FRIDAY_DESKTOP_CLICK_TYPES = [
  "single",
  "double",
  "triple",
] as const;

/** Click type union. */
export type FridayDesktopClickType =
  (typeof FRIDAY_DESKTOP_CLICK_TYPES)[number];

/**
 * Scroll direction.
 */
export const FRIDAY_DESKTOP_SCROLL_DIRECTIONS = [
  "up",
  "down",
  "left",
  "right",
] as const;

/** Scroll direction union type. */
export type FridayDesktopScrollDirection =
  (typeof FRIDAY_DESKTOP_SCROLL_DIRECTIONS)[number];

/**
 * Screenshot format.
 */
export const FRIDAY_DESKTOP_SCREENSHOT_FORMATS = [
  "png",
  "jpeg",
] as const;

/** Screenshot format union type. */
export type FridayDesktopScreenshotFormat =
  (typeof FRIDAY_DESKTOP_SCREENSHOT_FORMATS)[number];

/**
 * Clipboard operation type.
 */
export const FRIDAY_DESKTOP_CLIPBOARD_OPERATIONS = [
  "read",
  "write",
  "clear",
] as const;

/** Clipboard operation union type. */
export type FridayDesktopClipboardOperation =
  (typeof FRIDAY_DESKTOP_CLIPBOARD_OPERATIONS)[number];

/**
 * File operation type.
 */
export const FRIDAY_DESKTOP_FILE_OPERATIONS = [
  "read",
  "write",
  "move",
  "copy",
  "delete",
  "list",
  "stat",
] as const;

/** File operation union type. */
export type FridayDesktopFileOperation =
  (typeof FRIDAY_DESKTOP_FILE_OPERATIONS)[number];

// ─── Discriminated union variants ───

/** Click on a UI element or screen coordinates. */
export interface FridayDesktopClickAction {
  readonly type: "click";
  /** Target element selector. */
  readonly selector?: FridayDesktopElementSelector;
  /** Absolute screen coordinates (fallback if no selector). */
  readonly coordinates?: FridayDesktopBounds;
  /** Mouse button. @default "left" */
  readonly button?: FridayDesktopMouseButton;
  /** Click type. @default "single" */
  readonly clickType?: FridayDesktopClickType;
  /** Modifier keys held during click. */
  readonly modifiers?: readonly FridayDesktopModifierKey[];
}

/** Type text into a UI element. */
export interface FridayDesktopTypeAction {
  readonly type: "type";
  /** Text to type. */
  readonly text: string;
  /** Target element to focus before typing. */
  readonly selector?: FridayDesktopElementSelector;
  /** Whether to clear existing content before typing. @default false */
  readonly clearFirst?: boolean;
  /** Inter-keystroke delay in milliseconds. @default 0 */
  readonly delayMs?: number;
}

/** Press a key or key combination. */
export interface FridayDesktopKeypressAction {
  readonly type: "keypress";
  /** Primary key to press (e.g., "Enter", "Tab", "a", "F5"). */
  readonly key: string;
  /** Modifier keys held during keypress. */
  readonly modifiers?: readonly FridayDesktopModifierKey[];
  /** Target element to focus before pressing. */
  readonly selector?: FridayDesktopElementSelector;
}

/** Scroll within an element or at screen coordinates. */
export interface FridayDesktopScrollAction {
  readonly type: "scroll";
  /** Scroll direction. */
  readonly direction: FridayDesktopScrollDirection;
  /** Scroll amount (platform-specific units). @default 3 */
  readonly amount?: number;
  /** Target element to scroll within. */
  readonly selector?: FridayDesktopElementSelector;
  /** Absolute screen coordinates for scroll location. */
  readonly coordinates?: FridayDesktopBounds;
}

/** Drag from one point/element to another. */
export interface FridayDesktopDragAction {
  readonly type: "drag";
  /** Start element or coordinates. */
  readonly from: FridayDesktopElementSelector | FridayDesktopBounds;
  /** End element or coordinates. */
  readonly to: FridayDesktopElementSelector | FridayDesktopBounds;
  /** Duration of drag in milliseconds. @default 500 */
  readonly durationMs?: number;
  /** Modifier keys held during drag. */
  readonly modifiers?: readonly FridayDesktopModifierKey[];
}

/** Capture a screenshot. */
export interface FridayDesktopScreenshotAction {
  readonly type: "screenshot";
  /** Capture a specific element (null = full screen). */
  readonly selector?: FridayDesktopElementSelector;
  /** Display index for multi-monitor (null = primary). */
  readonly displayIndex?: number;
  /** Image format. @default "png" */
  readonly format?: FridayDesktopScreenshotFormat;
  /** JPEG quality (1-100). @default 85 */
  readonly quality?: number;
}

/** Read properties of a UI element. */
export interface FridayDesktopReadElementAction {
  readonly type: "read_element";
  /** Element to read. */
  readonly selector: FridayDesktopElementSelector;
  /** Include child elements up to this depth. @default 0 */
  readonly childDepth?: number;
  /** Include platform-specific attributes. @default false */
  readonly includePlatformAttributes?: boolean;
}

/** Launch a desktop application. */
export interface FridayDesktopLaunchAppAction {
  readonly type: "launch_app";
  /** App bundle ID (macOS), executable path (Windows/Linux), or app name. */
  readonly appIdentifier: string;
  /** Command-line arguments. */
  readonly args?: readonly string[];
  /** Whether to bring the app to the foreground. @default true */
  readonly activate?: boolean;
}

/** Close a desktop application. */
export interface FridayDesktopCloseAppAction {
  readonly type: "close_app";
  /** App bundle ID (macOS), executable path (Windows/Linux), or app name. */
  readonly appIdentifier: string;
  /** Whether to force-kill if graceful close fails. @default false */
  readonly force?: boolean;
  /** Timeout for graceful close in milliseconds. @default 5000 */
  readonly gracePeriodMs?: number;
}

// ─── Clipboard action (nested discriminated union by operation) ───

/** Clipboard write — requires content. */
export interface FridayDesktopClipboardWriteAction {
  readonly type: "clipboard";
  readonly operation: "write";
  /** Content to write to the clipboard. */
  readonly content: string;
  /** MIME type of content. @default "text/plain" */
  readonly mimeType?: string;
}

/** Clipboard read — no content required. */
export interface FridayDesktopClipboardReadAction {
  readonly type: "clipboard";
  readonly operation: "read";
  /** MIME type filter. @default "text/plain" */
  readonly mimeType?: string;
}

/** Clipboard clear — no content required. */
export interface FridayDesktopClipboardClearAction {
  readonly type: "clipboard";
  readonly operation: "clear";
}

/** Read, write, or clear the clipboard (nested discriminated union). */
export type FridayDesktopClipboardAction =
  | FridayDesktopClipboardWriteAction
  | FridayDesktopClipboardReadAction
  | FridayDesktopClipboardClearAction;

// ─── File operation action (nested discriminated union by operation) ───

/** File read — reads file content. */
export interface FridayDesktopFileReadAction {
  readonly type: "file_operation";
  readonly operation: "read";
  /** Source file path. */
  readonly path: string;
  /** File encoding. @default "utf-8" */
  readonly encoding?: string;
}

/** File write — requires content. */
export interface FridayDesktopFileWriteAction {
  readonly type: "file_operation";
  readonly operation: "write";
  /** Target file path. */
  readonly path: string;
  /** Content to write. */
  readonly content: string;
  /** File encoding. @default "utf-8" */
  readonly encoding?: string;
}

/** File move — requires destination path. */
export interface FridayDesktopFileMoveAction {
  readonly type: "file_operation";
  readonly operation: "move";
  /** Source file path. */
  readonly path: string;
  /** Destination path. */
  readonly destinationPath: string;
}

/** File copy — requires destination path. */
export interface FridayDesktopFileCopyAction {
  readonly type: "file_operation";
  readonly operation: "copy";
  /** Source file path. */
  readonly path: string;
  /** Destination path. */
  readonly destinationPath: string;
}

/** File delete — only requires path. */
export interface FridayDesktopFileDeleteAction {
  readonly type: "file_operation";
  readonly operation: "delete";
  /** File path to delete. */
  readonly path: string;
}

/** File list — lists directory contents. */
export interface FridayDesktopFileListAction {
  readonly type: "file_operation";
  readonly operation: "list";
  /** Directory path. */
  readonly path: string;
}

/** File stat — gets file metadata. */
export interface FridayDesktopFileStatAction {
  readonly type: "file_operation";
  readonly operation: "stat";
  /** File path. */
  readonly path: string;
}

/** File system operation (nested discriminated union). */
export type FridayDesktopFileOperationAction =
  | FridayDesktopFileReadAction
  | FridayDesktopFileWriteAction
  | FridayDesktopFileMoveAction
  | FridayDesktopFileCopyAction
  | FridayDesktopFileDeleteAction
  | FridayDesktopFileListAction
  | FridayDesktopFileStatAction;

/**
 * Discriminated union of all desktop actions.
 *
 * Keyed by `type` field. Each variant carries only the fields
 * relevant to that action kind.
 */
export type FridayDesktopAction =
  | FridayDesktopClickAction
  | FridayDesktopTypeAction
  | FridayDesktopKeypressAction
  | FridayDesktopScrollAction
  | FridayDesktopDragAction
  | FridayDesktopScreenshotAction
  | FridayDesktopReadElementAction
  | FridayDesktopLaunchAppAction
  | FridayDesktopCloseAppAction
  | FridayDesktopClipboardAction
  | FridayDesktopFileOperationAction;

// ═══════════════════════════════════════════════════════════════════════
// ERROR CODES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Standardised error codes for the desktop control domain.
 *
 * Defined at the domain layer because both the domain model
 * (`FridayDesktopActionResult`) and the API layer
 * (`FridayDesktopActionResultDto`) reference these codes.
 */
export const FRIDAY_DESKTOP_ERROR_CODES = {
  /** The requested action is not supported on the current platform. */
  UNSUPPORTED_PLATFORM: "DESKTOP_UNSUPPORTED_PLATFORM",
  /** The requested capability is not available on the current adapter. */
  UNSUPPORTED_CAPABILITY: "DESKTOP_UNSUPPORTED_CAPABILITY",
  /** Action execution timed out. */
  ACTION_TIMEOUT: "DESKTOP_ACTION_TIMEOUT",
  /** Action was cancelled before completion. */
  ACTION_CANCELLED: "DESKTOP_ACTION_CANCELLED",
  /** Action execution failed. */
  ACTION_FAILED: "DESKTOP_ACTION_FAILED",
  /** Target element could not be found. */
  ELEMENT_NOT_FOUND: "DESKTOP_ELEMENT_NOT_FOUND",
  /** Target display/monitor not found. */
  DISPLAY_NOT_FOUND: "DESKTOP_DISPLAY_NOT_FOUND",
  /** Target application not found or not installed. */
  APP_NOT_FOUND: "DESKTOP_APP_NOT_FOUND",
  /** Target application is not responding. */
  APP_NOT_RESPONDING: "DESKTOP_APP_NOT_RESPONDING",
  /** OS-level permission not granted. */
  PERMISSION_DENIED_OS: "DESKTOP_PERMISSION_DENIED_OS",
  /** Action blocked by desktop policy. */
  PERMISSION_DENIED_POLICY: "DESKTOP_PERMISSION_DENIED_POLICY",
  /** Action denied by human confirmation. */
  PERMISSION_DENIED_USER: "DESKTOP_PERMISSION_DENIED_USER",
  /** Action violates sandbox boundaries. */
  SANDBOX_VIOLATION: "DESKTOP_SANDBOX_VIOLATION",
  /** Recording not found. */
  RECORDING_NOT_FOUND: "DESKTOP_RECORDING_NOT_FOUND",
  /** Recording is not in a valid state for the requested operation. */
  RECORDING_INVALID_STATE: "DESKTOP_RECORDING_INVALID_STATE",
  /** Policy not found. */
  POLICY_NOT_FOUND: "DESKTOP_POLICY_NOT_FOUND",
  /** Policy rule not found. */
  POLICY_RULE_NOT_FOUND: "DESKTOP_POLICY_RULE_NOT_FOUND",
  /** Permission prompt not found or expired. */
  PERMISSION_PROMPT_EXPIRED: "DESKTOP_PERMISSION_PROMPT_EXPIRED",
  /** Optimistic concurrency conflict — the etag does not match. */
  ETAG_MISMATCH: "DESKTOP_ETAG_MISMATCH",
  /** Validation failed on the request payload. */
  VALIDATION_FAILED: "DESKTOP_VALIDATION_FAILED",
  /** Idempotency key reused with a different payload inside retention window. */
  IDEMPOTENCY_KEY_CONFLICT: "DESKTOP_IDEMPOTENCY_KEY_CONFLICT",
  /** Maximum concurrent action limit reached. */
  CONCURRENT_LIMIT: "DESKTOP_CONCURRENT_LIMIT",
  /** Replay failed — one or more steps could not be executed. */
  REPLAY_FAILED: "DESKTOP_REPLAY_FAILED",
  /** Batch action partially failed. */
  BATCH_PARTIAL_FAILURE: "DESKTOP_BATCH_PARTIAL_FAILURE",
} as const;

/** Union type of all desktop error codes. */
export type FridayDesktopErrorCode =
  (typeof FRIDAY_DESKTOP_ERROR_CODES)[keyof typeof FRIDAY_DESKTOP_ERROR_CODES];

// ═══════════════════════════════════════════════════════════════════════
// ACTION EXECUTION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Status codes for action execution results.
 */
export const FRIDAY_DESKTOP_ACTION_STATUSES = [
  "success",
  "failed",
  "timeout",
  "cancelled",
  "permission_denied_os",
  "permission_denied_policy",
  "permission_denied_user",
  "element_not_found",
  "display_not_found",
  "app_not_found",
  "app_not_responding",
  "unsupported_platform",
  "unsupported_capability",
  "sandbox_violation",
] as const;

/** Action status union type. */
export type FridayDesktopActionStatus =
  (typeof FRIDAY_DESKTOP_ACTION_STATUSES)[number];

/**
 * Result of executing a desktop action.
 */
export interface FridayDesktopActionResult {
  /** Unique result identifier. */
  readonly id: UUID;
  /** The action that was executed. */
  readonly action: FridayDesktopAction;
  /** Execution status. */
  readonly status: FridayDesktopActionStatus;
  /** Platform the action was executed on. */
  readonly platform: FridayDesktopPlatform;
  /** Error message (if status is not "success"). */
  readonly errorMessage?: string;
  /** Error code (structured, if available). */
  readonly errorCode?: FridayDesktopErrorCode;
  /** Element that was targeted (if resolved). */
  readonly targetElement?: FridayDesktopElement;
  /** Screenshot data as base64 (for screenshot actions). */
  readonly screenshotBase64?: string;
  /** Element data (for read_element actions). */
  readonly elementData?: FridayDesktopElement;
  /** Clipboard content (for clipboard read actions). */
  readonly clipboardContent?: string;
  /** File content or stat data (for file operations). */
  readonly fileData?: string;
  /** File listing (for file list operations). */
  readonly fileListing?: readonly FridayDesktopFileEntry[];
  /** Policy rule that was matched (if any). */
  readonly matchedPolicyRuleId?: UUID;
  /** Permission decision ID (if human confirmation was required). */
  readonly permissionDecisionId?: UUID;
  /** Trace ID from observability. */
  readonly traceId?: string;
  /** Span ID from observability. */
  readonly spanId?: string;
  /** Execution duration in milliseconds. */
  readonly durationMs: number;
  /** When execution started. */
  readonly startedAt: ISODateTime;
  /** When execution completed. */
  readonly completedAt: ISODateTime;
}

/**
 * File entry returned by file list operations.
 */
export interface FridayDesktopFileEntry {
  /** File name. */
  readonly name: string;
  /** Full path. */
  readonly path: string;
  /** Whether this is a directory. */
  readonly isDirectory: boolean;
  /** File size in bytes. */
  readonly sizeBytes: number;
  /** Last modified timestamp. */
  readonly modifiedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// RECORDING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Recording lifecycle states.
 */
export const FRIDAY_DESKTOP_RECORDING_STATES = [
  "idle",
  "recording",
  "paused",
  "stopped",
] as const;

/** Recording state union type. */
export type FridayDesktopRecordingState =
  (typeof FRIDAY_DESKTOP_RECORDING_STATES)[number];

/**
 * Valid state transitions for the recording lifecycle.
 *
 * Maps each state to the set of states it may transition to,
 * enforcing the lifecycle: idle → recording ↔ paused → stopped.
 *
 * Mirrors the security transition table pattern used elsewhere
 * (e.g., `FRIDAY_WORKFLOW_RUN_STATE_TRANSITIONS`).
 */
export const FRIDAY_DESKTOP_RECORDING_STATE_TRANSITIONS: Readonly<
  Record<FridayDesktopRecordingState, readonly FridayDesktopRecordingState[]>
> = {
  idle: ["recording"],
  recording: ["paused", "stopped"],
  paused: ["recording", "stopped"],
  stopped: [],
} as const;

/**
 * Parameter type for recording parameterization.
 */
export const FRIDAY_DESKTOP_PARAMETER_TYPES = [
  "string",
  "number",
  "boolean",
  "path",
  "selector",
] as const;

/** Recording parameter type union. */
export type FridayDesktopParameterType =
  (typeof FRIDAY_DESKTOP_PARAMETER_TYPES)[number];

/**
 * A single entry in the RFC-aligned parameter map shape.
 *
 * The RFC specifies parameters as `name → { type, defaultValue }`.
 * This type represents the value side of that map.
 */
export interface FridayDesktopRecordingParameterEntry {
  /** Parameter value type. */
  readonly type: FridayDesktopParameterType;
  /** Default value. */
  readonly defaultValue?: string;
  /** Human-readable description. */
  readonly description?: string;
  /** Whether this parameter is required at replay time. */
  readonly required: boolean;
}

/**
 * RFC-aligned parameter map: `name → { type, defaultValue, ... }`.
 *
 * Used on `FridayDesktopRecording.parameters` for map-based lookup
 * as described in the RFC's parameterization section.
 */
export type FridayDesktopRecordingParameterMap = Readonly<
  Record<string, FridayDesktopRecordingParameterEntry>
>;

/**
 * A single step within a recording.
 */
export interface FridayDesktopRecordingStep {
  /** Unique step identifier. */
  readonly id: UUID;
  /** Parent recording identifier. */
  readonly recordingId: UUID;
  /** Zero-based step index. */
  readonly stepIndex: number;
  /** The captured action. */
  readonly action: FridayDesktopAction;
  /** Execution result at capture time. */
  readonly result?: FridayDesktopActionResult;
  /** Element snapshot at capture time. */
  readonly element?: FridayDesktopElement;
  /** Parameter bindings: maps {{paramName}} to the original value. */
  readonly parameterBindings: Readonly<Record<string, string>>;
  /** When this step was captured. */
  readonly timestamp: ISODateTime;
  /** Step execution duration at capture time. */
  readonly durationMs?: number;
}

/**
 * A desktop action recording.
 */
export interface FridayDesktopRecording {
  /** Unique recording identifier. */
  readonly id: UUID;
  /** Human-readable name. */
  readonly name: string;
  /** Description of what the recording does. */
  readonly description?: string;
  /** Current recording state. */
  readonly state: FridayDesktopRecordingState;
  /** Platform the recording was captured on. */
  readonly platform: FridayDesktopPlatform;
  /** Parameterized variables for replay (map of name → entry, per RFC). */
  readonly parameters: FridayDesktopRecordingParameterMap;
  /** Searchable tags. */
  readonly tags: readonly string[];
  /** Number of steps in the recording. */
  readonly stepCount: number;
  /** Principal who created the recording. */
  readonly createdBy: string;
  /** Tenant context. */
  readonly tenantId?: string;
  /** When the recording was created. */
  readonly createdAt: ISODateTime;
  /** When the recording was last updated. */
  readonly updatedAt: ISODateTime;
  /** When the recording was stopped (null if still active). */
  readonly stoppedAt?: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// POLICY
// ═══════════════════════════════════════════════════════════════════════

/**
 * Risk levels for desktop actions.
 */
export const FRIDAY_DESKTOP_RISK_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "critical",
] as const;

/** Risk level union type. */
export type FridayDesktopRiskLevel =
  (typeof FRIDAY_DESKTOP_RISK_LEVELS)[number];

/**
 * Policy decision actions.
 */
export const FRIDAY_DESKTOP_POLICY_DECISIONS = [
  "allow",
  "deny",
  "warn",
  "audit",
] as const;

/** Policy decision union type. */
export type FridayDesktopPolicyDecision =
  (typeof FRIDAY_DESKTOP_POLICY_DECISIONS)[number];

/**
 * A single rule within a desktop policy.
 */
export interface FridayDesktopPolicyRule {
  /** Unique rule identifier. */
  readonly id: UUID;
  /** Parent policy identifier. */
  readonly policyId: UUID;
  /** Action type this rule applies to. */
  readonly actionType: FridayDesktopActionType;
  /** App bundle ID / executable glob filter ("*" matches all). */
  readonly appFilter: string;
  /** Element role/name glob filter (null = no element filtering). */
  readonly elementFilter?: string;
  /** Risk level classification. */
  readonly riskLevel: FridayDesktopRiskLevel;
  /** Policy decision. */
  readonly decision: FridayDesktopPolicyDecision;
  /** Whether to delegate evaluation to the Rules Engine. */
  readonly engineDelegate: boolean;
  /** Human-readable description. */
  readonly description?: string;
  /** Rule priority (higher = checked first). */
  readonly priority: number;
  /** When this rule was created. */
  readonly createdAt: ISODateTime;
}

/**
 * A desktop policy — a named collection of rules.
 */
export interface FridayDesktopPolicy {
  /** Unique policy identifier. */
  readonly id: UUID;
  /** Human-readable policy name. */
  readonly name: string;
  /** Policy description. */
  readonly description?: string;
  /** Whether this policy is active. */
  readonly enabled: boolean;
  /** Policy priority (higher = evaluated first). */
  readonly priority: number;
  /** Rules within this policy. */
  readonly rules: readonly FridayDesktopPolicyRule[];
  /** Tenant context. */
  readonly tenantId?: string;
  /** Principal who created the policy. */
  readonly createdBy: string;
  /** Optimistic concurrency token. */
  readonly etag: string;
  /** When the policy was created. */
  readonly createdAt: ISODateTime;
  /** When the policy was last updated. */
  readonly updatedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// PERMISSIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * OS-level permission types.
 */
export const FRIDAY_DESKTOP_OS_PERMISSION_TYPES = [
  "accessibility",
  "screen_recording",
  "file_access",
  "input_monitoring",
  "automation",
] as const;

/** OS permission type union. */
export type FridayDesktopOsPermissionType =
  (typeof FRIDAY_DESKTOP_OS_PERMISSION_TYPES)[number];

/**
 * OS-level permission status.
 */
export const FRIDAY_DESKTOP_OS_PERMISSION_STATUSES = [
  "granted",
  "denied",
  "not_determined",
  "restricted",
  "not_applicable",
] as const;

/** OS permission status union type. */
export type FridayDesktopOsPermissionStatus =
  (typeof FRIDAY_DESKTOP_OS_PERMISSION_STATUSES)[number];

/**
 * An OS-level permission check result.
 */
export interface FridayDesktopPermission {
  /** Permission type. */
  readonly permissionType: FridayDesktopOsPermissionType;
  /** Current status. */
  readonly status: FridayDesktopOsPermissionStatus;
  /** Platform this permission applies to. */
  readonly platform: FridayDesktopPlatform;
  /** Human-readable instructions to grant this permission. */
  readonly grantInstructions?: string;
  /** When this permission was last checked. */
  readonly checkedAt: ISODateTime;
}

/**
 * All permission decision values (includes system-generated "timeout").
 */
export const FRIDAY_DESKTOP_PERMISSION_DECISION_VALUES = [
  "approved",
  "denied",
  "timeout",
] as const;

/** Permission decision union type (all values including system-generated). */
export type FridayDesktopPermissionDecisionValue =
  (typeof FRIDAY_DESKTOP_PERMISSION_DECISION_VALUES)[number];

/**
 * Human-submittable permission decisions.
 *
 * `"timeout"` is system-generated and must not be submitted by a client.
 * This type is used for API request payloads only.
 */
export const FRIDAY_DESKTOP_PERMISSION_HUMAN_DECISIONS = [
  "approved",
  "denied",
] as const;

/** Human-submittable decision type (excludes "timeout"). */
export type FridayDesktopPermissionHumanDecision =
  (typeof FRIDAY_DESKTOP_PERMISSION_HUMAN_DECISIONS)[number];

/**
 * A prompt requesting human confirmation for a high-risk action.
 */
export interface FridayDesktopPermissionPrompt {
  /** Unique prompt identifier. */
  readonly id: UUID;
  /** Action type requiring confirmation. */
  readonly actionType: FridayDesktopActionType;
  /** The action being requested. */
  readonly action: FridayDesktopAction;
  /** Risk level that triggered the prompt. */
  readonly riskLevel: FridayDesktopRiskLevel;
  /** App bundle ID (if action targets a specific app). */
  readonly appBundleId?: string;
  /** Element description (if action targets a specific element). */
  readonly elementDescription?: string;
  /** Policy rule that triggered the prompt. */
  readonly policyRuleId?: UUID;
  /** Human-readable explanation of why confirmation is needed. */
  readonly reason: string;
  /** Timeout for the prompt in milliseconds. */
  readonly timeoutMs: number;
  /** When the prompt was created. */
  readonly createdAt: ISODateTime;
  /** When the prompt expires. */
  readonly expiresAt: ISODateTime;
}

/**
 * A recorded human decision on a permission prompt.
 */
export interface FridayDesktopPermissionDecision {
  /** Unique decision identifier. */
  readonly id: UUID;
  /** The prompt this decision responds to. */
  readonly promptId: UUID;
  /** Action type from the prompt. */
  readonly actionType: FridayDesktopActionType;
  /** App bundle ID from the prompt. */
  readonly appBundleId?: string;
  /** Element description from the prompt. */
  readonly elementDescription?: string;
  /** Risk level from the prompt. */
  readonly riskLevel: FridayDesktopRiskLevel;
  /** The decision. */
  readonly decision: FridayDesktopPermissionDecisionValue;
  /** Principal who made the decision. */
  readonly decidedBy: string;
  /** Human-readable rationale for the decision. */
  readonly rationale?: string;
  /** Tenant context. */
  readonly tenantId?: string;
  /** When the decision was made. */
  readonly createdAt: ISODateTime;
  /** When this decision expires (for cached approvals). */
  readonly expiresAt?: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// ENGINE CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Configuration for the Desktop Control Runtime.
 */
export interface FridayDesktopEngineConfig {
  /** Default action timeout in milliseconds. @default 10_000 */
  readonly defaultActionTimeoutMs: number;
  /** App launch timeout in milliseconds. @default 30_000 */
  readonly launchAppTimeoutMs: number;
  /** Permission prompt timeout in milliseconds. @default 300_000 (5 min) */
  readonly permissionPromptTimeoutMs: number;
  /** Maximum concurrent actions. @default 1 (serial execution) */
  readonly maxConcurrentActions: number;
  /** Idempotency key TTL in hours. @default 24 */
  readonly idempotencyTtlHours: number;
  /** Default screenshot format. @default "png" */
  readonly defaultScreenshotFormat: FridayDesktopScreenshotFormat;
  /** Default screenshot JPEG quality. @default 85 */
  readonly defaultScreenshotQuality: number;
  /** Generate a new UUID. */
  readonly generateId: () => UUID;
  /** Get current ISO timestamp. */
  readonly nowIso: () => ISODateTime;
}

/**
 * Default engine configuration values.
 */
export const FRIDAY_DESKTOP_ENGINE_DEFAULTS = {
  defaultActionTimeoutMs: 10_000,
  launchAppTimeoutMs: 30_000,
  permissionPromptTimeoutMs: 300_000,
  maxConcurrentActions: 1,
  idempotencyTtlHours: 24,
  defaultScreenshotFormat: "png",
  defaultScreenshotQuality: 85,
} as const;

// ═══════════════════════════════════════════════════════════════════════
// PERSISTENCE ROW TYPES (SQLite)
// ═══════════════════════════════════════════════════════════════════════

/** SQLite row shape for the `desktop_recordings` table. */
export interface FridayDesktopRecordingRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly state: string;
  readonly platform: string;
  readonly parameters_json: string;
  readonly tags_json: string;
  readonly created_by: string;
  readonly tenant_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly stopped_at: string | null;
}

/** SQLite row shape for the `desktop_recording_steps` table. */
export interface FridayDesktopRecordingStepRow {
  readonly id: string;
  readonly recording_id: string;
  readonly step_index: number;
  readonly action_json: string;
  readonly result_json: string | null;
  readonly element_json: string | null;
  readonly parameter_bindings_json: string;
  readonly timestamp: string;
  readonly duration_ms: number | null;
}

/** SQLite row shape for the `desktop_policies` table. */
export interface FridayDesktopPolicyRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly enabled: number;
  readonly priority: number;
  readonly tenant_id: string | null;
  readonly created_by: string;
  readonly etag: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `desktop_policy_rules` table. */
export interface FridayDesktopPolicyRuleRow {
  readonly id: string;
  readonly policy_id: string;
  readonly action_type: string;
  readonly app_filter: string;
  readonly element_filter: string | null;
  readonly risk_level: string;
  readonly decision: string;
  readonly engine_delegate: number;
  readonly description: string | null;
  readonly priority: number;
  readonly created_at: string;
}

/** SQLite row shape for the `desktop_permission_decisions` table. */
export interface FridayDesktopPermissionDecisionRow {
  readonly id: string;
  readonly action_type: string;
  readonly app_bundle_id: string | null;
  readonly element_desc: string | null;
  readonly risk_level: string;
  readonly decision: string;
  readonly decided_by: string;
  readonly rationale: string | null;
  readonly prompt_id: string;
  readonly tenant_id: string | null;
  readonly created_at: string;
  readonly expires_at: string | null;
}

/** SQLite row shape for the `desktop_action_log` table. */
export interface FridayDesktopActionLogRow {
  readonly id: string;
  readonly action_type: string;
  readonly action_json: string;
  readonly result_json: string;
  readonly status: string;
  readonly platform: string;
  readonly app_bundle_id: string | null;
  readonly element_json: string | null;
  readonly policy_rule_id: string | null;
  readonly permission_id: string | null;
  readonly trace_id: string | null;
  readonly span_id: string | null;
  readonly principal_id: string | null;
  readonly tenant_id: string | null;
  readonly duration_ms: number;
  readonly created_at: string;
}

// ─── Row-to-Entity Mapper Signature ───

/** Generic row-to-entity mapper function type. */
export type FridayDesktopRowMapper<TRow, TEntity> = (row: TRow) => TEntity;
