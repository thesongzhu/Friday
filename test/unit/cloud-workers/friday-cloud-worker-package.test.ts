import { describe, expect, it } from "vitest";
import {
  createFridayCloudWorkerCatalogService,
  createFridayCloudWorkerDnsValidator,
  createFridayCloudWorkerPackageService,
} from "#cloud-workers";

function makeService() {
  const catalog = createFridayCloudWorkerCatalogService();
  const dnsValidator = createFridayCloudWorkerDnsValidator();
  return createFridayCloudWorkerPackageService({ catalog, dnsValidator });
}

const VALID_INPUT = {
  providerId: "aliyun-ecs" as const,
  httpsHost: "https://worker.friday-test.example.com",
  dnsName: "worker.friday-test.example.com",
  dnsProviderId: "dnspod" as const,
  ownerRunId: "owner-run-2026-05-17",
};

describe("Phase 17A — cloud worker package generator", () => {
  it("generates a Dockerfile, compose, env, bootstrap, README — all auditable", () => {
    const bundle = makeService().generate(VALID_INPUT);
    const filenames = bundle.files.map((f) => f.filename).sort();
    expect(filenames).toEqual([
      "Dockerfile",
      "README.md",
      "bootstrap.env",
      "bootstrap.sh",
      "docker-compose.yml",
    ]);
    expect(bundle.proofTier).toBe("fixture");
    expect(bundle.leakageScanStatus).toBe("no_secrets_emitted");
  });

  it("uses placeholders for SETUP_PASSWORD, GATEWAY_TOKEN, MASTER_KEY, TOKEN_SECRET — never real values", () => {
    const bundle = makeService().generate(VALID_INPUT);
    const blob = bundle.files.map((f) => f.body).join("\n");
    for (const placeholder of bundle.placeholders) {
      expect(blob).toContain(placeholder);
    }
    expect(blob).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    expect(blob).not.toMatch(/LTAI[A-Za-z0-9]{16,}/);
    expect(blob).not.toMatch(/AKID[A-Za-z0-9]{16,}/);
  });

  it("docker-compose pins HTTPS, owner pairing, rate limit, redaction", () => {
    const bundle = makeService().generate(VALID_INPUT);
    const compose = bundle.files.find((f) => f.filename === "docker-compose.yml")!.body;
    expect(compose).toContain("FRIDAY_REQUIRE_HTTPS=true");
    expect(compose).toContain("FRIDAY_REQUIRE_OWNER_PAIRING=true");
    expect(compose).toContain("FRIDAY_RATE_LIMIT_ENABLED=true");
    expect(compose).toContain("FRIDAY_REDACT_LOG_SECRETS=true");
  });

  it("README explains the no-hosted-data and no-secret-custody safety boundary", () => {
    const bundle = makeService().generate(VALID_INPUT);
    const readme = bundle.files.find((f) => f.filename === "README.md")!.body;
    expect(readme).toMatch(/does not store your data/);
    expect(readme).toMatch(/HTTPS is required/);
    expect(readme).toMatch(/blocked_by_env/);
    expect(readme).toMatch(/cloud-vm` satellite/);
  });

  it("README renders the already-normalized HTTPS host exactly once and never doubles the scheme", () => {
    const bundle = makeService().generate(VALID_INPUT);
    const readme = bundle.files.find((f) => f.filename === "README.md")!.body;
    expect(readme).toContain("https://worker.friday-test.example.com");
    expect(readme).not.toContain("https://https://");
  });

  it("rejects HTTP-only host", () => {
    expect(() => makeService().generate({ ...VALID_INPUT, httpsHost: "http://worker.friday-test.example.com" })).toThrow(/https/i);
  });

  it("rejects unknown providers", () => {
    expect(() =>
      makeService().generate({ ...VALID_INPUT, providerId: "aws-ec2" as never }),
    ).toThrow(/provider/i);
  });

  it("rejects root-domain DNS scope via the integrated validator", () => {
    expect(() =>
      makeService().generate({
        ...VALID_INPUT,
        dnsName: "example.com",
      }),
    ).toThrow(/DNS scope rejected/);
  });

  it("emits a deterministic bundleId for the same input", () => {
    const a = makeService().generate(VALID_INPUT);
    const b = makeService().generate(VALID_INPUT);
    expect(a.bundleId).toBe(b.bundleId);
    expect(a.bundleId).toHaveLength(16);
  });
});
