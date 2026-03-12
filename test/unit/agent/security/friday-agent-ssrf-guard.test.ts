import { describe, it, expect } from "vitest";
import {
  createFridayAgentSsrfGuard,
  isPrivateIpv4,
  isPrivateIpv6,
  isPrivateIp,
  FridaySsrfBlockedError,
} from "#agent";

describe("FridayAgentSsrfGuard", () => {
  const guard = createFridayAgentSsrfGuard();

  // ─── Blocked targets ───

  it("blocks localhost", () => {
    expect(() => guard.validate("http://localhost/secret")).toThrow("blocked hostname");
  });

  it("blocks localhost with port", () => {
    expect(() => guard.validate("http://localhost:8080/api")).toThrow("blocked hostname");
  });

  it("blocks 127.0.0.1", () => {
    expect(() => guard.validate("http://127.0.0.1/admin")).toThrow("blocked private IPv4");
  });

  it("blocks 127.0.0.1 with port", () => {
    expect(() => guard.validate("http://127.0.0.1:3000")).toThrow("blocked private IPv4");
  });

  it("blocks 10.x.x.x private range", () => {
    expect(() => guard.validate("http://10.0.0.1/internal")).toThrow("blocked private IPv4");
  });

  it("blocks 172.16.x.x private range", () => {
    expect(() => guard.validate("http://172.16.0.1")).toThrow("blocked private IPv4");
  });

  it("blocks 192.168.x.x private range", () => {
    expect(() => guard.validate("http://192.168.1.1")).toThrow("blocked private IPv4");
  });

  it("blocks 169.254.x.x link-local", () => {
    expect(() => guard.validate("http://169.254.169.254/latest/meta-data")).toThrow("blocked private IPv4");
  });

  it("blocks 0.0.0.0", () => {
    expect(() => guard.validate("http://0.0.0.0")).toThrow("blocked hostname");
  });

  it("blocks cloud metadata endpoint", () => {
    expect(() => guard.validate("http://metadata.google.internal")).toThrow("blocked hostname");
  });

  it("blocks file:// protocol", () => {
    expect(() => guard.validate("file:///etc/passwd")).toThrow("blocked protocol");
  });

  it("blocks ftp:// protocol", () => {
    expect(() => guard.validate("ftp://internal.server")).toThrow("blocked protocol");
  });

  it("throws on invalid URL", () => {
    expect(() => guard.validate("not-a-url")).toThrow("invalid URL");
  });

  // ─── Enhanced blocked targets (IMPL-1) ───

  it("blocks 100.64.0.0/10 CGNAT range", () => {
    expect(() => guard.validate("http://100.64.0.1")).toThrow("blocked private IPv4");
    expect(() => guard.validate("http://100.127.255.255")).toThrow("blocked private IPv4");
  });

  it("blocks .local suffix", () => {
    expect(() => guard.validate("http://my-server.local/api")).toThrow("blocked hostname");
  });

  it("blocks .internal suffix", () => {
    expect(() => guard.validate("http://service.internal/api")).toThrow("blocked hostname");
  });

  it("blocks .localhost suffix", () => {
    expect(() => guard.validate("http://app.localhost:3000")).toThrow("blocked hostname");
  });

  it("blocks 198.18.0.0/15 benchmark testing range", () => {
    expect(() => guard.validate("http://198.18.0.1")).toThrow("blocked private IPv4");
    expect(() => guard.validate("http://198.19.255.255")).toThrow("blocked private IPv4");
  });

  it("blocks class E reserved range (240+)", () => {
    expect(() => guard.validate("http://240.0.0.1")).toThrow("blocked private IPv4");
  });

  // ─── Allowed targets ───

  it("allows public HTTPS URL", () => {
    expect(() => guard.validate("https://api.example.com/v1/data")).not.toThrow();
  });

  it("allows public HTTP URL", () => {
    expect(() => guard.validate("http://example.com")).not.toThrow();
  });

  it("allows public IP (8.8.8.8)", () => {
    expect(() => guard.validate("http://8.8.8.8")).not.toThrow();
  });

  it("allows domain with path and query", () => {
    expect(() => guard.validate("https://api.github.com/repos?page=1")).not.toThrow();
  });

  it("allows 100.63.x.x (just outside CGNAT range)", () => {
    expect(() => guard.validate("http://100.63.255.255")).not.toThrow();
  });

  // ─── Typed errors ───

  it("throws FridaySsrfBlockedError for blocked hostname", () => {
    expect(() => guard.validate("http://localhost/")).toThrow(FridaySsrfBlockedError);
  });

  it("throws FridaySsrfBlockedError for blocked protocol", () => {
    expect(() => guard.validate("file:///etc/passwd")).toThrow(FridaySsrfBlockedError);
  });

  it("throws FridaySsrfBlockedError for blocked private IP", () => {
    expect(() => guard.validate("http://127.0.0.1/")).toThrow(FridaySsrfBlockedError);
  });

  it("throws FridaySsrfBlockedError for invalid URL", () => {
    expect(() => guard.validate("not-a-url")).toThrow(FridaySsrfBlockedError);
  });

  // ─── Policy: allowPrivateNetwork ───

  it("allows localhost when allowPrivateNetwork is true", () => {
    const permissiveGuard = createFridayAgentSsrfGuard({ allowPrivateNetwork: true });
    expect(() => permissiveGuard.validate("http://localhost/")).not.toThrow();
    expect(() => permissiveGuard.validate("http://127.0.0.1/")).not.toThrow();
    expect(() => permissiveGuard.validate("http://10.0.0.1/")).not.toThrow();
  });

  // ─── Policy: hostnameAllowlist ───

  it("blocks hostname not in allowlist", () => {
    const restrictedGuard = createFridayAgentSsrfGuard({ hostnameAllowlist: ["cdn.example.com"] });
    expect(() => restrictedGuard.validate("https://evil.example.org/")).toThrow(/not in allowlist/);
  });

  it("allows hostname in allowlist", () => {
    const restrictedGuard = createFridayAgentSsrfGuard({ hostnameAllowlist: ["cdn.example.com"] });
    expect(() => restrictedGuard.validate("https://cdn.example.com/file.js")).not.toThrow();
  });

  it("supports wildcard hostname allowlist", () => {
    const restrictedGuard = createFridayAgentSsrfGuard({ hostnameAllowlist: ["*.example.com"] });
    expect(() => restrictedGuard.validate("https://cdn.example.com/file.js")).not.toThrow();
    // The bare domain should not match *.example.com
    expect(() => restrictedGuard.validate("https://example.com/file.js")).toThrow(/not in allowlist/);
  });

  // ─── IPv6 with zone IDs ───

  it("blocks IPv6 with zone ID fe80::1%lo0 as private via isPrivateIpv6", () => {
    expect(isPrivateIpv6("fe80::1%lo0")).toBe(true);
  });

  it("blocks IPv6 with zone ID fe80::1%eth0 as private via isPrivateIpv6", () => {
    expect(isPrivateIpv6("fe80::1%eth0")).toBe(true);
  });

  // ─── IPv4-compatible IPv6 ───

  it("blocks ::127.0.0.1 (IPv4-compatible loopback) via isPrivateIpv6", () => {
    expect(isPrivateIpv6("::127.0.0.1")).toBe(true);
  });

  it("blocks ::10.0.0.1 (IPv4-compatible private) via isPrivateIpv6", () => {
    expect(isPrivateIpv6("::10.0.0.1")).toBe(true);
  });

  it("does not block ::8.8.8.8 (IPv4-compatible public) via isPrivateIpv6", () => {
    expect(isPrivateIpv6("::8.8.8.8")).toBe(false);
  });

  // ─── Full form IPv6 parsing ───

  it("blocks 0:0:0:0:0:ffff:7f00:1 (full-form IPv4-mapped loopback)", () => {
    expect(isPrivateIpv6("0:0:0:0:0:ffff:7f00:1")).toBe(true);
  });

  it("blocks 0000:0000:0000:0000:0000:ffff:7f00:0001 (padded full-form)", () => {
    expect(isPrivateIpv6("0000:0000:0000:0000:0000:ffff:7f00:0001")).toBe(true);
  });
});

