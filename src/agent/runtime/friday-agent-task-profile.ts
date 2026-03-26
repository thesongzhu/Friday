export type FridayAgentTaskProfileId =
  | "default"
  | "deterministic"
  | "planning"
  | "review"
  | "creative";

export type FridayAgentTaskProfileEffort = "low" | "medium" | "high";

export interface FridayAgentTaskProfileInput {
  id?: FridayAgentTaskProfileId;
  model?: string;
  temperature?: number;
  reasoningEffort?: FridayAgentTaskProfileEffort;
  reason?: string;
}

export interface FridayResolvedAgentTaskProfile {
  id: FridayAgentTaskProfileId;
  label: string;
  description: string;
  model?: string;
  temperature?: number;
  reasoningEffort: FridayAgentTaskProfileEffort;
  reason?: string;
}

const FRIDAY_AGENT_TASK_PROFILE_DEFAULTS: Record<
  FridayAgentTaskProfileId,
  Omit<FridayResolvedAgentTaskProfile, "reason" | "model">
> = {
  default: {
    id: "default",
    label: "Balanced",
    description: "General-purpose execution profile for standard assistant turns.",
    temperature: undefined,
    reasoningEffort: "medium",
  },
  deterministic: {
    id: "deterministic",
    label: "Deterministic",
    description: "Low-variance profile for extraction, generation, and verification tasks.",
    temperature: 0,
    reasoningEffort: "low",
  },
  planning: {
    id: "planning",
    label: "Planning",
    description: "Low-temperature profile for structured planning and decomposition.",
    temperature: 0.1,
    reasoningEffort: "high",
  },
  review: {
    id: "review",
    label: "Review",
    description: "Low-variance profile for critique, validation, and risk review.",
    temperature: 0.1,
    reasoningEffort: "high",
  },
  creative: {
    id: "creative",
    label: "Creative",
    description: "Higher-variance profile for ideation and open-ended synthesis.",
    temperature: 0.35,
    reasoningEffort: "medium",
  },
};

export function resolveFridayAgentTaskProfile(
  input?: FridayAgentTaskProfileId | FridayAgentTaskProfileInput,
): FridayResolvedAgentTaskProfile {
  if (!input) {
    return { ...FRIDAY_AGENT_TASK_PROFILE_DEFAULTS.default };
  }

  const normalized = typeof input === "string"
    ? { id: input }
    : input;
  const base = FRIDAY_AGENT_TASK_PROFILE_DEFAULTS[normalized.id ?? "default"];

  return {
    ...base,
    ...(normalized.model ? { model: normalized.model } : {}),
    ...(normalized.temperature !== undefined ? { temperature: normalized.temperature } : {}),
    ...(normalized.reasoningEffort ? { reasoningEffort: normalized.reasoningEffort } : {}),
    ...(normalized.reason ? { reason: normalized.reason } : {}),
  };
}
