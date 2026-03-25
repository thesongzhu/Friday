import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const DELIVERABLE_HINTS = [
  { type: "workflow", patterns: [/\bworkflow\b/i, /\bautomation\b/i, /\bpipeline\b/i] },
  { type: "skill", patterns: [/\bskill\b/i, /\bagent\b/i, /\btool\b/i] },
  { type: "ui surface", patterns: [/\bpage\b/i, /\bdashboard\b/i, /\bui\b/i, /\bapp\b/i] },
  { type: "integration", patterns: [/\bintegration\b/i, /\bconnector\b/i, /\bapi\b/i] },
];

const AUDIENCE_PATTERNS = [
  /\bfor ([a-z0-9 ,/-]+?)(?:\.|,| so that| using| with|$)/i,
  /\bhelp ([a-z0-9 ,/-]+?)(?:\.|,| so that| using| with|$)/i,
];

function inferDeliverable(goal) {
  for (const hint of DELIVERABLE_HINTS) {
    if (hint.patterns.some((pattern) => pattern.test(goal))) {
      return hint.type;
    }
  }
  return "product change";
}

function inferAudience(goal) {
  for (const pattern of AUDIENCE_PATTERNS) {
    const match = goal.match(pattern);
    if (match?.[1]) {
      return compact(match[1].replace(/\bme\b/i, "the operator"), 80);
    }
  }
  return "not explicit";
}

function collectConstraints(goal) {
  const constraints = [];
  if (/read[- ]only/i.test(goal)) constraints.push("Keep the flow read-only.");
  if (/no prod|no production/i.test(goal)) constraints.push("Avoid production writes.");
  if (/local/i.test(goal)) constraints.push("Prefer local-first validation.");
  if (/today|tomorrow|deadline|ship/i.test(goal)) constraints.push("The request has time pressure.");
  return constraints;
}

function collectOpenQuestions(goal, deliverable, audience) {
  const questions = [];
  if (audience === "not explicit") {
    questions.push("Who is the narrowest first user or operator for this change?");
  }
  if (!/\b(success|metric|measure|so that)\b/i.test(goal)) {
    questions.push("What concrete signal would prove this is working?");
  }
  if (!/\b(without|constraints?|limit|budget|scope)\b/i.test(goal)) {
    questions.push("What should stay out of scope for the first pass?");
  }
  if (deliverable === "product change" && !/\b(workflow|skill|page|api|integration)\b/i.test(goal)) {
    questions.push("What exact artifact should Friday produce first: a plan, workflow, skill, or UI change?");
  }
  return questions;
}

export async function execute(input = {}) {
  const goal = asString(input.goal ?? input.idea ?? input.text);
  if (!goal) {
    throw new Error("idea-clarifier requires a goal, idea, or text input.");
  }

  const deliverable = inferDeliverable(goal);
  const audience = inferAudience(goal);
  const constraints = collectConstraints(goal);
  const openQuestions = collectOpenQuestions(goal, deliverable, audience);
  const firstMilestone = deliverable === "workflow"
    ? "Lock the trigger, output, and approval boundary before generating any workflow."
    : deliverable === "skill"
      ? "Define the single job this skill should do before thinking about implementation."
      : "Turn the request into one bounded first milestone that can be verified quickly.";

  return {
    summary: `Idea clarification: this looks like a ${deliverable} request with ${String(openQuestions.length)} major clarification gap(s).`,
    nextStep: openQuestions.length > 0
      ? `Answer the first question next: ${openQuestions[0]}`
      : "The request is concrete enough to move into implementation-plan-review.",
    details: {
      objective: goal,
      inferredDeliverable: deliverable,
      inferredAudience: audience,
      constraints,
      openQuestions,
      firstMilestone,
      suggestedSkillId: "implementation-plan-review",
    },
  };
}
