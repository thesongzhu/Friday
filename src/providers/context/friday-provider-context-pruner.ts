import type { FridayProviderContextMessage } from "../model/friday-provider-context.types.js";

// ─── Constants ───

/**
 * Messages older than this many turns from the end are eligible for
 * large-content pruning (retain head + tail only).
 */
const STALE_TURN_DISTANCE = 6;

/** Content bodies larger than this are pruned. */
const LARGE_CONTENT_CHARS = 12_000;

/** Head characters to retain when pruning large content. */
const RETAIN_HEAD_CHARS = 2_000;

/** Tail characters to retain when pruning large content. */
const RETAIN_TAIL_CHARS = 1_000;

// ─── Interface ───

export interface FridayProviderContextPruner {
  /** Prunes oversized content in older messages, returning new array. */
  prune(messages: readonly FridayProviderContextMessage[]): {
    messages: FridayProviderContextMessage[];
    prunedCount: number;
  };
}

// ─── Factory ───

export function createFridayProviderContextPruner(): FridayProviderContextPruner {
  return {
    prune(messages) {
      let prunedCount = 0;
      const totalMessages = messages.length;
      const result: FridayProviderContextMessage[] = [];

      for (let i = 0; i < totalMessages; i++) {
        const msg = messages[i];
        const distanceFromEnd = totalMessages - 1 - i;
        const isStale = distanceFromEnd >= STALE_TURN_DISTANCE;
        const isLarge = msg.content.length > LARGE_CONTENT_CHARS;
        const isToolResult = msg.role === "tool-result";

        if (isLarge && (isStale || isToolResult)) {
          // Retain head + "[...pruned...]" + tail
          const head = msg.content.slice(0, RETAIN_HEAD_CHARS);
          const tail = msg.content.slice(-RETAIN_TAIL_CHARS);
          const prunedContent = `${head}\n\n[...pruned ${String(msg.content.length - RETAIN_HEAD_CHARS - RETAIN_TAIL_CHARS)} chars...]\n\n${tail}`;
          result.push({ ...msg, content: prunedContent });
          prunedCount++;
        } else {
          result.push({ ...msg });
        }
      }

      return { messages: result, prunedCount };
    },
  };
}
