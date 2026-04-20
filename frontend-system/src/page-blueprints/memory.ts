import type { PageBlueprint } from "../types";

export const memoryBlueprint: PageBlueprint = {
  id: "memory",
  title: "Memory",
  audience: ["operators", "builders", "trust owners"],
  tasks: ["Search memory", "Inspect learned facts", "Edit retention"],
  modules: [
    { id: "search", title: "Search", purpose: "Find memory records", placement: "top", actions: ["Search", "Filter"] },
    { id: "results", title: "Results", purpose: "Browse records", placement: "left", actions: ["Open record"] },
    { id: "detail", title: "Record detail", purpose: "Show provenance and actions", placement: "right", actions: ["Forget", "Retain"] },
  ],
  desktopLayout: ["Search header", "List-detail body", "Retention actions in detail"],
  mobileMapping: ["Search", "Results", "Record detail sheet"],
  rightRailContext: {
    sourcePage: "memory",
    objectType: "memoryRecord",
    summary: "Shared chat rail with selected memory provenance",
    injections: ["memory.selected", "memory.provenance", "sessions.related"],
    quickActions: ["Forget this", "Explain provenance", "Retain with note"],
  },
  states: {
    loading: "Search shell skeleton.",
    empty: "Teach what memory is and how it is learned.",
    error: "Search and cleanup controls remain visible.",
    partial: "Provenance can lag behind result list.",
    success: "Record meaning and actions are clear.",
  },
  prohibitions: ["No database-first language", "No destructive cleanup without scope", "No hidden provenance"],
};
