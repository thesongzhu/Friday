# Friday Template Harness V1 Blueprint

**Status:** Draft  
**Date:** 2026-03-25  
**Owner:** Platform  
**Scope lock:** Template-level borrowing from Anthropic's harness article only

---

## 1. Product Decision Lock

### 1.1 Confirmed facts

- `docs/current-source-of-truth.md` defines Friday's steady-state product as a supervised, bounded automation system, not an unrestricted long-running coding harness.
- `/assistant` is the beginner-first surface for plain-language intent resolution, guided wizards, issue inbox, fix approvals, and direct skill generation.
- `src/uix/services/friday-uix-surface-service.ts` already exposes reusable starter surfaces through template IDs such as `idea-clarifier`, `implementation-plan-review`, `browser-qa-report`, `generate-skill`, and `generate-workflow`.
- `src/skills/generator/model/friday-skill-generator.types.ts` and `src/workflows/generator/model/friday-workflow-generator.types.ts` already carry session summaries, open questions, decisions, and draft review states.
- `src/acceptance/engine/acceptance-gate.ts` is already fail-closed and is the strongest existing backend quality gate for structured pass/fail decisions.
- `src/sessions/model/friday-session.types.ts` already carries focus-state continuity primitives such as `lastRunId`, `activeRunId`, `pendingPlanRunId`, topic summaries, and reply anchors.

### 1.2 Locked decisions for v1

1. V1 adopts Anthropic's ideas only at the template and generator layer.
2. V1 introduces four explicit artifacts: `planning spec`, `delivery contract`, `QA verdict`, and `handoff artifact`.
3. V1 does not introduce a new top-level public route family such as `/v1/harness/*`.
4. V1 does not turn the main agent runtime into a default long-running application-builder path.
5. V1 treats acceptance, verification evidence, and browser QA as the official evaluator surfaces; runtime self-test remains a local preflight signal, not the final acceptance authority.
6. V1 persists harness state in Friday platform state and artifacts, not in file-mailbox style agent-to-agent communication.
7. V1 ships behind a feature flag such as `FRIDAY_TEMPLATE_HARNESS_V1` with a clean fallback to today's template behavior.

### 1.3 Explicit non-goals

- No new unrestricted autonomous coding product.
- No weakening of approval, rollback, evidence, or repeated-failure halt expectations from the source of truth.
- No attempt to generalize the harness to every `FridayAgentRuntime.executeRun(...)` call.
- No new builder jargon in `/assistant`.
- No dependence on externalized file handoffs as the primary coordination model.

---

## 2. Why This Cut Is Correct

### 2.1 Confirmed facts

- Friday already has stronger product surfaces than the article in several places: approvals, rollback evidence, acceptance gating, realtime lifecycle events, and beginner-facing templates.
- Friday does not yet have a single app-building orchestration lane that binds `spec -> contract -> implementation -> evaluator -> handoff`.
- The closest existing product surfaces to Anthropic's `planner / generator / evaluator` pattern are the assistant templates and the skill/workflow generators, not the general agent runtime.

### 2.2 Recommendation

The right v1 is to make Friday's existing template and generator paths more explicit, not more autonomous. The product move is:

1. Convert vague goals into a visible `planning spec`.
2. Freeze a visible `delivery contract` before draft generation.
3. Produce a first-class `QA verdict` backed by existing evidence systems.
4. Persist a resumable `handoff artifact` in session-aware platform state.

This gives Friday the highest-value parts of the article without violating Friday's current product boundary.

---

## 3. Closed-Loop V1 User Journey

### 3.1 Entry surfaces

V1 should reuse existing assistant/template entry points instead of creating a new product lane:

| Existing surface | V1 harness role |
| --- | --- |
| `idea-clarifier` | bootstrap or repair the `planning spec` |
| `implementation-plan-review` | harden or challenge the `delivery contract` |
| `generate-skill` | generate a draft under a locked contract |
| `generate-workflow` | generate a workflow draft under a locked contract |
| `browser-qa-report` | produce browser evidence for the `QA verdict` when the success test is UI-facing |

### 3.2 Target loop

1. User enters a vague goal in `/assistant` or picks `generate-skill` / `generate-workflow`.
2. The generator session or wizard collects clarifications as it already does today.
3. Before draft generation, Friday emits a `planning spec` artifact with objective, assumptions, unknowns, out-of-scope items, and success test.
4. Friday derives a `delivery contract` artifact from the planning spec and any user answers.
5. Draft generation runs exactly once against that contract revision.
6. Friday runs `QA verdict` assembly using the existing evidence surfaces:
   - generator validation
   - skill self-test / verification evidence where applicable
   - workflow acceptance gate where applicable
   - browser QA evidence when the contract says the result must satisfy a page or app behavior
