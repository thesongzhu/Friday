import type { PageBlueprint } from "../types";

export const workflowBuilderBlueprint: PageBlueprint = {
  id: "workflows",
  title: "Workflow Builder",
  audience: ["builders"],
  tasks: ["Edit workflow structure", "Validate logic", "Prepare safe publish"],
  modules: [
    { id: "canvas", title: "Builder canvas", purpose: "Edit workflow nodes and steps", placement: "center", actions: ["Add node", "Remove node"] },
    { id: "validation", title: "Validation rail", purpose: "Show issues and evidence", placement: "right", actions: ["Open issue"] },
    { id: "publish", title: "Publish footer", purpose: "Save or publish changes", placement: "bottom", actions: ["Save draft", "Publish"] },
  ],
  desktopLayout: ["Context header", "Main builder canvas", "Validation rail", "Safe publish footer"],
  mobileMapping: ["Structured editor", "Validation sheet", "Sticky publish footer"],
  rightRailContext: {
    sourcePage: "workflows",
    objectType: "workflowBuilder",
    summary: "Shared chat rail with builder validation context",
    injections: ["workflow.selected", "builder.validation", "builder.unsavedChanges"],
    quickActions: ["Explain validation issue", "Suggest next step", "Generate branch"],
  },
  states: {
    loading: "Canvas skeleton and validation placeholders.",
    empty: "Starter templates and examples.",
    error: "Unsaved draft stays visible with failure banner.",
    partial: "Canvas available while validation recalculates.",
    success: "Builder and validation remain synchronized.",
  },
  prohibitions: ["No hidden validation rail", "No destructive publish without confirmation", "No separate builder product"],
};
