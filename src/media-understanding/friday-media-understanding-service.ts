/**
 * Media Understanding Service — Orchestrates attachment processing pipeline.
 *
 * @module media-understanding/friday-media-understanding-service
 */

import type {
  FridayMediaAttachment,
  FridayMediaUnderstandingConfig,
  FridayMediaUnderstandingDecision,
  FridayMediaUnderstandingProvider,
  FridayMediaUnderstandingResult,
} from "./friday-media-understanding.types.js";
import { DEFAULT_MEDIA_UNDERSTANDING_CONFIG } from "./friday-media-understanding.types.js";
import { applyAttachmentPolicy } from "./friday-media-attachments.js";
import { runProviderChain } from "./friday-media-providers.js";
import { formatEnrichmentBlock } from "./friday-media-format.js";

// ─── Deps ───

export interface FridayMediaUnderstandingServiceDeps {
  readonly providers: readonly FridayMediaUnderstandingProvider[];
  readonly fetchContent: (attachment: FridayMediaAttachment) => Promise<Buffer>;
  readonly config?: FridayMediaUnderstandingConfig;
}

// ─── Interface ───

export interface FridayMediaUnderstandingService {
  /** Process a batch of attachments and return enrichment blocks. */
  processAttachments(
    attachments: readonly FridayMediaAttachment[],
  ): Promise<FridayMediaUnderstandingResult>;
}

// ─── Factory ───

export function createFridayMediaUnderstandingService(
  deps: FridayMediaUnderstandingServiceDeps,
): FridayMediaUnderstandingService {
  const config = deps.config ?? DEFAULT_MEDIA_UNDERSTANDING_CONFIG;

  return {
    async processAttachments(attachments) {
      const startTime = Date.now();

      if (!config.enabled || attachments.length === 0) {
        return {
          enrichments: [],
          decisions: attachments.map((a) => ({
            attachmentId: a.id,
            filename: a.filename,
            mimeType: a.mimeType,
            action: "skipped_mime" as const,
          })),
          totalProcessingMs: Date.now() - startTime,
        };
      }

      // Apply policies
      const { eligible, decisions } = applyAttachmentPolicy(attachments, config);

      if (eligible.length === 0) {
        return {
          enrichments: [],
          decisions,
          totalProcessingMs: Date.now() - startTime,
        };
      }

      // Run providers
      const results = await runProviderChain(
        eligible,
        deps.providers,
        deps.fetchContent,
        config.maxConcurrency,
        config.providerTimeoutMs,
      );

      // Build enrichment blocks and final decisions
      const enrichments = [];
      const allDecisions = [...decisions];

      for (const attachment of eligible) {
        const result = results.get(attachment.id);

        if (!result) {
          allDecisions.push({
            attachmentId: attachment.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            action: "failed",
            error: "No result from provider",
          });
          continue;
        }

        if (result instanceof Error) {
          allDecisions.push({
            attachmentId: attachment.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            action: "failed",
            error: result.message,
          });
          continue;
        }

        enrichments.push(formatEnrichmentBlock(attachment, result));
        allDecisions.push({
          attachmentId: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          action: "processed",
          provider: result.provider,
        });
      }

      return {
        enrichments,
        decisions: allDecisions,
        totalProcessingMs: Date.now() - startTime,
      };
    },
  };
}
