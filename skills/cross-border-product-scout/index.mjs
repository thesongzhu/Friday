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

const SKILL_LABEL = "Cross-border Product Scout";
const OUTPUT_KEY = "productScout";

const DIRECTION_BUCKETS = [
  {
    id: "market_signal_inbound",
    label: "Market Signal (from upstream)",
    keywords: ["spike review", "spike clusters", "category lift", "viral signal", "sales spike", "ad lift", "search trend", "spike", "lift"],
  },
  {
    id: "supplier_outreach",
    label: "Supplier / Sourcing Direction",
    keywords: ["supplier", "factory", "moq", "vendor", "sourcing", "procurement", "供应商", "工厂", "起订", "采购", "找货"],
  },
  {
    id: "creative_direction",
    label: "Creative / Listing Direction",
    keywords: ["creative", "listing copy", "hero shot", "video angle", "ad angle", "ad copy", "title test", "素材", "首图", "视频", "标题"],
  },
  {
    id: "competitive_pressure",
    label: "Competitive Pressure",
    keywords: ["competitor", "incumbent seller", "official store", "brand store", "竞品", "现有卖家", "品牌店"],
  },
  {
    id: "demand_signal",
    label: "Demand Signal",
    keywords: ["demand", "search volume", "queries", "buyer intent", "wishlist", "saves", "需求", "搜索量", "收藏"],
  },
  {
    id: "rejection_signal",
    label: "Reject / Skip Signal",
    keywords: ["one-shot", "fad", "single creator", "weak repeat", "low margin", "saturated", "短命", "单波", "饱和", "毛利低"],
  },
];

const APPROVAL_BLOCK_KEYWORDS = [
  "sample order",
  "place sample",
  "purchase",
  "buy stock",
  "stock up",
  "list product",
  "go to market",
  "auto-list",
  "auto buy",
  "下样",
  "下采购单",
  "上架",
  "备货",
];

function summarizeAdvice(buckets, approvalSignals) {
  if (approvalSignals.length > 0) {
    return "The signals already imply procurement / launch action; this skill must not auto-act — queue for human review before any sampling, stocking, or listing.";
  }
  if (buckets.length === 0) {
    return "No usable scouting direction yet; add more concrete spike or demand signals and rerun.";
  }
  const topNonInbound = buckets.find((bucket) => bucket.id !== "market_signal_inbound") ?? buckets[0];
  if (topNonInbound.id === "rejection_signal") {
    return "Reject/skip signals dominate; recommend dropping these spikes from this week's scout list.";
  }
  if (topNonInbound.id === "supplier_outreach") {
    return "Cluster supplier-outreach hints into a short list and put a human reviewer on the actual outreach decision.";
  }
  if (topNonInbound.id === "creative_direction") {
    return "Use the creative hints to draft test angles only; do not auto-publish creative or copy competitor assets.";
  }
  if (topNonInbound.id === "competitive_pressure") {
    return "Map the competitive pressure before adding sample orders — the operator decides whether to enter or pass.";
  }
  if (topNonInbound.id === "demand_signal") {
    return "Quantify demand-signal magnitude and recurrence before recommending any procurement or listing step.";
  }
  return `Open the ${topNonInbound.label.toLowerCase()} cluster first and have an operator screen each direction before any execution step.`;
}

export async function execute(input = {}) {
  const text = readSkillInputText(input, "marketSignals", "spikeReview", "notes", "text");
  if (!text) {
    return buildEmptyResult(SKILL_LABEL, OUTPUT_KEY);
  }

  const lines = tokenizeNotes(text);
  const buckets = bucketLines(lines, DIRECTION_BUCKETS);
  const language = buildLanguageSummary(lines);
  const approvalSignals = detectKeywordMatches(text, APPROVAL_BLOCK_KEYWORDS);
  const highlights = clampHighlights(
    buckets.flatMap((bucket) => bucket.examples),
    5,
  );
  const advice = summarizeAdvice(buckets, approvalSignals);
  const productScout = summarizeBuckets(buckets, {
    headline: "Scouting directions",
    emptyMessage: "Scouting directions: no usable signal yet.",
  });
  const summary = compact(
    `Product scout: ${String(buckets.length)} direction(s) across ${String(lines.length)} note(s); top focus: ${buckets[0]?.label ?? "no direction"}; approval block: ${approvalSignals.length > 0 ? "raised" : "not raised"}.`,
    220,
  );

  return {
    [OUTPUT_KEY]: productScout,
    summary,
    nextStep: advice,
    details: {
      skillLabel: SKILL_LABEL,
      outputKey: OUTPUT_KEY,
      lineCount: lines.length,
      buckets,
      language,
      highlights,
      approvalSignals,
      requiresHumanReview: approvalSignals.length > 0,
      hasInput: true,
    },
  };
}
