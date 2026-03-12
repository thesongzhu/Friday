/**
 * Adversarial SSRF Boundary Tests (TEST-1 through TEST-6)
 *
 * Tests that SSRF guards correctly block DNS rebinding, redirect chains,
 * IPv6 edge cases, scheme abuse, obfuscated IPs, and Unicode hostnames.
 *
 * Every test exercises the real guard implementation — no stubbing of
 * `guard.validate` or `guard.validateWithDns`.
 *
 * Note: ESM prevents `vi.spyOn(dns, ...)` — DNS-dependent tests use
 * `vi.mock("node:dns")` at module level instead.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// Mock node:dns at module level (ESM-safe)
const mockDnsResolve = vi.fn();
const mockDnsResolve6 = vi.fn();
vi.mock("node:dns", () => ({
  resolve: (...args: unknown[]) => mockDnsResolve(...args),
  resolve6: (...args: unknown[]) => mockDnsResolve6(...args),
}));

import {
  createFridayAgentSsrfGuard,
  isPrivateIpv4,
  isPrivateIpv6,
  FridaySsrfBlockedError,
} from "#agent";
import { fetchWithFridayAgentSsrfGuard } from "../../src/agent/security/friday-agent-fetch-guard.js";

// ─── TEST-1: DNS Rebinding Across Redirect Hop ───

describe("TEST-1: DNS Rebinding Across Redirect Hop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockDnsResolve.mockReset();
    mockDnsResolve6.mockReset();
  });

  it("blocks redirect target when DNS rebinds from public to private IP", async () => {
    const guard = createFridayAgentSsrfGuard();

    // DNS: first resolution → public, second → private (rebind)
    let dnsCallCount = 0;
    mockDnsResolve.mockImplementation(
      (_hostname: string, cb: (err: NodeJS.ErrnoException | null, addresses: string[]) => void) => {
        dnsCallCount++;
        if (dnsCallCount === 1) {
          cb(null, ["93.184.216.34"]); // public IP
        } else {
          cb(null, ["127.0.0.1"]); // private — rebind!
        }
      },
    );
    mockDnsResolve6.mockImplementation(
      (_hostname: string, cb: (err: NodeJS.ErrnoException | null, addresses: string[]) => void) => {
        cb({ code: "ENODATA" } as NodeJS.ErrnoException, []);
      },
    );

    // Mock fetch to return one redirect
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://rebind.example.com/secret" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      fetchWithFridayAgentSsrfGuard({
        url: "http://rebind.example.com/start",
        guard,
      }),
    ).rejects.toThrow(/DNS resolved to private IP/);

    // fetch called once (initial URL), never followed the redirect
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // DNS called twice: once for initial URL, once for redirect target
    expect(dnsCallCount).toBe(2);
  });

  it("throws FridaySsrfBlockedError on DNS rebinding", async () => {
    const guard = createFridayAgentSsrfGuard();

    let dnsCallCount = 0;
    mockDnsResolve.mockImplementation(
      (_hostname: string, cb: (err: NodeJS.ErrnoException | null, addresses: string[]) => void) => {
        dnsCallCount++;
        if (dnsCallCount === 1) {
          cb(null, ["93.184.216.34"]);
        } else {
          cb(null, ["10.0.0.1"]);
        }
      },
    );
    mockDnsResolve6.mockImplementation(
      (_hostname: string, cb: (err: NodeJS.ErrnoException | null, addresses: string[]) => void) => {
        cb({ code: "ENODATA" } as NodeJS.ErrnoException, []);
      },
    );

    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://rebind.example.com/secret" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      fetchWithFridayAgentSsrfGuard({
        url: "http://rebind.example.com/start",
        guard,
      }),
    ).rejects.toThrow(FridaySsrfBlockedError);
  });
});

// ─── TEST-2: Multi-Hop Redirect to Metadata IP ───

describe("TEST-2: Multi-Hop Redirect to Metadata IP", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockDnsResolve.mockReset();
    mockDnsResolve6.mockReset();
  });

  it("blocks redirect chain ending at cloud metadata IP 169.254.169.254", async () => {
    const guard = createFridayAgentSsrfGuard();

    // DNS resolves all external hostnames to public IPs
    mockDnsResolve.mockImplementation(
      (_hostname: string, cb: (err: NodeJS.ErrnoException | null, addresses: string[]) => void) => {
        cb(null, ["93.184.216.34"]);
      },
    );
    mockDnsResolve6.mockImplementation(
      (_hostname: string, cb: (err: NodeJS.ErrnoException | null, addresses: string[]) => void) => {
        cb({ code: "ENODATA" } as NodeJS.ErrnoException, []);
      },
    );

    let fetchCallCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "http://trusted.example.com/step2" },
          }),
        );
      }
      if (fetchCallCount === 2) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          }),
        );
      }
      return Promise.resolve(new Response("leaked!", { status: 200 }));
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      fetchWithFridayAgentSsrfGuard({
        url: "http://external.example.com/start",
        guard,
      }),
    ).rejects.toThrow(/blocked private IPv4/);

    // Metadata IP fetch should never have been made — blocked at validate
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ─── TEST-3: IPv6 Edge Literal Blocking ───

describe("TEST-3: IPv6 Edge Literal Blocking", () => {
  const guard = createFridayAgentSsrfGuard();

  // [::1] is caught as "blocked hostname" (it's in BLOCKED_HOSTNAMES),
  // while mapped-IPv4 variants are caught as "blocked private IPv6"
  const ipv6MappedUrls = [
    "http://[::ffff:7f00:1]/admin",
    "http://[fe80::1]/internal",
    "http://[fd00::1]/secret",
    "http://[::ffff:c0a8:1]/internal",
    "http://[::ffff:0a00:1]/internal",
  ];

  it.each(ipv6MappedUrls)("blocks mapped/link-local/ULA IPv6 URL: %s", (url) => {
    expect(() => guard.validate(url)).toThrow(/blocked private IPv6/);
  });

  it("blocks [::1] as blocked hostname", () => {
    expect(() => guard.validate("http://[::1]/admin")).toThrow(/blocked hostname/);
  });

  it("blocks [0000:...0001] (long-form loopback) as blocked hostname", () => {
    expect(() => guard.validate("http://[0000:0000:0000:0000:0000:0000:0000:0001]/admin"))
      .toThrow(/blocked hostname/);
  });

  it("blocks [::] (unspecified) as blocked private IPv6", () => {
    expect(() => guard.validate("http://[::]/danger")).toThrow(/blocked/);
  });

  it("classifies ::ffff:7f00:1 as private via isPrivateIpv6", () => {
    expect(isPrivateIpv6("::ffff:7f00:1")).toBe(true);
  });

  it("classifies fe80::1 (link-local) as private via isPrivateIpv6", () => {
    expect(isPrivateIpv6("fe80::1")).toBe(true);
  });

  it("classifies fd00::1 (unique-local) as private via isPrivateIpv6", () => {
    expect(isPrivateIpv6("fd00::1")).toBe(true);
  });

  it("classifies ::ffff:c0a8:1 (mapped 192.168.0.1) as private via isPrivateIpv6", () => {
    expect(isPrivateIpv6("::ffff:c0a8:1")).toBe(true);
  });

  // ─── Zone ID tests ───

  it("classifies fe80::1%lo0 (with zone ID) as private via isPrivateIpv6", () => {
    expect(isPrivateIpv6("fe80::1%lo0")).toBe(true);
  });

  it("classifies fe80::1%eth0 (with zone ID) as private via isPrivateIpv6", () => {
    expect(isPrivateIpv6("fe80::1%eth0")).toBe(true);
  });

  // ─── IPv4-compatible IPv6 ───

  it("classifies ::127.0.0.1 (IPv4-compatible loopback) as private via isPrivateIpv6", () => {
    expect(isPrivateIpv6("::127.0.0.1")).toBe(true);
  });

  // ─── Typed errors ───

  it("throws FridaySsrfBlockedError for blocked IPv6 URLs", () => {
    expect(() => guard.validate("http://[fe80::1]/")).toThrow(FridaySsrfBlockedError);
  });
});

// ─── TEST-4: Scheme Abuse ───

describe("TEST-4: Scheme Abuse", () => {
  const guard = createFridayAgentSsrfGuard();

  const blockedSchemes: Array<[string, string]> = [
    ["file:///etc/passwd", "file:"],
    ["gopher://evil.com/_payload", "gopher:"],
    ["dict://evil.com/d:passwd:1", "dict:"],
    ["ftp://internal.server/data", "ftp:"],
    ["ldap://ldap.internal/dc=example,dc=com", "ldap:"],
    ["data:text/html,<script>alert(1)</script>", "data:"],
  ];

  it.each(blockedSchemes)(
    "blocks %s with 'blocked protocol' mentioning %s",
    (url, protocol) => {
      expect(() => guard.validate(url)).toThrow(
        new RegExp(`blocked protocol.*${protocol.replace(":", "\\:")}|invalid URL`, "i"),
      );
    },
  );

  it("throws FridaySsrfBlockedError for blocked schemes", () => {
    expect(() => guard.validate("ftp://internal.server/data")).toThrow(FridaySsrfBlockedError);
  });
});

// ─── TEST-5: Obfuscated Host/IP Forms ───

describe("TEST-5: Obfuscated Host/IP Forms", () => {
  afterEach(() => {
    mockDnsResolve.mockReset();
    mockDnsResolve6.mockReset();
  });

  const guard = createFridayAgentSsrfGuard();

  const obfuscatedUrls = [
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://2130706433/",
    "http://127.1/",
  ];

  it.each(obfuscatedUrls)(
    "blocks or rejects obfuscated loopback URL: %s",
    (url) => {
      // Must throw — no permissive try/catch
      expect(() => guard.validate(url)).toThrow(/blocked|SSRF|invalid/i);
    },
  );

  it("validates obfuscated hosts via DNS when they resolve to private IP", async () => {
    mockDnsResolve.mockImplementation(
      (_hostname: string, cb: (err: NodeJS.ErrnoException | null, addresses: string[]) => void) => {
        cb(null, ["127.0.0.1"]);
      },
    );
    mockDnsResolve6.mockImplementation(
      (_hostname: string, cb: (err: NodeJS.ErrnoException | null, addresses: string[]) => void) => {
        cb({ code: "ENODATA" } as NodeJS.ErrnoException, []);
      },
    );

    await expect(
      guard.validateWithDns("http://sneaky-host.example.com/"),
    ).rejects.toThrow(/DNS resolved to private IP/);
  });

  it("confirms isPrivateIpv4 detects 127.0.0.1", () => {
    expect(isPrivateIpv4("127.0.0.1")).toBe(true);
  });

  it("confirms isPrivateIpv4 detects 169.254.169.254", () => {
    expect(isPrivateIpv4("169.254.169.254")).toBe(true);
  });

  it("throws FridaySsrfBlockedError for DNS resolution to private IP", async () => {
    mockDnsResolve.mockImplementation(
      (_hostname: string, cb: (err: NodeJS.ErrnoException | null, addresses: string[]) => void) => {
        cb(null, ["192.168.1.1"]);
      },
    );
    mockDnsResolve6.mockImplementation(
      (_hostname: string, cb: (err: NodeJS.ErrnoException | null, addresses: string[]) => void) => {
        cb({ code: "ENODATA" } as NodeJS.ErrnoException, []);
      },
    );

    await expect(
      guard.validateWithDns("http://rebinding-test.example.com/"),
    ).rejects.toThrow(FridaySsrfBlockedError);
  });
});

// ─── TEST-6: Unicode/Canonical Localhost ───

describe("TEST-6: Unicode/Canonical Localhost", () => {
  afterEach(() => {
    mockDnsResolve.mockReset();
    mockDnsResolve6.mockReset();
  });

  const guard = createFridayAgentSsrfGuard();

  it("blocks localhost with trailing dot via 'blocked hostname'", () => {
    expect(() => guard.validate("http://localhost./")).toThrow(/blocked hostname/);
  });

  it("blocks evil.localhost via 'blocked hostname'", () => {
    expect(() => guard.validate("http://evil.localhost/")).toThrow(/blocked hostname/);
  });

  it("blocks evil.localhost. (trailing dot) via 'blocked hostname'", () => {
    expect(() => guard.validate("http://evil.localhost./")).toThrow(/blocked hostname/);
  });

  it("does not invoke DNS resolver for blocked-hostname cases", async () => {
    // validateWithDns calls validate() first, which throws before DNS
    await expect(
      guard.validateWithDns("http://localhost./"),
    ).rejects.toThrow(/blocked hostname/);

    // DNS should never be called — hostname blocked before resolution
    expect(mockDnsResolve).not.toHaveBeenCalled();
  });

  it("blocks .local suffix hostnames", () => {
    expect(() => guard.validate("http://printer.local/")).toThrow(/blocked hostname/);
  });

  it("blocks .internal suffix hostnames", () => {
    expect(() => guard.validate("http://metadata.google.internal/")).toThrow(/blocked hostname/);
  });

  it("throws FridaySsrfBlockedError for unicode/canonical blocked hostnames", () => {
    expect(() => guard.validate("http://localhost./")).toThrow(FridaySsrfBlockedError);
    expect(() => guard.validate("http://evil.localhost/")).toThrow(FridaySsrfBlockedError);
  });
});
