export type FridayAssistantStarterTask = {
  id: string;
  title: string;
  description: string;
  goal: string;
  outcome: string;
};

export const FRIDAY_ASSISTANT_STARTER_TASKS: FridayAssistantStarterTask[] = [
  {
    id: "clarify-next-step",
    title: "Help me figure out what to do next",
    description: "Friday reviews the current system, recent activity, and open issues, then guides the user toward the most useful next move.",
    goal: "Help me figure out what I should do next and guide me to the first useful action.",
    outcome: "A guided plan with the next best action already prepared.",
  },
  {
    id: "deploy-reporting-workflow",
    title: "Generate and deploy a reporting workflow",
    description: "Friday turns a vague recurring reporting goal into a workflow draft, deploys it, and prepares the first run.",
    goal: "Generate and deploy a workflow for weekly reporting, then guide me through the first run.",
    outcome: "A deployed workflow with a clear first-run path.",
  },
  {
    id: "enable-triage-skill",
    title: "Generate and enable an error triage skill",
    description: "Friday creates a skill, validates it, and brings it to an install-and-enable decision point without forcing the user into builder flows.",
    goal: "Generate and enable a skill for triaging errors, then show me how to use it safely.",
    outcome: "A validated skill ready to enable and use.",
  },
  {
    id: "recover-degraded-system",
    title: "Diagnose and recover a degraded system",
    description: "Friday inspects health and incident signals, explains what looks wrong, and lines up the safest recovery actions.",
    goal: "This system looks unhealthy. Figure out what is wrong, explain the safest recovery path, and guide me through it.",
    outcome: "A recovery plan with clear next actions and approvals if needed.",
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
