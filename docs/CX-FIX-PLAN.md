> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

I’m going to verify the audit doc and every referenced source file first, then I’ll produce copy-paste-ready fixes for all 17 issues in the exact format you requested. I’ll start by loading the required workspace context files and then the audit references.
I’ve loaded the required workspace context files and now I’m moving to `.` to read the audit document and every referenced source file before drafting fixes.
I couldn’t find `docs/CX-AUDIT-RESULTS.md` in `.`, so I’m locating the audit file path first and then I’ll proceed through each referenced file exactly.
I’m blocked on one prerequisite: the specified `docs/CX-AUDIT-RESULTS.md` file is not present in `.`. I’m now locating any equivalent audit-results file and cross-checking the same 17 issue titles against source code directly.
I’m now validating the exact current implementations for hub/bootstrap, browser, XHS, and channel files so each fix snippet is pulled verbatim from source with accurate line ranges.
I’ve confirmed the XHS and channel-registry hotspots; next I’m extracting exact snippets for browser tool, QQ/Lark lifecycle, and hub routing so each plan item maps to precise current lines.
I’ve collected the core issue files; now I’m confirming env/config and bootstrap wiring paths so the fix plans include exact, consistent code that matches the current startup flow.
## P0-1: Wire browser + XHS into hub bootstrap (integration gap)
**File:** `src/hub/friday-hub-bootstrap.ts`  
**Lines:** `561-565`, `592-595`  
**Problem:** Browser/XHS dependencies are not passed into tool registries, so `browser`/`xhs` tools are never available in hub runtime.
**Current code:**
```ts
  // Build agent tool registry (exec, read, write, edit, web_fetch)
  const agentTools = createFridayAgentToolRegistry({
    workdir: config.stateDir ?? ".",
    memoryService,
  });
```
**Fix:**
```ts
import { createFridayBrowserManager } from "#browser";
import { createXhsPageInteractions, createXhsSessionManager } from "#xhs";
```

```ts
  const workspaceRoot = config.stateDir ?? ".";
  const browserManager = createFridayBrowserManager({
    workspaceRoot,
    headless: process.env.FRIDAY_BROWSER_HEADLESS !== "false",
  });
  const xhsSessionManager = createXhsSessionManager({
    sqlite: stateRuntime!.sqlite,
    nowIso,
  });
  const xhsPageInteractions = createXhsPageInteractions({
    browserManager,
    sessionManager: xhsSessionManager,
    artifactDir: path.join(workspaceRoot, ".friday", "artifacts", "xhs"),
  });

  const agentTools = createFridayAgentToolRegistry({
    workdir: workspaceRoot,
    memoryService,
    browserManager,
    xhsPageInteractions,
    xhsSessionManager,
  });
```

```ts
      const childTools = createFridayAgentToolRegistry({
        workdir: workspaceRoot,
        memoryService,
        browserManager,
        xhsPageInteractions,
        xhsSessionManager,
      });
```

```ts
      // 1. Stop channel plugins
      await channelRegistry.stopAll();
      await browserManager.close();
```
**Why:** The tool registry only includes optional tools when these deps are provided.
**Tests to add:** 
- `test/unit/hub/friday-hub-bootstrap.test.ts :: wires browser and xhs tools into parent runtime`
- `test/unit/hub/friday-hub-bootstrap.test.ts :: wires browser and xhs tools into child runtime`
- `test/integration/hub/friday-hub-bootstrap-integration.test.ts :: browser manager closes on hub.stop()`

