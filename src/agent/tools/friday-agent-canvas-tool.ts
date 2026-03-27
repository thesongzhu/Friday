import { FridayDomainError } from "#errors";
import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readBooleanParam,
  readNumberParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";
import { validateGatewayUrl } from "./friday-agent-gateway-validation.js";
import type { FridayBrowserManager } from "../../browser/friday-browser-manager.js";

// ─── Constants ───

type CanvasAction = "present" | "navigate" | "eval" | "snapshot";

const VALID_ACTIONS = new Set<CanvasAction>(["present", "navigate", "eval", "snapshot"]);
const DEFAULT_TIMEOUT_MS = 30_000;
const CANVAS_SESSION_PREFIX = "canvas:";

// ─── Types ───

export interface CreateFridayAgentCanvasToolOptions {
  browserManager: FridayBrowserManager;
  /** Default workspace root for artifact storage. */
  workspaceRoot?: string;
}

// ─── Factory ───

export function createFridayAgentCanvasTool(
  options: CreateFridayAgentCanvasToolOptions,
): FridayAgentToolDefinition {
  const { browserManager } = options;

  return {
    name: "canvas",
    description:
      "Control managed browser canvases for rendering HTML, navigating URLs, evaluating JavaScript, " +
      "and taking snapshots. Each canvasId maps to a dedicated browser page. " +
      "Actions: present (create/show canvas with URL or inline HTML), navigate (go to URL), " +
      "eval (run JavaScript), snapshot (capture screenshot or AX tree).",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: ["present", "navigate", "eval", "snapshot"],
          description: "Canvas action to perform.",
        },
        canvasId: {
          type: "string",
          description: "Canvas identifier. Auto-generated if omitted for 'present'.",
        },
        url: {
          type: "string",
          description: "URL to load (for present/navigate).",
        },
        html: {
          type: "string",
          description: "Inline HTML content to render (for present action).",
        },
        script: {
          type: "string",
          description: "JavaScript to evaluate (for eval action).",
        },
        timeoutMs: {
          type: "number",
          description: `Navigation/eval timeout in ms (default: ${DEFAULT_TIMEOUT_MS}).`,
        },
        fullPage: {
          type: "boolean",
          description: "Capture full page screenshot (default: false, for snapshot action).",
        },
      },
      required: ["action"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const action = readStringParam(args, "action", { required: true }) as CanvasAction;

      if (!VALID_ACTIONS.has(action)) {
        return errorResult(
          `Invalid action "${action}". Valid: ${Array.from(VALID_ACTIONS).join(", ")}`,
        );
      }

      try {
        switch (action) {
          case "present":
            return await handlePresent(args, signal);
          case "navigate":
            return await handleNavigate(args, signal);
          case "eval":
            return await handleEval(args, signal);
          case "snapshot":
            return await handleSnapshot(args, signal);
          default:
            return errorResult(`Unknown canvas action: ${action as string}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("Canvas action aborted.");
        }
        return errorResult(`Canvas error: ${message}`);
      }
    },
  };

  // ─── Helpers ───

  /**
   * Validate a navigation URL. Rejects file://, javascript:, and private/loopback IPs.
   */
  function validateCanvasUrl(url: string): string | null {
    // Reject dangerous schemes before parsing
    const lower = url.trim().toLowerCase();
    if (lower.startsWith("file:") || lower.startsWith("javascript:")) {
      return `Disallowed URL scheme in: '${url}'`;
    }
    const result = validateGatewayUrl(url);
    if (!result.valid) {
      return result.error ?? `Invalid URL: '${url}'`;
    }
    return null;
  }

  function resolveCanvasId(args: Record<string, unknown>, required: boolean): string {
    const canvasId = readStringParam(args, "canvasId");
    if (canvasId) return canvasId;
    if (required) {
      throw new FridayDomainError("VALIDATION_ERROR", "canvasId is required for this action.", { httpStatus: 400 });
    }
    return `canvas-${Date.now()}`;
  }

  function sessionIdForCanvas(canvasId: string): string {
    return `${CANVAS_SESSION_PREFIX}${canvasId}`;
  }

  // ─── Action handlers ───

  async function handlePresent(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const canvasId = resolveCanvasId(args, false);
    const url = readStringParam(args, "url");
    const html = readStringParam(args, "html");
    const timeoutMs = readNumberParam(args, "timeoutMs", { integer: true }) ?? DEFAULT_TIMEOUT_MS;

    if (!url && !html) {
      return errorResult("Either 'url' or 'html' is required for present action.");
    }

    // Validate URL before navigation
    if (url) {
      const urlError = validateCanvasUrl(url);
      if (urlError) {
        return errorResult(urlError);
      }
    }

    const sessionId = sessionIdForCanvas(canvasId);
    await browserManager.launch(sessionId, signal);
    const { page } = await browserManager.getPage(sessionId, {}, signal);

    if (url) {
      await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    } else if (html) {
      await page.setContent(html, { waitUntil: "load", timeout: timeoutMs });
    }

    return jsonResult({
      canvasId,
      sessionId,
      url: page.url(),
      title: await page.title(),
    });
  }

  async function handleNavigate(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const canvasId = resolveCanvasId(args, true);
    const url = readStringParam(args, "url", { required: true });
    const timeoutMs = readNumberParam(args, "timeoutMs", { integer: true }) ?? DEFAULT_TIMEOUT_MS;

    // Validate URL before navigation
    const urlError = validateCanvasUrl(url);
    if (urlError) {
      return errorResult(urlError);
    }

    const sessionId = sessionIdForCanvas(canvasId);
    const { page } = await browserManager.getPage(sessionId, {}, signal);
    await page.goto(url, { waitUntil: "load", timeout: timeoutMs });

    return jsonResult({
      canvasId,
      sessionId,
      url: page.url(),
      title: await page.title(),
    });
  }

  async function handleEval(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const canvasId = resolveCanvasId(args, true);
    const script = readStringParam(args, "script", { required: true });

    const sessionId = sessionIdForCanvas(canvasId);
    const { page } = await browserManager.getPage(sessionId, {}, signal);

    signal.throwIfAborted();
    const result = await page.evaluate(script);

    return jsonResult({
      canvasId,
      sessionId,
      result,
      url: page.url(),
      title: await page.title(),
    });
  }

  async function handleSnapshot(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const canvasId = resolveCanvasId(args, true);
    const fullPage = readBooleanParam(args, "fullPage") ?? false;

    const sessionId = sessionIdForCanvas(canvasId);
    const { page } = await browserManager.getPage(sessionId, {}, signal);

    signal.throwIfAborted();

    const axTree = await browserManager.snapshotAria(sessionId, {}, signal);
    const screenshot = await page.screenshot({ fullPage, type: "png" });
    const base64 = screenshot.toString("base64");
    const viewport = page.viewportSize();

    return jsonResult({
      canvasId,
      sessionId,
      url: page.url(),
      title: await page.title(),
      axTree,
      screenshot: {
        mimeType: "image/png",
        base64,
        width: viewport?.width ?? 0,
        height: viewport?.height ?? 0,
        byteLength: screenshot.byteLength,
      },
    });
  }
}
