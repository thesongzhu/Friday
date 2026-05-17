// Phase 14.5E module_28e Slice 6.5 — channel-triggered closeout receipt
// helpers.
//
// The task-workflow closeout-gate machinery already maps the
// `channel_event` evidence ref source to
// `rollbackClass = "non_reversible_external"` via
// `FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE` (Phase 14.5D), and
// the closeout gate synthesizer (`friday-task-workflow-closeout-gates.ts`)
// composes the `nonReversibleReason` string deterministically. What this
// slice adds is a small, scope-local helper that gives channel-triggered
// closeout call sites a stable, user-facing reason string for outbound
// channel sends. The same helper is consumed by the Slice 6.8 acceptance
// test so reviewers can verify the receipt wording without touching the
// Phase 14.5D synthesizer.

import {
  FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE,
  type FridayTaskWorkflowOperationRollbackClass,
} from "../../task-workflows/friday-task-workflow.types.js";

export interface FridayChannelOutboundReceiptInput {
  readonly channelKind: string;
  readonly chatId: string;
  readonly messageId: string;
}

export interface FridayChannelOutboundReceiptSummary {
  readonly evidenceRefSource: "channel_event";
  readonly rollbackClass: FridayTaskWorkflowOperationRollbackClass;
  readonly nonReversibleReason: string;
  readonly evidenceRefId: string;
}

export function buildFridayChannelOutboundReceiptSummary(
  input: FridayChannelOutboundReceiptInput,
): FridayChannelOutboundReceiptSummary {
  const channelKind = String(input.channelKind ?? "").trim();
  const chatId = String(input.chatId ?? "").trim();
  const messageId = String(input.messageId ?? "").trim();
  if (channelKind.length === 0 || chatId.length === 0 || messageId.length === 0) {
    throw new Error(
      "Channel outbound receipt requires non-empty channelKind, chatId, and messageId.",
    );
  }
  const channelId = `${channelKind}:${chatId}`;
  const evidenceRefId = `channel-event:${channelId}:${messageId}`;
  // Deterministic registry lookup — see Phase 14.5D
  // FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE. Asserting via the
  // registry rather than hard-coding the class keeps this helper honest
  // if the rollback class for `channel_event` ever changes.
  const rollbackClass = FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE.channel_event;
  return {
    evidenceRefSource: "channel_event",
    rollbackClass,
    nonReversibleReason:
      `Channel outbound message delivered to ${channelId}; external delivery not reversible.`,
    evidenceRefId,
  };
}
