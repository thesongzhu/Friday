import { describe, expect, it } from "vitest";
import type {
  FridayCreatorProfile,
  FridayMarketplaceAssetSummary,
  FridayMarketplaceRequestPost,
} from "../../../ui/src/lib/api/marketplace";
import {
  buildMarketplaceHref,
  buildMarketplaceAssistantCards,
  summarizeCreatorSupport,
  summarizeMarketplaceRequestState,
} from "../../../ui/src/lib/marketplace/view-models";

describe("marketplace view models", () => {
  it("prefers public installable assets in assistant cards", () => {
    const assets: FridayMarketplaceAssetSummary[] = [
      {
        assetId: "workflow:ops-report",
        assetType: "workflow",
        title: "Ops Report",
        summary: "Builds a daily report.",
        publisherName: "Team Ops",
        latestVersion: "1.2.0",
        maturity: "validated_and_keep",
        verificationStatus: "verified",
        publicEligible: true,
        installable: true,
        trustScore: 70,
      },
      {
        assetId: "skill:error-triage",
        assetType: "skill",
        title: "Error Triage",
        summary: "Triage production errors.",
        publisherName: "Reliability",
        latestVersion: "2.1.0",
        maturity: "validated_and_keep",
        verificationStatus: "verified",
        publicEligible: true,
        installable: true,
        trustScore: 90,
      },
      {
        assetId: "agent:weekly-coach",
        assetType: "agent",
        title: "Weekly Coach",
        summary: "Guides weekly planning.",
        publisherName: "Enablement",
        latestVersion: "0.9.0",
        maturity: "validated_but_temporary",
        verificationStatus: "verified",
        publicEligible: false,
        installable: false,
        trustScore: 85,
      },
    ];

    const cards = buildMarketplaceAssistantCards(assets);

    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      assetId: "skill:error-triage",
      installable: true,
    });
    expect(cards[1]).toMatchObject({
      assetId: "workflow:ops-report",
      installable: false,
    });
  });

  it("summarizes request openness and accepted work", () => {
    const requests: FridayMarketplaceRequestPost[] = [
      {
        id: "req-1",
        assetKind: "skill",
        title: "Personal skill",
        goal: "Automate triage",
        desiredOutcome: "One click triage",
        constraints: [],
        budgetSupportIntent: null,
        privacy: "private",
        publishability: "allow_publication",
        status: "open",
        createdAt: "2026-03-09T12:00:00.000Z",
        updatedAt: "2026-03-09T12:00:00.000Z",
      },
      {
        id: "req-2",
        assetKind: "workflow",
        title: "Weekly report",
        goal: "Generate updates",
        desiredOutcome: "Friday drafts the report",
        constraints: [],
        budgetSupportIntent: "$50 tip",
        privacy: "private",
        publishability: "allow_publication",
        status: "accepted",
        createdAt: "2026-03-09T12:00:00.000Z",
        updatedAt: "2026-03-09T12:00:00.000Z",
      },
      {
        id: "req-3",
        assetKind: "agent",
        title: "Coach",
        goal: "Guide planning",
        desiredOutcome: "Weekly plan",
        constraints: [],
        budgetSupportIntent: null,
        privacy: "private",
        publishability: "keep_private",
        status: "closed",
        createdAt: "2026-03-09T12:00:00.000Z",
        updatedAt: "2026-03-09T12:00:00.000Z",
      },
    ];

    expect(summarizeMarketplaceRequestState(requests)).toEqual({
      openCount: 2,
      acceptedCount: 1,
    });
  });

  it("summarizes creator verification coverage", () => {
    const creators: FridayCreatorProfile[] = [
      {
        id: "creator-1",
        handle: "ops-team",
        displayName: "Ops Team",
        bio: "Builds operations assets",
        verifiedPublisher: true,
        reputation: {
          overallScore: 88,
          supportCount: 8,
          supportTotal: { amount: 12000, currency: "USD" },
          installCount: 42,
          retentionScore: 91,
          verificationPassRate: 0.96,
          fulfilledRequestCount: 6,
        },
      },
      {
        id: "creator-2",
        handle: "helpers",
        displayName: "Helpers",
        bio: "Builds team helpers",
        verifiedPublisher: false,
        reputation: {
          overallScore: 74,
          supportCount: 3,
          supportTotal: { amount: 5000, currency: "USD" },
          installCount: 10,
          retentionScore: 79,
          verificationPassRate: 0.84,
          fulfilledRequestCount: 2,
        },
      },
    ];

    expect(summarizeCreatorSupport(creators)).toEqual({
      creatorCount: 2,
      verifiedCount: 1,
    });
  });

  it("builds marketplace handoff urls with assistant context", () => {
    expect(
      buildMarketplaceHref({
        assetId: "skill:error-triage",
        requestKind: "workflow",
        goal: "Need a weekly reporting workflow",
      }),
    ).toBe(
      "/marketplace?asset=skill%3Aerror-triage&requestKind=workflow&goal=Need+a+weekly+reporting+workflow",
    );
    expect(buildMarketplaceHref()).toBe("/marketplace");
  });
});
