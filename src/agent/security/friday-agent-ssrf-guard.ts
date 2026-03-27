// ─── SSRF guard — blocks requests to private/internal network addresses ───

import * as dns from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import * as net from "node:net";

// ─── Types ───

export interface FridayAgentSsrfGuard {
  /** Validate a URL synchronously (protocol + literal IP checks). Throws if blocked. */
  validate(url: string): void;
  /** Validate a URL with async DNS resolution. Throws if the resolved IP is private. */
  validateWithDns(url: string): Promise<void>;
}

/**
 * Policy for SSRF guard behavior.
 */
export interface FridaySsrfPolicy {
  /** Allow requests to private/internal network addresses. */
  allowPrivateNetwork?: boolean;
  /** Restrict requests to only these hostnames (supports `*.example.com` wildcards). */
  hostnameAllowlist?: string[];
}

/**
 * Error thrown when an SSRF guard blocks a request.
 */
export class FridaySsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FridaySsrfBlockedError";
  }
}

export type LookupFn = typeof dnsLookup;

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

// ─── Blocked hostnames and suffixes ───

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.",
  "0.0.0.0",
  "[::1]",
  "[::0]",
  "[0000::1]",
  // Cloud metadata endpoints
  "metadata.google.internal",
  "metadata.google.internal.",
  "instance-data",
]);

const BLOCKED_SUFFIXES = [
  ".local",
  ".local.",
  ".internal",
  ".internal.",
  ".localhost",
  ".localhost.",
];

// ─── Hostname normalization ───

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function normalizeHostnameAllowlist(values?: string[]): string[] {
  if (!values || values.length === 0) {
    return [];
  }
  return Array.from(
    new Set(
      values
        .map((value) => normalizeHostname(value))
        .filter((value) => value !== "*" && value !== "*." && value.length > 0),
    ),
  );
}

function isHostnameAllowedByPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    if (!suffix || hostname === suffix) {
      return false;
    }
    return hostname.endsWith(`.${suffix}`);
  }
  return hostname === pattern;
}

function matchesHostnameAllowlist(hostname: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) {
    return true;
  }
  return allowlist.some((pattern) => isHostnameAllowedByPattern(hostname, pattern));
}

// ─── IPv4 parsing and classification ───

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const numbers = parts.map((part) => Number.parseInt(part, 10));
  if (numbers.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
    return null;
  }
  return numbers;
}

/**
 * Returns true if the given IPv4 address is in a private/reserved range.
 * Covers RFC 1918, loopback, link-local, current-network, shared address space (100.64/10),
 * and other IANA-reserved ranges.
 */
export function isPrivateIpv4(ip: string): boolean {
  const parts = parseIpv4(ip);
  if (!parts) {
    return false;
  }
  return isPrivateIpv4Parts(parts);
}

function isPrivateIpv4Parts(parts: number[]): boolean {
  const [a, b] = parts;

  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 10.0.0.0/8 — private
  if (a === 10) return true;
  // 172.16.0.0/12 — private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8 — current network
  if (a === 0) return true;
  // 100.64.0.0/10 — shared address space (CGNAT, RFC 6598)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 192.0.0.0/24 — IETF protocol assignments
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  // 198.18.0.0/15 — benchmark testing
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 240.0.0.0/4 — reserved (class E)
  if (a >= 240) return true;

  return false;
}

// ─── IPv6 parsing and classification ───

/**
 * Strip zone ID from IPv6 address (e.g., `fe80::1%lo0` → `fe80::1`).
 */
function stripIpv6ZoneId(address: string): string {
  const index = address.indexOf("%");
  return index >= 0 ? address.slice(0, index) : address;
}

/**
 * Parse an IPv6 address into 8 hextets using proper hextet logic.
 * Handles `::` expansion, zone IDs, and IPv4-embedded tails.
 */
