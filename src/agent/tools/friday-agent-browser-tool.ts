import { FridayDomainError } from "#errors";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readBooleanParam,
  readNumberParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";
import type {
  FridayBrowserExecutionContext,
  FridayBrowserManager,
  FridayBrowserPresentationMode,
  FridayBrowserPresentationState,
} from "../../browser/friday-browser-manager.js";
import { browserArtifactDir, validateUrl } from "../../browser/friday-browser-manager.js";
import { resolveBrowserTarget } from "../../browser/friday-browser-target-id.js";
import type {
  FridayDomDocumentLike,
  FridayDomElementLike,
} from "../../browser/friday-dom-lite.types.js";

// ─── Types ───

export interface CreateFridayAgentBrowserToolOptions {
  browserManager: FridayBrowserManager;
}

type BrowserAction =
  | "open"
  | "navigate"
  | "screenshot"
  | "snapshot"
  | "act"
  | "tabs"
  | "close"
  | "status"
  | "start"
  | "stop"
  | "profiles"
  | "focus"
  | "console"
  | "pdf"
  | "upload"
  | "dialog";

type ActKind =
  | "click"
  | "type"
  | "press"
  | "hover"
  | "drag"
  | "select"
  | "fill"
  | "resize"
  | "wait"
  | "evaluate"
  | "close";

const VALID_ACTIONS = new Set<BrowserAction>([
  "open",
  "navigate",
  "screenshot",
  "snapshot",
  "act",
  "tabs",
  "close",
  "status",
  "start",
  "stop",
  "profiles",
  "focus",
  "console",
  "pdf",
  "upload",
  "dialog",
]);

const VALID_ACT_KINDS = new Set<ActKind>([
  "click",
  "type",
  "press",
  "hover",
  "drag",
  "select",
  "fill",
  "resize",
  "wait",
  "evaluate",
  "close",
]);

// ─── Snapshot helpers ───

interface InteractiveElement {
  elementId: string;
  tag: string;
  role: string;
  name: string;
  selector: string;
}

function normalizeAxSnapshot(snapshot: string): string {
  const trimmed = snapshot.trim();
  return trimmed.length > 0 ? trimmed : "(empty page)";
}

// ─── Disconnect detection ───

function isBrowserDisconnectedError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("has been closed") ||
    lower.includes("browser has disconnected") ||
    lower.includes("browser has been closed") ||
    lower.includes("target page, context or browser") ||
    lower.includes("session is closed") ||
    lower.includes("connection refused")
  );
}

function isTimeoutError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("err_timed_out")
  );
}

// ─── Factory ───