## P0-2: Fix invalid CSS selector `text="登录"` in xhs-pages.ts
**File:** `src/xhs/friday-xhs-pages.ts`  
**Lines:** `402-409`  
**Problem:** `document.querySelector('text="登录"')` is invalid DOM selector syntax and can throw.
**Current code:**
```ts
async function detectLoginState(page: { evaluate: (fn: () => unknown) => Promise<unknown> }): Promise<boolean> {
  return (await page.evaluate(() => {
    // Check for logged-in indicators
    const hasAvatar = document.querySelector('[class*="avatar"], [class*="user-avatar"]') !== null;
    const hasLoginBtn = document.querySelector('text="登录"') !== null;
    const cookies = document.cookie;
    const hasSessionCookie = cookies.includes("web_session") || cookies.includes("a1");
    return (hasAvatar || hasSessionCookie) && !hasLoginBtn;
```
**Fix:**
```ts
async function detectLoginState(page: { evaluate: (fn: () => unknown) => Promise<unknown> }): Promise<boolean> {
  return (await page.evaluate(() => {
    const hasAvatar = document.querySelector('[class*="avatar"], [class*="user-avatar"]') !== null;
    const hasLoginBtn = Array.from(
      document.querySelectorAll('button, a, [role="button"], span, div'),
    ).some((el) => el.textContent?.trim() === "登录");
    const cookies = document.cookie;
    const hasSessionCookie = cookies.includes("web_session") || cookies.includes("a1");
    return (hasAvatar || hasSessionCookie) && !hasLoginBtn;
  })) as boolean;
}
```
**Why:** Uses valid DOM APIs and preserves login detection intent.
**Tests to add:** 
- `test/unit/xhs/friday-xhs-pages.test.ts :: detectLoginState does not throw on login check`
- `test/unit/xhs/friday-xhs-pages.test.ts :: detectLoginState returns false when 登录 button is present`

## P0-3: Fix browser launch leak — add try/finally to launch()
**File:** `src/browser/friday-browser-manager.ts`  
**Lines:** `146-170`  
**Problem:** If launch/context/page creation fails after browser starts, browser process can leak.
**Current code:**
```ts
    signal?.throwIfAborted();

    const browser = await launchFn({ headless });

    signal?.throwIfAborted();

    const context = await browser.newContext();
    context.setDefaultNavigationTimeout(navigationTimeoutMs);
    context.setDefaultTimeout(actionTimeoutMs);

    const page = await context.newPage();
    const tabId = "tab-1";

    const session: BrowserSession = {
```
**Fix:**
```ts
    signal?.throwIfAborted();

    let browser: Browser | undefined;
    let created = false;

    try {
      browser = await launchFn({ headless });

      signal?.throwIfAborted();

      const context = await browser.newContext();
      context.setDefaultNavigationTimeout(navigationTimeoutMs);
      context.setDefaultTimeout(actionTimeoutMs);

      const page = await context.newPage();
      const tabId = "tab-1";

      const session: BrowserSession = {
        browser,
        context,
        tabs: new Map([[tabId, page]]),
        activeTabId: tabId,
        elementCache: new Map(),
        tabCounter: 1,
      };

      sessions.set(sessionId, session);
      created = true;
      return { sessionId, tabId, reused: false };
    } finally {
      if (!created && browser) {
        await browser.close().catch(() => {});
      }
    }
```
**Why:** Guarantees cleanup on partial initialization failure.
**Tests to add:** 
- `test/unit/browser/friday-browser-manager.test.ts :: closes browser when aborted after launch`
- `test/unit/browser/friday-browser-manager.test.ts :: closes browser when newContext/newPage throws`

