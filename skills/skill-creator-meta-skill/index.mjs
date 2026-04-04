import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const CATEGORY_MAP = [
  { category: "utility", patterns: [/\breview\b/i, /\banalyze\b/i, /\bvalidat/i, /\bcheck\b/i, /\baudit\b/i, /\boptimiz/i] },
  { category: "media", patterns: [/\bvideo\b/i, /\baudio\b/i, /\bimage\b/i, /\bcontent\b/i, /\bscript\b/i, /\bcaption/i] },
  { category: "automation", patterns: [/\bautomat/i, /\bworkflow\b/i, /\bpipeline\b/i, /\bschedul/i, /\borchestrat/i] },
  { category: "communication", patterns: [/\bemail\b/i, /\bslack\b/i, /\bmessag/i, /\bnotif/i, /\bchat\b/i] },
  { category: "data", patterns: [/\bdata\b/i, /\banalytic/i, /\breport\b/i, /\bdashboard/i, /\bmetric/i] },
];

function slugify(text, maxLen = 60) {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  // Truncate at the last whole word boundary within maxLen
  if (slug.length <= maxLen) return slug;
  const truncated = slug.slice(0, maxLen);
  const lastDash = truncated.lastIndexOf("-");
  return lastDash > 10 ? truncated.slice(0, lastDash) : truncated;
}

function titleCase(text, maxLen = 60) {
  const full = text
    .split(/[\s-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
  if (full.length <= maxLen) return full;
  // Truncate at the last whole word boundary
  const truncated = full.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > 10 ? truncated.slice(0, lastSpace) : truncated;
}

function inferCategory(goal) {
  for (const entry of CATEGORY_MAP) {
    if (entry.patterns.some((p) => p.test(goal))) return entry.category;
  }
  return "utility";
}

function extractKeyVerbs(goal) {
  const verbs = [];
  const verbPatterns = [
    "analyze", "generate", "validate", "review", "create", "transform",
    "monitor", "optimize", "automate", "format", "extract", "summarize",
    "compare", "detect", "plan", "build", "convert", "audit",
  ];
  for (const v of verbPatterns) {
    if (new RegExp(`\\b${v}`, "i").test(goal)) verbs.push(v);
  }
  return verbs.length > 0 ? verbs : ["process"];
}

function generateInstructions(verbs, goal) {
  const instructions = [];
  instructions.push("Accept and validate the input content.");
  for (const verb of verbs) {
    instructions.push(`${verb.charAt(0).toUpperCase() + verb.slice(1)} the input according to the skill's purpose.`);
  }
  instructions.push("Return structured results with a clear summary.");
  instructions.push("Handle edge cases and provide actionable next steps.");
  return instructions;
}

function generateConstraints(goal) {
  const constraints = [
    "Maintain accuracy in all outputs.",
    "Avoid assumptions not supported by the input.",
  ];
  if (/\bsecur/i.test(goal)) constraints.push("Never expose sensitive data in outputs.");
  if (/\buser/i.test(goal)) constraints.push("Prioritize user experience and clarity.");
  return constraints;
}

function generateTriggerPhrases(name, verbs) {
  const phrases = [];
  const lower = name.toLowerCase();
  phrases.push(`run the ${lower}`);
  phrases.push(`use ${lower} on this`);
  for (const verb of verbs.slice(0, 2)) {
    phrases.push(`${verb} this for me`);
  }
  return phrases;
}

function generateFeatures(verbs) {
  return verbs.map((v) => `${v.charAt(0).toUpperCase() + v.slice(1)}-based processing`);
}

function buildSkillMd(name, description, features, instructions, constraints, triggers) {
  const lines = [
    `# ${name}`,
    "",
    description,
    "",
    "## Features",
    "",
    ...features.map((f) => `- ${f}`),
    "",
    "## Instructions",
    "",
    ...instructions.map((i) => `- ${i}`),
    "",
    "## Constraints",
    "",
    ...constraints.map((c) => `- ${c}`),
    "",
    "Typical triggers:",
    "",
    ...triggers.map((t) => `- \`${t}\``),
    "",
  ];
  return lines.join("\n");
}

export async function execute(input = {}) {
  const goal = asString(input.goal ?? input.content ?? input.text);
  if (!goal) {
    throw new Error("skill-creator-meta-skill requires a goal input.");
  }

  const rawName = asString(input.skillName, "");
  const skillId = slugify(rawName || goal);
  const skillName = rawName || titleCase(skillId);
  const category = inferCategory(goal);
  const verbs = extractKeyVerbs(goal);
  const description = compact(goal, 200);
  const features = generateFeatures(verbs);
  const instructions = generateInstructions(verbs, goal);
  const constraints = generateConstraints(goal);
  const triggerPhrases = generateTriggerPhrases(skillName, verbs);
  const skillMd = buildSkillMd(skillName, description, features, instructions, constraints, triggerPhrases);

  return {
    summary: `Generated skill template "${skillName}" (${category}) with ${features.length} feature(s) and ${instructions.length} instruction(s).`,
    nextStep: "Review the generated SKILL.md, then create the skill directory and implementation files.",
    details: {
      skillId,
      skillName,
      category,
      description,
      features,
      instructions,
      constraints,
      triggerPhrases,
      verbs,
      skillMd,
      suggestedDirectory: `skills/${skillId}`,
    },
  };
}
