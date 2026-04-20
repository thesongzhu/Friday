import type { PageBlueprint } from "../types";

export const observabilityBlueprint: PageBlueprint = {
  id: "observability",
  title: "Observability",
  audience: ["operators", "builders", "trust owners"],
  tasks: ["Inspect health", "Handle incidents", "Review evidence and diagnosis"],
  modules: [
    { id: "health", title: "Health overview", purpose: "Summarize runtime condition", placement: "top", actions: ["Open detail"] },
    { id: "incidents", title: "Incidents", purpose: "Expose what is broken now", placement: "above-fold", actions: ["Open incident", "Retry"] },
    { id: "trace-audit", title: "Trace and audit", purpose: "Provide evidence paths", placement: "lower", actions: ["Open trace", "Open audit"] },
  ],
  desktopLayout: ["Health and incidents above fold", "Trace, audit, retry, diagnosis below"],
  mobileMapping: ["Health", "Incidents", "Retry", "Diagnosis drill-in"],
  rightRailContext: {
    sourcePage: "observability",
    objectType: "incident",
    summary: "Shared chat rail with current incident and diagnosis",
    injections: ["health.summary", "incident.active", "diagnosis.latest"],
    quickActions: ["Explain incident", "Retry safely", "Open diagnosis"],
  },
  states: {
    loading: "Health and incident skeletons.",
    empty: "Healthy baseline plus history entry.",
    error: "Last-known health remains visible.",
    partial: "Health can load before trace detail.",
    success: "Alert to action flow is obvious.",
  },
  prohibitions: ["No chart wall without guidance", "No incident without impact summary", "No diagnosis without evidence references"],
};
