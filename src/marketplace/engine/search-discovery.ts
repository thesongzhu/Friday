/**
 * Search & Discovery — Listing search, filtering, categories, and trending.
 *
 * Provides in-memory search and filtering capabilities for marketplace
 * listings including text search, tag filtering, pricing type filtering,
 * sorting, and featured/trending computation.
 *
 * @module marketplace/engine/search-discovery
 */

import type {
  FridayListing,
  FridayListingStatus,
  FridayListingVersion,
  FridayPricingPlanType,
  ISODateTime,
  UUID,
} from "../model/friday-marketplace.types.js";

// ─── Search Types ───

/** A denormalized listing summary for search results. */
export interface ListingSearchEntry {
  readonly listing: FridayListing;
  readonly version: FridayListingVersion;
  readonly purchaseCount: number;
}

/** Search filter criteria. */
export interface ListingSearchFilters {
  readonly query?: string;
  readonly status?: FridayListingStatus;
  readonly publisherId?: UUID;
  readonly tag?: string;
  readonly pricingType?: FridayPricingPlanType;
  readonly tenantId?: string | null;
}

/** Sort configuration. */
export interface ListingSearchSort {
  readonly field: "createdAt" | "updatedAt" | "title" | "purchaseCount";
  readonly direction: "asc" | "desc";
}

/** Paginated search result. */
export interface ListingSearchResult {
  readonly items: readonly ListingSearchEntry[];
  readonly total: number;
  readonly hasMore: boolean;
}

// ─── Search Engine ───

/**
 * Searches and filters marketplace listings.
 *
 * Applies filters, text search, sorting, and pagination to a collection
 * of listing search entries.
 */
export function searchListings(
  entries: readonly ListingSearchEntry[],
  filters: ListingSearchFilters,
  sort: ListingSearchSort = { field: "createdAt", direction: "desc" },
  offset: number = 0,
  limit: number = 20,
): ListingSearchResult {
  let results = [...entries];

  // Apply filters
  results = applyFilters(results, filters);

  // Apply text search
  if (filters.query) {
    results = applyTextSearch(results, filters.query);
  }

  // Sort
  results = applySorting(results, sort);

  // Paginate
  const total = results.length;
  const paginated = results.slice(offset, offset + limit);

  return {
    items: paginated,
    total,
    hasMore: offset + limit < total,
  };
}

/**
 * Gets featured listings.
 *
 * Featured listings are published listings with the highest purchase counts.
 */
export function getFeaturedListings(
  entries: readonly ListingSearchEntry[],
  limit: number = 10,
): readonly ListingSearchEntry[] {
  return [...entries]
    .filter((e) => e.listing.status === "published")
    .sort((a, b) => b.purchaseCount - a.purchaseCount)
    .slice(0, limit);
}

/**
 * Gets trending listings.
 *
 * Trending is computed as a weighted score combining recency and purchase count.
 * More recent listings with high purchase counts rank higher.
 */
