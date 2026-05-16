/**
 * Phase 13.5D configured-channel task workflow command helpers.
 *
 * This module contains the pure helpers required to:
 *
 *   * Hash channel identifiers (chat id, message id, sender id) before
 *     persistence so the channel command table never stores raw values.
 *   * Generate Friday-issued opaque confirmation tokens that gate the
 *     canonical dispatch step.
 *   * Compose Friday-authored outbound disclosure text so callers never
 *     need to echo raw inbound user content back through the channel
 *     registry.
 *   * Translate the small set of canonical task workflow intents to the
 *     `dispatchedAction` label that gets persisted on dispatch.
 *
 * Stateful operations (insert, confirm, dispatch) live in the task
 * workflow service so this module stays a pure helper layer.
 *
 * @module task-workflows/friday-task-workflow-channel-commands
 */

import * as crypto from "node:crypto";

import type {
  FridayTaskWorkflowChannelIntentKind,
} from "./friday-task-workflow.types.js";

/** Default confirmation token TTL when the caller does not specify one. */
export const FRIDAY_TASK_WORKFLOW_CHANNEL_COMMAND_DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Hash a canonical channel identifier into a stable, opaque hex digest.
 *  Returns "" for empty inputs so the caller can validate prior to hash. */
export function hashFridayChannelIdentifier(value: string): string {
  if (typeof value !== "string" || value.length === 0) return "";
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Issue an opaque, time-bounded confirmation token. */
export function issueFridayChannelCommandConfirmationToken(): string {
  return `twcc_${crypto.randomBytes(18).toString("hex")}`;
}

/** Map a canonical intent to its dispatched-action label. */
export function getFridayTaskWorkflowChannelDispatchedAction(
  intent: FridayTaskWorkflowChannelIntentKind,
): string {
  switch (intent) {
    case "progress_query":
      return "task.workflows.supervisor.read";
    case "closeout_request":
      return "task.workflows.closeout";
    case "supervisor_mode_preview":
      return "task.workflows.preview";
    case "confirm_token":
      return "task.workflows.channel.confirm";
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}

/** Compose the outbound disclosure text for an issued command. The text
 *  is built from Friday-controlled labels only; raw inbound text is
 *  never echoed back. */
export function composeFridayTaskWorkflowChannelIssuedDisclosure(input: {
  readonly workflowId: string;
  readonly intentKind: FridayTaskWorkflowChannelIntentKind;
  readonly confirmationToken: string;
  readonly expiresAt: string;
}): string {
  const action = humanIntent(input.intentKind);
  return [
    `Friday task-workflow ${input.workflowId}`,
    `Requested action: ${action}.`,
    `Reply with: confirm ${input.confirmationToken}`,
    `Token expires at ${input.expiresAt}.`,
  ].join("\n");
}

/** Compose the outbound disclosure text after a command has been
 *  dispatched (action ran). Friday-authored summary only. */
export function composeFridayTaskWorkflowChannelDispatchedDisclosure(input: {
  readonly workflowId: string;
  readonly intentKind: FridayTaskWorkflowChannelIntentKind;
  readonly dispatchedAction: string;
}): string {
  const action = humanIntent(input.intentKind);
  return [
    `Friday task-workflow ${input.workflowId}`,
    `Confirmed action: ${action}.`,
    `Dispatched: ${input.dispatchedAction}.`,
  ].join("\n");
}

function humanIntent(intent: FridayTaskWorkflowChannelIntentKind): string {
  switch (intent) {
    case "progress_query":
      return "Read supervisor progress";
    case "closeout_request":
      return "Run closeout for workflow";
    case "supervisor_mode_preview":
      return "Preview supervisor mode plan";
    case "confirm_token":
      return "Confirm previously issued token";
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}
