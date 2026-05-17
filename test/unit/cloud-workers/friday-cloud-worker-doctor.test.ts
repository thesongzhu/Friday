import { describe, expect, it } from "vitest";
import {
  createFridayCloudWorkerCatalogService,
  createFridayCloudWorkerDnsValidator,
  createFridayCloudWorkerDoctorService,
} from "#cloud-workers";

function makeDoctor() {
  const catalog = createFridayCloudWorkerCatalogService();
  const dnsValidator = createFridayCloudWorkerDnsValidator();
  return createFridayCloudWorkerDoctorService({
    catalog,
    dnsValidator,
    nowIso: () => "2026-05-17T20:00:00.000Z",
  });
}

const BASE_INPUT = {
  providerId: "tencent-cvm" as const,
  httpsHost: "https://worker.friday-test.example.com",
  dnsName: "worker.friday-test.example.com",
  dnsProviderId: "cloudflare" as const,
  satellitePaired: true,
  liveCertificationConfigured: false,
};

describe("Phase 17A — cloud worker doctor", () => {
  it("returns warn (not ok) because live certification is always blocked_by_env in 17A", () => {
    const report = makeDoctor().runDoctor(BASE_INPUT);
    expect(report.verdict).toBe("warn");
    expect(report.proofTier).toBe("fixture");
    expect(report.blockedReasons).toContain("live_certification_blocked_by_env");
  });

  it("returns blocked when HTTPS is missing", () => {
    const report = makeDoctor().runDoctor({ ...BASE_INPUT, httpsHost: "http://worker.friday-test.example.com" });
    expect(report.verdict).toBe("blocked");
    expect(report.checks.find((c) => c.id === "https_required")!.verdict).toBe("blocked");
  });

  it("returns blocked when DNS scope is root or unsupported", () => {
    const report = makeDoctor().runDoctor({ ...BASE_INPUT, dnsName: "example.com" });
    expect(report.verdict).toBe("blocked");
    expect(report.checks.find((c) => c.id === "dns_scope")!.verdict).toBe("blocked");
  });

  it("warns when satellite has not yet paired (not blocked, since pairing can be done after package generation)", () => {
    const report = makeDoctor().runDoctor({ ...BASE_INPUT, satellitePaired: false });
    expect(report.checks.find((c) => c.id === "satellite_pairing")!.verdict).toBe("warn");
  });

  it("records the abuse-guard structural check (rate limit + redaction + owner pairing + HTTPS env flags)", () => {
    const report = makeDoctor().runDoctor(BASE_INPUT);
    const guard = report.checks.find((c) => c.id === "abuse_guard");
    expect(guard).toBeDefined();
    expect(guard!.message).toMatch(/FRIDAY_RATE_LIMIT_ENABLED/);
    expect(guard!.message).toMatch(/FRIDAY_REDACT_LOG_SECRETS/);
  });

  it("blocks the unknown provider", () => {
    const report = makeDoctor().runDoctor({ ...BASE_INPUT, providerId: "aws-ec2" as never });
    expect(report.verdict).toBe("blocked");
    expect(report.blockedReasons).toContain("unknown_provider");
  });
});
