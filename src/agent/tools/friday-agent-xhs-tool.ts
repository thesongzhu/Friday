// ─── XHS Agent Tool — Xiaohongshu automation for the agent ───

import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";
import type { XhsPageInteractions } from "../../xhs/friday-xhs-pages.js";
import type { XhsSessionManager } from "../../xhs/friday-xhs-session.js";

// ─── Types ───

export interface CreateFridayAgentXhsToolOptions {
  pageInteractions: XhsPageInteractions;
  sessionManager: XhsSessionManager;
}

type XhsAction = "login" | "search" | "post" | "comments" | "status";

const VALID_ACTIONS = new Set<XhsAction>(["login", "search", "post", "comments", "status"]);
const DEFAULT_SESSION_ID = "xhs-default";
const DEFAULT_MAX_RESULTS = 10;

// ─── Factory ───

export function createFridayAgentXhsTool(
  options: CreateFridayAgentXhsToolOptions,
): FridayAgentToolDefinition {
  const { pageInteractions, sessionManager } = options;

  return {
    name: "xhs",
    description:
      "Xiaohongshu (小红书/RED) automation. Actions: login (QR code login), search (search posts), " +
      "post (create 图文笔记), comments (extract comments), status (check login state).",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: ["login", "search", "post", "comments", "status"],
          description: "XHS action to perform.",
        },
        sessionId: {
          type: "string",
          description: "Session identifier (default: xhs-default).",
        },
        keyword: {
          type: "string",
          description: "Search keyword (for search action).",
        },
        maxResults: {
          type: "number",
          description: "Maximum search results to return (default: 10).",
        },
        title: {
          type: "string",
          description: "Post title (for post action).",
        },
        content: {
          type: "string",
          description: "Post content body (for post action).",
        },
        images: {
          type: "array",
          items: { type: "string" },
          description: "Image file paths (for post action).",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for the post (for post action).",
        },
        postUrl: {
          type: "string",
          description: "Post URL to extract comments from (for comments action).",
        },
      },
      required: ["action"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const action = readStringParam(args, "action", { required: true }) as XhsAction;
      const sessionId = readStringParam(args, "sessionId") ?? DEFAULT_SESSION_ID;

      if (!VALID_ACTIONS.has(action)) {
        return errorResult(
          `Invalid action "${action}". Valid actions: ${Array.from(VALID_ACTIONS).join(", ")}`,
        );
      }

      try {
        switch (action) {
          case "login":
            return await handleLogin(sessionId, signal);
          case "search":
            return await handleSearch(sessionId, args, signal);
          case "post":
            return await handlePost(sessionId, args, signal);
          case "comments":
            return await handleComments(sessionId, args, signal);
          case "status":
            return await handleStatus(sessionId, signal);
          default:
            return errorResult(`Unknown action: ${action as string}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("XHS action aborted.");
        }
        return errorResult(`XHS error: ${message}`);
      }
    },
  };

  // ─── Action handlers ───

  async function handleLogin(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const result = await pageInteractions.login(sessionId, sessionId, signal);
    return jsonResult({
      action: "login",
      sessionId,
      ...result,
    });
  }

  async function handleSearch(
    sessionId: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const keyword = readStringParam(args, "keyword", { required: true });
    const maxResults = readNumberParam(args, "maxResults", { integer: true }) ?? DEFAULT_MAX_RESULTS;

    const results = await pageInteractions.search(sessionId, keyword, maxResults, signal);
    return jsonResult({
      action: "search",
      sessionId,
      keyword,
      resultCount: results.length,
      results,
    });
  }

  async function handlePost(
    sessionId: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const title = readStringParam(args, "title", { required: true });
    const content = readStringParam(args, "content", { required: true });
    const images = readArrayParam(args, "images");
    const tags = readArrayParam(args, "tags");

    if (images.length === 0) {
      return errorResult("At least one image is required for an XHS post.");
    }

    const result = await pageInteractions.createPost(
      sessionId,
      title,
      content,
      images,
      tags,
      signal,
    );
    return jsonResult({
      action: "post",
      sessionId,
      ...result,
    });
  }

  async function handleComments(
    sessionId: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const postUrl = readStringParam(args, "postUrl", { required: true });

    const comments = await pageInteractions.extractComments(sessionId, postUrl, signal);
    return jsonResult({
      action: "comments",
      sessionId,
      postUrl,
      commentCount: comments.length,
      comments,
    });
  }

  async function handleStatus(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const sessionRow = sessionManager.getSession(sessionId);
    const isValid = sessionManager.isSessionValid(sessionId);

    return jsonResult({
      action: "status",
      sessionId,
      hasSession: sessionRow !== undefined,
      isValid,
      accountName: sessionRow?.account_name,
      lastUsedAt: sessionRow?.last_used_at,
    });
  }
}

// ─── Helpers ───

function readArrayParam(params: Record<string, unknown>, key: string): string[] {
  const raw = params[key];
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string");
  }
  return [];
}
