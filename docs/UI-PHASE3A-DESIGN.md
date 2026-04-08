Could not write `/tmp/friday-ui-phase3a-design.md` in this environment because the filesystem is read-only (`operation not permitted`).  
Below is the exact design content to use for that file.

---

# Friday Web UI Phase 3A Design (Core Shell + Agent MVP)
Date: 2026-02-19  
Target repo: `.`

## 0) Decisions
1. UI lives in a dedicated top-level folder: `ui/` (not inside `src/`).
2. Vite builds static assets to `dist/ui/`.
3. Friday HTTP server serves `dist/ui/` for non-API routes, with SPA fallback to `index.html`.
4. API remains at `/v1/*` on the same port (`3141`).
5. Dev mode uses `vite dev` on `5173` with proxy `/v1 -> http://127.0.0.1:3141`.
6. SSE client uses `fetch` stream parsing (not native `EventSource`) so Authorization header works.

---

## 1) File Tree (every new file)

```text
ui/index.html
ui/vite.config.ts
ui/tailwind.config.ts
ui/postcss.config.cjs
ui/tsconfig.json
ui/components.json

ui/src/main.tsx
ui/src/App.tsx
ui/src/router.tsx
ui/src/styles/globals.css

ui/src/lib/utils/cn.ts
ui/src/lib/storage/auth-storage.ts
ui/src/lib/api/types.ts
ui/src/lib/api/client.ts
ui/src/lib/api/auth.ts
ui/src/lib/api/agent.ts

ui/src/providers/query-provider.tsx
ui/src/providers/auth-provider.tsx

ui/src/hooks/use-auth.ts
ui/src/hooks/use-agent-run-events.ts

ui/src/components/layout/app-shell.tsx
ui/src/components/layout/sidebar.tsx
ui/src/components/layout/logo.tsx
ui/src/components/layout/top-bar.tsx

ui/src/components/agent/task-input.tsx
ui/src/components/agent/live-run-panel.tsx
ui/src/components/agent/run-history-list.tsx
ui/src/components/agent/subagent-tree.tsx
ui/src/components/agent/save-as-automation-button.tsx
ui/src/components/agent/tool-call-log.tsx

ui/src/components/shared/status-badge.tsx

ui/src/components/ui/button.tsx
ui/src/components/ui/card.tsx
ui/src/components/ui/badge.tsx
ui/src/components/ui/input.tsx
ui/src/components/ui/textarea.tsx
ui/src/components/ui/scroll-area.tsx
ui/src/components/ui/separator.tsx
ui/src/components/ui/dropdown-menu.tsx

ui/src/routes/login-page.tsx
ui/src/routes/agent-page.tsx
ui/src/routes/placeholder-page.tsx

test/unit/api/http/friday-http-server-static-ui.test.ts
test/unit/api/http/friday-http-server-sse-raw.test.ts
```

Existing files to modify:

```text
package.json
src/api/http/friday-http-server.ts
src/api/runtime/friday-api-runtime.ts
src/api/runtime/friday-api-runtime.types.ts
src/cli/friday-cli-run-loop.ts
src/hub/friday-hub-bootstrap.ts
src/cli/friday-cli.ts
```

---

## 2) Package additions (exact)

Runtime deps:
```bash
npm i react react-dom react-router-dom @tanstack/react-query clsx class-variance-authority tailwind-merge lucide-react eventsource-parser sonner @radix-ui/react-slot @radix-ui/react-scroll-area @radix-ui/react-separator @radix-ui/react-dropdown-menu
```

Dev deps:
```bash
npm i -D vite @vitejs/plugin-react @types/react @types/react-dom tailwindcss postcss autoprefixer tailwindcss-animate shadcn
```

---

## 3) Vite config (complete `ui/vite.config.ts`)

```ts
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: resolve(__dirname),
  appType: "spa",
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:3141",
        changeOrigin: false,
        secure: false,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: resolve(__dirname, "../dist/ui"),
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    assetsDir: "assets",
    manifest: true,
  },
});
```

---

## 4) Tailwind config (complete `ui/tailwind.config.ts` with WOM v2)

