import type { PageBlueprint } from "../types";

export const homeBlueprint: PageBlueprint = {
  id: "home",
  title: "Home",
  audience: ["new operators", "daily managers"],
  tasks: ["See live work", "Resolve approvals", "Pick the next best action"],
  modules: [
    { id: "summary", title: "Today summary", purpose: "Summarize current state", placement: "top", actions: ["Start task", "Resume work"] },
    { id: "approvals", title: "Pending approvals", purpose: "Expose blocked decisions", placement: "above-fold", actions: ["Approve", "Deny", "Explain"] },
    { id: "recent-results", title: "Recent results", purpose: "Review outcomes", placement: "lower", actions: ["Open result"] },
  ],
  desktopLayout: ["Top summary strip", "Approvals and live work above fold", "Recent results and pinned packs below"],
  mobileMapping: ["Summary", "Approvals", "Live work", "Recent results", "Pinned packs"],
  rightRailContext: {
    sourcePage: "home",
    objectType: "homeSnapshot",
    summary: "Shared chat rail with live home context",
    injections: ["homeSnapshot", "pendingApprovals", "recommendedActions"],
    quickActions: ["Start task", "Resume run", "Triage approvals"],
  },
  states: {
    loading: "Skeleton summary and module cards.",
    empty: "Teach the user how to start the first task.",
    error: "Preserve quick-start entry and cached modules.",
    partial: "Show stale but usable home summary with warning.",
    success: "Live work and approvals are actionable.",
  },
  prohibitions: ["No analytics-first home", "No hidden approvals", "No chat-only outcomes"],
};
