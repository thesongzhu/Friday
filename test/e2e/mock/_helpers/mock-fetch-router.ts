/**
 * URL-based router that dispatches requests to the correct MockFetch
 * based on the request URL host/path.
 */

import type { FridayProviderApi } from "../../../../src/providers/model/friday-provider.types.js";
import type { MockFetch } from "../../../_mocks/mock-llm-providers.js";

// ─── Route entry ───

export interface MockRouteEntry {
  /** URL prefix to match against (e.g. "https://mock.anthropic.local") */
  urlPrefix: string;
  api: FridayProviderApi;
  mockFetch: MockFetch;
}

// ─── Router ───

export interface MockFetchRouter {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  routes: MockRouteEntry[];
}

/**
 * Create a fetch function that routes requests based on URL prefix.
 * Falls through to the original fetch for unmatched URLs.
 */
export function createMockFetchRouter(
  routes: MockRouteEntry[],
  fallbackFetch?: typeof fetch,
): MockFetchRouter {
  const router = async function routerFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    for (const route of routes) {
      if (url.startsWith(route.urlPrefix)) {
        return route.mockFetch(input, init);
      }
    }

    // Fallback to real fetch for non-mock URLs (e.g. hub API calls to localhost)
    const realFetch = fallbackFetch ?? globalThis.fetch;
    if (!realFetch) {
      throw new Error(`MockFetchRouter: No route matched URL "${url}" and no fallback fetch available`);
    }
    return realFetch(input, init);
  } as MockFetchRouter;

  router.routes = routes;
  return router;
}
