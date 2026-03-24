import * as net from "node:net";
import { isPrivateIp } from "../../agent/security/friday-agent-ssrf-guard.js";

export type FridayHttpTrustProxyMode = "off" | "loopback" | "private_network";

export interface ResolveFridayClientIpInput {
  socketIp?: string;
  headers: Record<string, string | undefined>;
  trustProxyMode?: FridayHttpTrustProxyMode;
}

function stripIpv6ZoneId(value: string): string {
  const index = value.indexOf("%");
  return index >= 0 ? value.slice(0, index) : value;
}

export function normalizeFridayClientIp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const first = value.split(",")[0]?.trim();
  if (!first) {
    return undefined;
  }
  const withoutPort = first.startsWith("[")
    ? first.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1")
    : first.includes(":") && first.split(":").length === 2 && first.includes(".")
      ? first.split(":")[0]
      : first;
  const normalized = stripIpv6ZoneId(withoutPort.trim().toLowerCase());
  return normalized.length > 0 ? normalized : undefined;
}

export function isFridayLoopbackAddress(value: string | undefined): boolean {
  const normalized = normalizeFridayClientIp(value);
  if (!normalized) {
    return false;
  }
  return normalized === "localhost"
    || normalized === "localhost.localdomain"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "::ffff:127.0.0.1"
    || normalized.startsWith("127.")
    || normalized.startsWith("::ffff:127.");
}

export function isFridayPrivateNetworkAddress(value: string | undefined): boolean {
  const normalized = normalizeFridayClientIp(value);
  if (!normalized) {
    return false;
  }
  if (isFridayLoopbackAddress(normalized)) {
    return true;
  }
  return isPrivateIp(normalized);
}

function isValidForwardedAddress(value: string | undefined): value is string {
  const normalized = normalizeFridayClientIp(value);
  if (!normalized) {
    return false;
  }
  if (normalized === "localhost" || normalized === "localhost.localdomain") {
    return true;
  }
  return isPrivateIp(normalized) || net.isIP(normalized) !== 0;
}

function shouldTrustProxy(socketIp: string | undefined, trustProxyMode: FridayHttpTrustProxyMode): boolean {
  switch (trustProxyMode) {
    case "off":
      return false;
    case "loopback":
      return isFridayLoopbackAddress(socketIp);
    case "private_network":
      return isFridayPrivateNetworkAddress(socketIp);
    default:
      return false;
  }
}

export function parseFridayHttpTrustProxyMode(value: string | undefined): FridayHttpTrustProxyMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return "off";
  }
  if (normalized === "off" || normalized === "loopback" || normalized === "private_network") {
    return normalized;
  }
  throw new Error(
    `Invalid FRIDAY_HTTP_TRUST_PROXY value: ${value}. Expected one of: off, loopback, private_network.`,
  );
}

export function resolveFridayClientIp(input: ResolveFridayClientIpInput): string | undefined {
  const trustProxyMode = input.trustProxyMode ?? "off";
  const socketIp = normalizeFridayClientIp(input.socketIp);
  if (!shouldTrustProxy(socketIp, trustProxyMode)) {
    return socketIp;
  }

  const forwarded = input.headers["x-forwarded-for"];
  if (forwarded !== undefined) {
    return isValidForwardedAddress(forwarded) ? normalizeFridayClientIp(forwarded) : socketIp;
  }

  const realIp = input.headers["x-real-ip"];
  if (realIp !== undefined) {
    return isValidForwardedAddress(realIp) ? normalizeFridayClientIp(realIp) : socketIp;
  }

  return socketIp;
}
