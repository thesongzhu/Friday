import { describe, expect, it } from "vitest";

import {
  createFridayCloudWorkerSetupRoutes,
  type FridayCloudWorkerSetupRoutesDeps,
} from "#api";
import { createFridayCloudWorkerSetupService } from "#cloud-workers";
import type { FridayHttpContext } from "#api";
import {
  FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID,
  FRIDAY_DEFAULT_PUBLIC_HTTP_TOKEN_ID,
  FRIDAY_DEFAULT_PUBLIC_HTTP_USER_ID,
} from "../../../../../src/api/http/friday-default-public-principal.js";
import { FridayDomainError } from "#errors";

const NOW = "2026-05-17T20:00:00.000Z";
const setupService = createFridayCloudWorkerSetupService({ nowIso: () => NOW });

function makeDeps(): FridayCloudWorkerSetupRoutesDeps {
  return { setupService };
}

function findRoute(operationId: string) {
  const routes = createFridayCloudWorkerSetupRoutes(makeDeps());
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`route not found: ${operationId}`);
  return route;
}

function boundCtx(overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {}): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-1",
    receivedAt: NOW,
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: {
      principalType: "user" as const,
      principalId: "user-real",
      userId: "user-real",
      role: "admin" as const,
      scopes: [],
      tokenId: "tok-real",
      tokenKind: "access" as const,
      issuedAt: NOW,
    },
    ...overrides,
  };
}

function unauthenticatedCtx(overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {}): FridayHttpContext<unknown, unknown, unknown> {
  return boundCtx({
    principal: {
      principalType: "user" as const,
      principalId: FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID,
      userId: FRIDAY_DEFAULT_PUBLIC_HTTP_USER_ID,
      role: "admin" as const,
      scopes: [],
      tokenId: FRIDAY_DEFAULT_PUBLIC_HTTP_TOKEN_ID,
      tokenKind: "access" as const,
      issuedAt: NOW,
    },
    ...overrides,
  });
}

describe("Phase 17A — cloud-worker setup routes", () => {
  it("registers exactly the expected operation ids, methods, paths", () => {
    const routes = createFridayCloudWorkerSetupRoutes(makeDeps());
    expect(routes.map((r) => `${r.method} ${r.operationId} ${r.path}`).sort()).toEqual([
      "GET cloud.workers.catalog.list /v1/cloud-workers/catalog",
      "GET cloud.workers.doctor.run /v1/cloud-workers/doctor",
      "GET cloud.workers.preview.get /v1/cloud-workers/preview/:providerId",
      "POST cloud.workers.dns.validate /v1/cloud-workers/dns/validate",
      "POST cloud.workers.package.generate /v1/cloud-workers/package",
      "POST cloud.workers.teardown.receipt /v1/cloud-workers/teardown-receipt",
    ]);
  });

  it("every route is public (gating happens via bound-principal assertion inside the handler)", () => {
    const routes = createFridayCloudWorkerSetupRoutes(makeDeps());
    for (const route of routes) {
      expect(route.auth.public).toBe(true);
    }
  });

  it("catalog returns blocked_by_env live certification status", async () => {
    const route = findRoute("cloud.workers.catalog.list");
    const result = await route.handler(boundCtx()) as { liveCertificationProofTier: string; providers: Array<{ liveCertification: string }> };
    expect(result.liveCertificationProofTier).toBe("blocked_by_env");
    expect(result.providers.every((p) => p.liveCertification === "blocked_by_env")).toBe(true);
  });

  it("preview 404s on unknown provider", async () => {
    const route = findRoute("cloud.workers.preview.get");
    await expect(route.handler(boundCtx({ params: { providerId: "aws-ec2" } }))).rejects.toBeInstanceOf(FridayDomainError);
  });

  it("doctor returns a structured fixture report", async () => {
    const route = findRoute("cloud.workers.doctor.run");
    const result = await route.handler(boundCtx({
      query: {
        providerId: "aliyun-ecs",
        httpsHost: "https://worker.friday-test.example.com",
        dnsName: "worker.friday-test.example.com",
        dnsProviderId: "dnspod",
        satellitePaired: "true",
        liveCertificationConfigured: "false",
      },
    })) as { proofTier: string; verdict: string; blockedReasons: string[] };
    expect(result.proofTier).toBe("fixture");
    expect(result.verdict).toBe("warn");
    expect(result.blockedReasons).toContain("live_certification_blocked_by_env");
  });

  it("mutating routes reject the synthetic public principal (bound-principal gate)", async () => {
    const dns = findRoute("cloud.workers.dns.validate");
    await expect(dns.handler(unauthenticatedCtx({
      body: { dnsProviderId: "dnspod", dnsName: "worker.friday-test.example.com", rootDomain: "example.com" },
    }))).rejects.toBeInstanceOf(FridayDomainError);

    const pkg = findRoute("cloud.workers.package.generate");
    await expect(pkg.handler(unauthenticatedCtx({
      body: {
        providerId: "aliyun-ecs",
        httpsHost: "https://worker.friday-test.example.com",
        dnsName: "worker.friday-test.example.com",
        dnsProviderId: "dnspod",
        ownerRunId: "owner-run-1",
      },
    }))).rejects.toBeInstanceOf(FridayDomainError);

    const teardown = findRoute("cloud.workers.teardown.receipt");
    await expect(teardown.handler(unauthenticatedCtx({
      body: { providerId: "aliyun-ecs", ownerRunId: "r", resourceTag: "t" },
    }))).rejects.toBeInstanceOf(FridayDomainError);
  });

  it("package POST refuses HTTP-only host (returns VALIDATION_ERROR via wrapped throw)", async () => {
    const route = findRoute("cloud.workers.package.generate");
    await expect(route.handler(boundCtx({
      body: {
        providerId: "aliyun-ecs",
        httpsHost: "http://worker.friday-test.example.com",
        dnsName: "worker.friday-test.example.com",
        dnsProviderId: "dnspod",
        ownerRunId: "owner-run-1",
      },
    }))).rejects.toBeInstanceOf(FridayDomainError);
  });

  it("teardown receipt is fixture proof and blocked_by_env live status", async () => {
    const route = findRoute("cloud.workers.teardown.receipt");
    const result = await route.handler(boundCtx({
      body: { providerId: "volcengine-ecs", ownerRunId: "r", resourceTag: "t", satelliteId: "sat-1" },
    })) as { proofTier: string; liveTeardownStatus: string };
    expect(result.proofTier).toBe("fixture");
    expect(result.liveTeardownStatus).toBe("blocked_by_env");
  });
});
