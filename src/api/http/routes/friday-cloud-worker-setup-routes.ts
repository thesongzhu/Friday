/**
 * Phase 17A — User-owned cloud worker setup UX routes.
 *
 * The routes below productize a user-owned cloud worker setup flow without
 * Friday-hosted user data, without ordinary user secret custody, and without
 * accepting HTTP-only worker proof. Reuses existing cloud-vm satellite
 * pairing and doctor primitives — does not introduce a new principal type.
 *
 * 17B live cloud certification (Alibaba ECS, Tencent CVM, Volcengine ECS)
 * is `blocked_by_env` here; live workflow_dispatch is intentionally out of
 * scope and the catalog surfaces that status directly.
 */

import { FridayDomainError } from "#errors";
import type {
  FridayHttpContext,
  FridayRouteDefinition,
} from "../../model/friday-api-common.types.js";
import { assertBoundPrincipalForOperation } from "../../../security/friday-owner-session-channel-capability.js";
import type {
  FridayCloudWorkerDnsProviderId,
  FridayCloudWorkerPackageInput,
  FridayCloudWorkerProviderId,
  FridayCloudWorkerSetupService,
} from "#cloud-workers";
import { isFridayCloudWorkerProviderId } from "#cloud-workers";

type Ctx = FridayHttpContext<unknown, Record<string, string>, unknown>;
type Route = FridayRouteDefinition<unknown, Record<string, string>, unknown, unknown>;

export interface FridayCloudWorkerSetupRoutesDeps {
  readonly setupService: FridayCloudWorkerSetupService;
  /**
   * Test-oracle only: allow the legacy TypeScript cloud-worker setup compute
   * (DNS acceptance validation, deployment package generation, teardown receipt
   * issuance) in isolated mock/unit validation. Production/runtime callers must
   * leave this unset so these surfaces fail-close until Rust owns the cloud-worker
   * setup engine. The GET catalog/preview/doctor reads are never gated.
   */
  readonly allowTestOnlyCloudWorkerSetupExecution?: boolean;
}

// ─── Retirement helper ───
//
// The cloud-worker setup POST surfaces (DNS validate, package generate, teardown
// receipt) run user-triggerable TS-runtime product logic that produces the
// cloud-worker setup deliverables (acceptance verdicts, deployment bundles,
// teardown receipts). They fail-close by default/live until Rust owns the
// cloud-worker setup entrypoint; legacy behavior is reachable only through the
// explicit allowTestOnlyCloudWorkerSetupExecution test-oracle flag. The GET
// catalog/preview/doctor reads stay compat_shim and are NOT gated.

function assertCloudWorkerSetupTestOracleAllowed(deps: FridayCloudWorkerSetupRoutesDeps): void {
  if (deps.allowTestOnlyCloudWorkerSetupExecution !== true) {
    throw new FridayDomainError(
      "TS_RUNTIME_CLOUD_WORKER_SETUP_RETIRED",
      "TypeScript cloud-worker setup is fail-closed in default/live runtime; use the Rust-owned cloud-worker setup entrypoint.",
      {
        httpStatus: 503,
        details: {
          classification: "fail_closed",
          replacement: "rust_owned_cloud_worker_setup_entrypoint_required",
        },
      },
    );
  }
}

function asString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Expected non-empty string",
      { httpStatus: 400 },
    );
  }
  return value.trim();
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function asDnsProviderId(value: unknown): FridayCloudWorkerDnsProviderId {
  if (value === "dnspod" || value === "cloudflare") return value;
  throw new FridayDomainError(
    "VALIDATION_ERROR",
    "dnsProviderId must be 'dnspod' or 'cloudflare'",
    { httpStatus: 400 },
  );
}

function asProviderId(value: unknown): FridayCloudWorkerProviderId {
  if (isFridayCloudWorkerProviderId(value)) return value;
  throw new FridayDomainError(
    "VALIDATION_ERROR",
    "providerId must be one of aliyun-ecs, tencent-cvm, volcengine-ecs",
    { httpStatus: 400 },
  );
}

