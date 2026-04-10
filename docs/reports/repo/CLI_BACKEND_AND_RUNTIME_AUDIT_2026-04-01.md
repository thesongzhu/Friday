# CLI Backend And Runtime Audit

Date: 2026-04-01

## Scope

This audit covered:

- `provider/auth/backend matrix`
- `Codex CLI` / `Claude CLI` real Friday execution paths
- `agent/runtime` boundaries for CLI backends
- SQLite migration/bootstrap concurrency
- `scripts/e2e/run-friday-closure.mjs` finalization
- docs/runtime drift where it affected real behavior

The audit used real Friday execution evidence, not only static review.

## Release Summary

### Confirmed facts

- `PR1` remains required because current `main` still defaults `Codex CLI` to `codex`; the separate branch changes that default to `gpt-5.4`.
- `PR2` fixes both originally confirmed engineering gaps:
  - concurrent `attach-cli` startup against the same SQLite state directory
  - closure harness finalization / `completedAt`
- A third high-confidence blocker surfaced during the audit and was fixed in this branch:
  - CLI backends hard-failed inside `/v1/agent/runs` because the agent runtime always exposed Friday tools
  - the boundary is now treated as `text-only backend`, so pure inference works and file/tool tasks refuse honestly instead of 501-failing or bluffing

### Recommendation

- `PR1`: safe to land first once its own checks are green
- `PR2`: safe to land after CI completes; local release gate is green
- Do **not** claim “full tool-capable CLI backend support”
- It is accurate to claim:
  - Friday can use `Codex CLI` and `Claude CLI` as text backends
  - Friday routes tool-using work to HTTP backends, and CLI backends now refuse tool/file tasks honestly

## Evidence

- PR1 Friday CLI smoke:
  - [/path/to/friday/.friday/live-smoke/cli-backend-smoke-2026-04-01T09-01-37-838Z.json](/path/to/friday/.friday/live-smoke/cli-backend-smoke-2026-04-01T09-01-37-838Z.json)
- concurrent `attach-cli` failed before fix:
  - [/path/to/friday/.friday/live-smoke/attach-cli-concurrency-2026-04-01T09-08-28-094Z.json](/path/to/friday/.friday/live-smoke/attach-cli-concurrency-2026-04-01T09-08-28-094Z.json)
- concurrent `attach-cli` passed after migration + startup fix:
  - [/path/to/friday/.friday/live-smoke/attach-cli-concurrency-2026-04-01T09-09-11-666Z.json](/path/to/friday/.friday/live-smoke/attach-cli-concurrency-2026-04-01T09-09-11-666Z.json)
- auth/profile real output:
  - [/path/to/friday/.friday/live-smoke/auth-status-2026-04-01T09-16-37Z.json](/path/to/friday/.friday/live-smoke/auth-status-2026-04-01T09-16-37Z.json)
- closure run that now exits cleanly and writes `completedAt`:
  - [/path/to/friday/.friday/closure/2026-04-01T09-16-52-793Z/ledger.json](/path/to/friday/.friday/closure/2026-04-01T09-16-52-793Z/ledger.json)
- CLI backend agent-route probe before truth-boundary hardening:
  - [/path/to/friday/.friday/live-smoke/cli-agent-route-probe-pretruthfix-2026-04-01T09-20-41Z.json](/path/to/friday/.friday/live-smoke/cli-agent-route-probe-pretruthfix-2026-04-01T09-20-41Z.json)
- CLI backend agent-route probe after truth-boundary hardening:
  - [/path/to/friday/.friday/live-smoke/cli-agent-route-probe-posttruthfix-2026-04-01T09-22-12Z.json](/path/to/friday/.friday/live-smoke/cli-agent-route-probe-posttruthfix-2026-04-01T09-22-12Z.json)

## Confirmed Blockers Fixed

### 1. Concurrent `attach-cli` could fail during SQLite startup

**Confirmed fact**

- Two concurrent `attach-cli` processes against the same state directory could fail in two different ways:
  - `schema_migrations.version` unique constraint collision
  - `SQLITE_BUSY` during startup `journal_mode = WAL`

**Code changes**

- [/path/to/friday/src/state/sqlite/friday-migration-runner.ts](/path/to/friday/src/state/sqlite/friday-migration-runner.ts)
- [/path/to/friday/src/state/sqlite/friday-sqlite-pragmas.ts](/path/to/friday/src/state/sqlite/friday-sqlite-pragmas.ts)
- [/path/to/friday/test/integration/state/sqlite/friday-migration-chain.test.ts](/path/to/friday/test/integration/state/sqlite/friday-migration-chain.test.ts)
- [/path/to/friday/test/unit/state/sqlite/friday-sqlite-layer.test.ts](/path/to/friday/test/unit/state/sqlite/friday-sqlite-layer.test.ts)
- [/path/to/friday/test/integration/state/sqlite/helpers/run-friday-migrations-worker.mjs](/path/to/friday/test/integration/state/sqlite/helpers/run-friday-migrations-worker.mjs)
- [/path/to/friday/test/unit/state/sqlite/helpers/create-sqlite-layer-worker.mjs](/path/to/friday/test/unit/state/sqlite/helpers/create-sqlite-layer-worker.mjs)

**Result**

- The migration pass is now serialized under `BEGIN IMMEDIATE`.
- Startup write pragmas tolerate transient `SQLITE_BUSY` during parallel initialization.
- Real concurrent probe now succeeds.

