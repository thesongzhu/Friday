**Phase 3B Design (for CC)**

**Contract Notes (from current code)**
1. Automation route param is `:automationId` (not `:id`) in `src/api/http/routes/friday-agent-routes.ts`.
2. Automation record shape includes `runCount`, `lastRunId`, `lastRunAt`, `variables`, `skillIds`, `workflowIds`, `triggerId`.
3. Skill routes currently exposed are generator sessions, converter/import/pack, and `GET /v1/skills/:skillId/ui`.
4. Inference from current routes: there is no dedicated `GET /v1/skills` list endpoint and no direct `POST /v1/skills/:skillId/run`; this plan uses a local Skills catalog (seeded by import/generator) and runs skills through `POST /v1/agent/runs` with a deterministic task builder.

---

**1) New File Tree (every new file)**

```text
ui/src/routes/automations-page.tsx
ui/src/routes/automation-detail-page.tsx
ui/src/routes/skills-page.tsx
ui/src/routes/skill-detail-page.tsx
ui/src/routes/skill-generator-page.tsx

ui/src/lib/api/automations.ts
ui/src/lib/api/skills.ts
ui/src/lib/storage/automation-run-log-storage.ts
ui/src/lib/storage/skills-catalog-storage.ts
ui/src/lib/skills/build-skill-run-task.ts

ui/src/hooks/use-automation-run-log.ts
ui/src/hooks/use-skills-catalog.ts

ui/src/components/automations/automation-card.tsx
ui/src/components/automations/automation-form-modal.tsx
ui/src/components/automations/automation-variable-editor.tsx
ui/src/components/automations/automation-run-history-list.tsx

ui/src/components/skills/skill-card.tsx
ui/src/components/skills/skill-runtime-icon.tsx
ui/src/components/skills/skills-import-tab.tsx
ui/src/components/skills/converter-preview-panel.tsx
ui/src/components/skills/skill-generator-chat.tsx

ui/src/components/shared/modal.tsx
ui/src/components/shared/confirm-dialog.tsx
ui/src/components/shared/file-dropzone.tsx
ui/src/components/shared/dynamic-skill-form.tsx
ui/src/components/shared/segmented-tabs.tsx
```

**Modified existing files**
- `ui/src/router.tsx`
- `ui/src/lib/api/types.ts`
- `ui/src/components/shared/status-badge.tsx` (add `pending`)
- `ui/src/lib/api/agent.ts` (small type alignment only, keep API behavior)

---

**2) API Modules (typed functions for each endpoint)**

**`ui/src/lib/api/automations.ts`**
```ts
export interface AgentAutomationRecord {
  id: string;
  name: string;
  description?: string;
  sourceRunId?: string;
  taskTemplate: string;
  variables?: Record<string, string>;
  skillIds?: string[];
  workflowIds?: string[];
  triggerId?: string;
  enabled: boolean;
  lastRunId?: string;
  lastRunAt?: string;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAutomationInput {
  name: string;
  description?: string;
  sourceRunId?: string;
  taskTemplate: string;
  variables?: Record<string, string>;
  skillIds?: string[];
  workflowIds?: string[];
  triggerId?: string;
  enabled?: boolean;
}

export interface UpdateAutomationInput {
  name?: string;
  description?: string;
  taskTemplate?: string;
  variables?: Record<string, string>;
  skillIds?: string[];
  workflowIds?: string[];
  triggerId?: string;
  enabled?: boolean;
}

export interface RunAutomationInput {
  taskOverride?: string;
  providerId?: string;
  model?: string;
  timeoutMs?: number;
}

export interface AgentRuntimeResult {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  response: string;
  toolCallCount: number;
  durationMs: number;
  usageInput: number;
  usageOutput: number;
}

export const automationsApi = {
  list(query?: { enabled?: boolean; limit?: number; cursor?: string }): Promise<AgentAutomationRecord[]>,
  create(input: CreateAutomationInput): Promise<AgentAutomationRecord>,
  get(automationId: string): Promise<AgentAutomationRecord>,
  update(automationId: string, patch: UpdateAutomationInput): Promise<AgentAutomationRecord>,
  remove(automationId: string): Promise<{ deleted: true; automationId: string }>,
  run(automationId: string, input?: RunAutomationInput): Promise<AgentRuntimeResult>,
};
```

Calls:
- `GET /v1/agent/automations`
- `POST /v1/agent/automations`
- `GET /v1/agent/automations/:automationId`
- `PATCH /v1/agent/automations/:automationId`
- `DELETE /v1/agent/automations/:automationId`
- `POST /v1/agent/automations/:automationId/run`

---