7. `approveAndSave(...)` is allowed only when the verdict is `pass` or when a future explicit override policy exists. V1 should not silently ignore a failed verdict.
8. On save or pause, Friday emits a `handoff artifact` with current status, evidence refs, open issues, and next actions.

### 3.3 Session-state mapping

V1 should keep existing public generator status enums and add a finer internal harness stage instead of replacing the current session model:

| Existing session status | Harness stage intent |
| --- | --- |
| `collecting_requirements` | build or refine `planning spec` |
| `needs_clarification` | `planning spec` blocked by unknowns |
| `generating` | `delivery contract` locked, draft in progress |
| `ready_for_review` | draft present, `QA verdict` ready or pending |
| `approved` / `saved` | `handoff artifact` emitted |

This avoids a public contract break while still creating the missing harness semantics.

---

## 4. Shared Artifact Layer

### 4.1 Design rule

V1 should add a small shared harness artifact layer instead of inventing separate skill-only and workflow-only formats.

### 4.2 Proposed internal stage enum

```ts
export type FridayTemplateHarnessStage =
  | "planning_spec"
  | "delivery_contract"
  | "draft_generation"
  | "qa_verdict"
  | "handoff_ready"
  | "completed";
```

### 4.3 Proposed artifact schemas

```ts
export interface FridayHarnessPlanningSpecV1 {
  artifactId: string;
  version: 1;
  scopeKind: "skill_generator" | "workflow_generator" | "uix_template" | "uix_wizard";
  scopeId: string;
  objective: string;
  summary: string;
  assumptions: string[];
  unknowns: string[];
  outOfScope: string[];
  constraints: string[];
  successTests: string[];
  openQuestions: string[];
  sourceTemplateId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayHarnessDeliveryContractV1 {
  artifactId: string;
  version: 1;
  planningSpecId: string;
  deliverableKind: "skill" | "workflow";
  deliverables: string[];
  doneDefinition: string[];
  acceptanceCriteria: string[];
  evidenceRequirements: Array<
    | "generator_validation"
    | "skill_self_test"
    | "skill_verification"
    | "workflow_acceptance"
    | "browser_qa"
  >;
  riskFlags: string[];
  blockedBy: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FridayHarnessQaVerdictV1 {
  artifactId: string;
  version: 1;
  deliveryContractId: string;
  verdict: "pass" | "fail" | "blocked";
  summary: string;
  passedCriteria: string[];
  failedCriteria: string[];
  warnings: string[];
  evidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FridayHarnessHandoffArtifactV1 {
  artifactId: string;
  version: 1;
  scopeKind: "skill_generator" | "workflow_generator" | "uix_template" | "uix_wizard";
  scopeId: string;
  stage: FridayTemplateHarnessStage;
  summary: string;
  completedWork: string[];
  remainingWork: string[];
  blockers: string[];
  nextActions: string[];
  artifactRefs: string[];
  createdAt: string;
  updatedAt: string;
}
```

### 4.4 Design notes

- `planning spec` is not the same object as today's `specSummary` or `requirementsSummary`; those remain useful summaries, but V1 needs a richer explicit artifact.
- `delivery contract` is the missing Anthropic-style `done definition` layer. It must exist before the draft is treated as reviewable.
- `QA verdict` is not just a list of warnings. It is a closure artifact that answers whether the contract passed.
- `handoff artifact` is not a general memory blob. It is a structured resume package for long or paused generator flows.

---

## 5. Interface Strategy By Surface

### 5.1 Assistant and UIX surfaces

### Confirmed facts

- `FridayUixTemplateExecutionResponse` and `FridayUixWizardResponse` already expose `objective`, `assumptions`, `unknowns`, `successTest`, and `state`.
- This means UIX already has the beginnings of a user-visible planning artifact, but not a contract, verdict, or handoff schema.

### V1 change

Add an optional `harness` block to template and wizard responses:

```ts
interface FridayUixHarnessSummary {
  stage: FridayTemplateHarnessStage;
  planningSpecId?: string;
  deliveryContractId?: string;
  qaVerdictId?: string;
  handoffArtifactId?: string;
  verdict?: "pass" | "fail" | "blocked";
}
```

This lets `/assistant` surface the harness chain without inventing a new route family or exposing builder internals.

### 5.2 Skill generator

### Confirmed facts

- `FridaySkillGenerationSession` already carries `goal`, `specSummary`, `openQuestions`, and `decisions`.
- `FridayGeneratedSkillDraft` already carries `validation`.
- `FridaySkillGeneratorService.approveAndSave(...)` already returns verification-style evidence.

### V1 change

Extend the skill generator session shape with additive harness refs:

```ts
interface FridaySkillGenerationSession {
  // existing fields
  harnessStage?: FridayTemplateHarnessStage;
  planningSpecId?: string;
  deliveryContractId?: string;
  qaVerdictId?: string;
  handoffArtifactId?: string;
}
```

