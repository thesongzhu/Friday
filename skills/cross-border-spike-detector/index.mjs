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

const SKILL_LABEL = "Cross-border Spike Detector";
const OUTPUT_KEY = "spikeReview";

const SPIKE_BUCKETS = [
  {
    id: "sales_spike",
    label: "Sales Volume Spike",
    keywords: ["sales spike", "sales surge", "orders jumped", "gmv spike", "sold out", "stock cleared", "销量爆发", "爆单", "订单激增", "售空"],
  },
  {
    id: "viral_signal",
    label: "Viral / Creator Signal",
    keywords: ["went viral", "trending", "viral video", "creator post", "ugc", "tiktok hashtag", "trending sound", "刷屏", "视频爆", "创作者", "话题"],
  },
  {
    id: "ad_lift",
    label: "Paid Ad Lift",
    keywords: ["ad lift", "ad surge", "campaign winning", "campaign lift", "scaling ads", "broke through", "广告爆", "投放暴涨", "ad scaling"],
  },
  {
    id: "search_trend",
    label: "Search Trend",
    keywords: ["search trend", "google trends", "amazon search", "search volume", "搜索量", "搜索榜", "搜索关键词"],
  },
  {
    id: "category_lift",
    label: "Category-wide Lift",
    keywords: ["category lift", "whole category", "many sellers", "shared lift", "类目整体", "类目上涨", "全类目"],
  },
];

const FOLLOWUP_RISK_KEYWORDS = [
  "knockoff",
  "imitation",
  "copy",
  "trademark",
  "ip risk",
  "patent",
  "regulator",
  "compliance",
  "侵权",
  "盗版",
  "假货",
  "知识产权",
  "合规",
];

function summarizeAdvice(buckets, riskSignals) {
  if (riskSignals.length > 0) {
    return "Spike notes contain IP / compliance risk language; do not auto-follow this spike — queue for human review.";
  }
  if (buckets.length === 0) {
    return "No spikes detected this week — keep current scouting depth and check next week.";
  }
  const top = buckets[0];
  if (top.id === "sales_spike") {
    return "Confirm whether the sales spike is repeatable (organic vs ad-driven) before recommending sampling or supplier outreach.";
  }
  if (top.id === "viral_signal") {
    return "Check whether the viral signal is single-creator or multi-creator before treating it as a category trend.";
  }
  if (top.id === "ad_lift") {
    return "Inspect the ad creative and audience signal; ad lift alone is not enough to commit to procurement.";
  }
  if (top.id === "search_trend") {
    return "Cross-check search trend against actual sales data before adding to the scouting backlog.";
  }
  if (top.id === "category_lift") {
    return "Treat category lift as a watch signal, not a buy signal; the operator should pick which SKU narrows it down.";
  }
  return `Start with ${top.label.toLowerCase()} since it has the strongest signal in this week's spike notes.`;
}

export async function execute(input = {}) {
  const text = readSkillInputText(input, "spikeSignals", "notes", "text");
  if (!text) {
    return buildEmptyResult(SKILL_LABEL, OUTPUT_KEY);
  }

  const lines = tokenizeNotes(text);
  const buckets = bucketLines(lines, SPIKE_BUCKETS);
  const language = buildLanguageSummary(lines);
  const riskSignals = detectKeywordMatches(text, FOLLOWUP_RISK_KEYWORDS);
  const highlights = clampHighlights(
    buckets.flatMap((bucket) => bucket.examples),
    5,
  );
  const advice = summarizeAdvice(buckets, riskSignals);
  const spikeReview = summarizeBuckets(buckets, {
    headline: "Spike clusters",
    emptyMessage: "Spike clusters: no measurable spikes this week.",
  });
  const summary = compact(
    `Spike review: ${String(buckets.length)} spike cluster(s) across ${String(lines.length)} note(s); top focus: ${buckets[0]?.label ?? "no spike"}; risk flag: ${riskSignals.length > 0 ? "raised" : "none"}.`,
    220,
  );

  return {
    [OUTPUT_KEY]: spikeReview,
    summary,
    nextStep: advice,
    details: {
      skillLabel: SKILL_LABEL,
      outputKey: OUTPUT_KEY,
      lineCount: lines.length,
      buckets,
      language,
      highlights,
      riskSignals,
      hasRiskFlag: riskSignals.length > 0,
      hasInput: true,
    },
  };
}
