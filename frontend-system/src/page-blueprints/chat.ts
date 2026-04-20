import type { PageBlueprint } from "../types";

export const chatBlueprint: PageBlueprint = {
  id: "chat",
  title: "Chat",
  audience: ["all users"],
  tasks: ["Start work", "Inspect tool activity", "Review outputs"],
  modules: [
    { id: "stream", title: "Message stream", purpose: "Show conversation", placement: "center", actions: ["Send", "Edit prompt"] },
    { id: "activity", title: "Run activity", purpose: "Expose tool receipts", placement: "side", actions: ["Open evidence", "Retry"] },
    { id: "actions", title: "Action cards", purpose: "Turn output into next steps", placement: "below", actions: ["Convert to workflow", "Save result"] },
  ],
  desktopLayout: ["Expanded conversation", "Activity visible beside or below stream"],
  mobileMapping: ["Fullscreen conversation", "Activity sheet", "Sticky composer"],
  rightRailContext: {
    sourcePage: "chat",
    objectType: "conversation",
    summary: "Expanded shared conversation workspace",
    injections: ["conversation.active", "run.activity", "pageContext"],
    quickActions: ["Explain result", "Turn into workflow", "Retry action"],
  },
  states: {
    loading: "Skeleton thread and activity.",
    empty: "Guided examples and starter prompts.",
    error: "Draft preserved with failure explanation.",
    partial: "Thread visible with incomplete receipts.",
    success: "Messages and actions are in sync.",
  },
  prohibitions: ["No separate mobile chat product", "No hidden receipts", "No transcript-only result"],
};
