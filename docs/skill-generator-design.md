# Friday AI Skill Generator (v1) – Architecture Design

## 1) Generation Pipeline

1. User starts a generation session with a natural-language request (`POST /v1/skills/generator/sessions`).
2. `FridaySkillGeneratorService` stores a session record and first user turn in `memory_items` (no new DB tables in v1).
3. The service runs an **intent/requirements analyzer** prompt through `FridayProviderService.runWithFallback(...)`.
4. The analyzer returns one of two outcomes.
Outcome A: `needs_clarification` with up to 3 targeted questions.
Outcome B: `ready_for_generation` with a normalized `SkillGenerationSpec`.
5. Clarification loop continues on `POST /v1/skills/generator/sessions/:sessionId/messages` until required fields are resolved.
6. Once ready, artifact generation runs in this order.
Step A: Manifest generation (`SkillManifestV2` JSON).
Step B: Code generation (shell or node bundle).
Step C: UI generation (`skill.ui.json`).
7. Validation pipeline runs.
Stage A: structure/schema validation.
Stage B: code safety validation.
Stage C: existing skill package validation (`validateFridaySkillPackage`).
Stage D: UI schema validation and cross-check against manifest.
8. If validation fails, the service runs an auto-repair loop (max 2 retries) with structured errors fed back to the model.
9. Service returns a preview package for user review.
10. User confirms (`POST /v1/skills/generator/sessions/:sessionId/approve`).
11. Service writes files to local workspace path: `<workspaceDir>/skills/<skillId>/`.
12. Service marks status installed via `FridayHubMemoryStateService.updateSkillStatus(...)`, then calls `FridaySkillRegistry.refresh()`.
13. Skill is immediately invocable by ID and resolvable by intent.

### Context Window Management (multi-turn)

1. Session state keeps `specSummary`, `openQuestions`, `decisions`, and `recentTurns`.
2. Raw turns are capped (for example last 12 turns).
3. Older turns are summarized into `specSummary` once token budget threshold is hit.
4. Every model call uses:
`system prompt + specSummary + openQuestions + recentTurns + current user turn`.

---

## 2) Data Model (TypeScript)

```ts
export type FridaySkillGeneratorSessionStatus =
  | "collecting_requirements"
  | "needs_clarification"
  | "generating"
  | "ready_for_review"
  | "approved"
  | "saved"
  | "failed"
  | "cancelled";

export interface FridaySkillGenerationSession {
  sessionId: string;
  userId: string;
  channel: string;
  status: FridaySkillGeneratorSessionStatus;
  goal: string;
  specSummary: string;
  openQuestions: string[];
  decisions: string[];
  draftSkillId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridaySkillGenerationTurn {
  turnId: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export interface FridayStartSkillGenerationRequest {
  goal: string;
  requestedModel?: string;
  userId: string;
  channel: string;
}

export interface FridaySkillGenerationTurnRequest {
  message: string;
  requestedModel?: string;
}

export type FridaySkillGenerationTurnMode =
  | "clarification_required"
  | "preview_ready"
  | "generation_failed";

export interface FridaySkillGenerationTurnResponse {
  session: FridaySkillGenerationSession;
  mode: FridaySkillGenerationTurnMode;
  questions?: string[];
  draft?: FridayGeneratedSkillDraft;
  errors?: FridayGeneratedSkillValidationIssue[];
}

export interface FridayGeneratedSkillFile {
  path: string;               // ex: "index.mjs", "run.sh", "skill.ui.json"
  language: "json" | "javascript" | "typescript" | "bash" | "markdown";
  executable?: boolean;
  content: string;
}

export interface FridayGeneratedSkillDraft {
  manifest: SkillManifestV2;
  files: FridayGeneratedSkillFile[];
  uiSchema: FridaySkillUiSchemaV1;
  runtimeKind: "shell" | "node";
  validation: FridayGeneratedSkillValidationReport;
}

export interface FridayGeneratedSkillValidationIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  path?: string;
}

export interface FridayGeneratedSkillValidationReport {
  ok: boolean;
  issues: FridayGeneratedSkillValidationIssue[];
  repaired: boolean;
  repairAttempts: number;
}
```

---

## 3) Service Interface (`FridaySkillGeneratorService`)

