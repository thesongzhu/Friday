**AI Workflow Generator Design Plan (Friday-only, design-only)**

## 1) File-by-File Plan

1. `src/workflows/generator/model/friday-workflow-generator.types.ts`  
Estimated LOC: ~180  
Purpose: session lifecycle, turn IO, draft artifact, validation report types.

```ts
import type {
  FridayCompiledWorkflowGraphV2,
  FridayWorkflowSpecEdgeWhen,
  FridayWorkflowSpecInput,
  FridayWorkflowSpecOutput,
  FridayWorkflowSpecTestCase,
  FridayWorkflowSpecTrigger,
  FridayWorkflowSpecV1,
  FridayWorkflowVisualGraphV1,
} from "#workflows";
import type { WorkflowFailurePolicyV2 } from "#workflows";

export type FridayWorkflowGeneratorSessionStatus =
  | "collecting_requirements"
  | "needs_clarification"
  | "generating"
  | "ready_for_review"
  | "approved"
  | "saved"
  | "failed"
  | "cancelled";

export interface FridayWorkflowGenerationSession {
  sessionId: string;
  userId: string;
  channel: string;
  status: FridayWorkflowGeneratorSessionStatus;
  goal: string;
  requirementsSummary: string;
  openQuestions: string[];
  decisions: string[];
  draftWorkflowId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayWorkflowGenerationTurn {
  turnId: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export interface FridayStartWorkflowGenerationRequest {
  goal: string;
  requestedModel?: string;
  userId: string;
  channel: string;
}

export interface FridayWorkflowGenerationTurnRequest {
  message: string;
  requestedModel?: string;
}

export type FridayWorkflowGenerationTurnMode =
  | "clarification_required"
  | "preview_ready"
  | "generation_failed";

export interface FridayWorkflowGeneratorSkillContext {
  id: string;
  name: string;
  description: string;
  inputs: Array<{ key: string; type: string; required: boolean }>;
  outputs: Array<{ key: string; type: string }>;
}

export interface FridayWorkflowGenerationRequirements {
  goal: string;
  trigger: FridayWorkflowSpecTrigger;
  inputs: FridayWorkflowSpecInput[];
  plannedSteps: Array<{
    id: string;
    intent: string;
    nodeTypeHint: "action" | "condition" | "data" | "ai" | "approval";
    preferredSkillId?: string;
    condition?: string;
  }>;
  outputs: FridayWorkflowSpecOutput[];
  errorPolicy: WorkflowFailurePolicyV2;
  assumptions: string[];
  testScenarios: Array<{ name: string; description?: string }>;
}

export type FridayGeneratedWorkflowValidationStage =
  | "requirements"
  | "spec"
  | "visual"
  | "tests"
  | "compile"
  | "graph"
  | "skill_refs"
  | "draft_consistency";

export interface FridayGeneratedWorkflowValidationIssue {
  code: string;
  stage: FridayGeneratedWorkflowValidationStage;
  severity: "error" | "warning";
  message: string;
  path?: string;
  stepId?: string;
  edgeRef?: { from: string; to: string; when?: FridayWorkflowSpecEdgeWhen };
}

export interface FridayGeneratedWorkflowValidationReport {
  ok: boolean;
  issues: FridayGeneratedWorkflowValidationIssue[];
  repaired: boolean;
  repairAttempts: number;
}

export interface FridayGeneratedWorkflowDraft {
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
  tests: FridayWorkflowSpecTestCase[];
  compiledGraph: FridayCompiledWorkflowGraphV2;
  validation: FridayGeneratedWorkflowValidationReport;
}

export interface FridayWorkflowGenerationTurnResponse {
  session: FridayWorkflowGenerationSession;
  mode: FridayWorkflowGenerationTurnMode;
  questions?: string[];
  draft?: FridayGeneratedWorkflowDraft;
  errors?: FridayGeneratedWorkflowValidationIssue[];
}
```

2. `src/workflows/generator/prompts/friday-workflow-generator-prompts.ts`  
Estimated LOC: ~230  
Purpose: 4 prompt builders + shared prompt type.

