/**
 * Publisher Manager — Registration, verification, and profile management.
 *
 * Handles the full lifecycle of marketplace publisher identities including
 * creation, profile updates, verification workflow, and suspension.
 *
 * @module marketplace/engine/publisher-manager
 */

import type {
  FridayPublisher,
  FridayPublisherVerification,
  FridayPublisherVerificationStatus,
  ISODateTime,
  UUID,
} from "../model/friday-marketplace.types.js";
import type { MarketplaceAuditEntityType, MarketplaceAuditEventMetadata, MarketplaceAuditEventSink } from "./audit-events.js";
import { MARKETPLACE_SYSTEM_ACTOR } from "./audit-events.js";

// ─── Error Types ───

/** Error codes specific to publisher operations. */
export const PUBLISHER_ERROR_CODES = {
  NOT_FOUND: "PUBLISHER_NOT_FOUND",
  ALREADY_EXISTS: "PUBLISHER_ALREADY_EXISTS",
  NOT_VERIFIED: "PUBLISHER_NOT_VERIFIED",
  SUSPENDED: "PUBLISHER_SUSPENDED",
  INVALID_TRANSITION: "PUBLISHER_INVALID_TRANSITION",
  VALIDATION_FAILED: "PUBLISHER_VALIDATION_FAILED",
} as const;

export type PublisherErrorCode =
  (typeof PUBLISHER_ERROR_CODES)[keyof typeof PUBLISHER_ERROR_CODES];

export interface PublisherError {
  readonly code: PublisherErrorCode;
  readonly message: string;
}

export type PublisherResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PublisherError };

// ─── Input Types ───

export interface CreatePublisherInput {
  readonly tenantId: string;
  readonly principalId: string;
  readonly displayName: string;
  readonly bio?: string;
  readonly avatarUrl?: string;
  readonly websiteUrl?: string;
  readonly contactEmail: string;
}

export interface UpdatePublisherInput {
  readonly displayName?: string;
  readonly bio?: string;
  readonly avatarUrl?: string;
  readonly websiteUrl?: string;
  readonly contactEmail?: string;
}

export interface SubmitVerificationInput {
  readonly legalName: string;
  readonly taxId: string;
  readonly country: string;
  readonly payoutMethod: string;
}

export interface ReviewVerificationInput {
  readonly decision: "verified" | "rejected";
  readonly notes?: string;
}

// ─── ID & Timestamp Providers ───

export interface PublisherDeps {
  readonly generateId: () => UUID;
  readonly now: () => ISODateTime;
  readonly emitAuditEvent?: MarketplaceAuditEventSink;
  readonly defaultActor?: string;
}

// ─── Default Platform Fee ───

/** Default platform fee in basis points (0% for creator support). */
const DEFAULT_PLATFORM_FEE_BPS = 0;

// ─── Verification Status Transitions ───

const VERIFICATION_TRANSITIONS: Readonly<
  Record<FridayPublisherVerificationStatus, readonly FridayPublisherVerificationStatus[]>
> = {
  unverified: ["pending"],
  pending: ["verified", "suspended"],
  verified: ["suspended"],
  suspended: ["verified"],
};

// ─── Publisher Manager ───

/**
 * Creates a new publisher profile.
 *
 * Validates that the tenant/principal combination is unique (caller must check
 * against existing records) and initializes the publisher as unverified.
 */
export function createPublisher(
  input: CreatePublisherInput,
  existingPublishers: readonly FridayPublisher[],
  deps: PublisherDeps,
): PublisherResult<FridayPublisher> {
  const duplicate = existingPublishers.find(
    (p) => p.tenantId === input.tenantId && p.principalId === input.principalId,
  );
  if (duplicate) {
    return {
      ok: false,
      error: {
        code: PUBLISHER_ERROR_CODES.ALREADY_EXISTS,
        message: `Publisher already exists for tenant ${input.tenantId} and principal ${input.principalId}`,
      },
    };
  }

  if (!input.displayName.trim()) {
    return {
      ok: false,
      error: {
        code: PUBLISHER_ERROR_CODES.VALIDATION_FAILED,
        message: "Display name must not be empty",
      },
    };
  }

  if (!isValidEmail(input.contactEmail)) {
    return {
      ok: false,
      error: {
        code: PUBLISHER_ERROR_CODES.VALIDATION_FAILED,
        message: "Invalid contact email address",
      },
    };
  }

  const now = deps.now();
  const publisher: FridayPublisher = {
    id: deps.generateId(),
    tenantId: input.tenantId,
    principalId: input.principalId,
    displayName: input.displayName.trim(),
    bio: input.bio?.trim() ?? null,
    avatarUrl: input.avatarUrl ?? null,
    websiteUrl: input.websiteUrl ?? null,
    contactEmail: input.contactEmail.trim(),
    verificationStatus: "unverified",
    legalName: null,
    taxIdLast4: null,
    country: null,
    payoutMethod: null,
    platformFeeBps: DEFAULT_PLATFORM_FEE_BPS,
    createdAt: now,
    updatedAt: now,
  };

  emitPublisherAudit(deps, {
    entityType: "publisher",
    entityId: publisher.id,
    action: "publisher.created",
    fromState: null,
    toState: "unverified",
    timestamp: now,
  });

  return { ok: true, value: publisher };
}

