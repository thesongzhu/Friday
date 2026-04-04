import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const SCENE_BREAK_SIGNALS = [
  /\n\s*\n/,
  /\b(?:scene|section|part|chapter|act)\s*\d*/i,
  /\b(?:cut to|transition|next|meanwhile|later|now)\b/i,
  /^#{1,3}\s+/m,
  /^\d+[.)]\s+/m,
];

const TRANSITION_TYPES = [
  { name: "hard cut", use: "Fast-paced content, emphasis, or topic shifts", energy: "high" },
  { name: "cross dissolve", use: "Smooth topic transitions, passage of time", energy: "medium" },
  { name: "fade to black", use: "Section endings, dramatic pauses", energy: "low" },
  { name: "jump cut", use: "Maintaining energy in talking-head footage", energy: "high" },
  { name: "L-cut / J-cut", use: "Layering audio over next visual for smooth flow", energy: "medium" },
  { name: "whip pan", use: "Energetic transitions between related topics", energy: "high" },
];

const VISUAL_CUE_PATTERNS = [
  { cue: "B-roll overlay", patterns: [/\bexample\b/i, /\bshow\b/i, /\blook at\b/i, /\bdemonstrat/i] },
  { cue: "text overlay", patterns: [/\bstat/i, /\bnumber/i, /\bpercent/i, /\bkey point/i, /\bremember/i] },
  { cue: "screen recording", patterns: [/\bscreen\b/i, /\bdemo\b/i, /\bwalkthrough/i, /\btutorial/i, /\bclick/i] },
  { cue: "zoom-in", patterns: [/\bimportant\b/i, /\bcrucial\b/i, /\bpay attention/i, /\bnotice\b/i] },
  { cue: "split screen", patterns: [/\bcompare\b/i, /\bvs\b/i, /\bbefore and after/i, /\bside by side/i] },
];

const PACING_KEYWORDS = {
  fast: [/\bquick\b/i, /\brapid\b/i, /\bfast\b/i, /\benergy\b/i, /\bexciting\b/i, /\baction\b/i],
  slow: [/\bslow\b/i, /\breflect/i, /\bthink\b/i, /\bpause\b/i, /\bemotion/i, /\bstory\b/i],
};

function splitScenes(text) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length >= 2) return paragraphs;
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunkSize = Math.max(2, Math.ceil(sentences.length / 4));
  const scenes = [];
  for (let i = 0; i < sentences.length; i += chunkSize) {
    scenes.push(sentences.slice(i, i + chunkSize).join(" "));
  }
  return scenes.length > 0 ? scenes : [text];
}

function detectVisualCues(text) {
  const cues = [];
  for (const vc of VISUAL_CUE_PATTERNS) {
    if (vc.patterns.some((p) => p.test(text))) {
      cues.push(vc.cue);
    }
  }
  return cues.length > 0 ? cues : ["talking head"];
}

function suggestPacing(text) {
  let fastScore = 0;
  let slowScore = 0;
  for (const p of PACING_KEYWORDS.fast) { if (p.test(text)) fastScore++; }
  for (const p of PACING_KEYWORDS.slow) { if (p.test(text)) slowScore++; }
  if (fastScore > slowScore) return "fast";
  if (slowScore > fastScore) return "slow";
  return "moderate";
}

function pickTransition(pacing, isLastScene) {
  if (isLastScene) return TRANSITION_TYPES.find((t) => t.name === "fade to black");
  if (pacing === "fast") return TRANSITION_TYPES.find((t) => t.name === "jump cut");
  if (pacing === "slow") return TRANSITION_TYPES.find((t) => t.name === "cross dissolve");
  return TRANSITION_TYPES.find((t) => t.name === "hard cut");
}

function estimateDuration(wordCount) {
  const wpm = 150;
  const seconds = Math.round((wordCount / wpm) * 60);
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return { seconds, display: min > 0 ? `${min}m ${sec}s` : `${sec}s` };
}

export async function execute(input = {}) {
  const script = asString(input.script ?? input.content ?? input.text);
  if (!script) {
    throw new Error("video-editing-planner requires a script input.");
  }

  const rawScenes = splitScenes(script);
  const overallPacing = suggestPacing(script);
  const totalWords = script.split(/\s+/).length;
  const totalDuration = estimateDuration(totalWords);

  const scenes = rawScenes.map((text, i) => {
    const words = text.split(/\s+/).length;
    const pacing = suggestPacing(text);
    const visualCues = detectVisualCues(text);
    const transition = pickTransition(pacing, i === rawScenes.length - 1);
    const duration = estimateDuration(words);

    return {
      sceneNumber: i + 1,
      preview: compact(text, 120),
      wordCount: words,
      estimatedDuration: duration.display,
      pacing,
      visualCues,
      suggestedTransition: transition.name,
      transitionReason: transition.use,
    };
  });

  return {
    summary: `Editing plan: ${scenes.length} scene(s), estimated ${totalDuration.display} total, overall pacing: ${overallPacing}.`,
    nextStep: "Review scene breakdowns, refine transitions, and add B-roll notes before starting the edit.",
    details: {
      totalScenes: scenes.length,
      totalWords,
      estimatedDuration: totalDuration.display,
      overallPacing,
      scenes,
      transitionReference: TRANSITION_TYPES,
    },
  };
}