## P0-4: Fix QQ double reconnect — deduplicate reconnect logic
**File:** `src/channels/qq/friday-qq-channel.ts`  
**Lines:** `219-233`, `261-277`  
**Problem:** Reconnect is triggered both immediately and again via close handler, causing duplicate reconnect attempts.
**Current code:**
```ts
        case 7:
          // Reconnect requested
          reconnect(gatewayUrl);
          break;
        case 9:
          // Invalid session
          reconnect(gatewayUrl);
          break;
      }
    });

    ws.addEventListener("close", () => {
      if (!stopped) {
        setTimeout(() => reconnect(gatewayUrl), 5000);
      }
    });
```
**Fix:**
```ts
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleReconnect(gatewayUrl: string, delayMs = 5000): void {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnect(gatewayUrl);
    }, delayMs);
  }

  function connectWebSocket(gatewayUrl: string): void {
    if (stopped) return;

    const socket = new WebSocket(gatewayUrl);
    ws = socket;

    socket.addEventListener("message", (event) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }

      const op = data.op as number;
      const s = data.s as number | undefined;
      if (s !== undefined) lastSeq = s;

      switch (op) {
        case 10: {
          const heartbeatInterval =
            (data.d as Record<string, unknown>)?.heartbeat_interval as number | undefined;

          sendIdentify();

          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = setInterval(
            () => sendHeartbeat(),
            heartbeatInterval ?? QQ_HEARTBEAT_INTERVAL_MS,
          );
          break;
        }
        case 11:
          break;
        case 0:
          handleDispatch(data.t as string, data.d);
          break;
        case 7:
        case 9:
          scheduleReconnect(gatewayUrl, 0);
          break;
      }
    });

    socket.addEventListener("close", () => {
      if (ws !== socket) return;
      scheduleReconnect(gatewayUrl, 5000);
    });

    socket.addEventListener("error", () => {
      // Will trigger close event, which handles reconnection
    });
  }

  function reconnect(gatewayUrl: string): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    const socket = ws;
    ws = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    if (!stopped) {
      connectWebSocket(gatewayUrl);
    }
  }
```
**Why:** Coalesces reconnect triggers and ignores stale socket close events.
**Tests to add:** 
- `test/unit/channels/qq/friday-qq-channel.test.ts :: op7 plus close only schedules one reconnect`
- `test/unit/channels/qq/friday-qq-channel.test.ts :: stale socket close does not trigger extra reconnect`

## P0-5: Fix Lark reconnect-after-stop — check stopped flag before reconnect
**File:** `src/channels/lark/friday-lark-channel.ts`  
**Lines:** `230-253`  
**Problem:** Delayed reconnect callbacks can still run after `stop()` is called.
**Current code:**
```ts
    ws.addEventListener("close", () => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (!stopped) {
        setTimeout(() => {
          fetchWsEndpoint()
            .then((url) => connectWebSocket(url))
            .catch(() => {
              // Retry after delay
              if (!stopped) {
                setTimeout(() => {
                  fetchWsEndpoint()
                    .then((url) => connectWebSocket(url))
                    .catch(() => {
                      // Will eventually reconnect on next cycle
                    });
                }, WS_RECONNECT_DELAY_MS * 2);
              }
            });
        }, WS_RECONNECT_DELAY_MS);
      }
    });
```
**Fix:**
```ts
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleReconnect(delayMs = WS_RECONNECT_DELAY_MS): void {
    if (stopped || reconnectTimer) return;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped) return;

      fetchWsEndpoint()
        .then((url) => {
          if (stopped) return;
          connectWebSocket(url);
        })
        .catch(() => {
          if (!stopped) {
            scheduleReconnect(WS_RECONNECT_DELAY_MS * 2);
          }
        });
    }, delayMs);
  }

  ws.addEventListener("close", () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    scheduleReconnect();
  });
```

```ts
    async stop() {
      stopped = true;
      onMessage = null;

      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      if (ws) {
        ws.close();
        ws = null;
      }
    },
```
**Why:** Reconnect work is canceled/guarded once channel is stopped.
**Tests to add:** 
- `test/unit/channels/lark/friday-lark-channel.test.ts :: stop prevents reconnect timer callback from reconnecting`
- `test/unit/channels/lark/friday-lark-channel.test.ts :: stop clears pending reconnect timer`

## P0-6: Sanitize sessionId in screenshot/QR artifact paths
**File:** `src/browser/friday-browser-manager.ts`, `src/xhs/friday-xhs-pages.ts`  
**Lines:** `101-103`, `165-167`  
**Problem:** Raw `sessionId` is used in filesystem paths, allowing traversal/surprising path segments.
**Current code:**
```ts
export function browserArtifactDir(workspaceRoot: string, sessionId: string): string {
  return path.join(workspaceRoot, ".friday", "artifacts", "browser", sessionId);
}
```

```ts
    // Take QR code screenshot
    fs.mkdirSync(artifactDir, { recursive: true });
    const qrPath = path.join(artifactDir, `xhs-qr-${sessionId}-${Date.now()}.png`);
    const screenshotBuffer = await page.screenshot({ type: "png" });
    fs.writeFileSync(qrPath, screenshotBuffer);
```
**Fix:**
```ts
export function sanitizeArtifactPathSegment(input: string): string {
  const sanitized = input
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized.length > 0 ? sanitized : "session";
}

export function browserArtifactDir(workspaceRoot: string, sessionId: string): string {
  return path.join(
    workspaceRoot,
    ".friday",
    "artifacts",
    "browser",
    sanitizeArtifactPathSegment(sessionId),
  );
}
```

