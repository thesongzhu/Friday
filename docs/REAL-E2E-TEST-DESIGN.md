# Real Scenario E2E Test Design — CX (gpt-5.3-codex)
> Date: 2026-02-19 | 10 scenarios with real Ollama LLM calls

## Preconditions
- No `POST /v1/sessions/:key/run` route exists — use AI workflow nodes or agent runs instead
- Agent runtime currently ignores `model/providerId` params in some paths
- Local Ollama with `llama3.2:3b` (fast) and `qwen2.5-coder:7b` (code)

## Env Gates
```
E2E_REAL=1
E2E_OLLAMA=1
E2E_OLLAMA_BASE_URL=http://127.0.0.1:11434
E2E_FAST_MODEL=llama3.2:3b
E2E_CODE_MODEL=qwen2.5-coder:7b
```

## File Structure
```
test/e2e/live/friday-real-journeys.e2e.test.ts
test/e2e/live/friday-cloud-journeys.e2e.test.ts
test/e2e/live/_helpers/real-env.ts
test/e2e/live/_helpers/cloud-env.ts
test/e2e/live/_helpers/api.ts
test/e2e/live/_helpers/workflow.ts
test/e2e/live/_helpers/skill.ts
test/e2e/live/_helpers/poll.ts
```

## Target Modes

- `FRIDAY_E2E_TARGET=local` (default)
  - Runs `friday-real-journeys.e2e.test.ts` against an in-process temporary hub.
- `FRIDAY_E2E_TARGET=cloud`
  - Runs `friday-cloud-journeys.e2e.test.ts` against a deployed cloud base URL.
  - Requires cloud auth env contract (`FRIDAY_E2E_CLOUD_*`).

## Shared Helpers
- `createRealHubEnv()` — fresh hub/server/temp dir + auth token
- `ensureOllamaProviders()` — create fast+code providers + routing
- `createPublishRunWorkflow(graph)` + `pollRunTerminal(runId)`
- `runAiPing({prompt, model?})` — ephemeral workflow AI-node run
- `startSkillGenAndApprove(goal, model)` — with retry on 422
- `cleanupTempDirs()` in afterAll

## Scenarios

### 1. First-Time User Journey (45s, llama3.2:3b)
Setup wizard → Ollama provider → network → channels → complete → verify needsSetup=false

### 2. Skill Generation (120s, qwen2.5-coder:7b)
Generator session → generate → approve → verify in registry → use in workflow

### 3. Skill Import (45s, llama3.2:3b)
OpenClaw SKILL.md → convert (dry run) → import → verify skillId

### 4. Workflow Creation (180s, qwen2.5-coder:7b)
Generator → generate → approve → publish → trigger → poll → verify nodes

### 5. Agent Conversation + Memory (120s, llama3.2:3b)
Session → message → agent run → memory extract → search → verify facts

### 6. Self-Diagnosis (90s, qwen2.5-coder:7b)
Bad workflow → compile → validation errors → agent diagnosis

### 7. Automation Lifecycle (90s, llama3.2:3b)
Create → enable → run → disable → verify disabled → re-enable → run

### 8. Provider Failover (120s, llama3.2:3b)
Bad primary + good fallback → routing → run → verify fallback used

### 9. Memory Persistence (120s, llama3.2:3b)
Session A facts → extract → Session B → search → verify cross-session

### 10. Workflow with Skill Nodes (180s, qwen2.5-coder:7b)
Generate skill → create workflow using skill → publish → run → verify output

## Estimated Total Runtime
~14-22 minutes on local Ollama
