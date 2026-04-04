import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const ICON_MAP = [
  { patterns: [/\btime\b/i, /\bschedule\b/i, /\bdeadline\b/i, /\bclock\b/i], icon: "clock" },
  { patterns: [/\bmoney\b/i, /\bcost\b/i, /\bbudget\b/i, /\bprice\b/i, /\$\d/], icon: "dollar" },
  { patterns: [/\bgrowth\b/i, /\bincrease\b/i, /\bscale\b/i, /\brise\b/i], icon: "chart-up" },
  { patterns: [/\bdecline\b/i, /\bdecrease\b/i, /\bdrop\b/i, /\bfall\b/i], icon: "chart-down" },
  { patterns: [/\bteam\b/i, /\bpeople\b/i, /\buser\b/i, /\bcustomer\b/i], icon: "people" },
  { patterns: [/\btool\b/i, /\bsoftware\b/i, /\btech\b/i, /\bplatform\b/i], icon: "gear" },
  { patterns: [/\bsecurity\b/i, /\bprotect\b/i, /\bsafe\b/i, /\block\b/i], icon: "shield" },
  { patterns: [/\bdata\b/i, /\banalytics\b/i, /\bmetric\b/i, /\bstat\b/i], icon: "bar-chart" },
  { patterns: [/\bidea\b/i, /\binnovation\b/i, /\bcreativ/i], icon: "lightbulb" },
  { patterns: [/\bcheck\b/i, /\bverif/i, /\bvalid/i, /\bsuccess\b/i], icon: "checkmark" },
  { patterns: [/\bwarn/i, /\brisk\b/i, /\balert\b/i, /\bcaution\b/i], icon: "warning" },
];

const STAT_PATTERN = /(\d+(?:\.\d+)?)\s*(%|percent|million|billion|thousand|x|times|hours?|days?|minutes?|seconds?)/gi;
const HEADING_PATTERN = /^(?:#{1,3}\s+|[A-Z][A-Z\s]{3,}[A-Z]:?$)/m;

function suggestIcon(text) {
  for (const entry of ICON_MAP) {
    if (entry.patterns.some(p => p.test(text))) return entry.icon;
  }
  return "circle";
}

function extractStats(text) {
  const stats = [];
  let match;
  const re = new RegExp(STAT_PATTERN.source, "gi");
  while ((match = re.exec(text)) !== null) {
    stats.push({ value: match[1], unit: match[2], context: compact(text.substring(Math.max(0, match.index - 30), match.index + match[0].length + 30), 80) });
  }
  return stats;
}

function splitIntoSections(text) {
  // Try splitting by headings first
  const headingParts = text.split(/\n(?=#{1,3}\s|[A-Z][A-Z\s]{3,}[A-Z]:?\s*\n)/);
  if (headingParts.length > 1) {
    return headingParts.map(p => p.trim()).filter(p => p.length > 10);
  }

  // Try splitting by numbered items
  const numbered = text.split(/\n(?=\d+[.)]\s)/);
  if (numbered.length > 2) {
    return numbered.map(p => p.trim()).filter(p => p.length > 10);
  }

  // Try splitting by bullet points
  const bullets = text.split(/\n(?=[-*]\s)/);
  if (bullets.length > 2) {
    return bullets.map(p => p.trim()).filter(p => p.length > 10);
  }

  // Fall back to paragraph splitting
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 15);
  if (paragraphs.length > 1) return paragraphs;

  // Last resort: split by sentences into groups of 2-3
  const sentences = text.replace(/([.!?])\s+/g, "$1\n").split("\n").filter(s => s.trim().length > 10);
  const groups = [];
  for (let i = 0; i < sentences.length; i += 2) {
    groups.push(sentences.slice(i, i + 2).join(" "));
  }
  return groups;
}

function buildSection(rawText, index) {
  const lines = rawText.split("\n").map(l => l.trim()).filter(Boolean);
  const heading = lines[0].replace(/^#{1,3}\s+/, "").replace(/^[\d.]+\s*/, "").replace(/:$/, "");
  const body = lines.slice(1).join(" ") || heading;
  const stats = extractStats(rawText);

  return {
    order: index + 1,
    heading: compact(heading, 60),
    body: compact(body, 250),
    icon: suggestIcon(rawText),
    stats,
    visualHint: stats.length > 0 ? "highlight-stat" : index === 0 ? "hero-banner" : "text-block",
  };
}

export async function execute(input = {}) {
  const content = asString(input.content ?? input.text);
  if (!content) {
    throw new Error("infographic-builder requires a content input.");
  }

  const rawSections = splitIntoSections(content);
  const sections = rawSections.slice(0, 8).map((s, i) => buildSection(s, i));
  const allStats = sections.flatMap(s => s.stats);

  // Extract a title from the first line or heading
  const titleMatch = content.match(/^#{1,3}\s+(.+)/m);
  const title = titleMatch ? compact(titleMatch[1], 60) : compact(content.split(/[.!?\n]/)[0], 60);

  const layout = {
    orientation: sections.length > 4 ? "vertical-scroll" : "single-page",
    columns: sections.length <= 3 ? 1 : 2,
    colorScheme: "auto",
  };

  return {
    summary: `Infographic structured: ${sections.length} sections, ${allStats.length} stat highlights, ${layout.orientation} layout.`,
    nextStep: "Use the section data and visual hints to build the infographic in your design tool.",
    details: {
      title,
      layout,
      sections,
      statHighlights: allStats,
      sectionCount: sections.length,
      suggestedSkillId: "excalidraw-diagram-generator",
    },
  };
}
