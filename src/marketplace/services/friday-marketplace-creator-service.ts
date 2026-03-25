import { FridayDomainError } from "#errors";
import type { FridayLearningEventAppendInput } from "#ledger";
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
import {
  DEFAULT_FRIDAY_MARKETPLACE_PROOF_OF_USE_POLICY,
  type FridayMarketplaceProofOfUsePolicy,
} from "./friday-marketplace-proof-of-use-policy.js";

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
  learningEventWriter?: (events: FridayLearningEventAppendInput[]) => void;
  learningUserId?: string;
  proofOfUsePolicy?: FridayMarketplaceProofOfUsePolicy;
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

function actorKey(input: {
  tenantId?: string | null;
  principalId?: string | null;
}): string | null {
  const tenantId = input.tenantId?.trim();
  const principalId = input.principalId?.trim();
  if (!tenantId && !principalId) {
    return null;
  }
  return `${tenantId ?? "unknown"}:${principalId ?? "unknown"}`;
}

function publisherActorKey(publisher: FridayPublisher | null | undefined): string | null {
  if (!publisher) {
    return null;
  }
  return actorKey({
    tenantId: publisher.tenantId,
    principalId: publisher.principalId,
  });
}

function actorMatchesPublisher(
  input: {
    tenantId?: string | null;
    principalId?: string | null;
  },
  publisher: FridayPublisher | null | undefined,
): boolean {
  const left = actorKey(input);
  const right = publisherActorKey(publisher);
  return left !== null && right !== null && left === right;
}

