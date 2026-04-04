import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const FILLER_PATTERNS = [
  /\b(basically|essentially|actually|really|very|quite|rather|somewhat|just|simply|honestly|literally|obviously|clearly|naturally|of course|needless to say|it goes without saying|as you know|in my opinion|I think that|I believe that|it is worth noting that|it should be noted that|the fact that)\b/gi,
];

const IMPORTANCE_SIGNALS = [
  { pattern: /\b(key|critical|essential|important|significant|major|primary|fundamental|crucial)\b/i, weight: 3 },
  { pattern: /\b(result|conclusion|finding|outcome|impact|consequence|therefore|thus|hence)\b/i, weight: 2 },
  { pattern: /\b(first|second|third|finally|summary|overview|in short)\b/i, weight: 2 },
  { pattern: /\d+%|\$\d+|\d+ (million|billion|thousand|percent)/i, weight: 2 },
  { pattern: /\b(however|but|although|despite|nevertheless|yet)\b/i, weight: 1 },
  { pattern: /\b(because|since|due to|as a result|caused by|leads to)\b/i, weight: 1 },
];

const REDUNDANCY_PATTERNS = [
  /\b(in other words|that is to say|to put it another way|as mentioned|as stated|as noted)\b/i,
  /\b(again|once more|to reiterate|to repeat|as I said)\b/i,
];

function splitSentences(text) {
  return text
    .replace(/([.!?])\s+/g, "$1\n")
    .split("\n")
    .map(s => s.trim())
    .filter(s => s.length > 10);
}

function removeFiller(text) {
  let cleaned = text;
  for (const pattern of FILLER_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  return cleaned.replace(/\s{2,}/g, " ").replace(/\s([.,!?])/g, "$1").trim();
}

function scoreSentence(sentence) {
  let score = 0;
  for (const signal of IMPORTANCE_SIGNALS) {
    if (signal.pattern.test(sentence)) score += signal.weight;
  }
  // Penalize redundancy
  for (const pat of REDUNDANCY_PATTERNS) {
    if (pat.test(sentence)) score -= 2;
  }
  // Slight bonus for medium-length sentences (not too short, not too long)
  if (sentence.length > 30 && sentence.length < 200) score += 1;
  return score;
}

function extractTopSentences(sentences, maxCount) {
  const scored = sentences.map((s, idx) => ({ text: s, score: scoreSentence(s), idx }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, maxCount);
  // Restore original order for readability
  top.sort((a, b) => a.idx - b.idx);
  return top.map(s => s.text);
}

export async function execute(input = {}) {
  const content = asString(input.content ?? input.text);
  if (!content) {
    throw new Error("long-form-summary-compressor requires a content input.");
  }

  const sentences = splitSentences(content);
  const wordCount = content.split(/\s+/).length;

  // Determine how many bullets based on input length
  const bulletCount = Math.max(3, Math.min(10, Math.ceil(sentences.length * 0.3)));
  const topSentences = extractTopSentences(sentences, bulletCount);
  const bullets = topSentences.map(s => compact(removeFiller(s), 200));

  // Build paragraph summary from top 3
  const paragraphSentences = topSentences.slice(0, 3).map(s => removeFiller(s));
  const paragraphSummary = paragraphSentences.join(" ");

  const compressionRatio = wordCount > 0
    ? Math.round((1 - paragraphSummary.split(/\s+/).length / wordCount) * 100)
    : 0;

  return {
    summary: `Compressed ${wordCount} words into ${bullets.length} key points (${compressionRatio}% reduction).`,
    nextStep: "Review the bullet points and paragraph summary for completeness.",
    details: {
      paragraphSummary: compact(paragraphSummary, 600),
      bullets,
      originalWordCount: wordCount,
      compressedWordCount: paragraphSummary.split(/\s+/).length,
      compressionRatio: `${compressionRatio}%`,
      sentencesAnalyzed: sentences.length,
      suggestedSkillId: "scqa-writing-framework",
    },
  };
}
