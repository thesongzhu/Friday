Unable to write `/tmp/cx-phase3c-raw.md` in this environment (read-only filesystem). Design document content:

# Friday UI Phase 3C Design (Workflows + Visual Editor)
Date: 2026-02-19  
Target repo: `.`  
UI app: `./ui`

## 0) Implementation Decisions
1. Use `@xyflow/react` v12 for the editor (`ReactFlow`, `ReactFlowProvider`, custom nodes/edges).
2. Keep backend unchanged; all behavior uses existing `/v1/workflows*`, `/v1/workflow-runs*`, `/v1/workflows/:id/drafts*`, `/locks*`, `/workflows/generator*`.
3. Follow existing UI patterns: `apiClient`, TanStack Query, `toast` from `sonner`, `Modal`, `ConfirmDialog`, `cn()`.
4. Editor is draft-first: all visual editing is against builder drafts, not direct workflow version mutation.
5. Lock lifecycle is mandatory for edit mode: acquire on entry, renew heartbeat, release on exit.
6. Run monitoring is polling-based (timeline + run + nodes), since workflow runs do not expose SSE endpoint in current API.
7. Run history per workflow is maintained client-side (local storage), because no backend “list runs by workflowId” endpoint exists.
8. WOM v2 styling is preserved everywhere: navy (`#1E3A5F`), coral (`#E8A87C`), warm white (`#FEFDFB`).

## 1) File Tree

### New files
```text
ui/src/lib/api/workflows.ts
ui/src/lib/api/workflow-runs.ts
ui/src/lib/api/workflow-builder.ts
ui/src/lib/api/workflow-generator.ts

ui/src/lib/workflows/query-keys.ts
ui/src/lib/workflows/defaults.ts
ui/src/lib/workflows/workflow-status.ts
ui/src/lib/workflows/editor-adapters.ts
ui/src/lib/storage/workflow-run-log-storage.ts

ui/src/hooks/use-workflow-lock.ts
ui/src/hooks/use-workflow-editor.ts
ui/src/hooks/use-workflow-run-timeline.ts
ui/src/hooks/use-workflow-run-log.ts

ui/src/routes/workflows-page.tsx
ui/src/routes/workflow-detail-page.tsx
ui/src/routes/workflow-editor-page.tsx
ui/src/routes/workflow-run-page.tsx
ui/src/routes/workflow-generator-page.tsx

ui/src/components/workflows/workflow-card.tsx
ui/src/components/workflows/workflow-create-modal.tsx
ui/src/components/workflows/workflow-status-badge.tsx
ui/src/components/workflows/workflow-run-status-badge.tsx
ui/src/components/workflows/workflow-version-list.tsx
ui/src/components/workflows/workflow-run-history-list.tsx
ui/src/components/workflows/workflow-generator-chat.tsx
ui/src/components/workflows/workflow-run-node-table.tsx
ui/src/components/workflows/workflow-run-node-detail.tsx
ui/src/components/workflows/workflow-run-timeline-list.tsx

ui/src/components/workflows/editor/workflow-editor-canvas.tsx
ui/src/components/workflows/editor/workflow-editor-toolbar.tsx
ui/src/components/workflows/editor/workflow-node-palette.tsx
ui/src/components/workflows/editor/workflow-node-inspector.tsx
ui/src/components/workflows/editor/workflow-validation-panel.tsx
ui/src/components/workflows/editor/workflow-node.tsx
ui/src/components/workflows/editor/workflow-edge.tsx
```

### Modified files
```text
package.json
ui/src/router.tsx
ui/src/lib/api/types.ts
ui/src/styles/globals.css
```

## 2) API Modules

## 2.1 `ui/src/lib/api/types.ts` additions
Add workflow-facing types mirrored from backend contracts:
1. `WorkflowNodeType`, `WorkflowRunStatus`, `NodeAttemptStatus`, `FridayWorkflowStatus`.
2. `FridayWorkflowSpecV1`, `FridayWorkflowVisualGraphV1`, `FridayCompiledWorkflowGraphV2`.
3. `FridayWorkflowEntity`, `FridayWorkflowVersionEntity`.
4. `FridayWorkflowRunEntity`, `FridayWorkflowRunNodeEntity`, `FridayRunTimelineEntry`.
5. `FridayWorkflowDraftEntity`, `FridayWorkflowBuilderValidationReport`, `FridayWorkflowBuilderValidationIssue`.
6. Lock types: `FridayWorkflowEditLock`, `FridayAcquireWorkflowLockResponse`.
7. Generator types: `FridayWorkflowGenerationSession`, `FridayWorkflowGenerationTurn`, `FridayGeneratedWorkflowDraft`, generator response shapes.
8. Editor types: `FridayWorkflowEditorGraphV1`, `FridayWorkflowNodeDefinition`, node config unions.

