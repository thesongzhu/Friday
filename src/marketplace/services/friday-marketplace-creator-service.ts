import { FridayDomainError } from "#errors";
import type {
  FridayCreatorProfile,
  FridayCreatorReputationSummary,
  FridayMarketplaceAssetType,
  FridayMoneyAmount,
  FridayPublisher,
  FridaySupportEvent,
  MarketplaceActorContext,
} from "../model/friday-marketplace.types.js";
import type {
  FridayMarketplaceAssetCatalogService,
  FridayMarketplaceAssetDetail,
  FridayMarketplaceAssetSummary,
} from "./friday-marketplace-asset-catalog-service.js";
import type { FridayMarketplaceCommercePersistence } from "../persistence/friday-marketplace-commerce-persistence.js";

export interface FridayMarketplaceCreatorServiceDeps {
  commerce: Pick<
    FridayMarketplaceCommercePersistence,
    | "getPublisher"
    | "listPublishers"
    | "listInstallations"
    | "listAcceptedRequestCountsByCreator"
    | "listSupportEvents"
    | "saveSupportEvent"
  >;
  assetCatalog: Pick<FridayMarketplaceAssetCatalogService, "getAsset" | "listAssets">;
  generateId: () => string;
  now: () => string;
}

export interface FridayRecordSupportInput {
  assetId: string;
  actor: MarketplaceActorContext;
  amount: FridayMoneyAmount;
  message?: string | null;
}

export interface FridayRecordSupportResult {
  supportEvent: FridaySupportEvent;
  creator: FridayCreatorProfile;
}

interface CreatorProfileBuildContext {
  assetsByCreator: Map<string, FridayMarketplaceAssetSummary[]>;
  supportByCreator: Map<string, readonly FridaySupportEvent[]>;
  permissionScoreByAsset: Map<string, number>;
  installCountByAsset: Map<string, number>;
  fulfilledRequestCountByCreator: Map<string, number>;
  publishersByCreator: Map<string, FridayPublisher>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function reputationFrom(
  assets: readonly FridayMarketplaceAssetSummary[],
  supports: readonly FridaySupportEvent[],
  permissionScoreByAsset: Map<string, number>,
  installCountByAsset: Map<string, number>,
  fulfilledRequestCount: number,
): FridayCreatorReputationSummary {
  const supportCount = supports.length;
  const supportTotalCents = supports.reduce((sum, event) => sum + event.amount.amount, 0);
  const currency = supports[0]?.amount.currency ?? "USD";
  const installCount = assets.reduce(
    (sum, asset) => sum + (installCountByAsset.get(asset.assetId) ?? (asset.installed ? 1 : 0)),
    0,
  );
  const verifiedAssetCount = assets.filter((asset) => asset.verificationStatus === "verified").length;
  const verificationSuccessRate = assets.length === 0 ? null : verifiedAssetCount / assets.length;
  const permissionRestraintScore = assets.length === 0
    ? 100
    : Math.round(
      assets.reduce((sum, asset) => sum + (permissionScoreByAsset.get(asset.assetId) ?? 50), 0) / assets.length,
    );
  const overallScore = Math.round(
    clamp(
      (verificationSuccessRate ?? 0.5) * 45
      + Math.min(20, supportCount * 3)
      + Math.min(20, installCount * 1.5)
      + Math.min(10, fulfilledRequestCount * 2)
      + permissionRestraintScore * 0.15,
      0,
      100,
    ),
  );

  return {
    overallScore,
    ratingAverage: null,
    ratingCount: 0,
    supportCount,
    supportTotal: { amount: supportTotalCents, currency },
    installCount,
    verifiedAssetCount,
    verificationSuccessRate,
    permissionRestraintScore,
    fulfilledRequestCount,
  };
}

export class FridayMarketplaceCreatorService {
  public constructor(private readonly deps: FridayMarketplaceCreatorServiceDeps) {}

  public async listCreators(): Promise<FridayCreatorProfile[]> {
    const context = await this.buildContext();
    return [...context.assetsByCreator.keys()]
      .map((creatorId) => this.buildCreatorProfile(creatorId, context))
      .filter((creator): creator is FridayCreatorProfile => creator !== null)
      .sort((left, right) =>
        right.reputation.overallScore - left.reputation.overallScore
        || left.displayName.localeCompare(right.displayName),
      );
  }

  public async getCreator(creatorId: string): Promise<FridayCreatorProfile | null> {
    const context = await this.buildContext();
    return this.buildCreatorProfile(creatorId, context);
  }

