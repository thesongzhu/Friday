export type FridayAssistantStarterTask = {
  id: string;
  starterSkillId: string;
  title: string;
  description: string;
  goal: string;
  outcome: string;
};

export const FRIDAY_ASSISTANT_STARTER_TASKS: FridayAssistantStarterTask[] = [
  {
    id: "clarify-an-idea",
    starterSkillId: "idea-clarifier",
    title: "Clarify an idea",
    description: "Friday turns a vague request into a bounded objective, open questions, and the next concrete planning step.",
    goal: "Clarify this idea and turn it into a concrete first milestone I can review or implement next.",
    outcome: "A bounded objective with the missing scope questions already surfaced.",
  },
  {
    id: "review-implementation-plan",
    starterSkillId: "implementation-plan-review",
    title: "Review implementation plan",
    description: "Friday reviews architecture, edge cases, tests, rollback, and observability gaps before code or release work starts.",
    goal: "Review this implementation plan and tell me which execution gaps I need to close before coding or shipping.",
    outcome: "An execution review with the first missing plan detail called out clearly.",
  },
  {
    id: "qa-page-or-app",
    starterSkillId: "browser-qa-report",
    title: "QA this page or app",
    description: "Friday opens the page in its browser runtime, captures screenshot and console evidence, and returns a structured QA report.",
    goal: "QA this page or app in the browser, capture evidence, and tell me what needs attention before I ship it.",
    outcome: "A browser-backed QA report instead of a vague \"looks fine\" answer.",
  },
  {
    id: "review-current-changes",
    starterSkillId: "workspace-diff-review",
    title: "Review current changes",
    description: "Friday reviews the current workspace diff for risky hotspots, missing tests, and the next landing-safe action.",
    goal: "Review the current workspace changes and tell me what is risky before I land or ship this diff.",
    outcome: "A pre-landing review of the active diff with the highest-risk area already highlighted.",
  },
  {
    id: "sync-release-docs",
    starterSkillId: "release-doc-sync",
    title: "Sync release docs",
    description: "Friday updates managed README, changelog, and architecture notes so the release-facing docs match the current workspace changes.",
    goal: "Sync the release docs for the current workspace changes so README, changelog, and architecture notes stay aligned.",
    outcome: "A bounded docs sync pass instead of a stale release narrative.",
  },
];

export function getAssistantStarterTask(
  starterTaskId?: string | null,
): FridayAssistantStarterTask | null {
  if (!starterTaskId) {
    return null;
  }
  return FRIDAY_ASSISTANT_STARTER_TASKS.find((task) => task.id === starterTaskId) ?? null;
}
