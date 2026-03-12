import { describe, it, expect } from "vitest";
import {
  createPublisher,
  updatePublisher,
  submitVerification,
  reviewVerification,
  suspendPublisher,
  reinstatePublisher,
  isPublisherVerified,
  PUBLISHER_ERROR_CODES,
} from "../../../../src/marketplace/engine/publisher-manager.js";
import type { FridayPublisher, FridayPublisherVerification } from "../../../../src/marketplace/model/friday-marketplace.types.js";
import type { MarketplaceAuditEvent } from "../../../../src/marketplace/engine/audit-events.js";

// ─── Test Helpers ───

let idCounter = 0;
const deps = {
  generateId: () => `pub-${++idCounter}`,
  now: () => "2026-02-24T12:00:00.000Z",
};

function buildAuditDeps() {
  const events: MarketplaceAuditEvent[] = [];
  return {
    deps: { ...deps, emitAuditEvent: (e: MarketplaceAuditEvent) => events.push(e) },
    events,
  };
}

function resetCounter(): void {
  idCounter = 0;
}

function basePublisher(overrides?: Partial<FridayPublisher>): FridayPublisher {
  return {
    id: "pub-1",
    tenantId: "tenant-1",
    principalId: "principal-1",
    displayName: "Test Publisher",
    bio: null,
    avatarUrl: null,
    websiteUrl: null,
    contactEmail: "test@example.com",
    verificationStatus: "unverified",
    legalName: null,
    taxIdLast4: null,
    country: null,
    payoutMethod: null,
    platformFeeBps: 0,
    createdAt: "2026-02-24T10:00:00.000Z",
    updatedAt: "2026-02-24T10:00:00.000Z",
    ...overrides,
  };
}

function baseVerification(overrides?: Partial<FridayPublisherVerification>): FridayPublisherVerification {
  return {
    publisherId: "pub-1",
    legalName: "Test LLC",
    taxIdLast4: "1234",
    country: "US",
    payoutMethod: "bank_transfer",
    submittedAt: "2026-02-24T11:00:00.000Z",
    status: "pending",
    reviewerNotes: null,
    reviewedAt: null,
    ...overrides,
  };
}

// ─── Tests ───

