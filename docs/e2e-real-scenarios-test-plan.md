> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Friday Real User Scenario E2E Test Plan

> **Goal:** Test every major user journey through Friday end-to-end using real Anthropic Claude API calls, verifying the product works as a user would actually experience it.
>
> **Complements:** `docs/e2e-full-smoke-test-plan.md` (100 CRUD route-wiring tests). This plan focuses on **multi-step user stories**, not individual API calls.
>
> **Test file:** `test/e2e/friday-real-scenarios-e2e.test.ts`
>
> **Gating:** `FRIDAY_LLM_E2E` env var + `FRIDAY_ANTHROPIC_OAUTH_ACCESS_TOKEN` (or refresh token).
>
> **Estimated cost:** ~15-25 LLM calls per full run, ~$0.50-1.50 with claude-sonnet-4-20250514.
>
> **Estimated time:** 3-8 minutes (LLM latency dominates).

---

## Table of Contents

1. [Test Infrastructure](#1-test-infrastructure)
2. [Scenario 1: User Generates and Runs a Skill](#scenario-1-user-generates-and-runs-a-skill)
3. [Scenario 2: User Generates and Runs a Workflow](#scenario-2-user-generates-and-runs-a-workflow)
4. [Scenario 3: Workflow with AI Inference Node](#scenario-3-workflow-with-ai-inference-node)
5. [Scenario 4: Session with Memory Extraction](#scenario-4-session-with-memory-extraction)
6. [Scenario 5: Session Fork and Merge](#scenario-5-session-fork-and-merge)
7. [Scenario 6: Skill Converter Imports a Skill](#scenario-6-skill-converter-imports-a-skill)
8. [Scenario 7: Full Workflow Lifecycle with Builder](#scenario-7-full-workflow-lifecycle-with-builder)
9. [Scenario 8: Memory Store → Search → Recall Cycle](#scenario-8-memory-store--search--recall-cycle)
10. [Scenario 9: Workflow with Condition Branching](#scenario-9-workflow-with-condition-branching)
11. [Scenario 10: Workflow Approval Gate](#scenario-10-workflow-approval-gate)
12. [Scenario 11: Skill Generation with Conversation](#scenario-11-skill-generation-with-conversation)
13. [Scenario 12: End-to-End CLI Simulation](#scenario-12-end-to-end-cli-simulation)
14. [Scenario 13: Realtime Event Subscription During Workflow Run](#scenario-13-realtime-event-subscription-during-workflow-run)
15. [Dependency Map](#dependency-map)
16. [What's NOT Testable](#whats-not-testable)

---

## 1. Test Infrastructure

### Setup (identical to existing `friday-llm-e2e.test.ts`)

```ts
beforeAll:
  1. createFridayHub({ stateDir: tmpDir, skillDirs: [testSkillDir], port: 0 })
  2. hub.start()
  3. createFridayHttpServer({ routes, wsGateway, middleware, port: freePort })
  4. httpServer.listen()
  5. POST /v1/auth/login { local: true } → save accessToken
  6. Create Anthropic provider (oauth mode, validateOnSave: false)
  7. PUT /v1/model-routing → set default provider
  8. Seed OAuth credentials via credential store
  9. Create test skill fixture directory with a minimal echo skill

afterAll:
  httpServer.close(), hub.stop(), rm tmpDir
```

### Test Skill Fixture

Create a minimal test skill in `testSkillDir/echo-test/`:

```
echo-test/
├── skill.manifest.json   # { id: "echo-test", runtime: { kind: "shell", entrypoint: "run.sh" }, ... }
└── run.sh                # #!/bin/bash\necho '{"echoed": true}'
```

This gives us a pre-existing skill for workflow action nodes.

### Shared State

Tests share the hub instance and accumulate state across scenarios. Each scenario is a `describe` block with sequential `it` calls. Scenarios are independent — any one can fail without blocking others.

### Timeouts

| Category | Timeout |
|----------|---------|
| Single LLM call | 30s |
| Multi-LLM generation pipeline (3-4 calls) | 120s |
| Full scenario (multiple LLM calls) | 180s |
| Non-LLM steps | 10s |
| `beforeAll` setup | 60s |

---

## Scenario 1: User Generates and Runs a Skill

**User story:** "I want to create a skill that gives me the current date, without writing any code."

**LLM calls:** 4-6 (requirements analyzer + manifest + code + UI schema, possibly repair)

### Steps

| Step | Action | Method | Path | Body | Assert | LLM? |
|------|--------|--------|------|------|--------|------|
| 1.1 | Start skill generation session | `POST` | `/v1/skills/generator/sessions` | `{ goal: "Create a shell skill that outputs the current date in ISO format", userId: "admin-001", channel: "e2e", requestedModel: MODEL }` | `status: 200`, `session.sessionId` exists, `mode` is `"clarification_required"` or `"preview_ready"` | ✅ ~5s |
| 1.2 | If clarification needed, answer | `POST` | `/v1/skills/generator/sessions/:sessionId/messages` | `{ message: "A shell skill using the date command. No inputs needed. Output the ISO 8601 date string.", requestedModel: MODEL }` | `status: 200`, `mode` transitions | ✅ ~5s |
| 1.3 | Force generation | `POST` | `/v1/skills/generator/sessions/:sessionId/generate` | `{ requestedModel: MODEL }` | `status: 200` or `422`, if 200: `draft.manifest.id` exists, `draft.files.length > 0`, `draft.validation.ok === true` | ✅ ~30s |
| 1.4 | Verify session state | `GET` | `/v1/skills/generator/sessions/:sessionId` | — | `session.status === "ready_for_review"`, `draft` present, `turns.length >= 2` | ❌ |
| 1.5 | Approve and save to disk | `POST` | `/v1/skills/generator/sessions/:sessionId/approve` | — | `status: 200`, `skillId` returned, `savedFiles` includes `skill.manifest.json`, `registryRefreshed: true` | ❌ |
| 1.6 | Verify skill is in registry | `GET` | `/v1/skills/:skillId/ui` | — | `status: 200`, UI schema returned with `fields`, `outputs`, `actions` arrays | ❌ |
| 1.7 | Run the generated skill via hub executor | *(internal call)* | `hub.executor.execute({ skillId, input: {}, sessionId: "e2e", userId: "e2e", channel: "e2e" })` | — | `result.status === "completed"`, `result.stdout` or `result.output` contains date-like string | ❌ |
| 1.8 | Verify session is saved | `GET` | `/v1/skills/generator/sessions/:sessionId` | — | `session.status === "saved"` | ❌ |

### What Could Go Wrong

| Failure Mode | Likelihood | Mitigation |
|-------------|-----------|------------|
| LLM returns malformed manifest JSON | Medium | Generator has repair loop (MAX_REPAIR_ATTEMPTS=2). Accept 422 gracefully. |
| Generated shell script fails to execute | Medium | Skip step 1.7 assertion on output content; just verify `status !== "failed"`. The script may not work on all platforms. |
| Session enters "failed" state after generation | Low-Medium | Check session status before approve. If failed, verify error structure and skip approval. |
| Skill directory collision | Low | Each test run uses a fresh tmpDir. |
| LLM asks too many clarification rounds | Low | Step 1.3 force-generates regardless of conversation state. |

### ClawdBot Reference

ClawdBot has skill definitions in `skill.md` files under workspace dirs (see `clawdbot/src/agents/skills-install.ts`, `clawdbot/src/agents/skills-status.ts`). Friday's converter can import these — tested in Scenario 6.

---

## Scenario 2: User Generates and Runs a Workflow

**User story:** "I want an automated workflow that triggers manually, logs a message, and completes."

**LLM calls:** 5-8 (requirements + spec + visual + tests, possibly repair)

### Steps

| Step | Action | Method | Path | Body | Assert | LLM? |
|------|--------|--------|------|------|--------|------|
| 2.1 | Start workflow generation session | `POST` | `/v1/workflows/generator/sessions` | `{ goal: "A simple manual trigger workflow with one log action that says hello world", userId: "admin-001", channel: "e2e", requestedModel: MODEL }` | `status: 200`, `session.sessionId` exists | ✅ ~5s |
| 2.2 | If clarification needed, answer | `POST` | `/v1/workflows/generator/sessions/:sessionId/messages` | `{ message: "Manual trigger, single log node that outputs 'hello world'. No conditions or branching.", requestedModel: MODEL }` | `status: 200` | ✅ ~5s |
| 2.3 | Force generation | `POST` | `/v1/workflows/generator/sessions/:sessionId/generate` | `{ requestedModel: MODEL }` | `status: 200`, `draft.spec` exists, `draft.visual` exists, `draft.compiledGraph` exists, `draft.validation.ok === true` | ✅ ~45s |
| 2.4 | Verify draft structure | — | — | — | `compiledGraph.graph.nodes.length >= 2` (trigger + action), `compiledGraph.graph.edges.length >= 1` | ❌ |
| 2.5 | Approve and save | `POST` | `/v1/workflows/generator/sessions/:sessionId/approve` | — | `status: 200`, `workflowId` returned, `published: true`, `slug` exists | ❌ |
| 2.6 | Verify workflow exists | `GET` | `/v1/workflows/:workflowId` | — | `status: 200`, `workflow.slug` matches, `publishedVersion` not null | ❌ |
| 2.7 | Start a run | `POST` | `/v1/workflow-runs` | `{ workflowId, triggerType: "manual", triggerPayload: {} }` | `status: 200`, `run.id` exists, `run.status` is `"pending"` or `"running"` or `"completed"` | ❌ |
| 2.8 | Poll run until terminal | `GET` | `/v1/workflow-runs/:runId` | — (poll every 500ms, max 15s) | `run.status === "completed"` | ❌ |
| 2.9 | Verify run nodes | `GET` | `/v1/workflow-runs/:runId/nodes` | — | `items.length >= 2`, all nodes have `status === "completed"` | ❌ |
| 2.10 | Verify run timeline | `GET` | `/v1/workflow-runs/:runId/timeline` | — | `items.length > 0`, includes start and complete events | ❌ |

### What Could Go Wrong

| Failure Mode | Likelihood | Mitigation |
|-------------|-----------|------------|
| Generated graph fails validation | Medium | Generator has repair loop. If all retries fail, accept 422 and skip rest. |
| Workflow engine fails to execute a generated node type | Medium | Generated workflows may use node types not in the engine. The node executor supports: `trigger`, `action`, `condition`, `data`, `ai`, `approval`. Verify the generated graph only uses these. |
| Run never reaches terminal state | Low | Poll with timeout, then force-cancel and verify cancel works. |
| Slug collision | Low | Generator uses `makeUniqueSlug()` with counter and fallback random ID. |

### ClawdBot Reference

ClawdBot doesn't have workflows. This is a Friday-only feature.

---

## Scenario 3: Workflow with AI Inference Node

**User story:** "I want a workflow that triggers manually, sends a prompt to Claude, and stores the result."

**LLM calls:** 1 (the AI inference node execution) + 0 (workflow is manually constructed)

### Steps

This scenario bypasses the generator and directly constructs a workflow with an `ai` node type, then runs it with real LLM.

| Step | Action | Method | Path | Body | Assert | LLM? |
|------|--------|--------|------|------|--------|------|
| 3.1 | Create workflow with AI node graph | `POST` | `/v1/workflows` | See [Graph Fixture A](#graph-fixture-a-ai-inference) | `status: 200`, `workflow.id` exists | ❌ |
| 3.2 | Publish version | `POST` | `/v1/workflows/:id/publish` | `{ versionNumber: 1 }` | `status: 200` | ❌ |
| 3.3 | Start run | `POST` | `/v1/workflow-runs` | `{ workflowId, triggerType: "manual", triggerPayload: { topic: "the weather" } }` | `status: 200`, `run.id` exists | ❌ |
| 3.4 | Poll until terminal | `GET` | `/v1/workflow-runs/:runId` | — (poll every 1s, max 30s) | `run.status === "completed"` | ✅ ~10s (during engine execution) |
| 3.5 | Verify run nodes | `GET` | `/v1/workflow-runs/:runId/nodes` | — | Trigger node completed, AI node completed, output node completed | ❌ |
| 3.6 | Verify AI node produced output | — | — | — | AI node's output data contains a non-empty string response from Claude | ❌ |

#### Graph Fixture A: AI Inference

```json
{
  "schemaVersion": "2.0",
  "workflowId": "ai-workflow-test",
  "workflowVersionId": "<generated>",
  "sourceSpecSchemaVersion": "1.0",
  "graph": {
    "nodes": [
      {
        "id": "trigger-1",
        "type": "trigger",
        "label": "Manual Trigger",
        "config": { "triggerType": "manual" }
      },
      {
        "id": "ai-1",
        "type": "ai",
        "label": "Ask Claude",
        "config": {
          "prompt": "Say hello and tell me one interesting fact about $inputs.topic. Keep it under 50 words.",
          "model": "claude-sonnet-4-20250514"
        }
      },
      {
        "id": "data-1",
        "type": "data",
        "label": "Collect Result",
        "config": {
          "mapping": {
            "aiResponse": "$nodes.ai-1.output"
          }
        }
      }
    ],
    "edges": [
      { "id": "e1", "sourceNodeId": "trigger-1", "targetNodeId": "ai-1" },
      { "id": "e2", "sourceNodeId": "ai-1", "targetNodeId": "data-1" }
    ]
  },
  "failurePolicy": { "onFailure": "fail_fast" },
  "tests": [],
  "checksum": "<computed>"
}
```

**Important:** The `ai` node type invokes `deps.invokeSkill("ai-inference", ...)` which routes through the provider service → real Anthropic API call. This is the key test — verifying the full provider → LLM → workflow result propagation path.

### What Could Go Wrong

| Failure Mode | Likelihood | Mitigation |
|-------------|-----------|------------|
| AI inference skill not wired in executor | Low | The skill executor has explicit `ai-inference` shortcut routing. |
| Expression `$inputs.topic` not resolved | Medium | Depends on how `triggerPayload` maps to `inputs` in the expression context. Test with a simple prompt that doesn't need interpolation as fallback. |
| Provider credential not found for ai node | Low | Same OAuth credentials seeded in beforeAll. |
| AI node timeout | Low | Use generous timeout (30s). Claude responds in 2-5s typically. |

---

## Scenario 4: Session with Memory Extraction

**User story:** "I have a conversation, and I want Friday to extract and remember key facts from it."

**LLM calls:** 1-2 (memory extraction LLM call)

### Steps

| Step | Action | Method | Path | Body | Assert | LLM? |
|------|--------|--------|------|------|--------|------|
| 4.1 | Create session | `POST` | `/v1/sessions` | `{ channel: "e2e", chatId: "memory-test-1" }` | `status: 200`, `session.key` exists, `session.status === "active"` | ❌ |
| 4.2 | Add user message | `POST` | `/v1/sessions/:key/messages` | `{ role: "user", content: "My favorite programming language is Rust and I've been using it for 3 years" }` | `status: 200`, `message.id` exists | ❌ |
| 4.3 | Add assistant response | `POST` | `/v1/sessions/:key/messages` | `{ role: "assistant", content: "That's great! Rust is known for its memory safety. What projects have you built with it?" }` | `status: 200` | ❌ |
| 4.4 | Add user message | `POST` | `/v1/sessions/:key/messages` | `{ role: "user", content: "I built a web server and a CLI tool. I also love cooking Italian food on weekends." }` | `status: 200` | ❌ |
| 4.5 | Add assistant response | `POST` | `/v1/sessions/:key/messages` | `{ role: "assistant", content: "Nice combo of hobbies! Both Rust programming and Italian cooking require precision." }` | `status: 200` | ❌ |
| 4.6 | Trigger memory extraction (inline mode) | `POST` | `/v1/sessions/:key/memory/extract` | `{ trigger: "manual", mode: "inline" }` | `status: 200`, `result.extractedCount > 0` | ✅ ~10s |
| 4.7 | Check extraction status | `GET` | `/v1/sessions/:key/memory/extraction` | — | `status: 200`, extraction metadata present | ❌ |
| 4.8 | Get session memory namespace | `GET` | `/v1/sessions/:key/memory-namespace` | — | `status: 200`, `namespace` is a string | ❌ |
| 4.9 | Search memories for "Rust" | `POST` | `/v1/memory/search` | `{ query: "Rust programming", namespace: <from 4.8> }` | `status: 200`, `items.length > 0`, at least one item mentions Rust | ❌ |
| 4.10 | Search memories for "Italian cooking" | `POST` | `/v1/memory/search` | `{ query: "cooking Italian", namespace: <from 4.8> }` | `status: 200`, `items.length > 0`, at least one item mentions cooking or Italian | ❌ |
| 4.11 | List all extracted memories | `GET` | `/v1/memory/items?namespace=<from 4.8>` | — | `items.length >= 1`, all have `source` related to the session | ❌ |

### What Could Go Wrong

| Failure Mode | Likelihood | Mitigation |
|-------------|-----------|------------|
| Extraction service not configured | Medium | The hub creates it from `deps.extractionService`. If not wired, step 4.6 returns 501. Check and skip. |
| LLM extracts zero memories | Low | The conversation has clear, extractable facts. But LLM is non-deterministic. Accept `extractedCount >= 0` and verify at least structure is correct. |
| FTS search finds nothing | Low-Medium | FTS5 indexing may not match LLM-phrased memories exactly. Use broad search terms. |
| Memory namespace format changed | Low | Use the namespace returned by step 4.8 dynamically. |

### ClawdBot Reference

ClawdBot has memory in `clawdbot/src/memory/` with Voyage embeddings and sync operations. Friday uses FTS5 (SQLite full-text search) instead of vector embeddings. The extraction LLM pipeline (`friday-session-memory-extraction-llm-client.ts`) is unique to Friday.

---

## Scenario 5: Session Fork and Merge

**User story:** "I'm in a conversation, spawn a sub-task, work on it separately, then bring the results back."

**LLM calls:** 0

### Steps

| Step | Action | Method | Path | Body | Assert | LLM? |
|------|--------|--------|------|------|--------|------|
| 5.1 | Create parent session | `POST` | `/v1/sessions` | `{ channel: "e2e", chatId: "fork-test-1" }` | `status: 200`, `session.key` exists | ❌ |
| 5.2 | Add messages to parent | `POST` | `/v1/sessions/:parentKey/messages` | `{ role: "user", content: "Research the best pizza dough recipe" }` | `status: 200` | ❌ |
| 5.3 | Add assistant response | `POST` | `/v1/sessions/:parentKey/messages` | `{ role: "assistant", content: "I'll research that for you. Let me fork a sub-task." }` | `status: 200` | ❌ |
| 5.4 | Fork session | `POST` | `/v1/sessions/:parentKey/fork` | `{ taskId: "pizza-research", inheritMessageCount: 2 }` | `status: 200`, `result.forkSessionKey` exists | ❌ |
| 5.5 | Verify fork exists | `GET` | `/v1/sessions/:forkKey` | — | `status: 200`, `session.status === "active"`, parent reference set | ❌ |
| 5.6 | Verify fork inherited messages | `GET` | `/v1/sessions/:forkKey/messages` | — | `items.length >= 2`, messages from parent are inherited | ❌ |
| 5.7 | Add work to fork | `POST` | `/v1/sessions/:forkKey/messages` | `{ role: "assistant", content: "Found the recipe: 500g flour, 325ml water, 10g salt, 3g yeast. Ferment 24 hours." }` | `status: 200` | ❌ |
| 5.8 | List forks | `GET` | `/v1/sessions/:parentKey/forks` | — | `items.length >= 1`, includes our fork | ❌ |
| 5.9 | Merge fork back | `POST` | `/v1/sessions/:parentKey/merge` | `{ forkSessionKey: <forkKey>, summary: "Found pizza dough recipe: 500g flour, 325ml water, 10g salt, 3g yeast, 24h ferment" }` | `status: 200`, `result` present | ❌ |
| 5.10 | Verify parent has merge summary | `GET` | `/v1/sessions/:parentKey/messages` | — | Last message includes merge summary content | ❌ |
| 5.11 | Verify fork is archived (if archiveFork was set) | `GET` | `/v1/sessions/:forkKey` | — | Session may be archived after merge | ❌ |

### What Could Go Wrong

| Failure Mode | Likelihood | Mitigation |
|-------------|-----------|------------|
| Fork key format unexpected | Low | Use whatever key is returned by step 5.4. |
| Merge fails due to state conflict | Low | Ensure fork is active and has messages before merging. |
| Inherited messages not marked | Low | Check `is_inherited` flag on fork messages. |

---

## Scenario 6: Skill Converter Imports a Skill

**User story:** "I have a ClawdBot skill.md file and want to import it into Friday."

**LLM calls:** 0

### Steps

| Step | Action | Method | Path | Body | Assert | LLM? |
|------|--------|--------|------|------|--------|------|
| 6.1 | List available converters | `GET` | `/v1/skills/converters` | — | `status: 200`, `converters.length >= 1`, includes `clawdbot-skill-md` converter | ❌ |
| 6.2 | Convert ClawdBot skill (dry run) | `POST` | `/v1/skills/convert` | See [ClawdBot Skill Fixture](#clawdbot-skill-fixture) | `status: 200`, `converterId === "clawdbot-skill-md"`, `detectedFormat === "clawdbot-skill-md"`, `drafts.length >= 1` | ❌ |
| 6.3 | Verify draft structure | — | — | — | `drafts[0].manifest.id` exists, `drafts[0].manifest.runtime.kind === "shell"`, `drafts[0].files.length > 0` | ❌ |
| 6.4 | Verify validation | — | — | — | `validation[0].ok` is `true` or has only warnings (no errors) | ❌ |
| 6.5 | Import skill (real install) | `POST` | `/v1/skills/import` | `{ source: { contentBase64: <same> }, formatHint: "clawdbot-skill-md", target: "managed", replace: true, refreshRegistry: true }` | `status: 200`, `imports[0].installed === true`, `registryRefreshed === true` | ❌ |
| 6.6 | Verify skill appears in registry | *(internal)* | `hub.skills.get("converted-skill-id")` | — | Skill exists in registry with correct manifest | ❌ |

#### ClawdBot Skill Fixture

```ts
const CLAWDBOT_SKILL_MD = `# hello-world-converter-test

A test skill for converter E2E testing.

## Description
Outputs a greeting message.

## Runtime
kind: shell
command: echo '{"greeting": "hello from converted skill"}'

## Inputs
None.

## Outputs
- greeting: The greeting message
`;

const base64Content = Buffer.from(CLAWDBOT_SKILL_MD).toString("base64");

// Convert body:
{
  source: { contentBase64: base64Content },
  formatHint: "clawdbot-skill-md",
  dryRun: true
}
```

### What Could Go Wrong

| Failure Mode | Likelihood | Mitigation |
|-------------|-----------|------------|
| ClawdBot skill.md format changed | Low | Use the simplest possible skill.md format. |
| Converter generates invalid manifest | Medium | Check validation results. If errors, verify they're structural (not converter bugs). |
| Install path collision | Low | Use `replace: true`. |
| Registry refresh fails | Low | Non-fatal — skill is installed but registry didn't see it. Verify file on disk as fallback. |

### ClawdBot Reference

ClawdBot skill.md format defined in `clawdbot/src/agents/skills-install.ts`. The converter in Friday (`friday-clawdbot-skill-md-converter.ts`) parses this format. Skills live in workspace `skills/` directories with `SKILL.md` files.

---

## Scenario 7: Full Workflow Lifecycle with Builder

**User story:** "I want to create a workflow using the visual builder: create draft, edit it, compile, publish, run."

**LLM calls:** 0

### Steps

| Step | Action | Method | Path | Body | Assert | LLM? |
|------|--------|--------|------|------|--------|------|
| 7.1 | Create empty workflow | `POST` | `/v1/workflows` | `{ slug: "builder-lifecycle-test", name: "Builder Lifecycle Test", tags: ["e2e-builder"] }` with minimal graph | `status: 200`, `workflow.id` exists | ❌ |
| 7.2 | Create draft | `POST` | `/v1/workflows/:wfId/drafts` | `{ title: "Initial Draft", spec: <spec>, visual: <visual> }` | `status: 200`, `draft.id` exists, `draft.revision === 1` | ❌ |
| 7.3 | Acquire edit lock | `POST` | `/v1/workflows/:wfId/locks/acquire` | `{ ownerUserId: "admin-001", ownerSessionId: "e2e-builder" }` | `status: 200`, `acquired === true`, `lock.token` exists | ❌ |
| 7.4 | Edit draft (save) | `PATCH` | `/v1/workflows/:wfId/drafts/:draftId` | `{ title: "Updated Draft", spec: <updatedSpec> }` | `status: 200`, `draft.revision === 2` | ❌ |
| 7.5 | Autosave draft | `POST` | `/v1/workflows/:wfId/drafts/:draftId/autosave` | `{ spec: <spec>, visual: <visual> }` | `status: 200` | ❌ |
| 7.6 | Compile draft | `POST` | `/v1/workflows/:wfId/drafts/:draftId/compile` | — | `status: 200`, response contains `compiledGraph` or `errors` | ❌ |
| 7.7 | Release lock | `POST` | `/v1/workflows/:wfId/locks/release` | `{ lockToken: <from 7.3> }` | `status: 200`, `released === true` | ❌ |
| 7.8 | Publish draft | `POST` | `/v1/workflows/:wfId/drafts/:draftId/publish` | `{ publishNow: true }` | `status: 200` | ❌ |
| 7.9 | Verify published | `GET` | `/v1/workflows/:wfId` | — | `publishedVersion` not null, version number incremented | ❌ |
| 7.10 | Run published workflow | `POST` | `/v1/workflow-runs` | `{ workflowId, triggerType: "manual", triggerPayload: {} }` | `status: 200`, `run.id` exists | ❌ |
| 7.11 | Poll until complete | `GET` | `/v1/workflow-runs/:runId` | — (poll) | `run.status === "completed"` | ❌ |

#### Builder Spec Fixture

```json
{
  "spec": {
    "schemaVersion": "1.0",
    "workflowId": "builder-lifecycle-test",
    "name": "Builder Lifecycle Test",
    "description": "E2E test workflow",
    "nodes": [
      { "id": "trigger-1", "type": "trigger", "name": "Manual", "config": { "triggerType": "manual" } },
      { "id": "data-1", "type": "data", "name": "Transform", "config": { "mapping": { "result": "hello" } } }
    ],
    "edges": [
      { "id": "e1", "sourceNodeId": "trigger-1", "targetNodeId": "data-1" }
    ]
  },
  "visual": {
    "nodes": {
      "trigger-1": { "x": 100, "y": 100, "width": 200, "height": 80 },
      "data-1": { "x": 100, "y": 250, "width": 200, "height": 80 }
    },
    "viewport": { "x": 0, "y": 0, "zoom": 1 }
  }
}
```

### What Could Go Wrong

| Failure Mode | Likelihood | Mitigation |
|-------------|-----------|------------|
| Draft spec schema validation fails | Medium | Use the simplest valid spec. Check compiler error messages for hints. |
| Lock already held | Low | Fresh workflow per test. |
| Compile produces errors | Medium | Verify the spec matches what the compiler expects. If compile fails, check the error messages — they're the test output. |
| Publish fails after compile errors | Low | Only publish if compile succeeded. |

---

## Scenario 8: Memory Store → Search → Recall Cycle

**User story:** "I store structured knowledge, then later search for it using natural language queries."

**LLM calls:** 0

### Steps

| Step | Action | Method | Path | Body | Assert | LLM? |
|------|--------|--------|------|------|--------|------|
| 8.1 | Store fact 1 | `POST` | `/v1/memory/store` | `{ namespace: "e2e-knowledge", content: "TypeScript was created by Microsoft and first released in 2012", source: "e2e-test", tags: ["tech", "language"] }` | `status: 200`, `item.id` exists | ❌ |
| 8.2 | Store fact 2 | `POST` | `/v1/memory/store` | `{ namespace: "e2e-knowledge", content: "Rust was created by Mozilla and focuses on memory safety without garbage collection", source: "e2e-test", tags: ["tech", "language"] }` | `status: 200` | ❌ |
| 8.3 | Store fact 3 | `POST` | `/v1/memory/store` | `{ namespace: "e2e-knowledge", content: "The best pizza in New York is at Di Fara Pizza in Brooklyn", source: "e2e-test", tags: ["food", "nyc"] }` | `status: 200` | ❌ |
| 8.4 | Store with TTL | `POST` | `/v1/memory/store` | `{ namespace: "e2e-knowledge", content: "Temporary note: deploy at 3pm", source: "e2e-test", ttlSeconds: 3600 }` | `status: 200`, `item.expiresAt` exists | ❌ |
| 8.5 | Search for programming | `POST` | `/v1/memory/search` | `{ query: "programming language", namespace: "e2e-knowledge" }` | `items.length >= 2`, results include TypeScript and Rust facts | ❌ |
| 8.6 | Search for food | `POST` | `/v1/memory/search` | `{ query: "pizza food", namespace: "e2e-knowledge" }` | `items.length >= 1`, result mentions pizza or Di Fara | ❌ |
| 8.7 | Search with tag filter | `POST` | `/v1/memory/search` | `{ query: "language", namespace: "e2e-knowledge", tagsAny: ["tech"] }` | All results have "tech" tag | ❌ |
| 8.8 | Search with minScore | `POST` | `/v1/memory/search` | `{ query: "TypeScript Microsoft", namespace: "e2e-knowledge", minScore: 0.01 }` | All items have `score >= 0.01` | ❌ |
| 8.9 | Get item by ID | `GET` | `/v1/memory/items/:id` | — (use ID from 8.1) | `status: 200`, content matches | ❌ |
| 8.10 | List items in namespace | `GET` | `/v1/memory/items?namespace=e2e-knowledge` | — | `items.length === 4` | ❌ |
| 8.11 | Delete item | `DELETE` | `/v1/memory/items/:id` | — (use ID from 8.3) | `status: 200`, `deleted: true` | ❌ |
| 8.12 | Verify deleted | `GET` | `/v1/memory/items/:id` | — | `status: 404` | ❌ |
| 8.13 | Prune dry run | `POST` | `/v1/memory/prune` | `{ namespace: "e2e-knowledge", dryRun: true }` | `status: 200`, `result.prunedCount >= 0` | ❌ |

---

## Scenario 9: Workflow with Condition Branching

**User story:** "I want a workflow that makes a decision based on input data and takes different paths."

**LLM calls:** 0

### Steps

| Step | Action | Method | Path | Body | Assert | LLM? |
|------|--------|--------|------|------|--------|------|
| 9.1 | Create workflow with condition graph | `POST` | `/v1/workflows` | See [Graph Fixture B](#graph-fixture-b-condition-branching) | `status: 200` | ❌ |
| 9.2 | Publish | `POST` | `/v1/workflows/:id/publish` | `{ versionNumber: 1 }` | `status: 200` | ❌ |
| 9.3 | Run with value > threshold (true branch) | `POST` | `/v1/workflow-runs` | `{ workflowId, triggerType: "manual", triggerPayload: { score: 85 } }` | `status: 200` | ❌ |
| 9.4 | Poll until complete | `GET` | `/v1/workflow-runs/:runId` | — | `run.status === "completed"` | ❌ |
| 9.5 | Verify true branch executed | `GET` | `/v1/workflow-runs/:runId/nodes` | — | Condition node completed with `result: true`, "pass" data node completed, "fail" data node NOT executed (or skipped) | ❌ |
| 9.6 | Run with value ≤ threshold (false branch) | `POST` | `/v1/workflow-runs` | `{ workflowId, triggerType: "manual", triggerPayload: { score: 45 } }` | `status: 200` | ❌ |
| 9.7 | Poll until complete | `GET` | `/v1/workflow-runs/:runId` | — | `run.status === "completed"` | ❌ |
| 9.8 | Verify false branch executed | `GET` | `/v1/workflow-runs/:runId/nodes` | — | Condition node completed with `result: false`, "fail" data node completed | ❌ |

#### Graph Fixture B: Condition Branching

```json
{
  "schemaVersion": "2.0",
  "workflowId": "condition-test",
  "workflowVersionId": "<generated>",
  "sourceSpecSchemaVersion": "1.0",
  "graph": {
    "nodes": [
      {
        "id": "trigger-1",
        "type": "trigger",
        "label": "Manual Trigger",
        "config": { "triggerType": "manual" }
      },
      {
        "id": "check-score",
        "type": "condition",
        "label": "Score Check",
        "config": { "condition": "$inputs.score > 70" }
      },
      {
        "id": "pass-node",
        "type": "data",
        "label": "Pass",
        "config": { "mapping": { "status": "passed", "score": "$inputs.score" } }
      },
      {
        "id": "fail-node",
        "type": "data",
        "label": "Fail",
        "config": { "mapping": { "status": "failed", "score": "$inputs.score" } }
      }
    ],
    "edges": [
      { "id": "e1", "sourceNodeId": "trigger-1", "targetNodeId": "check-score" },
      { "id": "e2", "sourceNodeId": "check-score", "targetNodeId": "pass-node", "condition": "$nodes.check-score.output.result === true" },
      { "id": "e3", "sourceNodeId": "check-score", "targetNodeId": "fail-node", "condition": "$nodes.check-score.output.result === false" }
    ]
  },
  "failurePolicy": { "onFailure": "fail_fast" },
  "tests": [],
  "checksum": "<computed>"
}
```

**Note:** The edge condition syntax depends on how `FridayExpressionEvaluator` resolves `$nodes.<id>.output`. This needs to match the actual evaluator implementation. If the evaluator doesn't support edge conditions, use the simpler approach of having the condition node produce branching output and the DAG scheduler route based on `branch` labels on edges.

### What Could Go Wrong

| Failure Mode | Likelihood | Mitigation |
|-------------|-----------|------------|
| Expression evaluator doesn't support `$inputs.score > 70` | Medium | Test with the exact expression format the evaluator expects. Inspect `friday-workflow-expression-evaluator.ts` for syntax. |
| Branching edges not properly evaluated | Medium | The DAG scheduler may not support conditional edges. May need to use `branch: "true"/"false"` on edges instead. |
| Both branches execute | Low | This indicates the scheduler doesn't handle exclusion. Document and report. |

---

## Scenario 10: Workflow Approval Gate

**User story:** "I want a workflow where a human must approve before a critical step runs."

**LLM calls:** 0

### Steps

| Step | Action | Method | Path | Body | Assert | LLM? |
|------|--------|--------|------|------|--------|------|
| 10.1 | Create workflow with approval node | `POST` | `/v1/workflows` | Graph with trigger → approval → data node | `status: 200` | ❌ |
| 10.2 | Publish | `POST` | `/v1/workflows/:id/publish` | `{ versionNumber: 1 }` | `status: 200` | ❌ |
| 10.3 | Start run | `POST` | `/v1/workflow-runs` | `{ workflowId, triggerType: "manual", triggerPayload: {} }` | `status: 200` | ❌ |
| 10.4 | Poll until paused | `GET` | `/v1/workflow-runs/:runId` | — (poll, max 10s) | `run.status === "paused"` (waiting for approval) | ❌ |
| 10.5 | List pending approvals | `GET` | `/v1/workflow-approvals` | — | `items.length >= 1`, approval for our run exists | ❌ |
| 10.6 | Get approval detail | `GET` | `/v1/workflow-approvals/:approvalId` | — | `status === "pending"`, `runId` matches | ❌ |
| 10.7 | Approve | `POST` | `/v1/workflow-approvals/:approvalId/decide` | `{ decision: "approved", comment: "looks good" }` | `status: 200` | ❌ |
| 10.8 | Poll until completed | `GET` | `/v1/workflow-runs/:runId` | — | `run.status === "completed"` | ❌ |
| 10.9 | Verify post-approval node executed | `GET` | `/v1/workflow-runs/:runId/nodes` | — | All nodes completed, including the data node after approval | ❌ |

#### Approval Graph Fixture

```json
{
  "graph": {
    "nodes": [
      { "id": "trigger-1", "type": "trigger", "label": "Manual", "config": { "triggerType": "manual" } },
      { "id": "approval-1", "type": "approval", "label": "Approve Deploy", "config": { "approverRole": "admin", "timeoutMs": 60000 } },
      { "id": "deploy", "type": "data", "label": "Deploy", "config": { "mapping": { "deployed": true } } }
    ],
    "edges": [
      { "id": "e1", "sourceNodeId": "trigger-1", "targetNodeId": "approval-1" },
      { "id": "e2", "sourceNodeId": "approval-1", "targetNodeId": "deploy" }
    ]
  }
}
```

### What Could Go Wrong

| Failure Mode | Likelihood | Mitigation |
|-------------|-----------|------------|
| Approval service not wired | Low | Hub creates it in `createFridayWorkflowRuntime`. |
| Run never pauses (approval node treated as passthrough) | Medium | Approval node returns `{ approved: false, pending: true }`, which should trigger pause via `requestNodeApproval` callback. Verify engine implementation. |
| Approval API routes missing | Low | Routes defined in workflow approval routes file. |
| Resume after approval fails | Medium | The `resumeRun` endpoint + approval service need to coordinate. Test the happy path first. |

---

## Scenario 11: Skill Generation with Multi-Turn Conversation

**User story:** "I describe a complex skill through multiple conversation turns before generating."

**LLM calls:** 3-5 (multiple requirements rounds + generation)

### Steps

| Step | Action | Method | Path | Body | Assert | LLM? |
|------|--------|--------|------|------|--------|------|
| 11.1 | Start with vague goal | `POST` | `/v1/skills/generator/sessions` | `{ goal: "Make a skill that processes data", userId: "admin-001", channel: "e2e", requestedModel: MODEL }` | `mode === "clarification_required"`, `questions.length > 0` | ✅ ~5s |
| 11.2 | Provide more detail | `POST` | `/v1/skills/generator/sessions/:sessionId/messages` | `{ message: "It should take a CSV file path as input and output the number of rows and columns", requestedModel: MODEL }` | `mode` is `"clarification_required"` or `"preview_ready"` | ✅ ~5s |
| 11.3 | Provide remaining details | `POST` | `/v1/skills/generator/sessions/:sessionId/messages` | `{ message: "Shell skill, use wc and awk. Output JSON with rowCount and colCount fields.", requestedModel: MODEL }` | Updated session state | ✅ ~5s |
| 11.4 | Verify conversation history | `GET` | `/v1/skills/generator/sessions/:sessionId` | — | `turns.length >= 4` (2 user + 2 assistant minimum) | ❌ |
| 11.5 | Generate draft | `POST` | `/v1/skills/generator/sessions/:sessionId/generate` | `{ requestedModel: MODEL }` | `status: 200` or `422` | ✅ ~30s |
| 11.6 | If success, verify manifest has inputs | — | — | — | `draft.manifest.inputs.length >= 1`, at least one input for CSV path | ❌ |
| 11.7 | Cancel session (cleanup) | `DELETE` | `/v1/skills/generator/sessions/:sessionId` | — | `status: 200`, `cancelled: true` | ❌ |
| 11.8 | Verify cancelled | `GET` | `/v1/skills/generator/sessions/:sessionId` | — | `session.status === "cancelled"` | ❌ |

---

## Scenario 12: End-to-End CLI Simulation

**User story:** "I use the CLI to list skills, run a skill, and import a new one."

**LLM calls:** 0

This scenario tests the CLI code paths directly (not through HTTP). We invoke the parsed commands programmatically since the CLI boots a full hub.

### Steps

| Step | Action | Assert | LLM? |
|------|--------|--------|------|
| 12.1 | `parseArgs(["list", "--skills-dir", testSkillDir])` | `command === "list"`, `skillDirs` includes testSkillDir | ❌ |
| 12.2 | `parseArgs(["run", "echo-test", "--input", "name=world"])` | `command === "run"`, `skillId === "echo-test"`, `input.name === "world"` | ❌ |
| 12.3 | `parseArgs(["import", "/path/to/skill.md", "--from", "clawdbot-skill-md", "--dry-run"])` | `command === "import"`, `source`, `from`, `dryRun` all set | ❌ |
| 12.4 | `parseArgs(["converters"])` | `command === "converters"` | ❌ |
| 12.5 | `parseArgs(["status"])` | `command === "status"` | ❌ |
| 12.6 | `parseArgs(["--help"])` | `command === "help"` | ❌ |

**Note:** Full CLI integration tests (actually booting the hub via subprocess) belong in a separate test file. These tests verify the arg parser works correctly — a prerequisite for the CLI functioning.

---

## Scenario 13: Realtime Event Subscription During Workflow Run

**User story:** "I subscribe to run events via the realtime API and receive updates as a workflow executes."

**LLM calls:** 0

### Steps

| Step | Action | Method | Path | Body | Assert | LLM? |
|------|--------|--------|------|------|--------|------|
| 13.1 | Subscribe to run events | `POST` | `/v1/realtime/subscriptions` | `{ subscriptions: [{ streamId: "run:*", events: ["*"] }] }` | `status: 200`, subscription confirmed | ❌ |
| 13.2 | Start a workflow run | `POST` | `/v1/workflow-runs` | `{ workflowId: <from scenario 7 or 9>, triggerType: "manual" }` | `status: 200` | ❌ |
| 13.3 | Pull events | `POST` | `/v1/realtime/pull` | `{ streamId: "run:*", afterSeq: 0, limit: 20 }` | Events include run start, node executions, run complete | ❌ |
| 13.4 | Ack events | `POST` | `/v1/realtime/ack` | `{ streamId, seq, epoch }` | `status: 200` | ❌ |

**Note:** This depends on the realtime service being wired and the workflow engine emitting events via `publishEvent`. If the realtime service isn't available, skip.

---

## Dependency Map

```
Scenario 1 (Skill Gen+Run)      → independent
Scenario 2 (Workflow Gen+Run)    → independent
Scenario 3 (AI Inference Node)   → independent (constructs own workflow)
Scenario 4 (Memory Extraction)   → independent
Scenario 5 (Fork & Merge)        → independent
Scenario 6 (Skill Converter)     → independent
Scenario 7 (Builder Lifecycle)   → independent
Scenario 8 (Memory CRUD)         → independent
Scenario 9 (Condition Branch)    → independent
Scenario 10 (Approval Gate)      → independent
Scenario 11 (Multi-turn Gen)     → independent
Scenario 12 (CLI Args)           → independent (no hub needed)
Scenario 13 (Realtime Events)    → needs a published workflow (can reuse from 7 or 9)
```

All scenarios are independent (each creates its own resources). Scenario 13 optionally reuses a workflow from an earlier scenario but can create its own.

### Execution Order (suggested for efficiency)

```
1. CLI Args (Scenario 12)           — 0 LLM, fastest
2. Memory CRUD (Scenario 8)         — 0 LLM
3. Fork & Merge (Scenario 5)        — 0 LLM
4. Skill Converter (Scenario 6)     — 0 LLM
5. Builder Lifecycle (Scenario 7)   — 0 LLM
6. Condition Branch (Scenario 9)    — 0 LLM
7. Approval Gate (Scenario 10)      — 0 LLM
8. Realtime Events (Scenario 13)    — 0 LLM
9. AI Inference Node (Scenario 3)   — 1 LLM call
10. Memory Extraction (Scenario 4)  — 1-2 LLM calls
11. Skill Gen+Run (Scenario 1)      — 4-6 LLM calls
12. Multi-turn Gen (Scenario 11)    — 3-5 LLM calls
13. Workflow Gen+Run (Scenario 2)   — 5-8 LLM calls
```

Non-LLM scenarios first (fast, free), then LLM scenarios in order of increasing cost.

---

## What's NOT Testable

| Feature | Why | Alternative |
|---------|-----|-------------|
| **OAuth browser flow** | Requires real browser redirect to Anthropic OAuth page | Test with pre-seeded tokens (current approach) |
| **Cron-triggered workflows** | Would need to wait for cron to fire | Test cron trigger registration, not firing |
| **Webhook-triggered workflows** | Need external HTTP call to webhook URL | Can self-trigger with `POST /v1/workflow-webhooks/:token` but token discovery requires trigger sync |
| **Satellite pairing** | Requires a real satellite agent | Test fleet overview routes return empty |
| **Plugin installation** | Requires real plugin packages | Test list/search routes return empty |
| **Rate limiting** | Requires rapid concurrent requests | Flaky in tests; skip |
| **Provider failover** | Requires 2+ real providers with one failing | Could set up Ollama as fallback but unreliable in CI. Test routing config CRUD instead. |
| **File upload for skills** | Requires multipart form handling | Use `contentBase64` in converter instead |
| **WebSocket realtime** | Requires WS client and async event waiting | Complex but doable; test separately |
| **Long-running workflow timeout** | Would take minutes to trigger | Test engine's `sweepTimedOutRuns` directly |

---

## Test Count Summary

| Scenario | Steps | LLM Calls | Est. Time |
|----------|-------|-----------|-----------|
| 1. Skill Gen+Run | 8 | 4-6 | 60-90s |
| 2. Workflow Gen+Run | 10 | 5-8 | 90-120s |
| 3. AI Inference Node | 6 | 1 | 15-30s |
| 4. Memory Extraction | 11 | 1-2 | 15-30s |
| 5. Fork & Merge | 11 | 0 | 2-5s |
| 6. Skill Converter | 6 | 0 | 2-5s |
| 7. Builder Lifecycle | 11 | 0 | 3-5s |
| 8. Memory CRUD | 13 | 0 | 2-5s |
| 9. Condition Branch | 8 | 0 | 3-5s |
| 10. Approval Gate | 9 | 0 | 3-5s |
| 11. Multi-turn Gen | 8 | 3-5 | 45-60s |
| 12. CLI Args | 6 | 0 | <1s |
| 13. Realtime Events | 4 | 0 | 3-5s |
| **Total** | **111** | **14-22** | **4-6 min** |

---

## Implementation Notes

### Polling Helper

```ts
async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (result: T) => boolean,
  opts: { intervalMs?: number; maxMs?: number } = {},
): Promise<T> {
  const { intervalMs = 500, maxMs = 15000 } = opts;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (predicate(result)) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil timed out after ${maxMs}ms`);
}
```

### Graph Checksum Helper

```ts
function computeTestChecksum(content: string): string {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
```

### Response Type Helper

```ts
interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}
```

### Graceful LLM Failure Handling

For all LLM-dependent steps, the test should:
1. Accept both success (200) and graceful failure (422) responses
2. If 422, verify the error structure is correct (not a raw crash)
3. Skip downstream steps that depend on the LLM output
4. Log the failure for debugging but don't fail the test suite

```ts
function assertLlmResponse(res: Response, json: unknown): "success" | "graceful_failure" {
  if (res.status === 200) {
    expect(json.ok).toBe(true);
    return "success";
  }
  if (res.status === 422) {
    expect(json.ok).toBe(false);
    expect(json.error).toBeTruthy();
    return "graceful_failure";
  }
  throw new Error(`Unexpected LLM response status: ${res.status}`);
}
```

### Node Type Reference

The workflow engine's node executor (`friday-workflow-node-executor.ts`) supports these node types:

| Type | Purpose | Config | Notes |
|------|---------|--------|-------|
| `trigger` | Entry point, passes payload through | `{ triggerType: "manual" }` | Always first node |
| `action` | Invokes a registered skill | `{ skillId: "...", args: {...} }` | Needs skill in registry |
| `condition` | Evaluates boolean expression | `{ condition: "$expr" }` | Returns `{ result: true/false }` |
| `data` | Transforms/maps data | `{ mapping: {...} }` or `{ transform: "$expr" }` | For data routing |
| `ai` | Calls LLM via provider service | `{ prompt: "...", model?: "..." }` | Routes through `ai-inference` skill |
| `approval` | Pauses run for human approval | `{ approverRole?, timeoutMs? }` | Returns `{ approved: false, pending: true }` |

### Expression Context

The expression evaluator has access to:
- `$inputs` — trigger payload
- `$nodes.<nodeId>.output` — output of completed nodes
- Standard operators: `>`, `<`, `===`, `!==`, etc.

### ClawdBot Feature Comparison

| Friday Feature | ClawdBot Equivalent | Notes |
|---------------|---------------------|-------|
| Skill Registry | `skills-status.ts`, workspace `SKILL.md` files | ClawdBot scans workspace dirs |
| Skill Execution | Tool calls via LLM → skill dispatched | ClawdBot uses inline tool execution |
| Memory Store/Search | `memory/manager.ts` with Voyage embeddings | ClawdBot uses vector embeddings; Friday uses FTS5 |
| Sessions | `config/sessions/` | ClawdBot has simpler session management |
| Workflows | ❌ Not in ClawdBot | Unique to Friday |
| Generators | ❌ Not in ClawdBot | Unique to Friday |
| Builder | ❌ Not in ClawdBot | Unique to Friday |
| Converters | `skills-install.ts` | ClawdBot installs skills from SKILL.md; Friday has formal converter pipeline |

---

## CI Integration

```bash
# Run all scenarios (non-LLM are always free)
FRIDAY_LLM_E2E=1 \
FRIDAY_ANTHROPIC_OAUTH_ACCESS_TOKEN=xxx \
npx vitest run test/e2e/friday-real-scenarios-e2e.test.ts

# Run only non-LLM scenarios (free, fast, good for CI)
FRIDAY_LLM_E2E=1 \
npx vitest run test/e2e/friday-real-scenarios-e2e.test.ts --test-name-pattern "Scenario (5|6|7|8|9|10|12)"

# Run a single scenario
FRIDAY_LLM_E2E=1 \
FRIDAY_ANTHROPIC_OAUTH_ACCESS_TOKEN=xxx \
npx vitest run test/e2e/friday-real-scenarios-e2e.test.ts --test-name-pattern "Scenario 1"
```

### Cost Tracking

After each LLM-dependent scenario, log the number of API calls made and estimated token usage. This helps track costs across CI runs.

```ts
afterEach(() => {
  if (llmCallCount > 0) {
    console.log(`[COST] Scenario used ${llmCallCount} LLM call(s), ~${estimatedTokens} tokens`);
  }
});
```
