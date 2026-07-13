/**
 * Channel Entry Adapter — Initiative A.4
 *
 * Thin adapter that translates a `FridayChannelMessage` into a
 * `FridayEngineRunInput` and returns the engine result.
 *
 * Channel-specific concerns (send policy, outbound delivery,
 * debouncing) remain outside this adapter — it only handles the
 * inbound → engine → result translation.
 */

import { unlink } from "node:fs/promises";

import type {
  FridayEngineRunInput,
  FridayEngineRunResult,
  FridayOrchestrationEngine,
  FridayRunTerminalStatus,
} from "../friday-orchestration-engine.types.js";
import type { FridayChannelAttachment } from "../../channels/friday-channel.types.js";

// ─── Channel message shape (mirrors FridayChannelMessage) ───

export interface FridayChannelInboundMessage {
  /** Unique message ID from the source platform. */
  id: string;
  /** Channel plugin kind (e.g. "qq", "lark", "discord"). */
  channelKind: string;
  /** Platform-specific sender identifier. */
  senderId: string;
  /** Optional sender display name. */
  senderName?: string;
  /** Platform-specific conversation/room/group identifier. */
  chatId: string;
  /** Whether this is a direct message or group message. */
  chatType: "direct" | "group";
  /** Text content of the message. */
  text: string;
  /** ISO timestamp of the message. */
  occurredAt?: string;
  /** Optional reply-to reference. */
  replyToMessageId?: string;
  /** Optional timezone. */
  timezone?: string;
  /** Optional unix timestamp in milliseconds. */
  timestamp?: number;
  /** Optional image attachments already normalized by the channel layer. */
  images?: string[];
  /** Optional normalized attachments from the channel layer. */
  attachments?: FridayChannelAttachment[];
}

// ─── Adapter ───

export interface FridayChannelEntryAdapterDeps {
  engine: FridayOrchestrationEngine;
  idGenerator: () => string;
  /** Resolve a session key from channel + chat identifiers. */
  resolveSessionKey: (message: FridayChannelInboundMessage) => string;
  /** Optional channel policy hook. Defaults to no channel-specific tool restrictions. */
  resolveDisabledToolNames?: (channelKind: string) => string[];
  /** Optional: resolve a persona/system-prompt override for this channel kind. */
  resolveChannelPersona?: (channelKind: string) => { persona?: string; systemPrompt?: string } | undefined;
}

export const FRIDAY_CHANNEL_AGENT_SCOPE = "agent.run";
export const FRIDAY_CHANNEL_CONTROL_ROUTE = "full_agent";

function resolvedAttachmentPath(attachment: FridayChannelAttachment): string | undefined {
  return attachment.localPath ?? attachment.sourceUrl;
}

// ─── Per-run raw-attachment cleanup (PRIV-RAW-AUDIO per-run slice) ───
//
// Inbound channel attachments (raw audio/image/file bytes) are saved to a temp
// file by the channel layer, with the path on `attachment.localPath`. The run
// reads that file DURING execution (image -> base64 at LLM-request time;
// audio/file -> agent tool mid-run), so the file MUST survive until the run
// reaches a terminal state. This helper unlinks the owned temp files right after
// the run resolves/rejects (seconds after run-terminal) instead of waiting for
// the channel lifecycle boundary (the #1570 disconnect/stop backstop), which
// held raw audio for the whole session.

/**
 * Suspended runs resume via `engine.resumeRun` and still need to read the file,
 * so their attachments must NOT be deleted (deleting = use-after-unlink bug).
 */
const FRIDAY_SUSPENDED_RUN_STATUSES: ReadonlySet<FridayRunTerminalStatus> = new Set<FridayRunTerminalStatus>([
  "awaiting_clarification",
  "awaiting_plan_approval",
]);

/**
 * Whether the given attachment.localPath is an owned, on-disk temp path this
 * processing may unlink: present/non-empty, successfully saved (status
 * "resolved"), and a real local fs path (not an http(s) sourceUrl).
 */
function isOwnedLocalAttachmentPath(attachment: FridayChannelAttachment): attachment is FridayChannelAttachment & { localPath: string } {
  const localPath = attachment.localPath;
  return (
    attachment.status === "resolved" &&
    typeof localPath === "string" &&
    localPath.length > 0 &&
    !/^https?:\/\//i.test(localPath)
  );
}

/**
 * Unlink the raw temp files owned by THIS message's attachments once the run is
 * genuinely terminal (or on an uncertain-terminal reject). Correlation-safe:
 * touches only the exact `attachment.localPath` values on THIS message — never a
 * directory scan, never another run's path. Idempotent: tolerates ENOENT (the
 * #1570 disconnect() backstop or a double-invoke may have already removed it).
 *
 * @param terminalStatus the resolved run status, or `undefined` when the run
 *   REJECTED/threw (uncertain-terminal → privacy-safe default is to delete).
 */
