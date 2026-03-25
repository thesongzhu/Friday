/**
 * HTTP client for the Friday plugin marketplace API.
 *
 * Provides search, detail retrieval, and package download.
 */

import { FridayDomainError } from "#errors";
import type {
  FridayPluginCapabilitySummary,
  FridayPluginManifest,
  FridayPluginPolicySummary,
  FridayPluginSdkPreviewManifest,
} from "../model/friday-plugin.types.js";
import { FRIDAY_PLUGIN_ERROR_CODES } from "../model/friday-plugin.types.js";

// ─── Types ───

export interface FridayMarketplacePluginSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  downloads: number;
  updatedAt: string;
  previewSdk?: FridayPluginSdkPreviewManifest;
  capabilitySummary?: FridayPluginCapabilitySummary;
  policySummary?: FridayPluginPolicySummary;
}

export interface FridayMarketplacePluginDetail {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  downloads: number;
  manifest: FridayPluginManifest;
  checksum: string;
  packageUrl: string;
  updatedAt: string;
  previewSdk?: FridayPluginSdkPreviewManifest;
  capabilitySummary?: FridayPluginCapabilitySummary;
  policySummary?: FridayPluginPolicySummary;
}

export interface FridayMarketplaceSearchQuery {
  query?: string;
  kind?: string;
  limit?: number;
  offset?: number;
}

export interface FridayMarketplaceSearchResult {
  items: FridayMarketplacePluginSummary[];
  total: number;
}

export interface FridayMarketplaceDownloadResult {
  packageBytes: Buffer;
  checksum: string;
  manifest: FridayPluginManifest;
}

export interface FridayMarketplaceVersionEntry {
  version: string;
  releasedAt: string;
  checksum: string;
}

export interface FridayPluginMarketplaceClient {
  /** Search marketplace plugins. */
  search(query: FridayMarketplaceSearchQuery): Promise<FridayMarketplaceSearchResult>;
  /** Get details for a specific marketplace plugin. */
  getPluginDetail(pluginId: string): Promise<FridayMarketplacePluginDetail>;
  /** List versions for a marketplace plugin. */
  listVersions(pluginId: string): Promise<FridayMarketplaceVersionEntry[]>;
  /** Download a plugin package. */
  downloadPackage(pluginId: string, version?: string): Promise<FridayMarketplaceDownloadResult>;
}

/** Default timeout for marketplace HTTP requests (30 seconds). */
const FRIDAY_MARKETPLACE_DEFAULT_TIMEOUT_MS = 30_000;

export interface CreateFridayPluginMarketplaceClientDeps {
  /** Base URL for the marketplace API. */
  baseUrl: string;
  /** Override fetch for testing. */
  httpFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
}

// ─── Factory ───

export function createFridayPluginMarketplaceClient(
  deps: CreateFridayPluginMarketplaceClientDeps,
): FridayPluginMarketplaceClient {
  const { baseUrl } = deps;
  const httpFetch = deps.httpFetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? FRIDAY_MARKETPLACE_DEFAULT_TIMEOUT_MS;

  function createTimeoutSignal(): AbortSignal {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), timeoutMs);
    return controller.signal;
  }

  async function fetchJson<T>(path: string): Promise<T> {
    const url = `${baseUrl}${path}`;
    let response: Response;
    try {
      response = await httpFetch(url, { signal: createTimeoutSignal() });
    } catch (err) {
      const message = err instanceof Error && err.name === "AbortError"
        ? `Marketplace request timed out after ${String(timeoutMs)}ms`
        : `Marketplace request failed: ${err instanceof Error ? err.message : String(err)}`;
      throw new FridayDomainError(
        FRIDAY_PLUGIN_ERROR_CODES.DISCOVERY_FAILED,
        message,
        { httpStatus: 502, cause: err, details: { url } },
      );
    }

    if (!response.ok) {
      throw new FridayDomainError(
        FRIDAY_PLUGIN_ERROR_CODES.DISCOVERY_FAILED,
        `Marketplace returned HTTP ${String(response.status)} for ${url}`,
        { httpStatus: response.status >= 500 ? 502 : 400, details: { url, status: response.status } },
      );
    }

    try {
      return await response.json() as T;
    } catch (err) {
      throw new FridayDomainError(
        FRIDAY_PLUGIN_ERROR_CODES.DISCOVERY_FAILED,
        `Failed to parse JSON response from ${url}: ${err instanceof Error ? err.message : String(err)}`,
        { httpStatus: 502, cause: err, details: { url } },
      );
    }
  }

  async function fetchBuffer(path: string): Promise<Buffer> {
    const url = `${baseUrl}${path}`;
    let response: Response;
    try {
      response = await httpFetch(url, { signal: createTimeoutSignal() });
    } catch (err) {
      const message = err instanceof Error && err.name === "AbortError"
        ? `Marketplace download timed out after ${String(timeoutMs)}ms`
        : `Marketplace download failed: ${err instanceof Error ? err.message : String(err)}`;
      throw new FridayDomainError(
        FRIDAY_PLUGIN_ERROR_CODES.DISCOVERY_FAILED,
        message,
        { httpStatus: 502, cause: err, details: { url } },
      );
    }

    if (!response.ok) {
      throw new FridayDomainError(
        FRIDAY_PLUGIN_ERROR_CODES.DISCOVERY_FAILED,
        `Marketplace download returned HTTP ${String(response.status)} for ${url}`,
        { httpStatus: response.status >= 500 ? 502 : 400, details: { url, status: response.status } },
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  return {
    async search(query: FridayMarketplaceSearchQuery): Promise<FridayMarketplaceSearchResult> {
      const params = new URLSearchParams();
      if (query.query) params.set("q", query.query);
      if (query.kind) params.set("kind", query.kind);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.offset !== undefined) params.set("offset", String(query.offset));

      const qs = params.toString();
      const path = `/v1/plugins${qs ? `?${qs}` : ""}`;
      return fetchJson<FridayMarketplaceSearchResult>(path);
    },

    async getPluginDetail(pluginId: string): Promise<FridayMarketplacePluginDetail> {
      return fetchJson<FridayMarketplacePluginDetail>(`/v1/plugins/${encodeURIComponent(pluginId)}`);
    },

    async listVersions(pluginId: string): Promise<FridayMarketplaceVersionEntry[]> {
      return fetchJson<FridayMarketplaceVersionEntry[]>(
        `/v1/plugins/${encodeURIComponent(pluginId)}/versions`,
      );
    },

    async downloadPackage(pluginId: string, version?: string): Promise<FridayMarketplaceDownloadResult> {
      // First, get details for manifest and checksum
      const detail = await fetchJson<FridayMarketplacePluginDetail>(
        `/v1/plugins/${encodeURIComponent(pluginId)}${version ? `?version=${encodeURIComponent(version)}` : ""}`,
      );

      // Download the actual package
      const packageBytes = await fetchBuffer(
        `/v1/plugins/${encodeURIComponent(pluginId)}/download${version ? `?version=${encodeURIComponent(version)}` : ""}`,
      );

      return {
        packageBytes,
        checksum: detail.checksum,
        manifest: detail.manifest,
      };
    },
  };
}