export function getTrendingListings(
  entries: readonly ListingSearchEntry[],
  referenceTime: ISODateTime,
  limit: number = 10,
): readonly ListingSearchEntry[] {
  const refMs = new Date(referenceTime).getTime();

  return [...entries]
    .filter((e) => e.listing.status === "published")
    .map((entry) => ({
      entry,
      score: computeTrendingScore(entry, refMs),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((scored) => scored.entry);
}

/**
 * Gets listings by category (tag).
 *
 * Returns all published listings that include the specified tag.
 */
export function getListingsByCategory(
  entries: readonly ListingSearchEntry[],
  category: string,
  sort: ListingSearchSort = { field: "purchaseCount", direction: "desc" },
  offset: number = 0,
  limit: number = 20,
): ListingSearchResult {
  const filtered = entries.filter(
    (e) =>
      e.listing.status === "published" &&
      e.listing.tags.some((t) => t.toLowerCase() === category.toLowerCase()),
  );

  const sorted = applySorting([...filtered], sort);
  const total = sorted.length;
  const paginated = sorted.slice(offset, offset + limit);

  return {
    items: paginated,
    total,
    hasMore: offset + limit < total,
  };
}

/**
 * Extracts all unique tags from a collection of listings with their counts.
 *
 * Useful for building a category sidebar or tag cloud.
 */
export function extractCategories(
  entries: readonly ListingSearchEntry[],
): readonly { tag: string; count: number }[] {
  const tagCounts = new Map<string, number>();

  for (const entry of entries) {
    if (entry.listing.status !== "published") continue;
    for (const tag of entry.listing.tags) {
      const normalized = tag.toLowerCase();
      tagCounts.set(normalized, (tagCounts.get(normalized) ?? 0) + 1);
    }
  }

  return [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Gets listings from a specific publisher.
 */
export function getPublisherListings(
  entries: readonly ListingSearchEntry[],
  publisherId: UUID,
  includeNonPublished: boolean = false,
  sort: ListingSearchSort = { field: "createdAt", direction: "desc" },
  offset: number = 0,
  limit: number = 20,
): ListingSearchResult {
  const filtered = entries.filter(
    (e) =>
      e.listing.publisherId === publisherId &&
      (includeNonPublished || e.listing.status === "published"),
  );

  const sorted = applySorting([...filtered], sort);
  const total = sorted.length;
  const paginated = sorted.slice(offset, offset + limit);

  return {
    items: paginated,
    total,
    hasMore: offset + limit < total,
  };
}

// ─── Internal Helpers ───

function applyFilters(
  entries: ListingSearchEntry[],
  filters: ListingSearchFilters,
): ListingSearchEntry[] {
  let results = entries;

  if (filters.status) {
    results = results.filter((e) => e.listing.status === filters.status);
  }

  if (filters.publisherId) {
    results = results.filter((e) => e.listing.publisherId === filters.publisherId);
  }

  if (filters.tag) {
    const normalizedTag = filters.tag.toLowerCase();
    results = results.filter((e) =>
      e.listing.tags.some((t) => t.toLowerCase() === normalizedTag),
    );
  }

  if (filters.pricingType) {
    results = results.filter(
      (e) => e.version.pricingPlan.type === filters.pricingType,
    );
  }

  if (filters.tenantId !== undefined) {
    results = results.filter(
      (e) =>
        e.listing.tenantId === null || e.listing.tenantId === filters.tenantId,
    );
  }

  return results;
}

function applyTextSearch(
  entries: ListingSearchEntry[],
  query: string,
): ListingSearchEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return entries;

  return entries.filter((entry) => {
    const searchable = buildSearchableText(entry);
    return terms.every((term) => searchable.includes(term));
  });
}

function buildSearchableText(entry: ListingSearchEntry): string {
  return [
    entry.version.title,
    entry.version.description,
    entry.version.packageName,
    ...entry.listing.tags,
    entry.listing.slug,
  ]
    .join(" ")
    .toLowerCase();
}

function applySorting(
  entries: ListingSearchEntry[],
  sort: ListingSearchSort,
): ListingSearchEntry[] {
  const multiplier = sort.direction === "asc" ? 1 : -1;

  return entries.sort((a, b) => {
    switch (sort.field) {
      case "createdAt":
        return multiplier * a.listing.createdAt.localeCompare(b.listing.createdAt);
      case "updatedAt":
        return multiplier * a.listing.updatedAt.localeCompare(b.listing.updatedAt);
      case "title":
        return multiplier * a.version.title.localeCompare(b.version.title);
      case "purchaseCount":
        return multiplier * (a.purchaseCount - b.purchaseCount);
      default:
        return 0;
    }
  });
}

/**
 * Computes a trending score that balances recency and popularity.
 *
 * Uses a gravity-based decay formula similar to Hacker News ranking:
 * score = purchaseCount / (age_hours + 2) ^ gravity
 *
 * Higher gravity means faster decay for older listings.
 */
function computeTrendingScore(entry: ListingSearchEntry, referenceTimeMs: number): number {
  const createdMs = new Date(entry.listing.createdAt).getTime();
  const ageHours = Math.max(0, (referenceTimeMs - createdMs) / (1000 * 60 * 60));
  const gravity = 1.5;
  return (entry.purchaseCount + 1) / Math.pow(ageHours + 2, gravity);
}
