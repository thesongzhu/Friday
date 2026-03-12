/**
 * Listing Manager — Create, update, version, and review workflow.
 *
 * Manages listing lifecycle state machine (draft → review → published →
 * suspended → archived) with immutable versioning and review workflow.
 *
 * @module marketplace/engine/listing-manager
 */

import {
  FRIDAY_LISTING_STATE_TRANSITIONS,
  FRIDAY_MARKETPLACE_ASSET_TYPES,
  FRIDAY_MARKETPLACE_DISTRIBUTION_MODES,
} from "../model/friday-marketplace.types.js";
import { MARKETPLACE_SYSTEM_ACTOR } from "./audit-events.js";

import type {
  FridayListing,
  FridayListingReview,
  FridayListingReviewDecision,
  FridayListingStatus,
  FridayListingVersion,
  FridayListingVersionStatus,
  FridayMarketplaceAssetType,
  FridayMarketplaceDistributionMode,
  FridayMarketplacePermissionManifest,
  FridayPricingPlan,
  ISODateTime,
  UUID,
} from "../model/friday-marketplace.types.js";
import type {
  MarketplaceAuditEntityType,
  MarketplaceAuditEventMetadata,
  MarketplaceAuditEventSink,
} from "./audit-events.js";

// ─── Error Types ───

export const LISTING_ERROR_CODES = {
  NOT_FOUND: "LISTING_NOT_FOUND",
  VERSION_NOT_FOUND: "LISTING_VERSION_NOT_FOUND",
  INVALID_TRANSITION: "LISTING_INVALID_TRANSITION",
  SLUG_CONFLICT: "LISTING_SLUG_CONFLICT",
  NOT_PUBLISHABLE: "LISTING_NOT_PUBLISHABLE",
  VALIDATION_FAILED: "LISTING_VALIDATION_FAILED",
  UNSUPPORTED_ASSET_TYPE: "LISTING_UNSUPPORTED_ASSET_TYPE",
  ASSET_TYPE_IMMUTABLE: "LISTING_ASSET_TYPE_IMMUTABLE",
} as const;

export type ListingErrorCode =
  (typeof LISTING_ERROR_CODES)[keyof typeof LISTING_ERROR_CODES];

export interface ListingError {
  readonly code: ListingErrorCode;
  readonly message: string;
}

export type ListingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ListingError };

// ─── Input Types ───

export interface CreateListingInput {
  readonly publisherId: UUID;
  readonly slug: string;
  readonly assetType: FridayMarketplaceAssetType;
  readonly title: string;
  readonly description: string;
  readonly longDescription?: string;
  readonly screenshotUrls?: readonly string[];
  readonly packageName: string;
  readonly packageVersion: string;
  readonly distributionMode?: FridayMarketplaceDistributionMode;
  readonly permissionManifest?: FridayMarketplacePermissionManifest;
  readonly pricingPlan: FridayPricingPlan;
  readonly tags?: readonly string[];
  readonly tenantId?: string;
  readonly releaseNotes?: string;
}

export interface UpdateListingInput {
  readonly assetType?: FridayMarketplaceAssetType;
  readonly title?: string;
  readonly description?: string;
  readonly longDescription?: string;
  readonly screenshotUrls?: readonly string[];
  readonly packageVersion?: string;
  readonly distributionMode?: FridayMarketplaceDistributionMode;
  readonly permissionManifest?: FridayMarketplacePermissionManifest;
  readonly pricingPlan?: FridayPricingPlan;
  readonly tags?: readonly string[];
  readonly releaseNotes?: string;
}

export interface ReviewListingInput {
  readonly reviewerId: string;
  readonly decision: FridayListingReviewDecision;
  readonly notes?: string;
}

// ─── Deps ───

export interface ListingDeps {
  readonly generateId: () => UUID;
  readonly now: () => ISODateTime;
  readonly emitAuditEvent?: MarketplaceAuditEventSink;
  readonly defaultActor?: string;
}

// ─── Slug Validation ───

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

// ─── Description Length Limit ───

const MAX_DESCRIPTION_LENGTH = 280;

const EMPTY_PERMISSION_MANIFEST: FridayMarketplacePermissionManifest = Object.freeze({
  permissions: [],
  requiresExplicitApproval: false,
});

