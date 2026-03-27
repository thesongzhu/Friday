import { describe, it, expect } from "vitest";
import {
  FridayHeuristicUtilityStrategy,
  type FridayUtilityInput,
} from "../../../../src/learning/services/friday-expected-utility-calculator.js";

describe("FridayHeuristicUtilityStrategy", () => {
  const strategy = new FridayHeuristicUtilityStrategy();

  function makeInput(overrides: Partial<FridayUtilityInput> = {}): FridayUtilityInput {
    return {
      riskTier: 0,
      confidence: 0.5,
      predictedSuccessProb: 0.5,
      estimatedBenefitScore: 0.5,
      estimatedCostScore: 0.5,
      ...overrides,
    };
  }

  it("recommends auto_apply for high benefit + high success + low risk", () => {
    const result = strategy.compute(
      makeInput({
        riskTier: 0,
        confidence: 0.9,
        predictedSuccessProb: 0.9,
        estimatedBenefitScore: 0.8,
        estimatedCostScore: 0.1,
      }),
    );
    expect(result.recommendation).toBe("auto_apply");
    expect(result.expectedUtility).toBeGreaterThan(0.3);
  });

  it("recommends defer for low benefit + low success + high risk", () => {
    const result = strategy.compute(
      makeInput({
        riskTier: 2,
        confidence: 0.2,
        predictedSuccessProb: 0.2,
        estimatedBenefitScore: 0.1,
        estimatedCostScore: 0.8,
      }),
    );
    expect(result.recommendation).toBe("defer");
    expect(result.expectedUtility).toBeLessThan(0);
  });

  it("recommends suggest for moderate input", () => {
    const result = strategy.compute(
      makeInput({
        riskTier: 0,
        confidence: 0.6,
        predictedSuccessProb: 0.6,
        estimatedBenefitScore: 0.5,
        estimatedCostScore: 0.3,
      }),
    );
    expect(result.recommendation).toBe("suggest");
    expect(result.expectedUtility).toBeGreaterThan(0);
    expect(result.expectedUtility).toBeLessThanOrEqual(0.3);
  });

  it("applies risk penalty proportional to tier", () => {
    const base = makeInput({
      predictedSuccessProb: 0.7,
      estimatedBenefitScore: 0.6,
      estimatedCostScore: 0.2,
    });

    const tier0 = strategy.compute({ ...base, riskTier: 0 });
    const tier1 = strategy.compute({ ...base, riskTier: 1 });
    const tier2 = strategy.compute({ ...base, riskTier: 2 });

    expect(tier0.expectedUtility).toBeGreaterThan(tier1.expectedUtility);
    expect(tier1.expectedUtility).toBeGreaterThan(tier2.expectedUtility);
    // Each tier step adds 0.15 penalty
    expect(tier0.expectedUtility - tier1.expectedUtility).toBeCloseTo(0.15, 5);
    expect(tier1.expectedUtility - tier2.expectedUtility).toBeCloseTo(0.15, 5);
  });

  it("handles all-zero input", () => {
    const result = strategy.compute(
      makeInput({
        riskTier: 0,
        confidence: 0,
        predictedSuccessProb: 0,
        estimatedBenefitScore: 0,
        estimatedCostScore: 0,
      }),
    );
    expect(result.expectedUtility).toBe(0);
    expect(result.recommendation).toBe("defer");
  });

  it("handles all-max input (tier 0)", () => {
    const result = strategy.compute(
      makeInput({
        riskTier: 0,
        confidence: 1,
        predictedSuccessProb: 1,
        estimatedBenefitScore: 1,
        estimatedCostScore: 0,
      }),
    );
    // EU = 1*1 - 0*0 - 0 = 1
    expect(result.expectedUtility).toBe(1);
    expect(result.recommendation).toBe("auto_apply");
  });

  it("handles worst case input (tier 2, all against)", () => {
    const result = strategy.compute(
      makeInput({
        riskTier: 2,
        confidence: 0,
        predictedSuccessProb: 0,
        estimatedBenefitScore: 0,
        estimatedCostScore: 1,
      }),
    );
    // EU = 0*0 - 1*1 - 0.3 = -1.3
    expect(result.expectedUtility).toBe(-1.3);
    expect(result.recommendation).toBe("defer");
  });

  it("includes reasoning string with all components", () => {
    const result = strategy.compute(
      makeInput({
        riskTier: 1,
        predictedSuccessProb: 0.7,
        estimatedBenefitScore: 0.5,
        estimatedCostScore: 0.3,
      }),
    );
    expect(result.reasoning).toContain("EU=");
    expect(result.reasoning).toContain("benefit=");
    expect(result.reasoning).toContain("P(success)=");
    expect(result.reasoning).toContain("cost=");
    expect(result.reasoning).toContain("riskPenalty=");
  });

  it("implements FridayUtilityStrategy interface correctly", () => {
    // Verify the strategy can be used polymorphically
    const compute = (s: { compute: typeof strategy.compute }) =>
      s.compute(makeInput());
    const result = compute(strategy);
    expect(result).toHaveProperty("expectedUtility");
    expect(result).toHaveProperty("recommendation");
    expect(result).toHaveProperty("reasoning");
  });
});
