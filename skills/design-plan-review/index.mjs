import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

function normalizeGoal(input) {
  return asString(input.goal ?? input.text ?? input.plan);
}

function scoreDesignPlan(goal) {
  const lowered = goal.toLowerCase();
  const scores = {
    informationHierarchy: /hierarchy|headline|section|priority/.test(lowered) ? 8 : 5,
    stateCoverage: /loading|error|empty|success|failure|edge case/.test(lowered) ? 8 : 4,
    accessibility: /accessibility|keyboard|screen reader|contrast|aria/.test(lowered) ? 8 : 4,
    responsiveness: /mobile|tablet|responsive|desktop/.test(lowered) ? 8 : 5,
    interactionClarity: /hover|focus|submit|save|animation|transition|feedback/.test(lowered) ? 8 : 5,
  };
  return scores;
}

export async function execute(input = {}) {
  const goal = normalizeGoal(input);
  if (!goal) {
    throw new Error("design-plan-review requires a UI plan, page brief, or design note.");
  }

  const scores = scoreDesignPlan(goal);
  const recommendations = [];
  if (scores.stateCoverage <= 5) {
    recommendations.push("Enumerate empty, loading, error, and success states before implementation.");
  }
  if (scores.accessibility <= 5) {
    recommendations.push("Add keyboard, focus, and semantic accessibility requirements to the plan.");
  }
  if (scores.responsiveness <= 5) {
    recommendations.push("Call out at least desktop and mobile layouts explicitly to avoid accidental one-breakpoint designs.");
  }
  if (scores.informationHierarchy <= 5) {
    recommendations.push("Define the primary action, primary read surface, and what should visually recede.");
  }

  return {
    summary: `Design plan review: ${compact(goal, 120)}`,
    nextStep: recommendations[0] ?? "Feed the reviewed plan into browser-qa-report or implementation-plan-review once the UI work starts.",
    details: {
      scores,
      recommendations,
      missingStates: scores.stateCoverage <= 5 ? ["loading", "error", "empty", "success"] : [],
      suggestedSkillId: /page|screen|ui|route/.test(goal.toLowerCase()) ? "browser-qa-report" : "implementation-plan-review",
    },
  };
}
