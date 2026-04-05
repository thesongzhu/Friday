# Friday Agent Orchestration Rollout

This runbook defines the safe enablement order for the agent orchestration changes introduced in April 2026.

## Scope

The rollout covers two guarded runtime behaviors:

- `FRIDAY_AGENT_ENFORCE_STARTER_SKILL_ROUTING`
- `FRIDAY_SUBAGENT_FORK_MODE_ENABLED`

Both flags default to off. The MCP readiness and skill blocker surfaces ship safely before either flag is enabled.

## Enablement order

1. Phase 1: ship readiness and blocker visibility with both flags unset or explicitly `false`.
2. Phase 2: enable `FRIDAY_AGENT_ENFORCE_STARTER_SKILL_ROUTING=true` while keeping `FRIDAY_SUBAGENT_FORK_MODE_ENABLED=false`.
3. Phase 3: enable `FRIDAY_SUBAGENT_FORK_MODE_ENABLED=true` only after phase 2 has passed in the target environment.

Do not enable subagent fork mode before starter-skill routing enforcement is already stable.

## Acceptance commands

Use these commands in order:

1. `npm run check:agent-rollout:phase1`
2. `npm run check:agent-rollout:phase2`
3. `npm run check:agent-rollout:phase3`

For a single full pass across all three phases plus typecheck:

- `npm run check:agent-rollout:full`

## What each phase proves

### Phase 1

- Skill manifests accept `requirements.mcpServers`.
- `capabilities` exposes deterministic MCP server readiness.
- `skills_list` exposes `ready`, `blockers`, and `requirements`.
- `skill_run` fails closed when required MCP readiness is not met.

### Phase 2

- The runtime can force a one-shot retry when a high-confidence request should check an installed starter skill first.
- The stronger starter-skill routing language is only exposed when the rollout flag is enabled.

### Phase 3

- `spawn_subagent` can explicitly expose `mode="fork"` and fork metadata.
- Fork-mode subagents persist `mode`, `forkedFromMessageId`, and `inheritedMessageCount`.
- Session-fork-based subagent spawning and migration coverage both pass.

## Rollback order

Rollback in reverse order:

1. Disable `FRIDAY_SUBAGENT_FORK_MODE_ENABLED`.
2. Verify phase 2 behavior still passes.
3. Disable `FRIDAY_AGENT_ENFORCE_STARTER_SKILL_ROUTING`.

If only phase 3 is unstable, do not roll back the phase 1 MCP readiness surfaces.
