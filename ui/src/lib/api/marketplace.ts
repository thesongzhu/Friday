import { apiClient } from "./client";

export type FridayMarketplaceAssetKind = "skill" | "workflow" | "agent";
export type FridayMarketplaceDistributionMode = "declarative_public" | "legacy_executable";
export type FridayMarketplaceAssetMaturity =
  | "validated_and_keep"
  | "validated_but_temporary"
  | "deferred";
export type FridayMarketplaceVerificationStatus = "verified" | "unverified" | "unknown";

export interface FridayMarketplaceAssetSummary {
  assetId: string;
  creatorId: string;
  assetType: FridayMarketplaceAssetKind;
  sourceKind: "skills_lifecycle" | "marketplace_listing";
  distributionMode: FridayMarketplaceDistributionMode;
  publicEligible: boolean;
  title: string;
  slug: string;
  summary: string;
  publisherName: string;
  installable: boolean;
  installed: boolean;
  enabled: boolean;
  verificationStatus: FridayMarketplaceVerificationStatus;
  trustScore: number | null;
  latestVersion: string | null;
  maturity: FridayMarketplaceAssetMaturity;
}

export interface FridayMarketplaceAssetDetail extends FridayMarketplaceAssetSummary {
  description: string;
  permissions: string[];
  sourceLabel: string;
  provenance:
    | { kind: "skill"; skillId: string }
    | { kind: "listing"; listingId: string; versionId: string };
}

export interface FridayCreatorReputationSummary {
  overallScore: number;
  ratingAverage: number | null;
  ratingCount: number;
  supportCount: number;
  supportTotal: {
    amount: number;
    currency: string;
  };
  installCount: number;
  verifiedAssetCount: number;
  verificationSuccessRate: number | null;
  permissionRestraintScore: number;
  fulfilledRequestCount: number;
}

export interface FridayCreatorProfile {
  id: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  websiteUrl: string | null;
  assetIds: string[];
  reputation: FridayCreatorReputationSummary;
  verifiedPublisher: boolean;
}

export type FridayMarketplaceRequestPrivacyMode = "public" | "private";
export type FridayMarketplaceRequestPublishability = "private_only" | "allow_publication";
export type FridayMarketplaceRequestStatus =
  | "open"
  | "in_discussion"
  | "submitted"
  | "accepted"
  | "closed";

