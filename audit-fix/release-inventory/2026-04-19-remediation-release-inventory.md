# 2026-04-19 Remediation Release Inventory

## Current release state

- Worktree: `/Users/jarvis/Projects/Friday/.claude/worktrees/friday-audit-remediation-20260419T085134Z`
- Branch: `codex/audit-remediation-20260419`
- Merge base today: `96e573437500b2e7937cc6e23bad76ff6acddd30` (`main` and `origin/main`)
- `audit-fix/fix-phase-status/phase3.json` is still `in_progress`
- Local truth gates already passing on this tree:
  - `npm run check:audit-integrity`
  - `npm run check:closeout:truth:phase3`
  - `npm run typecheck`

This inventory groups the dirty remediation tree into release bands that can be explained, tested, and committed independently.

## Band 1: Auth, security, and API hardening

- Scope:
  - `src/api/auth/**`
  - `src/api/http/friday-http-{server,error-mapper}.ts`
  - `src/api/http/routes/friday-capability-disabled.ts`
  - `src/api/http/routes/friday-route-idempotency.ts`
  - `src/api/http/routes/friday-health-routes.ts`
  - `src/api/http/routes/friday-channel-routes.ts`
  - `src/api/http/routes/friday-channel-webhook-routes.ts`
  - `src/api/http/routes/friday-mcp-server-routes.ts`
  - `src/api/persistence/friday-api-token-repository.ts`
  - `src/api/runtime/friday-api-runtime.ts`
  - `src/channels/**`
  - `src/errors/**`
  - `src/state/sqlite/migrations/v072-auth-access-token-registry.ts`
  - matching `test/unit/api/**`, `test/contracts/api/**`, `test/unit/channels/**`
- Primary behaviors:
  - truthful token issuance and token-id revocation persistence
  - auth/rate-limit/header behavior stays correct on both success and error paths
  - disabled capabilities return explicit `501 CAPABILITY_DISABLED` instead of dark-route drift
  - channel and webhook surfaces reject unknown or inactive configurations truthfully
  - request idempotency conflict detection is canonicalized and deterministic
- Release risk:
  - login and token breakage
  - error masking or wrong HTTP status on protected routes
  - incompatible route behavior on channel, MCP, and health entrypoints
- Evidence anchors:
  - `audit-fix/post-fix-evidence/issue-00033-rerun/`
  - `audit-fix/post-fix-evidence/issue-00040-rerun/`
  - `audit-fix/post-fix-evidence/issue-00045-rerun/`
  - `audit-fix/post-fix-evidence/issue-00065-rerun/`
  - `audit-fix/post-fix-evidence/issue-00186-rerun/`
- Local verification:
  - `npm run check:audit-integrity`
  - `npm exec vitest run test/unit/api/auth test/unit/api/http test/unit/channels/lark test/contracts/api`

## Band 2: Agent, provider, and skill execution hardening

- Scope:
  - `src/agent/**`
  - `src/providers/services/friday-provider-service.ts`
  - `src/sessions/services/friday-execution-classifier.ts`
  - `src/skills/**`
  - `managed-skills/audit-shell-env-presence-probe/**`
  - `skills/audit-shell-env-presence-probe/**`
  - matching `test/unit/agent/**`, `test/unit/providers/**`, `test/unit/skills/**`, `test/unit/sessions/**`
- Primary behaviors:
  - explicit file-mutation tasks fail terminally when no mutating tool can execute
  - provider routing and invalid-provider handling do not fan into false fallback auth failures
  - agent execution classification no longer short-circuits imperative runs into capability queries
  - shell and node skill executors keep runtime/env behavior truthful without leaking secret values
  - delegation, tool-risk, memory-tool, and subagent profile safety paths match current runtime
- Release risk:
  - silent false-success agent runs
  - provider fallback regressions
  - shell executor trust-boundary mistakes
- Evidence anchors:
  - `audit-fix/post-fix-evidence/issue-00007-file-mutation-terminal-failure-current/`
  - `audit-fix/post-fix-evidence/issue-00018-rerun-current/`
  - `audit-fix/post-fix-evidence/issue-00149-rerun-current/`
  - `audit-fix/post-fix-evidence/cand-20260418-002-rerun-current/`
  - `audit-fix/post-fix-evidence/cand-20260419-013-rerun-current/`
  - `audit-fix/post-fix-evidence/issue-00199-main-rerun-current/`
  - `audit-fix/post-fix-evidence/issue-00200-main-rerun-current/`
- Local verification:
  - `npm exec vitest run test/unit/agent test/unit/providers/services/friday-provider-service.test.ts test/unit/skills test/unit/sessions`

## Band 3: Workflow, memory, and operator HTTP surfaces

- Scope:
  - `src/api/http/routes/friday-agent-routes.ts`
  - `src/api/http/routes/friday-deterministic-pipeline-routes.ts`
  - `src/api/http/routes/friday-memory-routes.ts`
  - `src/api/http/routes/friday-packaging-routes.ts`
  - `src/api/http/routes/friday-skill-generator-routes.ts`
  - `src/api/http/routes/friday-skill-routes.ts`
  - `src/api/http/routes/friday-uix-routes.ts`
  - `src/api/http/routes/friday-workflow-builder-routes.ts`
  - `src/api/http/routes/friday-workflow-run-routes.ts`
  - `src/api/http/routes/friday-tui-routes.ts`
  - `src/api/runtime/friday-deterministic-pipeline-runtime.ts`
  - `src/memory/**`
  - `src/workflows/**`
  - `src/tui/friday-tui-api-client.ts`
  - matching `test/unit/api/http/routes/**`, `test/e2e/api/**`, `test/integration/workflows/**`, `test/unit/workflows/**`, `test/unit/memory/**`, `test/unit/tui/**`
