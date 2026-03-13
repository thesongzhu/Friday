export type StarterSkillTelemetryEventName =
  | "starter_skill_shown"
  | "starter_skill_invoked"
  | "starter_skill_suggested"
  | "starter_skill_detail_opened";

export interface StarterSkillTelemetryEvent {
  event: StarterSkillTelemetryEventName;
  skillId: string;
  source: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

const STORAGE_KEY = "friday.starter-skill-telemetry";
const MAX_EVENTS = 100;

export function trackStarterSkillEvent(
  event: StarterSkillTelemetryEventName,
  input: {
    skillId: string;
    source: string;
    metadata?: Record<string, unknown>;
  },
): void {
  if (typeof window === "undefined") {
    return;
  }

  const entry: StarterSkillTelemetryEvent = {
    event,
    skillId: input.skillId,
    source: input.source,
    timestamp: new Date().toISOString(),
    metadata: input.metadata,
  };

  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const existing = raw ? (JSON.parse(raw) as StarterSkillTelemetryEvent[]) : [];
    const next = [...existing, entry].slice(-MAX_EVENTS);
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal: local telemetry buffering should never block the UI.
  }

  window.dispatchEvent(new CustomEvent("friday:starter-skill-telemetry", { detail: entry }));
}

export function trackStarterSkillBatch(
  event: StarterSkillTelemetryEventName,
  input: {
    skillIds: string[];
    source: string;
    metadata?: Record<string, unknown>;
  },
): void {
  const uniqueSkillIds = [...new Set(input.skillIds)];
  for (const skillId of uniqueSkillIds) {
    trackStarterSkillEvent(event, {
      skillId,
      source: input.source,
      metadata: input.metadata,
    });
  }
}
