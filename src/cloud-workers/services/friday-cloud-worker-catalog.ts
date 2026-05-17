import type {
  FridayCloudWorkerCatalog,
  FridayCloudWorkerDeploymentPreview,
  FridayCloudWorkerDnsProvider,
  FridayCloudWorkerProvider,
  FridayCloudWorkerProviderId,
} from "../model/friday-cloud-worker.types.js";

const LIVE_CERT_BLOCK_REASON =
  "Live cloud certification requires protected GitHub Environment Secrets (cloud-live-aliyun, cloud-live-tencent, cloud-live-volcengine), dedicated DNS tokens, TTL/budget controls, and manual workflow_dispatch approval. Until configured, 17B remains blocked_by_env; ordinary PRs and ordinary user setup must not read protected cloud secrets.";

const PROVIDERS: ReadonlyArray<FridayCloudWorkerProvider> = [
  {
    providerId: "aliyun-ecs",
    displayName: "Alibaba Cloud ECS",
    region: "cn-hangzhou",
    machineType: "ecs.t6-c1m2.large",
    ttlHours: 6,
    costNote: "Pay-as-you-go; TTL/budget enforced by protected workflow only.",
    httpsRequired: true,
    dnsRequired: true,
    livecertCloudEnvironment: "cloud-live-aliyun",
    liveCertification: "blocked_by_env",
    liveCertificationBlockedReason: LIVE_CERT_BLOCK_REASON,
  },
  {
    providerId: "tencent-cvm",
    displayName: "Tencent Cloud CVM",
    region: "ap-shanghai",
    machineType: "S5.MEDIUM4",
    ttlHours: 6,
    costNote: "Pay-as-you-go; TTL/budget enforced by protected workflow only.",
    httpsRequired: true,
    dnsRequired: true,
    livecertCloudEnvironment: "cloud-live-tencent",
    liveCertification: "blocked_by_env",
    liveCertificationBlockedReason: LIVE_CERT_BLOCK_REASON,
  },
  {
    providerId: "volcengine-ecs",
    displayName: "Volcengine ECS",
    region: "cn-beijing",
    machineType: "ecs.g3i.large",
    ttlHours: 6,
    costNote: "Pay-as-you-go; TTL/budget enforced by protected workflow only.",
    httpsRequired: true,
    dnsRequired: true,
    livecertCloudEnvironment: "cloud-live-volcengine",
    liveCertification: "blocked_by_env",
    liveCertificationBlockedReason: LIVE_CERT_BLOCK_REASON,
  },
];

const DNS_PROVIDERS: ReadonlyArray<FridayCloudWorkerDnsProvider> = [
  {
    providerId: "dnspod",
    displayName: "DNSPod",
    dedicatedSubdomainPattern: "*.friday-test.<your-domain>",
  },
  {
    providerId: "cloudflare",
    displayName: "Cloudflare",
    dedicatedSubdomainPattern: "*.friday-test.<your-domain>",
  },
];

export function createFridayCloudWorkerCatalogService() {
  return {
    listCatalog(): FridayCloudWorkerCatalog {
      return {
        providers: PROVIDERS,
        dnsProviders: DNS_PROVIDERS,
        hostedDataPolicy: "user_owned_cloud_only",
        secretsCustodyPolicy: "no_friday_custody",
        liveCertificationProofTier: "blocked_by_env",
        liveCertificationBlockReason: LIVE_CERT_BLOCK_REASON,
      };
    },

    getProvider(providerId: string): FridayCloudWorkerProvider | null {
      return PROVIDERS.find((p) => p.providerId === providerId) ?? null;
    },

    getDeploymentPreview(providerId: string): FridayCloudWorkerDeploymentPreview | null {
      const provider = PROVIDERS.find((p) => p.providerId === providerId);
      if (!provider) return null;
      return {
        providerId: provider.providerId,
        displayName: provider.displayName,
        region: provider.region,
        machineType: provider.machineType,
        httpsRequirement:
          "HTTPS is required. HTTP-only worker setup is not acceptable as Friday proof.",
        dnsRequirement:
          "Use a dedicated subdomain such as worker.friday-test.<your-domain>. Root domains and wildcard DNS automation are rejected.",
        secretsRequirement:
          "All cloud AK/SK and DNS tokens live in your cloud account or protected CI; Friday official infrastructure does not store them and ordinary PRs cannot read them.",
        internalRuntimeSecretsNote:
          "FRIDAY_MASTER_KEY and FRIDAY_TOKEN_SECRET are internal runtime secrets. The generated package will create them locally during first boot; you do not need to paste them.",
        setupPasswordNote:
          "A one-time setup password is generated locally on the cloud worker during first boot and is only stored as a SHA-256 hash. The password is never sent back to Friday and never persisted in your local hub.",
        gatewayTokenNote:
          "After setup, pair the cloud worker with this hub via the existing satellite pairing approve flow. The gateway access token is issued by Friday's existing satellite pairing service and stored only as a token hash.",
        pairingFlow:
          "satellite registration -> hub approves pairing -> handshake -> cloud-vm satellite is online; reuse existing /v1/satellites/* primitives.",
        teardownNote:
          "Teardown receipt is generated locally as fixture for 17A. Real cloud teardown is blocked_by_env until 17B protected workflow approves it.",
        estimatedTtlHours: provider.ttlHours,
        costNote: provider.costNote,
      };
    },

    listProviders(): ReadonlyArray<FridayCloudWorkerProvider> {
      return PROVIDERS;
    },

    listDnsProviders(): ReadonlyArray<FridayCloudWorkerDnsProvider> {
      return DNS_PROVIDERS;
    },
  };
}

export type FridayCloudWorkerCatalogService = ReturnType<
  typeof createFridayCloudWorkerCatalogService
>;

export function isFridayCloudWorkerProviderId(
  value: unknown,
): value is FridayCloudWorkerProviderId {
  return (
    value === "aliyun-ecs" ||
    value === "tencent-cvm" ||
    value === "volcengine-ecs"
  );
}
