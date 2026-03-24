import { afterEach, describe, expect, it } from "vitest";
import { createFridayAuthService, FridayAuthError } from "../../../../src/api/auth/friday-auth-service.js";
import {
  parseFridayHttpTrustProxyMode,
  resolveFridayClientIp,
} from "../../../../src/api/http/friday-http-client-ip.js";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

describe("Friday HTTP client IP resolution", () => {
  let db: FridaySqliteLayer | undefined;
  let idCounter = 0;

  afterEach(() => {
    db?.close();
    db = undefined;
    idCounter = 0;
  });

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

  it("does not allow loopback proxies to turn remote clients into localhost auth callers", () => {
    db = createTestDb();
    const service = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => "2025-06-15T10:00:00.000Z",
      tokenSecret: "test-route-secret",
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
      allowLocalBypassLogin: true,
    });

    const clientIp = resolveFridayClientIp({
      socketIp: "127.0.0.1",
      headers: {
        "x-forwarded-for": "203.0.113.20",
      },
      trustProxyMode: "loopback",
    });

    expect(clientIp).toBe("203.0.113.20");
    expect(() => service.login({ local: true }, clientIp)).toThrow(FridayAuthError);
    try {
      service.login({ local: true }, clientIp);
    } catch (err) {
      expect((err as FridayAuthError).code).toBe("PASSWORDLESS_LOCALHOST_ONLY");
    }
  });
});
