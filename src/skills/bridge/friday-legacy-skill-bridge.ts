/**
 * Legacy SKILL.md bridge — wraps an `AdaptedFridayLegacySkill` into a
 * full `FridaySkill` that can be executed by the runtime.
 *
 * Each bash code block in the SKILL.md becomes an available "action".
 * The bridge selects the best-matching action based on user intent and
 * executes it via the shell executor.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AdaptedFridayLegacySkill } from "../manifest/friday-skill-legacy-adapter.js";
import type { FridayShellExecutor } from "../executor/friday-skill-executor.types.js";
import type {
  FridaySkill,
  SkillExecuteContext,
  SkillExecutionResult,
  SkillInitContext,
  SkillRunState,
  SkillTeardownContext,
} from "../model/friday-skill-runtime.types.js";
import { parseFridaySkillFrontmatter } from "../manifest/friday-skill-frontmatter-parser.js";
import {
  type ExtractedCommand,
  extractMarkdownCommands,
} from "../converter/utils/friday-markdown-command-extractor.js";

// ─── Types ───

export interface LegacyBridgeState {
  /** All extracted commands from the SKILL.md. */
  commands: ExtractedCommand[];
  /** Index of the last-executed command (-1 = none). */
  lastCommandIndex: number;
  /** Raw SKILL.md body content. */
  skillBody: string;
}

export interface FridayLegacySkillBridge {
  wrap(adapted: AdaptedFridayLegacySkill): FridaySkill<unknown, LegacyBridgeState, unknown>;
}

export interface CreateFridayLegacySkillBridgeDeps {
  shellExecutor: FridayShellExecutor;
}

// ─── Implementation ───

/**
 * Creates a bridge that converts legacy SKILL.md skills into executable
 * `FridaySkill` instances.
 */
export function createFridayLegacySkillBridge(
  deps: CreateFridayLegacySkillBridgeDeps,
): FridayLegacySkillBridge {
  const { shellExecutor } = deps;

  return {
    wrap(adapted: AdaptedFridayLegacySkill): FridaySkill<unknown, LegacyBridgeState, unknown> {
      // Read the SKILL.md body at wrap-time (not per-execution)
      const body = readSkillBody(adapted.skillMdPath);
      const commands = extractMarkdownCommands(body);

      const skill: FridaySkill<unknown, LegacyBridgeState, unknown> = {
        manifest: adapted.manifest,

        async init(ctx: SkillInitContext<unknown>): Promise<SkillRunState<LegacyBridgeState>> {
          return {
            runId: `${adapted.manifest.id}-${ctx.sessionId}-${Date.now()}`,
            skillId: adapted.manifest.id,
            version: adapted.manifest.version,
            status: "running",
            currentStepId: "execute",
            attemptsByStep: {},
            state: {
              commands,
              lastCommandIndex: -1,
              skillBody: body,
            },
            startedAt: ctx.nowIso,
            updatedAt: ctx.nowIso,
          };
        },

        async execute(
          ctx: SkillExecuteContext<unknown, LegacyBridgeState>,
        ): Promise<SkillExecutionResult<LegacyBridgeState, unknown>> {
          const { run, input, userMessage } = ctx;
          const availableCommands = run.state.commands;

          if (availableCommands.length === 0) {
            return {
              run: {
                ...run,
                status: "failed",
                updatedAt: new Date().toISOString(),
              },
              messages: [
                {
                  role: "system",
                  text: `No executable commands found in SKILL.md for skill "${adapted.manifest.id}".`,
                },
              ],
            };
          }

          // Pick the best command based on input/intent
          const selectedIndex = selectCommand(availableCommands, input, userMessage);
          const selected = availableCommands[selectedIndex]!;

          // Replace {{variable}} placeholders with safe $FRIDAY_INPUT_VAR references.
          // User values are passed exclusively via env vars — never interpolated
          // into the command string — to prevent shell injection.
          const safeCommand = interpolateCommandToEnvRefs(selected.command);

          // Execute via shell — user input is only in env, not the command string
          const skillDir = dirname(adapted.skillMdPath);
          const result = await shellExecutor.run({
            command: "sh",
            args: ["-c", safeCommand],
            cwd: skillDir,
            env: buildEnv(adapted, input as Record<string, unknown>),
            timeoutMs: adapted.manifest.runtime.timeoutMsDefault,
          });

          const updatedState: LegacyBridgeState = {
            ...run.state,
            lastCommandIndex: selectedIndex,
          };

          const isSuccess = result.exitCode === 0 && !result.timedOut;

          const messages: Array<{ role: "assistant" | "system"; text: string }> = [];
          if (result.stdout.trim()) {
            messages.push({ role: "assistant", text: result.stdout.trim() });
          }
          if (result.stderr.trim() && !isSuccess) {
            messages.push({ role: "system", text: `stderr: ${result.stderr.trim()}` });
          }
          if (result.timedOut) {
            messages.push({ role: "system", text: "Command timed out." });
          }

          return {
            run: {
              ...run,
              status: isSuccess ? "completed" : "failed",
              state: updatedState,
              updatedAt: new Date().toISOString(),
            },
            messages,
            output: {
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              timedOut: result.timedOut,
              durationMs: result.durationMs,
              commandLabel: selected.label,
              commandIndex: selectedIndex,
            },
          };
        },

        async teardown(_ctx: SkillTeardownContext<LegacyBridgeState>): Promise<void> {
          // No-op for legacy skills — nothing to clean up
        },
      };

      return skill;
    },
  };
}

