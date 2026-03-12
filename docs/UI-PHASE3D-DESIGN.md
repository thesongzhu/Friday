# Phase 3D UI Design — Sessions, Memory, Settings

## 1. Scope and Constraints
1. Implement three real routes in the existing SPA: `ui/src/routes/sessions-page.tsx`, `ui/src/routes/memory-page.tsx`, `ui/src/routes/settings-page.tsx`.
2. Keep WOM v2 visual system and existing primitives only; no new design system or routing framework changes.
3. Use TanStack Query + `apiClient.get/post/patch/del` everywhere.
4. Do not modify backend APIs; UI must consume existing endpoints only.
5. Keep this shippable in one implementation session by prioritizing clear CRUD + operational controls over fancy visuals.

## 2. Router and Navigation Changes
1. Update `ui/src/router.tsx` to replace placeholders:
   - `sessions` -> `<SessionsPage />`
   - `memory` -> `<MemoryPage />`
   - `settings` -> `<SettingsPage />`
2. Keep existing sidebar links unchanged in `ui/src/components/layout/sidebar.tsx`.
3. Use URL query state for deep-linking:
   - `/sessions?status=active&sessionKey=...`
   - `/memory?q=...&namespace=...`
   - `/settings?tab=providers`

## 3. API Types and Modules

### 3.1 Add API types in `ui/src/lib/api/types.ts`
Add sections for:
1. Sessions:
   - `FridaySessionStatus`, `FridaySessionRecord`, `FridaySessionMessageRecord`
   - `FridaySessionForkCreateResult`, `FridaySessionForkMergeResult`
   - `FridaySessionMemoryExtractionStatus`, `FridaySessionMemoryExtractionRunResult`, `FridaySessionMemoryRetryResult`
2. Memory:
   - `FridayMemoryItem`, `FridayMemorySearchResult`, `FridayMemoryPruneResult`
3. Providers/Usage:
   - `FridayProviderProfile`, `FridayProviderValidationState`, `FridayModelRoutingConfig`
   - `FridayProviderUsageSummary`, `FridayLlmBudgetStatus`, `FridayLlmBudgetConfig`
   - `FridayOAuthLoginInitiation`, `FridayOAuthLoginResult`
4. Security/Fleet/Health:
   - `FridaySecurityCenterResponse`, `FridayFleetOverviewResponse`, `FridayFleetSatelliteCard`, `FridayFleetSatelliteDetailResponse`
   - `FridayRevokeTokenResponse`, `FridayRevokeSatelliteResponse`
   - `FridayHealthResponse`

### 3.2 New API modules in `ui/src/lib/api/`
1. `sessions.ts`:
   - `list`, `create`, `get`, `archive`, `prune`, `sweep`
   - `listMessages`, `createMessage`
   - `getMemoryNamespace`
   - `fork`, `listForks`, `merge`
   - `extractMemory`, `rememberMessages`, `getExtractionStatus`, `retryExtractions`
2. `memory.ts`:
   - `store`, `search`, `getItem`, `listItems`, `deleteItem`, `prune`
3. `providers.ts`:
   - `list`, `create`, `get`, `update`, `remove`, `validate`
   - `getRouting`, `setRouting`
   - `initiateAnthropicOAuth`, `completeAnthropicOAuth`
4. `provider-usage.ts`:
   - `getUsageSummary`, `getBudget`, `setBudget`
5. `security.ts`:
   - `getCenter`, `revokeToken`, `revokeSatellite`
6. `fleet.ts`:
   - `getOverview`, `listSatellites`, `getSatellite`
7. `health.ts`:
   - `getHealth`

## 4. Query Keys and Hooks

### 4.1 Query key files
1. `ui/src/lib/sessions/query-keys.ts`
2. `ui/src/lib/memory/query-keys.ts`
3. `ui/src/lib/settings/query-keys.ts`

