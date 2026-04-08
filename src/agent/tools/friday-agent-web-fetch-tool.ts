import { FRIDAY_AGENT_WEB_FETCH_MAX_BYTES } from "../friday-agent.constants.js";
import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type { FridayAgentSsrfGuard } from "../security/friday-agent-ssrf-guard.js";
import { fetchWithFridayAgentSsrfGuard } from "../security/friday-agent-fetch-guard.js";
import { summarizeContent } from "../../link-understanding/friday-link-summarize.js";
import { isFridayTestSecurityWarningSuppressed } from "../../utilities/friday-warning-flags.js";
import {
  errorResult,
  readBooleanParam,
  readNumberParam,
  readRecordParam,
  readStringParam,
  truncateOutput,
} from "./friday-agent-tool-helpers.js";

// ─── Default timeout for web fetch (30 seconds) ───

const FRIDAY_AGENT_WEB_FETCH_TIMEOUT_MS = 30_000;

// ─── Valid HTTP methods ───

const VALID_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

// ─── Default browser-like headers ───
// Many sites block requests without a realistic User-Agent or return JS-only
// shells.  Sending browser-like headers makes web_fetch behave like a normal
// browser and avoids unnecessary fallback to the heavier browser tool.

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1",
  "Accept-Language": "en-US,en;q=0.9",
};

// ─── URL rewriting ───
// Some sites serve JS-heavy SPAs on their main domain but have lightweight
// server-rendered versions on an alternate host.  Rewriting the URL before
// fetch lets us get real HTML without needing a headless browser.

/** @internal Exported for unit tests. */
export function rewriteUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // Reddit: www.reddit.com / reddit.com → old.reddit.com (server-rendered)
    if (u.hostname === "www.reddit.com" || u.hostname === "reddit.com") {
      u.hostname = "old.reddit.com";
      return u.toString();
    }
  } catch (err) {
    // Malformed URL — let fetch() handle the error downstream without
    // adding another warning line on top of the eventual fetch error.
  }
  return raw;
}

// ─── Options ───

export interface CreateFridayAgentWebFetchToolOptions {
  /** Optional SSRF guard to validate URLs before fetching. */
  ssrfGuard?: FridayAgentSsrfGuard;
}

// ─── Factory ───

export function createFridayAgentWebFetchTool(
  options?: CreateFridayAgentWebFetchToolOptions,
): FridayAgentToolDefinition {
  const ssrfGuard = options?.ssrfGuard;

  // P1-SEC-001: Warn when SSRF guard is not configured
  if (!ssrfGuard && !isFridayTestSecurityWarningSuppressed()) {
    console.warn("[friday][SECURITY] web_fetch tool created without SSRF guard — internal network requests will not be blocked");
  }

  return {
    name: "web_fetch",
    description:
      "Make HTTP requests. Supports GET, POST, PUT, DELETE methods. " +
      "HTML responses are automatically converted to readable plain text (scripts/styles stripped). " +
      "Response body is truncated to 100KB. For JSON APIs, set parseHtml to false.",
    parameters: {
      properties: {
        url: { type: "string", description: "HTTP or HTTPS URL to fetch" },
        method: {
          type: "string",
          description: "HTTP method (GET, POST, PUT, DELETE). Defaults to GET.",
        },
        headers: { type: "object", description: "Request headers" },
        body: { type: "string", description: "Request body (for POST/PUT)" },
        timeoutMs: { type: "number", description: "Timeout in milliseconds" },
        parseHtml: {
          type: "boolean",
          description: "Auto-parse HTML to plain text. Defaults to true. Set false for raw response (JSON APIs).",
        },
      },
      required: ["url"],
    },
    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const url = readStringParam(args, "url", { required: true });
      const method = (readStringParam(args, "method") ?? "GET").toUpperCase();
      const headers = readRecordParam(args, "headers");
      const body = readStringParam(args, "body");
      const timeoutMs = readNumberParam(args, "timeoutMs", { integer: true }) ?? FRIDAY_AGENT_WEB_FETCH_TIMEOUT_MS;
      const parseHtml = readBooleanParam(args, "parseHtml") ?? true;

      if (!VALID_METHODS.has(method)) {
        return errorResult(`Invalid HTTP method: ${method}. Use GET, POST, PUT, or DELETE.`);
      }

      // Rewrite URL for sites with server-rendered alternatives
      const effectiveUrl = rewriteUrl(url);

      // Merge default browser headers with any user-supplied headers.
      // User headers win when there is a conflict (case-sensitive merge).
      const mergedHeaders: Record<string, string> = { ...DEFAULT_HEADERS, ...(headers ?? {}) };

      // Create a combined abort signal (tool signal + timeout)
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), Math.max(1, timeoutMs));

      const onParentAbort = () => timeoutController.abort();
      if (signal.aborted) {
        timeoutController.abort();
      } else {
        signal.addEventListener("abort", onParentAbort, { once: true });
      }

      try {
        const fetchInit: RequestInit = {
          method,
          headers: mergedHeaders,
          body: method === "GET" || method === "DELETE" ? undefined : body,
          signal: timeoutController.signal,
        };

        // Use SSRF-guarded fetch (with DNS + redirect revalidation) when guard is present,
        // otherwise fall back to raw fetch.
        const response = ssrfGuard
          ? await fetchWithFridayAgentSsrfGuard({ url: effectiveUrl, init: fetchInit, guard: ssrfGuard })
          : await fetch(effectiveUrl, fetchInit);

        const responseBody = await response.text();
        const contentType = response.headers.get("content-type") ?? "";

        // Parse HTML to readable text when appropriate
        const isHtml = contentType.includes("html") || (!contentType && responseBody.trimStart().startsWith("<"));
        const processedBody = (parseHtml && isHtml)
          ? await summarizeContent(responseBody, contentType, FRIDAY_AGENT_WEB_FETCH_MAX_BYTES, effectiveUrl)
          : truncateOutput(responseBody, FRIDAY_AGENT_WEB_FETCH_MAX_BYTES);

        // Detect JS-rendered pages — signal as error so LLM retries with browser
        const jsRendered = processedBody.includes("JS-rendered") || processedBody.includes("content may require JavaScript");

        const resultText = [
          `HTTP ${String(response.status)} ${response.statusText}`,
          contentType ? `Content-Type: ${contentType}` : "",
          isHtml && parseHtml && !jsRendered ? "(HTML parsed to plain text)" : "",
          "",
          processedBody,
        ]
          .filter((line) => line !== "")
          .join("\n");

        return {
          content: resultText,
          isError: response.status >= 400 || jsRendered ? true : undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("abort")) {
          return errorResult(`Request timed out after ${String(timeoutMs)}ms`);
        }
        return errorResult(`Fetch error: ${message}`);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onParentAbort);
      }
    },
  };
}
