import { describe, it, expect } from "vitest";
import {
  createListing,
  createListingVersion,
  submitForReview,
  reviewListing,
  suspendListing,
  reinstateListing,
  archiveListing,
  canTransitionListing,
  LISTING_ERROR_CODES,
} from "../../../../src/marketplace/engine/listing-manager.js";
import type { MarketplaceAuditEvent } from "../../../../src/marketplace/engine/audit-events.js";
import type {
  FridayListing,
  FridayListingVersion,
  FridayPricingPlan,
} from "../../../../src/marketplace/model/friday-marketplace.types.js";
import { fridayMoney } from "../../../../src/marketplace/model/friday-marketplace.types.js";

// ─── Test Helpers ───

let idCounter = 0;

function resetCounter(): void {
  idCounter = 0;
}

function buildDeps(overrides?: {
  emitAuditEvent?: (event: MarketplaceAuditEvent) => void;
  now?: () => string;
}) {
  return {
    generateId: () => `id-${++idCounter}`,
    now: overrides?.now ?? (() => "2026-02-24T12:00:00.000Z"),
    emitAuditEvent: overrides?.emitAuditEvent,
    defaultActor: "system",
  };
}

const freePlan: FridayPricingPlan = { type: "free" };
const paidPlan: FridayPricingPlan = {
  type: "one_time",
  price: fridayMoney(999, "USD"),
};

function baseListing(overrides?: Partial<FridayListing>): FridayListing {
  return {
    id: "listing-1",
    publisherId: "pub-1",
    slug: "test-listing",
    status: "draft",
    currentVersionId: "ver-1",
    pendingVersionId: null,
    tenantId: null,
    tags: ["ai", "agent"],
    createdAt: "2026-02-24T10:00:00.000Z",
    updatedAt: "2026-02-24T10:00:00.000Z",
    ...overrides,
  };
}

function baseVersion(overrides?: Partial<FridayListingVersion>): FridayListingVersion {
  return {
    id: "ver-1",
    listingId: "listing-1",
    versionNumber: 1,
    status: "draft",
    title: "Test Listing",
    description: "A test listing description",
    longDescription: null,
    screenshotUrls: [],
    packageName: "@friday/test-pkg",
    packageVersion: "1.0.0",
    assetType: "agent",
    distributionMode: "declarative_public",
    permissionManifest: {
      permissions: [],
      requiresExplicitApproval: false,
    },
    pricingPlan: freePlan,
    releaseNotes: null,
    createdAt: "2026-02-24T10:00:00.000Z",
    ...overrides,
  };
}

// ─── Tests ───

