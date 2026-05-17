import { describe, expect, it } from "vitest";
import { createFridayCloudWorkerDnsValidator } from "#cloud-workers";

describe("Phase 17A — cloud worker DNS scope validator", () => {
  const validator = createFridayCloudWorkerDnsValidator();

  it("accepts a dedicated subdomain under friday-test.<root>", () => {
    const result = validator.validate({
      dnsProviderId: "dnspod",
      dnsName: "worker.friday-test.example.com",
      rootDomain: "example.com",
    });
    expect(result.valid).toBe(true);
    expect(result.rejectionReason).toBeUndefined();
  });

  it("accepts cloudflare dedicated subdomains", () => {
    const result = validator.validate({
      dnsProviderId: "cloudflare",
      dnsName: "worker-1.friday-test.example.org",
      rootDomain: "example.org",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects the root domain itself", () => {
    const result = validator.validate({
      dnsProviderId: "dnspod",
      dnsName: "example.com",
      rootDomain: "example.com",
    });
    expect(result.valid).toBe(false);
    expect(result.rejectionReason).toBe("root_domain_rejected");
  });

  it("rejects wildcard DNS scope", () => {
    const result = validator.validate({
      dnsProviderId: "cloudflare",
      dnsName: "*.friday-test.example.com",
      rootDomain: "example.com",
    });
    expect(result.valid).toBe(false);
    expect(result.rejectionReason).toBe("wildcard_rejected");
  });

  it("rejects a subdomain that does not sit under friday-test.<root>", () => {
    const result = validator.validate({
      dnsProviderId: "dnspod",
      dnsName: "worker.example.com",
      rootDomain: "example.com",
    });
    expect(result.valid).toBe(false);
    expect(result.rejectionReason).toBe("missing_dedicated_subdomain_prefix");
  });

  it("rejects a name whose root_domain mismatches the supplied root", () => {
    const result = validator.validate({
      dnsProviderId: "dnspod",
      dnsName: "worker.friday-test.example.com",
      rootDomain: "other-root.com",
    });
    expect(result.valid).toBe(false);
    expect(result.rejectionReason).toBe("dns_name_outside_root_domain");
  });

  it("rejects unsupported DNS providers (no Route53, no Aliyun DNS)", () => {
    const result = validator.validate({
      dnsProviderId: "route53",
      dnsName: "worker.friday-test.example.com",
      rootDomain: "example.com",
    });
    expect(result.valid).toBe(false);
    expect(result.rejectionReason).toBe("unsupported_dns_provider");
  });

  it("rejects invalid DNS label syntax", () => {
    const result = validator.validate({
      dnsProviderId: "dnspod",
      dnsName: "bad label.friday-test.example.com",
      rootDomain: "example.com",
    });
    expect(result.valid).toBe(false);
    expect(result.rejectionReason).toBe("invalid_dns_name");
  });
});
