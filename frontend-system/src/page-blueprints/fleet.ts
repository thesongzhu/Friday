import type { PageBlueprint } from "../types";

export const fleetBlueprint: PageBlueprint = {
  id: "fleet",
  title: "Fleet",
  audience: ["fleet operators", "runtime owners"],
  tasks: ["Inspect nodes", "Check pairing", "Check sync health"],
  modules: [
    { id: "summary", title: "Fleet summary", purpose: "Summarize node condition", placement: "top", actions: ["Open node"] },
    { id: "nodes", title: "Node list", purpose: "Browse satellites and execution nodes", placement: "left", actions: ["Select node"] },
    { id: "pairing-sync", title: "Pairing and sync", purpose: "Inspect distributed state", placement: "right", actions: ["Repair pairing", "Diagnose drift"] },
  ],
  desktopLayout: ["Overview top", "Nodes left", "Pairing and sync right"],
  mobileMapping: ["Summary", "Node cards", "Pairing and sync cards", "Detail drill-in"],
  rightRailContext: {
    sourcePage: "fleet",
    objectType: "fleetNode",
    summary: "Shared chat rail with selected node and sync status",
    injections: ["fleet.node.selected", "fleet.sync", "fleet.pairing"],
    quickActions: ["Diagnose node", "Explain drift", "Check pairing"],
  },
  states: {
    loading: "Node list skeleton.",
    empty: "Explain how to add or pair the first node.",
    error: "Last-known fleet state remains visible.",
    partial: "Node list can load before sync telemetry.",
    success: "Health and recovery paths are visible.",
  },
  prohibitions: ["No inventory-only view", "No pairing hidden inside settings", "No backend-only wording for node issues"],
};
