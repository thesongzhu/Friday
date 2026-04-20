import type { PageBlueprint } from "../types";

export const integrationsBlueprint: PageBlueprint = {
  id: "integrations",
  title: "Integrations",
  audience: ["builders", "operators"],
  tasks: ["Compare extension types", "Inspect health", "Configure connection"],
  modules: [
    { id: "overview", title: "Integration overview", purpose: "Summarize health by type", placement: "top", actions: ["Open section"] },
    { id: "switcher", title: "Section switcher", purpose: "Toggle Packs, Skills, Plugins, MCP, Channels", placement: "top", actions: ["Switch section"] },
    { id: "detail", title: "Selected integration detail", purpose: "Show setup and diagnostics", placement: "body", actions: ["Configure", "Diagnose"] },
  ],
  desktopLayout: ["Overview top", "Section switcher", "List-detail body"],
  mobileMapping: ["Switcher top", "One-column cards", "Detail drill-in"],
  rightRailContext: {
    sourcePage: "integrations",
    objectType: "integration",
    summary: "Shared chat rail with selected extension and setup blockers",
    injections: ["integration.selected", "integration.health", "setup.blockers"],
    quickActions: ["Configure this", "Compare options", "Diagnose connection"],
  },
  states: {
    loading: "Overview and list skeleton.",
    empty: "Explain the five integration types.",
    error: "Health summary remains visible.",
    partial: "List works while detail or health lags.",
    success: "List, detail, and diagnostics agree.",
  },
  prohibitions: ["No Marketplace content", "No MCP hidden under generic settings", "No plugin health visible only in logs"],
};
