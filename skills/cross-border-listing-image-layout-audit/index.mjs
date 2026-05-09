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

const SKILL_LABEL = "Cross-border Listing Image Layout Audit";
const OUTPUT_KEY = "listingAudit";

const LISTING_BUCKETS = [
  {
    id: "hero_first_impression",
    label: "Hero / First Impression",
    keywords: ["main image", "hero image", "first frame", "thumbnail", "hero shot", "首图", "主图", "首屏", "缩略图"],
  },
  {
    id: "info_hierarchy",
    label: "Information Hierarchy",
    keywords: ["info hierarchy", "headline", "subheading", "callout", "bullet", "section order", "信息层级", "标题", "卖点", "分块"],
  },
  {
    id: "lifestyle_vs_studio",
    label: "Lifestyle vs Studio",
    keywords: ["lifestyle", "studio shot", "in-use", "scene", "context", "lifestyle photo", "生活场景", "场景图", "棚拍"],
  },
  {
    id: "copy_density",
    label: "Copy Density",
    keywords: ["too much text", "wall of text", "too sparse", "copy length", "text density", "文字过多", "文字过少", "文字密度"],
  },
  {
    id: "trust_signals",
    label: "Trust Signals",
    keywords: ["badge", "certification", "warranty", "review snippet", "rating", "social proof", "认证", "保障", "评分", "社会证明"],
  },
  {
    id: "compliance_layout",
    label: "Compliance / Disclosure",
    keywords: ["compliance", "disclosure", "claim", "ftc", "regulatory", "warning", "合规", "声明", "提示", "警告"],
  },
];

const HUMAN_REVIEW_KEYWORDS = [
  "auto publish",
  "ship to live",
  "go live now",
  "auto edit",
  "auto-overwrite",
  "rewrite live listing",
  "立即发布",
  "直接上线",
  "覆盖线上",
];

function summarizeAdvice(buckets, humanReviewSignals) {
  if (humanReviewSignals.length > 0) {
    return "Notes mention auto-publish or live overwrite; this audit must not auto-act — queue for human approval before any live listing change.";
  }
  if (buckets.length === 0) {
    return "No actionable listing notes; add concrete listing observations and rerun.";
  }
  const top = buckets[0];
  if (top.id === "hero_first_impression") {
    return "Hero / first-impression issues dominate; draft a hero-image candidate set for review before any change goes live.";
  }
  if (top.id === "info_hierarchy") {
    return "Info hierarchy is the largest gap; reorder headline / bullet structure on a draft only — do not push directly to live.";
  }
  if (top.id === "lifestyle_vs_studio") {
    return "Notes flag lifestyle / studio mix issues; queue a small batch of draft variants for human review.";
  }
  if (top.id === "copy_density") {
    return "Copy density issues dominate; suggest a copy-trim/expand draft and route to human review.";
  }
  if (top.id === "trust_signals") {
    return "Trust signals are weak; gather candidate badges/reviews/warranties for review and never invent compliance claims.";
  }
  if (top.id === "compliance_layout") {
    return "Compliance / disclosure issues appear; do not auto-edit — escalate to a human reviewer.";
  }
  return `Open the ${top.label.toLowerCase()} cluster first and queue every draft change for human approval before publishing.`;
}

export async function execute(input = {}) {
  const text = readSkillInputText(input, "listingNotes", "weeklyReview", "notes", "text");
  if (!text) {
    return buildEmptyResult(SKILL_LABEL, OUTPUT_KEY);
  }

  const lines = tokenizeNotes(text);
  const buckets = bucketLines(lines, LISTING_BUCKETS);
  const language = buildLanguageSummary(lines);
  const humanReviewSignals = detectKeywordMatches(text, HUMAN_REVIEW_KEYWORDS);
  const highlights = clampHighlights(
    buckets.flatMap((bucket) => bucket.examples),
    5,
  );
  const advice = summarizeAdvice(buckets, humanReviewSignals);
  const listingAudit = summarizeBuckets(buckets, {
    headline: "Listing audit clusters",
    emptyMessage: "Listing audit clusters: no measurable signal yet.",
  });
  const summary = compact(
    `Listing audit: ${String(buckets.length)} cluster(s) across ${String(lines.length)} note(s); top focus: ${buckets[0]?.label ?? "no signal"}; human approval: ${humanReviewSignals.length > 0 ? "required" : "not flagged"}.`,
    220,
  );

  return {
    [OUTPUT_KEY]: listingAudit,
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
      requiresHumanReview: humanReviewSignals.length > 0,
      hasInput: true,
    },
  };
}
