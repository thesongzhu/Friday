/**
 * Plugin management and marketplace API routes.
 */

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayDisablePluginResponse,
  FridayEnablePluginResponse,
  FridayGetPluginResponse,
  FridayInstallPluginResponse,
  FridayListPluginsResponse,
  FridayMarketplaceInstallResponse,
  FridayMarketplacePluginDetailResponse,
  FridayMarketplacePluginVersionsResponse,
  FridayMarketplaceSearchResponse,
  FridayPluginVersionsResponse,
  FridayUninstallPluginResponse,
} from "../../model/friday-api-plugin.types.js";
import type { FridayPluginManifestLoader, FridayPluginService } from "#plugins";
import { FridayDomainError } from "#errors";
import {
  FRIDAY_PLUGIN_ERROR_CODES,
  FRIDAY_PLUGIN_VALID_KINDS,
  FRIDAY_PLUGIN_VALID_SOURCES,
  FRIDAY_PLUGIN_VALID_STATUSES,
} from "#plugins";

// ─── Dependencies ───

export interface FridayPluginRoutesDeps {
  pluginService: FridayPluginService;
  manifestLoader: FridayPluginManifestLoader;
}

// ─── Validation Helpers ───

function validateInstallBody(body: unknown): asserts body is { installPath: string; userApproved?: boolean } {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
  }
  const b = body as Record<string, unknown>;
  if (typeof b.installPath !== "string" || !b.installPath) {
    throw new FridayDomainError("VALIDATION_ERROR", "installPath is required and must be a non-empty string", { httpStatus: 400 });
  }
  if (b.userApproved !== undefined && typeof b.userApproved !== "boolean") {
    throw new FridayDomainError("VALIDATION_ERROR", "userApproved must be a boolean", { httpStatus: 400 });
  }
}

// ─── Factory ───

// ─── Query Validation ───

const FRIDAY_PLUGIN_ROUTE_DEFAULT_LIMIT = 50;
const FRIDAY_PLUGIN_ROUTE_MAX_LIMIT = 200;

function parseValidLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return FRIDAY_PLUGIN_ROUTE_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), FRIDAY_PLUGIN_ROUTE_MAX_LIMIT);
}