**`ui/src/lib/api/skills.ts`**
```ts
export const skillsApi = {
  startGeneratorSession(input: { goal: string; requestedModel?: string; userId: string; channel: string }): Promise<FridayStartSessionResponse>,
  getGeneratorSession(sessionId: string): Promise<FridayGetSessionResponse>,
  submitGeneratorMessage(sessionId: string, input: { message: string; requestedModel?: string }): Promise<FridaySubmitTurnResponse>,
  generateDraft(sessionId: string, input?: { requestedModel?: string }): Promise<FridayGenerateResponse>,
  approveSession(sessionId: string): Promise<FridayApproveResponse>,
  cancelSession(sessionId: string): Promise<{ cancelled: true }>,

  listConverters(): Promise<FridayApiListConvertersResponse["converters"]>,
  convert(input: FridayApiConvertRequest): Promise<FridayApiConvertResponse>,
  import(input: FridayApiImportRequest): Promise<FridayApiImportResponse>,
  pack(input: FridayApiPackRequest): Promise<FridayApiPackResponse>,

  getSkillUi(skillId: string): Promise<FridaySkillUiSchemaV1>,
};
```

Calls:
- `POST /v1/skills/generator/sessions`
- `GET /v1/skills/generator/sessions/:sessionId`
- `POST /v1/skills/generator/sessions/:sessionId/messages`
- `POST /v1/skills/generator/sessions/:sessionId/generate`
- `POST /v1/skills/generator/sessions/:sessionId/approve`
- `DELETE /v1/skills/generator/sessions/:sessionId`
- `GET /v1/skills/converters`
- `POST /v1/skills/convert`
- `POST /v1/skills/import`
- `POST /v1/skills/pack`
- `GET /v1/skills/:skillId/ui`

---

**3) Reusable Components Needed**

1. `ui/src/components/shared/modal.tsx`  
Props: `open`, `title`, `description?`, `onClose`, `children`, `footer?`, `widthClassName?`.  
Logic: portal, ESC close, backdrop close, body-scroll lock.

2. `ui/src/components/shared/confirm-dialog.tsx`  
Props: `open`, `title`, `description`, `confirmLabel`, `cancelLabel`, `confirmVariant`, `isLoading`, `onConfirm`, `onClose`.  
Logic: built on `Modal`; used by automation delete.

3. `ui/src/components/shared/file-dropzone.tsx`  
Props: `accept`, `maxSizeMb?`, `disabled?`, `onFile`, `label`, `helperText?`.  
Logic: drag-over UI + click-to-select input.

4. `ui/src/components/shared/segmented-tabs.tsx`  
Props: `items`, `value`, `onChange`.  
Logic: lightweight tab control for `My Skills | Import`.

5. `ui/src/components/shared/dynamic-skill-form.tsx`  
Props: `schema`, `disabled?`, `initialValues?`, `submitLabel?`, `onSubmit`, `onReset?`.  
Logic: render fields by `kind` (`text`, `textarea`, `number`, `toggle`, `select`, `json`, `file`), section ordering from schema, required validation, regex/min/max checks, JSON parsing, file-to-base64 conversion.

6. `ui/src/components/automations/automation-variable-editor.tsx`  
Props: `value`, `onChange`, `disabled?`.  
Logic: editable key/value rows for `variables`.

---

**4) Component Specs (props, logic, API calls)**

1. `ui/src/routes/automations-page.tsx`  
Props: none.  
Logic: query automations list; card grid; create/edit modal state; delete confirm state; live run state (`runId`, `taskTemplate`); optimistic enabled toggle.  
API calls: list/create/update/delete/run automation; invalidate `["agent-automations"]`; show `LiveRunPanel` on run.

2. `ui/src/components/automations/automation-card.tsx`  
Props: `automation`, `onOpenDetail`, `onRun`, `onEdit`, `onDelete`, `onToggleEnabled`, `isRunning?`, `isMutating?`.  
Logic: clickable card, action buttons stop propagation, displays name/description/enabled/runCount/lastRunAt.

3. `ui/src/components/automations/automation-form-modal.tsx`  
Props: `open`, `mode`, `initialValues?`, `isSubmitting?`, `onSubmit`, `onClose`.  
Logic: form for `name`, `description`, `taskTemplate`, `variables`, `enabled`; local validation; maps variables rows to `Record<string,string>`.

4. `ui/src/routes/automation-detail-page.tsx`  
Props: none.  
Logic: `useParams().automationId`; load detail; run/edit/delete controls; run history panel; live run panel after run click.  
API calls: get/update/delete/run automation, run history fetch via `agentApi.getRun` for known run IDs.

5. `ui/src/components/automations/automation-run-history-list.tsx`  
Props: `automationId`, `lastRunId?`.  
Logic: merges `lastRunId` + local run log IDs from storage, fetches runs with `Promise.all(agentApi.getRun)`, renders status/duration/time list.

6. `ui/src/routes/skills-page.tsx`  
Props: none.  
Logic: segmented tabs; `My Skills` uses local catalog hook; `Import` mounts import tab; “+ Create Skill” navigates to `/skills/generator/new`; optional “Open skill by ID” input for non-catalog skills.  
API calls: none on My Skills tab; import tab handles converter/import calls.

7. `ui/src/components/skills/skill-card.tsx`  
Props: `skill`, `onOpen`.  
Logic: shows name, description, runtime icon, last used timestamp; click to detail route.

