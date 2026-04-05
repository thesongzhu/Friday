import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

// ─── Platform definitions ───

const PLATFORMS = {
  jira: {
    name: "Jira",
    mcpPrefix: "jira",
    operations: {
      create_task: { tool: "jira_create_issue", fields: ["title", "description", "project", "type"] },
      list_tasks: { tool: "jira_search", fields: ["query", "project"] },
      update_task: { tool: "jira_update_issue", fields: ["taskId", "status", "title"] },
    },
  },
  linear: {
    name: "Linear",
    mcpPrefix: "linear",
    operations: {
      create_task: { tool: "linear_create_issue", fields: ["title", "description", "team"] },
      list_tasks: { tool: "linear_list_issues", fields: ["team", "status"] },
      update_task: { tool: "linear_update_issue", fields: ["taskId", "status", "title"] },
    },
  },
  notion: {
    name: "Notion",
    mcpPrefix: "notion",
    operations: {
      create_task: { tool: "notion_create_page", fields: ["title", "description", "database"] },
      list_tasks: { tool: "notion_query_database", fields: ["database", "filter"] },
      update_task: { tool: "notion_update_page", fields: ["taskId", "properties"] },
    },
  },
  github: {
    name: "GitHub Issues",
    mcpPrefix: "github",
    operations: {
      create_task: { tool: "github_create_issue", fields: ["title", "description", "repo"] },
      list_tasks: { tool: "github_list_issues", fields: ["repo", "state"] },
      update_task: { tool: "github_update_issue", fields: ["taskId", "status", "title"] },
    },
  },
};

// ─── Helpers ───

function detectPlatform(input) {
  const text = `${input.platform ?? ""} ${input.title ?? ""} ${input.description ?? ""}`.toLowerCase();
  if (/\bjira\b/.test(text)) return "jira";
  if (/\blinear\b/.test(text)) return "linear";
  if (/\bnotion\b/.test(text)) return "notion";
  if (/\bgithub\b|\bgh\b/.test(text)) return "github";
  return null;
}

function buildMcpInstructions(platform, operation, input) {
  const config = PLATFORMS[platform];
  if (!config) return null;

  const opConfig = config.operations[operation];
  if (!opConfig) return null;

  const params = {};
  for (const field of opConfig.fields) {
    if (input[field]) params[field] = input[field];
  }

  return {
    platform: config.name,
    suggestedMcpTool: opConfig.tool,
    params,
    note: `Use the MCP tool "${opConfig.tool}" if a ${config.name} MCP server is configured. Otherwise, use web_fetch with the ${config.name} API.`,
  };
}

// ─── Main executor ───

export async function execute(input = {}) {
  const operation = asString(input.operation ?? input.action ?? "list_platforms");
  const title = asString(input.title);
  const description = asString(input.description);
  const platform = asString(input.platform) || detectPlatform(input);

  if (operation === "list_platforms") {
    return {
      summary: "Available project management platforms.",
      nextStep: "Choose a platform and specify an operation (create_task, list_tasks, update_task).",
      details: {
        platforms: Object.entries(PLATFORMS).map(([key, p]) => ({
          id: key,
          name: p.name,
          operations: Object.keys(p.operations),
          mcpRequired: true,
          setupHint: `Configure ${p.name} MCP server via FRIDAY_MCP_SERVERS environment variable.`,
        })),
      },
    };
  }

  if (!platform) {
    return {
      summary: "Platform not specified or detected.",
      nextStep: "Specify a platform: jira, linear, notion, or github.",
      details: {
        operation,
        detectedPlatform: null,
        availablePlatforms: Object.keys(PLATFORMS),
      },
    };
  }

  const mcpInstructions = buildMcpInstructions(platform, operation, input);

  if (!mcpInstructions) {
    return {
      summary: `Operation "${operation}" is not supported for platform "${platform}".`,
      nextStep: `Valid operations: create_task, list_tasks, update_task, list_platforms.`,
      details: { operation, platform },
    };
  }

  return {
    summary: `${mcpInstructions.platform}: ${operation} — ${title ? compact(title, 80) : "ready to execute"}.`,
    nextStep: mcpInstructions.note,
    details: {
      operation,
      platform: mcpInstructions.platform,
      suggestedMcpTool: mcpInstructions.suggestedMcpTool,
      params: mcpInstructions.params,
      title: title || undefined,
      description: description ? compact(description, 200) : undefined,
    },
  };
}