## 2.2 `ui/src/lib/api/workflows.ts`
Pattern matches `automations.ts`.

Methods:
1. `list(query?: { tag?: string; archived?: boolean; cursor?: string; limit?: number })`
   - `GET /v1/workflows`
   - returns `{ items, nextCursor? }`.
2. `create(input: { slug; name; description?; tags?; graph })`
   - `POST /v1/workflows`
   - returns `{ workflow, version }`.
3. `get(workflowId: string)`
   - `GET /v1/workflows/:workflowId`
   - returns `{ workflow, latestVersion, publishedVersion? }`.
4. `update(workflowId, patch: { expectedRevision; etag; name?; description?; tags?; graph? })`
   - `PATCH /v1/workflows/:workflowId`
   - returns `{ workflow, version? }`.
5. `archive(workflowId)`
   - `DELETE /v1/workflows/:workflowId`
   - returns `{ archived: true }`.
6. `publish(workflowId, input?: { versionNumber?: number; changeNote?: string })`
   - `POST /v1/workflows/:workflowId/publish`
   - returns `{ publishedVersion }`.
7. `listVersions(workflowId, query?: { cursor?: string; limit?: number })`
   - `GET /v1/workflows/:workflowId/versions`
   - returns `{ items, nextCursor? }`.

## 2.3 `ui/src/lib/api/workflow-runs.ts`
Methods:
1. `start(input: { workflowId; workflowVersionId?; triggerType; triggerPayload?; dryRun? })`
   - `POST /v1/workflow-runs`
   - returns `{ run }`.
2. `get(runId)`
   - `GET /v1/workflow-runs/:runId`
   - returns `{ run }`.
3. `listNodes(runId, query?: { status?: NodeAttemptStatus; cursor?: string; limit?: number })`
   - `GET /v1/workflow-runs/:runId/nodes`
   - returns `{ items, nextCursor? }`.
4. `getTimeline(runId, query?: { afterSeq?: number; cursor?: string; limit?: number })`
   - `GET /v1/workflow-runs/:runId/timeline`
   - returns `{ items, nextCursor? }`.
5. `cancel(runId, input?: { reason?: string })`
   - `POST /v1/workflow-runs/:runId/cancel`
   - returns `{ run }`.
6. `retry(runId, input?: { nodeIds?: string[] })`
   - `POST /v1/workflow-runs/:runId/retry`
   - returns `{ run, retriedNodes }`.
7. `resume(runId)`
   - `POST /v1/workflow-runs/:runId/resume`
   - returns `{ run }`.

## 2.4 `ui/src/lib/api/workflow-builder.ts`
Methods:
1. `listDrafts(workflowId, query?: { cursor?: string; limit?: number })`
   - `GET /v1/workflows/:workflowId/drafts`
   - returns `{ items, nextCursor? }`.
2. `createDraft(workflowId, input: { title; spec; visual; baseWorkflowVersionId? })`
   - `POST /v1/workflows/:workflowId/drafts`
   - returns `{ draft }`.
3. `getDraft(workflowId, draftId)`
   - `GET /v1/workflows/:workflowId/drafts/:draftId`
   - returns `{ draft }`.
4. `saveDraft(workflowId, draftId, input: { expectedRevision; lockToken; title?; spec?; visual? })`
   - `PATCH /v1/workflows/:workflowId/drafts/:draftId`
   - returns `{ draft }`.
5. `autosaveDraft(workflowId, draftId, input: { lockToken; spec; visual })`
   - `POST /v1/workflows/:workflowId/drafts/:draftId/autosave`
   - returns `{ draft: FridayWorkflowDraftEntity | null }`.
6. `compileDraft(workflowId, draftId)`
   - `POST /v1/workflows/:workflowId/drafts/:draftId/compile`
   - returns `{ compiled, validation }`.
7. `publishDraft(workflowId, draftId, input: { workflowId; lockToken; createdByUserId?; changeNote?; publishNow: boolean })`
   - `POST /v1/workflows/:workflowId/drafts/:draftId/publish`
   - returns publish result payload.
8. `acquireLock(workflowId, input: { ownerUserId; ownerSessionId?; ttlSec })`
   - `POST /v1/workflows/:workflowId/locks/acquire`.
