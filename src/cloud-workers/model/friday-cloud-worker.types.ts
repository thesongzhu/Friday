/**
 * Phase 17A — User-owned cloud worker setup UX.
 *
 * Friday productizes user-owned cloud workers, not Friday-hosted user data.
 * Cloud providers below are IaaS deployment targets; they are NOT AI provider
 * recommendations. Live certification (17B) for these targets is blocked_by_env
 * until protected GitHub Environment Secrets plus dedicated DNS are configured.
 */

export type FridayCloudWorkerProviderId =
  | "aliyun-ecs"
  | "tencent-cvm"
  | "volcengine-ecs";

export type FridayCloudWorkerDnsProviderId = "dnspod" | "cloudflare";

export type FridayCloudWorkerCertificationStatus =
  | "fixture_only"
  | "blocked_by_env";

export type FridayCloudWorkerProofTier =
  | "fixture"
  | "blocked_by_env";

export interface FridayCloudWorkerProvider {
  readonly providerId: FridayCloudWorkerProviderId;
  readonly displayName: string;
  readonly region: string;
  readonly machineType: string;
  readonly ttlHours: number;
  readonly costNote: string;
  readonly httpsRequired: true;
  readonly dnsRequired: true;
  readonly livecertCloudEnvironment: string;
  readonly liveCertification: FridayCloudWorkerCertificationStatus;
  readonly liveCertificationBlockedReason?: string;
}

export interface FridayCloudWorkerDnsProvider {
  readonly providerId: FridayCloudWorkerDnsProviderId;
  readonly displayName: string;
  readonly dedicatedSubdomainPattern: string;
}

export interface FridayCloudWorkerCatalog {
  readonly providers: ReadonlyArray<FridayCloudWorkerProvider>;
  readonly dnsProviders: ReadonlyArray<FridayCloudWorkerDnsProvider>;
  readonly hostedDataPolicy: "user_owned_cloud_only";
  readonly secretsCustodyPolicy: "no_friday_custody";
  readonly liveCertificationProofTier: "blocked_by_env";
  readonly liveCertificationBlockReason: string;
}

export interface FridayCloudWorkerDeploymentPreview {
  readonly providerId: FridayCloudWorkerProviderId;
  readonly displayName: string;
  readonly region: string;
  readonly machineType: string;
  readonly httpsRequirement: string;
  readonly dnsRequirement: string;
  readonly secretsRequirement: string;
  readonly internalRuntimeSecretsNote: string;
  readonly setupPasswordNote: string;
  readonly gatewayTokenNote: string;
  readonly pairingFlow: string;
  readonly teardownNote: string;
  readonly estimatedTtlHours: number;
  readonly costNote: string;
}

export interface FridayCloudWorkerDnsValidationInput {
  readonly dnsProviderId: string;
  readonly dnsName: string;
  readonly rootDomain: string;
}

export type FridayCloudWorkerDnsRejectionReason =
  | "unsupported_dns_provider"
  | "root_domain_rejected"
  | "wildcard_rejected"
  | "missing_dedicated_subdomain_prefix"
  | "dns_name_outside_root_domain"
  | "invalid_dns_name";

export interface FridayCloudWorkerDnsValidationResult {
  readonly valid: boolean;
  readonly dnsProviderId: string;
  readonly dnsName: string;
  readonly rootDomain: string;
  readonly normalizedDnsName: string;
  readonly normalizedRootDomain: string;
  readonly dedicatedSubdomainPattern: string;
  readonly rejectionReason?: FridayCloudWorkerDnsRejectionReason;
  readonly reasonMessage: string;
}

export interface FridayCloudWorkerPackageInput {
  readonly providerId: FridayCloudWorkerProviderId;
  readonly httpsHost: string;
  readonly dnsName: string;
  readonly dnsProviderId: FridayCloudWorkerDnsProviderId;
  readonly ownerRunId: string;
}

export interface FridayCloudWorkerPackageFile {
  readonly filename: string;
  readonly contentType: "text/dockerfile" | "text/yaml" | "text/shell" | "text/markdown" | "text/plain";
  readonly description: string;
  readonly body: string;
}

export interface FridayCloudWorkerPackageBundle {
  readonly providerId: FridayCloudWorkerProviderId;
  readonly bundleId: string;
  readonly httpsHost: string;
  readonly dnsName: string;
  readonly dnsProviderId: FridayCloudWorkerDnsProviderId;
  readonly ownerRunId: string;
  readonly files: ReadonlyArray<FridayCloudWorkerPackageFile>;
  readonly placeholders: ReadonlyArray<string>;
  readonly leakageScanStatus: "no_secrets_emitted";
  readonly pairingFlow: string;
  readonly internalRuntimeSecretsNote: string;
  readonly proofTier: "fixture";
}

export type FridayCloudWorkerDoctorVerdict = "ok" | "warn" | "blocked";

export interface FridayCloudWorkerDoctorInput {
  readonly providerId: FridayCloudWorkerProviderId;
  readonly httpsHost: string;
  readonly dnsName: string;
  readonly dnsProviderId: FridayCloudWorkerDnsProviderId;
  readonly satellitePaired: boolean;
  readonly liveCertificationConfigured: boolean;
}

export interface FridayCloudWorkerDoctorCheck {
  readonly id: string;
  readonly label: string;
  readonly verdict: FridayCloudWorkerDoctorVerdict;
  readonly message: string;
}

export interface FridayCloudWorkerDoctorReport {
  readonly providerId: FridayCloudWorkerProviderId;
  readonly verdict: FridayCloudWorkerDoctorVerdict;
  readonly checks: ReadonlyArray<FridayCloudWorkerDoctorCheck>;
  readonly proofTier: FridayCloudWorkerProofTier;
  readonly blockedReasons: ReadonlyArray<string>;
  readonly generatedAt: string;
}

export interface FridayCloudWorkerTeardownReceiptInput {
  readonly providerId: FridayCloudWorkerProviderId;
  readonly ownerRunId: string;
  readonly resourceTag: string;
  readonly satelliteId?: string;
}

export interface FridayCloudWorkerTeardownReceipt {
  readonly providerId: FridayCloudWorkerProviderId;
  readonly receiptId: string;
  readonly ownerRunId: string;
  readonly resourceTag: string;
  readonly satelliteId: string | null;
  readonly proofTier: "fixture";
  readonly liveTeardownStatus: "blocked_by_env";
  readonly orphanCheckSteps: ReadonlyArray<string>;
  readonly manualCleanupSteps: ReadonlyArray<string>;
  readonly receiptIssuedAt: string;
}