export interface FridayMarketplaceRequestPost {
  id: string;
  assetKind: FridayMarketplaceAssetKind;
  requesterTenantId: string;
  requesterPrincipalId: string;
  title: string;
  goal: string;
  desiredOutcome: string;
  constraints: string[];
  budgetSupportIntent: string | null;
  privacy: FridayMarketplaceRequestPrivacyMode;
  publishability: FridayMarketplaceRequestPublishability;
  riskNotes: string | null;
  status: FridayMarketplaceRequestStatus;
  acceptedResponseId: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface FridayMarketplaceRequestResponse {
  id: string;
  requestId: string;
  responderTenantId: string;
  responderPrincipalId: string;
  responderCreatorId: string | null;
  message: string;
  proposal: string | null;
  deliverableAssetId: string | null;
  createdAt: string;
}

export interface FridayMarketplaceRequestBundle {
  request: FridayMarketplaceRequestPost;
  responses: FridayMarketplaceRequestResponse[];
}

interface FridayMarketplaceAssetListResponse {
  items: FridayMarketplaceAssetSummary[];
}

interface FridayMarketplaceCreatorListResponse {
  items: FridayCreatorProfile[];
}

interface FridayMarketplaceRequestListResponse {
  items: FridayMarketplaceRequestPost[];
}

interface FridayMarketplaceSupportInput {
  amount: {
    amount: number;
    currency: string;
  };
  message?: string | null;
}

interface FridayMarketplaceRequestCreateInput {
  assetKind: FridayMarketplaceAssetKind;
  title: string;
  goal: string;
  desiredOutcome: string;
  constraints?: string[];
  budgetSupportIntent?: string | null;
  privacy: FridayMarketplaceRequestPrivacyMode;
  publishability: FridayMarketplaceRequestPublishability;
  riskNotes?: string | null;
}

interface FridayMarketplaceRequestResponseCreateInput {
  message: string;
  proposal?: string | null;
  deliverableAssetId?: string | null;
}

export const marketplaceApi = {
  async listAssets(): Promise<FridayMarketplaceAssetSummary[]> {
    const data = await apiClient.get<FridayMarketplaceAssetListResponse>("/v1/marketplace/assets");
    return data.items;
  },

  async getAsset(assetId: string): Promise<FridayMarketplaceAssetDetail> {
    return apiClient.get<FridayMarketplaceAssetDetail>(
      `/v1/marketplace/assets/${encodeURIComponent(assetId)}`,
    );
  },

  async listCreators(): Promise<FridayCreatorProfile[]> {
    const data = await apiClient.get<FridayMarketplaceCreatorListResponse>("/v1/marketplace/creators");
    return data.items;
  },

  async getCreator(creatorId: string): Promise<FridayCreatorProfile> {
    return apiClient.get<FridayCreatorProfile>(
      `/v1/marketplace/creators/${encodeURIComponent(creatorId)}`,
    );
  },

  async supportAsset(assetId: string, input: FridayMarketplaceSupportInput): Promise<unknown> {
    return apiClient.post<FridayMarketplaceSupportInput, unknown>(
      `/v1/marketplace/assets/${encodeURIComponent(assetId)}/support`,
      input,
    );
  },

  async listRequests(input: {
    assetKind?: FridayMarketplaceAssetKind;
    status?: FridayMarketplaceRequestStatus;
    privacy?: FridayMarketplaceRequestPrivacyMode;
  } = {}): Promise<FridayMarketplaceRequestPost[]> {
    const params = new URLSearchParams();
    if (input.assetKind) params.set("assetKind", input.assetKind);
    if (input.status) params.set("status", input.status);
    if (input.privacy) params.set("privacy", input.privacy);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const data = await apiClient.get<FridayMarketplaceRequestListResponse>(
      `/v1/marketplace/requests${suffix}`,
    );
    return data.items;
  },

  async createRequest(input: FridayMarketplaceRequestCreateInput): Promise<FridayMarketplaceRequestBundle> {
    return apiClient.post<FridayMarketplaceRequestCreateInput, FridayMarketplaceRequestBundle>(
      "/v1/marketplace/requests",
      input,
    );
  },

  async getRequest(requestId: string): Promise<FridayMarketplaceRequestBundle> {
    return apiClient.get<FridayMarketplaceRequestBundle>(
      `/v1/marketplace/requests/${encodeURIComponent(requestId)}`,
    );
  },

  async createRequestResponse(
    requestId: string,
    input: FridayMarketplaceRequestResponseCreateInput,
  ): Promise<FridayMarketplaceRequestBundle> {
    return apiClient.post<FridayMarketplaceRequestResponseCreateInput, FridayMarketplaceRequestBundle>(
      `/v1/marketplace/requests/${encodeURIComponent(requestId)}/responses`,
      input,
    );
  },

  async acceptRequestResponse(
    requestId: string,
    responseId: string,
  ): Promise<FridayMarketplaceRequestBundle> {
    return apiClient.post<{ responseId: string }, FridayMarketplaceRequestBundle>(
      `/v1/marketplace/requests/${encodeURIComponent(requestId)}/accept`,
      { responseId },
    );
  },

  async closeRequest(requestId: string): Promise<FridayMarketplaceRequestBundle> {
    return apiClient.post<Record<string, never>, FridayMarketplaceRequestBundle>(
      `/v1/marketplace/requests/${encodeURIComponent(requestId)}/close`,
      {},
    );
  },
};
