import { apiClient } from "./client";

export type FridayPluginKind = "channel" | "provider" | "skill" | "storage" | "integration";
export type FridayPluginSource = "bundled" | "local";
export type FridayPluginCompatibilityStatus =
  | "unknown"
  | "compatible"
  | "adaptation_required"
  | "blocked";
export type FridayPluginPromotionChannel =
  | "none"
  | "shadow"
  | "canary"
  | "active"
  | "rolled_back";
export type FridayPluginStatus =
  | "not_installed"
  | "installed"
  | "configured"
  | "enabled"
  | "running"
  | "disabled"
  | "error"
  | "uninstalled";
export type FridayPluginTrustMode = "signed" | "trust_on_install";

interface FridayPluginSdkPreviewManifest {
  sdkVersion: string;
  capabilities: string[];
  publisherId?: string;
}

interface FridayPluginCapabilitySummary {
  previewEnabled: boolean;
  sdkVersion: string | null;
  requestedCapabilities: string[];
  supportedCapabilities: string[];
  unsupportedCapabilities: string[];
}

interface FridayPluginPolicySummary {
  publisherProgram: "first_party" | "allowlisted_partner" | "untrusted";
  installAllowed: boolean;
  enableAllowed: boolean;
  reasons: string[];
}

interface FridayPluginCanaryStats {
  sampleSize: number;
  successCount: number;
  failureCount: number;
  rollbackCount: number;
  lastEvaluatedAt?: string;
}

interface FridayPluginPermissionGrant {
  id: string;
  resource: string;
  action: string;
  required: boolean;
  reason: string;
}

interface FridayPluginManifest {
  schemaVersion: "1.0";
  id: string;
  version: string;
  name: string;
  description: string;
  kinds: FridayPluginKind[];
  permissions: {
    grants: FridayPluginPermissionGrant[];
    promptOn: string[];
  };
  requiredCapabilities?: string[];
  previewSdk?: FridayPluginSdkPreviewManifest;
}

export interface FridayPluginEntity {
  id: string;
  name: string;
  description: string;
  version: string;
  source: FridayPluginSource;
  status: FridayPluginStatus;
  enabled: boolean;
  trustMode: FridayPluginTrustMode;
  installPath: string;
  kinds: FridayPluginKind[];
  manifest: FridayPluginManifest;
  signatureVerified: boolean;
  installedAt: string;
  updatedAt: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  compatibilityStatus?: FridayPluginCompatibilityStatus;
  promotionChannel?: FridayPluginPromotionChannel;
  shadowVersionId?: string | null;
  canaryStats?: FridayPluginCanaryStats;
  capabilitySummary?: FridayPluginCapabilitySummary;
  policySummary?: FridayPluginPolicySummary;
}

export interface FridayPluginLifecycleEvidence {
  pluginId?: string;
  shadowVersionId?: string;
  stage?: string;
  lastEventAt?: string;
  canarySuccessCount?: number;
  canaryFailureCount?: number;
  rollbackPointerAvailable?: boolean;
  pluginArtifactDigest?: string;
  parentLifecycleTicketId?: string;
  planDigest?: string;
}

interface FridayListPluginsResponse {
  items: FridayPluginEntity[];
}

interface FridayInstallPluginResponse {
  plugin: FridayPluginEntity;
}

interface FridayGetPluginResponse {
  plugin: FridayPluginEntity;
}

interface FridayEnablePluginResponse {
  plugin: FridayPluginEntity;
}

interface FridayReviewEnablePluginResponse {
  plugin: FridayPluginEntity;
  evidence?: FridayPluginLifecycleEvidence;
}

interface FridayDisablePluginResponse {
  plugin: FridayPluginEntity;
}

interface FridayUninstallPluginResponse {
  uninstalled: true;
}

export const pluginsApi = {
  async listPlugins(input: {
    source?: FridayPluginSource;
    status?: FridayPluginStatus;
    kind?: FridayPluginKind;
    enabled?: boolean;
  } = {}): Promise<FridayPluginEntity[]> {
    const params = new URLSearchParams();
    if (input.source) params.set("source", input.source);
    if (input.status) params.set("status", input.status);
    if (input.kind) params.set("kind", input.kind);
    if (typeof input.enabled === "boolean") params.set("enabled", String(input.enabled));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const data = await apiClient.get<FridayListPluginsResponse>(`/v1/plugins${suffix}`);
    return data.items;
  },

  async installLocal(input: {
    pluginId: string;
    installPath: string;
    userApproved?: boolean;
  }): Promise<FridayPluginEntity> {
    const data = await apiClient.post<
      { installPath: string; userApproved?: boolean },
      FridayInstallPluginResponse
    >(`/v1/plugins/${encodeURIComponent(input.pluginId)}/install`, {
      installPath: input.installPath,
      userApproved: input.userApproved,
    });
    return data.plugin;
  },

  async enable(pluginId: string): Promise<FridayPluginEntity> {
    const data = await apiClient.post<Record<string, never>, FridayEnablePluginResponse>(
      `/v1/plugins/${encodeURIComponent(pluginId)}/enable`,
      {},
    );
    return data.plugin;
  },

  async reviewEnable(pluginId: string): Promise<FridayReviewEnablePluginResponse> {
    return apiClient.post<Record<string, never>, FridayReviewEnablePluginResponse>(
      `/v1/autonomy/plugins/${encodeURIComponent(pluginId)}/review-enable`,
      {},
    );
  },

  async disable(pluginId: string): Promise<FridayPluginEntity> {
    const data = await apiClient.post<Record<string, never>, FridayDisablePluginResponse>(
      `/v1/plugins/${encodeURIComponent(pluginId)}/disable`,
      {},
    );
    return data.plugin;
  },

  async uninstall(pluginId: string, input: { force?: boolean } = {}): Promise<FridayUninstallPluginResponse> {
    const suffix = input.force ? "?force=true" : "";
    return apiClient.del<FridayUninstallPluginResponse>(`/v1/plugins/${encodeURIComponent(pluginId)}${suffix}`);
  },

};