function dedupeKeyForDay(assetId: string, actor: string | null, createdAt: string): string | null {
  if (!actor) {
    return null;
  }
  return `${assetId}:${actor}:${createdAt.slice(0, 10)}`;
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
  proofOfUsePolicy: FridayMarketplaceProofOfUsePolicy,
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
  const proofOfUseScore = assets.length === 0
    ? 0
    : Math.round(assets.reduce((sum, asset) => sum + (asset.proofOfUseScore ?? 0), 0) / assets.length);
  const repeatRunRate = assets.length === 0
    ? 0
    : Number(
      (
        assets.reduce((sum, asset) => sum + (asset.repeatRunRate ?? 0), 0) / assets.length
      ).toFixed(3),
    );
  const outcomeReliabilityScore = assets.length === 0
    ? 0
    : Math.round(
      assets.reduce((sum, asset) => sum + (asset.outcomeReliabilityScore ?? 0), 0) / assets.length,
    );
  const permissionEfficiencyScore = assets.length === 0
    ? permissionRestraintScore
    : Math.round(
      assets.reduce((sum, asset) => sum + (asset.permissionEfficiencyScore ?? 0), 0) / assets.length,
    );
  const requestFulfillmentRate = assets.length === 0
    ? 0
    : Number(
      (
        assets.reduce((sum, asset) => sum + (asset.requestFulfillmentRate ?? 0), 0) / assets.length
      ).toFixed(3),
    );
  const maintenanceResponsivenessScore = assets.length === 0
    ? 0
    : Math.round(
      assets.reduce((sum, asset) => sum + (asset.maintenanceResponsivenessScore ?? 0), 0) / assets.length,
    );
  const overallScore = Math.round(
    clamp(
      proofOfUseScore * proofOfUsePolicy.creatorOverallWeights.proofOfUse
      + outcomeReliabilityScore * proofOfUsePolicy.creatorOverallWeights.outcomeReliability
      + permissionEfficiencyScore * proofOfUsePolicy.creatorOverallWeights.permissionEfficiency
      + Math.min(
        proofOfUsePolicy.creatorOverallWeights.supportCountPointsCap,
        supportCount * proofOfUsePolicy.creatorOverallWeights.supportCountPointsPerEvent,
      )
      + Math.min(
        proofOfUsePolicy.creatorOverallWeights.fulfilledRequestPointsCap,
        fulfilledRequestCount * proofOfUsePolicy.creatorOverallWeights.fulfilledRequestPointsPerEvent,
      ),
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
    proofOfUseScore,
    repeatRunRate,
    outcomeReliabilityScore,
    permissionEfficiencyScore,
    requestFulfillmentRate,
    maintenanceResponsivenessScore,
  };
}

export class FridayMarketplaceCreatorService {
  public constructor(private readonly deps: FridayMarketplaceCreatorServiceDeps) {}

  private writeLearningEvent(event: Omit<FridayLearningEventAppendInput, "eventId" | "ts" | "userId">): void {
    if (!this.deps.learningEventWriter || !this.deps.learningUserId) {
      return;
    }
    this.deps.learningEventWriter([
      {
        eventId: this.deps.generateId(),
        ts: this.deps.now(),
        userId: this.deps.learningUserId,
        ...event,
      },
    ]);
  }

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
    this.writeLearningEvent({
      kind: "asset_supported",
      payload: {
        assetId: asset.assetId,
        creatorId: asset.creatorId,
        assetType: asset.assetType,
        amount: input.amount.amount,
        currency: input.amount.currency,
        supporterPrincipalId: input.actor.principalId,
      },
    });
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

    const installCountByAsset = new Map<string, number>();
    const fulfilledRequestCountByCreator = new Map<string, number>();
    for (const entry of fulfilledRequestCounts) {
      fulfilledRequestCountByCreator.set(entry.creatorId, entry.count);
    }

    const publishersByCreator = new Map<string, FridayPublisher>();
    for (const publisher of publishers) {
      publishersByCreator.set(`publisher:${publisher.id}`, publisher);
    }

    const publisherByAssetId = new Map<string, FridayPublisher | null>();
    for (const asset of assets) {
      publisherByAssetId.set(asset.assetId, publishersByCreator.get(asset.creatorId) ?? null);
    }

    const seenInstallationActors = new Set<string>();
    for (const installation of installations) {
      const assetId = `listing:${installation.listingId}`;
      const publisher = publisherByAssetId.get(assetId) ?? null;
      if (actorMatchesPublisher(installation, publisher)) {
        continue;
      }
      const dedupeKey = dedupeKeyForDay(
        assetId,
        actorKey(installation),
        installation.createdAt,
      );
      if (dedupeKey && seenInstallationActors.has(dedupeKey)) {
        continue;
      }
      if (dedupeKey) {
        seenInstallationActors.add(dedupeKey);
      }
      installCountByAsset.set(assetId, (installCountByAsset.get(assetId) ?? 0) + 1);
    }

    const filteredSupportEvents: FridaySupportEvent[] = [];
    const seenSupportActors = new Set<string>();
    for (const event of supportEvents) {
      const publisher =
        publishersByCreator.get(event.creatorId) ??
        publisherByAssetId.get(event.assetId) ??
        null;
      if (
        actorMatchesPublisher(
          {
            tenantId: event.supporterTenantId,
            principalId: event.supporterPrincipalId,
          },
          publisher,
        )
      ) {
        continue;
      }
      const dedupeKey = dedupeKeyForDay(
        event.assetId,
        actorKey({
          tenantId: event.supporterTenantId,
          principalId: event.supporterPrincipalId,
        }),
        event.createdAt,
      );
      if (dedupeKey && seenSupportActors.has(dedupeKey)) {
        continue;
      }
      if (dedupeKey) {
        seenSupportActors.add(dedupeKey);
      }
      filteredSupportEvents.push(event);
    }

    return {
      assetsByCreator,
      supportByCreator: filteredSupportEvents.reduce((map, event) => {
        const bucket = map.get(event.creatorId);
        if (bucket) {
          bucket.push(event);
        } else {
          map.set(event.creatorId, [event]);
        }
        return map;
      }, new Map<string, FridaySupportEvent[]>()),
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
      this.deps.proofOfUsePolicy ?? DEFAULT_FRIDAY_MARKETPLACE_PROOF_OF_USE_POLICY,
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