```ts
import type { FridayWorkflowSpecV1, FridayWorkflowSpecTestCase } from "#workflows";
import type {
  FridayWorkflowGenerationRequirements,
  FridayWorkflowGenerationTurn,
  FridayWorkflowGeneratorSkillContext,
} from "../model/friday-workflow-generator.types.js";

export interface FridayWorkflowGeneratorPrompt {
  system: string;
  user: string;
}

export function buildWorkflowRequirementsPrompt(...): FridayWorkflowGeneratorPrompt;
export function buildWorkflowSpecPrompt(...): FridayWorkflowGeneratorPrompt;
export function buildWorkflowVisualLayoutPrompt(...): FridayWorkflowGeneratorPrompt;
export function buildWorkflowTestsPrompt(...): FridayWorkflowGeneratorPrompt;
```

3. `src/workflows/generator/persistence/friday-workflow-generation-session-repository.ts`  
Estimated LOC: ~240  
Purpose: session + turns persistence in `memory_items`.

```ts
import type { FridaySqliteLayer } from "#state";
import type {
  FridayWorkflowGenerationSession,
  FridayWorkflowGenerationTurn,
} from "../model/friday-workflow-generator.types.js";

export interface FridayWorkflowGenerationSessionRepository {
  createSession(session: FridayWorkflowGenerationSession): void;
  getSession(sessionId: string): FridayWorkflowGenerationSession | null;
  updateSession(session: FridayWorkflowGenerationSession): void;
  addTurn(turn: FridayWorkflowGenerationTurn): void;
  getTurns(sessionId: string): FridayWorkflowGenerationTurn[];
  deleteSession(sessionId: string): void;
}

export interface CreateWorkflowGenerationSessionRepositoryDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
}

export function createFridayWorkflowGenerationSessionRepository(
  deps: CreateWorkflowGenerationSessionRepositoryDeps,
): FridayWorkflowGenerationSessionRepository;
```

4. `src/workflows/generator/services/friday-workflow-generator-service.types.ts`  
Estimated LOC: ~90  
Purpose: service contract + dependency contract.

```ts
import type { FridaySqliteLayer } from "#state";
import type { FridayProviderService } from "#providers";
import type { FridaySkillRegistry } from "#skills";
import type { FridayWorkflowCrudService } from "#workflows";

import type {
  FridayGeneratedWorkflowDraft,
  FridayWorkflowGenerationSession,
  FridayWorkflowGenerationTurn,
  FridayWorkflowGenerationTurnRequest,
  FridayWorkflowGenerationTurnResponse,
  FridayStartWorkflowGenerationRequest,
} from "../model/friday-workflow-generator.types.js";

export interface FridayWorkflowGeneratorService {
  startSession(input: FridayStartWorkflowGenerationRequest): Promise<FridayWorkflowGenerationTurnResponse>;
  submitTurn(sessionId: string, input: FridayWorkflowGenerationTurnRequest): Promise<FridayWorkflowGenerationTurnResponse>;
  getSession(sessionId: string): Promise<{
    session: FridayWorkflowGenerationSession;
    turns: FridayWorkflowGenerationTurn[];
    draft?: FridayGeneratedWorkflowDraft;
  } | null>;
  generateDraft(sessionId: string, requestedModel?: string): Promise<FridayGeneratedWorkflowDraft>;
  approveAndSave(sessionId: string): Promise<{
    sessionId: string;
    workflowId: string;
    workflowVersionId: string;
    versionNumber: number;
    slug: string;
    published: boolean;
  }>;
  cancelSession(sessionId: string): Promise<void>;
}

export interface CreateFridayWorkflowGeneratorServiceDeps {
  db: FridaySqliteLayer;
  providerService: FridayProviderService;
  workflowCrud: FridayWorkflowCrudService;
  skillRegistry: FridaySkillRegistry;
  idGenerator: () => string;
  nowIso: () => string;
  computeChecksum: (content: string) => string;
}
```

5. `src/workflows/generator/validation/friday-generated-workflow-validator.ts`  
Estimated LOC: ~280  
Purpose: generated-artifact validation + compiled graph preview production.