function parseValidOffset(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function validateEnumParam<T extends string>(
  value: string | undefined,
  validValues: readonly T[],
  paramName: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!(validValues as readonly string[]).includes(value)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Invalid ${paramName}: "${value}". Must be one of: ${validValues.join(", ")}`,
      { httpStatus: 400, details: { param: paramName, value, validValues } },
    );
  }
  return value as T;
}

export function createFridayPluginRoutes(
  deps: FridayPluginRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  const { pluginService, manifestLoader } = deps;

  return [
    // ─── List installed plugins ───
    {
      operationId: "plugins.list",
      method: "GET",
      path: "/v1/plugins",
      auth: { public: false, anyOfScopes: ["plugin.read"] },
      async handler(ctx): Promise<FridayListPluginsResponse> {
        const query = ctx.query as Record<string, string | undefined>;
        const items = pluginService.listPlugins({
          source: validateEnumParam(query.source, FRIDAY_PLUGIN_VALID_SOURCES, "source"),
          status: validateEnumParam(query.status, FRIDAY_PLUGIN_VALID_STATUSES, "status"),
          kind: validateEnumParam(query.kind, FRIDAY_PLUGIN_VALID_KINDS, "kind"),
          enabled: query.enabled === "true" ? true : query.enabled === "false" ? false : undefined,
        });
        return { items };
      },
    },

    // ─── Get plugin details ───
    {
      operationId: "plugins.get",
      method: "GET",
      path: "/v1/plugins/:id",
      auth: { public: false, anyOfScopes: ["plugin.read"] },
      async handler(ctx): Promise<FridayGetPluginResponse> {
        const { id } = ctx.params as { id: string };
        const plugin = pluginService.getPlugin(id);
        if (!plugin) {
          throw new FridayDomainError(
            FRIDAY_PLUGIN_ERROR_CODES.NOT_FOUND,
            `Plugin "${id}" not found`,
            { httpStatus: 404, details: { pluginId: id } },
          );
        }
        return { plugin };
      },
    },

    // ─── Plugin versions ───
    {
      operationId: "plugins.versions.list",
      method: "GET",
      path: "/v1/plugins/:id/versions",
      auth: { public: false, anyOfScopes: ["plugin.read"] },
      async handler(ctx): Promise<FridayPluginVersionsResponse> {
        const { id } = ctx.params as { id: string };
        const versions = pluginService.listPluginVersions(id);
        return { versions };
      },
    },

    // ─── Install plugin (local) ───
    {
      operationId: "plugins.install",
      method: "POST",
      path: "/v1/plugins/:id/install",
      auth: { public: false, anyOfScopes: ["plugin.install"] },
      async handler(ctx): Promise<FridayInstallPluginResponse> {
        const { id } = ctx.params as { id: string };
        validateInstallBody(ctx.body);
        const body = ctx.body;

        // Read and validate the real manifest from installPath
        const manifest = manifestLoader.loadFromDirectory(body.installPath);

        // Ensure the manifest ID matches the route param
        if (manifest.id !== id) {
          throw new FridayDomainError(
            FRIDAY_PLUGIN_ERROR_CODES.MANIFEST_INVALID,
            `Manifest id "${manifest.id}" does not match route param "${id}"`,
            { httpStatus: 400, details: { manifestId: manifest.id, routeId: id } },
          );
        }

        const plugin = pluginService.installPlugin({
          manifest,
          installPath: body.installPath,
          source: "local",
          userApproved: body.userApproved,
        });

        return { plugin };
      },
    },

    // ─── Enable plugin ───
    {
      operationId: "plugins.enable",
      method: "POST",
      path: "/v1/plugins/:id/enable",
      auth: { public: false, anyOfScopes: ["plugin.write"] },
      async handler(ctx): Promise<FridayEnablePluginResponse> {
        const { id } = ctx.params as { id: string };
        const plugin = await pluginService.enablePlugin(id);
        return { plugin };
      },
    },

    // ─── Disable plugin ───
    {
      operationId: "plugins.disable",
      method: "POST",
      path: "/v1/plugins/:id/disable",
      auth: { public: false, anyOfScopes: ["plugin.write"] },
      async handler(ctx): Promise<FridayDisablePluginResponse> {
        const { id } = ctx.params as { id: string };
        const plugin = await pluginService.disablePlugin(id);
        return { plugin };
      },
    },

    // ─── Uninstall plugin ───
    {
      operationId: "plugins.uninstall",
      method: "DELETE",
      path: "/v1/plugins/:id",
      auth: { public: false, anyOfScopes: ["plugin.write"] },
      async handler(ctx): Promise<FridayUninstallPluginResponse> {
        const { id } = ctx.params as { id: string };
        const query = ctx.query as Record<string, string | undefined>;
        const force = query.force === "true";
        await pluginService.uninstallPlugin(id, force);
        return { uninstalled: true };
      },
    },

    // ─── Marketplace: search ───
    {
      operationId: "marketplace.plugins.list",
      method: "GET",
      path: "/v1/marketplace/plugins",
      auth: { public: false, anyOfScopes: ["plugin.read"] },
      async handler(ctx): Promise<FridayMarketplaceSearchResponse> {
        const query = ctx.query as Record<string, string | undefined>;
        const result = await pluginService.searchMarketplace({
          query: query.q,
          kind: validateEnumParam(query.kind, FRIDAY_PLUGIN_VALID_KINDS, "kind"),
          limit: parseValidLimit(query.limit),
          offset: parseValidOffset(query.offset),
        });
        return { items: result.items, total: result.total };
      },
    },

    // ─── Marketplace: get plugin detail ───
    {
      operationId: "marketplace.plugins.get",
      method: "GET",
      path: "/v1/marketplace/plugins/:id",
      auth: { public: false, anyOfScopes: ["plugin.read"] },
      async handler(ctx): Promise<FridayMarketplacePluginDetailResponse> {
        const { id } = ctx.params as { id: string };
        const detail = await pluginService.getMarketplacePlugin(id);
        return {
          plugin: {
            id: detail.id,
            name: detail.name,
            description: detail.description,
            version: detail.version,
            author: detail.author,
            downloads: detail.downloads,
            updatedAt: detail.updatedAt,
          },
        };
      },
    },

    // ─── Marketplace: plugin versions ───
    {
      operationId: "marketplace.plugins.versions.list",
      method: "GET",
      path: "/v1/marketplace/plugins/:id/versions",
      auth: { public: false, anyOfScopes: ["plugin.read"] },
      async handler(ctx): Promise<FridayMarketplacePluginVersionsResponse> {
        const { id } = ctx.params as { id: string };
        const versions = await pluginService.listMarketplacePluginVersions(id);
        return { versions };
      },
    },

    // ─── Marketplace: install from marketplace ───
    {
      operationId: "marketplace.plugins.install",
      method: "POST",
      path: "/v1/marketplace/plugins/:id/install",
      auth: { public: false, anyOfScopes: ["plugin.install"] },
      async handler(ctx): Promise<FridayMarketplaceInstallResponse> {
        const { id } = ctx.params as { id: string };
        const plugin = await pluginService.installFromMarketplace(id);
        return { plugin };
      },
    },
  ];
}
