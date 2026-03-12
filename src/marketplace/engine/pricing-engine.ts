/**
 * Pricing Engine — Plan management, validation, and cost calculation.
 *
 * Handles pricing plan lifecycle (create, update, deactivate) and
 * computes costs for all pricing models (free, one-time, subscription,
 * usage-based) using FridayMoneyAmount branded types.
 *
 * @module marketplace/engine/pricing-engine
 */

import type {
  FridayAmountCents,
  FridayCurrencyCode,
  FridayMoneyAmount,
  FridayPricingPlan,
  FridayPricingPlanRecord,
  FridayPricingTier,
  ISODateTime,
  UUID,
} from "../model/friday-marketplace.types.js";

import {
  FRIDAY_MVP_ALLOWED_PRICING_PLAN_TYPES,
  fridayMoney,
} from "../model/friday-marketplace.types.js";
import { MARKETPLACE_SYSTEM_ACTOR } from "./audit-events.js";
import type {
  MarketplaceAuditEventMetadata,
  MarketplaceAuditEventSink,
} from "./audit-events.js";

// ─── Error Types ───

export const PRICING_ERROR_CODES = {
  NOT_FOUND: "PRICING_PLAN_NOT_FOUND",
  INVALID: "PRICING_PLAN_INVALID",
  ALREADY_INACTIVE: "PRICING_PLAN_ALREADY_INACTIVE",
  TYPE_NOT_ALLOWED_IN_MVP: "PRICING_TYPE_NOT_ALLOWED_IN_MVP",
} as const;

export type PricingErrorCode =
  (typeof PRICING_ERROR_CODES)[keyof typeof PRICING_ERROR_CODES];

export interface PricingError {
  readonly code: PricingErrorCode;
  readonly message: string;
}

export type PricingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PricingError };

// ─── Deps ───

export interface PricingDeps {
  readonly generateId: () => UUID;
  readonly now: () => ISODateTime;
  readonly emitAuditEvent?: MarketplaceAuditEventSink;
  readonly defaultActor?: string;
}

// ─── Pricing Plan Management ───

/**
 * Creates a new pricing plan record for a listing.
 *
 * Validates the plan configuration based on its type.
 */
