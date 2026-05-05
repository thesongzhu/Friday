import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type { FridaySystemService } from "../../system/engine/friday-system-service.js";
import type { FridayCanonicalApprovalResolution } from "../../security/friday-mutating-action-gate.js";
import {
  errorResult,
  jsonResult,
  readBooleanParam,
  readNumberParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

export interface CreateFridayAgentSystemToolOptions {
  systemService: FridaySystemService;
}

function readCanonicalApprovalParam(
  args: Record<string, unknown>,
): FridayCanonicalApprovalResolution | undefined {
  const value = args.canonicalApproval;
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as FridayCanonicalApprovalResolution;
}

type SystemAction =
  | "snapshot"
  | "open"
  | "focus"
  | "arrange_windows"
  | "launch_app"
  | "close_app"
  | "open_url"
  | "open_project"
  | "search_file"
  | "handoff_to_browser"
  | "handoff_to_terminal"
  | "read_notification"
  | "notification_list"
  | "notification_act"
  | "triage_notifications"
  | "resume_task"
  | "recover_ui"
  | "clipboard_read"
  | "clipboard_write"
  | "request_control"
  | "release_control";

const VALID_ACTIONS = new Set<SystemAction>([
  "snapshot",
  "open",
  "focus",
  "arrange_windows",
  "launch_app",
  "close_app",
  "open_url",
  "open_project",
  "search_file",
  "handoff_to_browser",
  "handoff_to_terminal",
  "read_notification",
  "notification_list",
  "notification_act",
  "triage_notifications",
  "resume_task",
  "recover_ui",
  "clipboard_read",
  "clipboard_write",
  "request_control",
  "release_control",
]);

export function createFridayAgentSystemTool(
  options: CreateFridayAgentSystemToolOptions,
): FridayAgentToolDefinition {
  const { systemService } = options;

  return {
    name: "system",
    description:
      "High-level local computer orchestration for Friday Agent OS. " +
      "Actions: snapshot, open, focus, arrange_windows, launch_app, close_app, open_url, open_project, " +
      "search_file, handoff_to_browser, handoff_to_terminal, read_notification, notification_list, notification_act, " +
      "triage_notifications, resume_task, recover_ui, clipboard_read, clipboard_write, request_control, release_control.",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: Array.from(VALID_ACTIONS),
          description: "System action to execute.",
        },
        target: { type: "string", description: "Generic target string (app, URL, project path, task label)." },
        targetKind: {
          type: "string",
          enum: ["app", "url", "project"],
          description: "Explicit target kind for generic open actions.",
        },
        appIdentifier: { type: "string", description: "Application identifier or user-facing app name." },
        url: { type: "string", description: "URL for browser handoff/open actions." },
        projectPath: { type: "string", description: "Project path rooted within the configured workspace." },
        query: { type: "string", description: "Search query for search_file." },
        value: { type: "string", description: "Task text or clipboard contents." },
        notificationId: { type: "string", description: "Notification identifier for read_notification." },
        notificationAction: {
          type: "string",
          enum: ["open", "dismiss", "mark_read"],
          description: "Notification action for notification_act.",
        },
        deviceId: { type: "string", description: "Remote device identifier." },
        reason: { type: "string", description: "Human-readable reason, rationale, or lease note." },
        force: { type: "boolean", description: "Force a close_app action." },
        leaseTtlMs: { type: "number", description: "Optional lease lifetime in milliseconds." },
        layout: {
          type: "string",
          enum: ["single_focus", "dual_pane", "triad"],
          description: "Preferred window layout for arrange_windows.",
        },
      },
      required: ["action"],
    },

    async execute(
      args: Record<string, unknown>,
      _signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const action = readStringParam(args, "action", { required: true }) as SystemAction;
      if (!VALID_ACTIONS.has(action)) {
        return errorResult(
          `Invalid action "${action}". Valid actions: ${Array.from(VALID_ACTIONS).join(", ")}`,
        );
      }

      try {
        const canonicalApproval = readCanonicalApprovalParam(args);
        const canonicalActorId = canonicalApproval
          ? readStringParam(args, "canonicalActorId") ?? "agent-runtime"
          : "agent-runtime";
        const result = await systemService.executeIntent({
          action,
          actorId: canonicalActorId,
          actorKind: "agent",
          target: readStringParam(args, "target"),
          targetKind: readStringParam(args, "targetKind") as "app" | "url" | "project" | undefined,
          appIdentifier: readStringParam(args, "appIdentifier"),
          url: readStringParam(args, "url"),
          projectPath: readStringParam(args, "projectPath"),
          query: readStringParam(args, "query"),
          value: readStringParam(args, "value"),
          notificationId: readStringParam(args, "notificationId"),
          notificationAction: readStringParam(args, "notificationAction") as "open" | "dismiss" | "mark_read" | undefined,
          deviceId: readStringParam(args, "deviceId"),
          reason: readStringParam(args, "reason"),
          force: readBooleanParam(args, "force") ?? undefined,
          leaseTtlMs: readNumberParam(args, "leaseTtlMs"),
          layout: readStringParam(args, "layout") as "single_focus" | "dual_pane" | "triad" | undefined,
          idempotencyKey: readStringParam(args, "idempotencyKey"),
          canonicalApproval,
        });
        return jsonResult(result);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
