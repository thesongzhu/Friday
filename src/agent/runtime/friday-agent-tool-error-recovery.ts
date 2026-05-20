/**
 * Tool Error Recovery — runtime-level forced retry for recoverable tool errors.
 *
 * When a tool call fails with a recoverable error (file not found, network timeout, etc.),
 * this module generates a mandatory recovery hint that is injected into the message history.
 * The LLM then sees the error + explicit alternative strategies, making it far more likely
 * to attempt recovery instead of immediately reporting failure to the user.
 */

// ─── Types ───

export interface ToolErrorContext {
  toolName: string;
  errorContent: string;
  errorCode?: string;
  args: Record<string, unknown>;
}

export interface RecoveryHint {
  text: string;
}

// ─── Recovery patterns ───

interface RecoveryPattern {
  tools: string[];
  pattern: RegExp;
  strategy: (ctx: ToolErrorContext) => string;
}

const RECOVERABLE_PATTERNS: RecoveryPattern[] = [
  {
    tools: ["skill_run"],
    pattern: /missing required input\(s\):/i,
    strategy: (ctx) => {
      const skillId = typeof ctx.args.skillId === "string" ? ctx.args.skillId : "";
      return [
        `Skill "${skillId}" was called without the required input fields.`,
        "You MUST recover before reporting failure:",
        "1. Read the missing field names from the error message.",
        "2. Re-run skill_run with a non-empty input object that fills those fields.",
        "3. If the original user task includes an explicit example like key=\"value\", copy that concrete value into the input instead of leaving placeholders.",
        "4. Only report success after skill_run returns completed output for the required input.",
      ].join("\n");
    },
  },
  {
    tools: ["skill_run"],
    pattern: /not found in registry|must use tool 'skill_generate'|skill generation requests must use/i,
    strategy: (ctx) => {
      const skillId = typeof ctx.args.skillId === "string" ? ctx.args.skillId : "";
      if (!/(^|[-_\s])(skill[-_\s]?generator|generate[-_\s]?skill|skill[-_\s]?generate)([-_\s]|$)/i.test(skillId)) {
        return [
          `Skill "${skillId}" was not runnable through skill_run.`,
          "You MUST call skills_list again to verify the installed skill ID before reporting failure.",
          "If the user is asking to create or update a skill rather than run an existing one, switch to the skill_generate toolchain instead of skill_run.",
        ].join("\n");
      }
      return [
        `You attempted to use skill_run with "${skillId}", but skill authoring must go through the dedicated skill_generate toolchain.`,
        "You MUST recover by doing this next:",
        "1. Call skill_generate with action=\"start\" and restate the user's requested skill goal.",
        "2. If the generator asks follow-up questions, continue with skill_generate action=\"turn\".",
        "3. After the session is ready, call skill_generate action=\"generate\" and then action=\"approve\".",
        "4. Treat approve as candidate staging only; do not call skill_run on the staged candidate.",
        "5. Direct the user to the skill lifecycle shadow/canary/promote path before any run claim.",
        "Do NOT tell the user the skill generator is unavailable unless skill_generate itself fails.",
      ].join("\n");
    },
  },
  {
    tools: [],
    pattern: /explicitly requires tool 'autonomous'|do not use '.*' as a direct bypass/i,
    strategy: (ctx) => [
      `The task must route through the "autonomous" tool, not "${ctx.toolName}".`,
      "You MUST recover before responding to the user:",
      "1. Call the autonomous tool next instead of browser/desktop/system/exec/file tools.",
      "2. Use action=\"execute_goal\" for a new goal, or resume_goal/get_goal/list_goals/cancel_goal if the task is about an existing autonomous goal.",
      "3. Restate the concrete user objective in the autonomous goal description.",
      "4. Only report success after autonomous returns goal/result evidence that the task completed.",
    ].join("\n"),
  },
  // File not found → search with find
  {
    tools: ["read"],
    pattern: /not found|no such file|ENOENT|does not exist/i,
    strategy: (ctx) => {
      const filePath = typeof ctx.args.file_path === "string" ? ctx.args.file_path : "";
      const fileName = filePath.split("/").pop() ?? "";
      const baseName = fileName.replace(/\.[^.]+$/, ""); // strip extension
      return [
        `The file "${filePath}" was not found.`,
        `You MUST try these alternatives before reporting failure to the user:`,
        `1. Use the "exec" tool with command: find . -maxdepth 2 -iname ${baseName}* -type f`,
        `2. If find returns results, use the "read" tool to read the correct file and show it to the user`,
        `3. If the filename might be wrong, ask the user "Did you mean [found filename]?"`,
        `Do NOT respond to the user until you have searched for alternatives.`,
      ].join("\n");
    },
  },

  // File permission denied
  {
    tools: ["read"],
    pattern: /permission denied|EACCES/i,
    strategy: (ctx) => {
      const filePath = typeof ctx.args.file_path === "string" ? ctx.args.file_path : "";
      return [
        `Permission denied reading "${filePath}".`,
        `Try: Use "exec" to run: cat "${filePath}" as an alternative.`,
        `If that also fails, tell the user exactly which permission is needed.`,
      ].join("\n");
    },
  },

  // Edit target not found → search for it
  {
    tools: ["edit"],
    pattern: /not found|no such file|ENOENT|does not exist/i,
    strategy: (ctx) => {
      const filePath = typeof ctx.args.file_path === "string" ? ctx.args.file_path : "";
      const fileName = filePath.split("/").pop() ?? "";
      return [
        `Cannot edit "${filePath}" — file does not exist.`,
        `Alternatives:`,
        `1. Use "exec" to run: find . -maxdepth 3 -iname "*${fileName}*" -type f`,
        `2. If you meant to create a new file, use the "write" tool instead`,
      ].join("\n");
    },
  },

  // Web fetch failure → browser fallback
  {
    tools: ["web_fetch"],
    pattern: /timeout|ETIMEDOUT|ECONNREFUSED|fetch failed|network|5\d{2}|error/i,
    strategy: (ctx) => {
      const url = typeof ctx.args.url === "string" ? ctx.args.url : "";
      return [
        `Web fetch failed for "${url}".`,
        `You MUST try an alternative:`,
        `1. Use "browser" tool with action "open" to navigate to "${url}", then "snapshot" to read content`,
        `2. Or use "web_search" to find the information through search instead`,
        `Do NOT tell the user the fetch failed without trying browser first.`,
      ].join("\n");
    },
  },

  // Web search failure → alternative search
  {
    tools: ["web_search"],
    pattern: /timeout|failed|error|rate.?limit|no results/i,
    strategy: (ctx) => {
      const query = typeof ctx.args.query === "string" ? ctx.args.query : "";
      return [
        `Web search failed or returned no results.`,
        `Try alternatives:`,
        `1. Reformulate the query with different keywords and try "web_search" again`,
        `2. Use "web_fetch" on a likely URL if you know one`,
        `3. Use "browser" to search manually on a search engine`,
      ].join("\n");
    },
  },

  // Shell command not found
  {
    tools: ["exec"],
    pattern: /command not found|not recognized|No such file or directory/i,
    strategy: (ctx) => {
      const cmd = typeof ctx.args.command === "string" ? ctx.args.command : "";
      return [
        `Shell command failed: "${cmd.slice(0, 80)}".`,
        `Try: check if the command is available with "exec" running: which ${cmd.split(/\s/)[0] ?? ""}`,
        `Or try an alternative command that achieves the same goal.`,
      ].join("\n");
    },
  },

  // Memory search empty → broaden search
  {
    tools: ["memory_search"],
    pattern: /no results|empty|not found|0 items/i,
    strategy: (ctx) => {
      const query = typeof ctx.args.query === "string" ? ctx.args.query : "";
      return [
        `Memory search returned no results for "${query}".`,
        `Try: Use "memory_search" with broader keywords or shorter query.`,
        `If still empty, tell the user you have no stored information about this topic.`,
      ].join("\n");
    },
  },

  // Generic transient network errors (any tool)
  {
    tools: [],
    pattern: /ECONNRESET|EPIPE|socket hang up|EHOSTUNREACH/i,
    strategy: (ctx) => [
      `"${ctx.toolName}" failed with a transient network error.`,
      `Retry the same tool call once. If it fails again, try a different approach.`,
    ].join("\n"),
  },
];

