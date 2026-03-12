import { describe, it, expect, vi } from "vitest";
import { createFridayPluginMarketplaceClient } from "#plugins";
import { FridayDomainError } from "#errors";
import type { FridayPluginManifest } from "#plugins";

function makeManifest(id: string): FridayPluginManifest {
  return {
    schemaVersion: "1.0",
    id,
    version: "1.0.0",
    name: `Plugin ${id}`,
    description: `A test plugin`,
    kinds: ["skill"],
    entrypoints: { skill: "./dist/skill.js" },
    permissions: { grants: [], promptOn: [] },
    compatibility: { minHubVersion: "0.1.0", apiVersion: "1" },
  };
}

function createMockFetch(handler: (url: string) => { status: number; body: unknown; isBuffer?: boolean }) {
  return vi.fn(async (url: string) => {
    const result = handler(url);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body,
      arrayBuffer: async () => {
        if (result.isBuffer && result.body instanceof Buffer) {
          return result.body.buffer.slice(
            result.body.byteOffset,
            result.body.byteOffset + result.body.byteLength,
          );
        }
        return new ArrayBuffer(0);
      },
    } as Response;
  });
}

describe("FridayPluginMarketplaceClient", () => {
  const BASE_URL = "https://marketplace.friday.test";

  // ─── search ───

  it("searches with query parameters", async () => {
    const mockFetch = createMockFetch(() => ({
      status: 200,
      body: { items: [], total: 0 },
    }));

    const client = createFridayPluginMarketplaceClient({
      baseUrl: BASE_URL,
      httpFetch: mockFetch,
    });

    const result = await client.search({ query: "discord", kind: "channel", limit: 10 });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/v1/plugins");
    expect(calledUrl).toContain("q=discord");
    expect(calledUrl).toContain("kind=channel");
    expect(calledUrl).toContain("limit=10");
  });

  it("searches without parameters", async () => {
    const mockFetch = createMockFetch(() => ({
      status: 200,
      body: { items: [{ id: "friday.test.alpha" }], total: 1 },
    }));

    const client = createFridayPluginMarketplaceClient({
      baseUrl: BASE_URL,
      httpFetch: mockFetch,
    });

    const result = await client.search({});
    expect(result.total).toBe(1);
  });

  // ─── getPluginDetail ───

  it("gets plugin detail", async () => {
    const detail = {
      id: "friday.test.alpha",
      name: "Alpha Plugin",
      description: "A test plugin",
      version: "1.0.0",
      author: "Test",
      downloads: 42,
      manifest: makeManifest("friday.test.alpha"),
      checksum: "abc123",
      packageUrl: "https://example.com/package.tar.gz",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const mockFetch = createMockFetch(() => ({
      status: 200,
      body: detail,
    }));

    const client = createFridayPluginMarketplaceClient({
      baseUrl: BASE_URL,
      httpFetch: mockFetch,
    });

    const result = await client.getPluginDetail("friday.test.alpha");
    expect(result.id).toBe("friday.test.alpha");
    expect(result.manifest.id).toBe("friday.test.alpha");
  });

  // ─── downloadPackage ───

  it("downloads a plugin package", async () => {
    const packageData = Buffer.from("plugin-package-data");
    const manifest = makeManifest("friday.test.alpha");
    let callCount = 0;

    const mockFetch = createMockFetch((url) => {
      callCount++;
      if (url.includes("/download")) {
        return { status: 200, body: packageData, isBuffer: true };
      }
      return {
        status: 200,
        body: {
          id: "friday.test.alpha",
          name: "Alpha",
          description: "test",
          version: "1.0.0",
          author: "Test",
          downloads: 0,
          manifest,
          checksum: "checksum-123",
          packageUrl: "url",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      };
    });

    const client = createFridayPluginMarketplaceClient({
      baseUrl: BASE_URL,
      httpFetch: mockFetch,
    });

    const result = await client.downloadPackage("friday.test.alpha");
    expect(result.checksum).toBe("checksum-123");
    expect(result.manifest.id).toBe("friday.test.alpha");
    expect(Buffer.isBuffer(result.packageBytes)).toBe(true);
  });

  // ─── Error handling ───

  it("throws on HTTP error from marketplace", async () => {
    const mockFetch = createMockFetch(() => ({
      status: 500,
      body: { error: "Internal server error" },
    }));

    const client = createFridayPluginMarketplaceClient({
      baseUrl: BASE_URL,
      httpFetch: mockFetch,
    });

    await expect(client.search({})).rejects.toThrow(FridayDomainError);
  });

  it("throws on network error", async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error("Network error");
    });

    const client = createFridayPluginMarketplaceClient({
      baseUrl: BASE_URL,
      httpFetch: mockFetch as unknown as typeof fetch,
    });

    await expect(client.search({})).rejects.toThrow(FridayDomainError);
  });

  it("throws on 404 from marketplace", async () => {
    const mockFetch = createMockFetch(() => ({
      status: 404,
      body: { error: "Not found" },
    }));

    const client = createFridayPluginMarketplaceClient({
      baseUrl: BASE_URL,
      httpFetch: mockFetch,
    });

    await expect(client.getPluginDetail("nonexistent")).rejects.toThrow(FridayDomainError);
  });
});