```ts
import { sanitizeArtifactPathSegment, type FridayBrowserManager } from "#browser";

    fs.mkdirSync(artifactDir, { recursive: true });
    const safeSessionId = sanitizeArtifactPathSegment(sessionId);
    const qrPath = path.join(artifactDir, `xhs-qr-${safeSessionId}-${Date.now()}.png`);
    const screenshotBuffer = await page.screenshot({ type: "png" });
    fs.writeFileSync(qrPath, screenshotBuffer);
```
**Why:** Prevents path injection and keeps artifacts confined to intended directories.
**Tests to add:** 
- `test/unit/browser/friday-browser-manager.test.ts :: browserArtifactDir sanitizes sessionId`
- `test/unit/xhs/friday-xhs-pages.test.ts :: login QR path sanitizes sessionId before write`

## P0-7: Add .gitignore patterns — `.friday/`, `*.db`
**File:** `.gitignore`  
**Lines:** `1-20`  
**Problem:** Runtime artifacts and SQLite DB files can be accidentally committed.
**Current code:**
```gitignore
node_modules/
dist/
build/
coverage/
*.tsbuildinfo

*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
```
**Fix:**
```gitignore
node_modules/
dist/
build/
coverage/
*.tsbuildinfo
*.db

*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

.env
.env.*
!.env.example

.DS_Store
.vscode/
.idea/
.openclaw/
.friday/
```
**Why:** Keeps local runtime state/artifacts out of source control.
**Tests to add:** 
- `test/unit/hygiene/gitignore.test.ts :: ignores .friday runtime artifacts`
- `test/unit/hygiene/gitignore.test.ts :: ignores sqlite db files`

## P0-8: Create GitHub Actions CI workflow (`.github/workflows/ci.yml`)
**File:** `.github/workflows/ci.yml`  
**Lines:** `1-37`  
**Problem:** No CI pipeline exists to enforce lint/build/test on PRs.
**Current code:**
```text
(file missing)
```
**Fix:**
```yaml
name: CI

on:
  push:
    branches:
      - main
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build-test:
    runs-on: ubuntu-latest
    timeout-minutes: 25

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Build
        run: npm run build

      - name: Unit tests
        run: npm test
```
**Why:** Establishes baseline quality gates for all incoming changes.
**Tests to add:** 
- `ci/build-test :: npm run lint`
- `ci/build-test :: npm run build`
- `ci/build-test :: npm test`

## P1-9: Guard JSON.parse in xhs-session.ts
**File:** `src/xhs/friday-xhs-session.ts`  
**Lines:** `73-80`, `97-99`  
**Problem:** Malformed persisted JSON can crash `loadCookies()`/`isSessionValid()`.
**Current code:**
```ts
  function loadCookies(sessionId: string): XhsCookie[] | undefined {
    return sqlite.withReadConnection((db) => {
      const row = db.prepare(`
        SELECT cookies_json FROM xhs_sessions WHERE id = ?
      `).get(sessionId) as { cookies_json: string } | undefined;

      if (!row) return undefined;
      return JSON.parse(row.cookies_json) as XhsCookie[];
    });
  }
```
**Fix:**
```ts
  function loadCookies(sessionId: string): XhsCookie[] | undefined {
    return sqlite.withReadConnection((db) => {
      const row = db.prepare(`
        SELECT cookies_json FROM xhs_sessions WHERE id = ?
      `).get(sessionId) as { cookies_json: string } | undefined;

      if (!row) return undefined;
      try {
        return JSON.parse(row.cookies_json) as XhsCookie[];
      } catch {
        return undefined;
      }
    });
  }

  function isSessionValid(sessionId: string): boolean {
    return sqlite.withReadConnection((db) => {
      const row = db.prepare(`
        SELECT cookies_json, last_used_at FROM xhs_sessions WHERE id = ?
      `).get(sessionId) as { cookies_json: string; last_used_at: string } | undefined;

      if (!row) return false;

      const lastUsed = new Date(row.last_used_at).getTime();
      if (Date.now() - lastUsed > SESSION_MAX_AGE_MS) return false;

      let cookies: XhsCookie[];
      try {
        cookies = JSON.parse(row.cookies_json) as XhsCookie[];
      } catch {
        return false;
      }

      const cookieNames = new Set(cookies.map((c) => c.name));
      return REQUIRED_COOKIE_NAMES.every((name) => cookieNames.has(name));
    });
  }
```
**Why:** Corrupt DB rows should degrade safely, not throw.
**Tests to add:** 
- `test/unit/xhs/friday-xhs-session.test.ts :: loadCookies returns undefined on malformed cookies_json`
- `test/unit/xhs/friday-xhs-session.test.ts :: isSessionValid returns false on malformed cookies_json`

