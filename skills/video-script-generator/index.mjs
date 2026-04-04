import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const DURATION_PROFILES = {
  short:  { label: "Short (1-3 min)", sectionCount: 2, wordsPerSection: 80,  hookWords: 25 },
  medium: { label: "Medium (5-8 min)", sectionCount: 4, wordsPerSection: 150, hookWords: 40 },
  long:   { label: "Long (10+ min)", sectionCount: 6, wordsPerSection: 250, hookWords: 50 },
};

const HOOK_TEMPLATES = [
  (topic) => `Have you ever wondered why ${topic} matters more than you think?`,
  (topic) => `Most people get ${topic} completely wrong. Here's what they miss.`,
  (topic) => `In the next few minutes, I'll show you the truth about ${topic}.`,
  (topic) => `What if I told you that ${topic} could change everything?`,
  (topic) => `Stop scrolling. If you care about ${topic}, you need to hear this.`,
];

const TRANSITION_PHRASES = [
  "Now let's dive deeper into",
  "Building on that,",
  "Here's where it gets interesting:",
  "The next key point is",
  "This brings us to",
  "Let's shift gears and talk about",
];

const CTA_TEMPLATES = [
  (topic) => `If you found this helpful, share it with someone who needs to know about ${topic}.`,
  (topic) => `Drop a comment below with your thoughts on ${topic}. I read every one.`,
  (topic) => `Subscribe and hit the bell so you don't miss the next deep dive on ${topic}.`,
  (topic) => `Want more on ${topic}? Check the link in the description.`,
];

function extractKeyPoints(topic) {
  const words = topic.split(/\s+/).filter((w) => w.length > 3);
  const points = [];
  if (/\bhow\b/i.test(topic)) points.push("Step-by-step breakdown");
  if (/\bwhy\b/i.test(topic)) points.push("Root causes and reasoning");
  if (/\bbest\b/i.test(topic)) points.push("Top recommendations");
  if (/\btips?\b/i.test(topic)) points.push("Practical tips");
  if (/\bmistake|error|wrong/i.test(topic)) points.push("Common pitfalls to avoid");
  if (/\bcompare|vs\b/i.test(topic)) points.push("Side-by-side comparison");
  if (points.length === 0) {
    points.push("Key background and context");
    points.push("Core concepts explained");
    points.push("Practical applications");
  }
  if (words.length > 2) points.push("Real-world examples");
  return points;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildSections(topic, profile, keyPoints) {
  const sections = [];
  for (let i = 0; i < profile.sectionCount; i++) {
    const point = keyPoints[i % keyPoints.length];
    const transition = i > 0 ? TRANSITION_PHRASES[i % TRANSITION_PHRASES.length] : "Let's start with";
    sections.push({
      sectionNumber: i + 1,
      title: point,
      transition,
      estimatedWords: profile.wordsPerSection,
      guidance: `Cover "${point}" in approximately ${profile.wordsPerSection} words. Use concrete examples and keep the energy up.`,
    });
  }
  return sections;
}

export async function execute(input = {}) {
  const topic = asString(input.topic ?? input.content ?? input.text);
  if (!topic) {
    throw new Error("video-script-generator requires a topic input.");
  }

  const durationKey = asString(input.duration, "short").toLowerCase();
  const profile = DURATION_PROFILES[durationKey] || DURATION_PROFILES.short;

  const hook = pickRandom(HOOK_TEMPLATES)(compact(topic, 60));
  const keyPoints = extractKeyPoints(topic);
  const sections = buildSections(topic, profile, keyPoints);
  const cta = pickRandom(CTA_TEMPLATES)(compact(topic, 40));

  const totalEstWords = profile.hookWords + sections.reduce((s, sec) => s + sec.estimatedWords, 0) + 30;

  return {
    summary: `Generated a ${profile.label} video script on "${compact(topic, 50)}" with ${sections.length} section(s) and ~${totalEstWords} estimated words.`,
    nextStep: "Review the hook and section outlines, then flesh out each section with your voice and examples.",
    details: {
      topic: compact(topic, 200),
      duration: profile.label,
      estimatedTotalWords: totalEstWords,
      hook,
      sections,
      callToAction: cta,
      keyPoints,
      pacingNotes: durationKey === "short"
        ? "Keep pacing tight; cut filler ruthlessly."
        : durationKey === "long"
          ? "Allow breathing room for examples and stories; vary pacing between fast and reflective."
          : "Balanced pacing; one example per section keeps attention.",
    },
  };
}
