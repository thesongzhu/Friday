import type { Browser, BrowserContext, LaunchOptions, Page } from "playwright";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { FridayDomainError } from "#errors";

// ─── Constants ───

const DEFAULT_MAX_SESSIONS = 3;
const DEFAULT_MAX_TABS_PER_SESSION = 8;
const DEFAULT_MAX_TOTAL_PAGES = 16;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 20_000;
const DEFAULT_ACTION_TIMEOUT_MS = 15_000;

type FridayChromiumLaunchImpl = (options: LaunchOptions) => Promise<Browser>;
type FridayChromiumConnectOverCdpImpl = (wsEndpoint: string) => Promise<Browser>;

export type FridayBrowserPresentationMode =
  | "auto"
  | "headless"
  | "host_chrome_visible";

export type FridayBrowserActiveMode =
  | "headless"
  | "host_chrome_visible";

export interface FridayBrowserExecutionContext {
  presentationMode?: FridayBrowserPresentationMode;
  source?: string;
  interactive?: boolean;
}

export interface FridayBrowserPresentationState {
  configuredMode: FridayBrowserPresentationMode;
  activeMode: FridayBrowserActiveMode;
  targetBrowser: string;
  fallbackReason?: string;
  sessionId?: string;
  tabId?: string;
}

// ─── Options ───

export interface CreateFridayBrowserManagerOptions {
  workspaceRoot: string;
  allowedOrigins?: string[];
  headless?: boolean;
  presentationMode?: FridayBrowserPresentationMode;
  maxSessions?: number;
  maxTabsPerSession?: number;
  maxTotalPages?: number;
  navigationTimeoutMs?: number;
  actionTimeoutMs?: number;
  platform?: NodeJS.Platform;
  isCi?: boolean;
  /** Injectable chromium launcher for testing. */
  launchImpl?: FridayChromiumLaunchImpl;
  /** Injectable CDP connector for testing. */
  connectOverCdpImpl?: FridayChromiumConnectOverCdpImpl;
  /** Injectable host Chrome endpoint resolver for testing. */
  resolveHostChromeEndpointImpl?: typeof resolveHostChromeEndpoint;
  /** OC-009: Connect to an existing browser via CDP or pass extra launch args. */
  hostBrowser?: {
    /** Chrome DevTools Protocol WebSocket endpoint. */
    wsEndpoint?: string;
    /** Extra Chromium CLI arguments for launch mode. */
    launchArgs?: string[];
    /**
     * When true, auto-discover or launch user's Chrome with CDP on the given port
     * instead of using Playwright's built-in Chromium.
     */
    useHostChrome?: boolean;
    /** CDP debugging port for auto-launch (default: 9222). */
    cdpPort?: number;
    /** Path to Chrome executable (auto-detected on macOS if omitted). */
    chromePath?: string;
  };
}

// ─── Profile metadata ───

export type FridayBrowserProfileKind =
  | "operator"
  | "automation"
  | "remote"
  | "custom";

export interface BrowserProfileMetadata {
  /** Profile name (e.g. "chrome", "openclaw", "default"). */
  name: string;
  /** Canonical Friday profile intent used for diagnostics and routing. */
  kind: FridayBrowserProfileKind;
  /** When the profile session was created. */
  createdAt: number;
}

export interface FridayBrowserProfileSummary {
  name: string;
  kind: FridayBrowserProfileKind;
  sessionCount: number;
  sessionIds: string[];
  activeTabCount: number;
}

export interface FridayBrowserDiagnosticsSummary {
  presentation: FridayBrowserPresentationState;
  sessionCount: number;
  profiles: FridayBrowserProfileSummary[];
}

// ─── Session state ───

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  tabs: Map<string, Page>;
  activeTabId: string;
  elementCache: Map<string, string>;
  tabCounter: number;
  connectedOverCdp?: boolean;
  presentation: FridayBrowserPresentationState;
  /** Optional profile metadata for multi-profile support. */
  profile?: BrowserProfileMetadata;
}

