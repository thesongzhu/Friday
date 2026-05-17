import { describe, expect, it } from "vitest";
import {
  createFridayCloudWorkerCatalogService,
  isFridayCloudWorkerProviderId,
} from "#cloud-workers";

describe("Phase 17A — cloud worker catalog", () => {
  const service = createFridayCloudWorkerCatalogService();

  it("lists exactly the three approved user-owned cloud IaaS targets", () => {
    const catalog = service.listCatalog();
    expect(catalog.providers.map((p) => p.providerId)).toEqual([
      "aliyun-ecs",
      "tencent-cvm",
      "volcengine-ecs",
    ]);
  });

  it("flags every provider's live certification as blocked_by_env", () => {
    const catalog = service.listCatalog();
    for (const provider of catalog.providers) {
      expect(provider.liveCertification).toBe("blocked_by_env");
      expect(provider.liveCertificationBlockedReason ?? "").toMatch(/protected GitHub Environment/);
    }
    expect(catalog.liveCertificationProofTier).toBe("blocked_by_env");
  });

  it("declares no Friday-hosted user-data path and no Friday secret custody", () => {
    const catalog = service.listCatalog();
    expect(catalog.hostedDataPolicy).toBe("user_owned_cloud_only");
    expect(catalog.secretsCustodyPolicy).toBe("no_friday_custody");
  });

  it("never mentions AI provider recommendation language", () => {
    const catalog = service.listCatalog();
    const blob = JSON.stringify(catalog).toLowerCase();
    expect(blob).not.toMatch(/china-friendly/);
    expect(blob).not.toMatch(/recommendation entrance/);
    expect(blob).not.toMatch(/openai/);
    expect(blob).not.toMatch(/anthropic/);
  });

  it("only allows DNSPod and Cloudflare dedicated-subdomain DNS providers", () => {
    const catalog = service.listCatalog();
    expect(catalog.dnsProviders.map((p) => p.providerId)).toEqual([
      "dnspod",
      "cloudflare",
    ]);
    for (const dns of catalog.dnsProviders) {
      expect(dns.dedicatedSubdomainPattern).toContain("friday-test.");
    }
  });

  it("returns a deployment preview with HTTPS and DNS requirements", () => {
    const preview = service.getDeploymentPreview("aliyun-ecs");
    expect(preview).not.toBeNull();
    expect(preview!.httpsRequirement).toMatch(/HTTPS is required/);
    expect(preview!.dnsRequirement).toMatch(/dedicated subdomain/i);
    expect(preview!.internalRuntimeSecretsNote).toMatch(/FRIDAY_MASTER_KEY/);
    expect(preview!.internalRuntimeSecretsNote).toMatch(/do not need to paste/);
  });

  it("isFridayCloudWorkerProviderId narrows correctly", () => {
    expect(isFridayCloudWorkerProviderId("aliyun-ecs")).toBe(true);
    expect(isFridayCloudWorkerProviderId("tencent-cvm")).toBe(true);
    expect(isFridayCloudWorkerProviderId("volcengine-ecs")).toBe(true);
    expect(isFridayCloudWorkerProviderId("aws-ec2")).toBe(false);
    expect(isFridayCloudWorkerProviderId(null)).toBe(false);
  });
});