async function cleanupOwnedAttachments(
  attachments: readonly FridayChannelAttachment[] | undefined,
  terminalStatus: FridayRunTerminalStatus | undefined,
): Promise<void> {
  if (!attachments || attachments.length === 0) return;
  // Suspended run: the file is still needed on resume — do not delete.
  if (terminalStatus !== undefined && FRIDAY_SUSPENDED_RUN_STATUSES.has(terminalStatus)) return;
  await Promise.all(
    attachments.map(async (attachment) => {
      if (!isOwnedLocalAttachmentPath(attachment)) return;
      try {
        await unlink(attachment.localPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          // Best-effort privacy cleanup: never turn a completed run into a
          // failure because a temp unlink hit EPERM/EBUSY/etc. The #1570
          // lifecycle backstop remains as a second sweep.
          console.warn(
            `[friday][channel-entry] attachment cleanup failed for ${attachment.localPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }),
  );
}

function buildAttachmentPrompt(attachments: readonly FridayChannelAttachment[] | undefined): string | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  const lines = attachments.map((attachment, index) => {
    const location = resolvedAttachmentPath(attachment);
    const status = attachment.status === "resolved"
      ? "resolved"
      : `${attachment.status}${attachment.error ? `: ${attachment.error}` : ""}`;
    const name = attachment.filename ? ` "${attachment.filename}"` : "";
    const details = [
      `#${String(index + 1)}`,
      attachment.kind,
      name,
      attachment.contentType ? `type=${attachment.contentType}` : undefined,
      attachment.sizeBytes !== undefined ? `size=${String(attachment.sizeBytes)} bytes` : undefined,
      location ? `path=${location}` : undefined,
      `status=${status}`,
    ].filter((item): item is string => typeof item === "string" && item.length > 0);
    return `- ${details.join(" ")}`;
  });
  return [
    "Channel attachments have already been normalized by the channel adapter.",
    "Use the local paths below when a tool needs to inspect a file. If an attachment failed to resolve, explain the exact failure and do not pretend to see it.",
    ...lines,
  ].join("\n");
}

export function createFridayChannelEntryAdapter(deps: FridayChannelEntryAdapterDeps) {
  const { engine, idGenerator, resolveSessionKey, resolveDisabledToolNames, resolveChannelPersona } = deps;

  async function handleMessage(msg: FridayChannelInboundMessage): Promise<FridayEngineRunResult> {
    const hasImages = (msg.images?.length ?? 0) > 0;
    const hasAttachments = (msg.attachments?.length ?? 0) > 0;
    const task = msg.text.trim() || (hasImages ? "Analyze the attached image." : hasAttachments ? "Analyze the attached media." : "");
    if (!task) {
      return {
        runId: "",
        status: "failed",
        toolCallCount: 0,
        durationMs: 0,
        error: {
          category: "task_error",
          message: "Empty message received from channel.",
          retryable: false,
        },
      };
    }

    // Resolve optional per-channel persona
    const personaConfig = resolveChannelPersona?.(msg.channelKind);
    const channelPersona = personaConfig?.systemPrompt || personaConfig?.persona || undefined;
    const attachmentPrompt = buildAttachmentPrompt(msg.attachments);
    const taskPrompt = attachmentPrompt ? `${task}\n\n${attachmentPrompt}` : undefined;
    const attachmentImages = (msg.attachments ?? [])
      .filter((attachment) => attachment.kind === "image" && attachment.status === "resolved")
      .map(resolvedAttachmentPath)
      .filter((image): image is string => typeof image === "string" && image.length > 0);
    const images = [...new Set([...(msg.images ?? []), ...attachmentImages])];

    const input: FridayEngineRunInput = {
      task,
      taskPrompt,
      runId: idGenerator(),
      sessionKey: resolveSessionKey(msg),
      replyToMessageId: msg.replyToMessageId,
      timezone: msg.timezone,
      principalId: msg.senderId,
      scopes: [FRIDAY_CHANNEL_AGENT_SCOPE],
      disabledToolNames: resolveDisabledToolNames?.(msg.channelKind) ?? [],
      images: images.length > 0 ? images : undefined,
      taskAlreadyInHistory: true,
      executionContext: {
        surface: "channel",
        interactive: true,
        channelKind: msg.channelKind,
        channelChatType: msg.chatType,
        channelControlRoute: FRIDAY_CHANNEL_CONTROL_ROUTE,
        channelPersona,
      },
      tenantContext: {
        hubId: "default",
        userId: msg.senderId,
        channelKind: msg.channelKind,
      },
      idempotencyPrefix: `channel-${msg.channelKind}`,
    };

    // Run the engine, then reap this message's owned raw-attachment temp files.
    // Cleanup runs ONLY after executeRun resolves or rejects — never before, so
    // the run can still READ the file DURING execution (no-degrade requirement).
    let result: FridayEngineRunResult;
    try {
      result = await engine.executeRun(input);
    } catch (err) {
      // REJECT / thrown error → uncertain-terminal. Privacy-safe default: unlink
      // the owned localPath (this processing owns it and it won't be reused),
      // then re-throw the ORIGINAL error (never swallow it).
      await cleanupOwnedAttachments(msg.attachments, undefined);
      throw err;
    }
    await cleanupOwnedAttachments(msg.attachments, result.status);
    return result;
  }

  return { handleMessage };
}