## P1-10: Channel registry lifecycle — Promise.allSettled for start/stop
**File:** `src/channels/friday-channel-registry.ts`  
**Lines:** `96-127`  
**Problem:** `Promise.all` fail-fast can leave partial start/stop state and hide multi-failure context.
**Current code:**
```ts
    async startAll(handler) {
      const startPromises: Promise<void>[] = [];

      for (const [kind, entry] of entries) {
        if (entry.running) continue;

        const wrappedHandler = (msg: FridayChannelMessage) => {
          if (!checkAllowlist(msg, entry.allowlist)) return;
          handler(msg);
        };

        const startPromise = entry.plugin.start(wrappedHandler).then(() => {
          entry.running = true;
        });
        startPromises.push(startPromise);
      }

      await Promise.all(startPromises);
    },
```
**Fix:**
```ts
    async startAll(handler) {
      const startPromises: Promise<void>[] = [];

      for (const [, entry] of entries) {
        if (entry.running) continue;

        const wrappedHandler = (msg: FridayChannelMessage) => {
          if (!checkAllowlist(msg, entry.allowlist)) return;
          handler(msg);
        };

        startPromises.push(
          entry.plugin.start(wrappedHandler).then(() => {
            entry.running = true;
          }),
        );
      }

      const results = await Promise.allSettled(startPromises);
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length > 0) {
        throw new Error(
          `Failed to start ${String(failures.length)} channel(s): ` +
            failures
              .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
              .join("; "),
        );
      }
    },

    async stopAll() {
      const stopPromises: Promise<void>[] = [];

      for (const [, entry] of entries) {
        if (!entry.running) continue;
        stopPromises.push(
          entry.plugin.stop().finally(() => {
            entry.running = false;
          }),
        );
      }

      const results = await Promise.allSettled(stopPromises);
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length > 0) {
        throw new Error(
          `Failed to stop ${String(failures.length)} channel(s): ` +
            failures
              .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
              .join("; "),
        );
      }
    },
```
**Why:** Ensures all lifecycle ops are attempted and failures are aggregated deterministically.
**Tests to add:** 
- `test/unit/channels/friday-channel-registry.test.ts :: startAll aggregates failures and still starts successful plugins`
- `test/unit/channels/friday-channel-registry.test.ts :: stopAll aggregates failures and clears running flags`

## P1-11: Tab leak on invalid URL — close tab before returning error in tabs=new
**File:** `src/agent/tools/friday-agent-browser-tool.ts`  
**Lines:** `440-450`  
**Problem:** `tabs:new` creates a tab before URL validation; invalid URL returns error without closing created tab.
**Current code:**
```ts
      case "new": {
        const { tabId, page } = await browserManager.getPage(
          sessionId,
          { createIfMissing: true, tabId: `__new_${String(Date.now())}` },
          signal,
        );
        const url = readStringParam(args, "url");
        if (url) {
          const urlError = validateUrl(url, browserManager.options.allowedOrigins);
          if (urlError) return errorResult(urlError);
          await page.goto(url, { waitUntil: "load" });
        }
```
**Fix:**
```ts
      case "new": {
        const { tabId, page } = await browserManager.getPage(
          sessionId,
          { createIfMissing: true, tabId: `__new_${String(Date.now())}` },
          signal,
        );
        const url = readStringParam(args, "url");
        if (url) {
          const urlError = validateUrl(url, browserManager.options.allowedOrigins);
          if (urlError) {
            await page.close().catch(() => {});
            session.tabs.delete(tabId);
            if (session.activeTabId === tabId && session.tabs.size > 0) {
              session.activeTabId = session.tabs.keys().next().value!;
            }
            return errorResult(urlError);
          }
          await page.goto(url, { waitUntil: "load" });
        }
        return jsonResult({
          sessionId,
          tabId,
          url: page.url(),
          title: await page.title(),
        });
      }
```
**Why:** Prevents orphan tabs when URL input fails validation.
**Tests to add:** 
- `test/unit/agent/tools/friday-agent-browser-tool.test.ts :: tabs new closes created tab on invalid url`
- `test/unit/agent/tools/friday-agent-browser-tool.test.ts :: tabs new does not increase tab count on invalid url`