Skill QA verdict composition in V1:

1. Required: generator validation.
2. Required: explicit draft self-test / verification evidence.
3. Optional: browser QA evidence when the contract says the generated skill must satisfy a user-visible web flow.

### 5.3 Workflow generator

### Confirmed facts

- `FridayWorkflowGenerationSession` already carries `requirementsSummary`, `openQuestions`, `decisions`, and draft linkage.
- `FridayGeneratedWorkflowDraft` already carries validation artifacts across requirements, spec, visual, tests, compile, graph, and consistency stages.
- Friday already has a workflow acceptance runtime with structured evidence and pass/fail taxonomy.

### V1 change

Mirror the same additive harness refs on workflow generation sessions:

```ts
interface FridayWorkflowGenerationSession {
  // existing fields
  harnessStage?: FridayTemplateHarnessStage;
  planningSpecId?: string;
  deliveryContractId?: string;
  qaVerdictId?: string;
  handoffArtifactId?: string;
}
```

Workflow QA verdict composition in V1:

1. Required: generator validation.
2. Required: workflow acceptance gate evidence compiled from contract expectations.
3. Optional: browser QA evidence when the workflow's success test is user-visible.

### 5.4 Sessions and handoff

### Confirmed facts

- `FridaySessionConversationFocusState` already tracks run continuity and active planning continuity.
- This is a better base for handoff than Anthropic's file-mailbox approach because the platform already has session, artifact, and evidence stores.

### V1 change

Add optional handoff-oriented fields to focus state:

```ts
interface FridaySessionConversationFocusState {
  // existing fields
  lastHarnessStage?: FridayTemplateHarnessStage;
  lastHandoffArtifactId?: string;
  lastHarnessSummary?: string;
}
```

This makes resume logic session-native instead of document-folder-native.

### 5.5 Agent runtime

### Confirmed facts

- `FridayAgentRuntime.executeRun(...)` already has planning-review, task profile, context, and artifact-persistence hooks.
- The main runtime is not the right place to force an Anthropic-style heavyweight contract on every run.

### V1 decision

- Do not change the public `executeRun(...)` signature in V1.
- If a later batch needs runtime awareness, add optional artifact refs through existing metadata or plan-review payloads rather than promoting a new top-level runtime contract immediately.

---

## 6. Persistence and Internal Module Shape

### 6.1 Recommended internal module

Add a small shared internal module rather than scattering JSON blobs across unrelated services:

- `src/harness/model/friday-template-harness.types.ts`
- `src/harness/services/friday-template-harness-service.ts`
- `src/harness/persistence/friday-template-harness-repository.ts`
- `src/harness/services/friday-template-harness-qa-adapter.ts`

### 6.2 Persistence recommendation

Preferred V1 storage shape:

1. A shared artifact repository with versioned JSON payloads keyed by `artifactId`.
2. Additive artifact refs stored on generator sessions and, where needed, session focus state.
3. Optional filesystem mirror only for debugging or export, not as the source of truth.

This is preferable to file-mailbox coordination because:

1. Friday already has durable session and evidence concepts.
2. Handoff and verdict artifacts should be queryable, auditable, and resumable.
3. Files are useful as exports, but they should not become the canonical state machine.

---

## 7. QA and Acceptance Strategy

### 7.1 Design rule

Anthropic's evaluator is the most transferable idea, but in Friday it should compile into existing platform quality surfaces rather than remain a free-text reviewer loop.

### 7.2 V1 evaluator hierarchy

1. `generator validation` answers structural correctness.
2. `skill self-test / verification evidence` answers whether a generated skill can be loaded and validated.
3. `workflow acceptance` answers whether deterministic workflow artifacts satisfy required checks.
4. `browser QA` answers user-visible behavior when the contract requires it.

### 7.3 Pass/fail policy

- `pass`: all required evidence requirements in the contract are satisfied.
- `fail`: one or more required checks completed and failed.
- `blocked`: a required evidence source did not run, could not be collected, or is waiting on user/environment input.

### 7.4 Approval policy

V1 should keep approval conservative:

1. Failed verdict blocks `approveAndSave(...)`.
2. Blocked verdict also blocks `approveAndSave(...)` unless a later product decision adds an explicit override surface with evidence and audit trail.
3. Warning-only signals may appear inside a `pass` verdict, but they must stay visible in the verdict artifact.

---

## 8. File-Level Change Plan

### 8.1 New shared module

1. Add `src/harness/model/friday-template-harness.types.ts`.
2. Add `src/harness/services/friday-template-harness-service.ts`.
3. Add `src/harness/persistence/friday-template-harness-repository.ts`.
4. Add a migration for shared harness artifact persistence.

