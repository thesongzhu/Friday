import type { FridayAgentTaskProfileId } from "../runtime/friday-agent-task-profile.js";

export type FridaySubagentProfileId = "explore" | "plan" | "debug" | "review" | "execute";

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
  execute: {
    id: "execute",
    label: "Execute",
    description: "Full-access execution with tool mutations allowed.",
    taskProfile: "default",
    readOnly: false,
    maxTurns: 6,
    instructions: [
      "Execute the delegated task using all available tools including write operations.",
      "Store results, feedback, and memory as instructed. Do not skip mutations.",
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
  // Execute profile: tasks that require write access (memory, files, feedback, etc.)
  if (DIRECT_WRITE_HINTS.test(text)) {
    return "execute";
  }
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

const TOKEN_EDGE = "(?:^|[^a-z0-9])";
const TOKEN_END = "(?=$|[^a-z0-9])";

const DIRECT_WRITE_HINTS = new RegExp(
  `${TOKEN_EDGE}(write|edit|modify|update|patch|rewrite|rename|delete|remove|store|save|create|generate|import|record|feedback|remember|learn|preference|persist|memory_store|memory_delete|memory_clear|memory_update)${TOKEN_END}`,
  "i",
);
const IMPLEMENTATION_HINTS = new RegExp(
  `${TOKEN_EDGE}(fix|implement|refactor|store|save|create|record|feedback|learn|persist|memory_store|memory_delete|memory_clear|memory_update)${TOKEN_END}`,
  "i",
);
const IMPLEMENTATION_DOMAINS =
  /\b(file|files|code|repo|repository|workflow|skill|test|tests|docs|document|folder|directory|workspace|project|memory|automation)\b/i;
const BROWSER_MUTATION_HINTS =
  /\b(open|navigate|click|type|fill|select|press|drag|upload|take|capture|attach)\b/i;
const BROWSER_MUTATION_DOMAINS =
  /\b(browser|page|site|website|url|screenshot|screen shot|image|tab)\b|https?:\/\/|(?:^|\s)[\w-]+\.(com|net|org|io|dev|app)\b/i;
const EXEC_MUTATION_HINTS =
  /\b(run|execute|launch|start|stop|restart|deploy|build|install|lint|typecheck|migrate|publish|release|export)\b/i;
const EXEC_MUTATION_DOMAINS =
  /\b(command|shell|bash|script|server|service|process|package|dependency|tests?|build|deployment|release|migration)\b/i;
const MESSAGE_MUTATION_HINTS =
  /\b(send|post|reply|attach|upload|publish)\b/i;
const MESSAGE_MUTATION_DOMAINS =
  /\b(discord|slack|telegram|message|email|screenshot|file|artifact)\b/i;

export function taskLikelyNeedsWriteAccessForSubagent(task: string, label?: string): boolean {
  const text = `${label ?? ""}\n${task}`.trim();
  if (text.length === 0) {
    return false;
  }

  if (DIRECT_WRITE_HINTS.test(text)) {
    return true;
  }

  if (IMPLEMENTATION_HINTS.test(text) && IMPLEMENTATION_DOMAINS.test(text)) {
    return true;
  }

  if (BROWSER_MUTATION_HINTS.test(text) && BROWSER_MUTATION_DOMAINS.test(text)) {
    return true;
  }

  if (EXEC_MUTATION_HINTS.test(text) && EXEC_MUTATION_DOMAINS.test(text)) {
    return true;
  }

  if (MESSAGE_MUTATION_HINTS.test(text) && MESSAGE_MUTATION_DOMAINS.test(text)) {
    return true;
  }

  return false;
}
