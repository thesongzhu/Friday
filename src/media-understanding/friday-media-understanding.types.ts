/**
 * Media Understanding — Type definitions for attachment extraction.
 *
 * @module media-understanding/friday-media-understanding.types
 */

// ─── Attachment Types ───

export type FridayMediaType = "image" | "audio" | "video" | "document";

export interface FridayMediaAttachment {
  /** Unique attachment identifier. */
  readonly id: string;
  /** Original filename if available. */
  readonly filename: string | null;
  /** MIME type of the attachment. */
  readonly mimeType: string;
  /** Detected media category. */
  readonly mediaType: FridayMediaType;
  /** Size in bytes. */
  readonly sizeBytes: number;
  /** URL or local path to the attachment. */
  readonly sourceUrl: string;
  /** Channel the attachment came from. */
  readonly channelId?: string;
}

// ─── Configuration ───

export interface FridayMediaUnderstandingConfig {
  /** Whether media understanding is enabled. */
  readonly enabled: boolean;
  /** Maximum file size in bytes to process. */
  readonly maxFileSizeBytes: number;
  /** Allowed MIME type prefixes (e.g., ["image/", "audio/"]). */
  readonly allowedMimeTypePrefixes: readonly string[];
  /** Maximum number of attachments to process per message. */
  readonly maxAttachmentsPerMessage: number;
  /** Timeout per provider call in ms. */
  readonly providerTimeoutMs: number;
  /** Maximum concurrent provider calls. */
  readonly maxConcurrency: number;
}

export const DEFAULT_MEDIA_UNDERSTANDING_CONFIG: FridayMediaUnderstandingConfig = {
  enabled: true,
  maxFileSizeBytes: 25 * 1024 * 1024, // 25 MB
  allowedMimeTypePrefixes: ["image/", "audio/", "video/"],
  maxAttachmentsPerMessage: 5,
  providerTimeoutMs: 30_000,
  maxConcurrency: 3,
};

// ─── Provider ───

export interface FridayMediaUnderstandingOutput {
  /** Human-readable text description of the media. */
  readonly description: string;
  /** Detected language (for audio). */
  readonly language?: string;
  /** Transcription (for audio/video). */
  readonly transcription?: string;
  /** Extracted text (for images with OCR). */
  readonly extractedText?: string;
  /** Key entities detected. */
  readonly entities?: readonly string[];
  /** Confidence score [0, 1]. */
  readonly confidence: number;
  /** Provider that generated this output. */
  readonly provider: string;
  /** Processing time in ms. */
  readonly processingMs: number;
}

export interface FridayMediaUnderstandingProvider {
  /** Unique provider identifier. */
  readonly providerId: string;
  /** Media types this provider supports. */
  readonly supportedMediaTypes: readonly FridayMediaType[];
  /** Process an attachment and return understanding output. */
  process(
    attachment: FridayMediaAttachment,
    fetchContent: () => Promise<Buffer>,
  ): Promise<FridayMediaUnderstandingOutput>;
}

// ─── Decision Trace ───

export interface FridayMediaUnderstandingDecision {
  readonly attachmentId: string;
  readonly filename: string | null;
  readonly mimeType: string;
  readonly action: "processed" | "skipped_size" | "skipped_mime" | "skipped_limit" | "failed";
  readonly provider?: string;
  readonly error?: string;
}

// ─── Service Result ───

export interface FridayMediaUnderstandingResult {
  /** Enrichment blocks to append to agent context. */
  readonly enrichments: readonly FridayMediaEnrichmentBlock[];
  /** Decision trace for all attachments. */
  readonly decisions: readonly FridayMediaUnderstandingDecision[];
  /** Total processing time in ms. */
  readonly totalProcessingMs: number;
}

export interface FridayMediaEnrichmentBlock {
  readonly attachmentId: string;
  readonly mediaType: FridayMediaType;
  readonly filename: string | null;
  readonly output: FridayMediaUnderstandingOutput;
  /** Formatted text block for agent context injection. */
  readonly formattedBlock: string;
}