9. `renewLock(workflowId, input: { lockToken; ttlSec })`
   - `POST /v1/workflows/:workflowId/locks/renew`.
10. `releaseLock(workflowId, input: { lockToken })`
    - `POST /v1/workflows/:workflowId/locks/release`.

## 2.5 `ui/src/lib/api/workflow-generator.ts`
Mirror `skillsApi` generator pattern.

Methods:
1. `startSession(input: { goal; requestedModel?; userId; channel })`
   - `POST /v1/workflows/generator/sessions`.
2. `getSession(sessionId)`
   - `GET /v1/workflows/generator/sessions/:sessionId`.
3. `submitMessage(sessionId, input: { message; requestedModel? })`
   - `POST /v1/workflows/generator/sessions/:sessionId/messages`.
4. `generateDraft(sessionId, input?: { requestedModel? })`
   - `POST /v1/workflows/generator/sessions/:sessionId/generate`.
5. `approveSession(sessionId)`
   - `POST /v1/workflows/generator/sessions/:sessionId/approve`.
6. `cancelSession(sessionId)`
   - `DELETE /v1/workflows/generator/sessions/:sessionId`.

## 2.6 Query keys (`ui/src/lib/workflows/query-keys.ts`)
Expose stable key builders:
1. `workflowKeys.list(filters)`
2. `workflowKeys.detail(workflowId)`
3. `workflowKeys.versions(workflowId)`
4. `workflowKeys.drafts(workflowId)`
5. `workflowKeys.draft(workflowId, draftId)`
6. `workflowKeys.run(runId)`
7. `workflowKeys.runNodes(runId, status?)`
8. `workflowKeys.runTimeline(runId)`
9. `workflowKeys.generatorSession(sessionId)`

## 3) Pages

## 3.1 Workflows List Page (`/workflows`) — `workflows-page.tsx`
Core behavior:
1. Header: title + `Create Workflow` + `Generate with AI`.
2. Filters:
   - Tag filter (`tag`).
   - Status filter (`all|draft|published|archived`).
3. Data:
   - Query `workflowsApi.list`.
   - Use `archived=true` for archived filter.
   - Use `archived=false` + client derive for draft/published split.
4. Grid:
   - `WorkflowCard` with name, description, tags, derived status, latest/published version numbers, updatedAt.
5. Actions:
   - Open detail.
   - Open editor.
   - Archive with `ConfirmDialog`.
6. Create modal:
   - `slug`, `name`, `description`, `tags`.
   - Create with minimal raw graph from `defaults.ts`.
   - On success invalidate list and route to `/workflows/:id/edit`.

## 3.2 Workflow Detail Page (`/workflows/:workflowId`) — `workflow-detail-page.tsx`
Core behavior:
1. Load workflow detail and versions.
2. Action bar:
   - `Edit`.
   - `Start Run`.
   - `Publish Latest`.
   - `Archive`.
3. Overview card:
   - slug, description, tags, status badge.
   - revision + etag.
   - latest and published version numbers.
4. Versions section:
   - `WorkflowVersionList`.
   - row actions: `Run`, `Publish this version`.
5. Runs section:
   - `WorkflowRunHistoryList` backed by local run log storage.
6. Start run flow:
   - `workflowRunsApi.start({ workflowId, workflowVersionId?, triggerType: "manual", triggerPayload: {} })`.
   - append run ID to local log.
   - navigate to `/workflows/:workflowId/runs/:runId`.

## 3.3 Workflow Editor Page (`/workflows/:workflowId/edit`) — `workflow-editor-page.tsx`
Core behavior:
1. Uses `useWorkflowEditor`.
2. 3-panel layout:
   - Left `WorkflowNodePalette`.
   - Center `WorkflowEditorCanvas`.
   - Right `WorkflowNodeInspector`.
3. Top toolbar:
   - Save, Compile, Publish, Undo, Redo, Zoom Out, Zoom In, Fit.
4. Bottom panel:
   - `WorkflowValidationPanel` for compile report.
5. Lock state banner:
   - locked, conflicting, expired.
6. Autosave indicator:
   - idle, saving, saved timestamp, error.
7. Exit behavior:
   - release lock on unmount/beforeunload.

## 3.4 Workflow Run Page (`/workflows/:workflowId/runs/:runId`) — `workflow-run-page.tsx`
Core behavior:
1. Poll run summary + run nodes.
2. Poll timeline incrementally through `useWorkflowRunTimeline`.
3. Controls:
   - Cancel run.
   - Resume paused run.
   - Retry selected nodes.
