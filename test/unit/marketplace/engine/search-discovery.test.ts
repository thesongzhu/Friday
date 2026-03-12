import { describe, it, expect } from "vitest";
import {
  searchListings,
  getFeaturedListings,
  getTrendingListings,
  getListingsByCategory,
  extractCategories,
  getPublisherListings,
} from "../../../../src/marketplace/engine/search-discovery.js";
import type { ListingSearchEntry } from "../../../../src/marketplace/engine/search-discovery.js";
import type {
  FridayListing,
  FridayListingVersion,
  FridayCurrencyCode,
} from "../../../../src/marketplace/model/friday-marketplace.types.js";
import { fridayMoney } from "../../../../src/marketplace/model/friday-marketplace.types.js";

// ─── Test Helpers ───

function makeEntry(
  id: string,
  title: string,
  tags: string[] = [],
  status: FridayListing["status"] = "published",
  purchaseCount: number = 0,
  createdAt: string = "2026-02-24T10:00:00.000Z",
  publisherId: string = "pub-1",
): ListingSearchEntry {
  const listing: FridayListing = {
    id,
    publisherId,
    slug: id,
    status,
    currentVersionId: `ver-${id}`,
    pendingVersionId: null,
    tenantId: null,
    tags,
    createdAt,
    updatedAt: createdAt,
  };

  const version: FridayListingVersion = {
    id: `ver-${id}`,
    listingId: id,
    versionNumber: 1,
    status: "approved",
    title,
    description: `Description for ${title}`,
    longDescription: null,
    screenshotUrls: [],
    packageName: `@friday/${id}`,
    packageVersion: "1.0.0",
    assetType: "agent",
    pricingPlan: { type: "free" },
    releaseNotes: null,
    createdAt,
  };

  return { listing, version, purchaseCount };
}

function sampleEntries(): ListingSearchEntry[] {
  return [
    makeEntry("agent-alpha", "Agent Alpha", ["ai", "productivity"], "published", 100, "2026-02-20T10:00:00.000Z"),
    makeEntry("agent-beta", "Agent Beta", ["ai", "automation"], "published", 50, "2026-02-22T10:00:00.000Z"),
    makeEntry("agent-gamma", "Agent Gamma", ["productivity"], "published", 200, "2026-02-18T10:00:00.000Z"),
    makeEntry("agent-delta", "Agent Delta", ["ai"], "draft", 10, "2026-02-23T10:00:00.000Z"),
    makeEntry("agent-epsilon", "Agent Epsilon", ["ai", "analytics"], "published", 75, "2026-02-24T10:00:00.000Z", "pub-2"),
  ];
}

// ─── Tests ───

describe("searchListings", () => {
  it("returns all entries when no filters", () => {
    const entries = sampleEntries();
    const result = searchListings(entries, {});

    expect(result.total).toBe(5);
    expect(result.items.length).toBe(5);
  });

  it("filters by status", () => {
    const entries = sampleEntries();
    const result = searchListings(entries, { status: "published" });

    expect(result.total).toBe(4);
    expect(result.items.every((e) => e.listing.status === "published")).toBe(true);
  });

  it("filters by publisher", () => {
    const entries = sampleEntries();
    const result = searchListings(entries, { publisherId: "pub-2" });

    expect(result.total).toBe(1);
    expect(result.items[0].listing.publisherId).toBe("pub-2");
  });

  it("filters by tag", () => {
    const entries = sampleEntries();
    const result = searchListings(entries, { tag: "productivity" });

    expect(result.total).toBe(2);
    expect(result.items.every((e) => e.listing.tags.includes("productivity"))).toBe(true);
  });

  it("performs text search on title and description", () => {
    const entries = sampleEntries();
    const result = searchListings(entries, { query: "alpha" });

    expect(result.total).toBe(1);
    expect(result.items[0].version.title).toBe("Agent Alpha");
  });

  it("performs case-insensitive text search", () => {
    const entries = sampleEntries();
    const result = searchListings(entries, { query: "BETA" });

    expect(result.total).toBe(1);
    expect(result.items[0].version.title).toBe("Agent Beta");
  });

  it("performs multi-term text search (AND)", () => {
    const entries = sampleEntries();
    const result = searchListings(entries, { query: "agent alpha" });

    expect(result.total).toBe(1);
    expect(result.items[0].listing.id).toBe("agent-alpha");
  });

  it("sorts by title ascending", () => {
    const entries = sampleEntries();
    const result = searchListings(
      entries,
      { status: "published" },
      { field: "title", direction: "asc" },
    );

    expect(result.items[0].version.title).toBe("Agent Alpha");
    expect(result.items[result.items.length - 1].version.title).toBe("Agent Gamma");
  });

  it("paginates results", () => {
    const entries = sampleEntries();
    const page1 = searchListings(entries, {}, { field: "createdAt", direction: "desc" }, 0, 2);
    const page2 = searchListings(entries, {}, { field: "createdAt", direction: "desc" }, 2, 2);

    expect(page1.items.length).toBe(2);
    expect(page1.hasMore).toBe(true);
    expect(page2.items.length).toBe(2);
    expect(page2.hasMore).toBe(true);
  });
});

