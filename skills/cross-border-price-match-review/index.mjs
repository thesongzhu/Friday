import { compact } from "../_shared/friday-runtime-skill-utils.mjs";
import {
  bucketLines,
  buildEmptyResult,
  buildLanguageSummary,
  clampHighlights,
  detectKeywordMatches,
  readSkillInputText,
  summarizeBuckets,
  tokenizeNotes,
} from "../_shared/cross-border-skill-utils.mjs";

const SKILL_LABEL = "Cross-border Price Match Review";
const OUTPUT_KEY = "priceReview";

const PRICE_BUCKETS = [
  {
    id: "price_drop",
    label: "Competitor Price Drop",
    keywords: ["price drop", "lower price", "lowered price", "dropped to", "降价", "降到", "降幅"],
  },
  {
    id: "price_increase",
    label: "Competitor Price Increase",
    keywords: ["price up", "increased price", "raised price", "涨价", "涨到", "提价"],
  },
  {
    id: "coupon_stack",
    label: "Coupon / Stacked Discount",
    keywords: ["coupon", "stacked", "stackable", "promo code", "discount", "voucher", "优惠券", "叠加", "满减", "促销码"],
  },
  {
    id: "shipping_promise",
    label: "Shipping / Delivery Promise",
    keywords: ["free shipping", "shipping subsidy", "express", "fast delivery", "next-day", "free returns", "免运", "包邮", "次日达", "免运费"],
  },
  {
    id: "bundle_framing",
    label: "Bundle / Multi-pack Framing",
    keywords: ["bundle", "set", "combo", "pack", "value pack", "multi-pack", "套装", "组合", "捆绑", "多件装"],
  },
  {
    id: "listing_quality_gap",
    label: "Listing Quality Gap",
    keywords: ["weaker listing", "stronger listing", "better images", "better video", "better title", "review gap", "rating gap", "评分差", "评论数差", "图文更好"],
  },
];

const HUMAN_REVIEW_KEYWORDS = [
  "match price",
  "price match",
  "match this price",
  "tracking subsidy",
  "shipping subsidy",
  "ad budget",
  "promotional budget",
  "exclusive coupon",
  "auto-match",
  "跟价",
  "补贴",
  "下调价格",
  "冲量",
  "压制",
];

function summarizeAdvice(buckets, requiresHumanReview) {
  if (requiresHumanReview) {
    return "Stop before any auto price action — the notes already imply a price-match decision; queue this for human approval.";
  }
  if (buckets.length === 0) {
    return "No price gap signals detected — keep the existing price band today.";
  }
  const top = buckets[0];
  if (top.id === "price_drop") {
    return "A competitor price drop appears; do not auto-match. Confirm listing quality, shipping promise, and margin before approving any move.";
  }
  if (top.id === "price_increase") {
    return "A competitor price went up; consider whether to hold and capture share, but do not auto-raise without operator approval.";
  }
  if (top.id === "coupon_stack") {
    return "Coupon stacking widens the effective gap; quantify the stacked discount before deciding if a coupon response is needed.";
  }
  if (top.id === "shipping_promise") {
    return "The gap is in shipping/delivery; check whether your fulfillment mode can match before considering any price change.";
  }
  if (top.id === "bundle_framing") {
    return "The gap looks like a bundle/multi-pack framing change; consider a bundle test instead of a price drop.";
  }
  if (top.id === "listing_quality_gap") {
    return "Listing quality is the primary gap; do not match price until the listing gap is closed.";
  }
  return `Start with ${top.label.toLowerCase()} since it has the strongest signal in today's price notes.`;
}

export async function execute(input = {}) {
  const text = readSkillInputText(input, "priceSignals", "notes", "text");
  if (!text) {
    return buildEmptyResult(SKILL_LABEL, OUTPUT_KEY);
  }

  const lines = tokenizeNotes(text);
  const buckets = bucketLines(lines, PRICE_BUCKETS);
  const language = buildLanguageSummary(lines);
  const humanReviewSignals = detectKeywordMatches(text, HUMAN_REVIEW_KEYWORDS);
  const requiresHumanReview = humanReviewSignals.length > 0;
  const highlights = clampHighlights(
    buckets.flatMap((bucket) => bucket.examples),
    5,
  );
  const advice = summarizeAdvice(buckets, requiresHumanReview);
  const priceReview = summarizeBuckets(buckets, {
    headline: "Price-gap clusters",
    emptyMessage: "Price-gap clusters: no measurable changes today.",
  });
  const summary = compact(
    `Price review: ${String(buckets.length)} cluster(s) across ${String(lines.length)} note(s); top focus: ${buckets[0]?.label ?? "no gap"}; human approval: ${requiresHumanReview ? "required" : "not flagged"}.`,
    220,
  );

  return {
    [OUTPUT_KEY]: priceReview,
    summary,
    nextStep: advice,
    details: {
      skillLabel: SKILL_LABEL,
      outputKey: OUTPUT_KEY,
      lineCount: lines.length,
      buckets,
      language,
      highlights,
      humanReviewSignals,
      requiresHumanReview,
      hasInput: true,
    },
  };
}
