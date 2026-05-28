import type { FridayProviderKind } from "../model/friday-provider.types.js";
import type {
  FridayModelQualityTier,
  FridayProviderModelPricing,
} from "../model/friday-provider-cost.types.js";

// ─── Default pricing table (USD per 1M tokens) ───

const DEFAULT_MODEL_PRICING: readonly FridayProviderModelPricing[] = [
  {
    providerKind: "openai",
    modelPattern: "gpt-4.1",
    qualityTier: "best",
    inputPer1MUsd: 2.00,
    outputPer1MUsd: 8.00,
    cacheReadPer1MUsd: 0.50,
    cacheWritePer1MUsd: 2.00,
  },
  {
    providerKind: "openai",
    modelPattern: "gpt-4.1-mini",
    qualityTier: "balanced",
    inputPer1MUsd: 0.40,
    outputPer1MUsd: 1.60,
    cacheReadPer1MUsd: 0.10,
    cacheWritePer1MUsd: 0.40,
  },
  {
    providerKind: "openai",
    modelPattern: "gpt-4.1-nano",
    qualityTier: "cheap",
    inputPer1MUsd: 0.10,
    outputPer1MUsd: 0.40,
    cacheReadPer1MUsd: 0.03,
    cacheWritePer1MUsd: 0.10,
  },
  // gpt-4o family — Friday's OPENAI_API_KEY auto-detect defaults (gpt-4o-mini default, gpt-4o
  // supported). Source: https://openai.com/api/pricing/ (verified 2026-05-28). Without these,
  // both env-default OpenAI models hit the generic $1/$4 fallback below.
  {
    providerKind: "openai",
    modelPattern: "gpt-4o-mini",
    qualityTier: "cheap",
    inputPer1MUsd: 0.15,
    outputPer1MUsd: 0.60,
    cacheReadPer1MUsd: 0.075,
    cacheWritePer1MUsd: 0.15,
  },
  {
    providerKind: "openai",
    modelPattern: "gpt-4o",
    qualityTier: "best",
    inputPer1MUsd: 2.50,
    outputPer1MUsd: 10.00,
    cacheReadPer1MUsd: 1.25,
    cacheWritePer1MUsd: 2.50,
  },
  {
    providerKind: "anthropic",
    modelPattern: "claude-opus",
    qualityTier: "best",
    inputPer1MUsd: 15.00,
    outputPer1MUsd: 75.00,
    cacheReadPer1MUsd: 1.50,
    cacheWritePer1MUsd: 15.00,
  },
  {
    providerKind: "anthropic",
    modelPattern: "claude-sonnet",
    qualityTier: "balanced",
    inputPer1MUsd: 3.00,
    outputPer1MUsd: 15.00,
    cacheReadPer1MUsd: 0.30,
    cacheWritePer1MUsd: 3.00,
  },
  {
    providerKind: "anthropic",
    modelPattern: "claude-haiku",
    qualityTier: "cheap",
    inputPer1MUsd: 0.80,
    outputPer1MUsd: 4.00,
    cacheReadPer1MUsd: 0.08,
    cacheWritePer1MUsd: 0.80,
  },
  {
    providerKind: "google",
    modelPattern: "gemini-2.5-pro",
    qualityTier: "best",
    inputPer1MUsd: 1.25,
    outputPer1MUsd: 5.00,
    cacheReadPer1MUsd: 0.13,
    cacheWritePer1MUsd: 1.25,
  },
  {
    providerKind: "google",
    modelPattern: "gemini-2.5-flash",
    qualityTier: "balanced",
    inputPer1MUsd: 0.30,
    outputPer1MUsd: 1.20,
    cacheReadPer1MUsd: 0.03,
    cacheWritePer1MUsd: 0.30,
  },
  {
    providerKind: "google",
    modelPattern: "gemini-2.0-flash-lite",
    qualityTier: "cheap",
    inputPer1MUsd: 0.08,
    outputPer1MUsd: 0.30,
    cacheReadPer1MUsd: 0.01,
    cacheWritePer1MUsd: 0.08,
  },
  // gemini-2.0-flash — Friday's GOOGLE_API_KEY auto-detect default. Source:
  // https://ai.google.dev/gemini-api/docs/pricing (verified 2026-05-28). Note: "gemini-2.0-flash"
  // does NOT substring-match "gemini-2.0-flash-lite", so without this entry the default model
  // silently fell to the generic $1/$4 fallback.
  {
    providerKind: "google",
    modelPattern: "gemini-2.0-flash",
    qualityTier: "balanced",
    inputPer1MUsd: 0.10,
    outputPer1MUsd: 0.40,
    cacheReadPer1MUsd: 0.025,
    cacheWritePer1MUsd: 0.10,
  },
  // DeepSeek V4 — Friday's DEEPSEEK_API_KEY auto-detect defaults (deepseek-v4-pro default,
  // deepseek-v4-flash supported) plus the deepseek-chat / deepseek-reasoner deprecation aliases
  // (both are V4 Flash modes, priced as V4 Flash). Source: https://api-docs.deepseek.com/quick_start/pricing
  // (verified 2026-05-28; STANDARD list prices — the 75%-off v4-pro promo expiring 2026-05-31 is
  // intentionally NOT used so cost/budget never silently under-reports after the promo ends).
  // Without a deepseek kind here, every DeepSeek model hit the generic $1/$4 fallback.
  {
    providerKind: "deepseek",
    modelPattern: "deepseek-v4-flash",
    qualityTier: "cheap",
    inputPer1MUsd: 0.14,
    outputPer1MUsd: 0.28,
    cacheReadPer1MUsd: 0.0028,
    cacheWritePer1MUsd: 0.14,
  },
  {
    providerKind: "deepseek",
    modelPattern: "deepseek-v4-pro",
    qualityTier: "best",
    inputPer1MUsd: 1.74,
    outputPer1MUsd: 3.48,
    cacheReadPer1MUsd: 0.0145,
    cacheWritePer1MUsd: 1.74,
  },
  {
    providerKind: "deepseek",
    modelPattern: "deepseek-chat",
    qualityTier: "cheap",
    inputPer1MUsd: 0.14,
    outputPer1MUsd: 0.28,
    cacheReadPer1MUsd: 0.0028,
    cacheWritePer1MUsd: 0.14,
  },
  {
    // deepseek-reasoner is the V4 Flash thinking-mode alias — priced identically to
    // deepseek-v4-flash / deepseek-chat, so it carries the same "cheap" tier to keep the
    // cost router scoring equivalently-priced aliases of the same model equivalently.
    providerKind: "deepseek",
    modelPattern: "deepseek-reasoner",
    qualityTier: "cheap",
    inputPer1MUsd: 0.14,
    outputPer1MUsd: 0.28,
    cacheReadPer1MUsd: 0.0028,
    cacheWritePer1MUsd: 0.14,
  },
  {
    providerKind: "ollama",
    modelPattern: "*",
    qualityTier: "cheap",
    inputPer1MUsd: 0,
    outputPer1MUsd: 0,
    cacheReadPer1MUsd: 0,
    cacheWritePer1MUsd: 0,
  },
];