describe("getFeaturedListings", () => {
  it("returns top listings by purchase count", () => {
    const entries = sampleEntries();
    const featured = getFeaturedListings(entries, 3);

    expect(featured.length).toBe(3);
    expect(featured[0].listing.id).toBe("agent-gamma"); // 200 purchases
    expect(featured[1].listing.id).toBe("agent-alpha"); // 100 purchases
    expect(featured[2].listing.id).toBe("agent-epsilon"); // 75 purchases
  });

  it("excludes non-published listings", () => {
    const entries = sampleEntries();
    const featured = getFeaturedListings(entries, 10);

    expect(featured.every((e) => e.listing.status === "published")).toBe(true);
    expect(featured.find((e) => e.listing.id === "agent-delta")).toBeUndefined();
  });
});

describe("getTrendingListings", () => {
  it("returns listings weighted by recency and popularity", () => {
    const entries = sampleEntries();
    const trending = getTrendingListings(entries, "2026-02-24T12:00:00.000Z", 3);

    expect(trending.length).toBe(3);
    // Recent + popular listings should rank higher
    expect(trending.every((e) => e.listing.status === "published")).toBe(true);
  });

  it("excludes non-published listings", () => {
    const entries = sampleEntries();
    const trending = getTrendingListings(entries, "2026-02-24T12:00:00.000Z", 10);

    expect(trending.every((e) => e.listing.status === "published")).toBe(true);
  });
});

describe("getListingsByCategory", () => {
  it("returns listings for a specific tag", () => {
    const entries = sampleEntries();
    const result = getListingsByCategory(entries, "ai");

    // ai tag: alpha, beta, epsilon (published), delta excluded (draft)
    expect(result.total).toBe(3);
    expect(result.items.every((e) => e.listing.tags.some((t) => t === "ai"))).toBe(true);
  });

  it("is case-insensitive", () => {
    const entries = sampleEntries();
    const result = getListingsByCategory(entries, "AI");

    expect(result.total).toBe(3);
  });

  it("returns empty for non-existent category", () => {
    const entries = sampleEntries();
    const result = getListingsByCategory(entries, "nonexistent");

    expect(result.total).toBe(0);
    expect(result.items.length).toBe(0);
  });
});

describe("extractCategories", () => {
  it("extracts unique tags with counts from published listings", () => {
    const entries = sampleEntries();
    const categories = extractCategories(entries);

    const aiCategory = categories.find((c) => c.tag === "ai");
    expect(aiCategory).toBeDefined();
    expect(aiCategory!.count).toBe(3); // alpha, beta, epsilon (published)

    const productivityCategory = categories.find((c) => c.tag === "productivity");
    expect(productivityCategory).toBeDefined();
    expect(productivityCategory!.count).toBe(2); // alpha, gamma

    // Sorted by count descending
    expect(categories[0].count).toBeGreaterThanOrEqual(categories[categories.length - 1].count);
  });

  it("excludes non-published listings from counts", () => {
    const entries = sampleEntries();
    const categories = extractCategories(entries);

    // "ai" tag appears on 4 entries but delta is draft, so only 3
    const aiCategory = categories.find((c) => c.tag === "ai");
    expect(aiCategory!.count).toBe(3);
  });
});

describe("getPublisherListings", () => {
  it("returns published listings for a publisher", () => {
    const entries = sampleEntries();
    const result = getPublisherListings(entries, "pub-1");

    // pub-1 has alpha, beta, gamma (published), delta (draft - excluded)
    expect(result.total).toBe(3);
    expect(result.items.every((e) => e.listing.publisherId === "pub-1")).toBe(true);
    expect(result.items.every((e) => e.listing.status === "published")).toBe(true);
  });

  it("includes non-published when requested", () => {
    const entries = sampleEntries();
    const result = getPublisherListings(entries, "pub-1", true);

    expect(result.total).toBe(4); // includes draft delta
  });

  it("returns empty for unknown publisher", () => {
    const entries = sampleEntries();
    const result = getPublisherListings(entries, "pub-unknown");

    expect(result.total).toBe(0);
  });
});