```ts
import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        wom: {
          navy: "#1E3A5F",
          "navy-light": "#2A4A73",
          "navy-dark": "#152B47",
          coral: "#E8A87C",
          "coral-light": "#F5C9A8",
          "coral-dark": "#D4885A",
          "warm-white": "#FEFDFB",
          cream: "#F5F3F0",
          "cream-dark": "#EBE8E3",
        },
        background: "#FEFDFB",
        foreground: "#152B47",
        border: "#EBE8E3",
        ring: "#E8A87C",
        primary: {
          DEFAULT: "#1E3A5F",
          foreground: "#FEFDFB",
        },
        accent: {
          DEFAULT: "#E8A87C",
          foreground: "#152B47",
        },
        muted: {
          DEFAULT: "#F5F3F0",
          foreground: "#2A4A73",
        },
        success: "#10B981",
        warning: "#F59E0B",
        destructive: "#E74C3C",
      },
      width: {
        sidebar: "200px",
      },
      borderRadius: {
        card: "1rem",
        btn: "0.75rem",
        lg: "1rem",
        md: "0.75rem",
        sm: "0.5rem",
      },
      boxShadow: {
        card: "0 1px 3px rgba(0,0,0,0.08)",
        "card-hover": "0 10px 25px rgba(0,0,0,0.10)",
      },
    },
  },
  plugins: [animate],
};

export default config;
```

---

## 5) HTTP server changes (exact modifications)

### 5.1 `src/api/http/friday-http-server.ts`
1. Extend deps:
```ts
uiStaticDir?: string;
```

2. Add imports:
```ts
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
```

3. Add helpers:
- `isApiPath(pathname: string): boolean` with `/v1` and `/v1/*`.
- `resolveSafeUiPath(uiStaticDir, pathname): string | null` to block traversal.
- `getMimeType(filePath)` map for `.html`, `.js`, `.css`, `.json`, `.svg`, `.png`, `.jpg`, `.woff2`.
- `serveStaticFile(res, filePath, headOnly)` with security headers and cache policy.
- `tryServeUiAsset({ uiStaticDir, pathname, headOnly }): Promise<boolean>`:
  - If direct asset exists, serve it.
  - Else fallback to `${uiStaticDir}/index.html`.

4. Request flow change:
- Parse URL first.
- If non-API path and method is `GET` or `HEAD`, call `tryServeUiAsset(...)` before route matching.
- If static served, return.
- Existing JSON 404 behavior remains for `/v1/*`.

5. SSE raw response fix:
- Inject raw response into context:
```ts
(ctx as FridayHttpContext<unknown, unknown, unknown> & { _raw?: ServerResponse })._raw = res;
```
- After `await route.handler(ctx)`, short-circuit if handler already took response:
```ts
if (res.headersSent || res.writableEnded) return;
```
- In catch block, if headers already sent, avoid writing JSON again.

### 5.2 `src/cli/friday-cli-run-loop.ts`
- Pass UI static dir to HTTP server:
```ts
uiStaticDir: resolve(process.cwd(), "dist/ui")
```

### 5.3 `src/cli/friday-cli.ts` and `src/hub/friday-hub-bootstrap.ts`
- Update help text: `--port` is active for full API+UI server (not “future use”).
- Optional config knob:
  - `FRIDAY_UI_DIST_DIR` env override.
  - default remains `dist/ui`.

### 5.4 `src/api/runtime/friday-api-runtime.ts` and `.types.ts` (required for sub-agent tree endpoint wiring)
- Import and register `createFridaySubagentRoutes` when `subagentRegistry` exists.
- Add optional dep in `CreateFridayApiRuntimeDeps`:
```ts
subagentRegistry?: FridaySubagentRegistry;
```
- Register:
```ts
if (deps.subagentRegistry) {
  for (const route of createFridaySubagentRoutes({ subagentRegistry: deps.subagentRegistry })) {
    routes.register(route);
  }
}
```

---

## 6) Component specs (props, logic, API calls)

### 6.1 `TaskInput`
```ts
interface TaskInputProps {
  disabled?: boolean;
  defaultValue?: string;
  onSubmit: (input: { task: string; model?: string; timeoutMs?: number }) => Promise<void>;
}
```
Implementation logic:
- Auto-resizing textarea.
- `Enter` submits when no `Shift`; `Shift+Enter` inserts newline.
- Trim task; prevent empty submit.
- Optional advanced controls for model and timeout (collapsed by default).

API calls:
- `POST /v1/agent/runs` body `{ task, model?, timeoutMs? }`.

### 6.2 `LiveRunPanel`
```ts
interface LiveRunPanelProps {
  runId: string;
  task: string;
  onRunTerminal?: (status: string) => void;
}
```
Implementation logic:
- Uses `useAgentRunEvents(runId)` for live timeline.
- Hydrates initial run state via `GET /v1/agent/runs/:runId`.
- Shows status badge, streamed output, tool log, sub-agent tree.
- Cancel button with optimistic state (“Cancelling...”), disabled once terminal.

API calls:
- `GET /v1/agent/runs/:runId`
- `GET /v1/agent/runs/:runId/events` (stream)
- `POST /v1/agent/runs/:runId/cancel`