### 4.2 Hooks (only where complexity exists)
1. `ui/src/hooks/use-session-messages.ts`:
   - `useInfiniteQuery` with `before` cursor based on oldest loaded `occurredAt`
   - flatten pages into chronological order
2. `ui/src/hooks/use-session-fork-tree.ts`:
   - builds tree nodes from combined session lists and `parentSessionKey/rootSessionKey`
3. `ui/src/hooks/use-settings-tab.ts`:
   - sync settings tab with `URLSearchParams`

## 5. Sessions Page (`/sessions`)

### 5.1 Page layout
1. Two-pane desktop layout in `ui/src/routes/sessions-page.tsx`:
   - Left: session list + filters
   - Right: selected session detail
2. Mobile fallback:
   - stacked list then detail.

### 5.2 Left pane behavior
1. Status segmented filter: `active | idle | archived | pruned`.
2. Optional filters: `channel`, `accountId`, `userId`.
3. Cursor-based list with `Load more`.
4. Row content:
   - session key, chat/channel info, message count, last activity, status badge.

### 5.3 Right pane behavior
1. Header card:
   - session key, status, metadata summary, token counters, created/updated times.
2. Controls:
   - `Archive Session` (confirm dialog)
   - `Prune Old Sessions` modal (`olderThan` ISO datetime)
   - `Run Sweep` button
3. Memory namespace card:
   - value from `/memory-namespace`, copy button.
4. Messages card:
   - paginated chronological list
   - each message shows role, content text, memory extract status, timestamp
   - `Load older messages` button.
5. Fork tree card:
   - simple indented tree from root session
   - node shows short key + status + message count
   - click node to switch selected session.
6. Memory extraction card:
   - trigger form (`trigger`, `mode`, `batchSize`)
   - `Extract` button, `Retry Failed` button
   - status counters (`pending/extracted/skipped/failed/queued/running`)
   - polling every 3s while queued/running, 15s otherwise.

### 5.4 Components for sessions
1. `ui/src/components/sessions/session-status-badge.tsx`
2. `ui/src/components/sessions/session-list.tsx`
3. `ui/src/components/sessions/session-detail-summary.tsx`
4. `ui/src/components/sessions/session-message-list.tsx`
5. `ui/src/components/sessions/session-fork-tree.tsx`
6. `ui/src/components/sessions/session-memory-extraction-card.tsx`
7. `ui/src/components/sessions/session-prune-modal.tsx`

## 6. Memory Page (`/memory`)

### 6.1 Page layout
1. Header with actions:
   - `Store Memory` button
   - `Prune` button
2. Search/filter bar:
   - `query`, `namespace`, `tagsAny` (comma-separated), `source`, `includeExpired`.
3. Results area:
   - grouped by namespace card sections.

### 6.2 Behavior
1. If `query` is present and submitted:
   - call `/v1/memory/search`.
2. If `query` is empty:
   - call `/v1/memory/items`.
3. Grouping:
   - `Record<string, FridayMemoryItem[]>` by `namespace`.
4. Store modal:
   - fields: namespace, content, source, key, tags, metadata JSON, ttlSeconds.
5. Delete:
   - per-item delete button with `ConfirmDialog`.
6. Prune modal:
   - fields: namespace, source, tagsAny, expiredOnly, olderThan, limit, dryRun.
   - first run default `dryRun=true`, show preview count/IDs.
   - second action `Execute Prune` with `dryRun=false`.

### 6.3 Components for memory
1. `ui/src/components/memory/memory-search-bar.tsx`
2. `ui/src/components/memory/memory-items-grouped-list.tsx`
3. `ui/src/components/memory/memory-store-modal.tsx`
4. `ui/src/components/memory/memory-prune-modal.tsx`
5. `ui/src/components/memory/memory-item-row.tsx`

## 7. Settings Page (`/settings`)

