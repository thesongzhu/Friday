import type { FridayProviderKind } from "../model/friday-provider.types.js";
import type { FridayProviderNormalizedUsage } from "../model/friday-provider-cost.types.js";
import type { FridayProviderPricingCatalog } from "./friday-provider-pricing-catalog.js";

// ─── Interface ───

export interface FridayProviderCostCalculator {
  calculate(params: {
    providerKind: FridayProviderKind;
    model: string;
    usage: FridayProviderNormalizedUsage;
  }): number;
}

// ─── Factory ───

export function createFridayProviderCostCalculator(deps: {
  pricingCatalog: FridayProviderPricingCatalog;
}): FridayProviderCostCalculator {
  const { pricingCatalog } = deps;

  return {
    calculate(params) {
      const { providerKind, model, usage } = params;
      const pricing = pricingCatalog.getPricing(providerKind, model);

      const PER_1M = 1_000_000;
      const inputCost = (usage.input * pricing.inputPer1MUsd) / PER_1M;
      const outputCost = (usage.output * pricing.outputPer1MUsd) / PER_1M;
      const cacheReadCost = (usage.cacheRead * pricing.cacheReadPer1MUsd) / PER_1M;
      const cacheWriteCost = (usage.cacheWrite * pricing.cacheWritePer1MUsd) / PER_1M;

      // Round to 6 decimal places to avoid floating point noise
      return Math.round((inputCost + outputCost + cacheReadCost + cacheWriteCost) * 1_000_000) / 1_000_000;
    },
  };
}