```ts
export interface FridaySkillGeneratorService {
  startSession(
    input: FridayStartSkillGenerationRequest
  ): Promise<FridaySkillGenerationTurnResponse>;

  submitTurn(
    sessionId: string,
    input: FridaySkillGenerationTurnRequest
  ): Promise<FridaySkillGenerationTurnResponse>;

  getSession(sessionId: string): Promise<{
    session: FridaySkillGenerationSession;
    turns: FridaySkillGenerationTurn[];
    draft?: FridayGeneratedSkillDraft;
  } | null>;

  generateDraft(
    sessionId: string,
    requestedModel?: string
  ): Promise<FridayGeneratedSkillDraft>;

  approveAndSave(sessionId: string): Promise<{
    sessionId: string;
    skillId: string;
    skillDir: string;
    savedFiles: string[];
    registryRefreshed: boolean;
  }>;

  cancelSession(sessionId: string): Promise<void>;
}

export interface CreateFridaySkillGeneratorServiceDeps {
  db: FridaySqliteLayer;
  providerService: FridayProviderService;
  registry: FridaySkillRegistry;
  configManager: FridayHubConfigManagerService;
  memoryStateService: FridayHubMemoryStateService;
  idGenerator: () => string;
  nowIso: () => string;
}
```

---

## 4) Prompt Engineering

### Prompt A: Requirements/Clarification (planner)

System rules:
1. Extract task goal, inputs, outputs, triggers, external dependencies, and security-sensitive actions.
2. Ask only missing, blocking questions (max 3).
3. Return strict JSON only:
`{ "state": "needs_clarification" | "ready_for_generation", "questions": [], "spec": {...} }`.
4. Prefer deterministic automation over open-ended agent behavior.

### Prompt B: Manifest Generator

System rules:
1. Output valid `SkillManifestV2` JSON only.
2. Minimize permissions (`principle of least privilege`).
3. If AI is required inside runtime logic, force `runtime.kind = "node"` and include only required grants.
4. Ensure `inputs`, `outputs`, `invocation`, `triggers`, and `requirements` are complete and internally consistent.
5. Set `runtime.entrypoint` to generated runtime file path.

### Prompt C: Code Generator

System rules:
1. Output JSON array of files with path/content/language metadata only.
2. Conform to Friday executor contracts:
Node: exports `async function execute(input, ctx?)`.
Shell: reads JSON from stdin, writes JSON to stdout.
3. No privileged actions without matching manifest permissions.
4. If AI is needed, use provided runtime context helper (backed by BYOK provider service).
5. Favor small, readable code and explicit error handling.

### Prompt D: UI Generator

System rules:
1. Output valid `FridaySkillUiSchemaV1` JSON only.
2. Every UI input key must map to `manifest.inputs`.
3. Every UI output binding must map to `manifest.outputs`.
4. Keep v1 layout simple: form sections + run action + output renderers.

---

## 5) Validation and Safety

1. Parse and schema-check all model outputs (manifest JSON, file bundle JSON, UI JSON).
2. Validate manifest with existing schema parser (`safeParseFridaySkillManifestV2`) and defaults.
3. Enforce file rules.
Rule A: required files exist.
Rule B: path traversal blocked.
Rule C: max file count and size limits.
4. Static code safety checks.
Node checks: block dangerous imports unless explicitly permitted (`child_process`, unrestricted `fs`, arbitrary `net`).
Shell checks: enforce strict shebang and command allowlist policy; reject unsafe patterns.
5. Permission congruence checks.
Code behavior must match declared permissions.
Filesystem scopes must pass existing scope validator.
6. For node TypeScript generation, transpile to runnable JS (`index.mjs`) before save.
7. Stage artifacts in temp directory and run existing package validation (`validateFridaySkillPackage`).
8. Validate `skill.ui.json` against UI schema and cross-check manifest input/output keys.
9. Optional smoke validation with synthetic input under executor timeout.
10. On failure, structured errors go into repair prompt (up to 2 attempts), then fail hard if still invalid.
11. Nothing is persisted to skill directory until validation passes and user approves.

Security guarantee in v1:
Generated code is executed by existing Friday skill executor path, with existing timeout and validation boundaries, and with no automatic escalation.

---

## 6) UI Schema Format (`skill.ui.json`)

```ts
export interface FridaySkillUiSchemaV1 {
  schemaVersion: "1.0";
  title: string;
  description?: string;
  sections: FridaySkillUiSection[];
  fields: FridaySkillUiField[];
  outputs: FridaySkillUiOutput[];
  actions: FridaySkillUiAction[];
}

export interface FridaySkillUiSection {
  id: string;
  label: string;
  fieldIds: string[];
}

export type FridaySkillUiFieldKind =
  | "text"
  | "textarea"
  | "number"
  | "toggle"
  | "select"
  | "json"
  | "file";

export interface FridaySkillUiField {
  id: string;
  inputKey: string; // must match manifest.inputs[key]
  kind: FridaySkillUiFieldKind;
  label: string;
  required: boolean;
  help?: string;
  placeholder?: string;
  defaultValue?: unknown;
  validation?: { regex?: string; min?: number; max?: number; enum?: string[] };
}

export type FridaySkillUiOutputWidget =
  | "text"
  | "json"
  | "table"
  | "keyValue";

export interface FridaySkillUiOutput {
  id: string;
  outputKey: string; // must match manifest.outputs[key]
  label: string;
  widget: FridaySkillUiOutputWidget;
}

export interface FridaySkillUiAction {
  id: "run" | "reset";
  label: string;
  style: "primary" | "secondary";
}
```

