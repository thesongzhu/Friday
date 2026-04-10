# Friday Self-Evolution Live Audit

- Date: 2026-04-01T21:33:34.196Z
- Repo: /path/to/friday
- Artifact root: /path/to/friday/.friday/live-audit/2026-04-01T21-33-34-196Z
- Isolated state dir: /path/to/friday/.friday/live-audit/2026-04-01T21-33-34-196Z/state

## Confirmed facts

- OpenAI HTTP live: executed via Friday /v1/agent/runs against https://api.openai.com
- Codex CLI backend live: executed via Friday providerService + CLI backend text path using model gpt-5.4
- Claude CLI backend live: executed via Friday providerService + CLI backend text path using model claude-sonnet-4-20250514
- Ollama local live: executed via Friday /v1/agent/runs against http://127.0.0.1:11434 with model llama3.2:3b
- learned_lessons: 1
- friday_learned_patterns: 1
- incidents: 4
- diagnoses: 4
- auto_fix_actions: 3

## Live matrix summary

- OpenAI repeat run 1: completed via 72ad6d75-9952-4822-83af-0b9b417f9214
- OpenAI repeat run 2: completed via 72ad6d75-9952-4822-83af-0b9b417f9214
- OpenAI tool run: completed
- Codex CLI doctor: healthy/healthy
- Claude CLI doctor: healthy/healthy
- Ollama local run: completed

## Learning loop

- Manual resolve incident: 934adf87-3380-49d7-ba3d-3acd95a23d08
- Manual resolve matchedLessonIds: ["9593832a-9f46-4191-9fce-fd505cd0a1e6"]
- Auto-fix incident: 54b60ed6-e910-4e21-8a16-807dc88b56a6
- Auto-fix action status/outcome: applied / failed
- Routing explain learningAdjusted after repeated runs: false

## Blocker matrix

- gemini-cli: gemini binary is not installed in the current environment
- docker-smoke: docker is not installed in the current environment
- cloud-live: cloud live contract variables are not part of this isolated local audit
- china-vendors-live: No China vendor credentials were configured for this isolated local audit

## Findings

- [P1] Confirmed non-blocker — Provider / Routing / Backend matrix: Historical outcome bias did not visibly reorder routing toward the successful fallback provider (evidence: /path/to/friday/.friday/live-audit/2026-04-01T21-33-34-196Z/routing-explain-cli-text.json, /path/to/friday/.friday/live-audit/2026-04-01T21-33-34-196Z/learning-overview.json)

## Layer audit summary

- Auth / Setup / RBAC: local login and provider/admin APIs were exercised over the real HTTP stack.
- Provider / Routing / Backend / Auth matrix: OpenAI HTTP, Codex CLI, Claude CLI, and Ollama local were all checked through Friday-owned paths when available.
- Agent runtime / Subagent / Tool loop: main /v1/agent/runs remained native-tools-first; CLI backends stayed text-only and were excluded when requiresNativeTools=true.
- Sessions / Memory / World model: repeat runs, incident learning, lesson extraction, and pattern extraction were checked against the isolated SQLite state.
- Workflow / Approval / Automation / Self-healing: manual resolve and low-risk auto-fix execution were exercised via real diagnosis/auto-fix surfaces plus the live self-healing service path.
- Realtime / Channels / UIX / Observability: not fully live-dogfooded in this script; see blocker and recommendation sections for remaining operator-surface gaps.
- Marketplace / Skills / Plugins: covered only by existing suite expectations in this run; no new product-surface mutations were introduced here.
- Bootstrap / SQLite / Release harness: isolated hub bootstrap, SQLite state creation, and report artifacts were exercised directly; closure remains separately covered by npm run test:e2e:closure:local.

## Evidence

- Matrix JSON: /path/to/friday/docs/reports/repo/SELF_EVOLUTION_LIVE_AUDIT_MATRIX_2026-04-01.json
- Findings JSON: /path/to/friday/docs/reports/repo/SELF_EVOLUTION_LIVE_AUDIT_FINDINGS_2026-04-01.json
- Provider doctors: /path/to/friday/.friday/live-audit/2026-04-01T21-33-34-196Z/provider-doctors.json
- Routing explain: /path/to/friday/.friday/live-audit/2026-04-01T21-33-34-196Z/routing-explain-cli-text.json
- Learning overview: /path/to/friday/.friday/live-audit/2026-04-01T21-33-34-196Z/learning-overview.json
- Agent run events: /path/to/friday/.friday/live-audit/2026-04-01T21-33-34-196Z/agent-run-events.json
