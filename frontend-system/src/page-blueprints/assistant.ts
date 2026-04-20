import type { PageBlueprint } from "../types";

export const assistantBlueprint: PageBlueprint = {
  id: "assistant",
  title: "Assistant",
  audience: ["operators", "trust owners"],
  tasks: ["Handle approvals", "Inspect blocked work", "Follow recovery paths"],
  modules: [
    { id: "inbox", title: "Priority inbox", purpose: "Sort what needs action", placement: "top", actions: ["Open item"] },
    { id: "approvals", title: "Approval stack", purpose: "Handle risk-gated actions", placement: "center", actions: ["Approve", "Deny", "Explain"] },
    { id: "evidence", title: "Evidence receipts", purpose: "Support decisions", placement: "detail", actions: ["Open receipt"] },
  ],
  desktopLayout: ["Priority queue as main column", "Evidence as supporting detail"],
  mobileMapping: ["Approvals first", "Issues second", "Evidence sheet"],
  rightRailContext: {
    sourcePage: "assistant",
    objectType: "approvalItem",
    summary: "Shared chat rail with current approval and evidence",
    injections: ["approval.current", "risk.level", "evidence.summary"],
    quickActions: ["Explain this", "Retry safely", "Draft response"],
  },
  states: {
    loading: "Inbox skeleton.",
    empty: "Healthy state with next best tasks.",
    error: "Cached items remain visible if possible.",
    partial: "Approvals visible while receipts lag.",
    success: "Priority ordering is clear and actionable.",
  },
  prohibitions: ["No notification-center UX", "No approval without rationale", "No recovery without evidence"],
};