### 7.1 Shell
1. `ui/src/routes/settings-page.tsx` with `SegmentedTabs`.
2. Tabs: `providers`, `security`, `fleet`, `general`.
3. Keep each tab in its own component file for speed and isolation.

### 7.2 Providers tab
1. Provider list:
   - list/create/edit/delete/validate.
2. Provider form modal:
   - id, kind, displayName/name, baseUrl, apiKey, models, defaultModel, enabled.
3. Routing config card:
   - default provider, fallback providers, default model, save.
4. Anthropic OAuth card:
   - initiate request, show auth URL, callback submit (code/state/providerId).
5. Usage summary card:
   - date range + granularity + table totals/rows.
6. Budget card:
   - monthly limit, thresholds, webhook URL, hard stop, save.

### 7.3 Security tab
1. Security center overview cards.
2. Findings list with severity badges.
3. Revoke token action.
4. Revoke satellite action with optional reason.
5. Manual revoke forms for tokenId/satelliteId for non-finding cases.

### 7.4 Fleet tab
1. Overview metrics card.
2. Satellite list with filters and pagination.
3. Satellite detail card on selection:
   - capabilities
   - queue/workflow load
   - trust and health breakdown.

### 7.5 General tab
1. Health status card:
   - status/version/uptime, refresh every 30s.
2. System info card:
   - `/v1/auth/me` user, role, scopes.
3. Optional diagnostics:
   - latest API request error banner if unavailable.

### 7.6 Components for settings
1. `ui/src/components/settings/settings-tabs.tsx`
2. `ui/src/components/settings/providers-tab.tsx`
3. `ui/src/components/settings/provider-form-modal.tsx`
4. `ui/src/components/settings/provider-routing-card.tsx`
5. `ui/src/components/settings/provider-usage-card.tsx`
6. `ui/src/components/settings/provider-budget-card.tsx`
7. `ui/src/components/settings/provider-oauth-card.tsx`
8. `ui/src/components/settings/security-tab.tsx`
9. `ui/src/components/settings/fleet-tab.tsx`
10. `ui/src/components/settings/general-tab.tsx`

## 8. Mutation + Invalidation Rules
1. Session archive/prune/sweep invalidates session list and selected detail keys.
2. Message create/remember/extract invalidates messages + extraction status + session detail.
3. Memory store/delete/prune invalidates memory list and active search key.
4. Provider create/update/delete/validate invalidates provider list and provider detail.
5. Routing/budget changes invalidate routing and budget keys.
6. Security revoke invalidates security center and fleet lists.
7. Fleet detail refresh invalidates only selected satellite detail key.

## 9. Implementation Order (one-session practical sequence)
1. Add new API types in `ui/src/lib/api/types.ts`.
2. Add API clients in `ui/src/lib/api/sessions.ts`, `ui/src/lib/api/memory.ts`, `ui/src/lib/api/providers.ts`, `ui/src/lib/api/provider-usage.ts`, `ui/src/lib/api/security.ts`, `ui/src/lib/api/fleet.ts`, `ui/src/lib/api/health.ts`.
3. Add query keys files for sessions/memory/settings.
4. Build sessions components and `ui/src/routes/sessions-page.tsx`.
5. Build memory components and `ui/src/routes/memory-page.tsx`.
6. Build settings shell and providers tab first (largest dependency surface).
7. Build security tab, then fleet tab, then general tab.
8. Update `ui/src/router.tsx` to wire real pages.
9. Run lint/build and do manual functional checks for all mutation paths and empty/error states.

## 10. Definition of Done
1. All three routes render real data and no placeholder remains.
2. Every required endpoint family is reachable from UI flows.
3. Sessions supports filter, detail, archive/prune, paginated messages, fork tree, extraction trigger/status.
4. Memory supports search, grouped list, store, delete confirm, prune dry-run and execute.
5. Settings supports Providers, Security, Fleet, General tabs with working mutations and feedback toasts.
6. No backend changes required; UI follows existing API client and design patterns.