function defaultDistributionMode(
  assetType: FridayMarketplaceAssetType,
): FridayMarketplaceDistributionMode {
  return assetType === "skill" ? "legacy_executable" : "declarative_public";
}

function normalizePermissionManifest(
  manifest: FridayMarketplacePermissionManifest | undefined,
): FridayMarketplacePermissionManifest {
  if (!manifest) {
    return EMPTY_PERMISSION_MANIFEST;
  }
  return {
    permissions: [...manifest.permissions],
    requiresExplicitApproval: manifest.requiresExplicitApproval,
  };
}

function validateDistributionMode(
  distributionMode: FridayMarketplaceDistributionMode,
): ListingResult<FridayMarketplaceDistributionMode> {
  if (
    !(FRIDAY_MARKETPLACE_DISTRIBUTION_MODES as readonly string[]).includes(
      distributionMode,
    )
  ) {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.VALIDATION_FAILED,
        message: `Unsupported distributionMode "${distributionMode}"`,
      },
    };
  }
  return { ok: true, value: distributionMode };
}

// ─── Listing Manager ───

/**
 * Creates a new listing in draft status with its first version.
 *
 * The listing starts as `draft` with an initial version (version 1)
 * also in `draft` status.
 */
export function createListing(
  input: CreateListingInput,
  existingSlugs: readonly string[],
  deps: ListingDeps,
): ListingResult<{ listing: FridayListing; version: FridayListingVersion }> {
  const slugValidation = validateSlug(input.slug);
  if (!slugValidation.ok) return slugValidation;

  const assetTypeValidation = validateAssetType(input.assetType);
  if (!assetTypeValidation.ok) return assetTypeValidation;
  const distributionMode =
    input.distributionMode ?? defaultDistributionMode(input.assetType);
  const distributionModeValidation = validateDistributionMode(distributionMode);
  if (!distributionModeValidation.ok) return distributionModeValidation;

  if (existingSlugs.includes(input.slug)) {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.SLUG_CONFLICT,
        message: `Slug "${input.slug}" is already taken`,
      },
    };
  }

  const contentValidation = validateListingContent(input.title, input.description, input.packageName, input.packageVersion);
  if (!contentValidation.ok) return contentValidation;

  const now = deps.now();
  const listingId = deps.generateId();
  const versionId = deps.generateId();

  const version: FridayListingVersion = {
    id: versionId,
    listingId,
    versionNumber: 1,
    status: "draft",
    title: input.title.trim(),
    description: input.description.trim(),
    longDescription: input.longDescription?.trim() ?? null,
    screenshotUrls: input.screenshotUrls ?? [],
    packageName: input.packageName,
    packageVersion: input.packageVersion,
    assetType: input.assetType,
    distributionMode,
    permissionManifest: normalizePermissionManifest(input.permissionManifest),
    pricingPlan: input.pricingPlan,
    releaseNotes: input.releaseNotes?.trim() ?? null,
    createdAt: now,
  };

  const listing: FridayListing = {
    id: listingId,
    publisherId: input.publisherId,
    slug: input.slug,
    status: "draft",
    currentVersionId: versionId,
    pendingVersionId: null,
    tenantId: input.tenantId ?? null,
    tags: input.tags ?? [],
    createdAt: now,
    updatedAt: now,
  };

  emitTransitionAudit(deps, {
    entityType: "listing",
    entityId: listing.id,
    action: "listing.created",
    fromState: null,
    toState: listing.status,
    timestamp: now,
    actor: input.publisherId,
    metadata: {
      slug: listing.slug,
    },
  });
  emitTransitionAudit(deps, {
    entityType: "listing_version",
    entityId: version.id,
    action: "listing_version.created",
    fromState: null,
    toState: version.status,
    timestamp: now,
    actor: input.publisherId,
    metadata: {
      listingId: version.listingId,
      versionNumber: version.versionNumber,
    },
  });

  return { ok: true, value: cloneAndFreeze({ listing, version }) };
}

/**
 * Creates a new version for an existing listing.
 *
 * Used when editing a published listing: a new draft version is created
 * while the current published version remains live.
 */
