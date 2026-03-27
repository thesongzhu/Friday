import { FridayDomainError } from "#errors";
import { URL } from "node:url";

// ─── Constants ───

/** Default allowed URL schemes. */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Exact loopback hostnames / IPs to block. */
const LOOPBACK_EXACT = new Set([
  "::1",
  "[::1]",
  "0.0.0.0",
  "localhost",
]);

/** Private IPv4 CIDR ranges (RFC 1918 + link-local). */
const PRIVATE_IPV4_RANGES: Array<{ prefix: number; mask: number }> = [
  { prefix: 0x0A000000, mask: 0xFF000000 }, // 10.0.0.0/8
  { prefix: 0xAC100000, mask: 0xFFF00000 }, // 172.16.0.0/12
  { prefix: 0xC0A80000, mask: 0xFFFF0000 }, // 192.168.0.0/16
  { prefix: 0xA9FE0000, mask: 0xFFFF0000 }, // 169.254.0.0/16 (link-local)
];

// ─── Types ───

export interface GatewayValidationOptions {
  /** Additional allowed hostnames (beyond standard safe hosts). */
  allowedHosts?: string[];
  /** Whether to allow loopback addresses (default: false). */
  allowLoopback?: boolean;
  /** Whether to allow private/internal addresses (default: false). */
  allowPrivate?: boolean;
  /** Custom allowed schemes (default: http, https). */
  allowedSchemes?: string[];
}

export interface GatewayValidationResult {
  valid: boolean;
  url?: URL;
  error?: string;
}

// ─── Validation ───

/**
 * Validate and parse a gateway URL.
 * Checks for valid scheme, non-loopback, non-private IP, etc.
 */
export function validateGatewayUrl(
  rawUrl: string,
  options?: GatewayValidationOptions,
): GatewayValidationResult {
  // 1. Parse URL
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (err) {
    console.warn("[friday][agent-gateway-validation] invalid URL:", err instanceof Error ? err.message : String(err));
    return { valid: false, error: `Invalid URL: '${rawUrl}'` };
  }

  // 2. Check scheme
  const schemes = options?.allowedSchemes
    ? new Set(options.allowedSchemes.map((s) => s.endsWith(":") ? s : `${s}:`))
    : ALLOWED_SCHEMES;
  if (!schemes.has(url.protocol)) {
    return { valid: false, error: `Disallowed URL scheme: '${url.protocol}'` };
  }

  // 3. Check loopback
  if (!options?.allowLoopback) {
    const hostname = url.hostname.toLowerCase();
    if (isLoopbackAddress(hostname)) {
      return { valid: false, error: `Loopback address not allowed: '${hostname}'` };
    }
  }

  // 4. Check private IPs
  if (!options?.allowPrivate) {
    const hostname = url.hostname;
    if (isPrivateIpAddress(hostname)) {
      return { valid: false, error: `Private IP address not allowed: '${hostname}'` };
    }
  }

  // 5. Check allowlist if provided
  if (options?.allowedHosts && options.allowedHosts.length > 0) {
    const hostname = url.hostname.toLowerCase();
    const allowed = options.allowedHosts.some((h) => h.toLowerCase() === hostname);
    if (!allowed) {
      return { valid: false, error: `Host '${hostname}' not in allowlist` };
    }
  }

  return { valid: true, url };
}

/**
 * Parse and normalize a gateway URL, returning the URL object or throwing.
 */
export function parseGatewayUrl(
  rawUrl: string,
  options?: GatewayValidationOptions,
): URL {
  const result = validateGatewayUrl(rawUrl, options);
  if (!result.valid || !result.url) {
    throw new FridayDomainError("VALIDATION_ERROR", result.error ?? `Invalid gateway URL: '${rawUrl}'`, { httpStatus: 400 });
  }
  return result.url;
}

/**
 * Normalize gateway options with sensible defaults.
 */
export function normalizeGatewayOptions(
  options?: Partial<GatewayValidationOptions>,
): GatewayValidationOptions {
  return {
    allowedHosts: options?.allowedHosts ?? [],
    allowLoopback: options?.allowLoopback ?? false,
    allowPrivate: options?.allowPrivate ?? false,
    allowedSchemes: options?.allowedSchemes ?? ["http", "https"],
  };
}

// ─── Internal helpers ───

/**
 * Normalize a hostname by stripping brackets and IPv4-mapped IPv6 prefix.
 * Handles both dotted and hex forms:
 *   "[::ffff:127.0.0.1]" → "127.0.0.1"
 *   "[::ffff:7f00:1]"    → "127.0.0.1"  (Node URL parser hex form)
 */
function normalizeHostname(hostname: string): string {
  // Strip surrounding brackets (e.g. [::ffff:127.0.0.1])
  let h = hostname.replace(/^\[|\]$/g, "");
  // Strip IPv4-mapped IPv6 prefix
  if (h.toLowerCase().startsWith("::ffff:")) {
    h = h.slice(7);
    // If remaining part looks like hex IPv4 (e.g. "7f00:1"), convert to dotted decimal
    const hexMatch = /^([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4})$/.exec(h);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1], 16);
      const lo = parseInt(hexMatch[2], 16);
      h = `${(hi >> 8) & 0xFF}.${hi & 0xFF}.${(lo >> 8) & 0xFF}.${lo & 0xFF}`;
    }
  }
  return h;
}

/**
 * Check whether a hostname is a loopback address.
 * Covers the full 127.0.0.0/8 range, IPv6 ::1, 0.0.0.0, and "localhost".
 * Also handles IPv4-mapped IPv6 forms like ::ffff:127.0.0.1.
 */
function isLoopbackAddress(hostname: string): boolean {
  if (LOOPBACK_EXACT.has(hostname)) return true;
  const normalized = normalizeHostname(hostname);
  if (LOOPBACK_EXACT.has(normalized)) return true;
  // Block entire 127.0.0.0/8 range
  if (normalized.startsWith("127.")) return true;
  return false;
}

function isPrivateIpAddress(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  // Quick check for common patterns
  if (normalized.startsWith("10.") || normalized.startsWith("192.168.") || normalized.startsWith("169.254.")) {
    return true;
  }
  if (normalized.startsWith("172.")) {
    const parts = normalized.split(".");
    if (parts.length === 4) {
      const second = parseInt(parts[1], 10);
      if (second >= 16 && second <= 31) return true;
    }
  }

  // Full numeric check
  const parts = normalized.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const octets = parts.map((p) => parseInt(p, 10));
    if (octets.some((o) => o < 0 || o > 255)) return false;

    const ip32 = (octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3];

    for (const range of PRIVATE_IPV4_RANGES) {
      if ((ip32 & range.mask) === range.prefix) {
        return true;
      }
    }
  }

  return false;
}