function parseIpv6Hextets(address: string): number[] | null {
  let input = stripIpv6ZoneId(address.trim().toLowerCase());
  if (!input) {
    return null;
  }

  // Handle IPv4-embedded IPv6 like ::ffff:127.0.0.1 by converting the tail to 2 hextets.
  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    if (lastColon < 0) {
      return null;
    }
    const ipv4 = parseIpv4(input.slice(lastColon + 1));
    if (!ipv4) {
      return null;
    }
    const high = (ipv4[0] << 8) + ipv4[1];
    const low = (ipv4[2] << 8) + ipv4[3];
    input = `${input.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const doubleColonParts = input.split("::");
  if (doubleColonParts.length > 2) {
    return null;
  }

  const headParts =
    doubleColonParts[0]?.length > 0 ? doubleColonParts[0].split(":").filter(Boolean) : [];
  const tailParts =
    doubleColonParts.length === 2 && doubleColonParts[1]?.length > 0
      ? doubleColonParts[1].split(":").filter(Boolean)
      : [];

  const missingParts = 8 - headParts.length - tailParts.length;
  if (missingParts < 0) {
    return null;
  }

  const fullParts =
    doubleColonParts.length === 1
      ? input.split(":")
      : [...headParts, ...Array.from({ length: missingParts }, () => "0"), ...tailParts];

  if (fullParts.length !== 8) {
    return null;
  }

  const hextets: number[] = [];
  for (const part of fullParts) {
    if (!part) {
      return null;
    }
    const value = Number.parseInt(part, 16);
    if (Number.isNaN(value) || value < 0 || value > 0xffff) {
      return null;
    }
    hextets.push(value);
  }
  return hextets;
}

/**
 * Extract IPv4 address from IPv4-mapped/compatible IPv6 hextets.
 */
function extractIpv4FromEmbeddedIpv6(hextets: number[]): number[] | null {
  const zeroPrefix = hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0 && hextets[3] === 0;
  if (!zeroPrefix || hextets[4] !== 0) {
    return null;
  }
  if (hextets[5] !== 0xffff && hextets[5] !== 0) {
    return null;
  }
  const high = hextets[6];
  const low = hextets[7];
  return [(high >>> 8) & 0xff, high & 0xff, (low >>> 8) & 0xff, low & 0xff];
}

/**
 * Returns true if the given IPv6 address is private/reserved.
 * Uses parsed-hextet logic instead of regex-only.
 * Covers loopback, unspecified, link-local, unique-local, site-local,
 * and IPv4-embedded addresses.
 */
export function isPrivateIpv6(ip: string): boolean {
  // Normalize: strip brackets if present
  let normalized = ip.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!normalized) {
    return false;
  }

  const hextets = parseIpv6Hextets(normalized);
  if (!hextets) {
    return false;
  }

  // :: — unspecified (all zeros)
  const isUnspecified = hextets.every((h) => h === 0);
  if (isUnspecified) {
    return true;
  }

  // ::1 — loopback
  const isLoopback =
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0 &&
    hextets[6] === 0 &&
    hextets[7] === 1;
  if (isLoopback) {
    return true;
  }

  // Check embedded IPv4
  const embeddedIpv4 = extractIpv4FromEmbeddedIpv6(hextets);
  if (embeddedIpv4) {
    return isPrivateIpv4Parts(embeddedIpv4);
  }

  // IPv6 private/internal ranges
  const first = hextets[0];

  // fe80::/10 — link-local
  if ((first & 0xffc0) === 0xfe80) {
    return true;
  }
  // fec0::/10 — deprecated site-local
  if ((first & 0xffc0) === 0xfec0) {
    return true;
  }
  // fc00::/7 — unique local
  if ((first & 0xfe00) === 0xfc00) {
    return true;
  }

  return false;
}

/**
 * Returns true if the IP (v4 or v6) is private.
 */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  const stripped = ip.replace(/^\[/, "").replace(/\]$/, "");
  if (net.isIPv6(stripped) || stripped.includes(":")) return isPrivateIpv6(stripped);
  return false;
}

// ─── Hostname checks ───

function isBlockedHostname(hostname: string): boolean {
  if (BLOCKED_HOSTNAMES.has(hostname)) return true;
  for (const suffix of BLOCKED_SUFFIXES) {
    if (hostname.endsWith(suffix)) return true;
  }
  return false;
}

// ─── DNS resolution guard ───

/**
 * Resolve a hostname and return its IP addresses.
 * Throws if all resolved IPs are private.
 */
async function dnsResolveGuard(hostname: string): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    dns.resolve(hostname, (err, addresses) => {
      if (err) {
        // Also try resolve6
        dns.resolve6(hostname, (err6, addresses6) => {
          if (err6) {
            reject(new FridaySsrfBlockedError(`SSRF guard: DNS resolution failed for ${hostname}`));
          } else {
            resolve(addresses6);
          }
        });
      } else {
        // Also get AAAA records
        dns.resolve6(hostname, (_err6, addresses6) => {
          resolve([...addresses, ...(addresses6 ?? [])]);
        });
      }
    });
  });
}

// ─── DNS Pinning ───

export interface PinnedHostname {
  hostname: string;
  addresses: string[];
  lookup: typeof dns.lookup;
}

/**
 * Create a pinned DNS lookup function that returns pre-resolved addresses
 * for a specific hostname, falling back to the real resolver for other hostnames.
 */
export function createPinnedLookup(params: {
  hostname: string;
  addresses: string[];
  fallback?: typeof dns.lookup;
}): typeof dns.lookup {
  const normalizedHost = normalizeHostname(params.hostname);
  const fallback = params.fallback ?? dns.lookup;
  const fallbackLookup = fallback as unknown as (
    hostname: string,
    callback: LookupCallback,
  ) => void;
  const fallbackWithOptions = fallback as unknown as (
    hostname: string,
    options: unknown,
    callback: LookupCallback,
  ) => void;
  const records = params.addresses.map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }));
  let index = 0;

  return ((host: string, options?: unknown, callback?: unknown) => {
    const cb: LookupCallback =
      typeof options === "function" ? (options as LookupCallback) : (callback as LookupCallback);
    if (!cb) {
      return;
    }
    const normalized = normalizeHostname(host);
    if (!normalized || normalized !== normalizedHost) {
      if (typeof options === "function" || options === undefined) {
        return fallbackLookup(host, cb);
      }
      return fallbackWithOptions(host, options, cb);
    }

    const opts =
      typeof options === "object" && options !== null
        ? (options as { all?: boolean; family?: number })
        : {};
    const requestedFamily =
      typeof options === "number" ? options : typeof opts.family === "number" ? opts.family : 0;
    const candidates =
      requestedFamily === 4 || requestedFamily === 6
        ? records.filter((entry) => entry.family === requestedFamily)
        : records;
    const usable = candidates.length > 0 ? candidates : records;
    if (opts.all) {
      cb(null, usable as dns.LookupAddress[]);
      return;
    }
    const chosen = usable[index % usable.length];
    index += 1;
    cb(null, chosen.address, chosen.family);
  }) as typeof dns.lookup;
}

/**
 * Resolve a hostname to pinned addresses, blocking private IPs unless policy allows.
 */
export async function resolvePinnedHostname(
  hostname: string,
  params: { lookupFn?: LookupFn; policy?: FridaySsrfPolicy } = {},
): Promise<PinnedHostname> {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    throw new FridaySsrfBlockedError("SSRF guard: invalid hostname");
  }

  const allowPrivateNetwork = Boolean(params.policy?.allowPrivateNetwork);
  const hostnameAllowlist = normalizeHostnameAllowlist(params.policy?.hostnameAllowlist);

  // Check hostname allowlist
  if (!matchesHostnameAllowlist(normalized, hostnameAllowlist)) {
    throw new FridaySsrfBlockedError(`SSRF guard: blocked hostname (not in allowlist) — ${hostname}`);
  }

  if (!allowPrivateNetwork) {
    if (isBlockedHostname(normalized)) {
      throw new FridaySsrfBlockedError(`SSRF guard: blocked hostname — ${normalized}`);
    }
    if (isPrivateIp(normalized)) {
      throw new FridaySsrfBlockedError(`SSRF guard: blocked private IP — ${normalized}`);
    }
  }

  // Resolve DNS
  const lookupFn = params.lookupFn ?? dnsLookup;
  const results = await lookupFn(normalized, { all: true });
  if (results.length === 0) {
    throw new FridaySsrfBlockedError(`SSRF guard: DNS resolution failed for ${hostname}`);
  }

  if (!allowPrivateNetwork) {
    for (const entry of results) {
      if (isPrivateIp(entry.address)) {
        throw new FridaySsrfBlockedError(`SSRF guard: DNS resolved to private IP — ${hostname} → ${entry.address}`);
      }
    }
  }

  const addresses = Array.from(new Set(results.map((entry) => entry.address)));
  if (addresses.length === 0) {
    throw new FridaySsrfBlockedError(`SSRF guard: DNS resolution failed for ${hostname}`);
  }

  return {
    hostname: normalized,
    addresses,
    lookup: createPinnedLookup({ hostname: normalized, addresses }),
  };
}

// ─── Factory ───

export function createFridayAgentSsrfGuard(policy?: FridaySsrfPolicy): FridayAgentSsrfGuard {
  const allowPrivateNetwork = Boolean(policy?.allowPrivateNetwork);
  const hostnameAllowlist = normalizeHostnameAllowlist(policy?.hostnameAllowlist);

  return {
    validate(url: string): void {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch (err) {
        console.warn("[friday][agent-ssrf-guard] invalid URL:", err instanceof Error ? err.message : String(err));
        throw new FridaySsrfBlockedError(`SSRF guard: invalid URL — ${url}`);
      }

      // Only allow http/https
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new FridaySsrfBlockedError(`SSRF guard: blocked protocol — ${parsed.protocol}`);
      }

      const hostname = parsed.hostname.toLowerCase();

      // Check hostname allowlist
      const normalizedForAllowlist = normalizeHostname(hostname);
      if (!matchesHostnameAllowlist(normalizedForAllowlist, hostnameAllowlist)) {
        throw new FridaySsrfBlockedError(`SSRF guard: blocked hostname (not in allowlist) — ${hostname}`);
      }

      if (allowPrivateNetwork) {
        return;
      }

      // Check blocked hostnames and suffixes
      if (isBlockedHostname(hostname)) {
        throw new FridaySsrfBlockedError(`SSRF guard: blocked hostname — ${hostname}`);
      }

      // Check if hostname is an IP address — use hextet parsing for IPv6
      if (net.isIPv4(hostname)) {
        if (isPrivateIpv4(hostname)) {
          throw new FridaySsrfBlockedError(`SSRF guard: blocked private IPv4 — ${hostname}`);
        }
      } else {
        // Try stripping brackets for IPv6
        const stripped = hostname.replace(/^\[/, "").replace(/\]$/, "");
        if (stripped.includes(":")) {
          if (isPrivateIpv6(stripped)) {
            throw new FridaySsrfBlockedError(`SSRF guard: blocked private IPv6 — ${hostname}`);
          }
        }
      }
    },

    async validateWithDns(url: string): Promise<void> {
      // P2-SEC: TOCTOU note — DNS is resolved here for validation, but the HTTP client
      // may re-resolve during the actual request. For DNS-rebinding-safe requests, use
      // `resolvePinnedHostname()` + `createPinnedLookup()` which bind validated IPs.
      // Run synchronous checks first
      this.validate(url);

      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      if (allowPrivateNetwork) {
        return;
      }

      // If hostname is already a literal IP, no DNS needed
      if (net.isIPv4(hostname) || net.isIPv6(hostname.replace(/^\[/, "").replace(/\]$/, ""))) {
        return;
      }

      // DNS resolve and check each address
      const addresses = await dnsResolveGuard(hostname);
      for (const addr of addresses) {
        if (isPrivateIp(addr)) {
          throw new FridaySsrfBlockedError(`SSRF guard: DNS resolved to private IP — ${hostname} → ${addr}`);
        }
      }
    },
  };
}
