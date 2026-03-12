import { describe, it, expect } from "vitest";
import {
  validateGatewayUrl,
  parseGatewayUrl,
  normalizeGatewayOptions,
} from "#agent";

describe("FridayAgentGatewayValidation", () => {
  // ─── validateGatewayUrl ───

  describe("validateGatewayUrl", () => {
    it("validates a normal https URL", () => {
      const result = validateGatewayUrl("https://api.example.com/v1");
      expect(result.valid).toBe(true);
      expect(result.url?.hostname).toBe("api.example.com");
    });

    it("validates a normal http URL", () => {
      const result = validateGatewayUrl("http://myserver.com:8080/path");
      expect(result.valid).toBe(true);
    });

    it("rejects invalid URL", () => {
      const result = validateGatewayUrl("not-a-url");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid URL");
    });

    it("rejects file:// scheme", () => {
      const result = validateGatewayUrl("file:///etc/passwd");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Disallowed URL scheme");
    });

    it("rejects ftp:// scheme", () => {
      const result = validateGatewayUrl("ftp://files.example.com");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Disallowed URL scheme");
    });

    // ─── Loopback ───

    it("rejects localhost by default", () => {
      const result = validateGatewayUrl("http://localhost:3000");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Loopback");
    });

    it("rejects 127.0.0.1 by default", () => {
      const result = validateGatewayUrl("http://127.0.0.1:8080");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Loopback");
    });

    it("rejects ::1 by default", () => {
      const result = validateGatewayUrl("http://[::1]:3000");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Loopback");
    });

    it("rejects 127.0.0.2 (full loopback /8 range)", () => {
      const result = validateGatewayUrl("http://127.0.0.2:8080");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Loopback");
    });

    it("rejects 127.1.2.3 (full loopback /8 range)", () => {
      const result = validateGatewayUrl("http://127.1.2.3");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Loopback");
    });

    it("rejects 127.255.255.255 (end of loopback range)", () => {
      const result = validateGatewayUrl("http://127.255.255.255");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Loopback");
    });

    it("rejects 0.0.0.0 by default", () => {
      const result = validateGatewayUrl("http://0.0.0.0:8080");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Loopback");
    });

    it("rejects IPv4-mapped IPv6 loopback ::ffff:127.0.0.1", () => {
      const result = validateGatewayUrl("http://[::ffff:127.0.0.1]:8080");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Loopback");
    });

    it("rejects IPv4-mapped IPv6 loopback ::ffff:127.1.2.3", () => {
      const result = validateGatewayUrl("http://[::ffff:127.1.2.3]");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Loopback");
    });

    it("rejects IPv4-mapped IPv6 private ::ffff:10.0.0.1", () => {
      const result = validateGatewayUrl("http://[::ffff:10.0.0.1]");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Private IP");
    });

    it("rejects IPv4-mapped IPv6 private ::ffff:192.168.1.1", () => {
      const result = validateGatewayUrl("http://[::ffff:192.168.1.1]");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Private IP");
    });

    it("allows localhost when allowLoopback=true", () => {
      const result = validateGatewayUrl("http://localhost:3000", { allowLoopback: true });
      expect(result.valid).toBe(true);
    });

    // ─── Private IPs ───

    it("rejects 10.x.x.x by default", () => {
      const result = validateGatewayUrl("http://10.0.0.1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Private IP");
    });

    it("rejects 192.168.x.x by default", () => {
      const result = validateGatewayUrl("http://192.168.1.1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Private IP");
    });

    it("rejects 172.16.x.x by default", () => {
      const result = validateGatewayUrl("http://172.16.0.1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Private IP");
    });

    it("rejects 169.254.x.x (link-local) by default", () => {
      const result = validateGatewayUrl("http://169.254.1.1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Private IP");
    });

    it("allows 172.15.x.x (not in private range)", () => {
      const result = validateGatewayUrl("http://172.15.0.1");
      expect(result.valid).toBe(true);
    });

    it("allows 172.32.x.x (not in private range)", () => {
      const result = validateGatewayUrl("http://172.32.0.1");
      expect(result.valid).toBe(true);
    });

    it("allows private IPs when allowPrivate=true", () => {
      const result = validateGatewayUrl("http://10.0.0.1", { allowPrivate: true });
      expect(result.valid).toBe(true);
    });

    // ─── Allowlist ───

    it("rejects host not in allowlist", () => {
      const result = validateGatewayUrl("https://evil.com", {
        allowedHosts: ["api.example.com"],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not in allowlist");
    });

    it("allows host in allowlist", () => {
      const result = validateGatewayUrl("https://api.example.com/v1", {
        allowedHosts: ["api.example.com"],
      });
      expect(result.valid).toBe(true);
    });

    it("allowlist is case-insensitive", () => {
      const result = validateGatewayUrl("https://API.EXAMPLE.COM", {
        allowedHosts: ["api.example.com"],
      });
      expect(result.valid).toBe(true);
    });

    // ─── Custom schemes ───

    it("supports custom allowed schemes", () => {
      const result = validateGatewayUrl("ws://stream.example.com", {
        allowedSchemes: ["ws", "wss"],
      });
      expect(result.valid).toBe(true);
    });
  });

  // ─── parseGatewayUrl ───

  describe("parseGatewayUrl", () => {
    it("returns URL object for valid URL", () => {
      const url = parseGatewayUrl("https://api.example.com/v1");
      expect(url.hostname).toBe("api.example.com");
      expect(url.pathname).toBe("/v1");
    });

    it("throws for invalid URL", () => {
      expect(() => parseGatewayUrl("not-a-url")).toThrow("Invalid URL");
    });

    it("throws for loopback", () => {
      expect(() => parseGatewayUrl("http://127.0.0.1")).toThrow("Loopback");
    });
  });

  // ─── normalizeGatewayOptions ───

  describe("normalizeGatewayOptions", () => {
    it("returns defaults when no options", () => {
      const opts = normalizeGatewayOptions();
      expect(opts.allowLoopback).toBe(false);
      expect(opts.allowPrivate).toBe(false);
      expect(opts.allowedHosts).toEqual([]);
      expect(opts.allowedSchemes).toEqual(["http", "https"]);
    });

    it("preserves provided options", () => {
      const opts = normalizeGatewayOptions({
        allowLoopback: true,
        allowedHosts: ["foo.com"],
      });
      expect(opts.allowLoopback).toBe(true);
      expect(opts.allowedHosts).toEqual(["foo.com"]);
      expect(opts.allowPrivate).toBe(false);
    });
  });
});
