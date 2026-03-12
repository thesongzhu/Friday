/**
 * Media Format — Format enrichment blocks for agent context injection.
 *
 * @module media-understanding/friday-media-format
 */

import type {
  FridayMediaAttachment,
  FridayMediaEnrichmentBlock,
  FridayMediaUnderstandingOutput,
} from "./friday-media-understanding.types.js";

/**
 * Formats a media understanding output into an enrichment block for agent context.
 */
export function formatEnrichmentBlock(
  attachment: FridayMediaAttachment,
  output: FridayMediaUnderstandingOutput,
): FridayMediaEnrichmentBlock {
  const lines: string[] = [];

  const label = attachment.filename
    ? `[Attachment: ${attachment.filename}]`
    : `[Attachment: ${attachment.mediaType}]`;

  lines.push(label);

  if (output.description) {
    lines.push(`Description: ${output.description}`);
  }

  if (output.transcription) {
    lines.push(`Transcription: ${output.transcription}`);
  }

  if (output.extractedText) {
    lines.push(`Extracted text: ${output.extractedText}`);
  }

  if (output.entities && output.entities.length > 0) {
    lines.push(`Entities: ${output.entities.join(", ")}`);
  }

  if (output.language) {
    lines.push(`Language: ${output.language}`);
  }

  return {
    attachmentId: attachment.id,
    mediaType: attachment.mediaType,
    filename: attachment.filename,
    output,
    formattedBlock: lines.join("\n"),
  };
}

/**
 * Combines multiple enrichment blocks into a single context section.
 */
export function formatContextSection(
  blocks: readonly FridayMediaEnrichmentBlock[],
): string {
  if (blocks.length === 0) return "";

  const sections = blocks.map((block) => block.formattedBlock);
  return `--- Media Attachments ---\n${sections.join("\n\n")}\n--- End Attachments ---`;
}
