import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const CASUAL_MARKERS = [
  /\bgonna\b/i, /\bwanna\b/i, /\bgotta\b/i, /\bkinda\b/i, /\bsorta\b/i,
  /\byeah\b/i, /\bnope\b/i, /\bcool\b/i, /\bawesome\b/i, /\bstuff\b/i,
  /\bguys\b/i, /\blol\b/i, /\bhaha\b/i, /!{2,}/, /\bsuper\b/i,
  /\btotally\b/i, /\bliterally\b/i, /\bbasically\b/i,
];

const FORMAL_MARKERS = [
  /\bherewith\b/i, /\bwherein\b/i, /\bnotwithstanding\b/i,
  /\bpursuant\b/i, /\bhitherto\b/i, /\baforesaid\b/i,
  /\bnevertheless\b/i, /\bfurthermore\b/i, /\bmoreover\b/i,
  /\baccordingly\b/i, /\binasmuch\b/i,
];

const PASSIVE_PATTERN = /\b(is|are|was|were|be|been|being)\s+\w+ed\b/gi;
const FILLER_WORDS = /\b(very|really|just|quite|rather|somewhat|perhaps|maybe|actually|basically|literally)\b/gi;
const JARGON_PATTERNS = [
  /\bsynerg/i, /\bleverage\b/i, /\bparadigm\b/i, /\bholistic\b/i,
  /\bscalable\b/i, /\bactionable\b/i, /\bmove the needle\b/i,
  /\bdeep dive\b/i, /\blow-hanging fruit\b/i, /\bbandwidth\b/i,
];

const CASUAL_TO_PROFESSIONAL = [
  [/\bgonna\b/gi, "going to"], [/\bwanna\b/gi, "want to"],
  [/\bgotta\b/gi, "need to"], [/\bkinda\b/gi, "somewhat"],
  [/\bsorta\b/gi, "somewhat"], [/\bguys\b/gi, "team"],
  [/\bstuff\b/gi, "items"], [/\bcool\b/gi, "good"],
  [/\bawesome\b/gi, "excellent"], [/!{2,}/g, "."],
];

const FORMAL_TO_CASUAL = [
  [/\bfurthermore\b/gi, "also"], [/\bmoreover\b/gi, "plus"],
  [/\bnevertheless\b/gi, "still"], [/\baccordingly\b/gi, "so"],
  [/\bpursuant to\b/gi, "following"], [/\binasmuch as\b/gi, "since"],
];

function detectTone(text) {
  const casualScore = CASUAL_MARKERS.reduce((n, p) => n + (p.test(text) ? 1 : 0), 0);
  const formalScore = FORMAL_MARKERS.reduce((n, p) => n + (p.test(text) ? 1 : 0), 0);
  if (casualScore > formalScore + 1) return "casual";
  if (formalScore > casualScore + 1) return "formal";
  return "neutral";
}

function findIssues(text) {
  const issues = [];
  const passiveMatches = text.match(PASSIVE_PATTERN) || [];
  if (passiveMatches.length > 2) {
    issues.push({ type: "passive_voice", count: passiveMatches.length, suggestion: "Reduce passive voice for more direct tone." });
  }
  const fillerMatches = text.match(FILLER_WORDS) || [];
  if (fillerMatches.length > 2) {
    issues.push({ type: "filler_words", count: fillerMatches.length, suggestion: "Remove filler words for conciseness." });
  }
  const jargonHits = JARGON_PATTERNS.filter(p => p.test(text));
  if (jargonHits.length > 0) {
    issues.push({ type: "jargon", count: jargonHits.length, suggestion: "Replace jargon with plain language." });
  }
  return issues;
}

function adjustText(text, targetTone, detectedTone) {
  let adjusted = text;

  // Remove filler words regardless of tone
  adjusted = adjusted.replace(FILLER_WORDS, "");

  if (targetTone === "professional" || targetTone === "formal") {
    if (detectedTone === "casual") {
      for (const [pat, rep] of CASUAL_TO_PROFESSIONAL) {
        adjusted = adjusted.replace(pat, rep);
      }
    }
  } else if (targetTone === "casual") {
    if (detectedTone === "formal") {
      for (const [pat, rep] of FORMAL_TO_CASUAL) {
        adjusted = adjusted.replace(pat, rep);
      }
    }
  }

  // Clean up double spaces
  adjusted = adjusted.replace(/\s{2,}/g, " ").trim();
  return adjusted;
}

export async function execute(input = {}) {
  const content = asString(input.content ?? input.text);
  if (!content) {
    throw new Error("tone-style-enforcer requires a content input.");
  }

  const targetTone = asString(input.tone, "professional").toLowerCase();
  const detectedTone = detectTone(content);
  const issues = findIssues(content);
  const adjustedText = adjustText(content, targetTone, detectedTone);
  const toneMatch = detectedTone === targetTone || (targetTone === "professional" && detectedTone === "neutral");

  return {
    summary: `Tone analysis: detected "${detectedTone}" tone, target is "${targetTone}". ${issues.length} style issue(s) found.`,
    nextStep: toneMatch && issues.length === 0
      ? "Text already matches the target tone. Review for final polish."
      : `Address ${issues.length} issue(s) and review the adjusted text below.`,
    details: {
      detectedTone,
      targetTone,
      toneMatch,
      issues,
      adjustedText,
      originalLength: content.length,
      adjustedLength: adjustedText.length,
    },
  };
}