- Primary behaviors:
  - workflow pause/resume and lock persistence are wired to truthful database state
  - rules bundle versioning and workflow validation stop silently dropping state
  - memory remember/learned-fact flows are idempotent and queryable
  - operator/TUI routes expose `/v1/status` and `/v1/jobs` consistently
  - route contracts reflect real workflow, memory, and operator surfaces
- Release risk:
  - broken workflow state transitions
  - duplicate memory extraction
  - missing operator surfaces in production
- Evidence anchors:
  - `audit-fix/post-fix-evidence/blocker-group1-rerun/`
  - `audit-fix/post-fix-evidence/issue-00070-rerun-current/`
  - `audit-fix/post-fix-evidence/cand-20260419-004-main-rerun-current/`
  - `audit-fix/post-fix-evidence/issue-00205-rerun-current/`
  - `audit-fix/post-fix-evidence/heartbeat-main-rerun-current/`
- Local verification:
  - `npm exec vitest run test/unit/workflows test/unit/memory test/unit/tui/friday-tui.test.ts test/e2e/api/friday-api-workflows-routes.test.ts test/e2e/api/friday-api-health-routes.test.ts`

## Band 4: Learning, observability, retry, and state persistence

- Scope:
  - `src/learning/**`
  - `src/observability/**`
  - `src/retry/engine/friday-default-retry-policy.ts`
  - `src/state/sqlite/migrations/v073-observability-audit-trail-persistence.ts`
  - matching `test/unit/learning/**`, `test/unit/observability/**`, `test/integration/state/sqlite/friday-migration-chain.test.ts`
- Primary behaviors:
  - observability audit trail entries and retention checkpoints persist truthfully
  - diagnosis, self-healing, and self-learning flows use stable titles and evidence persistence
  - learned facts can be surfaced as first-class memory search/view data
  - unified retry defaults are explicit instead of implicit
- Release risk:
  - audit trail persistence mismatch
  - diagnosis/self-healing evidence drift
  - migration chain regression on fresh state
- Evidence anchors:
  - `audit-fix/post-fix-evidence/diagnosis-success-run-rerun/`
  - `audit-fix/post-fix-evidence/issue-00085-learning-route-surface-current/`
  - `audit-fix/post-fix-evidence/issue-00086-learned-facts-delete-surface-current/`
  - `audit-fix/post-fix-evidence/cand-20260419-004-main-rerun-current/`
- Local verification:
  - `npm exec vitest run test/unit/learning test/unit/observability test/integration/state/sqlite/friday-migration-chain.test.ts`

## Band 5: CLI, system runtime, desktop, and UI adapters

- Scope:
  - `src/cli/**`
  - `src/system/**`
  - `src/desktop/**`
  - `src/deeplink/**`
  - `src/hub/**`
  - `ui/src/**`
  - `ui/vite.config.ts`
  - `context/MEMORY.md`
  - matching `test/unit/cli/**`, `test/unit/system/**`, `test/unit/desktop/**`, `test/unit/deeplink/**`, `test/unit/hub/**`, `test/unit/ui/**`
- Primary behaviors:
  - `friday run` remote-target behavior is truthful and fail-fast
  - TUI command/help and API/dashboard surfaces stay aligned
  - AppleScript interpolation is escaped and validated
  - guided-flow session continuity and related UI affordances align with current backend behavior
  - settings/plugins/auth UI paths reflect the hardened runtime surfaces
- Release risk:
  - CLI/TUI path drift
  - system helper injection or escaping bugs
  - UI calling stale route shapes
- Evidence anchors:
  - `audit-fix/post-fix-evidence/issue-00048-cli-remote-run-current/`
  - `audit-fix/post-fix-evidence/cross-border-hero-rerun/`
  - `audit-fix/post-fix-evidence/cand-20260419-006-*`
- Local verification:
  - `npm exec vitest run test/unit/cli test/unit/system test/unit/desktop test/unit/deeplink test/unit/hub test/unit/ui`
  - `npm run build:ui`

## Band 6: Audit ledger, evidence, and release bookkeeping

- Scope:
  - `audit-fix/**`
  - this inventory file and any follow-up release-band notes
- Primary behaviors:
  - fix ledger rows, blocker log, regression history, and phase status reflect the shipped source
  - post-fix evidence bundles remain paired with the code and tests they justify
  - closeout truth and release explanations are reproducible from the repo
- Release risk:
  - code merges without matching evidence
  - `phase3` marked done without ledger truth
- Local verification:
  - `npm run check:closeout:truth:phase3`
  - targeted evidence spot checks tied to the touched families above

## Actual commit bundles

The release bands above remain the review structure, but the actual commit boundaries are slightly wider because several shared files cannot be split safely without index-level hunk surgery:

- `src/api/runtime/friday-api-runtime.ts`
- `src/state/sqlite/migrations/index.ts`
- route contract snapshots and a small number of shared UI/system adapters

The shipped commit sequence is therefore:

1. API runtime, auth, route, workflow, memory, and operator surface hardening
2. Agent, provider, and skill execution hardening
3. Learning, observability, retry, system, CLI, desktop, and UI convergence
4. Audit ledger, evidence, release inventory, and phase bookkeeping

This keeps the highest-risk runtime surfaces first, preserves compile-safe intermediate commits, lets the UI and operator layer consume stabilized route shapes, and leaves the ledger/evidence closeout as the last commit so the final repository truth matches the exact shipped tree.
