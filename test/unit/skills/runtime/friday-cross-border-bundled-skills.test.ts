import { describe, expect, it } from "vitest";

describe("cross-border bundled skills", () => {
  it("summarize-shop-performance clusters store-health notes and returns issueClusters", async () => {
    const { execute } = await import("../../../../skills/summarize-shop-performance/index.mjs");

    const result = await execute({
      performanceNotes: [
        "Awaiting collection backlog rising on TikTok Shop today",
        "Refund pressure increasing for Hair Dryer SKU",
        "ROAS dropped on the new ad set; needs review",
      ].join("\n"),
    });

    expect(typeof result.issueClusters).toBe("string");
    expect(result.issueClusters.length).toBeGreaterThan(0);
    expect(result.summary).toContain("Store action board");
    expect(result.details.hasInput).toBe(true);
    expect(result.details.lineCount).toBe(3);
    expect(result.details.buckets.length).toBeGreaterThan(0);
    expect(result.details.buckets.some((bucket) => bucket.id === "fulfillment_risk")).toBe(true);
    expect(result.details.buckets.some((bucket) => bucket.id === "refund_return")).toBe(true);
  });

  it("summarize-shop-performance returns a soft empty bundle when notes are missing", async () => {
    const { execute } = await import("../../../../skills/summarize-shop-performance/index.mjs");

    const result = await execute({});

    expect(result.issueClusters).toContain("no notes were provided");
    expect(result.details.hasInput).toBe(false);
    expect(result.details.buckets).toEqual([]);
  });

  it("cross-border-top-category-watch clusters category movement notes and returns watchBoard", async () => {
    const { execute } = await import("../../../../skills/cross-border-top-category-watch/index.mjs");

    const result = await execute({
      categoryWatchNotes: [
        "Travel Hair Dryer climbed from rank 12 to rank 6",
        "New entrant: Nano Dryer launched yesterday in the Top 10",
        "Competitor dropped price by 15% with stacked coupon",
      ].join("\n"),
    });

    expect(typeof result.watchBoard).toBe("string");
    expect(result.watchBoard.length).toBeGreaterThan(0);
    expect(result.summary).toContain("Category watch board");
    expect(result.details.buckets.some((bucket) => bucket.id === "rank_climber")).toBe(true);
    expect(result.details.buckets.some((bucket) => bucket.id === "new_entrants")).toBe(true);
    expect(result.details.buckets.some((bucket) => bucket.id === "price_action")).toBe(true);
  });

  it("cross-border-price-match-review clusters price gap notes and surfaces human-review prompt", async () => {
    const { execute } = await import("../../../../skills/cross-border-price-match-review/index.mjs");

    const result = await execute({
      priceSignals: [
        "Competitor price drop to US$22 with stackable coupon",
        "Free shipping promise narrowed to 2 days",
        "Operator is considering a price match — wants Friday's view",
      ].join("\n"),
    });

    expect(typeof result.priceReview).toBe("string");
    expect(result.summary).toContain("Price review");
    expect(result.details.requiresHumanReview).toBe(true);
    expect(result.details.humanReviewSignals.length).toBeGreaterThan(0);
    expect(result.nextStep).toMatch(/human approval|price-match|approval/i);
  });

  it("cross-border-customer-service-brief clusters refund/return notes and surfaces escalation when warranted", async () => {
    const { execute } = await import("../../../../skills/cross-border-customer-service-brief/index.mjs");

    const result = await execute({
      serviceNotes: [
        "Refund pressure on the Travel Hair Dryer SKU",
        "Buyer threatened a chargeback if package not delivered",
        "Three 1-star reviews mentioning broken plug",
      ].join("\n"),
    });

    expect(typeof result.serviceBrief).toBe("string");
    expect(result.summary).toContain("Support brief");
    expect(result.details.requiresEscalation).toBe(true);
    expect(result.details.escalationSignals.length).toBeGreaterThan(0);
    expect(result.details.buckets.some((bucket) => bucket.id === "refund_pressure")).toBe(true);
    expect(result.details.buckets.some((bucket) => bucket.id === "bad_review")).toBe(true);
  });

  it("cross-border-spike-detector clusters spike notes and returns spikeReview", async () => {
    const { execute } = await import("../../../../skills/cross-border-spike-detector/index.mjs");

    const result = await execute({
      spikeSignals: [
        "Sales spike on the Mini Dryer; orders jumped 4x",
        "TikTok creator video went viral and trending hashtag activity",
        "Search volume on Amazon search rose for 'foldable hair dryer'",
      ].join("\n"),
    });

    expect(typeof result.spikeReview).toBe("string");
    expect(result.summary).toContain("Spike review");
    expect(result.details.buckets.some((bucket) => bucket.id === "sales_spike")).toBe(true);
    expect(result.details.buckets.some((bucket) => bucket.id === "viral_signal")).toBe(true);
    expect(result.details.buckets.some((bucket) => bucket.id === "search_trend")).toBe(true);
    expect(result.details.hasRiskFlag).toBe(false);
  });

  it("cross-border-spike-detector flags IP/compliance risk when notes mention it", async () => {
    const { execute } = await import("../../../../skills/cross-border-spike-detector/index.mjs");

    const result = await execute({
      spikeSignals: "Sales spike but the product looks like a knockoff with possible trademark infringement",
    });

    expect(result.details.hasRiskFlag).toBe(true);
    expect(result.nextStep).toMatch(/IP \/ compliance|human review/);
  });

  it("cross-border-product-scout consumes spikeReview-style input and returns productScout", async () => {
    const { execute } = await import("../../../../skills/cross-border-product-scout/index.mjs");

    const result = await execute({
      marketSignals: [
        "Spike review: Sales Volume Spike (3): Mini Dryer orders jumped 4x",
        "Demand: search volume rising on foldable hair dryer queries",
        "Operator wants to place a sample order this week",
      ].join("\n"),
    });

    expect(typeof result.productScout).toBe("string");
    expect(result.summary).toContain("Product scout");
    expect(result.details.requiresHumanReview).toBe(true);
    expect(result.details.approvalSignals.length).toBeGreaterThan(0);
    expect(result.nextStep).toMatch(/human review|sampling|stocking|listing/i);
  });

  it("cross-border-weekly-growth-review clusters weekly signals and returns weeklyReview", async () => {
    const { execute } = await import("../../../../skills/cross-border-weekly-growth-review/index.mjs");

    const result = await execute({
      weeklySignals: [
        "Daily store check kept up: refund clusters caught earlier",
        "Need to adjust the price-gap threshold for the new category",
        "Stop the weekly viral scout for now — single-creator noise wasted time",
      ].join("\n"),
    });

    expect(typeof result.weeklyReview).toBe("string");
    expect(result.summary).toContain("Weekly review");
    expect(result.details.buckets.some((bucket) => bucket.id === "keep_signal")).toBe(true);
    expect(result.details.buckets.some((bucket) => bucket.id === "change_signal")).toBe(true);
    expect(result.details.buckets.some((bucket) => bucket.id === "stop_signal")).toBe(true);
    expect(result.details.requiresHumanApproval).toBe(false);
  });

  it("cross-border-weekly-growth-review flags high-impact tuning when notes mention it", async () => {
    const { execute } = await import("../../../../skills/cross-border-weekly-growth-review/index.mjs");

    const result = await execute({
      weeklySignals: "Increase automation by removing approval on the daily store check workflow",
    });

    expect(result.details.requiresHumanApproval).toBe(true);
    expect(result.nextStep).toMatch(/human confirmation|approval/);
  });

  it("cross-border-listing-image-layout-audit clusters listing notes and returns listingAudit", async () => {
    const { execute } = await import("../../../../skills/cross-border-listing-image-layout-audit/index.mjs");

    const result = await execute({
      listingNotes: [
        "Hero image is text-heavy; first frame doesn't show product clearly",
        "Detail page lacks lifestyle photo; only studio shots",
        "Trust badges and warranty info not visible above the fold",
      ].join("\n"),
    });

    expect(typeof result.listingAudit).toBe("string");
    expect(result.summary).toContain("Listing audit");
    expect(result.details.buckets.some((bucket) => bucket.id === "hero_first_impression")).toBe(true);
    expect(result.details.buckets.some((bucket) => bucket.id === "lifestyle_vs_studio")).toBe(true);
    expect(result.details.buckets.some((bucket) => bucket.id === "trust_signals")).toBe(true);
    expect(result.details.requiresHumanReview).toBe(false);
  });

  it("cross-border-listing-image-layout-audit flags human-review when auto-publish appears", async () => {
    const { execute } = await import("../../../../skills/cross-border-listing-image-layout-audit/index.mjs");

    const result = await execute({
      listingNotes: "Hero update needed; auto publish to live listing once Friday drafts the change",
    });

    expect(result.details.requiresHumanReview).toBe(true);
    expect(result.nextStep).toMatch(/human approval|approval/i);
  });
});