describe("createPublisher", () => {
  it("creates a publisher with valid input", () => {
    resetCounter();
    const result = createPublisher(
      {
        tenantId: "tenant-1",
        principalId: "principal-1",
        displayName: "My Publisher",
        contactEmail: "hello@example.com",
        bio: "A great publisher",
      },
      [],
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe("pub-1");
    expect(result.value.displayName).toBe("My Publisher");
    expect(result.value.contactEmail).toBe("hello@example.com");
    expect(result.value.bio).toBe("A great publisher");
    expect(result.value.verificationStatus).toBe("unverified");
    expect(result.value.platformFeeBps).toBe(0);
  });

  it("rejects duplicate tenant/principal", () => {
    const existing = [basePublisher()];
    const result = createPublisher(
      {
        tenantId: "tenant-1",
        principalId: "principal-1",
        displayName: "Duplicate",
        contactEmail: "dupe@example.com",
      },
      existing,
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PUBLISHER_ERROR_CODES.ALREADY_EXISTS);
  });

  it("rejects empty display name", () => {
    const result = createPublisher(
      {
        tenantId: "tenant-2",
        principalId: "principal-2",
        displayName: "   ",
        contactEmail: "test@example.com",
      },
      [],
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PUBLISHER_ERROR_CODES.VALIDATION_FAILED);
  });

  it("rejects invalid email", () => {
    const result = createPublisher(
      {
        tenantId: "tenant-2",
        principalId: "principal-2",
        displayName: "Valid Name",
        contactEmail: "not-an-email",
      },
      [],
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PUBLISHER_ERROR_CODES.VALIDATION_FAILED);
  });
});

describe("updatePublisher", () => {
  it("updates mutable fields", () => {
    const publisher = basePublisher();
    const result = updatePublisher(
      publisher,
      { displayName: "New Name", bio: "New bio" },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.displayName).toBe("New Name");
    expect(result.value.bio).toBe("New bio");
    expect(result.value.updatedAt).toBe("2026-02-24T12:00:00.000Z");
  });

  it("rejects update on suspended publisher", () => {
    const publisher = basePublisher({ verificationStatus: "suspended" });
    const result = updatePublisher(publisher, { displayName: "New" }, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PUBLISHER_ERROR_CODES.SUSPENDED);
  });
});

describe("submitVerification", () => {
  it("transitions unverified → pending", () => {
    const publisher = basePublisher();
    const result = submitVerification(
      publisher,
      {
        legalName: "Test Corp",
        taxId: "123456789",
        country: "US",
        payoutMethod: "bank_transfer",
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.publisher.verificationStatus).toBe("pending");
    expect(result.value.publisher.taxIdLast4).toBe("6789");
    expect(result.value.publisher.country).toBe("US");
    expect(result.value.verification.status).toBe("pending");
    expect(result.value.verification.legalName).toBe("Test Corp");
  });

  it("rejects submission from verified status", () => {
    const publisher = basePublisher({ verificationStatus: "verified" });
    const result = submitVerification(
      publisher,
      {
        legalName: "Test Corp",
        taxId: "123456789",
        country: "US",
        payoutMethod: "bank_transfer",
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PUBLISHER_ERROR_CODES.INVALID_TRANSITION);
  });

  it("rejects invalid country code", () => {
    const publisher = basePublisher();
    const result = submitVerification(
      publisher,
      {
        legalName: "Test Corp",
        taxId: "123456789",
        country: "USA",
        payoutMethod: "bank_transfer",
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PUBLISHER_ERROR_CODES.VALIDATION_FAILED);
  });
});

describe("reviewVerification", () => {
  it("approves verification: pending → verified", () => {
    const publisher = basePublisher({ verificationStatus: "pending" });
    const verification = baseVerification();
    const result = reviewVerification(
      publisher,
      verification,
      { decision: "verified", notes: "Looks good" },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.publisher.verificationStatus).toBe("verified");
    expect(result.value.verification.status).toBe("verified");
    expect(result.value.verification.reviewerNotes).toBe("Looks good");
  });

  it("rejects verification: pending → suspended", () => {
    const publisher = basePublisher({ verificationStatus: "pending" });
    const verification = baseVerification();
    const result = reviewVerification(
      publisher,
      verification,
      { decision: "rejected", notes: "Missing docs" },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.publisher.verificationStatus).toBe("suspended");
    expect(result.value.verification.status).toBe("suspended");
  });

  it("rejects review of non-pending publisher", () => {
    const publisher = basePublisher({ verificationStatus: "verified" });
    const verification = baseVerification({ status: "verified" });
    const result = reviewVerification(
      publisher,
      verification,
      { decision: "verified" },
      deps,
    );

    expect(result.ok).toBe(false);
  });

  it("rejects review when verification belongs to different publisher", () => {
    const publisher = basePublisher({ verificationStatus: "pending" });
    const verification = baseVerification({ publisherId: "pub-other" });

    const result = reviewVerification(
      publisher,
      verification,
      { decision: "verified" },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PUBLISHER_ERROR_CODES.INVALID_TRANSITION);
    expect(result.error.message).toContain("does not belong");
  });

  it("rejects review when verification status is not pending", () => {
    const publisher = basePublisher({ verificationStatus: "pending" });
    const verification = baseVerification({ status: "verified" });

    const result = reviewVerification(
      publisher,
      verification,
      { decision: "verified" },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PUBLISHER_ERROR_CODES.INVALID_TRANSITION);
    expect(result.error.message).toContain("expected \"pending\"");
  });
});

describe("suspendPublisher / reinstatePublisher", () => {
  it("suspends a verified publisher", () => {
    const publisher = basePublisher({ verificationStatus: "verified" });
    const result = suspendPublisher(publisher, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verificationStatus).toBe("suspended");
  });

  it("cannot suspend an already suspended publisher", () => {
    const publisher = basePublisher({ verificationStatus: "suspended" });
    const result = suspendPublisher(publisher, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PUBLISHER_ERROR_CODES.INVALID_TRANSITION);
  });

  it("reinstates a suspended publisher", () => {
    const publisher = basePublisher({ verificationStatus: "suspended" });
    const result = reinstatePublisher(publisher, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verificationStatus).toBe("verified");
  });

  it("cannot reinstate a non-suspended publisher", () => {
    const publisher = basePublisher({ verificationStatus: "verified" });
    const result = reinstatePublisher(publisher, deps);

    expect(result.ok).toBe(false);
  });
});

describe("isPublisherVerified", () => {
  it("returns true for verified publisher", () => {
    expect(isPublisherVerified(basePublisher({ verificationStatus: "verified" }))).toBe(true);
  });

  it("returns false for non-verified publisher", () => {
    expect(isPublisherVerified(basePublisher({ verificationStatus: "unverified" }))).toBe(false);
    expect(isPublisherVerified(basePublisher({ verificationStatus: "pending" }))).toBe(false);
    expect(isPublisherVerified(basePublisher({ verificationStatus: "suspended" }))).toBe(false);
  });
});

// ─── Audit Events ───

describe("publisher audit events", () => {
  it("emits audit event on createPublisher", () => {
    const { deps: auditDeps, events } = buildAuditDeps();
    const result = createPublisher(
      { tenantId: "t1", principalId: "p1", displayName: "Test", contactEmail: "a@b.com" },
      [],
      auditDeps,
    );

    expect(result.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].entityType).toBe("publisher");
    expect(events[0].action).toBe("publisher.created");
    expect(events[0].fromState).toBeNull();
    expect(events[0].toState).toBe("unverified");
  });

  it("emits audit event on submitVerification", () => {
    const { deps: auditDeps, events } = buildAuditDeps();
    const publisher = basePublisher({ verificationStatus: "unverified" });
    const result = submitVerification(
      publisher,
      { legalName: "Test Co", taxId: "123456", country: "US", payoutMethod: "bank" },
      auditDeps,
    );

    expect(result.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("publisher.verification_submitted");
    expect(events[0].fromState).toBe("unverified");
    expect(events[0].toState).toBe("pending");
  });

  it("emits audit event on suspendPublisher", () => {
    const { deps: auditDeps, events } = buildAuditDeps();
    const publisher = basePublisher({ verificationStatus: "verified" });
    const result = suspendPublisher(publisher, auditDeps);

    expect(result.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("publisher.suspended");
    expect(events[0].fromState).toBe("verified");
    expect(events[0].toState).toBe("suspended");
  });

  it("emits audit event on reinstatePublisher", () => {
    const { deps: auditDeps, events } = buildAuditDeps();
    const publisher = basePublisher({ verificationStatus: "suspended" });
    const result = reinstatePublisher(publisher, auditDeps);

    expect(result.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("publisher.reinstated");
    expect(events[0].fromState).toBe("suspended");
    expect(events[0].toState).toBe("verified");
  });
});