4. Layout:
   - Left timeline.
   - Right node table + node detail panel.
5. Status badges per run and per node.
6. Node detail shows input/output/error JSON.

## 3.5 Workflow Generator Page (`/workflows/generator/new`) — `workflow-generator-page.tsx`
Core behavior:
1. Same interaction model as skills generator.
2. `WorkflowGeneratorChat` start/session/message/generate/approve/cancel.
3. On approve success:
   - invalidate workflow list.
   - navigate to `/workflows/:workflowId/edit?source=generator`.

## 4) Visual Editor (React Flow) — Key Design

## 4.1 Editor component composition
1. `workflow-editor-page.tsx`: route-level data + overall layout.
2. `workflow-editor-toolbar.tsx`: command bar and lock/autosave status.
3. `workflow-node-palette.tsx`: drag source templates.
4. `workflow-editor-canvas.tsx`: `ReactFlow` instance with custom nodes/edges.
5. `workflow-node-inspector.tsx`: selected node/edge config form.
6. `workflow-validation-panel.tsx`: compile issues list + severity grouping.

## 4.2 React Flow setup
1. Use `@xyflow/react`.
2. Use custom `nodeTypes = { workflow_node: WorkflowNode }`.
3. Use custom `edgeTypes = { workflow_edge: WorkflowEdge }`.
4. Use canvas options:
   - `snapToGrid`, `snapGrid={[20, 20]}`.
   - `minZoom={0.2}`, `maxZoom={2}`.
   - `deleteKeyCode={["Backspace", "Delete"]}`.
5. Canvas background and controls styled to WOM v2.

## 4.3 Node palette
Palette entries:
1. Trigger.
2. Action.
3. Condition.
4. Data.
5. AI.
6. Approval.

Behavior:
1. Drag starts with serialized template payload.
2. Drop creates node at projected pointer coordinates.
3. Trigger is singleton (`__trigger__`); disable adding if present.
4. New node names auto-increment by type (`Action 1`, `Action 2`, ...).

## 4.4 Custom node rendering
Use one node component with per-type visual variants.

Variant mapping:
| Variant | Shape | Colors |
|---|---|---|
| trigger | rounded pill | navy bg, coral border |
| action | rounded rectangle | navy bg |
| condition | diamond card | navy-light bg |
| data | rectangle dashed border | cream bg with navy text |
| ai | rounded rectangle + coral glow | navy bg, coral ring |
| approval | rounded capsule | muted bg, navy border |

Selection state:
1. Selected node gets coral ring and stronger shadow.
2. Dragging node uses elevated shadow.
3. Node header includes icon + type label.

## 4.5 Edge labels
1. Custom edge (`workflow-edge.tsx`) built with `getBezierPath`.
2. Label precedence:
   - `edge.data.branch`
   - `edge.data.condition`
   - fallback none.
3. Label chip style:
   - warm-white background, coral text/border.
4. Inspector allows editing branch/condition fields for selected edge.

## 4.6 Toolbar actions
Buttons:
1. Save draft (manual save endpoint).
2. Compile (compile endpoint, opens validation panel).
3. Publish (publish draft endpoint).
4. Undo.
5. Redo.
6. Zoom out.
7. Zoom in.
8. Fit view.

Keyboard:
1. `Cmd/Ctrl+S` save.
2. `Cmd/Ctrl+Z` undo.
3. `Cmd/Ctrl+Shift+Z` redo.
4. `Delete/Backspace` delete selected node/edge.

## 4.7 Draft lifecycle
1. On page entry, fetch workflow and drafts.
2. Acquire lock first (`useWorkflowLock`).
3. Determine active draft:
   - URL `draftId` if present.
   - else latest active draft.
   - else create draft from defaults/conversion with `baseWorkflowVersionId`.
4. Load draft into editor graph.
5. Manual save increments `revision`.
6. Compile validates and returns report.
7. Publish creates/publishes workflow version and marks draft published.

## 4.8 Lock management lifecycle
1. Acquire lock with:
   - `ownerUserId = auth.user.id` fallback `ui-user`.
   - `ownerSessionId = browser-session UUID`.
   - `ttlSec = 90`.
2. Renew every `30s`.
3. Release on:
   - unmount.
   - `beforeunload`.
4. Conflict handling:
   - if acquire returns `acquired=false`, render read-only with lock owner + retry action.
5. Expired/mismatch handling:
   - switch to read-only and prompt reacquire.

