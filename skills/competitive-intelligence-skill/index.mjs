import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const FEATURE_KEYWORDS = [
  { category: "pricing", patterns: [/\bfree\b/i, /\bpaid\b/i, /\bpric/i, /\bcost/i, /\btier/i, /\bsubscription/i] },
  { category: "performance", patterns: [/\bfast/i, /\bslow/i, /\blatency/i, /\bspeed/i, /\bperformance/i, /\bthroughput/i] },
  { category: "scalability", patterns: [/\bscale/i, /\benterprise/i, /\bcluster/i, /\bdistributed/i] },
  { category: "ease of use", patterns: [/\beasy/i, /\bsimple/i, /\bintuitive/i, /\bUI\b/, /\bUX\b/, /\buser[- ]friendly/i] },
  { category: "integration", patterns: [/\bAPI\b/, /\bintegrat/i, /\bplugin/i, /\bextension/i, /\bwebhook/i] },
  { category: "security", patterns: [/\bsecur/i, /\bencrypt/i, /\bauth/i, /\bSSO\b/, /\bcompliance/i] },
  { category: "community", patterns: [/\bopen[- ]?source/i, /\bcommunity/i, /\bGitHub/i, /\bfork/i, /\bstar/i] },
  { category: "documentation", patterns: [/\bdoc/i, /\btutorial/i, /\bguide/i, /\bexample/i] },
];

const STRENGTH_SIGNALS = [
  /\bbest\b/i, /\bleading\b/i, /\bpopular\b/i, /\brobust\b/i, /\bmature\b/i,
  /\breliable\b/i, /\bpowerful\b/i, /\badvanced\b/i, /\brich\b/i,
];

const WEAKNESS_SIGNALS = [
  /\blimited\b/i, /\bexpensive\b/i, /\bslow\b/i, /\bcomplex\b/i, /\blegacy\b/i,
  /\block[- ]?in\b/i, /\bsteep learning/i, /\bbuggy\b/i, /\bunstable\b/i,
];

function parseItems(raw) {
  return raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function detectFeatures(text) {
  const detected = [];
  for (const feat of FEATURE_KEYWORDS) {
    if (feat.patterns.some((p) => p.test(text))) {
      detected.push(feat.category);
    }
  }
  return detected.length > 0 ? detected : ["general"];
}

function countSignals(text, signals) {
  let count = 0;
  for (const p of signals) {
    if (p.test(text)) count++;
  }
  return count;
}

function buildItemProfile(name, allText) {
  const nameLower = name.toLowerCase();
  const sentences = allText.split(/[.!?\n]+/).filter((s) => s.toLowerCase().includes(nameLower));
  const context = sentences.join(". ");

  const features = detectFeatures(context || name);
  const strengthCount = countSignals(context, STRENGTH_SIGNALS);
  const weaknessCount = countSignals(context, WEAKNESS_SIGNALS);

  return {
    name,
    mentionedFeatures: features,
    strengthSignals: strengthCount,
    weaknessSignals: weaknessCount,
    contextSnippet: compact(context, 200) || "No additional context provided.",
  };
}

export async function execute(input = {}) {
  const raw = asString(input.items ?? input.content ?? input.text);
  if (!raw) {
    throw new Error("competitive-intelligence-skill requires an items input (comma-separated list).");
  }

  const items = parseItems(raw);
  if (items.length < 2) {
    throw new Error("Please provide at least two items to compare (comma-separated).");
  }

  const profiles = items.map((item) => buildItemProfile(item, raw));

  const comparisonMatrix = {};
  const allFeatures = [...new Set(profiles.flatMap((p) => p.mentionedFeatures))];
  for (const feat of allFeatures) {
    comparisonMatrix[feat] = {};
    for (const profile of profiles) {
      comparisonMatrix[feat][profile.name] = profile.mentionedFeatures.includes(feat)
        ? "mentioned"
        : "not mentioned";
    }
  }

  const rankings = profiles
    .map((p) => ({
      name: p.name,
      score: p.strengthSignals * 2 - p.weaknessSignals,
    }))
    .sort((a, b) => b.score - a.score);

  const recommendations = [];
  if (rankings.length >= 2) {
    const top = rankings[0];
    const bottom = rankings[rankings.length - 1];
    if (top.score > bottom.score) {
      recommendations.push(`${top.name} shows more positive signals overall.`);
    }
    if (top.score === bottom.score) {
      recommendations.push("Items appear roughly comparable based on available signals.");
    }
  }
  recommendations.push("Provide additional context about each item for a more detailed comparison.");

  return {
    summary: `Competitive comparison of ${items.length} items across ${allFeatures.length} feature dimension(s).`,
    nextStep: recommendations[0],
    details: {
      items: profiles,
      featureDimensions: allFeatures,
      comparisonMatrix,
      rankings,
      recommendations,
    },
  };
}
