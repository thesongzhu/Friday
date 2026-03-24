import type { FridayMarketplaceCommerceRoutesDeps } from "../../api/http/routes/friday-marketplace-commerce-routes.js";
import type { ListingSearchEntry } from "../engine/search-discovery.js";
import type {
  FridayMarketplaceAssetType,
  FridayMarketplaceDistributionMode,
  FridayPublisher,
} from "../model/friday-marketplace.types.js";
import type {
  FridaySkillCatalogViewItem,
  FridaySkillLifecycleDetail,
  FridaySkillLifecycleService,
} from "../../skills/services/friday-skill-lifecycle-service.js";
import type { PermissionGrant } from "../../skills/model/friday-skill-permission-policy.types.js";
import {
  computeMarketplaceProofSignals,
  sortMarketplaceAssetsByProofOfUse,
} from "./friday-marketplace-proof-of-use.js";
import type { FridayMarketplaceProofOfUsePolicy } from "./friday-marketplace-proof-of-use-policy.js";

export type FridayMarketplaceAssetSourceKind =
  | "skills_lifecycle"
  | "marketplace_listing";

export interface FridayMarketplaceAssetSummary {
  assetId: string;
  creatorId: string;
  assetType: FridayMarketplaceAssetType;
  sourceKind: FridayMarketplaceAssetSourceKind;
  distributionMode: FridayMarketplaceDistributionMode;
  publicEligible: boolean;
  title: string;
  slug: string;
  summary: string;
  publisherName: string;
  installable: boolean;
  installed: boolean;
  enabled: boolean;
  verificationStatus: "verified" | "unverified" | "unknown";
  trustScore: number | null;
  latestVersion: string | null;
  maturity: "validated_and_keep" | "validated_but_temporary" | "deferred";
  proofOfUseScore?: number;
  repeatRunRate?: number;
  outcomeReliabilityScore?: number;
  permissionEfficiencyScore?: number;
  requestFulfillmentRate?: number;
  maintenanceResponsivenessScore?: number;
}

export interface FridayMarketplaceAssetDetail
  extends FridayMarketplaceAssetSummary {
  description: string;
  permissions: string[];
  sourceLabel: string;
  provenance:
    | {
        kind: "skill";
        skillId: string;
      }
    | {
        kind: "listing";
        listingId: string;
        versionId: string | null;
      };
}

export interface FridayMarketplaceAssetCatalogServiceDeps {
  commerce: Pick<
    FridayMarketplaceCommerceRoutesDeps,
    "getPublisher" | "getSearchIndex"
  >;
  commerceAnalytics?: {
    listInstallations: () => Promise<Array<{ listingId: string }>>;
    listSupportEvents: () => Promise<Array<{ assetId: string }>>;
    listAcceptedRequestCountsByCreator: () => Promise<
      readonly {
        creatorId: string;
        count: number;
      }[]
    >;
  };
  skillLifecycle: Pick<
    FridaySkillLifecycleService,
    "getSkill" | "listCatalog"
  >;
  proofOfUsePolicy?: FridayMarketplaceProofOfUsePolicy;
}

interface FridayMarketplaceProofContext {
  installCountByAsset: Map<string, number>;
  supportCountByAsset: Map<string, number>;
  requestFulfillmentCountByCreator: Map<string, number>;
}

function permissionGrantToLabel(grant: PermissionGrant): string {
  const selectors = grant.selectors;
  if (grant.resource === "filesystem" && selectors?.pathPrefixes?.length) {
    return `${grant.resource}.${grant.action}:${selectors.pathPrefixes.join(",")}`;
  }
  if (grant.resource === "network" && selectors?.hostAllowlist?.length) {
    return `${grant.resource}.${grant.action}:${selectors.hostAllowlist.join(",")}`;
  }
  if (grant.resource === "tool" && selectors?.toolAllowlist?.length) {
    return `${grant.resource}.${grant.action}:${selectors.toolAllowlist.join(",")}`;
  }
  if (grant.resource === "shell" && selectors?.commandAllowlist?.length) {
    return `${grant.resource}.${grant.action}:${selectors.commandAllowlist.join(",")}`;
  }
  if (grant.resource === "memory" && selectors?.memoryNamespaces?.length) {
    return `${grant.resource}.${grant.action}:${selectors.memoryNamespaces.join(",")}`;
  }
  if (grant.resource === "channel" && selectors?.channelIds?.length) {
    return `${grant.resource}.${grant.action}:${selectors.channelIds.join(",")}`;
  }
  return `${grant.resource}.${grant.action}`;
}

