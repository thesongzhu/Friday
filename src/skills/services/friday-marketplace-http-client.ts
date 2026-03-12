import type {
  FridayMarketplaceIndexDocument,
  FridayMarketplacePublisherKeyDocument,
  FridayMarketplaceSignatureDocument,
} from "../model/friday-skill-marketplace.types.js";
import { FridayDomainError } from "#errors";
import { validateGatewayUrl } from "../../agent/tools/friday-agent-gateway-validation.js";

// ─── Interface ───

export interface FridayMarketplaceHttpClient {
  fetchIndex(baseUrl: string): Promise<FridayMarketplaceIndexDocument>;
  fetchManifest(url: string): Promise<unknown>;
  fetchSignature(url: string): Promise<FridayMarketplaceSignatureDocument>;
  fetchPublisherKey(baseUrl: string, keyId: string): Promise<FridayMarketplacePublisherKeyDocument>;
  fetchPackage(url: string): Promise<Buffer>;
}

// ─── Types ───

export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface CreateMarketplaceHttpClientDeps {
  fetchFn: FetchFn;
  timeoutMs?: number;
}

// ─── Factory ───

export function createFridayMarketplaceHttpClient(
  deps: CreateMarketplaceHttpClientDeps,
): FridayMarketplaceHttpClient {
  const timeoutMs = deps.timeoutMs ?? 30_000;

  async function fetchJson<T>(url: string): Promise<T> {
    const ssrfCheck = validateGatewayUrl(url);
    if (!ssrfCheck.valid) {
      throw new FridayDomainError("MARKETPLACE_SSRF_BLOCKED", `Marketplace request blocked: ${ssrfCheck.error}`, {
        httpStatus: 403,
        details: { url },
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await deps.fetchFn(url, { signal: controller.signal });
      if (!res.ok) {
        throw new FridayDomainError("MARKETPLACE_HTTP_ERROR", `HTTP ${res.status} fetching ${url}`, {
          httpStatus: res.status,
          retryable: res.status >= 500,
          details: { url, status: res.status },
        });
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchBytes(url: string): Promise<Buffer> {
    const ssrfCheck = validateGatewayUrl(url);
    if (!ssrfCheck.valid) {
      throw new FridayDomainError("MARKETPLACE_SSRF_BLOCKED", `Marketplace request blocked: ${ssrfCheck.error}`, {
        httpStatus: 403,
        details: { url },
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await deps.fetchFn(url, { signal: controller.signal });
      if (!res.ok) {
        throw new FridayDomainError("MARKETPLACE_HTTP_ERROR", `HTTP ${res.status} fetching ${url}`, {
          httpStatus: res.status,
          retryable: res.status >= 500,
          details: { url, status: res.status },
        });
      }
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    fetchIndex(baseUrl) {
      const url = `${baseUrl.replace(/\/$/, "")}/index.json`;
      return fetchJson<FridayMarketplaceIndexDocument>(url);
    },

    fetchManifest(url) {
      return fetchJson<unknown>(url);
    },

    fetchSignature(url) {
      return fetchJson<FridayMarketplaceSignatureDocument>(url);
    },

    fetchPublisherKey(baseUrl, keyId) {
      const url = `${baseUrl.replace(/\/$/, "")}/keys/${encodeURIComponent(keyId)}`;
      return fetchJson<FridayMarketplacePublisherKeyDocument>(url);
    },

    fetchPackage(url) {
      return fetchBytes(url);
    },
  };
}