```ts
import type { FridaySkillRegistry } from "#skills";
import type { FridayWorkflowCompiler, FridayWorkflowValidator } from "#workflows";
import type {
  FridayCompiledWorkflowGraphV2,
  FridayWorkflowSpecTestCase,
  FridayWorkflowSpecV1,
  FridayWorkflowVisualGraphV1,
} from "#workflows";
import type { FridayGeneratedWorkflowValidationIssue } from "../model/friday-workflow-generator.types.js";

export interface FridayGeneratedWorkflowValidator {
  validate(input: {
    spec: FridayWorkflowSpecV1;
    visual: FridayWorkflowVisualGraphV1;
    tests: FridayWorkflowSpecTestCase[];
  }): {
    compiledGraph?: FridayCompiledWorkflowGraphV2;
    issues: FridayGeneratedWorkflowValidationIssue[];
  };
}

export interface CreateFridayGeneratedWorkflowValidatorDeps {
  compiler: FridayWorkflowCompiler;
  workflowValidator: FridayWorkflowValidator;
  skillRegistry: FridaySkillRegistry;
  idGenerator: () => string;
}

export function createFridayGeneratedWorkflowValidator(
  deps: CreateFridayGeneratedWorkflowValidatorDeps,
): FridayGeneratedWorkflowValidator;
```

6. `src/workflows/generator/services/friday-workflow-generator-service.ts`  
Estimated LOC: ~950  
Purpose: main orchestrator (conversation, generation pipeline, repair loop, approve/save).

Key internal constants:
- `MAX_RECENT_TURNS = 12`
- `MAX_REPAIR_ATTEMPTS = 2`
- `DRAFT_NAMESPACE = "workflow-generator-draft"`

Key internal helpers:
- `saveDraft/loadDraft/deleteDraft`
- `runRequirementsAnalyzer`
- `generateSpec/generateVisual/generateTests`
- `runGenerationPipeline` (with repair context)
- `buildAvailableSkillContext`
- `slugify + makeUniqueSlug`
- `buildTurnResponse`

Export:
```ts
export function createFridayWorkflowGeneratorService(
  deps: CreateFridayWorkflowGeneratorServiceDeps,
): FridayWorkflowGeneratorService;
```

7. `src/workflows/generator/index.ts`  
Estimated LOC: ~75  
Purpose: module barrel exports (types, prompts, persistence, validation, service).

8. `src/api/http/routes/friday-workflow-generator-routes.ts`  
Estimated LOC: ~230  
Purpose: HTTP endpoints for workflow generator sessions.

```ts
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { FridayWorkflowGeneratorService } from "#workflows";

export interface FridayWorkflowGeneratorRoutesDeps {
  workflowGenerator: FridayWorkflowGeneratorService;
}

export function createFridayWorkflowGeneratorRoutes(
  deps: FridayWorkflowGeneratorRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[];
```

9. Tests (all requested files covered)  
Estimated LOC total: ~2,200  
Files in test plan section below.

---

## 2) New Type Definitions (Concrete)

Use the exact definitions from section 1 (`friday-workflow-generator.types.ts`) and add this internal analyzer shape in service file:

```ts
interface WorkflowRequirementsAnalyzerResponse {
  state: "needs_clarification" | "ready_for_generation";
  questions: string[];
  requirements: FridayWorkflowGenerationRequirements;
}
```

---

## 3) Prompt Templates (All 4)

### A) Requirements Analysis Prompt

```ts
system = `
You are an AI workflow requirements analyzer for Friday.

Goal:
Extract complete requirements for generating a FridayWorkflowSpecV1.

Rules:
1. Ask only blocking clarification questions (max 3).
2. Do not invent skill IDs; use only provided available skills.
3. If information is complete, set state="ready_for_generation".
4. If critical data is missing, set state="needs_clarification".
5. Return strict JSON only.

Response JSON:
{
  "state": "needs_clarification" | "ready_for_generation",
  "questions": ["..."],
  "requirements": {
    "goal": "string",
    "trigger": { "type": "manual" | "schedule" | "event", "cron?": "string", "timezone?": "string", "source?": "string", "event?": "string" },
    "inputs": [{ "key": "string", "type": "string|number|boolean|object|array", "required": true, "defaultValue?": "unknown" }],
    "plannedSteps": [{
      "id": "string",
      "intent": "string",
      "nodeTypeHint": "action|condition|data|ai|approval",
      "preferredSkillId?": "string",
      "condition?": "string"
    }],
    "outputs": [{ "key": "string", "fromStep": "string", "path": "string" }],
    "errorPolicy": { "onFailure": "fail_fast|continue_on_error|fallback_step|compensate|pause_for_approval", "notifyUser": true, "fallbackStepId?": "string", "compensationWorkflowId?": "string" },
    "assumptions": ["string"],
    "testScenarios": [{ "name": "string", "description?": "string" }]
  }
}
`;

user = `
User goal:
{{goal}}

