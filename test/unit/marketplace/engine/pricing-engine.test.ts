import { describe, it, expect } from "vitest";
import {
  createPricingPlan,
  updatePricingPlan,
  deactivatePricingPlan,
  validatePricingPlan,
  calculatePlanCost,
  calculateUsageCost,
  calculatePlatformFee,
  bankersRound,
  PRICING_ERROR_CODES,
} from "../../../../src/marketplace/engine/pricing-engine.js";
import type { MarketplaceAuditEvent } from "../../../../src/marketplace/engine/audit-events.js";
import type {
  FridayPricingPlan,
  FridayPricingPlanRecord,
  FridayCurrencyCode,
} from "../../../../src/marketplace/model/friday-marketplace.types.js";
import { fridayMoney, fridayMoneyCents } from "../../../../src/marketplace/model/friday-marketplace.types.js";

// ─── Test Helpers ───

let idCounter = 0;

function resetCounter(): void {
  idCounter = 0;
}

function buildDeps(overrides?: {
  now?: () => string;
  emitAuditEvent?: (event: MarketplaceAuditEvent) => void;
}) {
  return {
    generateId: () => `plan-${++idCounter}`,
    now: overrides?.now ?? (() => "2026-02-24T12:00:00.000Z"),
    emitAuditEvent: overrides?.emitAuditEvent,
    defaultActor: "system",
  };
}

function basePlanRecord(overrides?: Partial<FridayPricingPlanRecord>): FridayPricingPlanRecord {
  return {
    id: "plan-1",
    listingId: "listing-1",
    plan: { type: "free" },
    isActive: true,
    createdAt: "2026-02-24T10:00:00.000Z",
    updatedAt: "2026-02-24T10:00:00.000Z",
    ...overrides,
  };
}

// ─── Tests ───

