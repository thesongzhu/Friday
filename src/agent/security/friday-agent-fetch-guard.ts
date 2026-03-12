/**
 * SSRF-guarded fetch — wraps native fetch with redirect-manual loop,
 * per-hop URL revalidation, and redirect loop detection.
 */

import { type FridayAgentSsrfGuard, FridaySsrfBlockedError } from "./friday-agent-ssrf-guard.js";

// ─── Types ───

export interface FridayAgentFetchGuardOptions {
  /** Maximum number of redirects to follow. Default: 3. */
  maxRedirects?: number;
}

export interface FridayGuardedFetchParams {
  url: string;
  init?: RequestInit;
  guard: FridayAgentSsrfGuard;
  options?: FridayAgentFetchGuardOptions;
  /** Optional fetch implementation. Defaults to `globalThis.fetch`. */
  fetchFn?: typeof fetch;
}

// ─── Constants ───

const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

// ─── Guarded Fetch ───

/**
 * Fetch a URL with SSRF guard protection on every redirect hop.
 *
 * Uses `redirect: "manual"` to intercept redirects, validates
 * each redirect target against the SSRF guard, and follows up to
 * `maxRedirects` hops (default 3).
 *
 * @throws FridaySsrfBlockedError if any hop targets a private IP or blocked hostname.
 * @throws Error on redirect loops or max redirects exceeded.
 */
export async function fetchWithFridayAgentSsrfGuard(
  params: FridayGuardedFetchParams,
): Promise<Response> {
  // Validate maxRedirects: must be finite number, floor it, clamp to >= 0
  const rawMax = params.options?.maxRedirects;
  const maxRedirects =
    typeof rawMax === "number" && Number.isFinite(rawMax)
      ? Math.max(0, Math.floor(rawMax))
      : DEFAULT_MAX_REDIRECTS;

  const fetchImpl = params.fetchFn ?? globalThis.fetch;
  const seen = new Set<string>();
  let currentUrl = params.url;

  // Validate initial URL (with DNS)
  await params.guard.validateWithDns(currentUrl);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    // Redirect loop detection
    if (seen.has(currentUrl)) {
      throw new FridaySsrfBlockedError(`SSRF guard: redirect loop detected — ${currentUrl}`);
    }
    seen.add(currentUrl);

    const response = await fetchImpl(currentUrl, {
      ...params.init,
      redirect: "manual",
    });

    // Not a redirect — return the response
    if (!REDIRECT_STATUS_CODES.has(response.status)) {
      return response;
    }

    // Get redirect location
    const location = response.headers.get("location");
    if (!location) {
      return response; // No Location header, return as-is
    }

    // Cancel the response body before following redirect to prevent resource leaks
    void response.body?.cancel();

    // Resolve relative redirect URLs
    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).href;
    } catch {
      throw new FridaySsrfBlockedError(`SSRF guard: invalid redirect URL — ${location}`);
    }

    // Validate redirect target (with DNS)
    try {
      await params.guard.validateWithDns(nextUrl);
    } catch (err) {
      // Ensure cleanup even on validation error (body already cancelled above)
      throw err;
    }

    // Check if we've hit max redirects
    if (hop === maxRedirects) {
      throw new FridaySsrfBlockedError(`SSRF guard: too many redirects (max ${String(maxRedirects)})`);
    }

    currentUrl = nextUrl;
  }

  // Should not reach here, but satisfy TypeScript
  throw new FridaySsrfBlockedError("SSRF guard: unexpected redirect loop");
}