function skillPermissionsToLabels(
  detail: FridaySkillLifecycleDetail,
): string[] {
  const manifest =
    detail.currentManifest ?? detail.catalogEntry?.manifest ?? null;
  if (manifest === null) {
    return [];
  }
  return manifest.permissions.grants.map(permissionGrantToLabel);
}

function slugifyCreatorId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function skillCreatorId(
  detailOrItem: FridaySkillLifecycleDetail | FridaySkillCatalogViewItem,
): string {
  if (detailOrItem.sourceDetails?.id) {
    return `source:${detailOrItem.sourceDetails.id}`;
  }
  if (detailOrItem.publisher) {
    return `publisher:${slugifyCreatorId(detailOrItem.publisher)}`;
  }
  return `skill:${detailOrItem.skillId}`;
}

function listingCreatorId(entry: ListingSearchEntry): string {
  return `publisher:${entry.listing.publisherId}`;
}

function skillDistributionMode(
  detailOrItem:
    | FridaySkillLifecycleDetail
    | FridaySkillCatalogViewItem,
): FridayMarketplaceDistributionMode {
  const manifest =
    "manifest" in detailOrItem
      ? detailOrItem.manifest
      : detailOrItem.currentManifest ?? detailOrItem.catalogEntry?.manifest ?? null;
  return manifest?.runtime.kind === "builtin"
    ? "declarative_public"
    : "legacy_executable";
}

export class FridayMarketplaceAssetCatalogService {
  public constructor(
    private readonly deps: FridayMarketplaceAssetCatalogServiceDeps,
  ) {}

  public async listAssets(): Promise<FridayMarketplaceAssetSummary[]> {
    const proofContext = await this.buildProofContext();
    const [skillAssets, listingAssets] = await Promise.all([
      this.listSkillAssets(proofContext),
      this.listListingAssets(proofContext),
    ]);
    return sortMarketplaceAssetsByProofOfUse([...skillAssets, ...listingAssets]);
  }

  public async getAsset(
    assetId: string,
  ): Promise<FridayMarketplaceAssetDetail | null> {
    const proofContext = await this.buildProofContext();
    if (assetId.startsWith("skill:")) {
      return this.getSkillAsset(assetId.slice("skill:".length), proofContext);
    }
    if (assetId.startsWith("listing:")) {
      return this.getListingAsset(assetId.slice("listing:".length), proofContext);
    }
    return null;
  }

  private async listSkillAssets(
    proofContext: FridayMarketplaceProofContext,
  ): Promise<FridayMarketplaceAssetSummary[]> {
    const catalog = await this.deps.skillLifecycle.listCatalog({
      includeStale: true,
      limit: 200,
    });
    return (catalog.items as FridaySkillCatalogViewItem[])
      .map((item) => this.mapSkillSummary(item, proofContext))
      .filter((item) => item.publicEligible);
  }

  private async listListingAssets(
    proofContext: FridayMarketplaceProofContext,
  ): Promise<FridayMarketplaceAssetSummary[]> {
    const searchIndex = await this.deps.commerce.getSearchIndex();
    const publisherCache = new Map<string, Promise<FridayPublisher | null>>();
    const assets: FridayMarketplaceAssetSummary[] = [];
    for (const entry of searchIndex) {
      let publisherPromise = publisherCache.get(entry.listing.publisherId);
      if (publisherPromise === undefined) {
        publisherPromise = this.deps.commerce.getPublisher(
          entry.listing.publisherId,
        );
        publisherCache.set(entry.listing.publisherId, publisherPromise);
      }
      const publisher = await publisherPromise;
      const summary = this.mapListingSummary(entry, publisher, proofContext);
      if (summary.publicEligible) {
        assets.push(summary);
      }
    }
    return assets;
  }

