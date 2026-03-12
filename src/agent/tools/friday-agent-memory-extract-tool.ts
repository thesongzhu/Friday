/**
 * OC-013: Memory extract agent tool — manual extraction trigger from session.
 */

import type {
  FridayAgentToolDefinition,
  FridayAgentToolResult,
} from "../model/friday-agent.types.js";
import { errorResult, jsonResult, readStringParam } from "./friday-agent-tool-helpers.js";
import type { FridaySessionMemoryExtractionService } from "#sessions";

// ─── Types ───

export interface CreateFridayAgentMemoryExtractToolOptions {
  extractionService: FridaySessionMemoryExtractionService;
}

// ─── Factory ───

export function createFridayAgentMemoryExtractTool(
  options: CreateFridayAgentMemoryExtractToolOptions,
): FridayAgentToolDefinition {
  const { extractionService } = options;

  return {
    name: "memory_extract",
    description:
      "Extract and persist memory from a session's conversation history. " +
      "Use this to manually trigger memory extraction for a specific session.",
    parameters: {
      properties: {
        sessionKey: {
          type: "string",
          description: "The session key to extract memory from (required).",
        },
        mode: {
          type: "string",
          enum: ["inline", "queue"],
          description: 'Extraction mode: "inline" runs synchronously, "queue" enqueues for background processing. Default: "inline".',
        },
      },
      required: ["sessionKey"],
    },

    async execute(
      args: Record<string, unknown>,
      _signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const sessionKey = readStringParam(args, "sessionKey", { required: true });
      const mode = (readStringParam(args, "mode") ?? "inline") as "inline" | "queue";

      if (mode !== "inline" && mode !== "queue") {
        return errorResult(`Invalid mode "${mode as string}". Valid: inline, queue`);
      }

      try {
        const result = await extractionService.extractFromSession(sessionKey, {
          trigger: "manual",
          mode,
        });

        return jsonResult({
          sessionKey,
          mode: result.mode,
          queued: result.queued,
          processedMessages: result.processedMessageCount,
          extractedMessages: result.extractedMessageCount,
          skippedMessages: result.skippedMessageCount,
          failedMessages: result.failedMessageCount,
          memoryItemsCreated: result.memoryItemsCreated,
          message: result.queued
            ? "Extraction job queued for background processing."
            : `Extracted ${String(result.memoryItemsCreated)} memory item(s) from ${String(result.processedMessageCount)} message(s).`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Memory extraction failed: ${message}`);
      }
    },
  };
}