export function createPricingPlan(
  listingId: UUID,
  plan: FridayPricingPlan,
  deps: PricingDeps,
): PricingResult<FridayPricingPlanRecord> {
  const validation = validatePricingPlan(plan);
  if (!validation.ok) return validation;

  const now = deps.now();
  const record: FridayPricingPlanRecord = {
    id: deps.generateId(),
    listingId,
    plan,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  const snapshot = cloneAndFreeze(record);
  emitTransitionAudit(deps, {
    entityType: "pricing_plan",
    entityId: snapshot.id,
    action: "pricing_plan.created",
    fromState: null,
    toState: snapshot.isActive ? "active" : "inactive",
    timestamp: now,
    metadata: {
      listingId: snapshot.listingId,
      pricingType: snapshot.plan.type,
    },
  });

  return { ok: true, value: snapshot };
}

/**
 * Updates an existing pricing plan.
 *
 * Validates the new plan configuration before applying.
 */
export function updatePricingPlan(
  existing: FridayPricingPlanRecord,
  plan: FridayPricingPlan,
  deps: PricingDeps,
): PricingResult<FridayPricingPlanRecord> {
  if (!existing.isActive) {
    return {
      ok: false,
      error: {
        code: PRICING_ERROR_CODES.ALREADY_INACTIVE,
        message: "Cannot update an inactive pricing plan",
      },
    };
  }

  const validation = validatePricingPlan(plan);
  if (!validation.ok) return validation;

  const now = deps.now();
  const updated: FridayPricingPlanRecord = {
    ...existing,
    plan,
    updatedAt: now,
  };

  const snapshot = cloneAndFreeze(updated);
  emitTransitionAudit(deps, {
    entityType: "pricing_plan",
    entityId: snapshot.id,
    action: "pricing_plan.updated",
    fromState: existing.isActive ? "active" : "inactive",
    toState: snapshot.isActive ? "active" : "inactive",
    timestamp: now,
    metadata: {
      pricingType: snapshot.plan.type,
    },
  });

  return { ok: true, value: snapshot };
}

/**
 * Deactivates a pricing plan (soft delete).
 */
export function deactivatePricingPlan(
  existing: FridayPricingPlanRecord,
  deps: PricingDeps,
): PricingResult<FridayPricingPlanRecord> {
  if (!existing.isActive) {
    return {
      ok: false,
      error: {
        code: PRICING_ERROR_CODES.ALREADY_INACTIVE,
        message: "Pricing plan is already inactive",
      },
    };
  }

  const now = deps.now();
  const deactivated: FridayPricingPlanRecord = {
    ...existing,
    isActive: false,
    updatedAt: now,
  };
  const snapshot = cloneAndFreeze(deactivated);
  emitTransitionAudit(deps, {
    entityType: "pricing_plan",
    entityId: snapshot.id,
    action: "pricing_plan.deactivated",
    fromState: existing.isActive ? "active" : "inactive",
    toState: "inactive",
    timestamp: now,
    metadata: {
      listingId: snapshot.listingId,
    },
  });

  return {
    ok: true,
    value: snapshot,
  };
}

/**
 * Validates a pricing plan configuration.
 */
export function validatePricingPlan(plan: FridayPricingPlan): PricingResult<void> {
  if (
    !(FRIDAY_MVP_ALLOWED_PRICING_PLAN_TYPES as readonly string[]).includes(plan.type)
  ) {
    return {
      ok: false,
      error: {
        code: PRICING_ERROR_CODES.TYPE_NOT_ALLOWED_IN_MVP,
        message: `Pricing plan type "${plan.type}" is not enabled in current marketplace MVP profile`,
      },
    };
  }

  switch (plan.type) {
    case "free":
      return { ok: true, value: undefined };

    case "one_time":
      return validateOneTimePlan(plan.price);

    case "subscription":
      return validateSubscriptionPlan(plan.price, plan.intervalMonths, plan.trialDays);

    case "usage_based":
      return validateUsageBasedPlan(plan.tiers, plan.unitLabel);

    default: {
      const exhaustive: never = plan;
      return {
        ok: false,
        error: {
          code: PRICING_ERROR_CODES.INVALID,
          message: `Unknown pricing plan type: ${(exhaustive as FridayPricingPlan).type}`,
        },
      };
    }
  }
}

/**
 * Calculates the cost for a one-time or subscription purchase.
 *
 * For free plans, returns zero. For usage-based plans, use `calculateUsageCost`.
 */
export function calculatePlanCost(plan: FridayPricingPlan): FridayMoneyAmount {
  switch (plan.type) {
    case "free":
      return fridayMoney(0, "USD");

    case "one_time":
      return plan.price;

    case "subscription":
      return plan.price;

    case "usage_based":
      return fridayMoney(0, plan.currency);

    default: {
      const exhaustive: never = plan;
      return fridayMoney(0, (exhaustive as { currency?: string }).currency ?? "USD");
    }
  }
}

/**
 * Calculates the cost for usage-based pricing using graduated tiers.
 *
 * Graduated pricing means each tier only applies to the units within
 * that tier's range, not to all units.
 */
export function calculateUsageCost(
  tiers: readonly FridayPricingTier[],
  units: number,
  currency: FridayCurrencyCode,
): FridayMoneyAmount {
  if (units <= 0 || tiers.length === 0) {
    return fridayMoney(0, currency);
  }

  let totalCents = 0;
  let remainingUnits = units;
  let previousUpperBound = 0;

  for (const tier of tiers) {
    if (remainingUnits <= 0) break;

    const tierUpperBound = tier.upToUnits ?? Infinity;
    const tierCapacity = tierUpperBound - previousUpperBound;
    const unitsInTier = Math.min(remainingUnits, tierCapacity);

    totalCents += unitsInTier * tier.pricePerUnitCents;
    remainingUnits -= unitsInTier;
    previousUpperBound = tierUpperBound;
  }

  return fridayMoney(Math.round(totalCents), currency);
}

/**
 * Applies banker's rounding (half-even) to a value.
 *
 * When the fractional part is exactly 0.5, rounds to the nearest even integer.
 * This eliminates systematic rounding bias over many transactions.
 */
export function bankersRound(value: number): number {
  const floored = Math.floor(value);
  const fractional = value - floored;

  if (Math.abs(fractional - 0.5) < 1e-10) {
    // Exactly halfway: round to even
    return floored % 2 === 0 ? floored : floored + 1;
  }

  return Math.round(value);
}

/**
 * Calculates the platform fee from a gross amount using basis points.
 *
 * Uses banker's rounding for deterministic, bias-free results.
 * Validates that gross = fee + net (the caller receives both values).
 *
 * @param grossCents - Gross amount in cents.
 * @param feeBps - Fee rate in basis points (e.g., 3000 = 30%).
 * @param currency - Currency code.
 * @returns Platform fee and net amount.
 */
export function calculatePlatformFee(
  grossCents: number,
  feeBps: number,
  currency: FridayCurrencyCode,
): { fee: FridayMoneyAmount; net: FridayMoneyAmount } {
  const rawFee = (grossCents * feeBps) / 10_000;
  const feeCents = bankersRound(rawFee);
  const netCents = grossCents - feeCents;

  return {
    fee: fridayMoney(feeCents, currency),
    net: fridayMoney(netCents, currency),
  };
}

// ─── Internal Validators ───

function validateOneTimePlan(price: FridayMoneyAmount): PricingResult<void> {
  if (price.amount < 0) {
    return {
      ok: false,
      error: {
        code: PRICING_ERROR_CODES.INVALID,
        message: "One-time price must be non-negative",
      },
    };
  }

  if (!Number.isInteger(price.amount)) {
    return {
      ok: false,
      error: {
        code: PRICING_ERROR_CODES.INVALID,
        message: "Price amount must be an integer (cents)",
      },
    };
  }

  if (!price.currency) {
    return {
      ok: false,
      error: {
        code: PRICING_ERROR_CODES.INVALID,
        message: "Currency code is required",
      },
    };
  }

  return { ok: true, value: undefined };
}

function validateSubscriptionPlan(
  price: FridayMoneyAmount,
  intervalMonths: number,
  trialDays: number,
): PricingResult<void> {
  const priceValidation = validateOneTimePlan(price);
  if (!priceValidation.ok) return priceValidation;

  if (intervalMonths !== 1 && intervalMonths !== 12) {
    return {
      ok: false,
      error: {
        code: PRICING_ERROR_CODES.INVALID,
        message: "Subscription interval must be 1 (monthly) or 12 (yearly)",
      },
    };
  }

  if (trialDays < 0 || !Number.isInteger(trialDays)) {
    return {
      ok: false,
      error: {
        code: PRICING_ERROR_CODES.INVALID,
        message: "Trial days must be a non-negative integer",
      },
    };
  }

  return { ok: true, value: undefined };
}

function validateUsageBasedPlan(
  tiers: readonly FridayPricingTier[],
  unitLabel: string,
): PricingResult<void> {
  if (!unitLabel.trim()) {
    return {
      ok: false,
      error: {
        code: PRICING_ERROR_CODES.INVALID,
        message: "Unit label is required for usage-based plans",
      },
    };
  }

  if (tiers.length === 0) {
    return {
      ok: false,
      error: {
        code: PRICING_ERROR_CODES.INVALID,
        message: "At least one pricing tier is required",
      },
    };
  }

  // Validate tier ordering and values
  let previousUpperBound = 0;
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];

    if (tier.pricePerUnitCents < 0) {
      return {
        ok: false,
        error: {
          code: PRICING_ERROR_CODES.INVALID,
          message: `Tier ${i + 1}: price per unit must be non-negative`,
        },
      };
    }

    if (tier.upToUnits !== null) {
      if (tier.upToUnits <= previousUpperBound) {
        return {
          ok: false,
          error: {
            code: PRICING_ERROR_CODES.INVALID,
            message: `Tier ${i + 1}: upToUnits (${tier.upToUnits}) must be greater than previous tier upper bound (${previousUpperBound})`,
          },
        };
      }
      previousUpperBound = tier.upToUnits;
    } else if (i !== tiers.length - 1) {
      return {
        ok: false,
        error: {
          code: PRICING_ERROR_CODES.INVALID,
          message: "Only the last tier may have null upToUnits (unbounded)",
        },
      };
    }
  }

  return { ok: true, value: undefined };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested !== null && typeof nested === "object") {
      deepFreeze(nested);
    }
  }

  return Object.freeze(value);
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function emitTransitionAudit(
  deps: PricingDeps,
  event: {
    readonly entityType: "pricing_plan";
    readonly entityId: UUID;
    readonly action: string;
    readonly fromState: string | null;
    readonly toState: string;
    readonly timestamp: ISODateTime;
    readonly actor?: string;
    readonly metadata?: MarketplaceAuditEventMetadata;
  },
): void {
  if (!deps.emitAuditEvent) return;
  deps.emitAuditEvent({
    ...event,
    actor: event.actor ?? deps.defaultActor ?? MARKETPLACE_SYSTEM_ACTOR,
  });
}
