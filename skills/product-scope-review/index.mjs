import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

function normalizeGoal(input) {
  return asString(input.goal ?? input.text ?? input.idea);
}

function scoreGoal(goal) {
  const lowered = goal.toLowerCase();
  const score = {
    userPain: 5,
    wedgeClarity: 5,
    scopeDiscipline: 5,
    differentiation: 5,
    executionRisk: 5,
  };

  if (/(customer|user|operator|incident|deploy|review|release)/.test(lowered)) score.userPain += 2;
  if (/(first milestone|first step|single page|single flow|one thing)/.test(lowered)) score.wedgeClarity += 2;
  if (/(dashboard|platform|suite|everything|all-in-one|full stack)/.test(lowered)) score.scopeDiscipline -= 2;
  if (/(specific|unique|differentiated|better than|advantage)/.test(lowered)) score.differentiation += 2;
  if (/(oauth|billing|compliance|marketplace|security|fleet|multi-tenant)/.test(lowered)) score.executionRisk += 2;

  for (const key of Object.keys(score)) {
    score[key] = Math.max(1, Math.min(10, score[key]));
  }
  return score;
}

export async function execute(input = {}) {
  const goal = normalizeGoal(input);
  if (!goal) {
    throw new Error("product-scope-review requires a goal, PRD, or scope statement.");
  }

  const scores = scoreGoal(goal);
  const recommendations = [];
  const openQuestions = [];

  if (scores.scopeDiscipline <= 4) {
    recommendations.push("Cut the first release down to one workflow or user journey with a measurable win.");
  }
  if (scores.wedgeClarity <= 5) {
    recommendations.push("Name the narrowest wedge explicitly: who uses this first, what they do, and what improves immediately.");
  }
  if (scores.differentiation <= 5) {
    recommendations.push("State why this is better than the current fallback or status quo, not just what it does.");
  }
  if (scores.executionRisk >= 7) {
    recommendations.push("Separate high-risk infrastructure or security work from the first user-facing milestone.");
  }

  openQuestions.push("What is the smallest outcome a real user would notice within the first release?");
  if (!/metric|measure|time saved|error reduced|latency|success rate/.test(goal.toLowerCase())) {
    openQuestions.push("What metric or operational delta would prove the wedge is working?");
  }
  if (!/user|operator|developer|team|admin/.test(goal.toLowerCase())) {
    openQuestions.push("Who is the first concrete user for this scope?");
  }

  return {
    summary: `Product scope review: ${compact(goal, 120)}`,
    nextStep: recommendations[0] ?? "Move the trimmed scope into implementation-plan-review once the wedge is explicit.",
    details: {
      scores,
      strongestArea: Object.entries(scores).sort((left, right) => right[1] - left[1])[0]?.[0] ?? null,
      weakestArea: Object.entries(scores).sort((left, right) => left[1] - right[1])[0]?.[0] ?? null,
      recommendations,
      openQuestions,
      suggestedSkillId: "implementation-plan-review",
    },
  };
}