Current requirements summary (JSON string; may be empty):
{{requirementsSummary}}

Open questions:
{{openQuestions}}

Available skills (id, name, description, IO):
{{availableSkillsJson}}

Recent conversation:
{{recentTurns}}
`;
```

### B) Spec Generation Prompt

```ts
system = `
You generate a valid FridayWorkflowSpecV1 JSON object.

Rules:
1. Output strict JSON only.
2. schemaVersion must be "1.0".
3. workflowId must be slug-safe lowercase (letters, numbers, hyphens).
4. startStepId must exist in steps.
5. Allowed step types: "skill_call" | "tool_call" | "condition" | "transform" | "human_approval".
6. For skill_call/tool_call, ref must be one of available skill IDs.
7. Allowed edge.when: "success" | "failure" | "true" | "false".
8. Conditions must use Friday expression syntax:
   - references: $inputs.<key>, $steps.<stepId>.output.<key>
   - operators: == != > < >= <= && || !
9. outputs[].fromStep must reference an existing step.
10. tests must be [] (generated separately in next stage).
11. Keep graph acyclic and connected from startStepId.
12. Return a complete FridayWorkflowSpecV1 object only.

Target shape:
{
  "schemaVersion": "1.0",
  "workflowId": "string",
  "name": "string",
  "description": "string",
  "startStepId": "string",
  "trigger": { ... },
  "inputs": [...],
  "steps": [...],
  "edges": [...],
  "outputs": [...],
  "errorPolicy": { ... },
  "tests": []
}
`;

user = `
Requirements:
{{requirementsJson}}

Available skills:
{{availableSkillsJson}}
`;
```

### C) Visual Layout Prompt

```ts
system = `
You generate a valid FridayWorkflowVisualGraphV1 JSON object for the given spec.

Rules:
1. Output strict JSON only.
2. schemaVersion must be "1.0".
3. workflowId must equal spec.workflowId.
4. nodes must include "__trigger__" and every spec step id exactly once.
5. x/y must be finite numbers.
6. Use readable layout: left-to-right flow, branch paths separated vertically.
7. viewport = { x: 0, y: 0, zoom: 1 }.
8. panelLayout = { leftOpen: true, rightOpen: false, bottomOpen: false }.
9. edges entries should map spec edges with edgeKey:
   "\${from}:\${to}:\${when ?? 'any'}".
10. Return FridayWorkflowVisualGraphV1 JSON only.
`;

user = `
Generate visual layout for this workflow spec:
{{specJson}}
`;
```

### D) Test Case Generation Prompt

```ts
system = `
You generate workflow test cases for FridayWorkflowSpecV1.

Rules:
1. Output strict JSON only: FridayWorkflowSpecTestCase[].
2. Generate 2-4 meaningful test cases.
3. Use only known input keys, step IDs, and output keys from the spec.
4. Each test requires:
   - name
   - inputs
   - assertions (at least 1)
5. Optional mocks must reference valid step IDs.
6. Allowed operators: "==" | "!=" | ">" | "<" | "contains" | "matches".
7. Assertion path should target execution context:
   - "inputs.<key>"
   - "steps.<stepId>.output.<key>"
   - "outputs.<key>"
8. Include branch coverage for condition steps when present.
9. Include at least one failure-path test when edges include "failure".
10. Return JSON array only.
`;

user = `
Generate tests for this workflow spec:
{{specJson}}
`;
```

---

## 4) Service Methods and Behavior

```ts
startSession(input): Promise<FridayWorkflowGenerationTurnResponse>
submitTurn(sessionId, input): Promise<FridayWorkflowGenerationTurnResponse>
getSession(sessionId): Promise<{ session; turns; draft? } | null>
generateDraft(sessionId, requestedModel?): Promise<FridayGeneratedWorkflowDraft>
approveAndSave(sessionId): Promise<{ sessionId; workflowId; workflowVersionId; versionNumber; slug; published }>
cancelSession(sessionId): Promise<void>
```

