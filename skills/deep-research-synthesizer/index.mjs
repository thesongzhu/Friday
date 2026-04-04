import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const LOW_VALUE_PATTERNS = [
  /\b(obviously|clearly|everyone knows|needless to say|it goes without saying|as we all know)\b/i,
  /\b(basically|essentially|in general|generally speaking|for the most part)\b/i,
  /\b(to be honest|in my opinion|I think|I believe|I feel)\b/i,
  /\b(etc|and so on|and so forth|and the like|you get the idea)\b/i,
];

const INSIGHT_SIGNALS = [
  { pattern: /\b(finding|found|discovered|revealed|showed|demonstrated|confirmed)\b/i, weight: 3 },
  { pattern: /\b(trend|pattern|correlation|relationship|connection|link)\b/i, weight: 3 },
  { pattern: /\b(significant|notable|striking|surprising|unexpected|remarkable)\b/i, weight: 2 },
  { pattern: /\b(increase|decrease|growth|decline|change|shift)\b/i, weight: 2 },
  { pattern: /\d+%|\d+x|\$\d+/i, weight: 2 },
  { pattern: /\b(cause|effect|impact|result|outcome|consequence|implication)\b/i, weight: 2 },
  { pattern: /\b(compared to|versus|relative to|in contrast|unlike)\b/i, weight: 1 },
  { pattern: /\b(recommend|suggest|propose|advise|should|could|must)\b/i, weight: 1 },
];

const THEME_DETECTORS = [
  { patterns: [/\btechnolog/i, /\bdigital\b/i, /\bsoftware\b/i, /\bAI\b/, /\bautomation\b/i], theme: "technology" },
  { patterns: [/\bmarket\b/i, /\brevenue\b/i, /\bsales\b/i, /\bgrowth\b/i, /\bprofit\b/i], theme: "market-business" },
  { patterns: [/\buser\b/i, /\bcustomer\b/i, /\baudience\b/i, /\bsatisfaction\b/i], theme: "user-experience" },
  { patterns: [/\bprocess\b/i, /\befficiency\b/i, /\boperati/i, /\bworkflow\b/i], theme: "operations" },
  { patterns: [/\brisk\b/i, /\bsecurity\b/i, /\bcompli/i, /\bthreat\b/i], theme: "risk-security" },
  { patterns: [/\binnovation\b/i, /\bresearch\b/i, /\bexperiment\b/i, /\bhypothesis\b/i], theme: "innovation-research" },
];

function splitSentences(text) {
  return text.replace(/([.!?])\s+/g, "$1\n").split("\n").map(s => s.trim()).filter(s => s.length > 10);
}

function isLowValue(sentence) {
  return LOW_VALUE_PATTERNS.some(p => p.test(sentence));
}

function scoreInsight(sentence) {
  let score = 0;
  for (const signal of INSIGHT_SIGNALS) {
    if (signal.pattern.test(sentence)) score += signal.weight;
  }
  // Penalize very short or very long sentences
  if (sentence.length < 20) score -= 1;
  if (sentence.length > 300) score -= 1;
  return score;
}

function detectThemes(text) {
  const themes = [];
  for (const detector of THEME_DETECTORS) {
    const matches = detector.patterns.filter(p => p.test(text)).length;
    if (matches > 0) {
      themes.push({ theme: detector.theme, strength: matches });
    }
  }
  return themes.sort((a, b) => b.strength - a.strength);
}

function findPatterns(insights) {
  const patterns = [];
  const allText = insights.join(" ");

  // Check for causal patterns
  if (/\b(because|caused by|leads to|results in|due to)\b/i.test(allText)) {
    patterns.push({ type: "causal", description: "Causal relationships detected between findings." });
  }

  // Check for contrasts
  if (/\b(however|but|although|despite|in contrast|on the other hand|whereas)\b/i.test(allText)) {
    patterns.push({ type: "contrast", description: "Contrasting or opposing findings detected." });
  }

  // Check for progression/trends
  if (/\b(increasing|decreasing|growing|declining|trending|shifting|evolving)\b/i.test(allText)) {
    patterns.push({ type: "trend", description: "Directional trends or progressions detected." });
  }

  // Check for quantitative evidence
  const statMatches = allText.match(/\d+(?:\.\d+)?(?:\s*%|\s*x)/g);
  if (statMatches && statMatches.length > 1) {
    patterns.push({ type: "quantitative", description: `Multiple quantitative data points found (${statMatches.length} stats).` });
  }

  return patterns;
}

export async function execute(input = {}) {
  const data = asString(input.data ?? input.content ?? input.text);
  if (!data) {
    throw new Error("deep-research-synthesizer requires a data input.");
  }

  const sentences = splitSentences(data);
  const filtered = sentences.filter(s => !isLowValue(s));
  const removedCount = sentences.length - filtered.length;

  // Score and rank
  const scored = filtered.map((s, idx) => ({ text: s, score: scoreInsight(s), idx }));
  scored.sort((a, b) => b.score - a.score);

  const topInsights = scored.slice(0, 8).sort((a, b) => a.idx - b.idx).map(s => compact(s.text, 200));
  const supportingDetails = scored.slice(8, 15).sort((a, b) => a.idx - b.idx).map(s => compact(s.text, 200));
  const themes = detectThemes(data);
  const patterns = findPatterns(topInsights);

  // Build synthesis paragraph
  const synthesisParts = topInsights.slice(0, 3);
  const synthesisParagraph = synthesisParts.join(" ");

  return {
    summary: `Synthesized ${sentences.length} data points into ${topInsights.length} key insights across ${themes.length} theme(s). Filtered ${removedCount} low-value items.`,
    nextStep: patterns.length > 0
      ? `Explore the ${patterns[0].type} pattern further for deeper understanding.`
      : "Review key insights and consider what additional data would strengthen the analysis.",
    details: {
      keyInsights: topInsights,
      supportingDetails,
      themes,
      patterns,
      synthesisParagraph: compact(synthesisParagraph, 500),
      stats: {
        totalSentences: sentences.length,
        filteredOut: removedCount,
        insightsExtracted: topInsights.length,
        themesDetected: themes.length,
        patternsFound: patterns.length,
      },
      suggestedSkillId: "long-form-summary-compressor",
    },
  };
}