### 8.2 UIX and assistant

1. Update `src/api/model/friday-api-uix-surface.types.ts` to add optional harness summaries.
2. Update `src/uix/services/friday-uix-surface-service.ts` so template execution and wizard flows emit harness refs and stage.
3. Reuse existing template IDs rather than introducing a separate assistant lane.

### 8.3 Skill generator

1. Update `src/skills/generator/model/friday-skill-generator.types.ts` with additive harness refs.
2. Update `src/skills/generator/services/friday-skill-generator-service.ts` to:
   - create/update `planning spec`
   - lock `delivery contract`
   - assemble `QA verdict`
   - emit `handoff artifact` on save or pause

### 8.4 Workflow generator

1. Update `src/workflows/generator/model/friday-workflow-generator.types.ts` with additive harness refs.
2. Update `src/workflows/generator/services/friday-workflow-generator-service.ts` to:
   - create/update `planning spec`
   - lock `delivery contract`
   - compile contract expectations into acceptance inputs
   - assemble `QA verdict`
   - emit `handoff artifact`

### 8.5 Sessions

1. Update `src/sessions/model/friday-session.types.ts` with additive handoff refs.
2. Update the session orchestration path only enough to surface the latest harness summary on resume.

### 8.6 Acceptance adapters

1. Add a contract-to-acceptance adapter for workflow generation.
2. Add a skill-verification-to-verdict adapter so skill flows produce a verdict object with the same semantics as workflow flows.

---

## 9. Rollout Phases

### Phase A - Contract lock

1. Add shared types, repository, and migration.
2. Add feature flag guard.
3. No visible behavior change yet beyond internal artifact persistence.

### Phase B - Generator integration

1. Emit `planning spec` and `delivery contract` from skill/workflow generation sessions.
2. Add harness refs to session responses.
3. Keep save behavior unchanged until verdict wiring lands.

### Phase C - Verdict gating

1. Wire `QA verdict` generation.
2. Block `approveAndSave(...)` on non-pass verdicts.
3. Surface verdict summaries in assistant and generator review flows.

### Phase D - Handoff and resume

1. Emit `handoff artifact` on save, pause, or blocked state.
2. Surface the handoff summary through session focus state and `/assistant` resume paths.

---

## 10. Validation Matrix

V1 is not complete unless all of the following are true:

1. A vague assistant request can produce a persisted `planning spec` before a draft exists.
2. Clarification answers update the planning spec revision instead of only changing ephemeral chat text.
3. A `delivery contract` exists before `generateDraft(...)` returns a reviewable draft.
4. A failed workflow acceptance result causes a `QA verdict = fail`.
5. Missing required browser QA evidence causes a `QA verdict = blocked`, not a silent pass.
6. `approveAndSave(...)` is rejected on `fail` or `blocked`.
7. A resumed session can read the last handoff summary without reconstructing it from raw chat history.
8. The feature flag cleanly falls back to today's generator/template behavior.

Recommended implementation validation commands once code exists:

- `npm run typecheck`
- targeted vitest coverage for skill generator, workflow generator, UIX response types, and session focus persistence
- existing release verification gates from `docs/current-source-of-truth.md` before any public contract ship

---

## 11. What V1 Must Not Copy From The Article

1. Do not copy file-based agent mailboxes as the primary coordination primitive.
2. Do not copy a default multi-agent autonomous app-builder product story into Friday's main runtime.
3. Do not copy harness complexity that bypasses Friday's approval, rollback, or evidence requirements.
4. Do not treat model improvements as permission to delete product-contract surfaces such as audit, approval, rollback, or acceptance evidence.
5. Do not claim Friday now supports unrestricted long-horizon autonomous software engineering after this v1.

---

## 12. Open Decisions For The Next Blueprint Round

These are not blockers for the direction lock, but they must be resolved before implementation starts:

1. Whether the shared artifact repository should be a dedicated table or a small versioned table plus optional filesystem export.
2. Whether browser QA should be auto-triggered only when `delivery contract.evidenceRequirements` explicitly asks for it, or also when the template category implies UI behavior.
3. Whether skill flows should reuse the acceptance engine directly or stay on a parallel skill-verification adapter that feeds the same verdict schema.
4. Whether `/assistant` should show the full contract text by default or only a compressed summary with drill-down.

---

## 13. Final Recommendation

Friday should adopt Anthropic's harness ideas as a visible artifact chain inside the existing assistant and generator product surfaces. The correct v1 is:

1. template-level borrowing, not full-harness adoption
2. shared artifacts, not file mailboxes
3. acceptance-backed verdicts, not free-text QA only
4. session-native handoff, not ad hoc context carryover

That is the smallest slice that materially improves Friday's planning rigor, QA rigor, and resumability without breaking the current source of truth.