### 6.3 `RunHistoryList`
```ts
interface RunHistoryListProps {
  selectedRunId?: string;
  statusFilter?: "completed" | "failed" | "cancelled" | "executing" | "planning";
  onSelectRun: (runId: string) => void;
}
```
Implementation logic:
- Query list with polling every 15s.
- Render cards with task preview, status, duration, timestamp.
- Click card selects run and loads it in `LiveRunPanel`.

API calls:
- `GET /v1/agent/runs?limit=30&status=<optional>`

### 6.4 `SubagentTree`
```ts
interface SubagentTreeProps {
  runId: string;
  streamEvents: AgentRunStreamEvent[];
}
```
Implementation logic:
- Initial fetch for persisted sub-agent runs.
- Merge live `agent.subagent.spawned` and `agent.subagent.completed`.
- Build tree by `parentRunId` and render nested rows with status + duration.

API calls:
- `GET /v1/agent/runs/:runId/subagents`
- Optional fallback: `GET /v1/agent/subagents?parentRunId=<runId>`

### 6.5 `SaveAsAutomationButton`
```ts
interface SaveAsAutomationButtonProps {
  run: FridayAgentRunRecord;
  disabled?: boolean;
}
```
Implementation logic:
- Enabled only when run is `completed`.
- Modal captures `name` and optional `description`.
- Default `taskTemplate` from `run.task`.
- On success, toast + invalidate automations query.

API calls:
- `POST /v1/agent/automations` body:
```json
{
  "name": "<user input>",
  "description": "<optional>",
  "sourceRunId": "<run.id>",
  "taskTemplate": "<run.task>",
  "enabled": true
}
```

### 6.6 `Sidebar` and `Logo` (WOM shell)
```ts
interface SidebarProps {
  powerMode: boolean;
  onTogglePowerMode: (next: boolean) => void;
}
```
Implementation logic:
- Fixed 200px width.
- Navy background.
- Active item: coral text + `rgba(232,168,124,0.2)` bg.
- `Friday.` logo with white text and coral period.
- `powerMode` stored in localStorage controls progressive disclosure groups.

API calls:
- None.

---

## 7) `useAgentRunEvents` hook spec

File: `ui/src/hooks/use-agent-run-events.ts`

```ts
interface UseAgentRunEventsOptions {
  enabled?: boolean;
  onTerminal?: (status: "completed" | "failed" | "cancelled" | "failed_tests") => void;
}

interface UseAgentRunEventsResult {
  connectionState: "idle" | "connecting" | "streaming" | "closed" | "error";
  status: string | null;
  outputText: string;
  events: AgentRunStreamEvent[];
  toolCalls: ToolCallViewModel[];
  subagents: SubagentNodeViewModel[];
  errorMessage?: string;
  reconnect: () => void;
}
```

Implementation details:
1. Start only when `runId` exists and `enabled !== false`.
2. Use authenticated `fetch` GET for `/v1/agent/runs/:runId/events`.
3. Parse SSE with `eventsource-parser`.
4. Ignore keepalive comments.
5. Reducer behavior:
- `agent.run.text_delta`: append `delta` to output.
- `agent.run.tool_start`: add running tool call.
- `agent.run.tool_end`: close tool call with duration and summary.
- `agent.subagent.spawned`: add node.
- `agent.subagent.completed`: update node outcome.
- terminal events: set closed + invoke `onTerminal`.
6. Reconnect strategy:
- Retry on transient network errors with backoff (0.5s, 1s, 2s, 5s).
- Stop reconnect after terminal event or explicit unmount.
7. Auth handling:
- If stream response is 401, trigger refresh flow once, then reconnect.
- If refresh fails, propagate auth-expired state.

---

## 8) API client spec (typed fetch + auth refresh)

Files:
- `ui/src/lib/api/types.ts`
- `ui/src/lib/api/client.ts`
- `ui/src/lib/storage/auth-storage.ts`

Core types:
```ts
type ApiSuccess<T> = { ok: true; data: T; requestId: string };
type ApiFailure = { ok: false; error: { code: string; message: string; retryable?: boolean; retryAfterMs?: number }; requestId: string };
type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;
```

Client contract:
```ts
class FridayApiClient {
  get<T>(path: string, init?: RequestInit): Promise<T>;
  post<TReq, TRes>(path: string, body: TReq, init?: RequestInit): Promise<TRes>;
  patch<TReq, TRes>(path: string, body: TReq, init?: RequestInit): Promise<TRes>;
  del<T>(path: string, init?: RequestInit): Promise<T>;
  refreshSession(): Promise<void>;
  clearSession(): void;
}
```

