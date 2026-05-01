import { describe, expect, it } from "vitest";
import {
  parseFridayHttpTrustProxyMode,
  resolveFridayClientIp,
} from "../../../../src/api/http/friday-http-client-ip.js";

describe("Friday HTTP client IP resolution", () => {
  it("defaults to off when the env var is unset", () => {
    expect(parseFridayHttpTrustProxyMode(undefined)).toBe("off");
    expect(parseFridayHttpTrustProxyMode("")).toBe("off");
  });

  it("rejects unsupported trust proxy values", () => {
    expect(() => parseFridayHttpTrustProxyMode("always")).toThrow(
      "Invalid FRIDAY_HTTP_TRUST_PROXY value",
    );
  });

  it("ignores forwarded headers when trust proxy mode is off", () => {
    expect(resolveFridayClientIp({
      socketIp: "127.0.0.1",
      headers: {
        "x-forwarded-for": "203.0.113.20",
        "x-real-ip": "203.0.113.21",
      },
      trustProxyMode: "off",
    })).toBe("127.0.0.1");
  });

  it("trusts forwarded headers from loopback proxies", () => {
    expect(resolveFridayClientIp({
      socketIp: "127.0.0.1",
      headers: {
        "x-forwarded-for": "203.0.113.20, 127.0.0.1",
      },
      trustProxyMode: "loopback",
    })).toBe("203.0.113.20");
  });

  it("trusts private-network proxies and falls back to x-real-ip when x-forwarded-for is absent", () => {
    expect(resolveFridayClientIp({
      socketIp: "10.0.0.2",
      headers: {
        "x-real-ip": "198.51.100.25",
      },
      trustProxyMode: "private_network",
    })).toBe("198.51.100.25");
  });

  it("falls back to the socket IP when forwarded headers are invalid", () => {
    expect(resolveFridayClientIp({
      socketIp: "127.0.0.1",
      headers: {
        "x-forwarded-for": "not-an-ip",
        "x-real-ip": "203.0.113.25",
      },
      trustProxyMode: "loopback",
    })).toBe("127.0.0.1");
  });

  it("resolves loopback-proxied remote clients as remote addresses", () => {
    const clientIp = resolveFridayClientIp({
      socketIp: "127.0.0.1",
      headers: {
        "x-forwarded-for": "203.0.113.20",
      },
      trustProxyMode: "loopback",
    });

    expect(clientIp).toBe("203.0.113.20");
  });
});