  private async getSkillAsset(
    skillId: string,
    proofContext: FridayMarketplaceProofContext,
  ): Promise<FridayMarketplaceAssetDetail | null> {
    const detail = await this.deps.skillLifecycle.getSkill(skillId);
    if (detail === null) {
      return null;
    }
    return this.mapSkillDetail(detail, proofContext);
  }

  private async getListingAsset(
    listingId: string,
    proofContext: FridayMarketplaceProofContext,
  ): Promise<FridayMarketplaceAssetDetail | null> {
    const searchIndex = await this.deps.commerce.getSearchIndex();
    const entry =
      searchIndex.find((item) => item.listing.id === listingId) ?? null;
    if (entry === null) {
      return null;
    }
    const publisher = await this.deps.commerce.getPublisher(
      entry.listing.publisherId,
    );
    return this.mapListingDetail(entry, publisher, proofContext);
  }

  private mapSkillSummary(
    item: FridaySkillCatalogViewItem,
    proofContext: FridayMarketplaceProofContext,
  ): FridayMarketplaceAssetSummary {
    const distributionMode = skillDistributionMode(item);
    const publicEligible = distributionMode === "declarative_public";
    const assetId = `skill:${item.skillId}`;
    const creatorId = skillCreatorId(item);
    const signals = computeMarketplaceProofSignals({
      verificationStatus: item.signatureValid ? "verified" : "unverified",
      trustScore: item.trustScore,
      permissionCount: item.manifest.permissions.grants.length,
      installCount: item.installed ? 1 : 0,
      supportCount: proofContext.supportCountByAsset.get(assetId) ?? 0,
      requestFulfillmentCount: proofContext.requestFulfillmentCountByCreator.get(creatorId) ?? 0,
      maintained: Boolean(item.version),
    }, this.deps.proofOfUsePolicy);
    return {
      assetId,
      creatorId,
      assetType: "skill",
      sourceKind: "skills_lifecycle",
      distributionMode,
      publicEligible,
      title: item.skillName,
      slug: item.skillId,
      summary: item.manifest.description,
      publisherName: item.publisher ?? item.sourceDetails?.name ?? "Local skill",
      installable: publicEligible && !item.installed,
      installed: item.installed,
      enabled: item.installed,
      verificationStatus: item.signatureValid ? "verified" : "unverified",
      trustScore: item.trustScore,
      latestVersion: item.version,
      maturity: publicEligible ? "validated_and_keep" : "validated_but_temporary",
      ...signals,
    };
  }

  private mapSkillDetail(
    detail: FridaySkillLifecycleDetail,
    proofContext: FridayMarketplaceProofContext,
  ): FridayMarketplaceAssetDetail {
    const manifest =
      detail.currentManifest ?? detail.catalogEntry?.manifest ?? null;
    const distributionMode = skillDistributionMode(detail);
    const publicEligible = distributionMode === "declarative_public";
    const assetId = `skill:${detail.skillId}`;
    const creatorId = skillCreatorId(detail);
    const permissions = skillPermissionsToLabels(detail);
    const signals = computeMarketplaceProofSignals({
      verificationStatus:
        detail.verification?.ok === true
          ? "verified"
          : detail.verification?.ok === false
            ? "unverified"
            : "unknown",
      trustScore: detail.catalogEntry?.trustScore ?? null,
      permissionCount: permissions.length,
      installCount: Boolean(detail.installedVersion) ? 1 : 0,
      supportCount: proofContext.supportCountByAsset.get(assetId) ?? 0,
      requestFulfillmentCount: proofContext.requestFulfillmentCountByCreator.get(creatorId) ?? 0,
      maintained: Boolean(detail.latestVersion ?? detail.installedVersion),
    }, this.deps.proofOfUsePolicy);
    return {
      assetId,
      creatorId,
      assetType: "skill",
      sourceKind: "skills_lifecycle",
      distributionMode,
      publicEligible,
      title: detail.name,
      slug: detail.skillId,
      summary: detail.description ?? manifest?.description ?? "",
      publisherName:
        detail.publisher ?? detail.sourceDetails?.name ?? "Local skill",
      installable: publicEligible && !Boolean(detail.installedVersion),
      installed: Boolean(detail.installedVersion),
      enabled: Boolean(detail.installedVersion),
      verificationStatus:
        detail.verification?.ok === true
          ? "verified"
          : detail.verification?.ok === false
            ? "unverified"
            : "unknown",
      trustScore: detail.catalogEntry?.trustScore ?? null,
      latestVersion: detail.latestVersion ?? detail.installedVersion ?? null,
      maturity: publicEligible ? "validated_and_keep" : "validated_but_temporary",
      ...signals,
      description: detail.description ?? manifest?.description ?? "",
      permissions,
      sourceLabel: detail.sourceDetails?.name ?? detail.source,
      provenance: {
        kind: "skill",
        skillId: detail.skillId,
      },
    };
  }

