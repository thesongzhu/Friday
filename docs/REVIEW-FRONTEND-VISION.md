> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Frontend Vision Review — CX (gpt-5.3-codex)
> Date: 2026-02-19 | Scope: ui/src/ (17.5k LOC, 148 files)

## 1. Vision Scorecard

| # | Vision Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Describe → Agent Delivers | ⚠️ Partial | Text prompt exists (task-input.tsx), live status exists (live-run-panel.tsx), skill/workflow generators exist. But no single end-to-end "describe → visual build → one-click deploy" flow. |
| 2 | Save → One-Click Reuse (ON/OFF) | ✅ Implemented | Automations dashboard + enable/disable toggle (automations-page.tsx, automation-card.tsx). |
| 3 | Give URL → Instant Integration | ⚠️ Partial | URL-based convert/import exists (skills-import-tab.tsx, converter-preview-panel.tsx). But UX is generic package import, not API/OpenAPI-first. |
| 4 | Users see text + buttons, never code | ❌ Missing | Raw technical output exposed: streamed logs (live-run-panel.tsx:98), JSON payloads (workflow-run-page.tsx:241), code-style templates (automation-detail-page.tsx:163). |
| 5 | Visual workflow auto-generated (no drawing) | ❌ Missing | UI is explicitly drag-and-drop builder (workflow-node-palette.tsx, workflow-editor-canvas.tsx, use-workflow-editor.ts). |
| 6 | Confirm/modify/test/deploy are one-click | ❌ Missing | Critical flows require multi-step forms/editor actions. Generator sends user into editor (workflow-generator-page.tsx). |
| 7 | Agent self-debugs; user sees ✅/❌ only | ⚠️ Partial | Status model includes testing/fixing (api/types.ts:52). But UI still exposes failures and manual recovery controls. |

**Summary: 1 ✅ / 3 ⚠️ / 3 ❌**

## 2. UX Issues

### High Priority
- **Workflows hidden behind Power Mode** — core differentiator hidden from beginners (sidebar.tsx:64, :98)
- **Broken "Build First Workflow" CTA** — routes to non-existent `/workflows/new` (step-done.tsx:118) while router has no such path (router.tsx:104)
- **Fragmented experience** — Agent, Skill Generator, Workflow Generator, and manual Workflow Editor are separate instead of one guided journey

### Medium Priority
- **Setup too technical** — API key/base URL/auth/network host/port visible to beginners (step-provider.tsx:47, step-network.tsx:100)
- **Non-functional select-all checkbox** — workflow run table (workflow-run-node-table.tsx:37)

## 3. Missing Features
1. Unified "describe once → Friday builds skill+workflow → progress → test/deploy" screen
2. True one-click deploy after generation (not editor-first publish flow)
3. API URL-first integration UX (OpenAPI URL, capability count, import-all/select)
4. Beginner mode hiding technical artifacts (JSON, IDs, provider internals)
5. Outcome-focused self-debug UI (clear ✅/❌ summary without raw internals)

## 4. Design Issues
- **Theme:** Mostly WOM v2 aligned (tailwind.config.ts, globals.css)
- **Consistency drift:** Setup done step uses non-system green (step-done.tsx:14) instead of WOM palette
- **Accessibility:**
  - Nested button inside button in channel card (channel-card.tsx:57, :80)
  - Icon-only actions without accessible labels in Providers tab (providers-tab.tsx:161)
  - Clickable cards without keyboard semantics (provider-kind-cards.tsx:56, converter-preview-panel.tsx:31)

## 5. Top 5 Priority Gaps

1. **Build integrated "Describe → Deliver → Deploy" flow** — replace page-hopping between Agent/Generator/Editor
2. **Auto-generated workflow as default** — move manual drag-and-drop to advanced mode
3. **True one-click deploy + immediate ON/OFF** from generated result
4. **API URL-first converter UX** — OpenAPI-centric, capability summary, selective import
5. **Fix trust-breaking UX defects** — broken setup CTA route, non-functional select-all, a11y issues
