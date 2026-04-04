import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const HOOK_STYLES = {
  curiosity: {
    label: "Curiosity",
    templates: [
      (t) => `Have you ever wondered why ${t} is so misunderstood?`,
      (t) => `What if everything you know about ${t} is wrong?`,
      (t) => `There's a hidden side of ${t} nobody talks about.`,
      (t) => `Why do 90% of people get ${t} completely backwards?`,
      (t) => `The truth about ${t} might surprise you.`,
    ],
  },
  bold: {
    label: "Bold Statement",
    templates: [
      (t) => `${t} is dead. Here's what's replacing it.`,
      (t) => `I'm going to say what nobody else will about ${t}.`,
      (t) => `Stop wasting time on ${t} the wrong way.`,
      (t) => `This is the only guide to ${t} you'll ever need.`,
      (t) => `Forget everything you've been told about ${t}.`,
    ],
  },
  story: {
    label: "Story",
    templates: [
      (t) => `Last year, I failed miserably at ${t}. Here's what I learned.`,
      (t) => `A friend asked me about ${t} and my answer changed everything.`,
      (t) => `I spent 3 months obsessing over ${t}. This is what happened.`,
      (t) => `The moment I understood ${t}, everything clicked.`,
      (t) => `Nobody believed me when I said ${t} would matter. They were wrong.`,
    ],
  },
  stat: {
    label: "Statistic / Data",
    templates: [
      (t) => `Studies show that 73% of people approach ${t} the wrong way.`,
      (t) => `The data on ${t} is staggering, and almost no one knows it.`,
      (t) => `Only 1 in 10 people actually understand ${t}. Are you one of them?`,
      (t) => `The numbers behind ${t} tell a story most people miss.`,
      (t) => `Research reveals a surprising truth about ${t}.`,
    ],
  },
  contrarian: {
    label: "Contrarian",
    templates: [
      (t) => `Unpopular opinion: ${t} is overrated, and here's why.`,
      (t) => `Everyone says ${t} is the answer. I disagree.`,
      (t) => `The popular advice about ${t} is actually hurting you.`,
      (t) => `I stopped following the crowd on ${t}. Best decision I ever made.`,
      (t) => `What if the conventional wisdom about ${t} is completely wrong?`,
    ],
  },
};

const ALL_STYLE_KEYS = Object.keys(HOOK_STYLES);

function pickSubset(arr, count) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function detectTopicTone(topic) {
  if (/\bfail|mistake|wrong|problem|issue/i.test(topic)) return "story";
  if (/\bdata|stat|number|percent|research/i.test(topic)) return "stat";
  if (/\boverrated|myth|lie|truth|actually/i.test(topic)) return "contrarian";
  if (/\bguide|how to|tips|steps/i.test(topic)) return "bold";
  return "curiosity";
}

export async function execute(input = {}) {
  const topic = asString(input.topic ?? input.content ?? input.text);
  if (!topic) {
    throw new Error("hook-generator requires a topic input.");
  }

  const requestedStyle = asString(input.style, "").toLowerCase();
  const primaryStyle = HOOK_STYLES[requestedStyle] ? requestedStyle : detectTopicTone(topic);
  const shortTopic = compact(topic, 50);

  const primary = HOOK_STYLES[primaryStyle];
  const primaryHooks = pickSubset(primary.templates, 3).map((fn) => ({
    text: fn(shortTopic),
    style: primary.label,
  }));

  const altStyleKeys = ALL_STYLE_KEYS.filter((k) => k !== primaryStyle);
  const altHooks = pickSubset(altStyleKeys, 2).map((key) => {
    const style = HOOK_STYLES[key];
    const template = pickSubset(style.templates, 1)[0];
    return { text: template(shortTopic), style: style.label };
  });

  const allHooks = [...primaryHooks, ...altHooks];

  return {
    summary: `Generated ${allHooks.length} hook(s) for "${shortTopic}" using ${primary.label} as the primary style.`,
    nextStep: "Pick the hook that resonates most, then refine it to match your voice and audience.",
    details: {
      topic: compact(topic, 200),
      primaryStyle: primary.label,
      hooks: allHooks,
      availableStyles: ALL_STYLE_KEYS,
      tip: "Mix and match styles: lead with curiosity, follow with a bold claim, and close with a story.",
    },
  };
}