## P1-12: Channel input bounds — add message length limit before executeRun
**File:** `src/hub/friday-hub-bootstrap.ts`  
**Lines:** `740-745`  
**Problem:** Inbound channel messages are passed directly into `executeRun` with no size bounds.
**Current code:**
```ts
        await channelRegistry.startAll((msg: FridayChannelMessage) => {
          // Route inbound channel messages to agent runtime
          const sessionKey = `channel:${msg.channelKind}:${msg.chatId}`;
          agentRuntime
            .executeRun({ task: msg.text, sessionKey })
            .then((result) => {
```
**Fix:**
```ts
const FRIDAY_CHANNEL_MAX_MESSAGE_LENGTH = 4000;
```

```ts
        await channelRegistry.startAll((msg: FridayChannelMessage) => {
          const text = msg.text.trim();
          if (text.length === 0) return;

          if (text.length > FRIDAY_CHANNEL_MAX_MESSAGE_LENGTH) {
            channelRegistry
              .send(msg.channelKind, {
                chatId: msg.chatId,
                text: `Message too long (max ${String(FRIDAY_CHANNEL_MAX_MESSAGE_LENGTH)} chars).`,
                replyTo: msg.id,
              })
              .catch((err) => {
                console.error(`[friday] Channel send failed (${msg.channelKind}):`, err);
              });
            return;
          }

          const sessionKey = `channel:${msg.channelKind}:${msg.chatId}`;
          agentRuntime
            .executeRun({ task: text, sessionKey })
```
**Why:** Prevents oversized prompts from exhausting runtime resources.
**Tests to add:** 
- `test/unit/hub/friday-hub-bootstrap.test.ts :: skips executeRun for oversized inbound channel message`
- `test/unit/hub/friday-hub-bootstrap.test.ts :: ignores empty inbound channel message`

## P1-13: QQ/Lark start() rollback — cleanup on partial failure
**File:** `src/channels/qq/friday-qq-channel.ts`, `src/channels/lark/friday-lark-channel.ts`  
**Lines:** `296-303`, `283-292`  
**Problem:** `start()` mutates runtime state before async failures and does not rollback partially initialized state.
**Current code:**
```ts
    async start(handler) {
      onMessage = handler;
      stopped = false;

      await refreshToken();
      const gatewayUrl = await fetchGatewayUrl();
      connectWebSocket(gatewayUrl);
    },
```
**Fix:**
```ts
    async start(handler) {
      onMessage = handler;
      stopped = false;

      try {
        await refreshToken();
        const gatewayUrl = await fetchGatewayUrl();
        connectWebSocket(gatewayUrl);
      } catch (error) {
        stopped = true;
        onMessage = null;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (ws) {
          try {
            ws.close();
          } catch {
            // ignore
          }
          ws = null;
        }
        throw error;
      }
    },
```

