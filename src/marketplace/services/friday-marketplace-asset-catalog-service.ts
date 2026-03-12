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
  skillLifecycle: Pick<
    FridaySkillLifecycleService,
    "getSkill" | "listCatalog"
  >;
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
    const [skillAssets, listingAssets] = await Promise.all([
      this.listSkillAssets(),
      this.listListingAssets(),
    ]);
    return [...skillAssets, ...listingAssets].sort((left, right) =>
      left.title.localeCompare(right.title),
    );
  }

  public async getAsset(
    assetId: string,
  ): Promise<FridayMarketplaceAssetDetail | null> {
    if (assetId.startsWith("skill:")) {
      return this.getSkillAsset(assetId.slice("skill:".length));
    }
    if (assetId.startsWith("listing:")) {
      return this.getListingAsset(assetId.slice("listing:".length));
    }
    return null;
  }

  private async listSkillAssets(): Promise<FridayMarketplaceAssetSummary[]> {
    const catalog = await this.deps.skillLifecycle.listCatalog({
      includeStale: true,
      limit: 200,
    });
    return (catalog.items as FridaySkillCatalogViewItem[])
      .map((item) => this.mapSkillSummary(item))
      .filter((item) => item.publicEligible);
  }

  private async listListingAssets(): Promise<FridayMarketplaceAssetSummary[]> {
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
      const summary = this.mapListingSummary(entry, publisher);
      if (summary.publicEligible) {
        assets.push(summary);
      }
    }
    return assets;
  }

  private async getSkillAsset(
    skillId: string,
  ): Promise<FridayMarketplaceAssetDetail | null> {
    const detail = await this.deps.skillLifecycle.getSkill(skillId);
    if (detail === null) {
      return null;
    }
    return this.mapSkillDetail(detail);
  }

  private async getListingAsset(
    listingId: string,
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
    return this.mapListingDetail(entry, publisher);
  }

  private mapSkillSummary(
    item: FridaySkillCatalogViewItem,
  ): FridayMarketplaceAssetSummary {
    const distributionMode = skillDistributionMode(item);
    const publicEligible = distributionMode === "declarative_public";
    return {
      assetId: `skill:${item.skillId}`,
      creatorId: skillCreatorId(item),
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
    };
  }

  private mapSkillDetail(
    detail: FridaySkillLifecycleDetail,
  ): FridayMarketplaceAssetDetail {
    const manifest =
      detail.currentManifest ?? detail.catalogEntry?.manifest ?? null;
    const distributionMode = skillDistributionMode(detail);
    const publicEligible = distributionMode === "declarative_public";
    return {
      assetId: `skill:${detail.skillId}`,
      creatorId: skillCreatorId(detail),
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
      description: detail.description ?? manifest?.description ?? "",
      permissions: skillPermissionsToLabels(detail),
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
  ): FridayMarketplaceAssetSummary {
    const publicEligible =
      entry.version.distributionMode === "declarative_public";
    return {
      assetId: `listing:${entry.listing.id}`,
      creatorId: listingCreatorId(entry),
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
    };
  }

  private mapListingDetail(
    entry: ListingSearchEntry,
    publisher: FridayPublisher | null,
  ): FridayMarketplaceAssetDetail {
    const summary = this.mapListingSummary(entry, publisher);
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
}
