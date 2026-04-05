# Project Management Hub

Unified interface for project management tools. Supports Jira, Linear, Notion, and GitHub Issues through MCP integrations.

## Operations

- `list_platforms` — Show available platforms and setup instructions
- `create_task` — Create a new task/issue
- `list_tasks` — List tasks from a platform
- `update_task` — Update task status or details

## Setup

Configure the relevant MCP server(s) via the `FRIDAY_MCP_SERVERS` environment variable. For example:

```
FRIDAY_MCP_SERVERS='{"jira": {"command": "npx", "args": ["-y", "@anthropic/jira-mcp"]}}'
```

## Supported Platforms

| Platform | MCP Server | Features |
|----------|-----------|----------|
| Jira | `@anthropic/jira-mcp` | Issues, search, transitions |
| Linear | `@anthropic/linear-mcp` | Issues, teams, cycles |
| Notion | `@anthropic/notion-mcp` | Pages, databases, properties |
| GitHub | Built-in | Issues, labels, milestones |
