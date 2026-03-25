# Workspace Context Files

Friday supports a thin workspace-context layer on top of its skills, workflows, and automations.

Use workspace context for repo policy and stable guidance. Use skills for reusable execution. Use automations or workflows for repeated orchestration.

## What Friday Loads Today

The current runtime loads these files fresh on each agent run:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `MEMORY.md`
- `memory/YYYY-MM-DD.md` for the current day
- exported memory items from `.friday/exports/memory/*.json`

Current selection behavior:

- `AGENTS.md` and `SOUL.md` are identity blocks. When present, they are always injected.
- `USER.md`, `MEMORY.md`, daily memory, and exported memory items are candidate blocks. When task-aware filtering is active, Friday selects only the relevant candidates.
- Files are read fresh each run, so edits take effect without restarting the hub.

## Recommended Split

| Layer | Put Here | Avoid Putting Here |
|---|---|---|
| `AGENTS.md` | repo rules, routing defaults, risk boundaries, evidence rules | long SOPs, step-by-step playbooks, reusable business logic |
| `SOUL.md` | style, tone, response discipline, anti-hallucination defaults | repo facts, operational runbooks |
| `USER.md` | maintainer preferences and editing defaults | hard product contract, durable repo truth |
| `MEMORY.md` | durable facts about how this repo works | per-day notes, ephemeral blockers |
| `memory/YYYY-MM-DD.md` | current focus, recent blockers, temporary notes | stable policy or long-term truth |

## Skills vs Workspace Context vs Automations

Use `skills/` when you need:

- reusable execution capability
- structured input and output
- explicit permissions
- validation, install, update, or sharing

Use workspace context when you need:

- repo-level behavior rules
- style defaults
- maintainer preferences
- stable facts or short-lived context that should shape the next run

Use agent automations or workflows when you need:

- repeated execution
- schedules
- a button or template for common operational routines
- orchestration across multiple steps or approval gates

## Friday Repo Defaults

This repository adopts the following pattern:

- `AGENTS.md` acts as a skill router and risk-policy layer.
- `SOUL.md` keeps the repo voice concise, evidence-first, and explicit about uncertainty.
- `USER.md` captures maintainer editing preferences.
- `MEMORY.md` stores durable facts about the repo's extensibility model.
- repeated checks should move to `/v1/agent/automations` or workflows instead of growing the prompt layer

## Good Patterns

Good `AGENTS.md` rules:

- "Prefer `skills_list` before broad freeform work."
- "Use `release-readiness-check` for ship-readiness."
- "Keep destructive actions approval-gated."

Good skill candidates:

- `release-readiness-check`
- `browser-qa-report`
- `browser-qa-fix`
- `implementation-plan-review`
- `security-review`

Good automation candidates:

- daily repo health snapshot
- pre-release readiness check
- browser QA report after UI-heavy changes

Example automation payloads:

```json
{
  "name": "Daily Release Readiness",
  "taskTemplate": "Run release-readiness-check for the current workspace and summarize blockers.",
  "schedule": {
    "type": "cron",
    "cron": "0 9 * * 1-5",
    "timezone": "America/Los_Angeles"
  },
  "enabled": true
}
```

```json
{
  "name": "UI QA Report",
  "taskTemplate": "Run browser-qa-report against the local Friday UI and summarize the most important findings.",
  "enabled": false
}
```

## Guardrails

- Keep `AGENTS.md` short. Treat it as a router, not a knowledge dump.
- Do not duplicate skill SOPs into workspace context.
- Put structured, reusable behavior into skills, not prose.
- Put recurring behavior into automations or workflows, not ever-growing prompts.
- If docs disagree, prefer `docs/current-source-of-truth.md` and current runtime behavior.
