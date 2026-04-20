import type { PageBlueprint } from "../types";

export const integrationsDetailBlueprint: PageBlueprint = {
  id: "integrations",
  title: "Integration Detail",
  audience: ["builders", "operators"],
  tasks: ["Inspect setup state", "Review health", "Run diagnostics"],
  modules: [
    { id: "summary", title: "Integration summary", purpose: "Explain what this extension does", placement: "top", actions: ["Enable", "Disable"] },
    { id: "config", title: "Configuration", purpose: "Manage connection settings", placement: "center", actions: ["Edit", "Validate"] },
    { id: "diagnostics", title: "Diagnostics", purpose: "Show health and blockers", placement: "right", actions: ["Retry check", "Open logs"] },
  ],
  desktopLayout: ["Summary top", "Config center", "Diagnostics right"],
  mobileMapping: ["Summary", "Config", "Diagnostics sheet"],
  rightRailContext: {
    sourcePage: "integrations",
    objectType: "integrationDetail",
    summary: "Shared chat rail with selected integration detail",
    injections: ["integration.selected", "integration.config", "integration.diagnostics"],
    quickActions: ["Explain blocker", "Compare alternatives", "Draft fix checklist"],
  },
  states: {
    loading: "Summary and configuration skeleton.",
    empty: "Explain how to enable the integration.",
    error: "Last-known diagnostics stay visible.",
    partial: "Config visible while health checks lag.",
    success: "Setup and diagnostics align.",
  },
  prohibitions: ["No config hidden outside this page family", "No diagnostics only in logs", "No raw backend naming as primary UI"],
};