Storage format:
Skill-local file `skill.ui.json` in the skill directory.

Renderer behavior:
Web app consumes this schema and renders form, action buttons, and output widgets without custom React code per skill.

---

## 7) API Endpoints (REST)

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `POST` | `/v1/skills/generator/sessions` | `skill.write` | Start session with initial goal. |
| `GET` | `/v1/skills/generator/sessions/:sessionId` | `skill.read` | Fetch session, turns, and current draft (if any). |
| `POST` | `/v1/skills/generator/sessions/:sessionId/messages` | `skill.write` | Submit next user turn; returns questions or preview. |
| `POST` | `/v1/skills/generator/sessions/:sessionId/generate` | `skill.write` | Force generation attempt from current spec. |
| `POST` | `/v1/skills/generator/sessions/:sessionId/approve` | `skill.write` | Persist validated draft, refresh registry, activate skill. |
| `DELETE` | `/v1/skills/generator/sessions/:sessionId` | `skill.write` | Cancel/close generation session. |
| `GET` | `/v1/skills/:skillId/ui` | `skill.read` | Return parsed `skill.ui.json` for skill page rendering. |

Notes:
1. Route naming follows existing operationId pattern (`skills.generator.sessions.create`, etc.).
2. v1 keeps generation local-only; no marketplace routes.

---

## 8) File Plan

### New Files

1. `src/skills/generator/model/friday-skill-generator.types.ts`
2. `src/skills/generator/model/friday-skill-ui-schema.types.ts`
3. `src/skills/generator/persistence/friday-skill-generation-session-repository.ts`
4. `src/skills/generator/prompts/friday-skill-generator-prompts.ts`
5. `src/skills/generator/llm/friday-provider-inference-client.types.ts`
6. `src/skills/generator/llm/friday-provider-inference-client.ts`
7. `src/skills/generator/validation/friday-generated-skill-safety-validator.ts`
8. `src/skills/generator/validation/friday-generated-skill-ui-validator.ts`
9. `src/skills/generator/services/friday-skill-generator-service.types.ts`
10. `src/skills/generator/services/friday-skill-generator-service.ts`
11. `src/skills/generator/index.ts`
12. `src/api/model/friday-api-skill-generator.types.ts`
13. `src/api/http/routes/friday-skill-generator-routes.ts`

### Files to Modify

1. `src/skills/index.ts` (export generator module/types)
2. `src/skills/manifest/friday-skill-package-loader.ts` (include `skill.ui.json` in declared files/watch targets)
3. `src/skills/executor/friday-skill-executor.types.ts` (optional node execution context for BYOK AI helper)
4. `src/skills/executor/friday-node-executor.ts` (pass optional runtime context to `execute`)
5. `src/skills/executor/friday-skill-executor.ts` (inject BYOK-backed AI helper context for node skills)
6. `src/api/index.ts` (export new API model types)
7. `src/api/runtime/friday-api-runtime.types.ts` (add `skillGenerator` dependency and runtime surface)
8. `src/api/runtime/friday-api-runtime.ts` (wire route registration for skill generator)
9. `src/hub/friday-hub-bootstrap.ts` (instantiate generator service and expose on hub interface)

DB impact:
No new migration required in v1 because session/draft persistence uses existing `memory_items` namespaces.

---

## 9) Integration: Providers, Skills, Hub

### Provider Integration (BYOK)

1. Generator uses `FridayProviderService.runWithFallback(...)` for every LLM call.
2. `FridayProviderInferenceClient` adapts request payloads to provider API flavors (`openai-responses`, `anthropic-messages`, `google-generative-ai`, `ollama`, etc.).
3. Credential handling remains inside provider service; generator never stores raw keys.

### Skills Integration

1. Approved drafts are saved as local skill packages:
`<workspaceDir>/skills/<skillId>/skill.manifest.json`
`<workspaceDir>/skills/<skillId>/skill.ui.json`
`<workspaceDir>/skills/<skillId>/index.mjs` or `run.sh`
2. Service updates lifecycle status to installed and refreshes registry.
3. Skill becomes immediately available to executor and intent resolution.

### Hub Integration

1. `createFridayHub(...)` composes and exposes `skillGenerator` alongside `providerService`, `skills`, and `executor`.
2. API runtime receives `skillGenerator` via deps and registers generator routes.
3. This keeps architecture consistent with existing compositional runtime patterns (`workflows`, `marketplace`, `providers`).

---

This design keeps v1 simple, local-only, BYOK-driven, and immediately executable while enforcing manifest/code/UI validation before any skill is persisted.