import { describe, expect, it, vi } from "vitest";

import { FridayMarketplaceAssetCatalogService } from "../../../../src/marketplace/services/friday-marketplace-asset-catalog-service.js";
import type {
  FridayListing,
  FridayListingVersion,
  FridayPublisher,
} from "../../../../src/marketplace/model/friday-marketplace.types.js";

function createPublisher(): FridayPublisher {
  return {
    id: "publisher-1",
    tenantId: "tenant-1",
    principalId: "principal-1",
    displayName: "Friday",
    bio: "Creator",
    avatarUrl: null,
    websiteUrl: null,
    contactEmail: "hello@example.com",
    verificationStatus: "verified",
    legalName: null,
    taxIdLast4: null,
    country: null,
    payoutMethod: null,
    platformFeeBps: 0,
    createdAt: "2026-03-08T00:00:00.000Z",
    updatedAt: "2026-03-08T00:00:00.000Z",
  };
}

function createListing(): FridayListing {
  return {
    id: "listing-1",
    publisherId: "publisher-1",
    slug: "workflow-one",
    status: "published",
    currentVersionId: "ver-1",
    pendingVersionId: null,
    tenantId: null,
    tags: ["ops"],
    createdAt: "2026-03-08T00:00:00.000Z",
    updatedAt: "2026-03-08T00:00:00.000Z",
  };
}

function createVersion(): FridayListingVersion {
  return {
    id: "ver-1",
    listingId: "listing-1",
    versionNumber: 1,
    status: "published",
    title: "Workflow One",
    description: "Workflow summary",
    longDescription: null,
    screenshotUrls: [],
    packageName: "@friday/workflow-one",
    packageVersion: "1.0.0",
    assetType: "workflow",
    distributionMode: "declarative_public",
    permissionManifest: {
      permissions: [],
      requiresExplicitApproval: false,
    },
    pricingPlan: { type: "free" },
    releaseNotes: null,
    createdAt: "2026-03-08T00:00:00.000Z",
  };
}

function createService(input: {
  installations: Array<{
    listingId: string;
    tenantId: string;
    principalId: string;
    createdAt: string;
  }>;
  supportEvents: Array<{
    assetId: string;
    creatorId: string;
    supporterTenantId: string;
    supporterPrincipalId: string;
    createdAt: string;
  }>;
}) {
  const publisher = createPublisher();
  const listing = createListing();
  const version = createVersion();

  return new FridayMarketplaceAssetCatalogService({
    commerce: {
      getPublisher: vi.fn(async () => publisher),
      getSearchIndex: vi.fn(async () => [
        {
          listing,
          version,
          purchaseCount: 0,
        },
      ]),
    },
    commerceAnalytics: {
      listInstallations: vi.fn(async () => input.installations),
      listSupportEvents: vi.fn(async () => input.supportEvents),
      listAcceptedRequestCountsByCreator: vi.fn(async () => []),
    },
    skillLifecycle: {
      listCatalog: vi.fn(() => ({ items: [], total: 0, hasMore: false })),
      getSkill: vi.fn(() => null),
    },
  });
}

describe("FridayMarketplaceAssetCatalogService", () => {
  it("ignores self-gaming and same-day duplicate actors when computing proof-of-use counts", async () => {
    const cleanService = createService({
      installations: [
        {
          listingId: "listing-1",
          tenantId: "tenant-2",
          principalId: "principal-2",
          createdAt: "2026-03-08T00:00:00.000Z",
        },
      ],
      supportEvents: [
        {
          assetId: "listing:listing-1",
          creatorId: "publisher:publisher-1",
          supporterTenantId: "tenant-3",
          supporterPrincipalId: "principal-3",
          createdAt: "2026-03-08T02:00:00.000Z",
        },
      ],
    });
    const noisyService = createService({
      installations: [
        {
          listingId: "listing-1",
          tenantId: "tenant-1",
          principalId: "principal-1",
          createdAt: "2026-03-08T00:00:00.000Z",
        },
        {
          listingId: "listing-1",
          tenantId: "tenant-2",
          principalId: "principal-2",
          createdAt: "2026-03-08T01:00:00.000Z",
        },
        {
          listingId: "listing-1",
          tenantId: "tenant-2",
          principalId: "principal-2",
          createdAt: "2026-03-08T05:00:00.000Z",
        },
      ],
      supportEvents: [
        {
          assetId: "listing:listing-1",
          creatorId: "publisher:publisher-1",
          supporterTenantId: "tenant-1",
          supporterPrincipalId: "principal-1",
          createdAt: "2026-03-08T00:00:00.000Z",
        },
        {
          assetId: "listing:listing-1",
          creatorId: "publisher:publisher-1",
          supporterTenantId: "tenant-3",
          supporterPrincipalId: "principal-3",
          createdAt: "2026-03-08T02:00:00.000Z",
        },
        {
          assetId: "listing:listing-1",
          creatorId: "publisher:publisher-1",
          supporterTenantId: "tenant-3",
          supporterPrincipalId: "principal-3",
          createdAt: "2026-03-08T08:00:00.000Z",
        },
      ],
    });

    const [cleanAsset] = await cleanService.listAssets();
    const [noisyAsset] = await noisyService.listAssets();

    expect(cleanAsset).toBeDefined();
    expect(noisyAsset).toBeDefined();
    expect(noisyAsset?.proofOfUseScore).toBe(cleanAsset?.proofOfUseScore);
  });
});
