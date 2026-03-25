import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const REVIEW_DIMENSIONS = [
  {
    key: "architecture",
    label: "architecture and ownership",
    keywords: ["architecture", "component", "service", "module", "owner"],
    question: "Which component owns the change, and what is the boundary?",
  },
  {
    key: "data_flow",
    label: "data flow",
    keywords: ["input", "output", "payload", "state", "data flow", "request", "response"],
    question: "What flows in, what changes, and what comes out?",
  },
  {
    key: "edge_cases",
    label: "edge cases",
    keywords: ["edge", "failure", "fallback", "retry", "timeout", "empty", "missing"],
    question: "What are the main failure or empty-state paths?",
  },
  {
    key: "tests",
    label: "test matrix",
    keywords: ["test", "coverage", "unit", "integration", "e2e", "qa"],
    question: "Which checks prove the plan works before shipping?",
  },
  {
    key: "rollback",
    label: "rollback and safety",
    keywords: ["rollback", "revert", "approval", "safe", "gate", "fallback"],
    question: "What is the rollback or approval boundary if the plan misbehaves?",
  },
  {
    key: "observability",
    label: "observability",
    keywords: ["log", "trace", "metric", "observe", "alert", "evidence"],
    question: "How will Friday or the operator verify the outcome in production-like conditions?",
  },
];

export async function execute(input = {}) {
  const plan = asString(input.goal ?? input.plan ?? input.text);
  if (!plan) {
    throw new Error("implementation-plan-review requires a goal, plan, or text input.");
  }

  const lowered = plan.toLowerCase();
  const coveredAreas = REVIEW_DIMENSIONS
    .filter((dimension) => dimension.keywords.some((keyword) => lowered.includes(keyword)))
    .map((dimension) => dimension.label);
  const missingAreas = REVIEW_DIMENSIONS
    .filter((dimension) => !dimension.keywords.some((keyword) => lowered.includes(keyword)))
    .map((dimension) => ({
      key: dimension.key,
      label: dimension.label,
      question: dimension.question,
    }));

  const coverageScore = Math.round((coveredAreas.length / REVIEW_DIMENSIONS.length) * 10);
  const summary = missingAreas.length === 0
    ? "Implementation plan review: the plan covers the main execution dimensions and looks ready to turn into work."
    : `Implementation plan review: ${String(coveredAreas.length)}/${String(REVIEW_DIMENSIONS.length)} execution areas are explicit, so the plan still has ${String(missingAreas.length)} meaningful gap(s).`;

  return {
    summary,
    nextStep: missingAreas.length > 0
      ? `Tighten the plan by answering this first: ${missingAreas[0].question}`
      : "Break the plan into tasks and validate the repo or target page before shipping.",
    details: {
      planSummary: compact(plan, 240),
      coverageScore,
      coveredAreas,
      missingAreas,
      suggestedTestMatrix: [
        "happy path",
        "one failure path",
        "rollback or approval path",
        "evidence or observability check",
      ],
      suggestedSkillId: "workspace-diff-review",
    },
  };
}