export function createFridayAgentBrowserTool(
  options: CreateFridayAgentBrowserToolOptions,
): FridayAgentToolDefinition {
  const { browserManager } = options;

  return {
    name: "browser",
    description:
      "Control a browser session that can run either in a visible desktop Chrome window or in a background headless browser. " +
      "Actions: open, navigate, screenshot, snapshot (AX tree + interactive elements), " +
      "act (click/type/press/hover/drag/select/fill/resize/wait/evaluate/close), tabs (list/new/switch/close), close, " +
      "status, start, stop, profiles, focus, console, pdf, upload, dialog.",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: [
            "open",
            "navigate",
            "screenshot",
            "snapshot",
            "act",
            "tabs",
            "close",
            "status",
            "start",
            "stop",
            "profiles",
            "focus",
            "console",
            "pdf",
            "upload",
            "dialog",
          ],
          description: "Browser action to perform.",
        },
        sessionId: {
          type: "string",
          description: "Browser session identifier.",
        },
        targetId: {
          type: "string",
          description: 'Target ID in "sessionId" or "sessionId:tabId" format.',
        },
        profile: {
          type: "string",
          description: 'Browser profile name (e.g. "chrome", "openclaw").',
        },
        url: {
          type: "string",
          description: "URL to navigate to (for open/navigate actions).",
        },
        act: {
          type: "string",
          enum: [
            "click",
            "type",
            "press",
            "hover",
            "drag",
            "select",
            "fill",
            "resize",
            "wait",
            "evaluate",
            "close",
          ],
          description: "Act sub-action.",
        },
        selector: {
          type: "string",
          description: "CSS selector for act target.",
        },
        elementId: {
          type: "string",
          description: "Cached element ID from snapshot for act target.",
        },
        text: {
          type: "string",
          description: "Text to type (for act:type/fill), or JS for act:evaluate.",
        },
        key: {
          type: "string",
          description: "Key to press (for act:press), e.g. 'Enter', 'Tab'.",
        },
        values: {
          type: "array",
          description: "Values for act:select (option values to select).",
        },
        endSelector: {
          type: "string",
          description: "End CSS selector for act:drag (drop target).",
        },
        width: {
          type: "number",
          description: "Width for act:resize.",
        },
        height: {
          type: "number",
          description: "Height for act:resize.",
        },
        timeMs: {
          type: "number",
          description: "Timeout in milliseconds for act:wait.",
        },
        fullPage: {
          type: "boolean",
          description: "Capture full page screenshot (default: false).",
        },
        screenshotMode: {
          type: "string",
          enum: ["path", "base64"],
          description: "Screenshot output mode (default: path).",
        },
        tabId: {
          type: "string",
          description: "Tab identifier for tabs action.",
        },
        tabsAction: {
          type: "string",
          enum: ["list", "new", "switch", "close"],
          description: "Sub-action for tabs: list, new, switch, close.",
        },
        accept: {
          type: "boolean",
          description: "Whether to accept or dismiss a dialog.",
        },
        promptText: {
          type: "string",
          description: "Text to enter in a dialog prompt.",
        },
        filePaths: {
          type: "array",
          description: "File paths for upload action.",
        },
      },
      required: ["action"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const action = readStringParam(args, "action", { required: true }) as BrowserAction;

      if (!VALID_ACTIONS.has(action)) {
        return errorResult(
          `Invalid action "${action}". Valid actions: ${Array.from(VALID_ACTIONS).join(", ")}`,
        );
      }

      try {
        switch (action) {
          case "open":
            return await handleOpen(args, signal);
          case "navigate":
            return await handleNavigate(args, signal);
          case "screenshot":
            return await handleScreenshot(args, signal);
          case "snapshot":
            return await handleSnapshot(args, signal);
          case "act":
            return await handleAct(args, signal);
          case "tabs":
            return await handleTabs(args, signal);
          case "close":
            return await handleClose(args);
          case "status":
            return handleStatus(args);
          case "start":
            return await handleStart(args, signal);
          case "stop":
            return await handleStop(args);
          case "profiles":
            return handleProfiles();
          case "focus":
            return await handleFocus(args, signal);
          case "console":
            return await handleConsole(args, signal);
          case "pdf":
            return await handlePdf(args, signal);
          case "upload":
            return await handleUpload(args, signal);
          case "dialog":
            return await handleDialog(args, signal);
          default:
            return errorResult(`Unknown action: ${action as string}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("Browser action aborted.");
        }
        return errorResult(message);
      }
    },
  };

  // ─── Helpers ───

  function resolveSession(args: Record<string, unknown>): {
    sessionId: string;
    tabId: string;
  } {
    const sessionId = readStringParam(args, "sessionId");
    const targetId = readStringParam(args, "targetId");
    const profile = readStringParam(args, "profile");
    const tabId = readStringParam(args, "tabId");

    const resolved = resolveBrowserTarget(browserManager, {
      sessionId,
      targetId,
      tabId,
      profile,
    });

    return { sessionId: resolved.sessionId, tabId: resolved.tabId };
  }

  function resolveSessionId(args: Record<string, unknown>): string {
    const sessionId = readStringParam(args, "sessionId");
    if (sessionId) return sessionId;

    const targetId = readStringParam(args, "targetId");
    if (targetId) {
      const colonIndex = targetId.indexOf(":");
      return colonIndex === -1 ? targetId : targetId.slice(0, colonIndex);
    }

    const profile = readStringParam(args, "profile");
    if (profile) {
      const sessions = browserManager.getSessionsByProfile(profile);
      if (sessions.length > 0) return sessions[0].sessionId;
      return profile; // Use as session ID for new sessions
    }

    throw new FridayDomainError("VALIDATION_ERROR", "No session specified. Provide sessionId, targetId, or profile.", { httpStatus: 400 });
  }

  function resolveSessionIdForOpenOrStart(args: Record<string, unknown>): string {
    const sessionId = readStringParam(args, "sessionId");
    if (sessionId) return sessionId;

    const targetId = readStringParam(args, "targetId");
    if (targetId) {
      const colonIndex = targetId.indexOf(":");
      return colonIndex === -1 ? targetId : targetId.slice(0, colonIndex);
    }

    const profile = readStringParam(args, "profile");
    if (profile) {
      const sessions = browserManager.getSessionsByProfile(profile);
      if (sessions.length > 0) return sessions[0].sessionId;
      return profile; // Use profile name as the new session ID
    }

    // Make `browser.open` and `browser.start` robust for natural-language commands
    // where the model may omit session/profile parameters.
    return "default";
  }

  function readBrowserExecutionContext(
    args: Record<string, unknown>,
  ): FridayBrowserExecutionContext | undefined {
    const presentationMode = readStringParam(args, "__browserPresentationMode") as FridayBrowserPresentationMode | undefined;
    const source = readStringParam(args, "__browserExecutionSource");
    const interactive = readBooleanParam(args, "__browserInteractive");

    if (!presentationMode && !source && interactive === undefined) {
      return undefined;
    }

    return {
      ...(presentationMode ? { presentationMode } : {}),
      ...(source ? { source } : {}),
      ...(interactive !== undefined ? { interactive } : {}),
    };
  }

  function presentModeLabel(mode: FridayBrowserPresentationMode | "headless" | "host_chrome_visible"): string {
    return mode === "host_chrome_visible" ? "visible desktop" : "headless";
  }

  function summarizeBrowserTarget(url: string | undefined, targetBrowser: string): string {
    if (url) {
      try {
        return new URL(url).hostname.replace(/^www\./, "");
      } catch (err) {
        console.warn("[friday][agent-browser-tool] URL parse failed:", err instanceof Error ? err.message : String(err));
        if (url.trim().length > 0) {
          return url.trim();
        }
      }
    }
    return targetBrowser;
  }

  function resolvePresentationState(input: {
    sessionId?: string;
    tabId?: string;
    presentation?: FridayBrowserPresentationState;
  } = {}): FridayBrowserPresentationState {
    const sessionPresentation = input.sessionId
      ? browserManager.getSession(input.sessionId)?.presentation
      : undefined;
    const base = input.presentation ?? sessionPresentation ?? browserManager.getDiagnostics();
    return {
      ...base,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.tabId ? { tabId: input.tabId } : {}),
    };
  }

  function browserJsonResult(
    payload: Record<string, unknown>,
    input: {
      sessionId?: string;
      tabId?: string;
      url?: string;
      presentation?: FridayBrowserPresentationState;
    } = {},
  ): FridayAgentToolResult {
    const sessionId = input.sessionId ?? (typeof payload.sessionId === "string" ? payload.sessionId : undefined);
    const tabId = input.tabId ?? (typeof payload.tabId === "string" ? payload.tabId : undefined);
    const url = input.url ?? (typeof payload.url === "string" ? payload.url : undefined);
    const presentation = resolvePresentationState({
      sessionId,
      tabId,
      presentation: input.presentation,
    });
    const browserTarget = presentation.targetBrowser;
    const presentationSummary = `${summarizeBrowserTarget(url, browserTarget)} · ${presentModeLabel(presentation.activeMode)}`;
    const browserPresentation = {
      presentationMode: presentation.activeMode,
      targetBrowser: browserTarget,
      browserTarget,
      ...(sessionId ? { sessionId } : {}),
      ...(tabId ? { tabId } : {}),
      ...(presentation.fallbackReason ? { fallbackReason: presentation.fallbackReason } : {}),
      presentationSummary,
    };

    return jsonResult(
      {
        ...payload,
        presentationMode: presentation.activeMode,
        targetBrowser: browserTarget,
        browserTarget,
        ...(presentation.fallbackReason ? { fallbackReason: presentation.fallbackReason } : {}),
        presentationSummary,
      },
      {
        metadata: {
          browserPresentation,
        },
      },
    );
  }

  // ─── Action handlers ───

  async function handleOpen(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const sessionId = resolveSessionIdForOpenOrStart(args);
    const url = readStringParam(args, "url");
    const profile = readStringParam(args, "profile");
    const executionContext = readBrowserExecutionContext(args);

    if (url) {
      const urlError = validateUrl(url, browserManager.options.allowedOrigins);
      if (urlError) return errorResult(urlError);
    }

    // Attempt open; if the browser died mid-operation, close the stale session
    // and retry once so the user gets a fresh browser automatically.
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { tabId, reused } = await browserManager.launch(sessionId, signal, profile, executionContext);

        if (url) {
          const { page } = await browserManager.getPage(sessionId, { tabId }, signal);
          await page.goto(url, { waitUntil: "domcontentloaded" });
        }

        const { page } = await browserManager.getPage(sessionId, { tabId }, signal);

        return browserJsonResult(
          {
            sessionId,
            tabId,
            reused: reused && attempt === 0,
            profile: profile ?? undefined,
            url: page.url(),
            title: await page.title(),
          },
          { sessionId, tabId, url: page.url() },
        );
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt === 0 && isBrowserDisconnectedError(msg)) {
          await browserManager.close(sessionId).catch(() => {});
          continue;
        }
        if (attempt === 0 && isTimeoutError(msg)) {
          // Transient timeout — retry navigation without re-launching
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  async function handleNavigate(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const url = readStringParam(args, "url", { required: true });
    const executionContext = readBrowserExecutionContext(args);
    const urlError = validateUrl(url, browserManager.options.allowedOrigins);
    if (urlError) return errorResult(urlError);

    // Retry once on browser disconnect — re-open session then navigate
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { sessionId, tabId } = resolveSession(args);
        const { page } = await browserManager.getPage(sessionId, { tabId }, signal);
        await page.goto(url, { waitUntil: "domcontentloaded" });

        return browserJsonResult(
          {
            sessionId,
            tabId,
            url: page.url(),
            title: await page.title(),
          },
          { sessionId, tabId, url: page.url() },
        );
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt === 0 && isBrowserDisconnectedError(msg)) {
          const sessionId = resolveSessionId(args);
          await browserManager.close(sessionId).catch(() => {});
          // Re-launch the session so retry can proceed
          await browserManager.launch(sessionId, signal, undefined, executionContext);
          continue;
        }
        if (attempt === 0 && isTimeoutError(msg)) {
          // Transient timeout — retry navigation without re-launching
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  async function handleScreenshot(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const fullPage = readBooleanParam(args, "fullPage") ?? false;
    const mode = (readStringParam(args, "screenshotMode") ?? "path") as "path" | "base64";

    signal.throwIfAborted();

    const { sessionId, tabId } = resolveSession(args);
    const { page } = await browserManager.getPage(sessionId, { tabId }, signal);

    const buffer = await page.screenshot({ fullPage, type: "png" });

    if (mode === "base64") {
      const base64 = buffer.toString("base64");
      const viewport = page.viewportSize();
      return browserJsonResult(
        {
          sessionId,
          tabId,
          mode: "base64",
          mimeType: "image/png",
          base64,
          width: viewport?.width ?? 0,
          height: viewport?.height ?? 0,
          byteLength: buffer.byteLength,
          url: page.url(),
        },
        { sessionId, tabId, url: page.url() },
      );
    }

    // Save to file
    const artifactDir = browserArtifactDir(browserManager.options.workspaceRoot, sessionId);
    fs.mkdirSync(artifactDir, { recursive: true });

    const timestamp = Date.now();
    const filename = `${String(timestamp)}-${tabId}.png`;
    const filePath = path.join(artifactDir, filename);

    fs.writeFileSync(filePath, buffer);

    const viewport = page.viewportSize();

    return browserJsonResult(
      {
        sessionId,
        tabId,
        mode: "path",
        mimeType: "image/png",
        path: filePath,
        width: viewport?.width ?? 0,
        height: viewport?.height ?? 0,
        byteLength: buffer.byteLength,
        url: page.url(),
      },
      { sessionId, tabId, url: page.url() },
    );
  }

  async function handleSnapshot(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    signal.throwIfAborted();

    const { sessionId, tabId } = resolveSession(args);
    const { page } = await browserManager.getPage(sessionId, { tabId }, signal);
    const session = browserManager.getSession(sessionId);
    if (!session) return errorResult(`Session "${sessionId}" not found.`);

    // Clear previous element cache
    session.elementCache.clear();

    // Accessibility tree snapshot (via manager's snapshotAria)
    const axTree = await browserManager.snapshotAria(sessionId, { tabId }, signal);
    const axText = normalizeAxSnapshot(axTree);

    // Extract interactive elements
    const interactive: InteractiveElement[] = await page.evaluate(() => {
      const { document: browserDocument } = globalThis as unknown as {
        document: FridayDomDocumentLike;
      };

      const readAttr = (el: FridayDomElementLike, name: string): string | null =>
        typeof el.getAttribute === "function" ? el.getAttribute(name) : null;

      const selectors = "a, button, input, textarea, select, [role], [tabindex]";
      const elements = Array.from(browserDocument.querySelectorAll(selectors)) as FridayDomElementLike[];
      const result: InteractiveElement[] = [];

      elements.forEach((el: FridayDomElementLike, index: number) => {
        const tag = String(el.tagName ?? "").toLowerCase() || "unknown";
        const role = readAttr(el, "role") ?? tag;
        const name =
          readAttr(el, "aria-label") ??
          readAttr(el, "title") ??
          el.textContent?.trim().slice(0, 80) ??
          "";

        // Build a stable CSS selector
        let selector: string;
        if (el.id) {
          selector = `#${el.id}`;
        } else {
          const nthIndex = index + 1;
          selector = `${selectors.split(", ").map((s) => `${s}`).join(", ")}:nth-match(${String(nthIndex)})`;
          // Fallback: use tag + nth-of-type
          const parent = el.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter(
              (s: FridayDomElementLike) => s.tagName === el.tagName,
            );
            const sibIndex = siblings.indexOf(el) + 1;
            selector = sibIndex > 1
              ? `${tag}:nth-of-type(${String(sibIndex)})`
              : tag;
          } else {
            selector = tag;
          }

          // Refine with class if available
          if (el.className && typeof el.className === "string" && el.className.trim()) {
            const cls = el.className.trim().split(/\s+/)[0];
            if (cls) {
              selector = `${tag}.${cls}`;
            }
          }
        }

        const elementId = `e${String(index)}`;
        result.push({ elementId, tag, role, name, selector });
      });

      return result;
    });

    // Cache element IDs
    for (const el of interactive) {
      session.elementCache.set(el.elementId, el.selector);
    }

    return browserJsonResult(
      {
        sessionId,
        tabId,
        url: page.url(),
        title: await page.title(),
        axTree,
        axText,
        interactive,
      },
      { sessionId, tabId, url: page.url() },
    );
  }

  async function handleAct(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const actKind = readStringParam(args, "act", { required: true }) as ActKind;

    if (!VALID_ACT_KINDS.has(actKind)) {
      return errorResult(
        `Invalid act kind "${actKind}". Valid: ${Array.from(VALID_ACT_KINDS).join(", ")}`,
      );
    }

    const { sessionId, tabId } = resolveSession(args);

    // Resolve selector from elementId or direct selector
    const elementId = readStringParam(args, "elementId");
    let selector = readStringParam(args, "selector");

    // Some act kinds don't require a selector
    const selectorOptionalKinds = new Set<ActKind>(["press", "wait", "evaluate", "close", "resize"]);

    if (!selector && elementId) {
      const session = browserManager.getSession(sessionId);
      if (!session) return errorResult(`Session "${sessionId}" not found.`);
      const cached = session.elementCache.get(elementId);
      if (!cached) {
        return errorResult(
          `Element "${elementId}" not found in cache. Run "snapshot" first to populate the element cache.`,
        );
      }
      selector = cached;
    }

    if (!selector && !selectorOptionalKinds.has(actKind)) {
      return errorResult("Either selector or elementId is required for act.");
    }

    const { page } = await browserManager.getPage(sessionId, { tabId }, signal);

    // Helper: resolve a locator that prefers visible elements.  When a CSS
    // selector matches multiple elements (common on responsive sites where
    // the same link/button exists in both mobile and desktop menus), plain
    // page.click(selector) waits for the FIRST match to become visible which
    // may never happen.  Using `:visible` narrows to the actually-visible one.
    function visibleLocator(sel: string) {
      const visible = page.locator(`${sel}:visible`);
      return visible;
    }

    switch (actKind) {
      case "click":
        await visibleLocator(selector!).first().click();
        break;
      case "type": {
        const text = readStringParam(args, "text", { required: true });
        await visibleLocator(selector!).first().fill(text);
        break;
      }
      case "press": {
        const key = readStringParam(args, "key", { required: true });
        if (selector) {
          await visibleLocator(selector).first().focus();
        }
        await page.keyboard.press(key);
        break;
      }
      case "hover":
        await visibleLocator(selector!).first().hover();
        break;
      case "drag": {
        const endSelector = readStringParam(args, "endSelector", { required: true });
        await page.dragAndDrop(selector!, endSelector);
        break;
      }
      case "select": {
        const rawValues = args.values;
        const values = Array.isArray(rawValues)
          ? rawValues.filter((v): v is string => typeof v === "string")
          : [];
        if (values.length === 0) {
          return errorResult("Values array is required for act:select.");
        }
        await visibleLocator(selector!).first().selectOption(values);
        break;
      }
      case "fill": {
        const text = readStringParam(args, "text", { required: true });
        await visibleLocator(selector!).first().fill(text);
        break;
      }
      case "resize": {
        const width = readNumberParam(args, "width", { integer: true });
        const height = readNumberParam(args, "height", { integer: true });
        if (width === undefined && height === undefined) {
          return errorResult("Width and/or height are required for act:resize.");
        }
        const currentViewport = page.viewportSize() ?? { width: 1280, height: 720 };
        await page.setViewportSize({
          width: width ?? currentViewport.width,
          height: height ?? currentViewport.height,
        });
        break;
      }
      case "wait": {
        const timeMs = readNumberParam(args, "timeMs", { integer: true }) ?? 1000;
        if (selector) {
          await page.waitForSelector(selector, { timeout: timeMs });
        } else {
          await page.waitForTimeout(timeMs);
        }
        break;
      }
      case "evaluate": {
        const text = readStringParam(args, "text", { required: true });
        // P1-SEC-002: Timeout wrapper to prevent script hangs
        const evalTimeout = 10_000;
        let evalTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const evalResult = await Promise.race([
          page.evaluate(text),
          new Promise<never>((_, reject) => {
            evalTimeoutHandle = setTimeout(() => reject(new Error("evaluate timed out after 10s")), evalTimeout);
          }),
        ]);
        if (evalTimeoutHandle !== undefined) clearTimeout(evalTimeoutHandle);
        return browserJsonResult(
          {
            sessionId,
            tabId,
            act: actKind,
            result: evalResult,
            url: page.url(),
            title: await page.title(),
          },
          { sessionId, tabId, url: page.url() },
        );
      }
      case "close": {
        // Close the current tab
        await page.close();
        const session = browserManager.getSession(sessionId);
        if (session) {
          session.tabs.delete(tabId);
          if (session.activeTabId === tabId && session.tabs.size > 0) {
            session.activeTabId = session.tabs.keys().next().value!;
          }
        }
        return browserJsonResult(
          {
            sessionId,
            closedTabId: tabId,
            act: actKind,
            remainingTabs: session?.tabs.size ?? 0,
          },
          { sessionId },
        );
      }
    }

    return browserJsonResult(
      {
        sessionId,
        tabId,
        act: actKind,
        selector: selector ?? undefined,
        url: page.url(),
        title: await page.title(),
      },
      { sessionId, tabId, url: page.url() },
    );
  }

  async function handleTabs(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const tabsAction = readStringParam(args, "tabsAction") ?? "list";
    const sessionId = resolveSessionId(args);
    const session = browserManager.getSession(sessionId);
    if (!session) return errorResult(`Session "${sessionId}" not found.`);

    switch (tabsAction) {
      case "list": {
        const tabs = Array.from(session.tabs.entries()).map(([tid, page]) => ({
          tabId: tid,
          url: page.url(),
          active: tid === session.activeTabId,
        }));
        return browserJsonResult({ sessionId, tabs }, { sessionId });
      }
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
          await page.goto(url, { waitUntil: "domcontentloaded" });
        }
        return browserJsonResult(
          {
            sessionId,
            tabId,
            url: page.url(),
            title: await page.title(),
          },
          { sessionId, tabId, url: page.url() },
        );
      }
      case "switch": {
        const tabId = readStringParam(args, "tabId", { required: true });
        if (!session.tabs.has(tabId)) {
          return errorResult(`Tab "${tabId}" not found in session "${sessionId}".`);
        }
        session.activeTabId = tabId;
        const page = session.tabs.get(tabId)!;
        return browserJsonResult(
          {
            sessionId,
            tabId,
            url: page.url(),
            title: await page.title(),
          },
          { sessionId, tabId, url: page.url() },
        );
      }
      case "close": {
        const tabId = readStringParam(args, "tabId");
        const targetTabId = tabId ?? session.activeTabId;
        const page = session.tabs.get(targetTabId);
        if (!page) {
          return errorResult(`Tab "${targetTabId}" not found.`);
        }
        await page.close();
        session.tabs.delete(targetTabId);

        // Switch active tab if needed
        if (session.activeTabId === targetTabId && session.tabs.size > 0) {
          session.activeTabId = session.tabs.keys().next().value!;
        }

        return browserJsonResult(
          {
            sessionId,
            closedTabId: targetTabId,
            remainingTabs: session.tabs.size,
          },
          { sessionId },
        );
      }
      default:
        return errorResult(
          `Invalid tabsAction "${tabsAction}". Valid: list, new, switch, close.`,
        );
    }
  }

  async function handleClose(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const sessionId = resolveSessionId(args);
    const presentation = browserManager.getSession(sessionId)?.presentation ?? browserManager.getDiagnostics();
    await browserManager.close(sessionId);
    return browserJsonResult({ sessionId, closed: true }, { sessionId, presentation });
  }

  // ─── New action handlers ───

  function handleStatus(args: Record<string, unknown>): FridayAgentToolResult {
    const profile = readStringParam(args, "profile");
    const sessions = browserManager.listSessions(profile);
    const diagnostics = browserManager.getDiagnostics();
    return browserJsonResult(
      {
        totalSessions: sessions.length,
        maxSessions: browserManager.options.maxSessions,
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          profile: s.profile?.name ?? null,
          tabCount: s.tabCount,
          activeTabId: s.activeTabId,
        })),
      },
      {
        sessionId: diagnostics.sessionId,
        tabId: diagnostics.tabId,
        presentation: diagnostics,
      },
    );
  }

  async function handleStart(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    // "start" is an alias for "open" with profile context
    return handleOpen(args, signal);
  }

  async function handleStop(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    // "stop" closes all sessions, or sessions for a profile
    const profile = readStringParam(args, "profile");
    if (profile) {
      const sessions = browserManager.getSessionsByProfile(profile);
      for (const { sessionId } of sessions) {
        await browserManager.close(sessionId);
      }
      return browserJsonResult({
        profile,
        closedSessions: sessions.length,
      });
    }
    await browserManager.close();
    return browserJsonResult({ closedAll: true });
  }

  function handleProfiles(): FridayAgentToolResult {
    const sessions = browserManager.listSessions();
    const profileMap = new Map<string, number>();

    for (const s of sessions) {
      const name = s.profile?.name ?? "(default)";
      profileMap.set(name, (profileMap.get(name) ?? 0) + 1);
    }

    const profiles = Array.from(profileMap.entries()).map(([name, count]) => ({
      name,
      sessionCount: count,
    }));

    return browserJsonResult({ profiles });
  }

  async function handleFocus(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const { sessionId, tabId } = resolveSession(args);
    const session = browserManager.getSession(sessionId);
    if (!session) return errorResult(`Session "${sessionId}" not found.`);

    // Set active tab
    session.activeTabId = tabId;
    const { page } = await browserManager.getPage(sessionId, { tabId }, signal);
    await page.bringToFront();

    return browserJsonResult(
      {
        sessionId,
        tabId,
        url: page.url(),
        title: await page.title(),
      },
      { sessionId, tabId, url: page.url() },
    );
  }

  async function handleConsole(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const { sessionId, tabId } = resolveSession(args);
    const { page } = await browserManager.getPage(sessionId, { tabId }, signal);

    // Evaluate and return the console output (last few entries)
    // We can't retroactively capture console, so evaluate an expression if provided
    const text = readStringParam(args, "text");
    if (text) {
      const result = await page.evaluate(text);
      return browserJsonResult(
        {
          sessionId,
          tabId,
          result,
          url: page.url(),
        },
        { sessionId, tabId, url: page.url() },
      );
    }

    return browserJsonResult(
      {
        sessionId,
        tabId,
        message: "Console listener active. Use 'text' param to evaluate an expression.",
        url: page.url(),
      },
      { sessionId, tabId, url: page.url() },
    );
  }

  async function handlePdf(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const { sessionId, tabId } = resolveSession(args);
    const { page } = await browserManager.getPage(sessionId, { tabId }, signal);

    const artifactDir = browserArtifactDir(browserManager.options.workspaceRoot, sessionId);
    fs.mkdirSync(artifactDir, { recursive: true });

    const timestamp = Date.now();
    const filename = `${String(timestamp)}-${tabId}.pdf`;
    const filePath = path.join(artifactDir, filename);

    const buffer = await page.pdf();
    fs.writeFileSync(filePath, buffer);

    return browserJsonResult(
      {
        sessionId,
        tabId,
        path: filePath,
        byteLength: buffer.byteLength,
        url: page.url(),
      },
      { sessionId, tabId, url: page.url() },
    );
  }

  /**
   * Check whether `filePath` is contained within `allowedDir` using
   * path.relative + path.isAbsolute (not string prefix) to prevent traversal.
   */
  function isPathContainedIn(filePath: string, allowedDir: string): boolean {
    // P2-SEC-009: Use realpathSync to resolve symlinks before containment check.
    // Both paths must use the same resolution method to ensure consistent comparison.
    let fileResolved: string;
    let baseResolved: string;
    try {
      fileResolved = fs.realpathSync(filePath);
      baseResolved = fs.realpathSync(allowedDir);
    } catch (err) {
      // Fall back to path.resolve for both if either path does not exist
      console.warn("[friday][agent-browser-tool] realpath fallback:", err instanceof Error ? err.message : String(err));
      fileResolved = path.resolve(filePath);
      baseResolved = path.resolve(allowedDir);
    }
    const rel = path.relative(baseResolved, fileResolved);
    // Must not be empty, must not start with "..", and must not be absolute
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  /** Allowed directories for upload file paths. */
  function getUploadAllowedDirs(): string[] {
    return [
      browserManager.options.workspaceRoot,
      os.tmpdir(),
    ];
  }

  async function handleUpload(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const { sessionId, tabId } = resolveSession(args);
    const { page } = await browserManager.getPage(sessionId, { tabId }, signal);
    const selector = readStringParam(args, "selector", { required: true });

    const rawPaths = args.filePaths;
    const filePaths = Array.isArray(rawPaths)
      ? rawPaths.filter((v): v is string => typeof v === "string")
      : [];

    if (filePaths.length === 0) {
      return errorResult("filePaths array is required for upload action.");
    }

    // Validate file paths are within allowed directories (prevent file exfiltration)
    const allowedDirs = getUploadAllowedDirs();
    for (const fp of filePaths) {
      const contained = allowedDirs.some((dir) => isPathContainedIn(fp, dir));
      if (!contained) {
        return errorResult(
          `Upload path "${fp}" is outside allowed directories. ` +
          `Allowed: ${allowedDirs.join(", ")}`,
        );
      }
    }

    // Validate file paths exist
    for (const fp of filePaths) {
      if (!fs.existsSync(fp)) {
        return errorResult(`File not found: ${fp}`);
      }
    }

    await page.setInputFiles(selector, filePaths);

    return browserJsonResult(
      {
        sessionId,
        tabId,
        selector,
        uploadedFiles: filePaths.length,
        url: page.url(),
      },
      { sessionId, tabId, url: page.url() },
    );
  }

  async function handleDialog(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const { sessionId, tabId } = resolveSession(args);
    const { page } = await browserManager.getPage(sessionId, { tabId }, signal);
    const accept = readBooleanParam(args, "accept") ?? true;
    const promptText = readStringParam(args, "promptText");

    // Set up dialog handler for the next dialog, with proper cleanup on timeout
    const dialogHandler = async (dialog: { type(): string; message(): string; accept(promptText?: string): Promise<void>; dismiss(): Promise<void> }) => {
      const info = { type: dialog.type(), message: dialog.message() };
      if (accept) {
        await dialog.accept(promptText ?? undefined);
      } else {
        await dialog.dismiss();
      }
      resolveDialog(info);
    };

    let resolveDialog: (value: { type: string; message: string }) => void;
    const dialogPromise = new Promise<{ type: string; message: string }>((resolve) => {
      resolveDialog = resolve;
    });

    page.once("dialog", dialogHandler as (...args: unknown[]) => void);

    // Wait briefly for a dialog (it may already be showing)
    const timeMs = readNumberParam(args, "timeMs", { integer: true }) ?? 5000;
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeMs);
    });

    const result = await Promise.race([dialogPromise, timeoutPromise]);

    if (result === null) {
      // Timeout: remove the stale listener to prevent it from handling a future dialog
      const listener = dialogHandler as (...args: unknown[]) => void;
      if (typeof page.removeListener === "function") {
        page.removeListener("dialog", listener);
      } else if (typeof page.off === "function") {
        page.off("dialog", listener);
      }

      return browserJsonResult(
        {
          sessionId,
          tabId,
          dialog: null,
          message: "No dialog appeared within timeout.",
        },
        { sessionId, tabId },
      );
    }

    return browserJsonResult(
      {
        sessionId,
        tabId,
        dialog: result,
        accepted: accept,
        promptText: promptText ?? null,
      },
      { sessionId, tabId },
    );
  }
}
