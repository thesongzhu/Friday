import type { FridayAgentTaskProfileId } from "../runtime/friday-agent-task-profile.js";

export type FridaySubagentProfileId = "explore" | "plan" | "debug" | "review";

export interface FridaySubagentProfileInput {
  id?: FridaySubagentProfileId;
  model?: string;
  taskProfile?: FridayAgentTaskProfileId;
  readOnly?: boolean;
}

export interface FridayResolvedSubagentProfile {
  id: FridaySubagentProfileId;
  label: string;
  description: string;
  model?: string;
  taskProfile: FridayAgentTaskProfileId;
  readOnly: boolean;
  maxTurns: number;
  instructions: string[];
}

const FRIDAY_SUBAGENT_PROFILE_DEFAULTS: Record<
  FridaySubagentProfileId,
  Omit<FridayResolvedSubagentProfile, "model">
> = {
  explore: {
    id: "explore",
    label: "Explore",
    description: "Read-only reconnaissance for codebase and runtime facts.",
    taskProfile: "deterministic",
    readOnly: true,
    maxTurns: 4,
    instructions: [
      "Prefer inspection, listing, and evidence gathering over edits.",
      "Return concrete findings and next-step evidence, not speculative plans.",
    ],
  },
  plan: {
    id: "plan",
    label: "Plan",
    description: "Read-only decomposition and implementation planning.",
    taskProfile: "planning",
    readOnly: true,
    maxTurns: 4,
    instructions: [
      "Produce a structured execution plan with risks and validation steps.",
      "Do not edit files unless the parent explicitly delegates implementation ownership.",
    ],
  },
  debug: {
    id: "debug",
    label: "Debug",
    description: "Read-only debugging with tests, logs, and focused root-cause analysis.",
    taskProfile: "review",
    readOnly: true,
    maxTurns: 6,
    instructions: [
      "Run diagnostics and tests as needed, but avoid code edits by default.",
      "Distinguish observed failures from inferred root causes.",
    ],
  },
  review: {
    id: "review",
    label: "Review",
    description: "Read-only risk review focused on regressions and test gaps.",
    taskProfile: "review",
    readOnly: true,
    maxTurns: 4,
    instructions: [
      "Prioritize bugs, regressions, unsafe assumptions, and missing validation.",
      "Keep summaries short after enumerating findings.",
    ],
  },
};

export function resolveFridaySubagentProfile(
  input?: FridaySubagentProfileId | FridaySubagentProfileInput,
): FridayResolvedSubagentProfile {
  const normalized = typeof input === "string"
    ? { id: input }
    : input;
  const base = FRIDAY_SUBAGENT_PROFILE_DEFAULTS[normalized?.id ?? "explore"];
  return {
    ...base,
    ...(normalized?.model ? { model: normalized.model } : {}),
    ...(normalized?.taskProfile ? { taskProfile: normalized.taskProfile } : {}),
    ...(normalized?.readOnly !== undefined ? { readOnly: normalized.readOnly } : {}),
  };
}

export function inferFridaySubagentProfile(task: string, label?: string): FridaySubagentProfileId {
  const text = `${label ?? ""}\n${task}`.toLowerCase();
  if (/\b(review|audit|risk|regression|test gap|diff)\b/.test(text)) {
    return "review";
  }
  if (/\b(plan|design|scope|roadmap|decompose|architecture)\b/.test(text)) {
    return "plan";
  }
  if (/\b(debug|investigate|root cause|error|failing|broken|trace|log)\b/.test(text)) {
    return "debug";
  }
  return "explore";
}
