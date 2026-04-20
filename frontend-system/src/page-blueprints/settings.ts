import type { PageBlueprint } from "../types";

export const settingsBlueprint: PageBlueprint = {
  id: "settings",
  title: "Settings",
  audience: ["builders", "trust owners", "runtime operators"],
  tasks: ["Configure providers", "Inspect security posture", "Manage runtime and utilities"],
  modules: [
    { id: "domains", title: "Settings domains", purpose: "Switch provider, security, runtime, utility sections", placement: "top", actions: ["Switch domain"] },
    { id: "providers", title: "Providers and routing", purpose: "Control runtime provider logic", placement: "body", actions: ["Compare", "Edit"] },
    { id: "security", title: "Security center", purpose: "Inspect secrets, grants, tokens, and warnings", placement: "body", actions: ["Review", "Rotate", "Revoke"] },
  ],
  desktopLayout: ["Domain switcher top", "Stacked domain sections"],
  mobileMapping: ["Segmented domain switcher", "Stacked sections", "Sensitive edits in sheets"],
  rightRailContext: {
    sourcePage: "settings",
    objectType: "settingsDomain",
    summary: "Shared chat rail with current control-plane context",
    injections: ["settings.domain", "warnings.open", "selected.provider"],
    quickActions: ["Compare providers", "Explain routing", "Review security posture"],
  },
  states: {
    loading: "Domain nav and section skeletons.",
    empty: "Only optional subsections may be empty.",
    error: "Last-known values are visible where safe.",
    partial: "Sensitive values may stay redacted while metadata loads.",
    success: "Control plane is understandable without logs.",
  },
  prohibitions: ["No backend package names as domains", "No unsafe secret display", "No split admin mode"],
};
