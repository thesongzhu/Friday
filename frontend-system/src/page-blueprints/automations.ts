import type { PageBlueprint } from "../types";

export const automationsBlueprint: PageBlueprint = {
  id: "automations",
  title: "Automations",
  audience: ["daily managers", "builders"],
  tasks: ["Review schedules", "Run immediately", "Inspect queue state"],
  modules: [
    { id: "overview", title: "Automation overview", purpose: "Summarize schedule and queue health", placement: "top", actions: ["Run now"] },
    { id: "schedules", title: "Schedules", purpose: "Manage recurring work", placement: "left", actions: ["Pause", "Resume"] },
    { id: "queue", title: "Queue", purpose: "Inspect delayed or active work", placement: "right", actions: ["Inspect", "Retry"] },
  ],
  desktopLayout: ["Overview top", "Schedules left", "Queue right"],
  mobileMapping: ["Overview", "Schedules", "Queue timeline", "Execution detail sheet"],
  rightRailContext: {
    sourcePage: "automations",
    objectType: "automation",
    summary: "Shared chat rail with selected automation and queue context",
    injections: ["automation.selected", "queue.health", "schedule.nextRun"],
    quickActions: ["Run now", "Pause", "Explain schedule"],
  },
  states: {
    loading: "Schedules and queue skeletons.",
    empty: "Explain how to create the first automation.",
    error: "Quick-run path remains available.",
    partial: "Schedules visible while execution history lags.",
    success: "Schedules and queue health stay connected.",
  },
  prohibitions: ["No queue hidden in another page", "No schedule without action controls", "No timeline without current status"],
};
