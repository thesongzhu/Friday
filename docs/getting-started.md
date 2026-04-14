# Getting Started with Friday

This guide walks you through installing Friday, creating your first skill, running it via the CLI, starting the API server, and making API calls.

---

## Prerequisites

- **Node.js ≥ 22** — [nodejs.org](https://nodejs.org/)
- **npm** (bundled with Node.js)
- **bash** + **jq** (for the echo skill example)

Verify your setup:

```bash
node --version   # v22.x.x or higher
npm --version    # 10.x or higher
```

---

## 1. Install Friday

### Option A: From source (recommended)

```bash
git clone https://github.com/thesongzhu/Friday.git
cd Friday
npm install
npm run build

# Run via node directly
node dist/cli/friday-cli.js --help

# Or link globally
npm link
friday --help
```

### Option B: npm global install (when published)

```bash
npm install -g friday
friday --help
```

### Option C: Docker

```bash
cp .env.example .env
# Edit .env — set FRIDAY_TOKEN_SECRET

docker compose up -d
curl http://localhost:3141/v1/health
```

Skip to [Step 4](#4-start-the-api-server) if using Docker — the server starts automatically.

---

## 2. Create Your First Skill

Skills are directories with a `skill.manifest.json` and an entrypoint script.

Create the echo skill:

```bash
mkdir -p skills/echo
```

### skills/echo/skill.manifest.json

```json
{
  "schemaVersion": "2.0",
  "id": "echo",
  "name": "Echo",
  "description": "Echoes back the input message.",
  "version": "1.0.0",
  "kind": "utility",
  "category": "utility",
  "author": { "name": "You" },
  "tags": ["example"],

  "runtime": {
    "kind": "shell",
    "entrypoint": "run.sh",
    "minHubVersion": "0.1.0",
    "apiVersion": "1",
    "timeoutMsDefault": 10000
  },

  "triggers": {
    "intents": ["echo"],
    "phrases": ["echo this"],
    "channels": ["*"]
  },

  "invocation": {
    "userInvocable": true,
    "modelInvocable": true,
    "priority": 50,
    "modes": ["intent"]
  },

  "requirements": {
    "bins": ["bash", "jq"],
    "env": [],
    "config": []
  },

  "input": {
    "schema": {
      "type": "object",
      "properties": {
        "message": { "type": "string", "description": "Message to echo" }
      },
      "required": ["message"]
    }
  },

  "output": {
    "schema": {
      "type": "object",
      "properties": {
        "echo": { "type": "string" }
      }
    }
  },

  "steps": [
    {
      "id": "echo",
      "type": "act",
      "completion": {},
      "transitions": { "onSuccess": null, "onFailure": null }
    }
  ],

  "security": {
    "sandbox": false,
    "network": false,
    "filesystem": "none",
    "permissionPolicy": { "default": "allow", "rules": [] }
  },

  "documentation": {
    "summary": "Echoes the input message.",
    "examples": [
      { "input": { "message": "Hello!" }, "output": { "echo": "Hello!" } }
    ]
  }
}
```

### skills/echo/run.sh

```bash
#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)
MESSAGE=$(echo "$INPUT" | jq -r '.message // "No message"')

echo "{\"echo\": \"$MESSAGE\"}"
```

Make it executable:

```bash
chmod +x skills/echo/run.sh
```

---

## 3. Run via CLI

### List skills

```bash
friday list --skills-dir skills
```

Output:

```
Found 1 skill(s):

ID                            NAME                          KIND            RUNTIME
--------------------------------------------------------------------------------------
echo                          Echo                          utility         shell
```

### Run a skill

```bash
friday run echo --input message="Hello, Friday!" --skills-dir skills
```

Output:

```
Run <run-id> — success (42ms)

--- output ---
{
  "echo": "Hello, Friday!"
}
```

---

## 4. Start the API Server

```bash
friday start --skills-dir skills --port 3141
```

You'll see:

```
🚀 Friday hub running — 1 skill(s) loaded
🚀 Friday API server listening on http://0.0.0.0:3141
```

The server keeps running. Press `Ctrl+C` for graceful shutdown.

---

## 5. Make API Calls

### Health check

```bash
curl http://localhost:3141/v1/health
```

```json
{
  "ok": true,
  "data": {
    "status": "ok",
    "version": "0.3.0",
    "uptime": 5
  },
  "requestId": "abc-123"
}
```

### Authenticate

```bash
curl -X POST http://localhost:3141/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{}'
```

Save the `accessToken` from the response:

```bash
export TOKEN="<your-access-token>"
```

### List providers

```bash
curl http://localhost:3141/v1/providers \
  -H "Authorization: Bearer $TOKEN"
```

### Register a provider (BYOK)

```bash
curl -X POST http://localhost:3141/v1/providers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "openai",
    "label": "My OpenAI",
    "apiId": "openai-completions",
    "authMode": "api-key",
    "credential": "sk-..."
  }'
```

### Create a workflow

```bash
curl -X POST http://localhost:3141/v1/workflows \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "hello-workflow",
    "name": "Hello Workflow",
    "graph": {
      "schemaVersion": "2.0",
      "workflowId": "placeholder",
      "workflowVersionId": "placeholder",
      "sourceSpecSchemaVersion": "1.0",
      "graph": {
        "nodes": [
          { "id": "trigger", "type": "trigger", "label": "Start", "config": {} },
          { "id": "echo", "type": "action", "label": "Echo", "config": { "skillId": "echo" } }
        ],
        "edges": [
          { "id": "e1", "sourceNodeId": "trigger", "targetNodeId": "echo" }
        ]
      },
      "failurePolicy": { "onFailure": "fail_fast", "notifyUser": false },
      "tests": [],
      "checksum": "placeholder"
    }
  }'
```

---

## 6. Import an External Skill

Friday can auto-detect and convert skills from multiple formats:

```bash
# Import a native Friday skill package
friday import ./path/to/my-skill.friday.tgz

# Import from a Clawdbot SKILL.md
friday import ./some-dir/SKILL.md --from clawdbot-skill-md

# Import an OpenAI GPT Action (OpenAPI spec)
friday import ./openapi.json --from openai-gpt-action

# Preview without installing
friday import ./openapi.json --from openai-gpt-action --dry-run

# List available converters
friday converters
```

### Supported source formats

| Format | Description |
|---|---|
| `friday-package` | Native Friday `.friday.tgz` archive |
| `clawdbot-skill-md` | Clawdbot `SKILL.md` files |
| `n8n-node` | n8n community node packages |
| `openai-gpt-action` | OpenAI GPT Action (OpenAPI 3.x spec) |

---

## 7. Create a Workflow

Workflows connect skills into multi-step automations with triggers, approvals, and branching.

### Via API

See Step 5 above for the API call.

### Workflow concepts

- **Versions** — Each edit creates a new version. Publish a version to make it active.
- **Triggers** — Start workflows via API call, webhook, schedule (cron), or event.
- **Approval nodes** — Pause execution until a human approves or rejects.
- **Retry policies** — Configure retry counts and backoff per node.

```bash
# Start a workflow run
curl -X POST http://localhost:3141/v1/workflow-runs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "workflowId": "<workflow-id>",
    "triggerType": "manual",
    "triggerPayload": { "message": "Hello from workflow!" }
  }'

# Check run status
curl http://localhost:3141/v1/workflow-runs/<run-id> \
  -H "Authorization: Bearer $TOKEN"
```

---

## 8. Use Agent Runs and Scheduled Automations

Friday also exposes a chat-style agent runtime and reusable automations.

### Start an agent run

```bash
curl -X POST http://localhost:3141/v1/agent/runs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Analyze this repo and propose a fix plan",
    "constraints": { "readOnly": true }
  }'
```

### Create a scheduled automation (cron)

```bash
curl -X POST http://localhost:3141/v1/agent/automations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Weekday Health Check",
    "taskTemplate": "Run Friday health checks and summarize critical issues",
    "schedule": {
      "type": "cron",
      "cron": "0 9 * * 1-5",
      "timezone": "America/New_York"
    },
    "enabled": true
  }'
```

### Update or clear automation schedule

```bash
# Update schedule
curl -X PATCH http://localhost:3141/v1/agent/automations/<automation-id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "schedule": {
      "type": "cron",
      "cron": "*/30 * * * *",
      "timezone": "UTC"
    }
  }'

# Clear schedule (manual runs only)
curl -X PATCH http://localhost:3141/v1/agent/automations/<automation-id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"schedule": null}'
```

### Execute an automation immediately

```bash
curl -X POST http://localhost:3141/v1/agent/automations/<automation-id>/run \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

---

## 9. Local Web UI Setup (No Sign-In Mode)

If you run Friday locally, you can use the setup wizard and agent workspace in browser.

### Start server and open UI

```bash
friday start --skills-dir skills --port 3141
open http://localhost:3141
```

### Complete setup wizard

1. Configure at least one model provider in **Providers**.
2. Select channels in **Connect Your Channels**.
3. Click **Open Friday** after setup status is marked complete.

### Agent workspace highlights

- **Conversation-first UI**: chat with Friday directly.
- **Command buttons**: one-click run for task/workflow/skill/health actions.
- **Task Controls**: set schedule/data/workflow context before runs.
- **Live Run Monitor**: view progress, tool usage, sub-agents, and trace/audit summary.
- **Save as Automation**: persist successful runs and optionally assign cron schedule.

---

## Next Steps

- **Environment variables** — See [.env.example](../.env.example) for all `FRIDAY_*` configuration.
- **Docker** — See [docker-compose.yml](../docker/docker-compose.yml) for containerized deployment.
- **Style guide** — See [friday-style-guide.md](friday-style-guide.md) for contribution conventions.
- **Recent changes** — See [CHANGELOG.md](CHANGELOG.md) for latest updates.
- **Production** — See [README.md](../README.md#production-notes) for hardening tips.

---

## Troubleshooting

### "No skills found"

Make sure `--skills-dir` points to a directory containing subdirectories with `skill.manifest.json` files.

```bash
ls skills/echo/skill.manifest.json  # Should exist
friday list --skills-dir skills
```

### Port already in use

```bash
friday start --port 4000  # Use a different port
# Or set FRIDAY_PORT=4000 in .env
```

### Token secret warning

```
⚠️  Using default token secret. Set FRIDAY_TOKEN_SECRET for production.
```

Set the environment variable:

```bash
export FRIDAY_TOKEN_SECRET=$(openssl rand -hex 32)
friday start
```

### Type errors during development

```bash
npx tsc --noEmit  # Should show 0 errors
```

The project uses strict TypeScript with zero `as any` — all types are explicit.