export function createListingVersion(
  listing: FridayListing,
  currentVersionNumber: number,
  input: UpdateListingInput,
  currentVersion: FridayListingVersion,
  deps: ListingDeps,
): ListingResult<{ listing: FridayListing; version: FridayListingVersion }> {
  const title = input.title ?? currentVersion.title;
  const description = input.description ?? currentVersion.description;
  const packageName = currentVersion.packageName;
  const packageVersion = input.packageVersion ?? currentVersion.packageVersion;
  const nextAssetType = input.assetType ?? currentVersion.assetType;
  const nextDistributionMode =
    input.distributionMode ?? currentVersion.distributionMode;

  const contentValidation = validateListingContent(title, description, packageName, packageVersion);
  if (!contentValidation.ok) return contentValidation;
  const assetTypeValidation = validateAssetType(nextAssetType);
  if (!assetTypeValidation.ok) return assetTypeValidation;
  const distributionModeValidation = validateDistributionMode(nextDistributionMode);
  if (!distributionModeValidation.ok) return distributionModeValidation;

  if (
    input.assetType !== undefined &&
    input.assetType !== currentVersion.assetType &&
    listing.status === "published"
  ) {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.ASSET_TYPE_IMMUTABLE,
        message: "Cannot change assetType after listing is published",
      },
    };
  }

  const now = deps.now();
  const versionId = deps.generateId();

  const version: FridayListingVersion = {
    id: versionId,
    listingId: listing.id,
    versionNumber: currentVersionNumber + 1,
    status: "draft",
    title: title.trim(),
    description: description.trim(),
    longDescription: input.longDescription !== undefined
      ? (input.longDescription?.trim() ?? null)
      : currentVersion.longDescription,
    screenshotUrls: input.screenshotUrls ?? currentVersion.screenshotUrls,
    packageName,
    packageVersion,
    assetType: nextAssetType,
    distributionMode: nextDistributionMode,
    permissionManifest: input.permissionManifest !== undefined
      ? normalizePermissionManifest(input.permissionManifest)
      : currentVersion.permissionManifest,
    pricingPlan: input.pricingPlan ?? currentVersion.pricingPlan,
    releaseNotes: input.releaseNotes?.trim() ?? null,
    createdAt: now,
  };

  const updatedListing: FridayListing = {
    ...listing,
    pendingVersionId: versionId,
    tags: input.tags ?? listing.tags,
    updatedAt: now,
  };

  emitTransitionAudit(deps, {
    entityType: "listing",
    entityId: listing.id,
    action: "listing.pending_version_set",
    fromState: listing.status,
    toState: updatedListing.status,
    timestamp: now,
    actor: listing.publisherId,
    metadata: {
      fromPendingVersionId: listing.pendingVersionId,
      toPendingVersionId: updatedListing.pendingVersionId,
    },
  });
  emitTransitionAudit(deps, {
    entityType: "listing_version",
    entityId: version.id,
    action: "listing_version.created",
    fromState: null,
    toState: version.status,
    timestamp: now,
    actor: listing.publisherId,
    metadata: {
      listingId: version.listingId,
      versionNumber: version.versionNumber,
    },
  });

  return { ok: true, value: cloneAndFreeze({ listing: updatedListing, version }) };
}

/**
 * Submits a listing for review.
 *
 * Transitions listing from `draft` → `review` and version from `draft` → `in_review`.
 */
export function submitForReview(
  listing: FridayListing,
  version: FridayListingVersion,
  deps: ListingDeps,
): ListingResult<{ listing: FridayListing; version: FridayListingVersion }> {
  if (!canTransitionListing(listing.status, "review")) {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.INVALID_TRANSITION,
        message: `Cannot submit for review from status "${listing.status}"`,
      },
    };
  }

  if (version.listingId !== listing.id) {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.INVALID_TRANSITION,
        message: "Version does not belong to listing",
      },
    };
  }

  if (version.status !== "draft") {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.INVALID_TRANSITION,
        message: `Version must be in "draft" status to submit for review, got "${version.status}"`,
      },
    };
  }

  const now = deps.now();

  const updatedListing: FridayListing = {
    ...listing,
    status: "review",
    pendingVersionId: version.id,
    updatedAt: now,
  };

  const updatedVersion: FridayListingVersion = {
    ...version,
    status: "in_review" as FridayListingVersionStatus,
  };

  emitTransitionAudit(deps, {
    entityType: "listing",
    entityId: listing.id,
    action: "listing.submitted_for_review",
    fromState: listing.status,
    toState: updatedListing.status,
    timestamp: now,
    actor: listing.publisherId,
    metadata: {
      versionId: version.id,
    },
  });
  emitTransitionAudit(deps, {
    entityType: "listing_version",
    entityId: version.id,
    action: "listing_version.submitted_for_review",
    fromState: version.status,
    toState: updatedVersion.status,
    timestamp: now,
    actor: listing.publisherId,
    metadata: {
      listingId: listing.id,
    },
  });

  return {
    ok: true,
    value: cloneAndFreeze({ listing: updatedListing, version: updatedVersion }),
  };
}

