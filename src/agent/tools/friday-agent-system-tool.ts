import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type { FridaySystemService } from "../../system/engine/friday-system-service.js";
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
  | "release_control"
  | "approve"
  | "deny";

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
  "approve",
  "deny",
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
      "triage_notifications, resume_task, recover_ui, clipboard_read, clipboard_write, request_control, release_control, approve, deny.",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: Array.from(VALID_ACTIONS),
          description: "System action to execute.",
        },
        actorId: { type: "string", description: "Optional logical caller ID for control lease ownership." },
        actorKind: {
          type: "string",
          enum: ["agent", "api", "remote", "system"],
          description: "Caller kind for control lease ownership.",
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
        approvalId: { type: "string", description: "Approval rule identifier for approve/deny." },
        deviceId: { type: "string", description: "Remote device identifier." },
        riskLevel: {
          type: "string",
          enum: ["none", "low", "medium", "high", "critical"],
          description: "Risk level when creating or updating an approval rule.",
        },
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
        const result = await systemService.executeIntent({
          action,
          actorId: readStringParam(args, "actorId"),
          actorKind: readStringParam(args, "actorKind") as "agent" | "api" | "remote" | "system" | undefined,
          target: readStringParam(args, "target"),
          targetKind: readStringParam(args, "targetKind") as "app" | "url" | "project" | undefined,
          appIdentifier: readStringParam(args, "appIdentifier"),
          url: readStringParam(args, "url"),
          projectPath: readStringParam(args, "projectPath"),
          query: readStringParam(args, "query"),
          value: readStringParam(args, "value"),
          notificationId: readStringParam(args, "notificationId"),
          notificationAction: readStringParam(args, "notificationAction") as "open" | "dismiss" | "mark_read" | undefined,
          approvalId: readStringParam(args, "approvalId"),
          deviceId: readStringParam(args, "deviceId"),
          riskLevel: readStringParam(args, "riskLevel") as
            | "none"
            | "low"
            | "medium"
            | "high"
            | "critical"
            | undefined,
          reason: readStringParam(args, "reason"),
          force: readBooleanParam(args, "force") ?? undefined,
          leaseTtlMs: readNumberParam(args, "leaseTtlMs"),
          layout: readStringParam(args, "layout") as "single_focus" | "dual_pane" | "triad" | undefined,
        });
        return jsonResult(result);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