describe("createListing", () => {
  it("creates a listing with valid input", () => {
    resetCounter();
    const result = createListing(
      {
        publisherId: "pub-1",
        slug: "my-awesome-agent",
        title: "My Awesome Agent",
        description: "The best agent ever",
        packageName: "@friday/awesome-agent",
        packageVersion: "1.0.0",
        assetType: "agent",
        pricingPlan: freePlan,
        tags: ["ai", "productivity"],
      },
      [],
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.listing.slug).toBe("my-awesome-agent");
    expect(result.value.listing.status).toBe("draft");
    expect(result.value.listing.tags).toEqual(["ai", "productivity"]);
    expect(result.value.version.versionNumber).toBe(1);
    expect(result.value.version.status).toBe("draft");
    expect(result.value.version.title).toBe("My Awesome Agent");
    expect(result.value.version.distributionMode).toBe("declarative_public");
    expect(result.value.version.permissionManifest).toEqual({
      permissions: [],
      requiresExplicitApproval: false,
    });
  });

  it("defaults skill listings to legacy executable distribution", () => {
    resetCounter();
    const result = createListing(
      {
        publisherId: "pub-1",
        slug: "legacy-skill",
        title: "Legacy Skill",
        description: "Skill package backed by executable runtime",
        packageName: "@friday/legacy-skill",
        packageVersion: "1.0.0",
        assetType: "skill",
        pricingPlan: freePlan,
      },
      [],
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version.distributionMode).toBe("legacy_executable");
  });

  it("accepts explicit declarative distribution and permission manifest", () => {
    resetCounter();
    const result = createListing(
      {
        publisherId: "pub-1",
        slug: "safe-skill",
        title: "Safe Skill",
        description: "Declarative marketplace skill",
        packageName: "@friday/safe-skill",
        packageVersion: "1.0.0",
        assetType: "skill",
        distributionMode: "declarative_public",
        permissionManifest: {
          permissions: ["system.read", "workflow.deploy"],
          requiresExplicitApproval: true,
        },
        pricingPlan: freePlan,
      },
      [],
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version.distributionMode).toBe("declarative_public");
    expect(result.value.version.permissionManifest).toEqual({
      permissions: ["system.read", "workflow.deploy"],
      requiresExplicitApproval: true,
    });
  });

  it("rejects duplicate slug", () => {
    const result = createListing(
      {
        publisherId: "pub-1",
        slug: "existing-slug",
        title: "New Listing",
        description: "Description",
        packageName: "@friday/pkg",
        packageVersion: "1.0.0",
        assetType: "agent",
        pricingPlan: freePlan,
      },
      ["existing-slug"],
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(LISTING_ERROR_CODES.SLUG_CONFLICT);
  });

  it("rejects invalid slug format", () => {
    const result = createListing(
      {
        publisherId: "pub-1",
        slug: "INVALID_SLUG!",
        title: "Test",
        description: "Test",
        packageName: "@friday/pkg",
        packageVersion: "1.0.0",
        assetType: "agent",
        pricingPlan: freePlan,
      },
      [],
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(LISTING_ERROR_CODES.VALIDATION_FAILED);
  });

  it("rejects empty title", () => {
    const result = createListing(
      {
        publisherId: "pub-1",
        slug: "valid-slug",
        title: "   ",
        description: "Valid description",
        packageName: "@friday/pkg",
        packageVersion: "1.0.0",
        assetType: "agent",
        pricingPlan: freePlan,
      },
      [],
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(LISTING_ERROR_CODES.VALIDATION_FAILED);
  });

  it("rejects description exceeding 280 chars", () => {
    const result = createListing(
      {
        publisherId: "pub-1",
        slug: "valid-slug",
        title: "Valid Title",
        description: "x".repeat(281),
        packageName: "@friday/pkg",
        packageVersion: "1.0.0",
        assetType: "agent",
        pricingPlan: freePlan,
      },
      [],
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(LISTING_ERROR_CODES.VALIDATION_FAILED);
  });

  it("rejects unsupported asset type", () => {
    const result = createListing(
      {
        publisherId: "pub-1",
        slug: "valid-slug",
        title: "Valid Title",
        description: "Valid description",
        packageName: "@friday/pkg",
        packageVersion: "1.0.0",
        assetType: "plugin" as never,
        pricingPlan: freePlan,
      },
      [],
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(LISTING_ERROR_CODES.UNSUPPORTED_ASSET_TYPE);
  });

  it("isolates mutable input references and returns frozen snapshots", () => {
    resetCounter();
    const tags = ["ai"];
    const screenshotUrls = ["https://example.com/1.png"];
    const pricingPlan: FridayPricingPlan = {
      type: "one_time",
      price: fridayMoney(1499, "USD"),
    };

    const result = createListing(
      {
        publisherId: "pub-1",
        slug: "immutable-test",
        title: "Immutable",
        description: "Testing immutable boundaries",
        packageName: "@friday/immutable",
        packageVersion: "1.0.0",
        assetType: "skill",
        pricingPlan,
        tags,
        screenshotUrls,
      },
      [],
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    tags.push("mutated");
    screenshotUrls.push("https://example.com/2.png");
    (pricingPlan as { type: string }).type = "free";

    expect(result.value.listing.tags).toEqual(["ai"]);
    expect(result.value.version.screenshotUrls).toEqual(["https://example.com/1.png"]);
    expect(result.value.version.pricingPlan.type).toBe("one_time");

    expect(Object.isFrozen(result.value.listing)).toBe(true);
    expect(Object.isFrozen(result.value.listing.tags)).toBe(true);
    expect(Object.isFrozen(result.value.version)).toBe(true);
    expect(Object.isFrozen(result.value.version.screenshotUrls)).toBe(true);
    expect(Object.isFrozen(result.value.version.pricingPlan)).toBe(true);
  });
});

describe("createListingVersion", () => {
  it("creates a new version with incremented version number", () => {
    resetCounter();
    const listing = baseListing({ status: "published" });
    const currentVersion = baseVersion();

    const result = createListingVersion(
      listing,
      1,
      { title: "Updated Title", releaseNotes: "Bug fixes" },
      currentVersion,
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version.versionNumber).toBe(2);
    expect(result.value.version.title).toBe("Updated Title");
    expect(result.value.version.releaseNotes).toBe("Bug fixes");
    expect(result.value.version.description).toBe(currentVersion.description);
    expect(result.value.listing.pendingVersionId).toBe(result.value.version.id);
    expect(Object.isFrozen(result.value.version)).toBe(true);
  });

  it("rejects asset type change after publish", () => {
    const listing = baseListing({ status: "published" });
    const currentVersion = baseVersion({ assetType: "agent" });

    const result = createListingVersion(
      listing,
      1,
      { assetType: "workflow" },
      currentVersion,
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(LISTING_ERROR_CODES.ASSET_TYPE_IMMUTABLE);
  });
});

describe("submitForReview", () => {
  it("transitions draft → review", () => {
    const listing = baseListing({ status: "draft" });
    const version = baseVersion({ status: "draft" });
    const result = submitForReview(listing, version, buildDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.listing.status).toBe("review");
    expect(result.value.version.status).toBe("in_review");
    expect(result.value.listing.pendingVersionId).toBe(version.id);
  });

  it("rejects submission from published status", () => {
    const listing = baseListing({ status: "published" });
    const version = baseVersion({ status: "draft" });
    const result = submitForReview(listing, version, buildDeps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(LISTING_ERROR_CODES.INVALID_TRANSITION);
  });

  it("rejects submission of non-draft version", () => {
    const listing = baseListing({ status: "draft" });
    const version = baseVersion({ status: "in_review" });
    const result = submitForReview(listing, version, buildDeps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(LISTING_ERROR_CODES.INVALID_TRANSITION);
  });

  it("rejects submission when version is not owned by listing", () => {
    const listing = baseListing({ status: "draft" });
    const version = baseVersion({ status: "draft", listingId: "listing-2" });
    const result = submitForReview(listing, version, buildDeps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(LISTING_ERROR_CODES.INVALID_TRANSITION);
  });
});

describe("reviewListing", () => {
  it("approves listing: review → published", () => {
    resetCounter();
    const listing = baseListing({ status: "review", pendingVersionId: "ver-1" });
    const version = baseVersion({ status: "in_review" });

    const result = reviewListing(
      listing,
      version,
      { reviewerId: "admin-1", decision: "approved", notes: "LGTM" },
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.listing.status).toBe("published");
    expect(result.value.listing.currentVersionId).toBe("ver-1");
    expect(result.value.listing.pendingVersionId).toBeNull();
    expect(result.value.version.status).toBe("approved");
    expect(result.value.review.decision).toBe("approved");
    expect(result.value.review.notes).toBe("LGTM");
  });

  it("rejects listing: review → draft", () => {
    resetCounter();
    const listing = baseListing({
      status: "review",
      currentVersionId: "prev-ver",
      pendingVersionId: "ver-1",
    });
    const version = baseVersion({ status: "in_review" });

    const result = reviewListing(
      listing,
      version,
      { reviewerId: "admin-1", decision: "rejected", notes: "Fix the description" },
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.listing.status).toBe("draft");
    expect(result.value.listing.currentVersionId).toBe("prev-ver");
    expect(result.value.version.status).toBe("rejected");
    expect(result.value.review.decision).toBe("rejected");
  });

  it("rejects review of non-review listing", () => {
    const listing = baseListing({ status: "draft", pendingVersionId: "ver-1" });
    const version = baseVersion({ status: "in_review" });

    const result = reviewListing(
      listing,
      version,
      { reviewerId: "admin-1", decision: "approved" },
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(LISTING_ERROR_CODES.INVALID_TRANSITION);
  });

  it("rejects review when version does not belong to listing", () => {
    const listing = baseListing({ status: "review", pendingVersionId: "ver-1" });
    const version = baseVersion({ status: "in_review", listingId: "listing-2" });

    const result = reviewListing(
      listing,
      version,
      { reviewerId: "admin-1", decision: "approved" },
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(LISTING_ERROR_CODES.INVALID_TRANSITION);
  });

  it("rejects review when version does not match pendingVersionId", () => {
    const listing = baseListing({ status: "review", pendingVersionId: "ver-pending" });
    const version = baseVersion({ status: "in_review", id: "ver-1" });

    const result = reviewListing(
      listing,
      version,
      { reviewerId: "admin-1", decision: "approved" },
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(LISTING_ERROR_CODES.INVALID_TRANSITION);
  });
});

describe("suspendListing / reinstateListing / archiveListing", () => {
  it("suspends a published listing", () => {
    const listing = baseListing({ status: "published" });
    const result = suspendListing(listing, buildDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("suspended");
  });

  it("cannot suspend a draft listing", () => {
    const listing = baseListing({ status: "draft" });
    const result = suspendListing(listing, buildDeps());

    expect(result.ok).toBe(false);
  });

  it("reinstates a suspended listing", () => {
    const listing = baseListing({ status: "suspended" });
    const result = reinstateListing(listing, buildDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("published");
  });

  it("cannot reinstate a published listing", () => {
    const listing = baseListing({ status: "published" });
    const result = reinstateListing(listing, buildDeps());

    expect(result.ok).toBe(false);
  });

  it("archives a published listing", () => {
    const listing = baseListing({ status: "published" });
    const result = archiveListing(listing, buildDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("archived");
  });

  it("archives a suspended listing", () => {
    const listing = baseListing({ status: "suspended" });
    const result = archiveListing(listing, buildDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("archived");
  });

  it("cannot archive a draft listing", () => {
    const listing = baseListing({ status: "draft" });
    const result = archiveListing(listing, buildDeps());

    expect(result.ok).toBe(false);
  });
});

describe("audit events", () => {
  it("emits transition audit events with from/to state, actor, and timestamp", () => {
    const events: MarketplaceAuditEvent[] = [];

    const listing = baseListing({ status: "draft" });
    const version = baseVersion({ status: "draft" });
    const result = submitForReview(
      listing,
      version,
      buildDeps({ emitAuditEvent: (event) => events.push(event) }),
    );

    expect(result.ok).toBe(true);
    expect(events.length).toBe(2);
    for (const event of events) {
      expect(event.fromState).toBeTruthy();
      expect(event.toState).toBeTruthy();
      expect(event.actor).toBeTruthy();
      expect(event.timestamp).toBe("2026-02-24T12:00:00.000Z");
    }
  });
});

describe("canTransitionListing", () => {
  it("allows valid transitions", () => {
    expect(canTransitionListing("draft", "review")).toBe(true);
    expect(canTransitionListing("review", "published")).toBe(true);
    expect(canTransitionListing("review", "draft")).toBe(true);
    expect(canTransitionListing("published", "suspended")).toBe(true);
    expect(canTransitionListing("published", "archived")).toBe(true);
    expect(canTransitionListing("suspended", "published")).toBe(true);
    expect(canTransitionListing("suspended", "archived")).toBe(true);
  });

  it("disallows invalid transitions", () => {
    expect(canTransitionListing("draft", "published")).toBe(false);
    expect(canTransitionListing("archived", "published")).toBe(false);
    expect(canTransitionListing("archived", "draft")).toBe(false);
  });
});

describe("CSV KPI assertions", () => {
  it("keeps listing publish success rate above 99%", () => {
    const total = 200;
    let success = 0;

    for (let i = 0; i < total; i += 1) {
      const listing = baseListing({
        id: `listing-${i}`,
        status: "review",
        pendingVersionId: `ver-${i}`,
        currentVersionId: `old-${i}`,
      });
      const version = baseVersion({
        id: `ver-${i}`,
        listingId: `listing-${i}`,
        status: "in_review",
      });

      const result = reviewListing(
        listing,
        version,
        { reviewerId: "admin-1", decision: "approved" },
        buildDeps(),
      );

      if (result.ok && result.value.listing.status === "published") {
        success += 1;
      }
    }

    expect(success / total).toBeGreaterThan(0.99);
  });
});