/**
 * Reviews a listing version, resulting in approval or rejection.
 *
 * - Approved: listing transitions `review` → `published`, version → `approved`.
 * - Rejected: listing transitions `review` → `draft`, version → `rejected`.
 */
export function reviewListing(
  listing: FridayListing,
  version: FridayListingVersion,
  input: ReviewListingInput,
  deps: ListingDeps,
): ListingResult<{ listing: FridayListing; version: FridayListingVersion; review: FridayListingReview }> {
  if (version.listingId !== listing.id) {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.INVALID_TRANSITION,
        message: "Version does not belong to listing",
      },
    };
  }

  if (listing.pendingVersionId !== version.id) {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.INVALID_TRANSITION,
        message: "Version does not match listing pendingVersionId",
      },
    };
  }

  if (listing.status !== "review") {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.INVALID_TRANSITION,
        message: `Cannot review listing in status "${listing.status}", must be "review"`,
      },
    };
  }

  if (version.status !== "in_review") {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.INVALID_TRANSITION,
        message: `Version must be "in_review" to be reviewed, got "${version.status}"`,
      },
    };
  }

  const now = deps.now();
  const isApproved = input.decision === "approved";

  const targetListingStatus: FridayListingStatus = isApproved ? "published" : "draft";
  const targetVersionStatus: FridayListingVersionStatus = isApproved ? "approved" : "rejected";

  const updatedListing: FridayListing = {
    ...listing,
    status: targetListingStatus,
    currentVersionId: isApproved ? version.id : listing.currentVersionId,
    pendingVersionId: null,
    updatedAt: now,
  };

  const updatedVersion: FridayListingVersion = {
    ...version,
    status: targetVersionStatus,
  };

  const review: FridayListingReview = {
    id: deps.generateId(),
    listingId: listing.id,
    versionId: version.id,
    reviewerId: input.reviewerId,
    decision: input.decision,
    notes: input.notes ?? null,
    createdAt: now,
  };

  emitTransitionAudit(deps, {
    entityType: "listing",
    entityId: listing.id,
    action: "listing.reviewed",
    fromState: listing.status,
    toState: updatedListing.status,
    timestamp: now,
    actor: input.reviewerId,
    metadata: {
      decision: input.decision,
      versionId: version.id,
    },
  });
  emitTransitionAudit(deps, {
    entityType: "listing_version",
    entityId: version.id,
    action: "listing_version.reviewed",
    fromState: version.status,
    toState: updatedVersion.status,
    timestamp: now,
    actor: input.reviewerId,
    metadata: {
      listingId: listing.id,
      decision: input.decision,
    },
  });
  emitTransitionAudit(deps, {
    entityType: "listing_review",
    entityId: review.id,
    action: "listing_review.created",
    fromState: null,
    toState: review.decision,
    timestamp: now,
    actor: input.reviewerId,
    metadata: {
      listingId: review.listingId,
      versionId: review.versionId,
    },
  });

  return {
    ok: true,
    value: cloneAndFreeze({ listing: updatedListing, version: updatedVersion, review }),
  };
}

/**
 * Suspends a published listing.
 */
export function suspendListing(
  listing: FridayListing,
  deps: ListingDeps,
): ListingResult<FridayListing> {
  if (!canTransitionListing(listing.status, "suspended")) {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.INVALID_TRANSITION,
        message: `Cannot suspend listing from status "${listing.status}"`,
      },
    };
  }

  const now = deps.now();
  const suspended: FridayListing = {
    ...listing,
    status: "suspended",
    updatedAt: now,
  };
  emitTransitionAudit(deps, {
    entityType: "listing",
    entityId: listing.id,
    action: "listing.suspended",
    fromState: listing.status,
    toState: suspended.status,
    timestamp: now,
    actor: listing.publisherId,
  });

  return {
    ok: true,
    value: cloneAndFreeze(suspended),
  };
}

/**
 * Reinstates a suspended listing back to published.
 */
