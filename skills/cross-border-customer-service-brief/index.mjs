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

const SKILL_LABEL = "Cross-border Customer Service Brief";
const OUTPUT_KEY = "serviceBrief";

const SUPPORT_BUCKETS = [
  {
    id: "refund_pressure",
    label: "Refund Pressure",
    keywords: ["refund", "money back", "退款", "全额退款"],
  },
  {
    id: "return_pressure",
    label: "Return Pressure",
    keywords: ["return", "rma", "send back", "退货", "寄回"],
  },
  {
    id: "delivery_complaint",
    label: "Delivery / Logistics Complaint",
    keywords: ["late delivery", "lost package", "wrong address", "carrier", "tracking", "lost in transit", "package not delivered", "not delivered", "未收到", "丢件", "物流", "派送"],
  },
  {
    id: "bad_review",
    label: "Bad Review / Low Rating",
    keywords: ["1 star", "one star", "1-star", "bad review", "low rating", "negative review", "差评", "低分", "差评率"],
  },
  {
    id: "product_quality",
    label: "Product Quality Complaint",
    keywords: ["broken", "defect", "damaged", "quality issue", "quality complaint", "doesn't work", "not working", "破损", "损坏", "质量", "不能用"],
  },
  {
    id: "policy_dispute",
    label: "Policy / Eligibility Dispute",
    keywords: ["policy", "not eligible", "denied", "appeal", "platform", "政策", "不符合", "申诉", "平台介入"],
  },
];

const ESCALATION_KEYWORDS = [
  "platform escalation",
  "escalate to platform",
  "appeal",
  "regulator",
  "fraud",
  "legal",
  "chargeback",
  "credit card dispute",
  "platform介入",
  "申诉",
  "投诉到平台",
  "拒付",
];

function summarizeAdvice(buckets, escalationSignals) {
  if (escalationSignals.length > 0) {
    return "Escalation signals appear; route to a human reviewer before sending any reply or refund decision.";
  }
  if (buckets.length === 0) {
    return "No support pressure detected — the inbox looks calm today.";
  }
  const top = buckets[0];
  if (top.id === "refund_pressure" || top.id === "return_pressure") {
    return `Cluster the ${top.label.toLowerCase()} cases by SKU first; require human approval before any refund-without-return or compensation reply.`;
  }
  if (top.id === "delivery_complaint") {
    return "Pull tracking events for the affected orders before replying; do not promise reshipment without operator approval.";
  }
  if (top.id === "product_quality") {
    return "Group the quality complaints by SKU and decide whether listing copy or QC needs an operator-led action.";
  }
  if (top.id === "bad_review") {
    return "Draft reply candidates only; do not auto-publish, and do not change the policy template without approval.";
  }
  if (top.id === "policy_dispute") {
    return "Read each policy dispute end-to-end before replying; platform-side disputes require human approval.";
  }
  return `Start with ${top.label.toLowerCase()} since it has the most signal in today's support notes.`;
}

export async function execute(input = {}) {
  const text = readSkillInputText(input, "serviceNotes", "notes", "text");
  if (!text) {
    return buildEmptyResult(SKILL_LABEL, OUTPUT_KEY);
  }

  const lines = tokenizeNotes(text);
  const buckets = bucketLines(lines, SUPPORT_BUCKETS);
  const language = buildLanguageSummary(lines);
  const escalationSignals = detectKeywordMatches(text, ESCALATION_KEYWORDS);
  const highlights = clampHighlights(
    buckets.flatMap((bucket) => bucket.examples),
    5,
  );
  const advice = summarizeAdvice(buckets, escalationSignals);
  const serviceBrief = summarizeBuckets(buckets, {
    headline: "Support clusters",
    emptyMessage: "Support clusters: no measurable pressure today.",
  });
  const summary = compact(
    `Support brief: ${String(buckets.length)} cluster(s) across ${String(lines.length)} note(s); top focus: ${buckets[0]?.label ?? "no pressure"}; escalation: ${escalationSignals.length > 0 ? "flagged" : "not flagged"}.`,
    220,
  );

  return {
    [OUTPUT_KEY]: serviceBrief,
    summary,
    nextStep: advice,
    details: {
      skillLabel: SKILL_LABEL,
      outputKey: OUTPUT_KEY,
      lineCount: lines.length,
      buckets,
      language,
      highlights,
      escalationSignals,
      requiresEscalation: escalationSignals.length > 0,
      hasInput: true,
    },
  };
}