Behavior:
1. Base URL is empty string; all calls use absolute `/v1/...`.
2. Adds `Authorization: Bearer <accessToken>` if token exists.
3. On 401 for authenticated request:
- Run single-flight refresh with `/v1/auth/refresh` and stored refresh token.
- Retry original request exactly once.
- If refresh fails, clear storage and throw `AuthExpiredError`.
4. Always unwrap Friday envelope.
5. Throw typed `ApiError` when `ok: false` or non-2xx.

---

## 9) Router setup (React Router)

File: `ui/src/router.tsx`

```ts
import { Navigate, createBrowserRouter } from "react-router-dom";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    path: "/",
    element: <RequireAuth><AppShell /></RequireAuth>,
    children: [
      { index: true, element: <AgentPage /> },
      { path: "automations", element: <PlaceholderPage title="Automations (Phase 3B)" /> },
      { path: "skills", element: <PlaceholderPage title="Skills (Phase 3B)" /> },
      { path: "workflows", element: <PlaceholderPage title="Workflows (Phase 3C)" /> },
      { path: "sessions", element: <PlaceholderPage title="Sessions (Phase 3D)" /> },
      { path: "memory", element: <PlaceholderPage title="Memory (Phase 3D)" /> },
      { path: "settings", element: <PlaceholderPage title="Settings (Phase 3D)" /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
```

Auth flow:
1. `AuthProvider` bootstraps from localStorage.
2. If token exists, call `/v1/auth/me`.
3. If `me` fails and refresh fails, redirect `/login`.
4. Login page:
- Primary button: dev local login via `{ local: true }`.
- Secondary form: `localPassphrase` or `email/password`.
5. Store `accessToken` and `refreshToken` in localStorage keys:
- `friday.auth.accessToken`
- `friday.auth.refreshToken`
- `friday.auth.user`

---

## 10) Build integration (`friday start` + dev mode)

### 10.1 `package.json` scripts
```json
{
  "scripts": {
    "build:api": "tsc",
    "build:ui": "vite build --config ui/vite.config.ts",
    "build": "npm run build:api && npm run build:ui",
    "prestart": "npm run build",
    "start": "node dist/cli/friday-cli.js start",
    "ui:dev": "vite --config ui/vite.config.ts",
    "ui:preview": "vite preview --config ui/vite.config.ts"
  }
}
```

### 10.2 Runtime serving behavior
1. `npm run build` creates API in `dist/**` and SPA in `dist/ui/**`.
2. `npm run start` first rebuilds `dist/**`, then launches Friday server.
3. Requests to `/v1/*` hit API routes.
4. Requests to `/assets/*` or other static paths hit `dist/ui`.
5. Any non-API route without file match falls back to `dist/ui/index.html` (SPA history fallback).

### 10.3 Dev behavior
1. Terminal A: run backend at `3141`.
2. Terminal B: `npm run ui:dev` (Vite at `5173`).
3. Browser: open `http://127.0.0.1:5173`.
4. UI requests to `/v1/*` are proxied to backend `3141`.

---

## 11) Implementation order for CC (zero-ambiguity sequence)

1. Add npm packages and scripts in `package.json`.
2. Scaffold `ui/` folder with Vite entry, tsconfig, PostCSS, Tailwind, shadcn config.
3. Add Tailwind tokens and global styles (WOM v2 colors, radius, shadows).
4. Implement shared UI primitives (`ui/components/ui/*`) and `cn` util.
5. Implement API client + auth storage + auth provider + `use-auth`.
6. Implement router with protected shell + `/login` + `/` agent route.
7. Implement layout shell (`AppShell`, `Sidebar`, `Logo`, `TopBar`) with exact WOM sidebar spec.
8. Implement agent API module (`startRun`, `listRuns`, `getRun`, `cancelRun`, `saveAutomation`, `listSubagents`).
9. Implement `TaskInput`, `RunHistoryList`, and agent page orchestration.
10. Implement `useAgentRunEvents` streaming hook with fetch + parser + reconnect.
11. Implement `LiveRunPanel`, `ToolCallLog`, `SubagentTree`, `SaveAsAutomationButton`.
12. Update HTTP server for static file serving and SPA fallback.
13. Update HTTP server to inject `_raw` and support SSE response takeover.
14. Register sub-agent routes in API runtime if not already wired.
15. Wire `uiStaticDir` in CLI run loop and config.
16. Add tests for static serving + SPA fallback + SSE raw takeover.
17. Validate manually:
- `npm run start`
- open `http://localhost:3141`
- login (dev local)
- run task
- observe live stream
- save automation
- refresh browser on `/automations` path and ensure SPA fallback works.

---

If you want, I can also produce this as a patch-ready checklist with exact method signatures and test case names per file.
