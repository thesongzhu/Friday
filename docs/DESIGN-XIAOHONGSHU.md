# Xiaohongshu Tool Design

## 1) `src/xhs/` Module Layout

```text
src/xhs/
  index.ts
  model/
    xhs-types.ts
    xhs-tool-input.ts
    xhs-tool-output.ts
  tool/
    friday-agent-xhs-tool.ts
    xhs-action-router.ts
  browser/
    xhs-browser-driver.ts
    xhs-selectors.ts
    xhs-flow-guards.ts
  services/
    xhs-auth-service.ts
    xhs-post-service.ts
    xhs-search-service.ts
    xhs-comments-service.ts
    xhs-schedule-service.ts
  persistence/
    xhs-session-repository.ts
    xhs-schedule-repository.ts
  scheduler/
    xhs-dispatcher.ts
    xhs-dispatcher-workflow-bootstrap.ts
  adapters/
    xhs-mediacrawler-adapter.ts
  telemetry/
    xhs-telemetry.ts
```

Related wiring outside `src/xhs/`:
- `src/agent/tools/friday-agent-tool-registry.ts`: register `createFridayAgentXhsTool(...)`.
- `src/hub/friday-hub-bootstrap.ts`: pass `db`, `workflowRuntime`, `browserManager`, `idGenerator`, `nowIso` into XHS tool deps for parent + child runtimes.
- `src/state/sqlite/migrations/v015-xhs-automation.ts`: add XHS tables.

---

## 2) `xhs` Tool Parameter Schema and Action Routing

Tool name: `xhs`  
Actions: `login`, `post`, `search`, `comments`, `schedule`

### Schema (single tool, action-based)
```ts
{
  properties: {
    action: { type: "string", enum: ["login", "post", "search", "comments", "schedule"] },
    accountId: { type: "string", description: "Logical XHS account key (default: 'default')" },

    loginTimeoutSec: { type: "number" },
    forceRelogin: { type: "boolean" },

    title: { type: "string" },
    text: { type: "string" },
    images: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    location: { type: "string" },

    keyword: { type: "string" },
    limit: { type: "number" },
    sort: { type: "string", enum: ["general", "latest", "most_liked"] },

    postUrl: { type: "string" },
    includeReplies: { type: "boolean" },

    publishAt: { type: "string", description: "ISO datetime" },
    timezone: { type: "string", description: "IANA TZ, e.g. Asia/Shanghai" },
    maxAttempts: { type: "number" },
    source: { type: "string", enum: ["live", "wom_cache", "auto"] }
  },
  required: ["action"]
}
```

### Required-by-action
- `login`: `accountId?`
- `post`: `title`, `text`, `images` (non-empty), `accountId?`, `tags?`, `location?`
- `search`: `keyword`, `limit?`, `sort?`, `source?`
- `comments`: `postUrl`, `limit?`, `includeReplies?`, `source?`
- `schedule`: `title`, `text`, `images`, `publishAt`, `timezone`, `accountId?`, `tags?`, `location?`, `maxAttempts?`

### Routing
```ts
switch (action) {
  case "login": return authService.login(...);
  case "post": return postService.publishNow(...);
  case "search": return searchService.search(...);
  case "comments": return commentsService.extract(...);
  case "schedule": return scheduleService.enqueue(...);
  default: return errorResult("Unsupported action");
}
```

Return shape (`FridayAgentToolResult.content` JSON):
```json
{
  "ok": true,
  "action": "post",
  "accountId": "default",
  "data": {}
}
```

---

## 3) Page Interaction Flows (Browser Action Sequences)

All flows reuse browser plugin primitives from `docs/DESIGN-BROWSER-PLUGIN.md`: `open`, `navigate`, `snapshot`, `act`, `screenshot`, `tabs`, `close`.

### A. `login` (QR code + session save)
Sequence: `open -> navigate -> snapshot -> act -> screenshot -> snapshot(poll)`

1. `open` session `xhs:{accountId}`.
2. `navigate` to `https://www.xiaohongshu.com/`.
3. `snapshot` and detect already-authenticated UI.
4. If not logged in, `act(click)` login entry.
5. `snapshot` login modal, locate QR container.
6. `screenshot` QR area, return `qrImagePath` and `status: "pending_scan"`.
7. Poll `snapshot` every 2-3s until login success marker or timeout.
8. On success, export browser storage/cookies from current context.
9. Encrypt and persist in SQLite (`xhs_sessions` + `secrets`).
10. Return `status: "authenticated"` with account metadata.

### B. `post` (图文笔记)
Sequence: `open -> navigate -> snapshot -> act(click/type/press) -> snapshot -> act(click publish)`

1. Ensure valid session; if missing/expired, fail with `needs_login`.
2. `navigate` to creator publish page.
3. `snapshot` and choose “图文” mode.
4. Upload images using driver-level file-input helper on the same page context.
5. `act(type)` title.
6. `act(type)` note text body.
7. For each tag, type `#tag` and `press(Enter)`/select suggestion.
8. Optional location picker: click, type location, choose suggestion.
9. `snapshot` validation state (char counts, upload done, no error badges).
10. `act(click)` publish button.
11. `snapshot` success toast/result page, extract `noteId`/URL.
12. Return published metadata.

### C. `search`
Sequence: `open -> navigate -> snapshot -> (act for filters) -> snapshot`

