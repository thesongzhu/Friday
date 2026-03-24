import { describe, expect, it, vi } from "vitest";

import { FridayDomainError } from "#errors";
import { FridayMarketplaceCreatorService } from "../../../../src/marketplace/services/friday-marketplace-creator-service.js";
import { DEFAULT_FRIDAY_MARKETPLACE_PROOF_OF_USE_POLICY } from "../../../../src/marketplace/services/friday-marketplace-proof-of-use-policy.js";

function createService(input?: { proofOfUsePolicy?: typeof DEFAULT_FRIDAY_MARKETPLACE_PROOF_OF_USE_POLICY }) {
  const deps = {
    commerce: {
      getPublisher: vi.fn(async () => null),
      listPublishers: vi.fn(async () => [
        {
          id: "publisher-1",
          tenantId: "tenant-1",
          principalId: "principal-1",
          displayName: "Friday",
          contactEmail: "hello@example.com",
          bio: "Creator",
          avatarUrl: null,
          websiteUrl: null,
          verificationStatus: "verified",
          platformFeeBps: 0,
          stripeAccountId: null,
          taxIdLast4: null,
          country: null,
          payoutMethod: null,
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:00.000Z",
        },
      ]),
      listInstallations: vi.fn(async () => [
        { listingId: "listing-1" },
        { listingId: "listing-1" },
      ]),
      listAcceptedRequestCountsByCreator: vi.fn(async () => [
        { creatorId: "publisher:publisher-1", count: 2 },
      ]),
      listSupportEvents: vi.fn(async () => [
        {
          id: "support-1",
          creatorId: "publisher:publisher-1",
          assetId: "listing:listing-1",
          assetType: "workflow",
          supporterTenantId: "tenant-2",
          supporterPrincipalId: "principal-2",
          amount: { amount: 1000, currency: "USD" },
          message: null,
          createdAt: "2026-03-08T00:00:00.000Z",
        },
      ]),
      saveSupportEvent: vi.fn(async () => undefined),
    },
    assetCatalog: {
      listAssets: vi.fn(async () => [
        {
          assetId: "listing:listing-1",
          creatorId: "publisher:publisher-1",
          assetType: "workflow",
          sourceKind: "marketplace_listing",
          distributionMode: "declarative_public",
          publicEligible: true,
          title: "Workflow One",
          slug: "workflow-one",
          summary: "Workflow summary",
          publisherName: "Friday",
          installable: true,
          installed: false,
          enabled: false,
          verificationStatus: "verified",
          trustScore: 91,
          latestVersion: "1.0.0",
          maturity: "validated_and_keep",
          proofOfUseScore: 78,
          repeatRunRate: 0.65,
          outcomeReliabilityScore: 89,
          permissionEfficiencyScore: 88,
          requestFulfillmentRate: 0.67,
          maintenanceResponsivenessScore: 83,
        },
      ]),
      getAsset: vi.fn(async (assetId: string) =>
        assetId === "listing:listing-1"
          ? {
            assetId,
            creatorId: "publisher:publisher-1",
            assetType: "workflow",
            sourceKind: "marketplace_listing",
            distributionMode: "declarative_public",
            publicEligible: true,
            title: "Workflow One",
            slug: "workflow-one",
            summary: "Workflow summary",
            publisherName: "Friday",
            installable: true,
            installed: false,
            enabled: false,
            verificationStatus: "verified",
            trustScore: 91,
            latestVersion: "1.0.0",
            maturity: "validated_and_keep",
            description: "Workflow description",
            permissions: ["workflow.deploy"],
            sourceLabel: "Friday catalog",
            provenance: { kind: "listing", listingId: "listing-1" as never },
          }
          : null,
      ),
    },
    generateId: vi.fn(() => "support-2"),
    now: vi.fn(() => "2026-03-08T00:05:00.000Z"),
    proofOfUsePolicy: input?.proofOfUsePolicy,
  };

  return {
    deps,
    service: new FridayMarketplaceCreatorService(deps as never),
  };
}

