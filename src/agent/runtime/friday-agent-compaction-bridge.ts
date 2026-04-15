/**
 * Compaction Bridge: adapts between agent-layer messages (FridayAgentMessage)
 * and provider-layer messages (FridayProviderContextMessage) so the
 * sophisticated provider compactor can be used in the main agent loop.
 *
 * Graceful degradation: if the provider compactor throws, the caller falls
 * back to the legacy `compactMessagesIfNeeded()` function.
 */

import type { FridayAgentMessage } from "../model/friday-agent.types.js";
import type {
  FridayContextCompactionBlockSummary,
  FridayContextCompactionSummary,
  FridayProviderContextMessage,
} from "../../providers/model/friday-provider-context.types.js";
import type { FridayProviderContextCompactor } from "../../providers/context/friday-provider-context-compactor.js";
import type { FridayProviderTokenEstimator } from "../../providers/context/friday-provider-token-estimator.js";
import type { FridayProviderContextPruner } from "../../providers/context/friday-provider-context-pruner.js";
import { verifyCompactionSummary } from "./friday-agent-compaction-verifier.js";

// ─── Result types ───

export interface FridayAgentCompactionBridgeResult {
  /** Whether compaction actually occurred. */
  compacted: boolean;
  /** The resulting message array (compacted or unchanged). */
  messages: FridayAgentMessage[];
  /** Structured summary of dropped blocks (if compaction occurred). */
  summary?: FridayContextCompactionSummary;
  /** Per-block summaries for all blocks (kept and dropped). */
  blocks?: FridayContextCompactionBlockSummary[];
  /** Number of messages dropped during compaction. */
  droppedMessageCount: number;
  /** Token estimate before compaction. */
  estimatedTokensBefore: number;
  /** Token estimate after compaction. */
  estimatedTokensAfter: number;
}

// ─── Bridge interface ───

export interface FridayAgentCompactionBridge {
  compact(params: {
    messages: FridayAgentMessage[];
    systemPrompt: string;
    task: string;
    contextWindowTokens: number;
    summarize?: (prompt: { system: string; user: string }) => Promise<string>;
  }): Promise<FridayAgentCompactionBridgeResult>;
}

// ─── Factory ───

export interface CreateFridayAgentCompactionBridgeDeps {
  compactor: FridayProviderContextCompactor;
  estimator: FridayProviderTokenEstimator;
  pruner: FridayProviderContextPruner;
  idGenerator: () => string;
  nowIso: () => string;
  /**
   * Optional default LLM summarize callback.  When provided and no per-call
   * summarize is given, this is used to generate LLM-powered summaries of
   * dropped blocks.  Route to a fast/cheap model (Haiku, GPT-4o-mini).
   */
  defaultSummarize?: (prompt: { system: string; user: string }) => Promise<string>;
}

