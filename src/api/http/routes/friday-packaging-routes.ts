/**
 * B-008 Packaging API Routes — exposes package publish, search, install,
 * upgrade, rollback, uninstall, dependency check, lifecycle events,
 * and trusted key management.
 *
 * @module api/http/routes
 */

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import { FridayDomainError } from "../../../errors/friday-domain-error.js";
import { throwFridayCapabilityDisabled } from "./friday-capability-disabled.js";
import type {
  FridayAddTrustedKeyRequest,
  FridayAddTrustedKeyResponse,
  FridayCheckDependenciesRequest,
  FridayCheckDependenciesResponse,
  FridayGetInstallResponse,
  FridayGetPackageResponse,
  FridayInstallPackageRequest,
  FridayInstallPackageResponse,
  FridayListInstallsQuery,
  FridayListInstallsResponse,
  FridayListLifecycleEventsQuery,
  FridayListLifecycleEventsResponse,
  FridayListPackagesQuery,
  FridayListPackagesResponse,
  FridayListPackageVersionsQuery,
  FridayListPackageVersionsResponse,
  FridayListTrustedKeysRequest,
  FridayListTrustedKeysResponse,
  FridayPublishPackageRequest,
  FridayPublishPackageResponse,
  FridayRevokeTrustedKeyRequest,
  FridayRevokeTrustedKeyResponse,
  FridayRollbackPackageRequest,
  FridayRollbackPackageResponse,
  FridayRotateTrustedKeyRequest,
  FridayRotateTrustedKeyResponse,
  FridayUninstallPackageRequest,
  FridayUninstallPackageResponse,
  FridayUpgradePackageRequest,
  FridayUpgradePackageResponse,
  FridayVerifyPackageRequest,
  FridayVerifyPackageResponse,
} from "../../../packaging/api/friday-packaging-api.types.js";
import type { UUID } from "../../../security/multi-tenant/model/friday-multi-tenant-security.types.js";

// ─── Service Dependencies ───

export interface FridayPackagingRoutesDeps {
  packages: {
    publish(req: FridayPublishPackageRequest): FridayPublishPackageResponse;
    list(query: FridayListPackagesQuery): FridayListPackagesResponse;
    get(packageId: UUID): FridayGetPackageResponse;
    listVersions(packageName: string, query: FridayListPackageVersionsQuery): FridayListPackageVersionsResponse;
    verify(packageId: UUID, req: FridayVerifyPackageRequest): FridayVerifyPackageResponse;
    checkDependencies(packageName: string, req: FridayCheckDependenciesRequest): FridayCheckDependenciesResponse;
  };
  installs: {
    install(packageName: string, req: FridayInstallPackageRequest): FridayInstallPackageResponse;
    upgrade(packageName: string, req: FridayUpgradePackageRequest): FridayUpgradePackageResponse;
    rollback(packageName: string, req: FridayRollbackPackageRequest): FridayRollbackPackageResponse;
    uninstall(packageName: string, req: FridayUninstallPackageRequest): FridayUninstallPackageResponse;
    list(query: FridayListInstallsQuery): FridayListInstallsResponse;
    get(installId: UUID): FridayGetInstallResponse;
  };
  lifecycle: {
    list(query: FridayListLifecycleEventsQuery): FridayListLifecycleEventsResponse;
  };
  keys: {
    list(query: FridayListTrustedKeysRequest): FridayListTrustedKeysResponse;
    add(req: FridayAddTrustedKeyRequest): FridayAddTrustedKeyResponse;
    revoke(keyId: string, req: FridayRevokeTrustedKeyRequest): FridayRevokeTrustedKeyResponse;
    rotate(keyId: string, req: FridayRotateTrustedKeyRequest): FridayRotateTrustedKeyResponse;
  };
}

// ─── Validation Helpers ───

function requireString(body: unknown, field: string): void {
  const obj = body as Record<string, unknown> | null | undefined;
  if (!obj || typeof obj[field] !== "string" || (obj[field] as string).trim() === "") {
    throw new FridayDomainError("VALIDATION_ERROR", `${field} is required`);
  }
}

