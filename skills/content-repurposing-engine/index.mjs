import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const PLATFORM_CONFIGS = {
  twitter: { maxLen: 280, style: "punchy", threads: true, hashtagCount: 3, label: "Twitter/X" },
  linkedin: { maxLen: 1300, style: "professional", threads: false, hashtagCount: 5, label: "LinkedIn" },
  blog: { maxLen: 5000, style: "detailed", threads: false, hashtagCount: 0, label: "Blog Post" },
  email: { maxLen: 2000, style: "conversational", threads: false, hashtagCount: 0, label: "Email Newsletter" },
  instagram: { maxLen: 2200, style: "visual", threads: false, hashtagCount: 10, label: "Instagram" },
};

function extractKeyPoints(text) {
  const sentences = text
    .replace(/([.!?])\s+/g, "$1\n")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 15);

  const scored = sentences.map((s) => {
    let score = 0;
    if (/\b(key|important|critical|essential|main|core|significant)\b/i.test(s)) score += 2;
    if (/\b(first|second|third|finally|conclusion|result|found|shows)\b/i.test(s)) score += 1;
    if (/\d+%|\d+ percent|\$\d+/i.test(s)) score += 2;
    if (s.length > 30 && s.length < 200) score += 1;
    return { sentence: s, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 7).map((s) => s.sentence);
}

function extractCoreMessage(text) {
  const firstSentences = text.replace(/([.!?])\s+/g, "$1\n").split("\n").slice(0, 3).join(" ");
  return compact(firstSentences, 200);
}

function extractHashtags(text, count) {
  if (count === 0) return [];
  const words = text.toLowerCase().match(/\b[a-z]{4,15}\b/g) || [];
  const freq = {};
  for (const w of words) {
    if (!/^(this|that|with|from|they|have|been|were|will|would|could|should|about|their|there|which|these|those|other|after|before|being|where|does|some|into|than|them|then|just|only|also|very|much|more|most|each|such|both|well|also|back|even|still|over)$/.test(w)) {
      freq[w] = (freq[w] || 0) + 1;
    }
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([w]) => `#${w}`);
}

function formatForTwitter(keyPoints, coreMessage, hashtags) {
  const threads = [];
  threads.push(compact(coreMessage, 250) + (hashtags.length > 0 ? "\n\n" + hashtags.slice(0, 2).join(" ") : ""));
  for (let i = 0; i < Math.min(keyPoints.length, 5); i++) {
    threads.push(`${i + 1}/ ${compact(keyPoints[i], 260)}`);
  }
  threads.push(`${threads.length}/ That's the thread. ${hashtags.join(" ")}`);
  return { format: "thread", parts: threads };
}

function formatForLinkedIn(keyPoints, coreMessage, hashtags) {
  let post = coreMessage + "\n\n";
  for (const point of keyPoints.slice(0, 5)) {
    post += `- ${compact(point, 200)}\n`;
  }
  if (hashtags.length > 0) post += "\n" + hashtags.join(" ");
  return { format: "post", parts: [compact(post, 1300)] };
}

function formatForBlog(keyPoints, coreMessage) {
  let post = `## Overview\n\n${coreMessage}\n\n## Key Points\n\n`;
  for (const point of keyPoints) {
    post += `- ${point}\n`;
  }
  post += "\n## Conclusion\n\nThe points above highlight the essential takeaways from the source material.";
  return { format: "article", parts: [post] };
}

function formatForEmail(keyPoints, coreMessage) {
  let body = `Hi there,\n\n${coreMessage}\n\nHere are the highlights:\n\n`;
  for (const point of keyPoints.slice(0, 5)) {
    body += `- ${compact(point, 150)}\n`;
  }
  body += "\nLet me know your thoughts.\n\nBest regards";
  return { format: "email", parts: [body] };
}

function formatForInstagram(keyPoints, coreMessage, hashtags) {
  let caption = coreMessage + "\n\n";
  for (let i = 0; i < Math.min(keyPoints.length, 4); i++) {
    caption += `${["1️⃣", "2️⃣", "3️⃣", "4️⃣"][i]} ${compact(keyPoints[i], 150)}\n`;
  }
  if (hashtags.length > 0) caption += "\n" + hashtags.join(" ");
  return { format: "caption", parts: [compact(caption, 2200)] };
}

export async function execute(input = {}) {
  const content = asString(input.content ?? input.text);
  if (!content) {
    throw new Error("content-repurposing-engine requires a content input.");
  }

  const platform = asString(input.targetPlatform ?? input.platform, "twitter").toLowerCase();
  const config = PLATFORM_CONFIGS[platform] ?? PLATFORM_CONFIGS.twitter;
  const keyPoints = extractKeyPoints(content);
  const coreMessage = extractCoreMessage(content);
  const hashtags = extractHashtags(content, config.hashtagCount);

  let formatted;
  switch (platform) {
    case "linkedin":
      formatted = formatForLinkedIn(keyPoints, coreMessage, hashtags);
      break;
    case "blog":
      formatted = formatForBlog(keyPoints, coreMessage);
      break;
    case "email":
      formatted = formatForEmail(keyPoints, coreMessage);
      break;
    case "instagram":
      formatted = formatForInstagram(keyPoints, coreMessage, hashtags);
      break;
    default:
      formatted = formatForTwitter(keyPoints, coreMessage, hashtags);
  }

  const wordCount = content.split(/\s+/).length;

  return {
    summary: `Repurposed ${wordCount}-word content for ${config.label} (${formatted.format} format, ${formatted.parts.length} part(s)).`,
    nextStep: "Review the repurposed content and adjust tone or length as needed for your audience.",
    details: {
      platform: config.label,
      format: formatted.format,
      parts: formatted.parts,
      keyPoints,
      coreMessage,
      hashtags,
      inputWordCount: wordCount,
      suggestedSkillId: "tone-style-enforcer",
    },
  };
}
