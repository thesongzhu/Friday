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

const SKILL_LABEL = "Cross-border Weekly Growth Review";
const OUTPUT_KEY = "weeklyReview";

const KEEP_BUCKETS = [
  {
    id: "keep_signal",
    label: "Keep",
    keywords: ["worked", "winning", "kept up", "stayed strong", "best", "top performer", "维持", "保留", "效果好", "继续做"],
  },
  {
    id: "change_signal",
    label: "Change",
    keywords: ["needs change", "tweak", "adjust", "iterate", "rework", "refresh", "调整", "优化", "改进", "重做"],
  },
  {
    id: "stop_signal",
    label: "Stop",
    keywords: ["stop", "drop", "kill", "pause", "shut down", "wasted time", "停掉", "停用", "暂停", "停止", "浪费时间"],
  },
  {
    id: "learning_signal",
    label: "Learnings (no action yet)",
    keywords: ["learned", "insight", "noted", "interesting", "observed", "学到", "发现", "观察"],
  },
  {
    id: "operating_friction",
    label: "Operating Friction",
    keywords: ["bottleneck", "missed", "delay", "slow", "blocked", "stuck", "瓶颈", "被卡住", "拖延", "延期"],
  },
];

const HIGH_IMPACT_KEYWORDS = [
  "disable workflow",
  "auto approve",
  "increase automation",
  "automate",
  "remove approval",
  "default-on",
  "停用工作流",
  "自动批准",
  "降低审批",
  "提升自动化",
  "默认开启",
];

function summarizeAdvice(buckets, highImpactSignals) {
  if (highImpactSignals.length > 0) {
    return "Notes mention disabling a core workflow, increasing automation, or removing approval; require explicit human confirmation before applying.";
  }
  if (buckets.length === 0) {
    return "No tuning signal yet; add concrete weekly signals and rerun to generate keep / change / stop guidance.";
  }
  const top = buckets[0];
  if (top.id === "stop_signal") {
    return "Stop signals dominate; before disabling any daily routine, confirm whether the stop is permanent or just for this cycle.";
  }
  if (top.id === "change_signal") {
    return "Cluster the change signals into discrete daily-routine adjustments; queue each adjustment for human approval before pushing.";
  }
  if (top.id === "operating_friction") {
    return "Address the friction bottleneck first; tuning while a bottleneck is open will tune on noisy data.";
  }
  if (top.id === "learning_signal") {
    return "Learnings without explicit action — leave the operating profile unchanged this cycle.";
  }
  if (top.id === "keep_signal") {
    return "Keep signals dominate; confirm that nothing else needs to change and skip a tuning cycle if appropriate.";
  }
  return `Open the ${top.label.toLowerCase()} cluster first and queue any tuning suggestion for explicit human approval.`;
}

export async function execute(input = {}) {
  const text = readSkillInputText(input, "weeklySignals", "notes", "text");
  if (!text) {
    return buildEmptyResult(SKILL_LABEL, OUTPUT_KEY);
  }

  const lines = tokenizeNotes(text);
  const buckets = bucketLines(lines, KEEP_BUCKETS);
  const language = buildLanguageSummary(lines);
  const highImpactSignals = detectKeywordMatches(text, HIGH_IMPACT_KEYWORDS);
  const highlights = clampHighlights(
    buckets.flatMap((bucket) => bucket.examples),
    5,
  );
  const advice = summarizeAdvice(buckets, highImpactSignals);
  const weeklyReview = summarizeBuckets(buckets, {
    headline: "Weekly tuning clusters",
    emptyMessage: "Weekly tuning clusters: no measurable signal this week.",
  });
  const summary = compact(
    `Weekly review: ${String(buckets.length)} cluster(s) across ${String(lines.length)} note(s); top focus: ${buckets[0]?.label ?? "no signal"}; high-impact tuning: ${highImpactSignals.length > 0 ? "flagged" : "not flagged"}.`,
    220,
  );

  return {
    [OUTPUT_KEY]: weeklyReview,
    summary,
    nextStep: advice,
    details: {
      skillLabel: SKILL_LABEL,
      outputKey: OUTPUT_KEY,
      lineCount: lines.length,
      buckets,
      language,
      highlights,
      highImpactSignals,
      requiresHumanApproval: highImpactSignals.length > 0,
      hasInput: true,
    },
  };
}
