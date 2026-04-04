import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const HOOK_TEMPLATES = [
  { pattern: /\b(save|reduce|cut|lower)\b/i, template: (topic) => `Stop wasting resources. ${compact(topic, 80)} changes everything.` },
  { pattern: /\b(grow|increase|boost|improve|scale)\b/i, template: (topic) => `Ready to level up? ${compact(topic, 80)} is the key.` },
  { pattern: /\b(problem|issue|struggle|pain|fail)\b/i, template: (topic) => `Tired of the same problems? ${compact(topic, 80)} is the fix.` },
  { pattern: /\b(new|launch|introduce|announce)\b/i, template: (topic) => `Introducing something new: ${compact(topic, 100)}.` },
  { pattern: /\b(secret|hidden|unknown|surprising)\b/i, template: (topic) => `Most people miss this. ${compact(topic, 100)}.` },
];

const CTA_TEMPLATES = {
  "landing-page": "Get started today and see the difference.",
  email: "Reply to this email to learn more.",
  social: "Like and share if this resonated with you.",
  general: "Take the next step now.",
};

const BENEFIT_SIGNALS = [
  /\b(benefit|advantage|result|outcome|gain|improve|save|reduce|increase|boost)\b/i,
  /\b(faster|better|easier|simpler|cheaper|stronger|smarter)\b/i,
];

const FEATURE_SIGNALS = [
  /\b(feature|include|offer|provide|support|enable|allow|built-in|comes with)\b/i,
];

function extractSentences(text) {
  return text.replace(/([.!?])\s+/g, "$1\n").split("\n").map(s => s.trim()).filter(s => s.length > 10);
}

function generateHook(content) {
  const firstSentence = content.replace(/([.!?])\s+.*/, "$1").trim().replace(/[.!?]+$/, "");
  for (const h of HOOK_TEMPLATES) {
    if (h.pattern.test(content)) {
      return h.template(firstSentence);
    }
  }
  return `Here's what you need to know: ${compact(firstSentence, 100)}.`;
}

function classifySentences(sentences) {
  const benefits = [];
  const features = [];
  const other = [];

  for (const s of sentences) {
    const bScore = BENEFIT_SIGNALS.reduce((n, p) => n + (p.test(s) ? 1 : 0), 0);
    const fScore = FEATURE_SIGNALS.reduce((n, p) => n + (p.test(s) ? 1 : 0), 0);
    if (bScore > fScore && bScore > 0) benefits.push(s);
    else if (fScore > 0) features.push(s);
    else other.push(s);
  }
  return { benefits, features, other };
}

function buildBody(classified) {
  const sections = [];

  if (classified.benefits.length > 0) {
    sections.push({
      heading: "Why It Matters",
      points: classified.benefits.slice(0, 4).map(s => compact(s, 150)),
    });
  }

  if (classified.features.length > 0) {
    sections.push({
      heading: "What You Get",
      points: classified.features.slice(0, 4).map(s => compact(s, 150)),
    });
  }

  if (classified.other.length > 0) {
    sections.push({
      heading: "Key Details",
      points: classified.other.slice(0, 3).map(s => compact(s, 150)),
    });
  }

  if (sections.length === 0) {
    sections.push({ heading: "Overview", points: ["Review and expand on the core topic."] });
  }

  return sections;
}

export async function execute(input = {}) {
  const content = asString(input.content ?? input.text);
  if (!content) {
    throw new Error("structured-copywriting-skill requires a content input.");
  }

  const platform = asString(input.platform, "general").toLowerCase();
  const sentences = extractSentences(content);
  const classified = classifySentences(sentences);
  const hook = generateHook(content);
  const body = buildBody(classified);
  const cta = CTA_TEMPLATES[platform] || CTA_TEMPLATES.general;

  return {
    summary: `Generated structured copy for ${platform}: hook + ${body.length} body section(s) + CTA.`,
    nextStep: "Review the hook, body sections, and CTA. Adjust tone for your audience.",
    details: {
      platform,
      hook,
      body,
      cta,
      stats: {
        benefitPoints: classified.benefits.length,
        featurePoints: classified.features.length,
        totalSentences: sentences.length,
      },
      suggestedSkillId: "tone-style-enforcer",
    },
  };
}
