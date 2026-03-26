# Friday Roadmap Mainline Implementation Tracker

Last updated: 2026-03-25
Worktree: `/Users/jarvis/Projects/Friday-roadmap-mainline`
Branch: `codex/friday-roadmap-mainline`
Base commit: `4d20ee0`

## Batch 0

- Status: completed
- Goal: isolate roadmap implementation from the dirty primary worktree.
- Completed:
  - Created isolated worktree and branch from committed `HEAD`.
  - Verified the new worktree does not inherit uncommitted primary-tree changes.
- Validation:
  - `git -C /Users/jarvis/Projects/Friday-roadmap-mainline status --short --branch`
  - `git -C /Users/jarvis/Projects/Friday-roadmap-mainline rev-parse --short HEAD`
- Rollback:
  - Remove worktree with `git worktree remove /Users/jarvis/Projects/Friday-roadmap-mainline`
  - Delete branch `codex/friday-roadmap-mainline` if the isolation branch is abandoned.

## Batch 1

- Status: completed
- Goal: land the P0 backbone.
- Scope:
  - CLI-first starter skill pack and lifecycle metadata for skills.
  - Built-in subagent profiles.
  - Unified task-profile scaffolding across agent/generator/extraction paths.
- Interface changes:
  - Skill lifecycle summaries expose `originType` and `maturity`.
  - Subagent spawn inputs may specify `profile`.
  - Agent runtime accepts resolved task-profile hints.
- Validation commands:
  - `npm run typecheck`
  - `npx vitest run test/unit/agent/tools/friday-agent-subagent-tools.test.ts test/unit/skills/marketplace/friday-skill-lifecycle-service.test.ts test/unit/skills/generator/llm/friday-provider-inference-client.test.ts test/unit/agent/tools/friday-agent-skills-list-tool.test.ts`
- Resolved blockers:
  - Main agent loop now carries temperature/task-profile hints end to end.
  - Repo and ops starter skills now expose CLI-first catalog tags (`starter.cli`, `cli-backed`, `skill.stabilized`).
- Rollback points:
  - Revert task-profile plumbing without removing new public types.
  - Keep subagent profiles read-only by default if broader write policies regress tests.

## Batch 2

- Status: completed
- Goal: land P1 context governance.
- Scope:
  - Path-scoped workspace rules.
  - Context cost summary surface.
  - MCP server discovery state and lazy search.
- Validation commands:
  - `npm run typecheck`
  - `npx vitest run test/unit/agent/runtime/friday-agent-workspace-context.test.ts test/unit/agent/mcp/friday-mcp-adapter-runtime.test.ts test/unit/agent/tools/friday-agent-mcp-tool.test.ts`
- Rollback points:
  - Keep rule files discoverable but non-injected if path matching proves noisy.
  - Fall back to legacy `list_servers` behavior if MCP state metadata breaks consumers.

## Batch 3

- Status: completed
- Goal: land P2 stabilization skeletons.
- Scope:
  - Preprocessor/hook registry.
  - MCP-vs-CLI recommendation primitives.
  - Stable workflow template catalog.
- Validation commands:
  - `npm run typecheck`
  - `npx vitest run test/unit/agent/runtime/friday-agent-preprocessors.test.ts test/unit/agent/mcp/friday-mcp-cli-recommendation.test.ts test/unit/workflows/friday-stable-workflow-templates.test.ts`
- Rollback points:
  - Keep template registry internal-only if public APIs drift.
  - Leave preprocessors opt-in and disabled by default until evidence flow is fully covered.

## Notes

- This worktree intentionally ignores uncommitted files in `/Users/jarvis/Projects/Friday`.
- The roadmap landed as a backend-first slice in this worktree. Public UI exposure can follow after additional product wiring.