1. Build URL `.../search_result?keyword=...`.
2. `navigate`.
3. Optional filter/sort via `act(click)` on sort tabs.
4. `snapshot` confirms results loaded.
5. Extract cards from DOM in page context.
6. Normalize to MediaCrawler-compatible fields: `note_id`, `title`, `desc`, `cover`, `liked_count`, `comment_count`, `share_count`, `note_url`.
7. If `source=auto` and live parse fails, fallback to WOM cache adapter (`<wom-repo>/` exports).
8. Return `results[]`.

### D. `comments`
Sequence: `open -> navigate -> snapshot -> act(scroll/click more) -> snapshot`

1. Validate and `navigate` to post URL.
2. `snapshot` detect comment panel.
3. Expand comments/replies with `act(click)` on “more” controls.
4. Scroll loop with delays until limit reached.
5. Extract comments with normalized fields:
   - `comment_id`, `content`, `user_id`, `nickname`, `avatar`, `liked_count`, `sub_comment_count`, `create_time`, `parent_comment_id`.
6. Return comments and counters.
7. Fallback to WOM cached records if `source=auto` and live extraction blocked.

### E. `schedule`
No direct publish-page automation now.
1. Validate payload + `publishAt`.
2. Write queue row to `xhs_scheduled_posts`.
3. Ensure dispatcher workflow exists and is published (cron trigger).
4. Return `queueId`, planned time, status `queued`.

---

## 4) Anti-Detection Strategy

1. Use real QR login and persistent sessions; no credential stuffing.
2. One active posting session per account; cap concurrent XHS sessions globally.
3. Human-like pacing:
- per-action jitter 300-1500ms
- per-page settle delay 1.5-4s
- randomized typing cadence
4. Behavioral realism:
- occasional hover/scroll before critical clicks
- no burst posting/search scraping
5. Stable browser identity per account:
- stable UA/timezone/viewport per account profile
- avoid aggressive fingerprint spoofing
6. Backoff and circuit-breaker:
- detect captcha/challenge pages
- stop automation and return `requires_human` instead of bypassing
7. Rate governance:
- daily operation caps by account
- adaptive cooldown on 429/403/challenge signals
8. Full telemetry for audits:
- action timings, retries, challenge detection, outcome codes.

---

## 5) Cookie / Session Persistence (SQLite)

Use existing `secrets` encryption model for sensitive blobs.

```sql
CREATE TABLE IF NOT EXISTS xhs_accounts (
  account_id      TEXT PRIMARY KEY,
  xhs_user_id     TEXT,
  display_name    TEXT,
  avatar_url      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS xhs_sessions (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES xhs_accounts(account_id) ON DELETE CASCADE,
  session_key         TEXT NOT NULL UNIQUE,              -- e.g. "xhs:default"
  cookie_secret_ref   TEXT NOT NULL,                     -- ref_key in secrets table
  storage_secret_ref  TEXT,                              -- optional local/session storage
  user_agent          TEXT,
  status              TEXT NOT NULL CHECK (status IN ('active','expired','invalid','needs_relogin')),
  last_validated_at   TEXT,
  expires_at          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_xhs_sessions_account_status
  ON xhs_sessions(account_id, status);
```

`secrets` rows:
- `scope = 'xhs'`
- `ref_key = xhs_sessions.cookie_secret_ref`
- `encrypted_value = serialized Playwright cookie/storage payload`

---

## 6) Scheduled Posting via Friday Cron Triggers

Use queue + singleton cron-dispatch workflow (recommended over one-workflow-per-post).

### Data table
```sql
CREATE TABLE IF NOT EXISTS xhs_scheduled_posts (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES xhs_accounts(account_id),
  payload_json      TEXT NOT NULL, -- title/text/images/tags/location
  publish_at        TEXT NOT NULL, -- UTC ISO
  timezone          TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('queued','publishing','published','retry','failed','cancelled')),
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  next_attempt_at   TEXT,
  last_error        TEXT,
  published_note_id TEXT,
  published_note_url TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_xhs_scheduled_due
  ON xhs_scheduled_posts(status, next_attempt_at, publish_at);
```

### Runtime flow
1. `xhs.schedule` inserts queue row with `status='queued'`, `next_attempt_at=publish_at`.
2. `xhs-dispatcher-workflow-bootstrap` ensures one published workflow:
- trigger: `{ type: "schedule", cron: "* * * * *", timezone: "UTC" }`
- step: call dispatch skill/service (`xhs_dispatch_due`).
3. Existing cron tick (`workflowRuntime.triggers.tickCron`) starts dispatcher every minute.
4. Dispatcher leases due rows, marks `publishing`, calls `xhs.post`.
5. Success: mark `published`, store `note_id/url`.
6. Failure: increment attempts, exponential retry (`status='retry'` then `queued`) until `max_attempts`, then `failed`.

This gives one-shot scheduling semantics without cron-expression limitations.

---

## 7) Test Strategy

1. Unit tests (`test/unit/xhs/*`):
- input validation per action
- router dispatch correctness
- delay policy and anti-burst guards
- session encrypt/decrypt roundtrip
- queue lease/retry state transitions

2. Integration tests (`test/integration/xhs/*`):
- `login` flow with mocked browser driver
- `post` happy path and selector-missing fallback
- `search/comments` normalization against WOM MediaCrawler field fixtures
- `schedule` enqueue + dispatcher invocation with fake clock

3. Workflow/cron integration tests:
- bootstrap creates dispatcher workflow once
- cron tick starts run and dispatches due posts
- dedupe (same row not double-published)

4. E2E smoke tests (manual or gated CI):
- real QR login
- one draft/test account post publish
- one scheduled post firing end-to-end

5. Regression fixtures:
- store AX snapshot fixtures for key pages (login modal, publish page, search result card, comment panel) so selector breakages are caught quickly.