### 2. Closure harness could leave `completedAt=null`

**Confirmed fact**

- Before the fix, the harness could finish the functional stages but still leave `completedAt` null because cleanup/finalization did not reliably release child handles and writable streams.

**Code changes**

- [/path/to/friday/scripts/e2e/run-friday-closure.mjs](/path/to/friday/scripts/e2e/run-friday-closure.mjs)
- [/path/to/friday/test/unit/e2e/run-friday-closure.test.ts](/path/to/friday/test/unit/e2e/run-friday-closure.test.ts)

**Result**

- The latest closure run exited naturally.
- `completedAt` is now written.
- Local readiness is `GO`.

### 3. CLI backends hard-failed inside `/v1/agent/runs`

**Confirmed fact**

- The first real `/v1/agent/runs` probe with `Codex CLI` showed the provider was considered `routingEligible`, but agent runs failed because `FridayAgentLlmClient` rejected any CLI backend when tools were present.
- In practice, the agent runtime always exposed tools, so even pure inference tasks failed.

**Code changes**

- [/path/to/friday/src/agent/runtime/friday-agent-llm-client.ts](/path/to/friday/src/agent/runtime/friday-agent-llm-client.ts)
- [/path/to/friday/test/unit/agent/runtime/friday-agent-llm-client-cli.test.ts](/path/to/friday/test/unit/agent/runtime/friday-agent-llm-client-cli.test.ts)

**Result**

- CLI backends are now treated as `text-only`.
- Pure inference through `/v1/agent/runs` succeeds.
- Tool/file tasks no longer hard-fail with `501`; instead they refuse honestly and ask for an HTTP backend.

## Layer Findings

### Backend/auth matrix

#### Confirmed facts

- `Codex CLI` and `Claude CLI` both work through Friday’s provider/runtime path for text output.
- `external-session` auth is functioning for CLI backends.
- `auth status` correctly reports:
  - `Codex CLI` healthy
  - `Claude CLI` healthy
  - real account metadata for `Claude CLI`

#### Confirmed non-blocker

- `auth status` still reports Anthropic OAuth providers as `authHealth=status_unknown` and `routingEligible=false` with reason `oauth_requires_token_manager_check`, even though real OAuth-backed runs can work elsewhere.
- This is an operator-surface accuracy issue, not a proven runtime failure in this audit.

### Provider routing and CLI backend boundaries

#### Confirmed facts

- CLI backends are **not** full Friday tool-loop backends.
- `Codex CLI` and `Claude CLI` should currently be understood as `text-only` execution backends.
- A real pre-fix probe showed a worse failure mode:
  - once the model mismatch was removed, the backend could answer a file-reading task without tools and without proof

#### Fix applied

- The runtime boundary message is now explicit:
  - no file access
  - no shell access
  - no web access
  - no live workspace state
  - do not claim tool use

#### Recommendation

- Keep CLI backends as text-only for now.
- Do not market them as general replacements for HTTP/tool-capable providers.

### Runtime / session / workflow / memory

#### Confirmed facts

- World-model markers continue to fire in real runs:
  - `world_model_episode_extracted`
  - `world_model_snapshot_saved`
- The CLI backend boundary fix did not break run completion or post-run world-model hooks.
- Closure remains `GO` after the runtime and SQLite fixes.

### SQLite / bootstrap / migration

#### Confirmed facts

- The migration model is now `whole-pass atomic` rather than `one transaction per migration`.
- One unit test had to be updated because it still asserted the old semantics.
- This is an intentional contract change aligned with the serialization requirement.

### Closure / release / CI path

#### Confirmed facts

- The first post-fix closure run exited cleanly but exposed a real failing unit assertion in `friday-migration-runner.test.ts`.
- That assertion drift was corrected.
- The next closure run completed with:
  - `25 PASS`
  - `0 FAIL`
  - `0 BLOCKER`
  - `repoReady=GO`
  - `productReadyLocal=GO`

### Docs vs runtime

#### Confirmed non-blocker

- `Gemini CLI` is advertised in the capability/catalog surface, but runtime still throws:
  - `Gemini CLI backend is not wired for non-interactive inference yet`
- Relevant source:
  - [/path/to/friday/src/providers/cli/friday-provider-cli-backend.ts](/path/to/friday/src/providers/cli/friday-provider-cli-backend.ts)
  - [/path/to/friday/src/providers/model/friday-provider-capabilities.ts](/path/to/friday/src/providers/model/friday-provider-capabilities.ts)
- This should stay out of the “verified ready” surface until a real non-interactive path exists.

## Confirmed Non-Blockers

- Default provider fallback warning is real and operator-useful:
  - current default provider has no configured fallback
- This does not block the audited branch from release, but it remains a resiliency gap in the user’s local state configuration.

## Inference

- The current architecture is converging toward a correct split:
  - HTTP backends for tool-capable execution
  - CLI backends for text-only consumer-plan execution
- The remaining risk is not that the split is wrong; it is that some operator surfaces still describe CLI backends too loosely.

## Recommendations

- Add an explicit doctor/report field for `textOnlyBackend` or equivalent, so operator surfaces stop implying full agent capability when the backend cannot use Friday tools.
- Downgrade `Gemini CLI` from “ready backend” surfaces until a real non-interactive inference path exists.
- Keep using real Friday-path probes for CLI backends; bare CLI success is not enough to prove Friday integration correctness.