// ─── Non-recoverable patterns (skip these) ───

const NON_RECOVERABLE = /Tool '.*' blocked|readOnly constraint|not available in .* mode|TOOL_UNAVAILABLE|denied by policy/i;

// ─── Main function ───

/**
 * Analyzes tool errors from the current loop iteration and returns a recovery hint
 * if any errors are recoverable. Returns undefined if recovery is not warranted.
 */
export function buildToolErrorRecoveryHint(
  errors: ToolErrorContext[],
): RecoveryHint | undefined {
  const hints: string[] = [];

  for (const err of errors) {
    // Skip non-recoverable errors (policy blocks, disabled tools, readOnly)
    if (NON_RECOVERABLE.test(err.errorContent)) {
      continue;
    }

    for (const rule of RECOVERABLE_PATTERNS) {
      if (rule.tools.length > 0 && !rule.tools.includes(err.toolName)) {
        continue;
      }
      if (rule.pattern.test(err.errorContent)) {
        hints.push(rule.strategy(err));
        break; // first matching rule wins per error
      }
    }
  }

  if (hints.length === 0) {
    return undefined;
  }

  const text = [
    "[TOOL ERROR RECOVERY — MANDATORY]",
    "One or more tool calls failed with recoverable errors.",
    "You MUST attempt the suggested alternatives below before responding to the user.",
    "",
    ...hints,
    "",
    "Remember: Try the alternatives FIRST. Only report failure after attempting recovery.",
  ].join("\n");

  return { text };
}
