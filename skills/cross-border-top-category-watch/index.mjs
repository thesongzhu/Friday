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

const SKILL_LABEL = "Cross-border Top Category Watch";
const OUTPUT_KEY = "watchBoard";

const CATEGORY_BUCKETS = [
  {
    id: "new_entrants",
    label: "New Entrants / New SKU in Top",
    keywords: ["new entrant", "new sku", "first time", "first listing", "newly listed", "新进入", "新品", "新上架", "首次进入"],
  },
  {
    id: "rank_climber",
    label: "Rank Climber",
    keywords: ["climb", "moved up", "moved to", "jumped", "rose to", "rose from", "rank up", "上升", "上涨", "排名上升", "升至"],
  },
  {
    id: "price_action",
    label: "Price Action",
    keywords: ["price drop", "dropped price", "price cut", "price up", "discount", "stacked coupon", "stackable coupon", "coupon", "shipping subsidy", "降价", "涨价", "促销", "优惠券", "运费补贴"],
  },
  {
    id: "rank_drop",
    label: "Rank Drop",
    keywords: ["dropped to rank", "fell to", "fell out of", "lost top spot", "lost spot", "down to rank", "rank down", "rank drop", "下跌", "掉出", "排名下降"],
  },
  {
    id: "creative_update",
    label: "Creative / Content Update",
    keywords: ["main image", "hero image", "video", "creative", "ad copy", "title change", "首图", "主图", "视频", "素材", "标题"],
  },
  {
    id: "seller_shift",
    label: "Seller / Storefront Shift",
    keywords: ["seller change", "official store", "brand store", "storefront", "official", "店铺", "官方店", "店铺切换"],
  },
  {
    id: "compliance_signal",
    label: "Compliance / Policy Signal",
    keywords: ["delisted", "removed", "violation", "policy", "下架", "违规", "封禁"],
  },
];

function summarizeAdvice(buckets) {
  if (buckets.length === 0) {
    return "No category movement detected — keep the existing watch targets and check again tomorrow.";
  }
  const top = buckets[0];
  if (top.id === "new_entrants") {
    return `Open the new entrants first; one of them may already be the next watch target.`;
  }
  if (top.id === "rank_climber") {
    return `Inspect the climbing SKUs and note which competitor is gaining momentum before adjusting your own listing.`;
  }
  if (top.id === "rank_drop") {
    return `Check what changed for the dropping SKUs (price, ad spend, or creative) before re-investing in the same lane.`;
  }
  if (top.id === "price_action") {
    return `Compare the price actions to your current price band before deciding to match, hold, or reframe.`;
  }
  if (top.id === "creative_update") {
    return `Open the creative updates and decide whether to mirror, fork, or ignore — never auto-copy competitor assets.`;
  }
  if (top.id === "compliance_signal") {
    return `Confirm whether any compliance signal also applies to your own listings before continuing the day.`;
  }
  return `Start with ${top.label.toLowerCase()} since it has the strongest signal in today's category notes.`;
}

export async function execute(input = {}) {
  const text = readSkillInputText(input, "categoryWatchNotes", "notes", "text");
  if (!text) {
    return buildEmptyResult(SKILL_LABEL, OUTPUT_KEY);
  }

  const lines = tokenizeNotes(text);
  const buckets = bucketLines(lines, CATEGORY_BUCKETS);
  const language = buildLanguageSummary(lines);
  const highlights = clampHighlights(
    buckets.flatMap((bucket) => bucket.examples),
    5,
  );
  const advice = summarizeAdvice(buckets);
  const watchBoard = summarizeBuckets(buckets, {
    headline: "Category Top 10 movement",
    emptyMessage: "Category Top 10 movement: no measurable changes today.",
  });
  const summary = compact(
    `Category watch board: ${String(buckets.length)} movement cluster(s) across ${String(lines.length)} note(s); top focus: ${buckets[0]?.label ?? "no movement"}.`,
    220,
  );

  return {
    [OUTPUT_KEY]: watchBoard,
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
