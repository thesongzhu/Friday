import { describe, expect, it } from "vitest";
import { assertListingExecutionReady } from "../../../../src/marketplace/engine/entitlement-guard.js";

describe("assertListingExecutionReady", () => {
  it("allows active entitlement when installation is not required", async () => {
    const result = await assertListingExecutionReady(
      {
        listingId: "listing-1",
        principalId: "tenant-1",
      },
      {
        requireInstallation: false,
        listEntitlements: async () => [{
          id: "ent-1",
          tenantId: "tenant-1",
          principalId: "tenant-1",
          listingId: "listing-1",
          packageName: "@friday/agent-a",
          sourceType: "purchase",
          sourceId: "purchase-1",
          status: "active",
          grantedAt: "2026-03-01T00:00:00.000Z",
          expiresAt: null,
          gracePeriodEndsAt: null,
          grandfathered: false,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        }],
        listInstallations: async () => [],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entitlement.id).toBe("ent-1");
    expect(result.value.installation).toBeNull();
  });

  it("denies when entitlement is missing", async () => {
    const result = await assertListingExecutionReady(
      {
        listingId: "listing-1",
        principalId: "tenant-1",
      },
      {
        listEntitlements: async () => [],
        listInstallations: async () => [],
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MARKETPLACE_ENTITLEMENT_REQUIRED");
  });

  it("denies when installation is required but missing", async () => {
    const result = await assertListingExecutionReady(
      {
        listingId: "listing-1",
        principalId: "tenant-1",
      },
      {
        listEntitlements: async () => [{
          id: "ent-1",
          tenantId: "tenant-1",
          principalId: "tenant-1",
          listingId: "listing-1",
          packageName: "@friday/agent-a",
          sourceType: "purchase",
          sourceId: "purchase-1",
          status: "grace",
          grantedAt: "2026-03-01T00:00:00.000Z",
          expiresAt: null,
          gracePeriodEndsAt: null,
          grandfathered: false,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        }],
        listInstallations: async () => [],
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MARKETPLACE_INSTALL_REQUIRED");
  });

  it("allows when entitlement and installed record both exist", async () => {
    const result = await assertListingExecutionReady(
      {
        listingId: "listing-1",
        principalId: "tenant-1",
      },
      {
        listEntitlements: async () => [{
          id: "ent-1",
          tenantId: "tenant-1",
          principalId: "tenant-1",
          listingId: "listing-1",
          packageName: "@friday/agent-a",
          sourceType: "purchase",
          sourceId: "purchase-1",
          status: "active",
          grantedAt: "2026-03-01T00:00:00.000Z",
          expiresAt: null,
          gracePeriodEndsAt: null,
          grandfathered: false,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        }],
        listInstallations: async () => [{
          id: "inst-1",
          tenantId: "tenant-1",
          principalId: "tenant-1",
          listingId: "listing-1",
          assetType: "agent",
          packageName: "@friday/agent-a",
          packageVersion: "1.0.0",
          status: "installed",
          lastError: null,
          installedAt: "2026-03-01T00:01:00.000Z",
          createdAt: "2026-03-01T00:01:00.000Z",
          updatedAt: "2026-03-01T00:01:00.000Z",
        }],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.installation?.id).toBe("inst-1");
  });
});