/**
 * Updates an existing publisher profile.
 *
 * Only mutable profile fields are updated; verification-related fields
 * are modified through the verification workflow.
 */
export function updatePublisher(
  publisher: FridayPublisher,
  input: UpdatePublisherInput,
  deps: PublisherDeps,
): PublisherResult<FridayPublisher> {
  if (publisher.verificationStatus === "suspended") {
    return {
      ok: false,
      error: {
        code: PUBLISHER_ERROR_CODES.SUSPENDED,
        message: "Cannot update a suspended publisher",
      },
    };
  }

  if (input.displayName !== undefined && !input.displayName.trim()) {
    return {
      ok: false,
      error: {
        code: PUBLISHER_ERROR_CODES.VALIDATION_FAILED,
        message: "Display name must not be empty",
      },
    };
  }

  if (input.contactEmail !== undefined && !isValidEmail(input.contactEmail)) {
    return {
      ok: false,
      error: {
        code: PUBLISHER_ERROR_CODES.VALIDATION_FAILED,
        message: "Invalid contact email address",
      },
    };
  }

  const now = deps.now();
  const updated: FridayPublisher = {
    ...publisher,
    displayName: input.displayName?.trim() ?? publisher.displayName,
    bio: input.bio !== undefined ? (input.bio?.trim() ?? null) : publisher.bio,
    avatarUrl: input.avatarUrl !== undefined ? (input.avatarUrl ?? null) : publisher.avatarUrl,
    websiteUrl: input.websiteUrl !== undefined ? (input.websiteUrl ?? null) : publisher.websiteUrl,
    contactEmail: input.contactEmail?.trim() ?? publisher.contactEmail,
    updatedAt: now,
  };

  emitPublisherAudit(deps, {
    entityType: "publisher",
    entityId: publisher.id,
    action: "publisher.updated",
    fromState: publisher.verificationStatus,
    toState: updated.verificationStatus,
    timestamp: now,
  });

  return { ok: true, value: updated };
}

/**
 * Submits a publisher verification request.
 *
 * Transitions the publisher from `unverified` to `pending` and creates
 * a verification record with the submitted details.
 */
export function submitVerification(
  publisher: FridayPublisher,
  input: SubmitVerificationInput,
  deps: PublisherDeps,
): PublisherResult<{ publisher: FridayPublisher; verification: FridayPublisherVerification }> {
  if (!canTransitionVerification(publisher.verificationStatus, "pending")) {
    return {
      ok: false,
      error: {
        code: PUBLISHER_ERROR_CODES.INVALID_TRANSITION,
        message: `Cannot submit verification from status "${publisher.verificationStatus}"`,
      },
    };
  }

  if (!input.legalName.trim() || !input.taxId.trim() || !input.country.trim() || !input.payoutMethod.trim()) {
    return {
      ok: false,
      error: {
        code: PUBLISHER_ERROR_CODES.VALIDATION_FAILED,
        message: "All verification fields are required",
      },
    };
  }

  if (input.country.length !== 2) {
    return {
      ok: false,
      error: {
        code: PUBLISHER_ERROR_CODES.VALIDATION_FAILED,
        message: "Country must be a 2-letter ISO 3166-1 alpha-2 code",
      },
    };
  }

  const now = deps.now();
  const taxIdLast4 = input.taxId.slice(-4);

  const updatedPublisher: FridayPublisher = {
    ...publisher,
    verificationStatus: "pending",
    legalName: input.legalName.trim(),
    taxIdLast4,
    country: input.country.toUpperCase(),
    payoutMethod: input.payoutMethod.trim(),
    updatedAt: now,
  };

  const verification: FridayPublisherVerification = {
    publisherId: publisher.id,
    legalName: input.legalName.trim(),
    taxIdLast4,
    country: input.country.toUpperCase(),
    payoutMethod: input.payoutMethod.trim(),
    submittedAt: now,
    status: "pending",
    reviewerNotes: null,
    reviewedAt: null,
  };

  emitPublisherAudit(deps, {
    entityType: "publisher",
    entityId: publisher.id,
    action: "publisher.verification_submitted",
    fromState: publisher.verificationStatus,
    toState: "pending",
    timestamp: now,
  });

  return { ok: true, value: { publisher: updatedPublisher, verification } };
}

/**
 * Reviews a publisher's verification submission.
 *
 * Transitions the publisher to `verified` or back to `suspended` (rejected)
 * based on the reviewer's decision.
 */