export function reinstateListing(
  listing: FridayListing,
  deps: ListingDeps,
): ListingResult<FridayListing> {
  if (listing.status !== "suspended") {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.INVALID_TRANSITION,
        message: `Cannot reinstate listing from status "${listing.status}", must be "suspended"`,
      },
    };
  }

  const now = deps.now();
  const reinstated: FridayListing = {
    ...listing,
    status: "published",
    updatedAt: now,
  };
  emitTransitionAudit(deps, {
    entityType: "listing",
    entityId: listing.id,
    action: "listing.reinstated",
    fromState: listing.status,
    toState: reinstated.status,
    timestamp: now,
    actor: listing.publisherId,
  });

  return {
    ok: true,
    value: cloneAndFreeze(reinstated),
  };
}

/**
 * Archives a listing (terminal state).
 */
export function archiveListing(
  listing: FridayListing,
  deps: ListingDeps,
): ListingResult<FridayListing> {
  if (!canTransitionListing(listing.status, "archived")) {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.INVALID_TRANSITION,
        message: `Cannot archive listing from status "${listing.status}"`,
      },
    };
  }

  const now = deps.now();
  const archived: FridayListing = {
    ...listing,
    status: "archived",
    updatedAt: now,
  };
  emitTransitionAudit(deps, {
    entityType: "listing",
    entityId: listing.id,
    action: "listing.archived",
    fromState: listing.status,
    toState: archived.status,
    timestamp: now,
    actor: listing.publisherId,
  });

  return {
    ok: true,
    value: cloneAndFreeze(archived),
  };
}

/**
 * Checks whether a listing status transition is valid.
 */
export function canTransitionListing(
  from: FridayListingStatus,
  to: FridayListingStatus,
): boolean {
  const allowed = FRIDAY_LISTING_STATE_TRANSITIONS[from];
  return allowed.includes(to);
}

// ─── Internal Helpers ───

function validateSlug(slug: string): ListingResult<void> {
  if (!SLUG_PATTERN.test(slug)) {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.VALIDATION_FAILED,
        message: `Invalid slug "${slug}": must be 3-64 lowercase alphanumeric characters or hyphens`,
      },
    };
  }
  return { ok: true, value: undefined };
}

function validateListingContent(
  title: string,
  description: string,
  packageName: string,
  packageVersion: string,
): ListingResult<void> {
  if (!title.trim()) {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.VALIDATION_FAILED,
        message: "Title must not be empty",
      },
    };
  }

  if (!description.trim()) {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.VALIDATION_FAILED,
        message: "Description must not be empty",
      },
    };
  }

  if (description.trim().length > MAX_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.VALIDATION_FAILED,
        message: `Description must be ≤ ${MAX_DESCRIPTION_LENGTH} characters`,
      },
    };
  }

  if (!packageName.trim()) {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.VALIDATION_FAILED,
        message: "Package name must not be empty",
      },
    };
  }

  if (!packageVersion.trim()) {
    return {
      ok: false,
      error: {
        code: LISTING_ERROR_CODES.VALIDATION_FAILED,
        message: "Package version must not be empty",
      },
    };
  }

  return { ok: true, value: undefined };
}

function validateAssetType(assetType: string): ListingResult<void> {
  if ((FRIDAY_MARKETPLACE_ASSET_TYPES as readonly string[]).includes(assetType)) {
    return { ok: true, value: undefined };
  }
  return {
    ok: false,
    error: {
      code: LISTING_ERROR_CODES.UNSUPPORTED_ASSET_TYPE,
      message: `Unsupported assetType "${assetType}"`,
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested !== null && typeof nested === "object") {
      deepFreeze(nested);
    }
  }

  return Object.freeze(value);
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function emitTransitionAudit(
  deps: ListingDeps,
  event: {
    readonly entityType: MarketplaceAuditEntityType;
    readonly entityId: UUID;
    readonly action: string;
    readonly fromState: string | null;
    readonly toState: string;
    readonly timestamp: ISODateTime;
    readonly actor?: string;
    readonly metadata?: MarketplaceAuditEventMetadata;
  },
): void {
  if (!deps.emitAuditEvent) return;
  deps.emitAuditEvent({
    ...event,
    actor: event.actor ?? deps.defaultActor ?? MARKETPLACE_SYSTEM_ACTOR,
  });
}
