import { describe, it, expect, vi } from "vitest";
import {
  createFridayBillingAdapterRegistry,
  BILLING_ADAPTER_ERROR_CODES,
} from "../../../../src/marketplace/billing/friday-billing-adapter.js";
import type { FridayBillingAdapter } from "../../../../src/marketplace/billing/friday-billing-adapter.js";

// ─── Test Helpers ───

function createMockAdapter(providerId: string): FridayBillingAdapter {
  return {
    providerId,
    displayName: `${providerId} adapter`,
    createCharge: vi.fn(),
    createRefund: vi.fn(),
    createPayout: vi.fn(),
    createSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    verifyWebhook: vi.fn(),
    getPaymentMethodInfo: vi.fn(),
  };
}

// ─── Tests ───

describe("FridayBillingAdapterRegistry", () => {
  describe("register / get", () => {
    it("registers and retrieves an adapter", () => {
      const registry = createFridayBillingAdapterRegistry();
      const adapter = createMockAdapter("stripe");

      registry.register(adapter);

      expect(registry.get("stripe")).toBe(adapter);
    });

    it("returns undefined for unregistered provider", () => {
      const registry = createFridayBillingAdapterRegistry();

      expect(registry.get("unknown")).toBeUndefined();
    });

    it("overwrites adapter with same provider ID", () => {
      const registry = createFridayBillingAdapterRegistry();
      const first = createMockAdapter("stripe");
      const second = createMockAdapter("stripe");

      registry.register(first);
      registry.register(second);

      expect(registry.get("stripe")).toBe(second);
    });
  });

  describe("require", () => {
    it("returns ok result for registered provider", () => {
      const registry = createFridayBillingAdapterRegistry();
      const adapter = createMockAdapter("paypal");
      registry.register(adapter);

      const result = registry.require("paypal");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(adapter);
      }
    });

    it("returns error for unregistered provider", () => {
      const registry = createFridayBillingAdapterRegistry();

      const result = registry.require("unknown");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(BILLING_ADAPTER_ERROR_CODES.PROVIDER_NOT_FOUND);
        expect(result.error.message).toContain("unknown");
      }
    });
  });

  describe("listProviders", () => {
    it("returns empty array for empty registry", () => {
      const registry = createFridayBillingAdapterRegistry();

      expect(registry.listProviders()).toEqual([]);
    });

    it("returns all registered provider IDs", () => {
      const registry = createFridayBillingAdapterRegistry();
      registry.register(createMockAdapter("stripe"));
      registry.register(createMockAdapter("paypal"));

      const providers = registry.listProviders();

      expect(providers).toHaveLength(2);
      expect(providers).toContain("stripe");
      expect(providers).toContain("paypal");
    });
  });
});