function requireIdempotencyKey(body: unknown): void {
  requireString(body, "idempotencyKey");
}

function requireEtag(body: unknown): void {
  requireString(body, "etag");
}

// ─── Factory ───

export function createFridayPackagingRoutes(
  deps?: FridayPackagingRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  function requireEnabled(): FridayPackagingRoutesDeps {
    if (!deps) {
      throwFridayCapabilityDisabled({
        capability: "packaging",
        surface: "/v1/packages",
        message: "Packaging surface is disabled in this runtime",
      });
    }
    return deps;
  }

  return [
    // ═══════════════════════════════════════════════════════════════
    // PACKAGES
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "packaging.packages.publish",
      method: "POST",
      path: "/v1/packages",
      auth: { public: false, anyOfScopes: ["plugin.install"] },
      async handler(ctx) {
        const services = requireEnabled();
        const body = ctx.body as FridayPublishPackageRequest;
        requireString(body, "archive");
        requireIdempotencyKey(body);
        return services.packages.publish(body);
      },
    },
    {
      operationId: "packaging.packages.list",
      method: "GET",
      path: "/v1/packages",
      auth: { public: false, anyOfScopes: ["plugin.read"] },
      async handler(ctx) {
        const services = requireEnabled();
        return services.packages.list(ctx.query as FridayListPackagesQuery);
      },
    },
    {
      operationId: "packaging.packages.get",
      method: "GET",
      path: "/v1/packages/:packageId",
      auth: { public: false, anyOfScopes: ["plugin.read"] },
      async handler(ctx) {
        const services = requireEnabled();
        const { packageId } = ctx.params as { packageId: UUID };
        return services.packages.get(packageId);
      },
    },
    {
      operationId: "packaging.packages.versions.list",
      method: "GET",
      path: "/v1/packages/:packageName/versions",
      auth: { public: false, anyOfScopes: ["plugin.read"] },
      async handler(ctx) {
        const services = requireEnabled();
        const { packageName } = ctx.params as { packageName: string };
        return services.packages.listVersions(packageName, ctx.query as FridayListPackageVersionsQuery);
      },
    },
    {
      operationId: "packaging.packages.verify",
      method: "POST",
      path: "/v1/packages/:packageId/verify",
      auth: { public: false, anyOfScopes: ["plugin.install"] },
      async handler(ctx) {
        const services = requireEnabled();
        const { packageId } = ctx.params as { packageId: UUID };
        const body = ctx.body as FridayVerifyPackageRequest;
        requireIdempotencyKey(body);
        return services.packages.verify(packageId, body);
      },
    },
    {
      operationId: "packaging.packages.dependencies.check",
      method: "POST",
      path: "/v1/packages/:packageName/check-dependencies",
      auth: { public: false, anyOfScopes: ["plugin.read"] },
      async handler(ctx) {
        const services = requireEnabled();
        const { packageName } = ctx.params as { packageName: string };
        const body = ctx.body as FridayCheckDependenciesRequest;
        requireString(body, "tenantId");
        return services.packages.checkDependencies(packageName, body);
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // INSTALL LIFECYCLE
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "packaging.installs.install",
      method: "POST",
      path: "/v1/packages/:packageName/install",
      auth: { public: false, anyOfScopes: ["plugin.install"] },
      async handler(ctx) {
        const services = requireEnabled();
        const { packageName } = ctx.params as { packageName: string };
        const body = ctx.body as FridayInstallPackageRequest;
        requireString(body, "tenantId");
        requireIdempotencyKey(body);
        return services.installs.install(packageName, body);
      },
    },
    {
      operationId: "packaging.installs.upgrade",
      method: "POST",
      path: "/v1/packages/:packageName/upgrade",
      auth: { public: false, anyOfScopes: ["plugin.install"] },
      async handler(ctx) {
        const services = requireEnabled();
        const { packageName } = ctx.params as { packageName: string };
        const body = ctx.body as FridayUpgradePackageRequest;
        requireEtag(body);
        requireIdempotencyKey(body);
        return services.installs.upgrade(packageName, body);
      },
    },
    {
      operationId: "packaging.installs.rollback",
      method: "POST",
      path: "/v1/packages/:packageName/rollback",
      auth: { public: false, anyOfScopes: ["plugin.install"] },
      async handler(ctx) {
        const services = requireEnabled();
        const { packageName } = ctx.params as { packageName: string };
        const body = ctx.body as FridayRollbackPackageRequest;
        requireEtag(body);
        requireString(body, "targetVersion");
        requireString(body, "reason");
        requireIdempotencyKey(body);
        return services.installs.rollback(packageName, body);
      },
    },
    {
      operationId: "packaging.installs.uninstall",
      method: "POST",
      path: "/v1/packages/:packageName/uninstall",
      auth: { public: false, anyOfScopes: ["plugin.install"] },
      async handler(ctx) {
        const services = requireEnabled();
        const { packageName } = ctx.params as { packageName: string };
        const body = ctx.body as FridayUninstallPackageRequest;
        requireEtag(body);
        requireIdempotencyKey(body);
        return services.installs.uninstall(packageName, body);
      },
    },
    {
      operationId: "packaging.installs.list",
      method: "GET",
      path: "/v1/packages/installs",
      auth: { public: false, anyOfScopes: ["plugin.read"] },
      async handler(ctx) {
        const services = requireEnabled();
        return services.installs.list(ctx.query as FridayListInstallsQuery);
      },
    },
    {
      operationId: "packaging.installs.get",
      method: "GET",
      path: "/v1/packages/installs/:installId",
      auth: { public: false, anyOfScopes: ["plugin.read"] },
      async handler(ctx) {
        const services = requireEnabled();
        const { installId } = ctx.params as { installId: UUID };
        return services.installs.get(installId);
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // LIFECYCLE EVENTS
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "packaging.lifecycle.list",
      method: "GET",
      path: "/v1/packages/lifecycle",
      auth: { public: false, anyOfScopes: ["plugin.read"] },
      async handler(ctx) {
        const services = requireEnabled();
        return services.lifecycle.list(ctx.query as FridayListLifecycleEventsQuery);
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // TRUSTED KEY MANAGEMENT
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "packaging.keys.list",
      method: "GET",
      path: "/v1/packages/keys",
      auth: { public: false, anyOfScopes: ["plugin.read"] },
      async handler(ctx) {
        const services = requireEnabled();
        return services.keys.list(ctx.query as FridayListTrustedKeysRequest);
      },
    },
    {
      operationId: "packaging.keys.add",
      method: "POST",
      path: "/v1/packages/keys",
      auth: { public: false, anyOfScopes: ["security.write"] },
      async handler(ctx) {
        const services = requireEnabled();
        const body = ctx.body as FridayAddTrustedKeyRequest;
        requireString(body, "keyId");
        requireString(body, "publicKey");
        requireString(body, "owner");
        requireIdempotencyKey(body);
        return services.keys.add(body);
      },
    },
    {
      operationId: "packaging.keys.revoke",
      method: "POST",
      path: "/v1/packages/keys/:keyId/revoke",
      auth: { public: false, anyOfScopes: ["security.write"] },
      async handler(ctx) {
        const services = requireEnabled();
        const { keyId } = ctx.params as { keyId: string };
        const body = ctx.body as FridayRevokeTrustedKeyRequest;
        requireString(body, "reason");
        requireIdempotencyKey(body);
        return services.keys.revoke(keyId, body);
      },
    },
    {
      operationId: "packaging.keys.rotate",
      method: "POST",
      path: "/v1/packages/keys/:keyId/rotate",
      auth: { public: false, anyOfScopes: ["security.write"] },
      async handler(ctx) {
        const services = requireEnabled();
        const { keyId } = ctx.params as { keyId: string };
        const body = ctx.body as FridayRotateTrustedKeyRequest;
        requireString(body, "newKeyId");
        requireString(body, "newPublicKey");
        requireString(body, "owner");
        requireIdempotencyKey(body);
        return services.keys.rotate(keyId, body);
      },
    },
  ];
}
