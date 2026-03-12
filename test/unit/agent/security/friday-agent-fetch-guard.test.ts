import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithFridayAgentSsrfGuard, FridaySsrfBlockedError } from "#agent";
import type { FridayAgentSsrfGuard } from "#agent";

describe("fetchWithFridayAgentSsrfGuard", () => {
  let guard: FridayAgentSsrfGuard;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Create a guard that only blocks known private patterns
    guard = {
      validate: vi.fn((url: string) => {
        if (url.includes("127.0.0.1") || url.includes("private")) {
          throw new FridaySsrfBlockedError("SSRF guard: blocked private IP");
        }
      }),
      validateWithDns: vi.fn(async (url: string) => {
        guard.validate(url);
      }),
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("passes through non-redirect responses", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const response = await fetchWithFridayAgentSsrfGuard({
      url: "https://example.com",
      guard,
    });

    expect(response.status).toBe(200);
    expect(guard.validateWithDns).toHaveBeenCalledWith("https://example.com");
  });

  it("follows valid redirects", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example.com/target" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("final", { status: 200 }),
      );

    const response = await fetchWithFridayAgentSsrfGuard({
      url: "https://example.com",
      guard,
    });

    expect(response.status).toBe(200);
    // Should have validated both the original and redirect target
    expect(guard.validateWithDns).toHaveBeenCalledTimes(2);
  });

  it("blocks redirect to private IP", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/secret" },
      }),
    );

    await expect(fetchWithFridayAgentSsrfGuard({
      url: "https://example.com",
      guard,
    })).rejects.toThrow("blocked private IP");
  });

  it("rejects redirect loops", async () => {
    // Create a redirect that points back to itself
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com" },
      }),
    );

    await expect(fetchWithFridayAgentSsrfGuard({
      url: "https://example.com",
      guard,
    })).rejects.toThrow("redirect loop");
  });

  it("enforces max redirects", async () => {
    let hop = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      hop++;
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: `https://hop${String(hop)}.example.com` },
        }),
      );
    });

    await expect(fetchWithFridayAgentSsrfGuard({
      url: "https://example.com",
      guard,
      options: { maxRedirects: 2 },
    })).rejects.toThrow("too many redirects");
  });

  it("uses redirect: manual in fetch calls", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    await fetchWithFridayAgentSsrfGuard({
      url: "https://example.com",
      guard,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  // ─── maxRedirects validation ───

  it("treats NaN maxRedirects as default (3)", async () => {
    let hop = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      hop++;
      if (hop <= 3) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: `https://hop${String(hop)}.example.com` },
          }),
        );
      }
      return Promise.resolve(new Response("final", { status: 200 }));
    });

    const response = await fetchWithFridayAgentSsrfGuard({
      url: "https://example.com",
      guard,
      options: { maxRedirects: NaN },
    });

    expect(response.status).toBe(200);
  });

  it("treats Infinity maxRedirects as default (3)", async () => {
    let hop = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      hop++;
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: `https://hop${String(hop)}.example.com` },
        }),
      );
    });

    await expect(fetchWithFridayAgentSsrfGuard({
      url: "https://example.com",
      guard,
      options: { maxRedirects: Infinity },
    })).rejects.toThrow("too many redirects");
  });

  it("treats negative maxRedirects as 0 (no redirects allowed)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://other.example.com/" },
      }),
    );

    await expect(fetchWithFridayAgentSsrfGuard({
      url: "https://example.com",
      guard,
      options: { maxRedirects: -5 },
    })).rejects.toThrow("too many redirects");
  });

  it("floors fractional maxRedirects", async () => {
    let hop = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      hop++;
      if (hop <= 2) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: `https://hop${String(hop)}.example.com` },
          }),
        );
      }
      return Promise.resolve(new Response("final", { status: 200 }));
    });

    // 2.9 → floors to 2, should allow exactly 2 redirects
    const response = await fetchWithFridayAgentSsrfGuard({
      url: "https://example.com",
      guard,
      options: { maxRedirects: 2.9 },
    });

    expect(response.status).toBe(200);
  });

  // ─── Body cleanup on redirect ───

  it("cancels response body before following redirect", async () => {
    const cancelFn = vi.fn().mockResolvedValue(undefined);

    // Create a Response-like object with a controllable body.cancel
    const redirectResponse = {
      status: 302,
      ok: false,
      headers: new Headers({ location: "https://other.example.com/target" }),
      body: { cancel: cancelFn } as unknown as ReadableStream,
      redirected: false,
      type: "basic" as ResponseType,
      url: "",
      statusText: "Found",
      bodyUsed: false,
      clone: () => redirectResponse,
      arrayBuffer: async () => new ArrayBuffer(0),
      blob: async () => new Blob(),
      formData: async () => new FormData(),
      json: async () => ({}),
      text: async () => "",
      bytes: async () => new Uint8Array(),
    } as unknown as Response;

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(redirectResponse)
      .mockResolvedValueOnce(
        new Response("final", { status: 200 }),
      );

    const response = await fetchWithFridayAgentSsrfGuard({
      url: "https://example.com",
      guard,
    });

    expect(response.status).toBe(200);
    expect(cancelFn).toHaveBeenCalledTimes(1);
  });

  // ─── Custom fetchFn ───

  it("uses supplied fetchFn instead of global fetch", async () => {
    const customFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("custom", { status: 200 }),
    );
    // Ensure global fetch is NOT called
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("global fetch should not be called"));

    const response = await fetchWithFridayAgentSsrfGuard({
      url: "https://example.com",
      guard,
      fetchFn: customFetch,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("custom");
    expect(customFetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // ─── Typed errors ───

  it("throws FridaySsrfBlockedError for redirect loop", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com" },
      }),
    );

    await expect(fetchWithFridayAgentSsrfGuard({
      url: "https://example.com",
      guard,
    })).rejects.toThrow(FridaySsrfBlockedError);
  });

  it("throws FridaySsrfBlockedError for too many redirects", async () => {
    let hop = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      hop++;
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: `https://hop${String(hop)}.example.com` },
        }),
      );
    });

    await expect(fetchWithFridayAgentSsrfGuard({
      url: "https://example.com",
      guard,
      options: { maxRedirects: 1 },
    })).rejects.toThrow(FridaySsrfBlockedError);
  });
});
