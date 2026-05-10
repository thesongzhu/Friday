import { compact } from "../_shared/friday-runtime-skill-utils.mjs";
import {
  bucketLines,
  buildEmptyResult,
  buildLanguageSummary,
  clampHighlights,
  readSkillInputText,
  summarizeBuckets,
  tokenizeNotes,
} from "../_shared/cross-border-skill-utils.mjs";

const SKILL_LABEL = "Summarize Shop Performance";
const OUTPUT_KEY = "issueClusters";

const STORE_HEALTH_BUCKETS = [
  {
    id: "fulfillment_risk",
    label: "Fulfillment / Late Shipment",
    keywords: ["late ship", "late dispatch", "late shipment", "late fulfillment", "awaiting collection", "collection backlog", "stuck in warehouse", "未发货", "延迟发货", "履约", "发货超时"],
  },
  {
    id: "cancellation_risk",
    label: "Cancellation / Order Cancel",
    keywords: ["cancel", "order cancel", "buyer cancel", "auto cancel", "取消", "买家取消", "自动取消"],
  },
  {
    id: "refund_return",
    label: "Refund / Return Pressure",
    keywords: ["refund", "return", "rma", "退款", "退货", "售后退款", "退货率"],
  },
  {
    id: "ad_spend",
    label: "Ad Spend / ROAS",
    keywords: ["roas", "ad spend", "cpm", "cpc", "burn rate", "ad cost", "广告", "投放", "费比"],
  },
  {
    id: "listing_quality",
    label: "Listing Quality",
    keywords: ["listing", "title", "main image", "主图", "详情", "首图", "图文", "长图"],
  },
  {
    id: "shop_score",
    label: "Shop Score / Policy Risk",
    keywords: ["shop score", "policy", "violation", "warning letter", "store rating", "店铺分", "警告", "违规", "店铺评分"],
  },
  {
    id: "inventory_risk",
    label: "Inventory / Stock",
    keywords: ["out of stock", "low stock", "restock", "oos", "缺货", "断货", "补货"],
  },
];

function summarizeAdvice(buckets) {
  if (buckets.length === 0) {
    return "No risk clusters detected — the day looks operationally quiet.";
  }
  const top = buckets[0];
  if (top.id === "fulfillment_risk" || top.id === "cancellation_risk") {
    return `Triage ${top.label.toLowerCase()} first; one late or cancelled batch hides repeat risk.`;
  }
  if (top.id === "refund_return") {
    return `Cluster the refund/return notes into product/SKU buckets before deciding on policy or copy changes.`;
  }
  if (top.id === "ad_spend") {
    return `Pause or cap the worst ROAS line before approving any further budget increase.`;
  }
  if (top.id === "shop_score") {
    return `Open the shop policy panel and confirm whether any violation needs an appeal today.`;
  }
  return `Start with ${top.label.toLowerCase()} since it has the most signal in today's notes.`;
}

export async function execute(input = {}) {
  const text = readSkillInputText(input, "performanceNotes", "notes", "text");
  if (!text) {
    return buildEmptyResult(SKILL_LABEL, OUTPUT_KEY);
  }

  const lines = tokenizeNotes(text);
  const buckets = bucketLines(lines, STORE_HEALTH_BUCKETS);
  const language = buildLanguageSummary(lines);
  const highlights = clampHighlights(
    buckets.flatMap((bucket) => bucket.examples),
    5,
  );
  const advice = summarizeAdvice(buckets);
  const issueClusters = summarizeBuckets(buckets, {
    headline: "Store-health clusters",
    emptyMessage: "Store-health clusters: no measurable risks today.",
  });
  const summary = compact(
    `Store action board: ${String(buckets.length)} risk cluster(s) across ${String(lines.length)} note(s); top focus: ${buckets[0]?.label ?? "no risk cluster"}.`,
    220,
  );

  return {
    [OUTPUT_KEY]: issueClusters,
    summary,
    nextStep: advice,
    details: {
      skillLabel: SKILL_LABEL,
      outputKey: OUTPUT_KEY,
      lineCount: lines.length,
      buckets,
      language,
      highlights,
      hasInput: true,
    },
  };
}