Behavior details:

1. `startSession`
- Create session (`collecting_requirements`), persist first user turn.
- Run requirements analyzer prompt.
- Persist updated session summary/open questions.
- If clarification needed: return `mode="clarification_required"`.
- If ready: run generation pipeline and return preview or generation failure.

2. `submitTurn`
- Reject if session status is `approved|saved|cancelled`.
- Persist user turn, rerun requirements analyzer on recent turns.
- Same branching as `startSession`.

3. `generateDraft`
- Force generation from persisted `requirementsSummary`.
- Reject if no parseable requirements summary.
- Set session `generating`, run pipeline, persist draft, set status `ready_for_review|failed`.

4. `runGenerationPipeline` (core)
- Build available skill context from `skillRegistry.list()`.
- Attempt loop: 0..2 repairs.
- Per attempt call order:
  - spec generation
  - visual layout generation
  - test generation
- Merge tests into spec (`spec.tests = tests`).
- Validate via `friday-generated-workflow-validator`.
- If errors: add `_repairContext` into next spec-generation input.
- Persist final draft with `validation.repairAttempts/repaired`.

5. `approveAndSave`
- Require session status `ready_for_review`.
- Load persisted draft.
- Require `draft.validation.ok === true`.
- Derive unique slug (`workflowCrud.getWorkflowBySlug` loop with suffix `-2`, `-3`, ...).
- `createWorkflow({ slug, name, description })`
- `createVersion(workflow.id, draft.compiledGraph)`
- `publishVersion(workflow.id, version.versionNumber)`
- Update session status `approved` then `saved`.
- Delete draft record.
- Return workflow IDs + version + slug + published flag.

6. `cancelSession`
- Reject only if already `saved`.
- Set status `cancelled`.
- Delete persisted draft.

---

## 5) API Routes

Add `src/api/http/routes/friday-workflow-generator-routes.ts` with 6 endpoints.

1. `POST /v1/workflows/generator/sessions`  
Operation: `workflows.generator.sessions.create`  
Auth: `workflow.write`  
Request:
```json
{ "goal": "string", "requestedModel?": "string", "userId": "string", "channel": "string" }
```
Response: `FridayWorkflowGenerationTurnResponse`

2. `GET /v1/workflows/generator/sessions/:sessionId`  
Operation: `workflows.generator.sessions.get`  
Auth: `workflow.read`  
Response:
```json
{ "session": {...}, "turns": [...], "draft?": {...} }
```

3. `POST /v1/workflows/generator/sessions/:sessionId/messages`  
Operation: `workflows.generator.sessions.messages.create`  
Auth: `workflow.write`  
Request:
```json
{ "message": "string", "requestedModel?": "string" }
```
Response: `FridayWorkflowGenerationTurnResponse`

4. `POST /v1/workflows/generator/sessions/:sessionId/generate`  
Operation: `workflows.generator.sessions.generate`  
Auth: `workflow.write`  
Request:
```json
{ "requestedModel?": "string" }
```
Response:
```json
{ "draft": FridayGeneratedWorkflowDraft }
```

5. `POST /v1/workflows/generator/sessions/:sessionId/approve`  
Operation: `workflows.generator.sessions.approve`  
Auth: `workflow.write`  
Rate limit: `workflow.publish`  
Response:
```json
{
  "sessionId": "string",
  "workflowId": "string",
  "workflowVersionId": "string",
  "versionNumber": 2,
  "slug": "string",
  "published": true
}
```

6. `DELETE /v1/workflows/generator/sessions/:sessionId`  
Operation: `workflows.generator.sessions.cancel`  
Auth: `workflow.write`  
Response:
```json
{ "cancelled": true }
```

Also extend `src/api/model/friday-api-workflow.types.ts` with request/response interfaces for these payloads.

---

## 6) Wiring Plan

Modify these existing files:

1. `src/workflows/index.ts`
- Export generator model types, prompt builders, repo factory/types, validator factory/type, service factory/type.

2. `src/api/runtime/friday-api-runtime.types.ts`
- Add optional dependency and runtime handle:
```ts
workflowGenerator?: FridayWorkflowGeneratorService;
```