  public async recordSupport(
    input: FridayRecordSupportInput,
  ): Promise<FridayRecordSupportResult> {
    const asset = await this.deps.assetCatalog.getAsset(input.assetId);
    if (asset === null) {
      throw new FridayDomainError(
        "MARKETPLACE_ASSET_NOT_FOUND",
        `Marketplace asset "${input.assetId}" not found`,
        { httpStatus: 404, details: { assetId: input.assetId } },
      );
    }
    if (!asset.publicEligible) {
      throw new FridayDomainError(
        "MARKETPLACE_ASSET_NOT_SUPPORTABLE",
        "Only public declarative marketplace assets can receive support",
        { httpStatus: 409, details: { assetId: input.assetId } },
      );
    }
    const supportEvent: FridaySupportEvent = {
      id: this.deps.generateId(),
      creatorId: asset.creatorId,
      assetId: asset.assetId,
      assetType: asset.assetType,
      supporterTenantId: input.actor.tenantId,
      supporterPrincipalId: input.actor.principalId,
      amount: input.amount,
      message: input.message ?? null,
      createdAt: this.deps.now(),
    };
    await this.deps.commerce.saveSupportEvent(supportEvent);
    const creator = await this.getCreator(asset.creatorId);
    if (creator === null) {
      throw new FridayDomainError(
        "MARKETPLACE_CREATOR_NOT_FOUND",
        `Creator "${asset.creatorId}" not found`,
        { httpStatus: 404, details: { creatorId: asset.creatorId } },
      );
    }
    return { supportEvent, creator };
  }

  private async buildContext(): Promise<CreatorProfileBuildContext> {
    const [assets, supportEvents, installations, publishers, fulfilledRequestCounts] = await Promise.all([
      this.deps.assetCatalog.listAssets(),
      this.deps.commerce.listSupportEvents(),
      this.deps.commerce.listInstallations(),
      this.deps.commerce.listPublishers(),
      this.deps.commerce.listAcceptedRequestCountsByCreator(),
    ]);

    const permissionScoreByAsset = new Map<string, number>();
    await Promise.all(
      assets.map(async (asset) => {
        const detail = await this.deps.assetCatalog.getAsset(asset.assetId);
        permissionScoreByAsset.set(asset.assetId, this.permissionScore(detail));
      }),
    );

    const assetsByCreator = new Map<string, FridayMarketplaceAssetSummary[]>();
    for (const asset of assets) {
      const bucket = assetsByCreator.get(asset.creatorId);
      if (bucket) {
        bucket.push(asset);
      } else {
        assetsByCreator.set(asset.creatorId, [asset]);
      }
    }

    const supportByCreator = new Map<string, FridaySupportEvent[]>();
    for (const event of supportEvents) {
      const bucket = supportByCreator.get(event.creatorId);
      if (bucket) {
        bucket.push(event);
      } else {
        supportByCreator.set(event.creatorId, [event]);
      }
    }

    const installCountByAsset = new Map<string, number>();
    for (const installation of installations) {
      const assetId = `listing:${installation.listingId}`;
      installCountByAsset.set(assetId, (installCountByAsset.get(assetId) ?? 0) + 1);
    }

    const fulfilledRequestCountByCreator = new Map<string, number>();
    for (const entry of fulfilledRequestCounts) {
      fulfilledRequestCountByCreator.set(entry.creatorId, entry.count);
    }

    const publishersByCreator = new Map<string, FridayPublisher>();
    for (const publisher of publishers) {
      publishersByCreator.set(`publisher:${publisher.id}`, publisher);
    }

    return {
      assetsByCreator,
      supportByCreator,
      permissionScoreByAsset,
      installCountByAsset,
      fulfilledRequestCountByCreator,
      publishersByCreator,
    };
  }

  private buildCreatorProfile(
    creatorId: string,
    context: CreatorProfileBuildContext,
  ): FridayCreatorProfile | null {
    const assets = context.assetsByCreator.get(creatorId) ?? [];
    if (assets.length === 0) {
      return null;
    }
    const publisher = context.publishersByCreator.get(creatorId) ?? null;
    const supports = context.supportByCreator.get(creatorId) ?? [];
    const fulfilledRequestCount = context.fulfilledRequestCountByCreator.get(creatorId) ?? 0;
    const reputation = reputationFrom(
      assets,
      supports,
      context.permissionScoreByAsset,
      context.installCountByAsset,
      fulfilledRequestCount,
    );
    const displayName = publisher?.displayName ?? assets[0]?.publisherName ?? creatorId;
    return {
      id: creatorId,
      displayName,
      bio: publisher?.bio ?? null,
      avatarUrl: publisher?.avatarUrl ?? null,
      websiteUrl: publisher?.websiteUrl ?? null,
      assetIds: assets.map((asset) => asset.assetId),
      reputation,
      verifiedPublisher: publisher?.verificationStatus === "verified",
    };
  }

  private permissionScore(
    detail: FridayMarketplaceAssetDetail | null,
  ): number {
    if (detail === null) {
      return 50;
    }
    if (detail.permissions.length === 0) {
      return 100;
    }
    return clamp(100 - detail.permissions.length * 12, 10, 95);
  }
}