  private mapListingSummary(
    entry: ListingSearchEntry,
    publisher: FridayPublisher | null,
    proofContext: FridayMarketplaceProofContext,
  ): FridayMarketplaceAssetSummary {
    const publicEligible =
      entry.version.distributionMode === "declarative_public";
    const assetId = `listing:${entry.listing.id}`;
    const creatorId = listingCreatorId(entry);
    const signals = computeMarketplaceProofSignals({
      verificationStatus: "unverified",
      trustScore: null,
      permissionCount: entry.version.permissionManifest.permissions.length,
      installCount: proofContext.installCountByAsset.get(assetId) ?? 0,
      supportCount: proofContext.supportCountByAsset.get(assetId) ?? 0,
      requestFulfillmentCount: proofContext.requestFulfillmentCountByCreator.get(creatorId) ?? 0,
      maintained: Boolean(entry.version.packageVersion),
    }, this.deps.proofOfUsePolicy);
    return {
      assetId,
      creatorId,
      assetType: entry.version.assetType,
      sourceKind: "marketplace_listing",
      distributionMode: entry.version.distributionMode,
      publicEligible,
      title: entry.version.title,
      slug: entry.listing.slug,
      summary: entry.version.description,
      publisherName: publisher?.displayName ?? "Unknown publisher",
      installable: publicEligible,
      installed: false,
      enabled: false,
      verificationStatus: "unverified",
      trustScore: null,
      latestVersion: entry.version.packageVersion,
      maturity: publicEligible
        ? entry.version.assetType === "skill"
          ? "validated_and_keep"
          : "validated_but_temporary"
        : "validated_but_temporary",
      ...signals,
    };
  }

  private mapListingDetail(
    entry: ListingSearchEntry,
    publisher: FridayPublisher | null,
    proofContext: FridayMarketplaceProofContext,
  ): FridayMarketplaceAssetDetail {
    const summary = this.mapListingSummary(entry, publisher, proofContext);
    return {
      ...summary,
      description:
        entry.version.longDescription ?? entry.version.description,
      permissions: [...entry.version.permissionManifest.permissions],
      sourceLabel: publisher?.displayName ?? "Unknown publisher",
      provenance: {
        kind: "listing",
        listingId: entry.listing.id,
        versionId: entry.version.id,
      },
    };
  }

  private async buildProofContext(): Promise<FridayMarketplaceProofContext> {
    if (!this.deps.commerceAnalytics) {
      return {
        installCountByAsset: new Map(),
        supportCountByAsset: new Map(),
        requestFulfillmentCountByCreator: new Map(),
      };
    }

    const [installations, supportEvents, acceptedRequests] = await Promise.all([
      this.deps.commerceAnalytics.listInstallations(),
      this.deps.commerceAnalytics.listSupportEvents(),
      this.deps.commerceAnalytics.listAcceptedRequestCountsByCreator(),
    ]);

    const installCountByAsset = new Map<string, number>();
    for (const installation of installations) {
      const assetId = `listing:${installation.listingId}`;
      installCountByAsset.set(assetId, (installCountByAsset.get(assetId) ?? 0) + 1);
    }

    const supportCountByAsset = new Map<string, number>();
    for (const event of supportEvents) {
      supportCountByAsset.set(event.assetId, (supportCountByAsset.get(event.assetId) ?? 0) + 1);
    }

    const requestFulfillmentCountByCreator = new Map<string, number>();
    for (const entry of acceptedRequests) {
      requestFulfillmentCountByCreator.set(entry.creatorId, entry.count);
    }

    return {
      installCountByAsset,
      supportCountByAsset,
      requestFulfillmentCountByCreator,
    };
  }
}