// ─── Manager interface ───

export interface FridayBrowserManager {
  launch(
    sessionId: string,
    signal?: AbortSignal,
    profile?: string,
    context?: FridayBrowserExecutionContext,
  ): Promise<{ sessionId: string; tabId: string; reused: boolean }>;
  getPage(sessionId: string, opts?: { tabId?: string; createIfMissing?: boolean }, signal?: AbortSignal): Promise<{ tabId: string; page: Page }>;
  getSession(sessionId: string): BrowserSession | undefined;
  snapshotAria(sessionId: string, opts?: { tabId?: string }, signal?: AbortSignal): Promise<string>;
  close(sessionId?: string): Promise<void>;
  getDiagnostics(): FridayBrowserPresentationState;
  getDiagnosticsSummary(): FridayBrowserDiagnosticsSummary;
  /** List sessions for a given profile name, or all if no profile specified. */
  listSessions(profile?: string): Array<{ sessionId: string; profile?: BrowserProfileMetadata; tabCount: number; activeTabId: string }>;
  /** Get sessions matching a profile name. */
  getSessionsByProfile(profile: string): Array<{ sessionId: string; session: BrowserSession }>;
  readonly sessions: ReadonlyMap<string, BrowserSession>;
  readonly options: Readonly<
    Required<
      Omit<
        CreateFridayBrowserManagerOptions,
        "launchImpl"
        | "hostBrowser"
        | "connectOverCdpImpl"
        | "resolveHostChromeEndpointImpl"
      >
    > & { hostBrowser?: CreateFridayBrowserManagerOptions["hostBrowser"] }
  >;
}

// ─── Origin matching ───

/**
 * Explicit opt-in sentinel: passing this single entry in `allowedOrigins`
 * permits ANY origin. Use only when the deployment cannot enumerate a
 * trusted-origin allowlist (e.g. open research workspaces). For any
 * production deployment, prefer an explicit list of origins.
 */
export const FRIDAY_BROWSER_ALLOW_ANY_ORIGIN = "*" as const;

function matchesOrigin(url: string, allowedOrigins: string[]): boolean {
  // B4 default-deny safety boundary: previously, an empty `allowedOrigins`
  // list returned `true` for every URL, meaning a deployment that did not
  // explicitly configure an allowlist permitted the browser tool to navigate
  // to ANY origin. This was a misconfiguration trap — `friday-hub-bootstrap`
  // does not pass `allowedOrigins`, so production deployments fell into the
  // default-allow path. Now, empty → deny. Opt-in to allow-all requires the
  // explicit `FRIDAY_BROWSER_ALLOW_ANY_ORIGIN` sentinel ("*").
  if (allowedOrigins.length === 0) return false;
  if (allowedOrigins.length === 1 && allowedOrigins[0] === FRIDAY_BROWSER_ALLOW_ANY_ORIGIN) return true;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    console.warn("[friday][browser-manager] parse-origin-url:", err instanceof Error ? err.message : String(err));
    return false;
  }

  const origin = parsed.origin;

  for (const pattern of allowedOrigins) {
    if (pattern === FRIDAY_BROWSER_ALLOW_ANY_ORIGIN) return true;
    // Wildcard subdomain: "https://*.example.com"
    // Security note: The character class [a-zA-Z0-9-]+ intentionally excludes
    // dots, so "*.example.com" cannot match "evil.com.example.com" — the
    // wildcard only matches a single DNS label (no embedded dots). This
    // prevents subdomain-confusion attacks.
    if (pattern.includes("*")) {
      const re = new RegExp(
        "^" +
        pattern
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, "[a-zA-Z0-9-]+") +
        "$",
      );
      if (re.test(origin)) return true;
    } else {
      if (origin === pattern) return true;
    }
  }
  return false;
}

