import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const CATEGORY_HINTS = [
  { category: "Technical", patterns: [/\bcode\b/i, /\bAPI\b/, /\bdatabase\b/i, /\bserver\b/i, /\bfunction\b/i, /\barchitect/i, /\binfrastructure\b/i, /\bsystem\b/i] },
  { category: "Business", patterns: [/\brevenue\b/i, /\bprofit\b/i, /\bmarket/i, /\bcustomer\b/i, /\bstrateg/i, /\bROI\b/, /\bKPI\b/] },
  { category: "Design", patterns: [/\bUI\b/, /\bUX\b/, /\bdesign\b/i, /\blayout\b/i, /\bwireframe/i, /\bprototype/i, /\bcolor/i] },
  { category: "Process", patterns: [/\bworkflow\b/i, /\bprocess\b/i, /\bpipeline\b/i, /\bstep/i, /\bprocedure/i, /\bSOP\b/] },
  { category: "People", patterns: [/\bteam\b/i, /\bhire/i, /\brole/i, /\bmanager/i, /\bstakeholder/i, /\bcommunicat/i] },
  { category: "Research", patterns: [/\bstudy\b/i, /\bdata\b/i, /\banalys/i, /\bfinding/i, /\bhypothes/i, /\bexperiment/i] },
  { category: "Content", patterns: [/\bcontent\b/i, /\bblog\b/i, /\bvideo\b/i, /\bpost\b/i, /\bscript\b/i, /\bcopy/i] },
];

const PRIORITY_SIGNALS = [
  { level: "high", patterns: [/\burgent\b/i, /\bcritical\b/i, /\bimportant\b/i, /\bASAP\b/i, /\bblocking\b/i, /\bmust\b/i] },
  { level: "medium", patterns: [/\bshould\b/i, /\bplan\b/i, /\bneed\b/i, /\bwant\b/i] },
  { level: "low", patterns: [/\bnice to have\b/i, /\bmaybe\b/i, /\bcould\b/i, /\beventually\b/i, /\bsomeday\b/i] },
];

function splitIntoChunks(text) {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  return sentences.length > 1 ? sentences : [text];
}

function classifyChunk(chunk) {
  for (const hint of CATEGORY_HINTS) {
    if (hint.patterns.some((p) => p.test(chunk))) {
      return hint.category;
    }
  }
  return "General";
}

function detectPriority(chunk) {
  for (const signal of PRIORITY_SIGNALS) {
    if (signal.patterns.some((p) => p.test(chunk))) {
      return signal.level;
    }
  }
  return "medium";
}

function extractKeyTerms(text) {
  const words = text.replace(/[^a-zA-Z0-9\s-]/g, "").split(/\s+/).filter((w) => w.length > 3);
  const freq = {};
  for (const w of words) {
    const lower = w.toLowerCase();
    freq[lower] = (freq[lower] || 0) + 1;
  }
  return Object.entries(freq)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word, count]) => ({ term: word, frequency: count }));
}

export async function execute(input = {}) {
  const content = asString(input.content ?? input.text);
  if (!content) {
    throw new Error("knowledge-structuring-skill requires a content input.");
  }

  const chunks = splitIntoChunks(content);
  const classified = chunks.map((chunk) => ({
    text: compact(chunk, 300),
    category: classifyChunk(chunk),
    priority: detectPriority(chunk),
  }));

  const groups = {};
  for (const item of classified) {
    if (!groups[item.category]) {
      groups[item.category] = { items: [], highPriority: 0 };
    }
    groups[item.category].items.push(item);
    if (item.priority === "high") groups[item.category].highPriority++;
  }

  const hierarchy = Object.entries(groups)
    .sort((a, b) => b[1].highPriority - a[1].highPriority || b[1].items.length - a[1].items.length)
    .map(([category, data]) => ({
      category,
      itemCount: data.items.length,
      highPriorityCount: data.highPriority,
      items: data.items,
    }));

  const keyTerms = extractKeyTerms(content);
  const categoryCount = hierarchy.length;
  const totalItems = chunks.length;

  return {
    summary: `Organized ${totalItems} item(s) into ${categoryCount} categor${categoryCount === 1 ? "y" : "ies"}: ${hierarchy.map((h) => h.category).join(", ")}.`,
    nextStep: hierarchy[0]?.highPriorityCount > 0
      ? `Focus on the "${hierarchy[0].category}" category first (${hierarchy[0].highPriorityCount} high-priority item(s)).`
      : "Review the structured categories and refine groupings as needed.",
    details: {
      totalItems,
      categories: hierarchy,
      keyTerms,
    },
  };
}