## 4.9 Autosave policy
1. Autosave interval `10s`.
2. Autosave only when:
   - lock state is locked.
   - draft exists.
   - dirty flag true.
3. Payload always includes full `spec` + `visual`.
4. If response draft is `null`, treat as no-op and clear dirty flag.
5. On 409/410/412, stop autosave and surface lock warning.

## 4.10 Spec ↔ Visual sync
Use `editor-adapters.ts` with two primary functions:
1. `draftToEditorGraph(draft): FridayWorkflowEditorGraphV1`
2. `editorGraphToDraftBundle(editorGraph, previousDraft): { spec, visual }`

Mapping table:
| Editor node intent | Stored node definition | Spec step mapping |
|---|---|---|
| Trigger | `type: "trigger"` + trigger config | `spec.trigger` and `spec.startStepId` |
| Action | `type: "action"` + `actionType: "skill"` | `step.type = "skill_call"` |
| AI | `type: "action"` + `actionType: "ai_completion"` | `step.type = "tool_call"` with AI args |
| HTTP Action | `type: "action"` + `actionType: "http_request"` | `step.type = "tool_call"` with request args |
| Condition | `type: "condition"` | `step.type = "condition"` |
| Data | `type: "transform"` | `step.type = "transform"` |
| Approval | `type: "approval"` | `step.type = "human_approval"` |

Edge mapping:
1. Trigger edge `__trigger__ -> X` drives `startStepId = X`.
2. Non-trigger edges become `spec.edges`.
3. `edge.data.branch` maps to `when` when value is `success|failure|true|false`.
4. Unsupported branch labels remain in visual edge data and appear as compile warnings in UI.

## 4.11 WOM v2 styling for React Flow
Add CSS overrides in `ui/src/styles/globals.css`:
1. `.workflow-flow .react-flow__pane { background: #FEFDFB; }`
2. `.workflow-flow .react-flow__edge-path { stroke: #2A4A73; stroke-width: 2; }`
3. `.workflow-flow .react-flow__edge.selected .react-flow__edge-path { stroke: #E8A87C; }`
4. `.workflow-flow .react-flow__controls button { background: #1E3A5F; color: #FEFDFB; border-color: #EBE8E3; }`
5. `.workflow-flow .react-flow__minimap { background: #F5F3F0; }`

## 5) Run Monitoring Design

## 5.1 Data model on run page
1. Run summary from `workflowRunsApi.get(runId)` polled every `2s` until terminal.
2. Run nodes from `workflowRunsApi.listNodes(runId)` polled every `2s`.
3. Timeline from `useWorkflowRunTimeline` polled every `1.5s` with `afterSeq`.

## 5.2 Controls logic
1. Cancel enabled when run is `queued|running|pausing|compensating`.
2. Resume enabled when run is `paused`.
3. Retry enabled when run is terminal or node selections exist.
4. Retry payload uses selected node IDs from table selection.

## 5.3 Timeline view
1. Append-only ordered by `seq`.
2. Event row shows:
   - sequence,
   - timestamp,
   - event name,
   - node ID and attempt when present,
   - compact payload preview.
3. Click row opens payload JSON detail panel.

## 5.4 Node status view
1. Table columns:
   - nodeId,
   - attempt,
   - status badge,
   - startedAt,
   - finishedAt,
   - duration.
2. Selecting row opens `WorkflowRunNodeDetail` with full input/output/error payload.

## 6) Hooks

## 6.1 `use-workflow-lock.ts`
Signature:
```ts
useWorkflowLock(params: {
  workflowId: string | null;
  ownerUserId: string;
  ownerSessionId: string;
  ttlSec?: number;
  renewEveryMs?: number;
  enabled?: boolean;
}): {
  status: "idle" | "acquiring" | "locked" | "conflicted" | "expired" | "error";
  lockToken: string | null;
  conflict: FridayWorkflowEditLock | null;
  error: string | null;
  acquire: () => Promise<boolean>;
  release: () => Promise<void>;
}
```

Behavior:
1. Acquire on enable.
2. Start renew interval while locked.
3. Stop renew and mark expired/error on renew failure.
4. Release best-effort on cleanup.

## 6.2 `use-workflow-run-timeline.ts`
Signature:
```ts
useWorkflowRunTimeline(params: {
  runId: string | null;
  enabled?: boolean;
  pollMs?: number;
  pageSize?: number;
}): {
  entries: FridayRunTimelineEntry[];
  lastSeq: number;
  isPolling: boolean;
  error: string | null;
  refetchNow: () => Promise<void>;
  reset: () => void;
}
```