export function createFridayAgentCompactionBridge(
  deps: CreateFridayAgentCompactionBridgeDeps,
): FridayAgentCompactionBridge {
  const { compactor, idGenerator, nowIso, defaultSummarize } = deps;

  return {
    async compact(params) {
      const { messages, systemPrompt, task, contextWindowTokens, summarize } = params;

      // ── Step 1: Convert agent messages to provider messages ──
      // Build a lookup map keyed by messageId so we can restore original
      // content blocks later.  We also store the serialized text so we can
      // detect whether the pruner modified the content (head+tail truncation).
      const originalMap = new Map<string, { agent: FridayAgentMessage; serializedText: string }>();
      const providerMessages: FridayProviderContextMessage[] = [];

      for (const msg of messages) {
        const msgId = idGenerator();
        const contentText = serializeAgentContent(msg.content);
        originalMap.set(msgId, { agent: msg, serializedText: contentText });

        const toolName = extractToolName(msg);

        providerMessages.push({
          messageId: msgId,
          role: mapAgentRoleToProvider(msg),
          content: contentText,
          createdAt: nowIso(),
          ...(toolName ? { toolName } : {}),
        });
      }

      // ── Step 2: Call provider compactor ──
      // Priority: per-call summarize > factory-level defaultSummarize > empty fallback
      const fallbackSummarize = summarize ?? defaultSummarize ?? (async (_prompt: { system: string; user: string }) => {
        // No LLM available — return empty string so template-based extraction is used
        return "";
      });

      const result = await compactor.compact({
        systemPrompt,
        userPrompt: task,
        messages: providerMessages,
        contextWindowTokens,
        summarize: fallbackSummarize,
      });

      if (!result.compacted) {
        return {
          compacted: false,
          messages,
          droppedMessageCount: 0,
          estimatedTokensBefore: result.estimatedTokensBefore,
          estimatedTokensAfter: result.estimatedTokensAfter,
        };
      }

      // ── Step 3: Convert kept messages back to agent messages ──
      // For each kept message, check whether the pruner modified its content.
      // If the content is unchanged, restore the original rich content blocks.
      // If the pruner truncated it (head+tail), use the pruned text instead.
      const agentMessages: FridayAgentMessage[] = [];
      for (const keptMsg of result.keptMessages) {
        if (keptMsg.messageId === "compaction-summary") {
          // Summary message generated by the compactor — always plain text.
          agentMessages.push({
            role: "user",
            content: keptMsg.content,
          });
          continue;
        }

        const entry = originalMap.get(keptMsg.messageId);
        if (!entry) {
          // Unknown message — should not happen, but handle gracefully.
          agentMessages.push({
            role: keptMsg.role === "assistant" ? "assistant" : "user",
            content: keptMsg.content,
          });
          continue;
        }

        // If the compactor/pruner modified the content (e.g. head+tail truncation),
        // use the modified text.  Otherwise restore the original rich content blocks.
        const wasModified = keptMsg.content !== entry.serializedText;
        if (wasModified) {
          agentMessages.push({
            role: entry.agent.role,
            content: keptMsg.content,
          });
        } else {
          agentMessages.push(entry.agent);
        }
      }

      // ── Step 4: Verify summary entity recall ──
      // If the summary mentions entities that don't exist in the source messages,
      // discard it (likely hallucinated or overly generic).  The per-block
      // template summaries in result.blocks are always trustworthy since they're
      // regex-based, so we only gate the aggregated summary.
      let verifiedSummary = result.summary;
      if (verifiedSummary && result.droppedMessages.length > 0) {
        const verification = verifyCompactionSummary({
          originalMessages: result.droppedMessages,
          summary: verifiedSummary,
        });
        if (!verification.valid) {
          // Summary failed verification — discard it but keep block-level summaries
          verifiedSummary = undefined;
        }
      }

      return {
        compacted: true,
        messages: agentMessages,
        summary: verifiedSummary,
        blocks: result.blocks,
        droppedMessageCount: result.droppedMessages.length,
        estimatedTokensBefore: result.estimatedTokensBefore,
        estimatedTokensAfter: result.estimatedTokensAfter,
      };
    },
  };
}

// ─── Helpers ───

/**
 * Serialize agent message content (which can be string or content-block array)
 * into a plain text string for the provider compactor.
 */
function serializeAgentContent(content: FridayAgentMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return String(content ?? "");
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (block && typeof block === "object" && "type" in block) {
      switch (block.type) {
        case "tool_use":
          parts.push(`[tool_use: ${(block as { name?: string }).name ?? "unknown"}]`);
          break;
        case "tool_result":
          parts.push(`[tool_result] ${(block as { content?: string }).content ?? ""}`);
          break;
        case "image":
          parts.push("[image]");
          break;
        default:
          parts.push(`[${block.type}]`);
      }
    }
  }
  return parts.join("\n");
}

/**
 * Map agent message role to provider context role.
 * Agent messages only have "user" and "assistant" roles.
 * Tool results are embedded as content blocks within "user" messages.
 */
function mapAgentRoleToProvider(
  msg: FridayAgentMessage,
): "user" | "assistant" | "tool-result" {
  if (msg.role === "assistant") return "assistant";
  // Check if user message contains tool_result blocks
  if (Array.isArray(msg.content)) {
    const hasToolResult = msg.content.some(
      (block) => typeof block === "object" && block !== null && "type" in block && block.type === "tool_result",
    );
    if (hasToolResult) return "tool-result";
  }
  return "user";
}

/**
 * Extract tool name from an assistant message with tool_use blocks.
 */
function extractToolName(msg: FridayAgentMessage): string | undefined {
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return undefined;
  for (const block of msg.content) {
    if (typeof block === "object" && block !== null && "type" in block && block.type === "tool_use" && "name" in block) {
      return block.name as string;
    }
  }
  return undefined;
}