function validateUrl(url: string, allowedOrigins: string[]): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    console.warn("[friday][browser-manager] validate-url:", err instanceof Error ? err.message : String(err));
    return `Invalid URL: ${url}`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Protocol "${parsed.protocol}" is not allowed. Only http: and https: are permitted.`;
  }

  if (!matchesOrigin(url, allowedOrigins)) {
    return `Origin "${parsed.origin}" is not in the allowed origins list.`;
  }

  return undefined;
}

// ─── Artifact path ───

export function sanitizeArtifactPathSegment(input: string): string {
  const raw = input.trim();
  const segments = raw.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) {
    throw new FridayDomainError("VALIDATION_ERROR", `Invalid artifact path segment "${input}"`, { httpStatus: 400 });
  }

  const sanitized = segments
    .join("_")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");

  if (!sanitized) {
    throw new FridayDomainError("VALIDATION_ERROR", `Invalid artifact path segment "${input}"`, { httpStatus: 400 });
  }
  return sanitized;
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

function inferBrowserProfileKind(profile?: string): FridayBrowserProfileKind {
  const normalized = profile?.trim().toLowerCase();
  if (normalized === "operator") return "operator";
  if (normalized === "automation") return "automation";
  if (normalized === "remote") return "remote";
  return "custom";
}

function resolvePlaywrightBrowsersCacheDir(platform: NodeJS.Platform): string | undefined {
  let userHome = "";
  try {
    userHome = os.userInfo().homedir;
  } catch (err) {
    console.warn("[friday][browser-manager] resolve-homedir:", err instanceof Error ? err.message : String(err));
    userHome = os.homedir();
  }
  if (!userHome) {
    return undefined;
  }

  const candidates =
    platform === "darwin"
      ? [path.join(userHome, "Library", "Caches", "ms-playwright")]
      : platform === "linux"
        ? [path.join(userHome, ".cache", "ms-playwright")]
        : platform === "win32" && process.env.LOCALAPPDATA
          ? [path.join(process.env.LOCALAPPDATA, "ms-playwright")]
          : [];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function ensurePlaywrightBrowsersPath(platform: NodeJS.Platform): void {
  if (typeof process.env.PLAYWRIGHT_BROWSERS_PATH === "string" && process.env.PLAYWRIGHT_BROWSERS_PATH.trim().length > 0) {
    return;
  }

  const cacheDir = resolvePlaywrightBrowsersCacheDir(platform);
  if (cacheDir) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = cacheDir;
  }
}

async function launchPlaywrightChromium(options: LaunchOptions): Promise<Browser> {
  const { chromium } = await import("playwright");
  return chromium.launch(options);
}

async function connectPlaywrightChromiumOverCdp(
  wsEndpoint: string,
): Promise<Browser> {
  const { chromium } = await import("playwright");
  return chromium.connectOverCDP(wsEndpoint);
}

// ─── Host Chrome auto-discovery ───

const DEFAULT_CDP_PORT = 9222;

const CHROME_PATHS_MACOS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

function findChromeExecutable(customPath?: string): string | undefined {
  if (customPath?.endsWith(".app")) {
    const appName = path.basename(customPath, ".app");
    const executable = path.join(customPath, "Contents", "MacOS", appName);
    try {
      fs.accessSync(executable, fs.constants.X_OK);
      return executable;
    } catch (err) {
      console.warn("[friday][browser-manager] access-chrome-app:", err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }
  if (customPath) {
    try {
      fs.accessSync(customPath, fs.constants.X_OK);
      return customPath;
    } catch (err) {
      console.warn("[friday][browser-manager] access-custom-chrome:", err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    for (const p of CHROME_PATHS_MACOS) {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch (err) {
        console.warn("[friday][browser-manager] access-chrome-path:", err instanceof Error ? err.message : String(err));
        continue;
      }
    }
  }
  return undefined;
}

function chromeAppBundleFromExecutable(executablePath: string): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  const appBundle = path.resolve(executablePath, "../../..");
  return appBundle.endsWith(".app") ? appBundle : undefined;
}

function hostChromeUserDataDir(port: number): string {
  return path.join(os.tmpdir(), "friday-host-chrome-cdp", `port-${String(port)}`);
}

async function probeCdpEndpoint(port: number): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${String(port)}/json/version`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return undefined;
    const data = (await res.json()) as { webSocketDebuggerUrl?: string };
    return data.webSocketDebuggerUrl ?? undefined;
  } catch (err) {
    console.warn("[friday][browser-manager] discover-cdp-endpoint:", err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

function launchChromeWithCdp(chromePath: string, port: number): void {
  const userDataDir = hostChromeUserDataDir(port);
  fs.mkdirSync(userDataDir, { recursive: true });
  const launchArgs = [
    `--remote-debugging-port=${String(port)}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "about:blank",
  ];
  if (process.platform === "darwin") {
    const appBundle = chromeAppBundleFromExecutable(chromePath);
    const child = appBundle
      ? spawn("open", ["-na", appBundle, "--args", ...launchArgs], {
          detached: true,
          stdio: "ignore",
        })
      : spawn(chromePath, launchArgs, {
          detached: true,
          stdio: "ignore",
        });
    child.unref();
  } else {
    const child = spawn(chromePath, launchArgs, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }
}

async function resolveHostChromeEndpoint(
  port: number,
  chromePath?: string,
): Promise<string> {
  // 1. Try connecting to an already-running Chrome with CDP
  const existing = await probeCdpEndpoint(port);
  if (existing) {
    console.log(`[friday] Connected to existing Chrome CDP on port ${String(port)}`);
    return existing;
  }

  // 2. Find and launch user's Chrome with CDP
  const exe = findChromeExecutable(chromePath);
  if (!exe) {
    throw new FridayDomainError("NOT_FOUND", "[friday] Host Chrome executable not found. Install Google Chrome or set FRIDAY_BROWSER_CHROME_PATH.", { httpStatus: 404 });
  }

  console.log(`[friday] Launching Chrome with CDP on port ${String(port)}: ${exe}`);
  launchChromeWithCdp(exe, port);

  // 3. Wait for CDP to become available (up to 15s)
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    const ws = await probeCdpEndpoint(port);
    if (ws) {
      console.log(`[friday] Chrome CDP ready on port ${String(port)}`);
      return ws;
    }
  }

  throw new FridayDomainError("NOT_INITIALIZED", `[friday] Chrome CDP did not become available on port ${String(port)} after 15 seconds. Ensure Chrome is not blocked from starting or try setting FRIDAY_BROWSER_WS_ENDPOINT manually.`, { httpStatus: 503 });
}

// ─── Factory ───

export function createFridayBrowserManager(
  opts: CreateFridayBrowserManagerOptions,
): FridayBrowserManager {
  const headless = opts.headless ?? true;
  const configuredMode = opts.presentationMode ?? "auto";
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxTabsPerSession = opts.maxTabsPerSession ?? DEFAULT_MAX_TABS_PER_SESSION;
  const maxTotalPages = opts.maxTotalPages ?? DEFAULT_MAX_TOTAL_PAGES;
  const navigationTimeoutMs = opts.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  const actionTimeoutMs = opts.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const allowedOrigins = opts.allowedOrigins ?? [];
  // B4 default-deny: surface a single startup warning when no allowlist is
  // configured. Pre-fix behavior was silent allow-all; now the warning makes
  // the deny-by-default state visible. Operators who genuinely want
  // allow-all must pass `FRIDAY_BROWSER_ALLOW_ANY_ORIGIN` explicitly.
  if (allowedOrigins.length === 0) {
    console.warn(
      `[friday][browser-manager] No allowedOrigins configured — the browser tool will reject every navigation. ` +
      `Configure a list of trusted origins (e.g. ["https://example.com"]) or, only for trusted research workspaces, ` +
      `pass FRIDAY_BROWSER_ALLOW_ANY_ORIGIN ("*") to opt into allow-all explicitly.`,
    );
  }
  const workspaceRoot = opts.workspaceRoot;
  const platform = opts.platform ?? process.platform;
  const isCi = opts.isCi ?? process.env.CI === "true";
  const launchFn = opts.launchImpl ?? launchPlaywrightChromium;
  const connectOverCdp = opts.connectOverCdpImpl ?? connectPlaywrightChromiumOverCdp;
  const resolveHostChromeEndpointFn = opts.resolveHostChromeEndpointImpl ?? resolveHostChromeEndpoint;
  // OC-009: Visible browser control — CDP connect or extra launch args
  let wsEndpoint = opts.hostBrowser?.wsEndpoint;
  const extraLaunchArgs = opts.hostBrowser?.launchArgs ?? [];
  const cdpPort = opts.hostBrowser?.cdpPort ?? DEFAULT_CDP_PORT;
  const hostChromePath = opts.hostBrowser?.chromePath;

  const sessions = new Map<string, BrowserSession>();

  function predictedPresentationForMode(
    mode: FridayBrowserPresentationMode | FridayBrowserActiveMode,
  ): Pick<FridayBrowserPresentationState, "activeMode" | "targetBrowser"> {
    if (mode === "host_chrome_visible") {
      return {
        activeMode: "host_chrome_visible",
        targetBrowser: "Google Chrome",
      };
    }
    return {
      activeMode: "headless",
      targetBrowser: "Playwright Chromium",
    };
  }

  function resolveLaunchPresentationMode(
    context?: FridayBrowserExecutionContext,
  ): FridayBrowserActiveMode {
    const hintedMode = context?.presentationMode;
    if (hintedMode === "headless" || hintedMode === "host_chrome_visible") {
      return hintedMode;
    }
    if (configuredMode === "headless" || configuredMode === "host_chrome_visible") {
      return configuredMode;
    }
    const source = context?.source?.trim().toLowerCase();
    if (platform === "darwin" && !isCi && context?.interactive === true && source === "agent_page") {
      return "host_chrome_visible";
    }
    return "headless";
  }

  let lastPresentation: FridayBrowserPresentationState = {
    configuredMode,
    ...predictedPresentationForMode(configuredMode),
  };

  function totalOpenPages(): number {
    return Array.from(sessions.values()).reduce((sum, s) => sum + s.tabs.size, 0);
  }

  let reservedPageSlots = 0;

  function reservePageSlot(): () => void {
    const projectedTotal = totalOpenPages() + reservedPageSlots;
    if (projectedTotal >= maxTotalPages) {
      throw new FridayDomainError("VALIDATION_ERROR", `Maximum total pages (${String(maxTotalPages)}) reached.`, { httpStatus: 400 });
    }

    reservedPageSlots += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      reservedPageSlots -= 1;
    };
  }

  const resolvedOptions = {
    workspaceRoot,
    allowedOrigins,
    headless,
    presentationMode: configuredMode,
    maxSessions,
    maxTabsPerSession,
    maxTotalPages,
    navigationTimeoutMs,
    actionTimeoutMs,
    platform,
    isCi,
    hostBrowser: opts.hostBrowser,
  };

  function isSessionAlive(session: BrowserSession): boolean {
    return session.browser.isConnected();
  }

  async function evictDeadSession(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    if (session.connectedOverCdp) {
      await Promise.all(
        Array.from(session.tabs.values()).map((page) => page.close().catch((err: unknown) => console.warn("[friday][browser] cleanup:", err instanceof Error ? err.message : String(err)))),
      );
      return;
    }
    await session.browser.close().catch((err: unknown) => console.warn("[friday][browser] cleanup:", err instanceof Error ? err.message : String(err)));
  }

  async function launch(
    sessionId: string,
    signal?: AbortSignal,
    profile?: string,
    executionContext?: FridayBrowserExecutionContext,
  ): Promise<{ sessionId: string; tabId: string; reused: boolean }> {
    const requestedMode = resolveLaunchPresentationMode(executionContext);
    const existing = sessions.get(sessionId);
    if (existing) {
      if (isSessionAlive(existing)) {
        if (existing.presentation.activeMode !== requestedMode) {
          await evictDeadSession(sessionId);
        } else {
        // Verify the active tab is still usable (not closed externally).
          const activePage = existing.tabs.get(existing.activeTabId);
          if (activePage && !activePage.isClosed()) {
            lastPresentation = {
              ...existing.presentation,
              sessionId,
              tabId: existing.activeTabId,
            };
            return { sessionId, tabId: existing.activeTabId, reused: true };
          }
          // Active tab is dead — clean it up and create a fresh one.
          if (activePage) {
            existing.tabs.delete(existing.activeTabId);
          }
          const releaseSlot = reservePageSlot();
          try {
            const newPage = await existing.context.newPage();
            existing.tabCounter += 1;
            const newTabId = `tab-${String(existing.tabCounter)}`;
            existing.tabs.set(newTabId, newPage);
            existing.activeTabId = newTabId;
            existing.presentation = {
              ...existing.presentation,
              sessionId,
              tabId: newTabId,
            };
            lastPresentation = existing.presentation;
            return { sessionId, tabId: newTabId, reused: true };
          } finally {
            releaseSlot();
          }
        }
      }
      // Browser died — evict stale session and re-launch below
      await evictDeadSession(sessionId);
    }

    if (sessions.size >= maxSessions) {
      throw new FridayDomainError("VALIDATION_ERROR", `Maximum sessions (${String(maxSessions)}) reached. Close an existing session first.`, { httpStatus: 400 });
    }

    signal?.throwIfAborted();

    let browser: Browser | undefined;
    let browserContext: BrowserContext | undefined;
    let page: Page | undefined;
    let created = false;
    let connectedOverCdp = false;
    let actualMode: FridayBrowserActiveMode = requestedMode;
    let fallbackReason: string | undefined;

    async function launchPlaywrightBrowser(forceHeadless = headless): Promise<Browser> {
      ensurePlaywrightBrowsersPath(platform);
      return launchFn({
        headless: forceHeadless,
        args: extraLaunchArgs.length > 0 ? extraLaunchArgs : undefined,
      });
    }

    try {
      if (requestedMode === "host_chrome_visible" && !wsEndpoint) {
        try {
          wsEndpoint = await resolveHostChromeEndpointFn(cdpPort, hostChromePath);
        } catch (error) {
          fallbackReason = error instanceof Error ? error.message : String(error);
          actualMode = "headless";
          console.warn("[friday] Host Chrome unavailable; falling back to Playwright Chromium");
        }
      }

      // OC-009: Connect to existing browser via CDP, or launch Playwright Chromium.
      if (requestedMode === "host_chrome_visible" && wsEndpoint && actualMode === "host_chrome_visible") {
        try {
          browser = await connectOverCdp(wsEndpoint);
          connectedOverCdp = true;
        } catch (error) {
          console.warn(`[friday] CDP connect failed, re-resolving host Chrome: ${String(error)}`);
          wsEndpoint = undefined;
          try {
            wsEndpoint = await resolveHostChromeEndpointFn(cdpPort, hostChromePath);
            browser = await connectOverCdp(wsEndpoint);
            connectedOverCdp = true;
          } catch (retryError) {
            fallbackReason = retryError instanceof Error ? retryError.message : String(retryError);
            actualMode = "headless";
            wsEndpoint = undefined;
            browser = await launchPlaywrightBrowser(true);
          }
        }
      } else {
        browser = await launchPlaywrightBrowser(requestedMode === "headless" ? headless : true);
      }

      signal?.throwIfAborted();

      // When connected via CDP, try to reuse an existing blank tab instead of
      // creating a new context + page (which would open a redundant blank tab).
      if (connectedOverCdp) {
        const existingContexts = browser.contexts();
        for (const ctx of existingContexts) {
          const pages = ctx.pages();
          const blank = pages.find((p) => {
            const u = p.url();
            return u === "about:blank" || u === "" || u.startsWith("chrome://newtab");
          });
          if (blank) {
            browserContext = ctx;
            page = blank;
            browserContext.setDefaultNavigationTimeout(navigationTimeoutMs);
            browserContext.setDefaultTimeout(actionTimeoutMs);
            break;
          }
        }
      }

      if (!browserContext) {
        browserContext = await browser.newContext();
        browserContext.setDefaultNavigationTimeout(navigationTimeoutMs);
        browserContext.setDefaultTimeout(actionTimeoutMs);
      }

      const releasePageSlot = reservePageSlot();
      try {
        if (!page) {
          page = await browserContext.newPage();
        }
        const tabId = "tab-1";
        const presentation: FridayBrowserPresentationState = {
          configuredMode,
          activeMode: actualMode,
          targetBrowser: actualMode === "host_chrome_visible"
            ? "Google Chrome"
            : "Playwright Chromium",
          ...(fallbackReason ? { fallbackReason } : {}),
          sessionId,
          tabId,
        };

        const session: BrowserSession = {
          browser,
          context: browserContext,
          tabs: new Map<string, Page>([[tabId, page]]),
          activeTabId: tabId,
          elementCache: new Map(),
          tabCounter: 1,
          connectedOverCdp,
          presentation,
          profile: profile
            ? {
                name: profile,
                kind: inferBrowserProfileKind(profile),
                createdAt: Date.now(),
              }
            : undefined,
        };

        sessions.set(sessionId, session);
        lastPresentation = presentation;
        created = true;
        return { sessionId, tabId, reused: false };
      } finally {
        releasePageSlot();
      }
    } finally {
      if (!created) {
        await page?.close().catch((err: unknown) => console.warn("[friday][browser] cleanup:", err instanceof Error ? err.message : String(err)));
        await browserContext?.close().catch((err: unknown) => console.warn("[friday][browser] cleanup:", err instanceof Error ? err.message : String(err)));
        if (!connectedOverCdp) {
          await browser?.close().catch((err: unknown) => console.warn("[friday][browser] cleanup:", err instanceof Error ? err.message : String(err)));
        }
      }
    }
  }

  async function getPage(
    sessionId: string,
    getOpts?: { tabId?: string; createIfMissing?: boolean },
    signal?: AbortSignal,
  ): Promise<{ tabId: string; page: Page }> {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new FridayDomainError("NOT_FOUND", `Session "${sessionId}" not found. Use "open" action first.`, { httpStatus: 404 });
    }

    // Detect dead browser and evict so caller can re-open
    if (!isSessionAlive(session)) {
      await evictDeadSession(sessionId);
      throw new FridayDomainError("NOT_INITIALIZED", `Session "${sessionId}" browser has disconnected. Use "open" action to start a new session.`, { httpStatus: 503 });
    }

    const targetTabId = getOpts?.tabId ?? session.activeTabId;
    const existing = session.tabs.get(targetTabId);

    if (existing) {
      // Verify the page is still usable (not closed)
      if (existing.isClosed()) {
        session.tabs.delete(targetTabId);
        // Fall through to createIfMissing logic
      } else {
        session.presentation = {
          ...session.presentation,
          sessionId,
          tabId: targetTabId,
        };
        lastPresentation = session.presentation;
        return { tabId: targetTabId, page: existing };
      }
    }

    if (!getOpts?.createIfMissing) {
      throw new FridayDomainError("NOT_FOUND", `Tab "${targetTabId}" not found in session "${sessionId}".`, { httpStatus: 404 });
    }

    if (session.tabs.size >= maxTabsPerSession) {
      throw new FridayDomainError("VALIDATION_ERROR", `Maximum tabs per session (${String(maxTabsPerSession)}) reached. Close a tab first.`, { httpStatus: 400 });
    }

    const releasePageSlot = reservePageSlot();
    try {
      signal?.throwIfAborted();

      const page = await session.context.newPage();
      session.tabCounter += 1;
      const newTabId = `tab-${String(session.tabCounter)}`;
      session.tabs.set(newTabId, page);
      session.activeTabId = newTabId;
      session.presentation = {
        ...session.presentation,
        sessionId,
        tabId: newTabId,
      };
      lastPresentation = session.presentation;

      return { tabId: newTabId, page };
    } finally {
      releasePageSlot();
    }
  }

  function getSession(sessionId: string): BrowserSession | undefined {
    return sessions.get(sessionId);
  }

  async function snapshotAria(
    sessionId: string,
    opts?: { tabId?: string },
    signal?: AbortSignal,
  ): Promise<string> {
    const { page } = await getPage(sessionId, { tabId: opts?.tabId }, signal);
    return page.locator("body").ariaSnapshot().catch(() => "");
  }

  async function close(sessionId?: string): Promise<void> {
    if (sessionId !== undefined) {
      const session = sessions.get(sessionId);
      if (session) {
        if (session.connectedOverCdp) {
          await Promise.all(
            Array.from(session.tabs.values()).map((page) => page.close().catch((err: unknown) => console.warn("[friday][browser] cleanup:", err instanceof Error ? err.message : String(err)))),
          );
        } else {
          await session.browser.close().catch((err: unknown) => console.warn("[friday][browser] cleanup:", err instanceof Error ? err.message : String(err)));
        }
        sessions.delete(sessionId);
      }
      return;
    }

    // Close all sessions
    const closeTasks = Array.from(sessions.values()).map((session) => {
      if (session.connectedOverCdp) {
        return Promise.all(
          Array.from(session.tabs.values()).map((page) => page.close().catch((err: unknown) => console.warn("[friday][browser] cleanup:", err instanceof Error ? err.message : String(err)))),
        ).then(() => undefined);
      }
      return session.browser.close().catch((err: unknown) => console.warn("[friday][browser] cleanup:", err instanceof Error ? err.message : String(err)));
    });
    await Promise.all(closeTasks);
    sessions.clear();
  }

  function getDiagnostics(): FridayBrowserPresentationState {
    return { ...lastPresentation };
  }

  function getDiagnosticsSummary(): FridayBrowserDiagnosticsSummary {
    const profiles = new Map<string, FridayBrowserProfileSummary>();
    for (const [sessionId, session] of sessions) {
      const profile = session.profile;
      if (!profile) continue;
      const existing = profiles.get(profile.name);
      if (existing) {
        existing.sessionCount += 1;
        existing.sessionIds.push(sessionId);
        existing.activeTabCount += session.tabs.size;
        continue;
      }
      profiles.set(profile.name, {
        name: profile.name,
        kind: profile.kind,
        sessionCount: 1,
        sessionIds: [sessionId],
        activeTabCount: session.tabs.size,
      });
    }

    return {
      presentation: getDiagnostics(),
      sessionCount: sessions.size,
      profiles: Array.from(profiles.values()).sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  function listSessions(
    profile?: string,
  ): Array<{ sessionId: string; profile?: BrowserProfileMetadata; tabCount: number; activeTabId: string }> {
    const result: Array<{ sessionId: string; profile?: BrowserProfileMetadata; tabCount: number; activeTabId: string }> = [];
    for (const [sessionId, session] of sessions) {
      if (profile !== undefined && session.profile?.name !== profile) continue;
      result.push({
        sessionId,
        profile: session.profile,
        tabCount: session.tabs.size,
        activeTabId: session.activeTabId,
      });
    }
    return result;
  }

  function getSessionsByProfile(
    profile: string,
  ): Array<{ sessionId: string; session: BrowserSession }> {
    const result: Array<{ sessionId: string; session: BrowserSession }> = [];
    for (const [sessionId, session] of sessions) {
      if (session.profile?.name === profile) {
        result.push({ sessionId, session });
      }
    }
    return result;
  }

  return {
    launch,
    getPage,
    getSession,
    snapshotAria,
    close,
    getDiagnostics,
    getDiagnosticsSummary,
    listSessions,
    getSessionsByProfile,
    get sessions() {
      return sessions as ReadonlyMap<string, BrowserSession>;
    },
    options: resolvedOptions,
  };
}

// Re-export for use by tool
export { validateUrl, matchesOrigin };
