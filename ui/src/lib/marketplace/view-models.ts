import type {
  FridayCreatorProfile,
  FridayMarketplaceAssetKind,
  FridayMarketplaceAssetSummary,
  FridayMarketplaceRequestPost,
} from "@/lib/api/marketplace";

export type FridayMarketplaceAssistantCard = {
  assetId: string;
  title: string;
  assetType: FridayMarketplaceAssetSummary["assetType"];
  publisherName: string;
  summary: string;
  installable: boolean;
  supportable: boolean;
  trustScore?: number;
  maturity: FridayMarketplaceAssetSummary["maturity"];
};

export function buildMarketplaceAssistantCards(
  assets: FridayMarketplaceAssetSummary[],
): FridayMarketplaceAssistantCard[] {
  return assets
    .filter((asset) => asset.publicEligible)
    .sort((left, right) => {
      const installFirst = Number(right.installable) - Number(left.installable);
      if (installFirst !== 0) return installFirst;
      return (right.trustScore ?? 0) - (left.trustScore ?? 0);
    })
    .slice(0, 3)
    .map((asset) => ({
      assetId: asset.assetId,
      title: asset.title,
      assetType: asset.assetType,
      publisherName: asset.publisherName,
      summary: asset.summary ?? "No summary yet.",
      installable: asset.installable && asset.assetType === "skill",
      supportable: true,
      trustScore: asset.trustScore ?? undefined,
      maturity: asset.maturity,
    }));
}

export function summarizeMarketplaceRequestState(
  requests: FridayMarketplaceRequestPost[],
): { openCount: number; acceptedCount: number } {
  return requests.reduce(
    (summary, request) => {
      if (request.status === "accepted") {
        summary.acceptedCount += 1;
      }
      if (request.status !== "closed") {
        summary.openCount += 1;
      }
      return summary;
    },
    { openCount: 0, acceptedCount: 0 },
  );
}

export function summarizeCreatorSupport(
  creators: FridayCreatorProfile[],
): { creatorCount: number; verifiedCount: number } {
  return creators.reduce(
    (summary, creator) => {
      summary.creatorCount += 1;
      if (creator.verifiedPublisher) {
        summary.verifiedCount += 1;
      }
      return summary;
    },
    { creatorCount: 0, verifiedCount: 0 },
  );
}

export function buildMarketplaceHref(input?: {
  assetId?: string;
  requestKind?: FridayMarketplaceAssetKind;
  goal?: string;
}): string {
  const params = new URLSearchParams();
  if (input?.assetId) {
    params.set("asset", input.assetId);
  }
  if (input?.requestKind) {
    params.set("requestKind", input.requestKind);
  }
  if (input?.goal) {
    params.set("goal", input.goal);
  }

  const query = params.toString();
  return query.length > 0 ? `/marketplace?${query}` : "/marketplace";
}
