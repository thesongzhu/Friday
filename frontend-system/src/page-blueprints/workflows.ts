import type { PageBlueprint } from "../types";

export const workflowsBlueprint: PageBlueprint = {
  id: "workflows",
  title: "Workflows",
  audience: ["builders", "automation managers"],
  tasks: ["Browse workflows", "Open builder", "Inspect runs"],
  modules: [
    { id: "library", title: "Workflow list", purpose: "Browse available workflows", placement: "left", actions: ["Filter", "Select"] },
    { id: "detail", title: "Workflow detail", purpose: "Review selected workflow", placement: "right", actions: ["Edit", "Run"] },
    { id: "runs", title: "Run history", purpose: "Inspect execution state", placement: "bottom", actions: ["Retry", "Open evidence"] },
  ],
  desktopLayout: ["List-detail body", "Builder entry in detail header", "Runs below"],
  mobileMapping: ["List", "Detail drill-in", "Builder and runs sub-tabs"],
  rightRailContext: {
    sourcePage: "workflows",
    objectType: "workflow",
    summary: "Shared chat rail with workflow and latest runs",
    injections: ["workflow.selected", "runs.latest", "builder.validation"],
    quickActions: ["Explain failure", "Open builder", "Rerun latest"],
  },
  states: {
    loading: "Library and detail skeleton.",
    empty: "Guide toward first workflow.",
    error: "Library remains usable.",
    partial: "Run history can lag behind list selection.",
    success: "Workflow, runs, and evidence align.",
  },
  prohibitions: ["No hidden builder entry", "No failed run without retry path", "No page losing context on detail change"],
};
