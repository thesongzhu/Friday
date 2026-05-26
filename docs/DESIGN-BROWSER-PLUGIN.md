# Browser Plugin Design

## 1) File structure and module boundaries

1. New file: `src/browser/friday-browser-manager.ts`
- Own all Playwright lifecycle/state.
- Expose a narrow API to tools (`launch`, `getPage`, `close`) plus tab helpers.
- Enforce security controls (allowed origins, protocol checks, limits).
- Store session/tab state and snapshot element cache.

2. New file: `src/agent/tools/friday-agent-browser-tool.ts`
- Define `browser` tool schema and action dispatcher.
- Parse/validate action-specific args.
- Call `FridayBrowserManager`.
- Return `FridayAgentToolResult` as JSON text (`content`), with `isError` on failures.

3. Existing file changes:
- `src/agent/tools/friday-agent-tool-registry.ts:32` add `createFridayAgentBrowserTool(...)`.
- `src/agent/index.ts:84` export browser tool factory/types.
- `src/hub/friday-hub-bootstrap.ts:552` pass browser config into tool registry for both parent and child runtime creation.
- `package.json` add Playwright dependency (recommend `playwright` for lowest-friction v1).

## 2) `FridayBrowserManager` interface (lifecycle)

```ts
export interface CreateFridayBrowserManagerOptions {
  workspaceRoot: string;
  allowedOrigins?: string[]; // e.g. ["https://x.com", "https://*.linkedin.com"]
  headless?: boolean;        // default true
  maxSessions?: number;      // default 3
  maxTabsPerSession?: number;// default 8
  navigationTimeoutMs?: number; // default 20_000
  actionTimeoutMs?: number;     // default 10_000
}

export interface FridayBrowserManager {
  launch(sessionId: string, signal?: AbortSignal): Promise<{ sessionId: string; tabId: string; reused: boolean }>;
  getPage(sessionId: string, opts?: { tabId?: string; createIfMissing?: boolean }, signal?: AbortSignal): Promise<{ tabId: string; page: import("playwright").Page }>;
  close(sessionId?: string): Promise<void>; // no arg => close all sessions
}
```

Internal session state:
- Browser, context, tab map, active tab id, last-used timestamp.
- Snapshot cache: `Map<elementId, selector>` per session for `act` by `elementId`.

## 3) `browser` tool definition (schema + execute behavior)

Tool name: `browser`  
Actions: `open`, `navigate`, `screenshot`, `snapshot`, `act`, `tabs`, `close`

Recommended schema shape:
```ts
parameters: {
  properties: {
    action: { type: "string", enum: ["open","navigate","screenshot","snapshot","act","tabs","close"] },
    sessionId: { type: "string", description: "Required logical browser session id" },
    tabId: { type: "string" },
    url: { type: "string" },
    waitUntil: { type: "string", enum: ["load","domcontentloaded","networkidle"] },
    timeoutMs: { type: "number" },

    act: { type: "string", enum: ["click","type","press"] },
    selector: { type: "string" },
    elementId: { type: "string" },
    text: { type: "string" },
    key: { type: "string" },

    tabsAction: { type: "string", enum: ["list","new","switch","close"] },

    screenshotMode: { type: "string", enum: ["path","base64"] },
    fullPage: { type: "boolean" },
    path: { type: "string" },

    interestingOnly: { type: "boolean" }
  },
  required: ["action", "sessionId"]
}
```

Execute routing:
- `open`: launch session; optional initial `url`; returns `sessionId`, `tabId`, `url`, `title`.
- `navigate`: goto URL on active/specified tab.
- `act`:
  - `click`: locator click.
  - `type`: fill/type into selector.
  - `press`: key press, optionally after focusing selector.
  - Selector source: direct `selector` or cached `elementId` from latest snapshot.
- `snapshot`: return AX tree + compact text + interactive element list.
- `screenshot`: capture PNG and return path/base64 metadata.
- `tabs`: `list` / `new` / `switch` / `close`.
- `close`: close tab or full session.

Cancellation:
- Every action calls manager methods with `signal`.
- Use `Promise.race` abort wrapper for Playwright calls; if aborted, return `isError: true` with `"Browser action aborted"`.

## 4) Snapshot / accessible tree design

Source:
- `page.accessibility.snapshot({ interestingOnly })`.

Returned payload (JSON string in `content`):
- `url`, `title`, `tabId`.
- `axTree`: raw AX snapshot.
- `axText`: flattened role/name/value tree for LLM readability.
- `interactive`: DOM-derived actionable elements with stable ids:
  - `elementId`, `role`, `name`, `selectorHint`.

Implementation note:
- Extract `interactive` via `page.evaluate(...)` on `a, button, input, textarea, select, [role], [tabindex]`.
- Cache `elementId -> selectorHint` in session for later `act`.

## 5) Screenshot integration

Mode options:
- `screenshotMode: "path"` (default): save under workspace, return path + dimensions.
- `screenshotMode: "base64"`: inline base64 in result for vision consumers.

Path convention:
- `<workspaceRoot>/.friday/artifacts/browser/<sessionId>/<timestamp>-<tabId>.png`

Return fields:
- `mode`, `mimeType`, `path?`, `base64?`, `width`, `height`, `byteLength`.

## 6) Security boundaries

1. Allowed origin guard:
- Validate all navigation URLs before `goto`.
- Install `context.route("**/*")` to abort requests outside allowlist.
- Allowlist supports exact origin + wildcard subdomain.

2. Protocol and filesystem guard:
- Block non-http(s) by default (`file:`, `data:`, `chrome:`).
- Keep browser artifacts inside `workspaceRoot`.

3. Resource limits:
- Max sessions/tabs.
- Per-action timeout caps.
- Snapshot node cap and screenshot size cap.
- Reject oversized inline base64 responses.

4. Isolation:
- One browser context per `sessionId`.
- No shared cookies/storage across sessions.

## 7) Test strategy

Unit tests:
- `test/unit/browser/friday-browser-manager.test.ts`
  - session reuse, tab lifecycle, allowlist blocking, close behavior, abort behavior.
- `test/unit/agent/tools/friday-agent-browser-tool.test.ts`
  - action dispatch, validation errors, result formatting, `isError` paths.
- Use dependency injection for mocked Playwright launch/page/context.

E2E tests (real Playwright):
- `test/e2e/agent/friday-agent-browser-tool.e2e.test.ts`
- Run against local HTTP test server only.
- Validate full flow: `open -> snapshot -> act(click/type/press) -> screenshot -> tabs -> close`.
- Validate domain restriction: allowed localhost passes, external domain blocked.

## Implementation order for CC

1. Add `playwright` dependency.
2. Implement `src/browser/friday-browser-manager.ts`.
3. Implement `src/agent/tools/friday-agent-browser-tool.ts`.
4. Wire registry in `src/agent/tools/friday-agent-tool-registry.ts:32`.
5. Export in `src/agent/index.ts:84`.
6. Add hub config wiring in `src/hub/friday-hub-bootstrap.ts:170` and `src/hub/friday-hub-bootstrap.ts:552`.
7. Add unit tests, then e2e tests.