3. `src/api/runtime/friday-api-runtime.ts`
- Import `createFridayWorkflowGeneratorRoutes`.
- Conditionally register when `deps.workflowGenerator` exists.
- Return `workflowGenerator` on runtime object.

4. `src/api/index.ts`
- Export `createFridayWorkflowGeneratorRoutes` and deps type.
- No new API barrel file needed if generator request/response types are added into `friday-api-workflow.types.ts`.

5. `src/hub/friday-hub-bootstrap.ts`
- Instantiate workflow generator service after workflow runtime:
```ts
const workflowGenerator = createFridayWorkflowGeneratorService({
  db: stateRuntime.sqlite,
  providerService,
  workflowCrud: workflowRuntime.crud,
  skillRegistry: registry,
  idGenerator,
  nowIso,
  computeChecksum,
});
```
- Pass to `createFridayApiRuntime({ workflowGenerator, ... })`.
- Add `workflowGenerator` to `FridayHub` interface and returned hub object.

6. `src/hub/index.ts`
- If desired for convenience, re-export workflow generator service type from `#workflows` (optional).

---

## 7) Test Plan

Create these test files:

1. `test/unit/workflows/generator/model/friday-workflow-generator.types.test.ts`
- Status union coverage.
- Session/turn/request/response structural validity.
- Draft and validation report shape checks.

2. `test/unit/workflows/generator/prompts/friday-workflow-generator-prompts.test.ts`
- Each prompt returns `system` and `user`.
- JSON-only instructions present.
- Requirements prompt includes open questions + conversation + available skills.
- Spec prompt enforces allowed step types and expression syntax.
- Visual prompt contains edgeKey rule.
- Tests prompt contains operator/path constraints.

3. `test/unit/workflows/generator/persistence/friday-workflow-generation-session-repository.test.ts`
- Session create/get/update/delete.
- Turn add/get ordering.
- Session isolation across IDs.
- Not-found update throws.

4. `test/unit/workflows/generator/validation/friday-generated-workflow-validator.test.ts`
- Valid artifacts produce no error issues and compiled graph.
- Unknown skill ref -> `error`.
- Missing step node in visual -> `error`.
- Orphan visual node -> `warning`.
- Invalid test operator/path -> `error`.
- Compile or graph validation errors map into issues.

5. `test/unit/workflows/generator/services/friday-workflow-generator-service.test.ts`
- `startSession` clarification flow.
- `startSession` ready flow auto-generates draft.
- `submitTurn` progression.
- `generateDraft` from summary.
- Repair loop increments attempts and succeeds on 2nd/3rd try.
- `approveAndSave` invokes CRUD create/version/publish.
- `approveAndSave` rejects invalid draft.
- `cancelSession` transitions and cleans draft.

6. `test/unit/workflows/generator/index.test.ts`
- Barrel exports are defined/importable.

7. `test/unit/api/http/routes/friday-workflow-generator-routes.test.ts`
- Route count = 6.
- Operation IDs/method/path/auth correctness.
- Body validation failures.
- Delegation to service methods with expected args.
- Not-found session maps to thrown domain error.

8. `test/unit/api/runtime/friday-api-runtime-workflow-generator-registration.test.ts`
- Routes register only when `workflowGenerator` is provided.
- No `workflows.generator.*` routes when omitted.
- Runtime handle exposes `workflowGenerator` when provided.

9. Update `test/integration/hub/friday-hub-bootstrap-integration.test.ts`
- Assert `hub.workflowGenerator` is defined.

---

## 8) Implementation Order

1. Add `src/workflows/generator/model/friday-workflow-generator.types.ts`.
2. Add prompts file.
3. Add session repository file.
4. Add generated workflow validator file.
5. Add service types file.
6. Implement main service file.
7. Add generator barrel `src/workflows/generator/index.ts`.
8. Add workflow generator route file.
9. Extend API workflow model types in `src/api/model/friday-api-workflow.types.ts`.
10. Wire exports in `src/workflows/index.ts` and `src/api/index.ts`.
11. Wire API runtime deps + route registration.
12. Wire hub bootstrap service construction + injection.
13. Add all unit tests.
14. Add runtime registration test + hub integration assertion update.
15. Run targeted tests for new module, routes, runtime wiring, then full suite.