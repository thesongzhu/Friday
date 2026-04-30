/**
 * Friday glossary — beginner-friendly explanations of key terms.
 * Used by HelpTooltip to show hover-based definitions.
 */

export interface GlossaryEntry {
  term: string;
  definition: string;
}

export const FRIDAY_GLOSSARY: Record<string, GlossaryEntry> = {
  skill: {
    term: "Skill",
    definition: "An automation script that Friday can execute. Skills are single-purpose tools — like sending emails, querying databases, or calling APIs.",
  },
  workflow: {
    term: "Workflow",
    definition: "A multi-step automation flow. Workflows chain skills together with conditions, loops, and parallel branches.",
  },
  satellite: {
    term: "Satellite",
    definition: "A remote device or server that runs tasks for Friday. Satellites extend Friday's reach to other machines.",
  },
  fleet: {
    term: "Fleet",
    definition: "The collection of all connected satellite nodes. Fleet management lets you monitor health, trust, and task distribution.",
  },
  mcp: {
    term: "MCP",
    definition: "Model Context Protocol — an open standard for connecting AI models to external tools and data sources.",
  },
  agent: {
    term: "Agent",
    definition: "Friday's core AI engine that understands your requests, plans actions, and executes tasks using skills and tools.",
  },
  taskProfile: {
    term: "Task Profile",
    definition: "A configuration that controls which tools and strategies Friday uses for a task. Different profiles suit different types of work.",
  },
  observability: {
    term: "Observability",
    definition: "Tools for monitoring Friday's behavior — traces, audit logs, alerts, and health metrics for debugging.",
  },
  selfHealing: {
    term: "Self-Healing",
    definition: "Friday's ability to automatically detect issues and apply fixes without human intervention.",
  },
  episode: {
    term: "Episode",
    definition: "A record of one complete task execution — what tools were used, what happened, and whether it succeeded.",
  },
  pattern: {
    term: "Pattern",
    definition: "A work habit Friday noticed from your interactions.",
  },
  confidence: {
    term: "Confidence",
    definition: "How sure Friday is about a learned preference. Higher = more reliable.",
  },
  rollback: {
    term: "Rollback",
    definition: "When Friday undoes an action that didn't work as expected.",
  },
  hotspot: {
    term: "Hotspot",
    definition: "A problem area where fixes often fail and need to be retried.",
  },
  lesson: {
    term: "Lesson",
    definition: "Something Friday learned from a past mistake — it won't repeat the same error.",
  },
  evidence: {
    term: "Evidence",
    definition: "The number of times Friday has observed this preference.",
  },
  "auto-fix": {
    term: "Auto-fix",
    definition: "Friday automatically fixes a detected problem without asking you first.",
  },
};

export function lookupGlossary(key: string): GlossaryEntry | undefined {
  return FRIDAY_GLOSSARY[key.toLowerCase()];
}