8. `ui/src/components/skills/skills-import-tab.tsx`  
Props: `onImported`.  
Logic: source mode (file/url), converter format selection, preview before install, install action, render import results.  
API calls: `GET /v1/skills/converters`, `POST /v1/skills/convert`, `POST /v1/skills/import`.

9. `ui/src/components/skills/converter-preview-panel.tsx`  
Props: `preview`, `selectedSkillIds`, `onToggleSkill`.  
Logic: shows draft manifest summary per skill, warnings, validation issues, selected set for install.

10. `ui/src/routes/skill-generator-page.tsx`  
Props: none.  
Logic: page shell + `SkillGeneratorChat`, back link to `/skills`.

11. `ui/src/components/skills/skill-generator-chat.tsx`  
Props: `onSaved`.  
Logic: start session form (`goal`, optional model); transcript; submit follow-up message; force generate; approve/save; cancel session; draft summary sidebar.  
API calls: all generator session endpoints; on approve adds skill to local catalog and navigates to detail.

12. `ui/src/routes/skill-detail-page.tsx`  
Props: none.  
Logic: load `skillId` UI schema, render dynamic form, run action, last-used update, live run panel.  
API calls: `GET /v1/skills/:skillId/ui`; run uses `agentApi.startRun` with `buildSkillRunTask(...)` (inference adapter).

13. `ui/src/components/shared/dynamic-skill-form.tsx`  
Props/logic above.  
API calls: none; parent handles submit.

---

**5) Storage + Hooks**

1. `ui/src/lib/storage/skills-catalog-storage.ts`  
Key: `friday.skills.catalog.v1`.  
Shape: `skillId`, `name`, `description`, `runtimeKind`, `icon?`, `installedAt`, `lastUsedAt?`, `source: "generator" | "import"`.

2. `ui/src/hooks/use-skills-catalog.ts`  
Returns: `skills`, `upsertSkills`, `markSkillUsed`, `removeSkill`, `getSkill`.  
Logic: in-memory state + storage sync.

3. `ui/src/lib/storage/automation-run-log-storage.ts`  
Key: `friday.automations.run-log.v1`.  
Shape: `Record<automationId, { runIds: string[]; updatedAt: string }>`; keep latest 50 IDs.

4. `ui/src/hooks/use-automation-run-log.ts`  
Returns: `getRunIds`, `appendRunId`, `clearRunLog`.

5. `ui/src/lib/skills/build-skill-run-task.ts`  
Creates deterministic agent task string from `skillId` and form inputs.

---

**6) Routing Changes**

Update `ui/src/router.tsx`:

```tsx
{ path: "automations", element: <AutomationsPage /> },
{ path: "automations/:automationId", element: <AutomationDetailPage /> },

{ path: "skills", element: <SkillsPage /> },
{ path: "skills/generator/new", element: <SkillGeneratorPage /> },
{ path: "skills/:skillId", element: <SkillDetailPage /> },
```

Keep existing protected shell behavior unchanged.

---

**7) Type Updates in `ui/src/lib/api/types.ts`**

1. Add `pending` to `AgentRunStatus` to match backend.
2. Expand automation type to full backend shape (`runCount`, `lastRunAt`, `variables`, etc.).
3. Add skill UI schema types (`FridaySkillUiSchemaV1`, field/output/action enums).
4. Add skill generator response/request types.
5. Add skill converter request/response types.
6. Add `AgentRuntimeResult` type used by automation run response.

Also update `ui/src/components/shared/status-badge.tsx` mapping for `pending`.

---

**8) Implementation Order for CC**

1. Extend `ui/src/lib/api/types.ts` and `ui/src/components/shared/status-badge.tsx` first.
2. Add `ui/src/lib/api/automations.ts` with all automation endpoints.
3. Add `ui/src/lib/api/skills.ts` with all generator/converter/ui/pack endpoints.
4. Add storage modules for skills catalog and automation run log.
5. Add hooks `use-skills-catalog` and `use-automation-run-log`.
6. Add shared primitives `Modal`, `ConfirmDialog`, `SegmentedTabs`, `FileDropzone`, `DynamicSkillForm`.
7. Build automation components (`automation-variable-editor`, `automation-form-modal`, `automation-card`, `automation-run-history-list`).
8. Build `automations-page.tsx` and wire list/create/edit/delete/enable/run + `LiveRunPanel`.
9. Build `automation-detail-page.tsx` and wire run history + live run.
10. Build skill card + runtime icon components.
11. Build converter preview + import tab with preview-before-install flow.
12. Build generator chat component with full session lifecycle.
13. Build `skills-page.tsx` with tabs and navigation to generator/detail.
14. Build `skill-detail-page.tsx` with `GET /skills/:skillId/ui`, dynamic form, run button, and `LiveRunPanel`.
15. Add task builder helper for skill run adapter (`build-skill-run-task.ts`).
16. Update router paths to replace placeholders.
17. Validate query invalidations and toasts across create/update/delete/run/import/approve.
18. Smoke test flows: automations CRUD/run/detail; skill import preview+install; skill generator chat; skill detail run + live panel.
