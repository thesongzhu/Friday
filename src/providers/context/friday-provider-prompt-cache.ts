import type { FridayContextOptimizationResult } from "../model/friday-provider-context.types.js";

// ─── Constants ───

/** Minimum characters in a system prompt to enable Anthropic caching. */
const MIN_STATIC_CHARS = 800;

/** Anthropic prompt caching beta header value. */
const ANTHROPIC_CACHE_BETA_HEADER = "prompt-caching-2024-07-31";

// ─── Content block shapes (Anthropic Messages API) ───

interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

// ─── Interface ───

export interface FridayProviderPromptCacheAdapter {
  applyAnthropicCacheHints(params: {
    systemPrompt: string;
    userPrompt: string;
    hints: FridayContextOptimizationResult["cacheHints"];
  }): {
    systemBlocks: AnthropicTextBlock[];
    userBlocks: AnthropicTextBlock[];
    extraHeaders: Record<string, string>;
  };
}

// ─── Factory ───

export function createFridayProviderPromptCacheAdapter(): FridayProviderPromptCacheAdapter {
  return {
    applyAnthropicCacheHints(params) {
      const { systemPrompt, userPrompt, hints } = params;

      // Build system blocks
      const systemBlocks: AnthropicTextBlock[] = [];
      if (systemPrompt) {
        const block: AnthropicTextBlock = { type: "text", text: systemPrompt };
        // Tag system block for caching if enabled and long enough
        if (hints.anthropic.enabled && hints.anthropic.systemCache && systemPrompt.length >= MIN_STATIC_CHARS) {
          block.cache_control = { type: "ephemeral" };
        }
        systemBlocks.push(block);
      }

      // Build user blocks
      const userBlocks: AnthropicTextBlock[] = [];
      if (userPrompt) {
        const block: AnthropicTextBlock = { type: "text", text: userPrompt };
        // Tag user block for caching when indexes indicate static content
        if (hints.anthropic.enabled && hints.anthropic.userStaticBlockIndexes.includes(0)) {
          block.cache_control = { type: "ephemeral" };
        }
        userBlocks.push(block);
      }

      // Set beta header when Anthropic caching is active
      const extraHeaders: Record<string, string> = {};
      if (hints.anthropic.enabled) {
        extraHeaders["anthropic-beta"] = ANTHROPIC_CACHE_BETA_HEADER;
      }

      return { systemBlocks, userBlocks, extraHeaders };
    },
  };
}
