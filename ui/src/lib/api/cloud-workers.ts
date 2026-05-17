import { apiClient } from "./client";

export interface CloudWorkerProvider {
  providerId: "aliyun-ecs" | "tencent-cvm" | "volcengine-ecs";
  displayName: string;
  region: string;
  machineType: string;
  ttlHours: number;
  costNote: string;
  httpsRequired: true;
  dnsRequired: true;
  livecertCloudEnvironment: string;
  liveCertification: "fixture_only" | "blocked_by_env";
  liveCertificationBlockedReason?: string;
}

export interface CloudWorkerDnsProvider {
  providerId: "dnspod" | "cloudflare";
  displayName: string;
  dedicatedSubdomainPattern: string;
}

export interface CloudWorkerCatalog {
  providers: CloudWorkerProvider[];
  dnsProviders: CloudWorkerDnsProvider[];
  hostedDataPolicy: "user_owned_cloud_only";
  secretsCustodyPolicy: "no_friday_custody";
  liveCertificationProofTier: "blocked_by_env";
  liveCertificationBlockReason: string;
}

export interface CloudWorkerDeploymentPreview {
  providerId: CloudWorkerProvider["providerId"];
  displayName: string;
  region: string;
  machineType: string;
  httpsRequirement: string;
  dnsRequirement: string;
  secretsRequirement: string;
  internalRuntimeSecretsNote: string;
  setupPasswordNote: string;
  gatewayTokenNote: string;
  pairingFlow: string;
  teardownNote: string;
  estimatedTtlHours: number;
  costNote: string;
}

export interface CloudWorkerDnsValidationResult {
  valid: boolean;
  dnsProviderId: string;
  dnsName: string;
  rootDomain: string;
  normalizedDnsName: string;
  normalizedRootDomain: string;
  dedicatedSubdomainPattern: string;
  rejectionReason?: string;
  reasonMessage: string;
}

export interface CloudWorkerPackageBundle {
  providerId: CloudWorkerProvider["providerId"];
  bundleId: string;
  httpsHost: string;
  dnsName: string;
  dnsProviderId: CloudWorkerDnsProvider["providerId"];
  ownerRunId: string;
  files: Array<{
    filename: string;
    contentType: string;
    description: string;
    body: string;
  }>;
  placeholders: string[];
  leakageScanStatus: "no_secrets_emitted";
  pairingFlow: string;
  internalRuntimeSecretsNote: string;
  proofTier: "fixture";
}

export interface CloudWorkerDoctorReport {
  providerId: CloudWorkerProvider["providerId"];
  verdict: "ok" | "warn" | "blocked";
  checks: Array<{
    id: string;
    label: string;
    verdict: "ok" | "warn" | "blocked";
    message: string;
  }>;
  proofTier: "fixture" | "blocked_by_env";
  blockedReasons: string[];
  generatedAt: string;
}

export interface CloudWorkerTeardownReceipt {
  providerId: CloudWorkerProvider["providerId"];
  receiptId: string;
  ownerRunId: string;
  resourceTag: string;
  satelliteId: string | null;
  proofTier: "fixture";
  liveTeardownStatus: "blocked_by_env";
  orphanCheckSteps: string[];
  manualCleanupSteps: string[];
  receiptIssuedAt: string;
}

export const cloudWorkersApi = {
  async getCatalog(): Promise<CloudWorkerCatalog> {
    return apiClient.get<CloudWorkerCatalog>("/v1/cloud-workers/catalog");
  },

  async getPreview(providerId: CloudWorkerProvider["providerId"]): Promise<CloudWorkerDeploymentPreview> {
    return apiClient.get<CloudWorkerDeploymentPreview>(
      `/v1/cloud-workers/preview/${encodeURIComponent(providerId)}`,
    );
  },

  async runDoctor(input: {
    providerId: CloudWorkerProvider["providerId"];
    httpsHost: string;
    dnsName: string;
    dnsProviderId: CloudWorkerDnsProvider["providerId"];
    satellitePaired: boolean;
    liveCertificationConfigured: boolean;
  }): Promise<CloudWorkerDoctorReport> {
    const params = new URLSearchParams();
    params.set("providerId", input.providerId);
    params.set("httpsHost", input.httpsHost);
    params.set("dnsName", input.dnsName);
    params.set("dnsProviderId", input.dnsProviderId);
    params.set("satellitePaired", String(input.satellitePaired));
    params.set("liveCertificationConfigured", String(input.liveCertificationConfigured));
    return apiClient.get<CloudWorkerDoctorReport>(
      `/v1/cloud-workers/doctor?${params.toString()}`,
    );
  },

  async validateDns(input: {
    dnsProviderId: string;
    dnsName: string;
    rootDomain: string;
  }): Promise<CloudWorkerDnsValidationResult> {
    return apiClient.post<typeof input, CloudWorkerDnsValidationResult>(
      "/v1/cloud-workers/dns/validate",
      input,
    );
  },

  async generatePackage(input: {
    providerId: CloudWorkerProvider["providerId"];
    httpsHost: string;
    dnsName: string;
    dnsProviderId: CloudWorkerDnsProvider["providerId"];
    ownerRunId: string;
  }): Promise<CloudWorkerPackageBundle> {
    return apiClient.post<typeof input, CloudWorkerPackageBundle>(
      "/v1/cloud-workers/package",
      input,
    );
  },

  async issueTeardownReceipt(input: {
    providerId: CloudWorkerProvider["providerId"];
    ownerRunId: string;
    resourceTag: string;
    satelliteId?: string;
  }): Promise<CloudWorkerTeardownReceipt> {
    return apiClient.post<typeof input, CloudWorkerTeardownReceipt>(
      "/v1/cloud-workers/teardown-receipt",
      input,
    );
  },
};