export function reviewVerification(
  publisher: FridayPublisher,
  verification: FridayPublisherVerification,
  input: ReviewVerificationInput,
  deps: PublisherDeps,
): PublisherResult<{ publisher: FridayPublisher; verification: FridayPublisherVerification }> {
  if (verification.publisherId !== publisher.id) {
    return {
      ok: false,
      error: {
        code: PUBLISHER_ERROR_CODES.INVALID_TRANSITION,
        message: `Verification does not belong to publisher "${publisher.id}"`,
      },
    };
  }

  if (verification.status !== "pending") {
    return {
      ok: false,
      error: {
        code: PUBLISHER_ERROR_CODES.INVALID_TRANSITION,
        message: `Verification is "${verification.status}", expected "pending"`,
      },
    };
  }

  if (publisher.verificationStatus !== "pending") {
    return {
      ok: false,
      error: {
        code: PUBLISHER_ERROR_CODES.INVALID_TRANSITION,
        message: `Cannot review verification when publisher status is "${publisher.verificationStatus}"`,
      },
    };
  }

  const targetStatus: FridayPublisherVerificationStatus =
    input.decision === "verified" ? "verified" : "suspended";

  if (!canTransitionVerification(publisher.verificationStatus, targetStatus)) {
    return {
      ok: false,
      error: {
        code: PUBLISHER_ERROR_CODES.INVALID_TRANSITION,
        message: `Cannot transition verification from "${publisher.verificationStatus}" to "${targetStatus}"`,
      },
    };
  }

  const now = deps.now();

  const updatedPublisher: FridayPublisher = {
    ...publisher,
    verificationStatus: targetStatus,
    updatedAt: now,
  };

  const updatedVerification: FridayPublisherVerification = {
    ...verification,
    status: targetStatus,
    reviewerNotes: input.notes ?? null,
    reviewedAt: now,
  };

  emitPublisherAudit(deps, {
    entityType: "publisher",
    entityId: publisher.id,
    action: `publisher.verification_${input.decision}`,
    fromState: publisher.verificationStatus,
    toState: targetStatus,
    timestamp: now,
  });

  return { ok: true, value: { publisher: updatedPublisher, verification: updatedVerification } };
}

/**
 * Suspends a publisher.
 *
 * Transitions the publisher to `suspended` status.
 */
export function suspendPublisher(
  publisher: FridayPublisher,
  deps: PublisherDeps,
): PublisherResult<FridayPublisher> {
  if (publisher.verificationStatus === "suspended") {
    return {
      ok: false,
      error: {
        code: PUBLISHER_ERROR_CODES.INVALID_TRANSITION,
        message: "Publisher is already suspended",
      },
    };
  }

  if (!canTransitionVerification(publisher.verificationStatus, "suspended")) {
    return {
      ok: false,
      error: {
        code: PUBLISHER_ERROR_CODES.INVALID_TRANSITION,
        message: `Cannot suspend publisher from status "${publisher.verificationStatus}"`,
      },
    };
  }

  const now = deps.now();

  emitPublisherAudit(deps, {
    entityType: "publisher",
    entityId: publisher.id,
    action: "publisher.suspended",
    fromState: publisher.verificationStatus,
    toState: "suspended",
    timestamp: now,
  });

  return {
    ok: true,
    value: {
      ...publisher,
      verificationStatus: "suspended",
      updatedAt: now,
    },
  };
}

/**
 * Reinstates a suspended publisher.
 *
 * Transitions the publisher from `suspended` back to `verified`.
 */
export function reinstatePublisher(
  publisher: FridayPublisher,
  deps: PublisherDeps,
): PublisherResult<FridayPublisher> {
  if (publisher.verificationStatus !== "suspended") {
    return {
      ok: false,
      error: {
        code: PUBLISHER_ERROR_CODES.INVALID_TRANSITION,
        message: `Cannot reinstate publisher from status "${publisher.verificationStatus}"`,
      },
    };
  }

  const now = deps.now();

  emitPublisherAudit(deps, {
    entityType: "publisher",
    entityId: publisher.id,
    action: "publisher.reinstated",
    fromState: "suspended",
    toState: "verified",
    timestamp: now,
  });

  return {
    ok: true,
    value: {
      ...publisher,
      verificationStatus: "verified",
      updatedAt: now,
    },
  };
}

/**
 * Checks whether a publisher is verified and can publish listings.
 */
export function isPublisherVerified(publisher: FridayPublisher): boolean {
  return publisher.verificationStatus === "verified";
}

// ─── Internal Helpers ───

function emitPublisherAudit(
  deps: PublisherDeps,
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

function canTransitionVerification(
  from: FridayPublisherVerificationStatus,
  to: FridayPublisherVerificationStatus,
): boolean {
  const allowed = VERIFICATION_TRANSITIONS[from];
  return allowed.includes(to);
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