describe("FridayMarketplaceCreatorService", () => {
  it("lists creators ordered by reputation", async () => {
    const { service } = createService();

    const creators = await service.listCreators();

    expect(creators).toHaveLength(1);
    expect(creators[0]).toMatchObject({
      id: "publisher:publisher-1",
      assetIds: ["listing:listing-1"],
      reputation: expect.objectContaining({
        supportCount: 1,
        installCount: 2,
        verifiedAssetCount: 1,
        fulfilledRequestCount: 2,
        proofOfUseScore: expect.any(Number),
        outcomeReliabilityScore: expect.any(Number),
      }),
    });
  });

  it("returns null when a creator has no public assets", async () => {
    const { service } = createService();

    const creator = await service.getCreator("publisher:missing");

    expect(creator).toBeNull();
  });

  it("rejects support for non-public assets", async () => {
    const { deps, service } = createService();
    vi.mocked(deps.assetCatalog.getAsset).mockResolvedValueOnce({
      assetId: "listing:listing-1",
      creatorId: "publisher:publisher-1",
      assetType: "workflow",
      sourceKind: "marketplace_listing",
      distributionMode: "legacy_executable",
      publicEligible: false,
      title: "Workflow One",
      slug: "workflow-one",
      summary: "Workflow summary",
      publisherName: "Friday",
      installable: false,
      installed: false,
      enabled: false,
      verificationStatus: "unverified",
      trustScore: 50,
      latestVersion: "1.0.0",
      maturity: "validated_but_temporary",
      description: "Workflow description",
      permissions: ["workflow.deploy"],
      sourceLabel: "Friday catalog",
      provenance: { kind: "listing", listingId: "listing-1" as never },
    });

    await expect(service.recordSupport({
      assetId: "listing:listing-1",
      actor: {
        tenantId: "tenant-2",
        principalId: "principal-2",
      },
      amount: { amount: 500, currency: "USD" },
    })).rejects.toMatchObject<Partial<FridayDomainError>>({
      code: "MARKETPLACE_ASSET_NOT_SUPPORTABLE",
    });
  });

  it("persists support events and returns updated creator state", async () => {
    const { deps, service } = createService();

    const result = await service.recordSupport({
      assetId: "listing:listing-1",
      actor: {
        tenantId: "tenant-2",
        principalId: "principal-2",
      },
      amount: { amount: 500, currency: "USD" },
      message: "Great work",
    });

    expect(deps.commerce.saveSupportEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "support-2",
        creatorId: "publisher:publisher-1",
        supporterTenantId: "tenant-2",
        supporterPrincipalId: "principal-2",
        amount: { amount: 500, currency: "USD" },
        message: "Great work",
      }),
    );
    expect(result.creator).toMatchObject({
      id: "publisher:publisher-1",
    });
  });

  it("lets policy injection change creator overall score without changing response shape", async () => {
    const { service } = createService({
      proofOfUsePolicy: {
        ...DEFAULT_FRIDAY_MARKETPLACE_PROOF_OF_USE_POLICY,
        creatorOverallWeights: {
          ...DEFAULT_FRIDAY_MARKETPLACE_PROOF_OF_USE_POLICY.creatorOverallWeights,
          proofOfUse: 0.2,
          outcomeReliability: 0.05,
          permissionEfficiency: 0.05,
          supportCountPointsPerEvent: 5,
          supportCountPointsCap: 20,
          fulfilledRequestPointsPerEvent: 4,
          fulfilledRequestPointsCap: 20,
        },
      },
    });

    const [creator] = await service.listCreators();

    expect(creator).toBeDefined();
    expect(creator?.reputation.overallScore).toBeGreaterThan(20);
    expect(creator?.reputation.proofOfUseScore).toBe(78);
    expect(creator?.reputation.outcomeReliabilityScore).toBe(89);
  });
});