// ─── IP classification helpers ───

describe("isPrivateIpv4", () => {
  it("classifies 127.x as private", () => {
    expect(isPrivateIpv4("127.0.0.1")).toBe(true);
    expect(isPrivateIpv4("127.255.255.255")).toBe(true);
  });

  it("classifies 10.x as private", () => {
    expect(isPrivateIpv4("10.0.0.1")).toBe(true);
  });

  it("classifies 100.64.0.0/10 as private", () => {
    expect(isPrivateIpv4("100.64.0.1")).toBe(true);
    expect(isPrivateIpv4("100.127.0.1")).toBe(true);
  });

  it("classifies 100.128.0.1 as public", () => {
    expect(isPrivateIpv4("100.128.0.1")).toBe(false);
  });

  it("classifies 8.8.8.8 as public", () => {
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
  });

  it("returns false for invalid input", () => {
    expect(isPrivateIpv4("not-an-ip")).toBe(false);
  });
});

describe("isPrivateIpv6", () => {
  it("classifies ::1 as private", () => {
    expect(isPrivateIpv6("::1")).toBe(true);
  });

  it("classifies :: as private", () => {
    expect(isPrivateIpv6("::")).toBe(true);
  });

  it("classifies fe80:: as private", () => {
    expect(isPrivateIpv6("fe80::1")).toBe(true);
  });

  it("classifies fc00::/fd00:: as private", () => {
    expect(isPrivateIpv6("fc00::1")).toBe(true);
    expect(isPrivateIpv6("fd00::1")).toBe(true);
  });

  it("classifies ::ffff:127.0.0.1 (IPv4-embedded) as private", () => {
    expect(isPrivateIpv6("::ffff:127.0.0.1")).toBe(true);
  });

  it("classifies ::ffff:7f00:1 (hex IPv4-embedded) as private", () => {
    expect(isPrivateIpv6("::ffff:7f00:1")).toBe(true);
  });

  it("classifies ::ffff:8.8.8.8 (IPv4-embedded public) as not private", () => {
    expect(isPrivateIpv6("::ffff:8.8.8.8")).toBe(false);
  });

  it("classifies 2001:db8::1 as not private", () => {
    expect(isPrivateIpv6("2001:db8::1")).toBe(false);
  });

  // ─── Extended fe80::/10 link-local range (IMPL-1 round 2) ───

  it("classifies fe80::1 as private (link-local)", () => {
    expect(isPrivateIpv6("fe80::1")).toBe(true);
  });

  it("classifies fe90::1 as private (within fe80::/10)", () => {
    expect(isPrivateIpv6("fe90::1")).toBe(true);
  });

  it("classifies fea0::1 as private (within fe80::/10)", () => {
    expect(isPrivateIpv6("fea0::1")).toBe(true);
  });

  it("classifies febf::1 as private (upper bound of fe80::/10)", () => {
    expect(isPrivateIpv6("febf::1")).toBe(true);
  });

  // ─── fec0::/10 deprecated site-local ───

  it("classifies fec0::1 as private (deprecated site-local)", () => {
    expect(isPrivateIpv6("fec0::1")).toBe(true);
  });

  it("classifies fed0::1 as private (within fec0::/10)", () => {
    expect(isPrivateIpv6("fed0::1")).toBe(true);
  });

  // ─── IPv4-mapped IPv6 edge cases ───

  it("classifies ::ffff:10.0.0.1 (IPv4-mapped private) as private", () => {
    expect(isPrivateIpv6("::ffff:10.0.0.1")).toBe(true);
  });

  it("classifies ::ffff:192.168.1.1 (IPv4-mapped private) as private", () => {
    expect(isPrivateIpv6("::ffff:192.168.1.1")).toBe(true);
  });

  it("classifies ::ffff:a9fe:a9fe (hex IPv4-mapped 169.254.x) as private", () => {
    expect(isPrivateIpv6("::ffff:a9fe:a9fe")).toBe(true);
  });

  // ─── Public addresses should NOT be private ───

  it("classifies fec0 outside /10 range as not matching if not in range", () => {
    // feff::1 is within fec0::/10 (top of range)
    expect(isPrivateIpv6("feff::1")).toBe(true);
  });

  it("classifies ff00::1 (multicast) as not private", () => {
    // Multicast is not covered by our private ranges
    expect(isPrivateIpv6("ff00::1")).toBe(false);
  });

  // ─── Zone ID stripping ───

  it("strips zone ID from fe80::1%lo0 and classifies as private", () => {
    expect(isPrivateIpv6("fe80::1%lo0")).toBe(true);
  });

  it("strips zone ID from fe80::1%25 and classifies as private", () => {
    expect(isPrivateIpv6("fe80::1%25")).toBe(true);
  });

  it("strips zone ID from fd00::1%eth0 and classifies as private", () => {
    expect(isPrivateIpv6("fd00::1%eth0")).toBe(true);
  });

  // ─── IPv4-compatible (deprecated) ───

  it("classifies ::127.0.0.1 (IPv4-compatible) as private", () => {
    expect(isPrivateIpv6("::127.0.0.1")).toBe(true);
  });

  it("classifies 0:0:0:0:0:0:7f00:1 (IPv4-compatible full-form) as private", () => {
    expect(isPrivateIpv6("0:0:0:0:0:0:7f00:1")).toBe(true);
  });
});

describe("isPrivateIp", () => {
  it("handles IPv4", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });

  it("handles IPv6", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("2001:db8::1")).toBe(false);
  });

  it("handles bracketed IPv6", () => {
    expect(isPrivateIp("[::1]")).toBe(true);
  });

  it("returns false for non-IP strings", () => {
    expect(isPrivateIp("not-an-ip")).toBe(false);
  });

  it("handles IPv6 with zone ID", () => {
    expect(isPrivateIp("fe80::1%lo0")).toBe(true);
  });
});
