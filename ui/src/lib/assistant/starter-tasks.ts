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
    id: "review-repo-health",
    starterSkillId: "repo-health-check",
    title: "Review repo health",
    description: "Friday runs the bundled repo-health-check skill to inspect the workspace and point to the next useful action.",
    goal: "Run the repo-health-check starter skill for the current workspace, summarize what matters most, and guide me to the next useful action.",
    outcome: "A skill-backed repo summary with the best next step already prepared.",
  },
  {
    id: "check-release-readiness",
    starterSkillId: "release-readiness-check",
    title: "Check release readiness",
    description: "Friday runs the bundled release-readiness-check skill to detect lint, test, typecheck, and build blockers before a release.",
    goal: "Run the release-readiness-check starter skill on this workspace and show me the blockers before I ship.",
    outcome: "A readiness matrix with blockers and the next release-safe action.",
  },
  {
    id: "review-open-issues",
    starterSkillId: "review-open-issues",
    title: "Review detected issues",
    description: "Friday runs the bundled review-open-issues skill to summarize open incidents, approvals, and the most important recovery lead.",
    goal: "Run the review-open-issues starter skill and tell me what Friday has already detected, what matters most, and what I should inspect next.",
    outcome: "A prioritized issue queue instead of a vague recovery conversation.",
  },
  {
    id: "review-autofix-readiness",
    starterSkillId: "autofix-readiness-review",
    title: "Review repair readiness",
    description: "Friday runs the bundled autofix-readiness-review skill to show which repair plans are safe, approval-gated, or still not ready.",
    goal: "Run the autofix-readiness-review starter skill and explain which planned repairs are safe to inspect, which need approval, and what rollback coverage exists.",
    outcome: "A bounded self-healing readiness summary without executing any fix.",
  },
  {
    id: "recover-failed-deploy",
    starterSkillId: "failed-deploy-recovery-brief",
    title: "Recover a failed deploy",
    description: "Friday runs the bundled failed-deploy-recovery-brief skill to summarize the active workflow/deploy incident and the safest recovery path.",
    goal: "Run the failed-deploy-recovery-brief starter skill and summarize the current failed deploy, the repair boundary, and the safest next recovery step.",
    outcome: "A recovery brief with the next safe action already identified.",
  },
  {
    id: "run-log-error-triage",
    starterSkillId: "log-error-triage",
    title: "Run log error triage",
    description: "Friday uses the bundled log-error-triage skill to cluster recurring errors and highlight probable root causes from local logs.",
    goal: "Run the log-error-triage starter skill on the relevant logs and explain the likely root cause clusters.",
    outcome: "A grouped error triage report instead of a blank skill builder flow.",
  },
  {
    id: "diagnose-local-service",
    starterSkillId: "local-service-diagnose",
    title: "Diagnose a local service",
    description: "Friday runs the bundled local-service-diagnose skill to inspect process, port, health URL, and log signals before suggesting recovery.",
    goal: "Run the local-service-diagnose starter skill for the local service I am working on and explain the safest next actions.",
    outcome: "A service diagnosis with clear recovery guidance and no destructive changes.",
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
