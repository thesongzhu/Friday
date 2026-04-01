/**
 * Composable Prompt Section Registry — Initiative E.1
 *
 * Replaces the monolithic string concatenation in
 * `buildFridayAgentSystemPrompt()` with a composable pipeline
 * of typed, prioritized sections.
 *
 * Each section:
 * - Has a unique `id` for dedup and override
 * - Has a `priority` (lower = earlier in prompt)
 * - Produces a string fragment or undefined (skip)
 * - Can be conditionally enabled based on build context
 *
 * The existing `buildFridayAgentSystemPrompt()` continues to work
 * unchanged. This module provides the NEW composable path.
 */

import type { BuildFridayAgentSystemPromptParams } from "./friday-agent-system-prompt-builder.js";

// ─── Types ───

/** Context passed to each section builder. */
export interface FridayPromptBuildContext extends BuildFridayAgentSystemPromptParams {
  /** Resolved tool set for O(1) lookup. */
  toolSet: ReadonlySet<string>;
  /** Custom persona overrides from rules engine (Initiative E.2). */
  personaOverrides?: {
    name?: string;
    intro?: string;
    behaviorRules?: string[];
  };
}

/** A composable prompt section. */
export interface FridayPromptSection {
  /** Unique section identifier. */
  id: string;
  /** Priority — lower values appear earlier in the prompt. */
  priority: number;
  /** Build the section content. Return undefined to skip. */
  build(context: FridayPromptBuildContext): string | undefined;
}

// ─── Registry ───

export interface FridayPromptSectionRegistry {
  /** Register a section. Overwrites if same id exists. */
  register(section: FridayPromptSection): void;
  /** Remove a section by id. */
  remove(id: string): boolean;
  /** Build the full prompt from all registered sections. */
  build(context: FridayPromptBuildContext): string;
  /** List all registered section ids in priority order. */
  listIds(): string[];
}

export function createFridayPromptSectionRegistry(): FridayPromptSectionRegistry {
  const sections = new Map<string, FridayPromptSection>();

  function register(section: FridayPromptSection): void {
    sections.set(section.id, section);
  }

  function remove(id: string): boolean {
    return sections.delete(id);
  }

  function build(context: FridayPromptBuildContext): string {
    const sorted = [...sections.values()].sort((a, b) => a.priority - b.priority);
    const fragments: string[] = [];

    for (const section of sorted) {
      const fragment = section.build(context);
      if (fragment !== undefined && fragment.length > 0) {
        fragments.push(fragment);
      }
    }

    return fragments.join("\n\n");
  }

  function listIds(): string[] {
    return [...sections.values()]
      .sort((a, b) => a.priority - b.priority)
      .map((s) => s.id);
  }

  return { register, remove, build, listIds };
}

// ─── Default sections (matching existing prompt structure) ───

/** Identity section: "You are Friday vX..." */
export const FRIDAY_PROMPT_SECTION_IDENTITY: FridayPromptSection = {
  id: "identity",
  priority: 0,
  build(ctx) {
    const name = ctx.personaOverrides?.name ?? "Friday";
    const intro = ctx.personaOverrides?.intro ??
      `You are ${name} v${ctx.version}, an autonomous AI agent. ` +
      `Your underlying model is ${ctx.modelIdentity}. ` +
      "You were created by Jarvis as an open-source project. " +
      "You are designed to solve problems end-to-end — from answering questions to executing multi-step tasks autonomously. " +
      "You can read and modify files, run shell commands, and execute tests. When you make code changes, validate them before reporting completion. " +
      "Your only hard constraint: never break existing functionality. Always run tests after modifying code.";
    return intro;
  },
};

/** Time context section. */
export const FRIDAY_PROMPT_SECTION_TIME: FridayPromptSection = {
  id: "time_context",
  priority: 5,
  build(ctx) {
    if (!ctx.currentTime) return undefined;
    return (
      "Current time context:\n" +
      `- nowIso: ${ctx.currentTime.nowIso}\n` +
      `- timezone: ${ctx.currentTime.timezone}\n` +
      `- localDate: ${ctx.currentTime.localDate}`
    );
  },
};

/** Capabilities section. */
export const FRIDAY_PROMPT_SECTION_CAPABILITIES: FridayPromptSection = {
  id: "capabilities",
  priority: 10,
  build(ctx) {
    const hasTool = (name: string) => ctx.toolSet.has(name);
    const lines = [
      `- Tools: ${ctx.toolNames.join(", ")}`,
      hasTool("browser") || hasTool("canvas")
        ? "- Browser automation (Playwright with host Chrome CDP support)"
        : "- Browser automation is not enabled in this deployment.",
      hasTool("desktop")
        ? "- Desktop control (mouse, keyboard, screen capture)"
        : "- Desktop control is available only when the desktop runtime is enabled in this deployment.",
      hasTool("system")
        ? "- Agent OS system orchestration (approvals, control leases, app/project handoff, trusted-device surfaces)"
        : "- Agent OS system orchestration is not enabled in this deployment.",
      hasTool("exec")
        ? "- Shell execution (CLI commands with runtime safety guards)"
        : "- Shell execution is not enabled in this deployment.",
      "- Workflow engine: DAG-based multi-step orchestration with triggers and approval gates",
      "- Memory: embedding-based long-term memory with recall",
    ];
    return "Capabilities:\n" + lines.join("\n");
  },
};

/** Starter skills section. */
export const FRIDAY_PROMPT_SECTION_STARTER_SKILLS: FridayPromptSection = {
  id: "starter_skills",
  priority: 80,
  build(ctx) {
    const skills = ctx.starterSkills;
    if (!skills || skills.length === 0) return undefined;

    const render = (s: NonNullable<typeof skills>) =>
      s.slice(0, 8)
        .map((skill) => `- ${skill.skillId}: ${skill.purpose}. Typical triggers: ${skill.triggerPhrases.join(", ") || "none listed"}`)
        .join("\n");

    const diagnosis = skills.filter((s) =>
      (s.tags ?? []).some((t) => t === "starter.diagnosis" || t === "starter.recovery"),
    );
    const others = skills.filter((s) => !diagnosis.includes(s));

    const sections = [
      diagnosis.length > 0 ? `Available Diagnosis & Recovery Skills:\n${render(diagnosis)}` : "",
      others.length > 0 ? `${diagnosis.length > 0 ? "Other Starter Skills" : "Available Starter Skills"}:\n${render(others)}` : "",
    ].filter((s) => s.length > 0);

    return sections.join("\n\n") || undefined;
  },
};

/** Workspace context section. */
export const FRIDAY_PROMPT_SECTION_WORKSPACE: FridayPromptSection = {
  id: "workspace_context",
  priority: 90,
  build(ctx) {
    return ctx.workspaceContext || undefined;
  },
};

/**
 * Create a registry pre-populated with default sections.
 */
export function createDefaultPromptSectionRegistry(): FridayPromptSectionRegistry {
  const registry = createFridayPromptSectionRegistry();
  registry.register(FRIDAY_PROMPT_SECTION_IDENTITY);
  registry.register(FRIDAY_PROMPT_SECTION_TIME);
  registry.register(FRIDAY_PROMPT_SECTION_CAPABILITIES);
  registry.register(FRIDAY_PROMPT_SECTION_STARTER_SKILLS);
  registry.register(FRIDAY_PROMPT_SECTION_WORKSPACE);
  return registry;
}
