/**
 * Agent Desktop Tool — Exposes desktop control actions to the agent runtime.
 *
 * Multi-action tool following the same pattern as the browser tool.
 * Actions: execute, screenshot, inspect_element, search_elements,
 *          start_recording, stop_recording, check_permissions, session_info.
 *
 * Requires an active DesktopSessionManager to be wired in via the tool
 * registry. The session manager must be connected before the agent invokes
 * desktop actions.
 *
 * @module agent/tools/friday-agent-desktop-tool
 */

import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type { DesktopSessionManager } from "../../desktop/engine/session-manager.js";
import type {
  FridayDesktopAction,
  FridayDesktopElementSelector,
  FridayDesktopModifierKey,
  FridayDesktopSelectorStrategy,
} from "../../desktop/model/friday-desktop.types.js";
import {
  errorResult,
  jsonResult,
  readBooleanParam,
  readNumberParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Types ───

export interface CreateFridayAgentDesktopToolOptions {
  desktopSessionManager: DesktopSessionManager;
}

type DesktopAction =
  | "execute"
  | "screenshot"
  | "inspect_element"
  | "search_elements"
  | "start_recording"
  | "stop_recording"
  | "check_permissions"
  | "session_info";

const VALID_ACTIONS = new Set<DesktopAction>([
  "execute",
  "screenshot",
  "inspect_element",
  "search_elements",
  "start_recording",
  "stop_recording",
  "check_permissions",
  "session_info",
]);

const VALID_MODIFIERS = new Set<FridayDesktopModifierKey>([
  "shift",
  "control",
  "alt",
  "meta",
  "command",
]);

// ─── Factory ───

export function createFridayAgentDesktopTool(
  options: CreateFridayAgentDesktopToolOptions,
): FridayAgentToolDefinition {
  const { desktopSessionManager } = options;

  return {
    name: "desktop",
    description:
      "Control the native desktop environment. Actions: execute (click/type/keypress/scroll/drag/screenshot/read_element/launch_app/close_app/clipboard/file_operation), " +
      "screenshot (capture screen), inspect_element (inspect a UI element), search_elements (find UI elements by text), " +
      "start_recording (begin recording desktop actions), stop_recording (end recording), " +
      "check_permissions (check OS-level permissions), session_info (get desktop session state).",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: [
            "execute",
            "screenshot",
            "inspect_element",
            "search_elements",
            "start_recording",
            "stop_recording",
            "check_permissions",
            "session_info",
          ],
          description: "Desktop action to perform.",
        },
        // ─── execute params ───
        actionType: {
          type: "string",
          enum: [
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
          ],
          description: "Desktop action type (for execute action).",
        },
        x: { type: "number", description: "X coordinate for click coordinates." },
        y: { type: "number", description: "Y coordinate for click coordinates." },
        text: { type: "string", description: "Text to type, key combo, app identifier, or file path." },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          description: "Mouse button (for click).",
        },
        clickType: {
          type: "string",
          enum: ["single", "double", "triple"],
          description: "Click type (for click).",
        },
        modifiers: {
          type: "array",
          description: "Modifier keys (shift, control, alt, meta, command).",
        },
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Scroll direction.",
        },
        amount: { type: "number", description: "Scroll amount." },
        startX: { type: "number", description: "Drag start X." },
        startY: { type: "number", description: "Drag start Y." },
        endX: { type: "number", description: "Drag end X." },
        endY: { type: "number", description: "Drag end Y." },
        operation: {
          type: "string",
          description: "Clipboard operation (read/write/clear) or file operation (read/write/move/copy/delete/list/stat).",
        },
        content: { type: "string", description: "Content for clipboard write or file write." },
        path: { type: "string", description: "File path for file operations." },
        destinationPath: { type: "string", description: "Destination path for file move/copy." },
        // ─── inspect_element params ───
        strategy: {
          type: "string",
          enum: ["accessibility_id", "role_and_name", "xpath", "coordinates", "app_menu_path", "window_title"],
          description: "Element selector strategy.",
        },
        selectorValue: { type: "string", description: "Element selector value." },
        appBundleId: { type: "string", description: "Application bundle identifier." },
        // ─── search_elements params ───
        query: { type: "string", description: "Text query for element search." },
        // ─── recording params ───
        recordingName: { type: "string", description: "Recording name (for start_recording)." },
        recordingId: { type: "string", description: "Recording ID (for stop_recording)." },
        // ─── screenshot params ───
        displayIndex: { type: "number", description: "Display index for multi-monitor (0-based)." },
        format: { type: "string", enum: ["png", "jpeg"], description: "Screenshot format." },
      },
      required: ["action"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const action = readStringParam(args, "action", { required: true }) as DesktopAction;

      if (!VALID_ACTIONS.has(action)) {
        return errorResult(
          `Invalid action "${action}". Valid actions: ${Array.from(VALID_ACTIONS).join(", ")}`,
        );
      }

      try {
        switch (action) {
          case "execute":
            return await handleExecute(args, signal);
          case "screenshot":
            return await handleScreenshot(args, signal);
          case "inspect_element":
            return await handleInspectElement(args, signal);
          case "search_elements":
            return await handleSearchElements(args, signal);
          case "start_recording":
            return handleStartRecording(args);
          case "stop_recording":
            return handleStopRecording(args);
          case "check_permissions":
            return await handleCheckPermissions();
          case "session_info":
            return handleSessionInfo();
          default:
            return errorResult(`Unknown action: ${action as string}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("Desktop action aborted.");
        }
        return errorResult(message);
      }
    },
  };

  // ─── Action Handlers ───

  function ensureConnected(): FridayAgentToolResult | null {
    if (!desktopSessionManager.isConnected()) {
      return errorResult("Desktop session is not connected. Connect the session first.");
    }
    return null;
  }

  async function handleExecute(
    args: Record<string, unknown>,
    _signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const notConnected = ensureConnected();
    if (notConnected) return notConnected;

    const actionType = readStringParam(args, "actionType", { required: true });
    const desktopAction = buildDesktopAction(actionType, args);
    if (!desktopAction) {
      return errorResult(`Invalid or incomplete actionType "${actionType}".`);
    }

    const result = await desktopSessionManager.executeAction(desktopAction);
    return jsonResult({
      actionId: result.id,
      actionType: result.action.type,
      status: result.status,
      durationMs: result.durationMs,
      errorMessage: result.errorMessage ?? undefined,
      screenshotBase64: result.screenshotBase64 ?? undefined,
      elementData: result.elementData ?? undefined,
      clipboardContent: result.clipboardContent ?? undefined,
      fileData: result.fileData ?? undefined,
    });
  }

  async function handleScreenshot(
    args: Record<string, unknown>,
    _signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const notConnected = ensureConnected();
    if (notConnected) return notConnected;

    const displayIndex = readNumberParam(args, "displayIndex", { integer: true });
    const format = readStringParam(args, "format") as "png" | "jpeg" | undefined;
    const screenshotAction: FridayDesktopAction = {
      type: "screenshot",
      displayIndex: displayIndex ?? undefined,
      format: format ?? undefined,
    };

    const result = await desktopSessionManager.executeAction(screenshotAction);
    if (result.status === "failed") {
      return errorResult(result.errorMessage ?? "Screenshot failed.");
    }

    return jsonResult({
      actionId: result.id,
      status: result.status,
      screenshotBase64: result.screenshotBase64 ?? null,
      durationMs: result.durationMs,
    });
  }

  async function handleInspectElement(
    args: Record<string, unknown>,
    _signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const notConnected = ensureConnected();
    if (notConnected) return notConnected;

    const strategy = readStringParam(args, "strategy", { required: true }) as FridayDesktopSelectorStrategy;
    const selectorValue = readStringParam(args, "selectorValue", { required: true });
    const appBundleId = readStringParam(args, "appBundleId");

    const selector: FridayDesktopElementSelector = {
      strategy,
      value: selectorValue,
      appBundleId: appBundleId ?? undefined,
    };

    const element = await desktopSessionManager.inspectElement(selector);
    if (!element) {
      return jsonResult({ found: false, element: null });
    }

    return jsonResult({ found: true, element });
  }

  async function handleSearchElements(
    args: Record<string, unknown>,
    _signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const notConnected = ensureConnected();
    if (notConnected) return notConnected;

    const query = readStringParam(args, "query", { required: true });
    const appBundleId = readStringParam(args, "appBundleId");

    const elements = await desktopSessionManager.searchElements(query, appBundleId ?? undefined);
    return jsonResult({
      query,
      appBundleId: appBundleId ?? undefined,
      count: elements.length,
      elements,
    });
  }

  function handleStartRecording(args: Record<string, unknown>): FridayAgentToolResult {
    const notConnected = ensureConnected();
    if (notConnected) return notConnected;

    const recordingName = readStringParam(args, "recordingName") ?? "Agent Recording";

    const recording = desktopSessionManager.startRecording({ name: recordingName });
    return jsonResult({
      recordingId: recording.id,
      name: recording.name,
      state: recording.state,
      createdAt: recording.createdAt,
    });
  }

  function handleStopRecording(args: Record<string, unknown>): FridayAgentToolResult {
    const notConnected = ensureConnected();
    if (notConnected) return notConnected;

    const recordingId = readStringParam(args, "recordingId", { required: true });
    const recording = desktopSessionManager.stopRecording(recordingId);
    const steps = desktopSessionManager.getRecordingSteps(recordingId);

    return jsonResult({
      recordingId: recording.id,
      name: recording.name,
      state: recording.state,
      stepCount: steps.length,
      createdAt: recording.createdAt,
      stoppedAt: recording.stoppedAt,
    });
  }

  async function handleCheckPermissions(): Promise<FridayAgentToolResult> {
    const notConnected = ensureConnected();
    if (notConnected) return notConnected;

    const permissions = await desktopSessionManager.checkPermissions();
    return jsonResult({
      permissions: permissions.map((p) => ({
        type: p.permissionType,
        status: p.status,
        platform: p.platform,
        grantInstructions: p.grantInstructions,
      })),
    });
  }

  function handleSessionInfo(): FridayAgentToolResult {
    const info = desktopSessionManager.getSessionInfo();
    // Surface whether this is a real desktop session or headless-only,
    // so the LLM does not misreport a headless browser as "desktop usable".
    const isHeadless = info.state === "connected" && !info.platform;
    return jsonResult({
      sessionId: info.sessionId,
      state: info.state,
      platform: info.platform,
      principalId: info.principalId,
      connectedAt: info.connectedAt,
      ...(isHeadless
        ? { warning: "Session is headless browser only — real desktop control (click, type, screenshot via OS) requires macOS TCC permissions (Accessibility, Screen Recording, Input Monitoring, Automation). Check permissions before reporting desktop as usable." }
        : {}),
    });
  }

  // ─── Desktop action builder ───

  function buildDesktopAction(
    actionType: string,
    args: Record<string, unknown>,
  ): FridayDesktopAction | null {
    switch (actionType) {
      case "click": {
        const x = readNumberParam(args, "x");
        const y = readNumberParam(args, "y");
        const strategy = readStringParam(args, "strategy") as FridayDesktopSelectorStrategy | undefined;
        const selectorValue = readStringParam(args, "selectorValue");
        return {
          type: "click",
          coordinates: x != null && y != null ? { x, y, width: 1, height: 1 } : undefined,
          selector: strategy && selectorValue ? { strategy, value: selectorValue } : undefined,
          button: (readStringParam(args, "button") as "left" | "right" | "middle") ?? undefined,
          clickType: (readStringParam(args, "clickType") as "single" | "double" | "triple") ?? undefined,
          modifiers: readModifiers(args),
        };
      }
      case "type": {
        const text = readStringParam(args, "text", { required: true });
        return { type: "type", text };
      }
      case "keypress": {
        const key = readStringParam(args, "text", { required: true });
        return { type: "keypress", key, modifiers: readModifiers(args) };
      }
      case "scroll": {
        const x = readNumberParam(args, "x");
        const y = readNumberParam(args, "y");
        return {
          type: "scroll",
          direction: (readStringParam(args, "direction") as "up" | "down" | "left" | "right") ?? "down",
          amount: readNumberParam(args, "amount") ?? 3,
          coordinates: x != null && y != null ? { x, y, width: 1, height: 1 } : undefined,
        };
      }
      case "drag": {
        const startX = readNumberParam(args, "startX", { required: true })!;
        const startY = readNumberParam(args, "startY", { required: true })!;
        const endX = readNumberParam(args, "endX", { required: true })!;
        const endY = readNumberParam(args, "endY", { required: true })!;
        return {
          type: "drag",
          from: { x: startX, y: startY, width: 1, height: 1 },
          to: { x: endX, y: endY, width: 1, height: 1 },
          modifiers: readModifiers(args),
        };
      }
      case "screenshot": {
        const displayIndex = readNumberParam(args, "displayIndex", { integer: true });
        const format = readStringParam(args, "format") as "png" | "jpeg" | undefined;
        return {
          type: "screenshot",
          displayIndex: displayIndex ?? undefined,
          format: format ?? undefined,
        };
      }
      case "read_element": {
        const strategy = (readStringParam(args, "strategy") ?? "accessibility_id") as FridayDesktopSelectorStrategy;
        const selectorValue = readStringParam(args, "selectorValue") ?? readStringParam(args, "text") ?? "";
        return {
          type: "read_element",
          selector: { strategy, value: selectorValue },
        };
      }
      case "launch_app": {
        const appIdentifier = readStringParam(args, "text", { required: true });
        return { type: "launch_app", appIdentifier };
      }
      case "close_app": {
        const appIdentifier = readStringParam(args, "text", { required: true });
        return { type: "close_app", appIdentifier };
      }
      case "clipboard": {
        const operation = readStringParam(args, "operation") ?? "read";
        if (operation === "write") {
          return {
            type: "clipboard",
            operation: "write" as const,
            content: readStringParam(args, "content") ?? "",
          };
        }
        if (operation === "clear") {
          return { type: "clipboard", operation: "clear" as const };
        }
        return { type: "clipboard", operation: "read" as const };
      }
      case "file_operation": {
        const filePath = readStringParam(args, "path", { required: true });
        // P1-SEC-003: Reject paths with directory traversal segments
        if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(filePath)) {
          return null;
        }
        const operation = readStringParam(args, "operation") ?? "read";
        switch (operation) {
          case "write":
            return {
              type: "file_operation",
              operation: "write" as const,
              path: filePath,
              content: readStringParam(args, "content") ?? "",
            };
          case "move":
            return {
              type: "file_operation",
              operation: "move" as const,
              path: filePath,
              destinationPath: readStringParam(args, "destinationPath", { required: true }),
            };
          case "copy":
            return {
              type: "file_operation",
              operation: "copy" as const,
              path: filePath,
              destinationPath: readStringParam(args, "destinationPath", { required: true }),
            };
          case "delete":
            return { type: "file_operation", operation: "delete" as const, path: filePath };
          case "list":
            return { type: "file_operation", operation: "list" as const, path: filePath };
          case "stat":
            return { type: "file_operation", operation: "stat" as const, path: filePath };
          case "read":
          default:
            return { type: "file_operation", operation: "read" as const, path: filePath };
        }
      }
      default:
        return null;
    }
  }

  function readModifiers(args: Record<string, unknown>): FridayDesktopModifierKey[] | undefined {
    const raw = args.modifiers;
    if (Array.isArray(raw)) {
      const mods = raw.filter(
        (v): v is FridayDesktopModifierKey => typeof v === "string" && VALID_MODIFIERS.has(v as FridayDesktopModifierKey),
      );
      return mods.length > 0 ? mods : undefined;
    }
    return undefined;
  }
}