```ts
    async start(handler) {
      onMessage = handler;
      stopped = false;

      try {
        await refreshToken();

        if (config!.receiveMode === "websocket") {
          const wsUrl = await fetchWsEndpoint();
          connectWebSocket(wsUrl);
        }
      } catch (error) {
        stopped = true;
        onMessage = null;
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (ws) {
          try {
            ws.close();
          } catch {
            // ignore
          }
          ws = null;
        }
        throw error;
      }

      // Webhook mode: messages arrive via HTTP handler (not implemented here —
      // requires integration with the API runtime HTTP server).
    },
```
**Why:** Ensures channel instance is left in a clean stopped state if startup fails mid-flight.
**Tests to add:** 
- `test/unit/channels/qq/friday-qq-channel.test.ts :: start rollback clears handler/timers/socket when token fetch fails`
- `test/unit/channels/lark/friday-lark-channel.test.ts :: start rollback clears handler/timers/socket when ws endpoint fetch fails`

## P1-14: Update README with browser/channels/xhs features
**File:** `README.md`  
**Lines:** `44-56`  
**Problem:** Feature list omits newly shipped browser, channel, and XHS capabilities.
**Current code:**
```md
## Key Features

- **Skills** — Discover, validate, and execute skills from directories or archives. Shell, Node, Python, HTTP.
- **Skill Generator** — AI-generated skills from natural-language descriptions.
- **Skill Converter** — Import from Clawdbot SKILL.md, n8n nodes, or OpenAI GPT Actions.
- **Plugins** — Extend Friday with loadable plugin packages.
- **Workflows** — Visual DAG editor with draft/publish, versioning, triggers, and approval nodes.
- **Memory** — Per-session memory with PII guarding, embedding search, and quota limits.
- **Sessions** — Multi-turn conversation state with memory extraction.
- **Fleet** — Dashboard for satellite health, trust scoring, and security revocation.
- **Learning** — Self-learning pipeline: error diagnosis, auto-fix plans, preference extraction.
- **Providers (BYOK)** — Register, validate, and route to any LLM provider with usage tracking.
```
**Fix:**
```md
## Key Features

- **Skills** — Discover, validate, and execute skills from directories or archives. Shell, Node, Python, HTTP.
- **Browser Automation** — Headless Playwright tool with open/navigate/act/snapshot/screenshot/tabs controls.
- **XHS Automation** — `xhs` tool for 小红书 login (QR), search, posting, and comment extraction.
- **Channels (QQ + Lark/Feishu)** — Inbound message routing to agent runtime with allowlists and outbound replies.
- **Skill Generator** — AI-generated skills from natural-language descriptions.
- **Skill Converter** — Import from Clawdbot SKILL.md, n8n nodes, or OpenAI GPT Actions.
- **Plugins** — Extend Friday with loadable plugin packages.
- **Workflows** — Visual DAG editor with draft/publish, versioning, triggers, and approval nodes.
- **Memory** — Per-session memory with PII guarding, embedding search, and quota limits.
- **Sessions** — Multi-turn conversation state with memory extraction.
- **Fleet** — Dashboard for satellite health, trust scoring, and security revocation.
- **Learning** — Self-learning pipeline: error diagnosis, auto-fix plans, preference extraction.
- **Providers (BYOK)** — Register, validate, and route to any LLM provider with usage tracking.
```
**Why:** README should reflect actual shipped runtime capabilities.
**Tests to add:** 
- `test/unit/docs/readme.test.ts :: key features include Browser Automation`
- `test/unit/docs/readme.test.ts :: key features include Channels and XHS`

## P1-15: Create CONTRIBUTING.md + CHANGELOG.md
**File:** `CONTRIBUTING.md`, `CHANGELOG.md`  
**Lines:** `1-57`, `1-26`  
**Problem:** Project lacks contributor workflow guidance and release history file.
**Current code:**
```text
(files missing)
```
**Fix:**
```md
# Contributing to Friday

Thanks for contributing to Friday.

## Prerequisites
- Node.js 22+
- npm 10+
- Git

## Setup
```bash
git clone https://github.com/thesongzhu/Friday.git
cd Friday
npm ci
npm run build
```

## Development Workflow
1. Create a branch from `main`.
2. Make focused changes with tests.
3. Run local checks before opening a PR:
```bash
npm run lint
npm run build
npm test
```

## Code Standards
- TypeScript strict mode; avoid `any`.
- Keep public naming conventions (`Friday*`, `createFriday*`).
- Prefer small, reviewable commits.

## Tests
- Add/adjust unit tests for logic changes.
- Add integration tests when wiring runtime components.
- Include regression tests for bug fixes.

## Pull Request Checklist
- [ ] Lint/build/tests pass locally.
- [ ] New behavior is covered by tests.
- [ ] Docs are updated when behavior/config changes.
- [ ] PR description explains problem, fix, and verification.

## Security
- Never commit secrets.
- Keep `.env.example` sanitized.
- Report vulnerabilities privately to maintainers.
```