describe("validatePricingPlan", () => {
  it("validates free plan", () => {
    const result = validatePricingPlan({ type: "free" });
    expect(result.ok).toBe(true);
  });

  it("validates one-time plan", () => {
    const result = validatePricingPlan({
      type: "one_time",
      price: fridayMoney(999, "USD"),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects negative one-time price", () => {
    const result = validatePricingPlan({
      type: "one_time",
      price: fridayMoney(-100, "USD"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PRICING_ERROR_CODES.INVALID);
  });

  it("rejects subscription plan in MVP profile", () => {
    const result = validatePricingPlan({
      type: "subscription",
      intervalMonths: 1,
      price: fridayMoney(499, "USD"),
      trialDays: 14,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PRICING_ERROR_CODES.TYPE_NOT_ALLOWED_IN_MVP);
  });

  it("rejects invalid interval months (still blocked by MVP gate)", () => {
    const result = validatePricingPlan({
      type: "subscription",
      intervalMonths: 6 as 1 | 12,
      price: fridayMoney(499, "USD"),
      trialDays: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PRICING_ERROR_CODES.TYPE_NOT_ALLOWED_IN_MVP);
  });

  it("rejects negative trial days (still blocked by MVP gate)", () => {
    const result = validatePricingPlan({
      type: "subscription",
      intervalMonths: 1,
      price: fridayMoney(499, "USD"),
      trialDays: -1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PRICING_ERROR_CODES.TYPE_NOT_ALLOWED_IN_MVP);
  });

  it("rejects usage-based plan in MVP profile", () => {
    const result = validatePricingPlan({
      type: "usage_based",
      unitLabel: "API call",
      tiers: [
        { upToUnits: 1000, pricePerUnitCents: 1 },
        { upToUnits: 10000, pricePerUnitCents: 0.8 },
        { upToUnits: null, pricePerUnitCents: 0.5 },
      ],
      currency: "USD" as FridayCurrencyCode,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PRICING_ERROR_CODES.TYPE_NOT_ALLOWED_IN_MVP);
  });

  it("rejects usage-based plan with empty tiers", () => {
    const result = validatePricingPlan({
      type: "usage_based",
      unitLabel: "API call",
      tiers: [],
      currency: "USD" as FridayCurrencyCode,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects usage-based plan with empty unit label", () => {
    const result = validatePricingPlan({
      type: "usage_based",
      unitLabel: "  ",
      tiers: [{ upToUnits: null, pricePerUnitCents: 1 }],
      currency: "USD" as FridayCurrencyCode,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects unordered tiers", () => {
    const result = validatePricingPlan({
      type: "usage_based",
      unitLabel: "API call",
      tiers: [
        { upToUnits: 10000, pricePerUnitCents: 1 },
        { upToUnits: 1000, pricePerUnitCents: 0.5 },
      ],
      currency: "USD" as FridayCurrencyCode,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects null upToUnits in non-last tier", () => {
    const result = validatePricingPlan({
      type: "usage_based",
      unitLabel: "API call",
      tiers: [
        { upToUnits: null, pricePerUnitCents: 1 },
        { upToUnits: 1000, pricePerUnitCents: 0.5 },
      ],
      currency: "USD" as FridayCurrencyCode,
    });
    expect(result.ok).toBe(false);
  });
});

describe("createPricingPlan", () => {
  it("creates a plan record", () => {
    resetCounter();
    const result = createPricingPlan("listing-1", { type: "free" }, buildDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe("plan-1");
    expect(result.value.listingId).toBe("listing-1");
    expect(result.value.isActive).toBe(true);
    expect(result.value.plan.type).toBe("free");
  });

  it("stores one-time plan by value and returns frozen record", () => {
    resetCounter();
    const plan: FridayPricingPlan = {
      type: "one_time",
      price: fridayMoney(2499, "USD"),
    };

    const result = createPricingPlan("listing-1", plan, buildDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    (plan as { type: string }).type = "free";
    (plan as { price?: ReturnType<typeof fridayMoney> }).price = fridayMoney(1, "USD");

    expect(result.value.plan.type).toBe("one_time");

    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.plan)).toBe(true);
  });
});

describe("updatePricingPlan", () => {
  it("updates an active plan", () => {
    const existing = basePlanRecord();
    const result = updatePricingPlan(
      existing,
      { type: "one_time", price: fridayMoney(1999, "USD") },
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.plan.type).toBe("one_time");
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.plan)).toBe(true);
  });

  it("rejects update on inactive plan", () => {
    const existing = basePlanRecord({ isActive: false });
    const result = updatePricingPlan(existing, { type: "free" }, buildDeps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PRICING_ERROR_CODES.ALREADY_INACTIVE);
  });
});

describe("deactivatePricingPlan", () => {
  it("deactivates an active plan", () => {
    const existing = basePlanRecord();
    const result = deactivatePricingPlan(existing, buildDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isActive).toBe(false);
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("rejects deactivation of already inactive plan", () => {
    const existing = basePlanRecord({ isActive: false });
    const result = deactivatePricingPlan(existing, buildDeps());

    expect(result.ok).toBe(false);
  });
});

describe("calculatePlanCost", () => {
  it("returns zero for free plan", () => {
    const cost = calculatePlanCost({ type: "free" });
    expect(fridayMoneyCents(cost)).toBe(0);
  });

  it("returns price for one-time plan", () => {
    const cost = calculatePlanCost({
      type: "one_time",
      price: fridayMoney(2499, "USD"),
    });
    expect(fridayMoneyCents(cost)).toBe(2499);
  });

  it("returns interval price for subscription plan", () => {
    const cost = calculatePlanCost({
      type: "subscription",
      intervalMonths: 1,
      price: fridayMoney(999, "USD"),
      trialDays: 14,
    });
    expect(fridayMoneyCents(cost)).toBe(999);
  });

  it("returns zero for usage-based plan (no usage)", () => {
    const cost = calculatePlanCost({
      type: "usage_based",
      unitLabel: "API call",
      tiers: [{ upToUnits: null, pricePerUnitCents: 1 }],
      currency: "USD" as FridayCurrencyCode,
    });
    expect(fridayMoneyCents(cost)).toBe(0);
  });
});

describe("calculateUsageCost", () => {
  const tiers = [
    { upToUnits: 1000, pricePerUnitCents: 10 },
    { upToUnits: 5000, pricePerUnitCents: 8 },
    { upToUnits: null, pricePerUnitCents: 5 },
  ];
  const usd = "USD" as FridayCurrencyCode;

  it("calculates cost within first tier", () => {
    const cost = calculateUsageCost(tiers, 500, usd);
    expect(fridayMoneyCents(cost)).toBe(500 * 10);
  });

  it("calculates cost spanning two tiers", () => {
    const cost = calculateUsageCost(tiers, 2000, usd);
    expect(fridayMoneyCents(cost)).toBe(18000);
  });

  it("calculates cost spanning all tiers", () => {
    const cost = calculateUsageCost(tiers, 7000, usd);
    expect(fridayMoneyCents(cost)).toBe(52000);
  });

  it("returns zero for zero units", () => {
    const cost = calculateUsageCost(tiers, 0, usd);
    expect(fridayMoneyCents(cost)).toBe(0);
  });

  it("returns zero for negative units", () => {
    const cost = calculateUsageCost(tiers, -10, usd);
    expect(fridayMoneyCents(cost)).toBe(0);
  });
});

describe("bankersRound", () => {
  it("rounds normally for non-halfway values", () => {
    expect(bankersRound(2.3)).toBe(2);
    expect(bankersRound(2.7)).toBe(3);
    expect(bankersRound(3.1)).toBe(3);
  });

  it("rounds to even for exactly halfway values", () => {
    expect(bankersRound(0.5)).toBe(0);
    expect(bankersRound(1.5)).toBe(2);
    expect(bankersRound(2.5)).toBe(2);
    expect(bankersRound(3.5)).toBe(4);
    expect(bankersRound(4.5)).toBe(4);
  });
});

describe("calculatePlatformFee", () => {
  it("calculates 30% fee correctly", () => {
    const { fee, net } = calculatePlatformFee(10000, 3000, "USD" as FridayCurrencyCode);
    expect(fridayMoneyCents(fee)).toBe(3000);
    expect(fridayMoneyCents(net)).toBe(7000);
  });

  it("calculates fee with banker's rounding", () => {
    const { fee, net } = calculatePlatformFee(15, 3000, "USD" as FridayCurrencyCode);
    expect(fridayMoneyCents(fee)).toBe(4);
    expect(fridayMoneyCents(net)).toBe(11);
  });

  it("maintains gross = fee + net invariant", () => {
    const testCases = [100, 999, 1234, 5001, 10000, 99999];
    for (const gross of testCases) {
      const { fee, net } = calculatePlatformFee(gross, 3000, "USD" as FridayCurrencyCode);
      expect(fridayMoneyCents(fee) + fridayMoneyCents(net)).toBe(gross);
    }
  });

  it("handles zero gross amount", () => {
    const { fee, net } = calculatePlatformFee(0, 3000, "USD" as FridayCurrencyCode);
    expect(fridayMoneyCents(fee)).toBe(0);
    expect(fridayMoneyCents(net)).toBe(0);
  });
});

describe("audit events", () => {
  it("emits pricing plan transition records", () => {
    resetCounter();
    const events: MarketplaceAuditEvent[] = [];

    const createResult = createPricingPlan(
      "listing-1",
      { type: "free" },
      buildDeps({ emitAuditEvent: (event) => events.push(event) }),
    );
    expect(createResult.ok).toBe(true);

    const updateResult = updatePricingPlan(
      basePlanRecord(),
      { type: "one_time", price: fridayMoney(1299, "USD") },
      buildDeps({ emitAuditEvent: (event) => events.push(event) }),
    );
    expect(updateResult.ok).toBe(true);

    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const event of events) {
      expect(event.entityType).toBe("pricing_plan");
      expect(event.timestamp).toBe("2026-02-24T12:00:00.000Z");
      expect(event.actor).toBeTruthy();
      expect(event.fromState).not.toBeUndefined();
      expect(event.toState).toBeTruthy();
    }
  });
});