// ─── Helpers ───

/**
 * Selects the best-matching command for a given input/intent.
 *
 * Strategy:
 * 1. If `input.commandIndex` is provided, use it directly.
 * 2. If `input.commandLabel` is provided, fuzzy-match against labels.
 * 3. Otherwise, match the user message against labels.
 * 4. Fall back to the first command.
 */
export function selectCommand(
  commands: ExtractedCommand[],
  input: unknown,
  userMessage?: string,
): number {
  if (commands.length === 0) return 0;

  const inputObj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  // Direct index selection — must be an integer within bounds
  if (typeof inputObj.commandIndex === "number") {
    const idx = inputObj.commandIndex;
    if (Number.isInteger(idx) && idx >= 0 && idx < commands.length) return idx;
  }

  // Label match
  if (typeof inputObj.commandLabel === "string") {
    const target = inputObj.commandLabel.toLowerCase();
    const idx = commands.findIndex((c) => c.label.toLowerCase().includes(target));
    if (idx !== -1) return idx;
  }

  // User message fuzzy match against labels
  if (userMessage) {
    const msg = userMessage.toLowerCase();
    let bestScore = 0;
    let bestIdx = 0;
    for (let i = 0; i < commands.length; i++) {
      const score = fuzzyScore(msg, commands[i]!.label.toLowerCase());
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestScore > 0) return bestIdx;
  }

  // Default to first
  return 0;
}

/**
 * Simple word-overlap scoring for fuzzy matching.
 * Returns the number of words in common between query and target.
 */
function fuzzyScore(query: string, target: string): number {
  const queryWords = query.split(/\s+/).filter(Boolean);
  const targetWords = new Set(target.split(/\s+/).filter(Boolean));
  let score = 0;
  for (const word of queryWords) {
    if (targetWords.has(word)) score++;
  }
  return score;
}

/**
 * Replaces `{{variable}}` placeholders with safe shell env-var references
 * (`"$FRIDAY_INPUT_VARIABLE"`). User values are never interpolated into the
 * command string — they live only in the process environment.
 *
 * Unknown placeholders (no matching key) are left as-is.
 */
export function interpolateCommandToEnvRefs(template: string): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return `"$FRIDAY_INPUT_${key.toUpperCase()}"`;
  });
}

/**
 * Interpolates `{{variable}}` placeholders in a command string with
 * values from the input object. Unknown placeholders are left as-is.
 *
 * @deprecated Use {@link interpolateCommandToEnvRefs} instead — this function
 * is unsafe for shell execution because it embeds raw values in command strings.
 * Retained only for non-shell template rendering.
 */
export function interpolateCommand(
  template: string,
  input: Record<string, unknown>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = input[key];
    if (value === undefined || value === null) return `{{${key}}}`;
    return String(value);
  });
}

/**
 * Reads the SKILL.md file and extracts the body content (everything after
 * frontmatter). Returns empty string on failure.
 */
function readSkillBody(skillMdPath: string): string {
  try {
    const raw = readFileSync(skillMdPath, "utf-8");
    const result = parseFridaySkillFrontmatter(raw);
    return result.ok ? result.value.body : raw;
  } catch {
    return "";
  }
}

/**
 * Builds environment variables for the shell command.
 * Includes any env vars from the manifest requirements.
 */
function buildEnv(
  adapted: AdaptedFridayLegacySkill,
  input: Record<string, unknown>,
): Record<string, string> {
  const env: Record<string, string> = {};

  // Pass input values as FRIDAY_INPUT_* env vars
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) {
      env[`FRIDAY_INPUT_${key.toUpperCase()}`] = String(value);
    }
  }

  // Set skill metadata env vars
  env.FRIDAY_SKILL_ID = adapted.manifest.id;
  env.FRIDAY_SKILL_NAME = adapted.manifest.name;

  return env;
}
