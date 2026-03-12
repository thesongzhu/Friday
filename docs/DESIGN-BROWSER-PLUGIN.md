I’ll start by loading the required session context files (`SOUL.md`, `USER.md`, recent `memory/*.md`, and `MEMORY.md`), then I’ll inspect the current tool architecture under `src/agent/tools` so the browser design matches Friday’s existing patterns.

I found the workspace files and today’s date (`2026-02-20`). Next I’m loading the required identity/memory docs, including `BOOTSTRAP.md` since it exists.

Session context files are loaded; there are no existing `memory/` or `MEMORY.md` files in this workspace. I’m now inspecting `.` to map current tool interfaces and registry wiring before drafting the browser plugin design.

There’s no existing `src/browser/` module yet, so this will be a net-new boundary. I’m now reading the tool registry and type definitions to align the new browser tool contract exactly with existing patterns.

I confirmed the registry factory and helper patterns. Next I’m reading the core tool type file and a couple of concrete tools (`exec`, `web_fetch`) to mirror schema shape, error handling, and abort behavior in the browser design.

I now have the exact tool contract and helper style. I’m checking constants and existing tool tests next so the design includes concrete limits and a test plan that fits this repo’s current testing approach.

I verified there’s no `src/agent/tools/index.ts` in this repo today; integration currently happens via `friday-agent-tool-registry.ts`. I’m now checking OpenClaw reference files in `.openclaw/` plus existing tool tests to shape the action schema and lifecycle behavior.

I confirmed the repository layout and that top-level exports are module-scoped (for example `src/agent/index.ts`), not a single `src/index.ts`. I’m now checking where to thread browser manager configuration from hub/bootstrap into the tool registry.

I’ve gathered enough context to draft the implementation-ready design. I’m pulling exact insertion points (line references) in the registry and hub bootstrap so CC can wire the browser tool with minimal ambiguity.

**Friday Browser Plugin Design (v1, OpenClaw-inspired)**

`src/agent/tools/index.ts` does not exist in this repo today; the actual registry integration point is `src/agent/tools/friday-agent-tool-registry.ts:27`.

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