// ─── Interface ───

export interface FridayProviderPricingCatalog {
  getPricing(providerKind: FridayProviderKind, model: string): {
    inputPer1MUsd: number;
    outputPer1MUsd: number;
    cacheReadPer1MUsd: number;
    cacheWritePer1MUsd: number;
    qualityTier: FridayModelQualityTier;
  };
}

// ─── Factory ───

export function createFridayProviderPricingCatalog(): FridayProviderPricingCatalog {
  return {
    getPricing(providerKind, model) {
      const modelLower = model.toLowerCase();

      // Find best match: provider kind must match, then longest modelPattern prefix wins
      let bestMatch: FridayProviderModelPricing | undefined;
      let bestLen = -1;

      for (const entry of DEFAULT_MODEL_PRICING) {
        if (entry.providerKind !== providerKind) continue;

        // Wildcard matches everything
        if (entry.modelPattern === "*") {
          if (bestLen < 0) {
            bestMatch = entry;
            bestLen = 0;
          }
          continue;
        }

        // Check if model contains the pattern (case-insensitive)
        if (modelLower.includes(entry.modelPattern.toLowerCase())) {
          const patternLen = entry.modelPattern.length;
          if (patternLen > bestLen) {
            bestMatch = entry;
            bestLen = patternLen;
          }
        }
      }

      if (bestMatch) {
        return {
          inputPer1MUsd: bestMatch.inputPer1MUsd,
          outputPer1MUsd: bestMatch.outputPer1MUsd,
          cacheReadPer1MUsd: bestMatch.cacheReadPer1MUsd,
          cacheWritePer1MUsd: bestMatch.cacheWritePer1MUsd,
          qualityTier: bestMatch.qualityTier,
        };
      }

      // Fallback: unknown model, assume balanced pricing
      return {
        inputPer1MUsd: 1.00,
        outputPer1MUsd: 4.00,
        cacheReadPer1MUsd: 0.10,
        cacheWritePer1MUsd: 1.00,
        qualityTier: "balanced",
      };
    },
  };
}