Behavior:
1. Tracks `afterSeq` internally.
2. Appends deduped entries by `seq`.
3. Stops polling when disabled.

## 6.3 `use-workflow-editor.ts`
Signature:
```ts
useWorkflowEditor(params: {
  workflowId: string;
  draftIdFromUrl?: string | null;
  userId: string;
}): {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: OnNodesChange<Node>;
  onEdgesChange: OnEdgesChange<Edge>;
  onConnect: OnConnect;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  selectNode: (id: string | null) => void;
  selectEdge: (id: string | null) => void;
  addNodeFromPalette: (kind: WorkflowNodeType, position: XYPosition) => void;
  updateSelectedNode: (patch: Partial<FridayWorkflowNodeDefinition>) => void;
  updateSelectedEdge: (patch: { condition?: string; branch?: string }) => void;
  deleteSelection: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  saveDraft: () => Promise<void>;
  compileDraft: () => Promise<void>;
  publishDraft: (changeNote?: string) => Promise<void>;
  startRun: () => Promise<string | null>;
  draft: FridayWorkflowDraftEntity | null;
  validation: FridayWorkflowBuilderValidationReport | null;
  isLoading: boolean;
  isDirty: boolean;
  isSaving: boolean;
  isAutosaving: boolean;
  isCompiling: boolean;
  isPublishing: boolean;
  autosaveState: "idle" | "saving" | "saved" | "error";
  lock: ReturnType<typeof useWorkflowLock>;
  error: string | null;
}
```

Behavior:
1. Orchestrates workflow query, drafts query, lock hook, active draft selection/creation.
2. Maintains React Flow nodes/edges state + history stacks.
3. Converts graph to spec/visual before save/autosave/compile/publish.
4. Runs autosave interval.
5. Exposes command handlers for page/toolbar.
6. Handles query invalidation for workflow detail/list/drafts on publish/save.

## 7) Implementation Order (for CC)

1. Add dependency in `package.json`: `@xyflow/react`.
2. Extend `ui/src/lib/api/types.ts` with workflow, draft, run, generator, and editor types.
3. Implement `ui/src/lib/api/workflows.ts`.
4. Implement `ui/src/lib/api/workflow-runs.ts`.
5. Implement `ui/src/lib/api/workflow-builder.ts`.
6. Implement `ui/src/lib/api/workflow-generator.ts`.
7. Implement `ui/src/lib/workflows/query-keys.ts`.
8. Implement `ui/src/lib/workflows/workflow-status.ts` and `ui/src/lib/workflows/defaults.ts`.
9. Implement `ui/src/lib/workflows/editor-adapters.ts`.
10. Implement `ui/src/lib/storage/workflow-run-log-storage.ts` and `ui/src/hooks/use-workflow-run-log.ts`.
11. Implement `ui/src/hooks/use-workflow-lock.ts`.
12. Implement `ui/src/hooks/use-workflow-run-timeline.ts`.
13. Implement workflow badges and list/detail shared components (`workflow-status-badge`, `workflow-run-status-badge`, `workflow-card`, `workflow-create-modal`, `workflow-version-list`, `workflow-run-history-list`).
14. Build `ui/src/routes/workflows-page.tsx`.
15. Build `ui/src/routes/workflow-detail-page.tsx`.
16. Build generator components (`workflow-generator-chat.tsx`) and page (`workflow-generator-page.tsx`).
17. Build run monitoring components (`workflow-run-timeline-list`, `workflow-run-node-table`, `workflow-run-node-detail`) and `workflow-run-page.tsx`.
18. Build editor components (`workflow-node`, `workflow-edge`, `workflow-node-palette`, `workflow-node-inspector`, `workflow-editor-toolbar`, `workflow-validation-panel`, `workflow-editor-canvas`).
19. Implement `ui/src/hooks/use-workflow-editor.ts` and wire into `workflow-editor-page.tsx`.
20. Update `ui/src/router.tsx` routes:
    - `/workflows`
    - `/workflows/generator/new`
    - `/workflows/:workflowId`
    - `/workflows/:workflowId/edit`
    - `/workflows/:workflowId/runs/:runId`
21. Add React Flow WOM overrides in `ui/src/styles/globals.css`.
22. Final integration pass:
    - query invalidation coverage,
    - lock cleanup on navigation/unload,
    - toasts for save/compile/publish/run/cancel/retry/resume,
    - empty and error states for all pages.