```md
# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog,
and this project follows Semantic Versioning.

## [Unreleased]

### Added
- TBD

### Changed
- TBD

### Fixed
- TBD

## [0.3.0] - 2026-02-20

### Added
- Browser automation module and `browser` agent tool.
- Channel runtime foundation with QQ and Lark/Feishu connectors.
- XHS session/page tooling and `xhs` agent tool.
```
**Why:** OSS readiness requires contributor guidance and change tracking.
**Tests to add:** 
- `test/unit/docs/contributing.test.ts :: CONTRIBUTING contains setup and PR checklist`
- `test/unit/docs/changelog.test.ts :: CHANGELOG contains Unreleased and current release sections`

## P1-16: Fix .env.example — add channel config vars
**File:** `.env.example`  
**Lines:** `24-37`  
**Problem:** Env template does not document channel runtime config inputs.
**Current code:**
```env
# Comma-separated CORS origins.
# Default: disabled (empty). Set to "*" to allow all origins,
# or specify domains like "https://app.example.com,https://admin.example.com".
# FRIDAY_CORS_ORIGINS=

# Enable request logging ("true" or "false").
# FRIDAY_LOG_REQUESTS=true

# Enable HTTP Strict Transport Security header ("true" or "false").
# Only enable behind a TLS-terminating reverse proxy.
# FRIDAY_ENABLE_HSTS=false

# Node environment. Set to "production" for production deployments.
# NODE_ENV=development
```
**Fix:**
```env
# Comma-separated CORS origins.
# Default: disabled (empty). Set to "*" to allow all origins,
# or specify domains like "https://app.example.com,https://admin.example.com".
# FRIDAY_CORS_ORIGINS=

# Enable request logging ("true" or "false").
# FRIDAY_LOG_REQUESTS=true

# Optional static UI build directory served by `friday start`.
# FRIDAY_UI_DIST_DIR=./dist/ui

# Channel bridge config as JSON (qq/lark/feishu instances).
# Example:
# FRIDAY_CHANNELS_JSON={"enabled":true,"instances":[{"kind":"qq","enabled":true,"appId":"qq-app-id","appSecret":"qq-app-secret","sandbox":false},{"kind":"lark","enabled":true,"appId":"lark-app-id","appSecret":"lark-app-secret","useFeishu":false,"receiveMode":"websocket"}]}
# FRIDAY_CHANNELS_JSON=

# Enable HTTP Strict Transport Security header ("true" or "false").
# Only enable behind a TLS-terminating reverse proxy.
# FRIDAY_ENABLE_HSTS=false

# Node environment. Set to "production" for production deployments.
# NODE_ENV=development
```
**Why:** Makes channel bootstrap configuration discoverable for operators.
**Tests to add:** 
- `test/unit/docs/env-example.test.ts :: includes FRIDAY_CHANNELS_JSON example`
- `test/unit/docs/env-example.test.ts :: includes FRIDAY_UI_DIST_DIR`

## P1-17: Fix Dockerfile — include UI build inputs
**File:** `Dockerfile`  
**Lines:** `17-20`  
**Problem:** Builder stage runs `npm run build` (includes `build:ui`) without copying `ui/` sources.
**Current code:**
```Dockerfile
COPY tsconfig.json ./
COPY src ./src

RUN npm run build
```
**Fix:**
```Dockerfile
COPY tsconfig.json ./
COPY src ./src
COPY ui ./ui

RUN npm run build
```
**Why:** UI build step must have UI source/config present in Docker build context.
**Tests to add:** 
- `test/integration/docker/dockerfile-build.test.ts :: docker build succeeds with ui assets included`
- `test/integration/docker/dockerfile-build.test.ts :: dist/ui exists in builder output`
