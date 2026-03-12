/**
 * Media Attachments — Build attachment list from channel messages and apply policies.
 *
 * @module media-understanding/friday-media-attachments
 */

import type {
  FridayMediaAttachment,
  FridayMediaType,
  FridayMediaUnderstandingConfig,
  FridayMediaUnderstandingDecision,
} from "./friday-media-understanding.types.js";

// ─── MIME → Media Type Mapping ───

const MIME_PREFIX_MAP: readonly [string, FridayMediaType][] = [
  ["image/", "image"],
  ["audio/", "audio"],
  ["video/", "video"],
  ["application/pdf", "document"],
  ["text/", "document"],
];

export function detectMediaType(mimeType: string): FridayMediaType {
  const lower = mimeType.toLowerCase();
  for (const [prefix, mediaType] of MIME_PREFIX_MAP) {
    if (lower.startsWith(prefix)) return mediaType;
  }
  return "document";
}

// ─── Attachment Input ───

export interface RawAttachmentInput {
  readonly id: string;
  readonly filename?: string | null;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly channelId?: string;
}

/**
 * Converts raw attachment inputs into typed media attachments.
 */
export function buildAttachmentList(
  inputs: readonly RawAttachmentInput[],
): FridayMediaAttachment[] {
  return inputs.map((input) => ({
    id: input.id,
    filename: input.filename ?? null,
    mimeType: input.mimeType,
    mediaType: detectMediaType(input.mimeType),
    sizeBytes: input.sizeBytes,
    sourceUrl: input.url,
    channelId: input.channelId,
  }));
}

/**
 * Applies scope, size, and MIME policy to an attachment list.
 *
 * Returns a tuple of [eligible attachments, decisions for all].
 */
export function applyAttachmentPolicy(
  attachments: readonly FridayMediaAttachment[],
  config: FridayMediaUnderstandingConfig,
): {
  eligible: FridayMediaAttachment[];
  decisions: FridayMediaUnderstandingDecision[];
} {
  const eligible: FridayMediaAttachment[] = [];
  const decisions: FridayMediaUnderstandingDecision[] = [];

  for (const attachment of attachments) {
    // Check attachment limit
    if (eligible.length >= config.maxAttachmentsPerMessage) {
      decisions.push({
        attachmentId: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        action: "skipped_limit",
      });
      continue;
    }

    // Check MIME type
    const mimeAllowed = config.allowedMimeTypePrefixes.some((prefix) =>
      attachment.mimeType.toLowerCase().startsWith(prefix),
    );
    if (!mimeAllowed) {
      decisions.push({
        attachmentId: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        action: "skipped_mime",
      });
      continue;
    }

    // Check size
    if (attachment.sizeBytes > config.maxFileSizeBytes) {
      decisions.push({
        attachmentId: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        action: "skipped_size",
      });
      continue;
    }

    eligible.push(attachment);
  }

  return { eligible, decisions };
}