export function createFridayCloudWorkerSetupRoutes(
  deps: FridayCloudWorkerSetupRoutesDeps,
): Route[] {
  return [
    {
      operationId: "cloud.workers.catalog.list",
      method: "GET",
      path: "/v1/cloud-workers/catalog",
      auth: { public: true },
      async handler() {
        return deps.setupService.catalog.listCatalog();
      },
    },
    {
      operationId: "cloud.workers.preview.get",
      method: "GET",
      path: "/v1/cloud-workers/preview/:providerId",
      auth: { public: true },
      async handler(ctx: Ctx) {
        const params = ctx.params as Record<string, string>;
        const preview = deps.setupService.catalog.getDeploymentPreview(params.providerId);
        if (!preview) {
          throw new FridayDomainError(
            "NOT_FOUND",
            `No deployment preview for provider '${params.providerId}'`,
            { httpStatus: 404 },
          );
        }
        return preview;
      },
    },
    {
      operationId: "cloud.workers.doctor.run",
      method: "GET",
      path: "/v1/cloud-workers/doctor",
      auth: { public: true },
      async handler(ctx: Ctx) {
        const query = ctx.query as Record<string, string | undefined>;
        const providerId = asProviderId(query.providerId);
        const httpsHost = asString(query.httpsHost);
        const dnsName = asString(query.dnsName);
        const dnsProviderId = asDnsProviderId(query.dnsProviderId);
        const satellitePaired = (query.satellitePaired ?? "false") === "true";
        const liveCertificationConfigured =
          (query.liveCertificationConfigured ?? "false") === "true";
        return deps.setupService.doctor.runDoctor({
          providerId,
          httpsHost,
          dnsName,
          dnsProviderId,
          satellitePaired,
          liveCertificationConfigured,
        });
      },
    },
    {
      operationId: "cloud.workers.dns.validate",
      method: "POST",
      path: "/v1/cloud-workers/dns/validate",
      auth: { public: true },
      async handler(ctx: Ctx) {
        assertBoundPrincipalForOperation(
          ctx.principal,
          "cloud.worker.dns.validate",
          "api",
        );
        const body = ctx.body as Record<string, unknown>;
        const dnsProviderId = asString(body.dnsProviderId);
        const dnsName = asString(body.dnsName);
        const rootDomain = asString(body.rootDomain);
        assertCloudWorkerSetupTestOracleAllowed(deps);
        return deps.setupService.dnsValidator.validate({
          dnsProviderId,
          dnsName,
          rootDomain,
        });
      },
    },
    {
      operationId: "cloud.workers.package.generate",
      method: "POST",
      path: "/v1/cloud-workers/package",
      auth: { public: true },
      async handler(ctx: Ctx) {
        assertBoundPrincipalForOperation(
          ctx.principal,
          "cloud.worker.package.generate",
          "api",
        );
        const body = ctx.body as Record<string, unknown>;
        const input: FridayCloudWorkerPackageInput = {
          providerId: asProviderId(body.providerId),
          httpsHost: asString(body.httpsHost),
          dnsName: asString(body.dnsName),
          dnsProviderId: asDnsProviderId(body.dnsProviderId),
          ownerRunId: asString(body.ownerRunId),
        };
        // Guard ABOVE the try: the catch below maps any thrown FridayDomainError
        // to a 400 VALIDATION_ERROR, which would otherwise swallow this 503.
        assertCloudWorkerSetupTestOracleAllowed(deps);
        try {
          return deps.setupService.packageService.generate(input);
        } catch (error) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            error instanceof Error ? error.message : String(error),
            { httpStatus: 400 },
          );
        }
      },
    },
    {
      operationId: "cloud.workers.teardown.receipt",
      method: "POST",
      path: "/v1/cloud-workers/teardown-receipt",
      auth: { public: true },
      async handler(ctx: Ctx) {
        assertBoundPrincipalForOperation(
          ctx.principal,
          "cloud.worker.teardown.receipt",
          "api",
        );
        const body = ctx.body as Record<string, unknown>;
        const providerId = asProviderId(body.providerId);
        const ownerRunId = asString(body.ownerRunId);
        const resourceTag = asString(body.resourceTag);
        const satelliteId =
          typeof body.satelliteId === "string" && body.satelliteId.trim().length > 0
            ? body.satelliteId.trim()
            : undefined;
        assertCloudWorkerSetupTestOracleAllowed(deps);
        return deps.setupService.teardown.issueReceipt({
          providerId,
          ownerRunId,
          resourceTag,
          satelliteId,
        });
      },
    },
  ];
}
