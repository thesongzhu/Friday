import { FridayDomainError } from "#errors";
import type {
  FridayAgentMessage,
  FridayAgentToolDefinition,
  FridayAgentToolResult,
} from "../model/friday-agent.types.js";
import type { FridaySessionService } from "../../sessions/services/friday-session-service.types.js";
import type { FridayAgentRuntime } from "../runtime/friday-agent-runtime.types.js";
import { getFridayAgentToolExecutionContext } from "../runtime/friday-agent-tool-execution-context.js";
import {
  errorResult,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Types ───

export interface CreateFridayAgentSessionsToolDeps {
  sessionService: FridaySessionService;
  /** Direct runtime reference (used if agentRuntimeGetter is not provided). */
  agentRuntime?: FridayAgentRuntime;
  /**
   * Lazy getter for agent runtime — resolves the circular dependency when
   * the runtime is created after the tool registry. Takes precedence over
   * `agentRuntime` when both are supplied.
   */
  agentRuntimeGetter?: () => FridayAgentRuntime | undefined;
}

type SessionsAction = "list" | "history" | "send" | "spawn";

const VALID_ACTIONS = new Set<SessionsAction>(["list", "history", "send", "spawn"]);

// P2-SEC: Track recursive sessions:send depth to prevent unbounded execution
const MAX_SESSION_SEND_DEPTH = 3;
const activeSessionSendDepth = new Map<string, number>();

/** Default message limit for history action. */
const DEFAULT_HISTORY_LIMIT = 50;

/** Max message limit for history action. */
const MAX_HISTORY_LIMIT = 200;
const SESSION_CONTEXT_HISTORY_LIMIT = 24;

// ─── Factory ───

export function createFridayAgentSessionsTool(
  deps: CreateFridayAgentSessionsToolDeps,
): FridayAgentToolDefinition {
  const { sessionService } = deps;

  function getRuntime(): FridayAgentRuntime {
    const rt = deps.agentRuntimeGetter?.() ?? deps.agentRuntime;
    if (!rt) {
      throw new FridayDomainError("NOT_INITIALIZED", "Agent runtime is not available yet. It may still be initializing.", { httpStatus: 503 });
    }
    return rt;
  }

  function mapSessionMessageToAgentMessage(
    message: {
      role: string;
      content: unknown;
      contentText: string;
    },
  ): FridayAgentMessage | null {
    if (message.role !== "user" && message.role !== "assistant") {
      return null;
    }

    if (typeof message.content === "string") {
      const content = message.content.trim();
      if (content.length > 0) {
        return { role: message.role, content };
      }
    }

    const fallbackText = message.contentText.trim();
    if (fallbackText.length > 0) {
      return { role: message.role, content: fallbackText };
    }

    return null;
  }

  return {
    name: "sessions",
    description:
      "Manage conversation sessions. Actions: list (session summaries), history (messages for a session), " +
      "send (append a message and trigger agent execution), spawn (create a new session).",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: ["list", "history", "send", "spawn"],
          description: "Session action to perform.",
        },
        sessionId: {
          type: "string",
          description: "Session key (required for history, send).",
        },
        agentId: {
          type: "string",
          description: "Agent/channel identifier for spawn (e.g. 'agent:main').",
        },
        message: {
          type: "string",
          description: "Message text (required for send).",
        },
        limit: {
          type: "number",
          description: "Max number of results to return (for list and history).",
        },
      },
      required: ["action"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const action = readStringParam(args, "action", { required: true }) as SessionsAction;

      if (!VALID_ACTIONS.has(action)) {
        return errorResult(
          `Invalid action "${action}". Valid actions: ${Array.from(VALID_ACTIONS).join(", ")}`,
        );
      }

      try {
        switch (action) {
          case "list":
            return await handleList(args);
          case "history":
            return await handleHistory(args);
          case "send":
            return await handleSend(args, signal);
          case "spawn":
            return await handleSpawn(args);
          default:
            return errorResult(`Unknown action: ${action as string}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message);
      }
    },
  };

  // ─── Action handlers ───

  async function handleList(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const limit = readNumberParam(args, "limit", { integer: true });

    const sessions = await sessionService.listSessions({
      limit: limit ?? 20,
    });

    return jsonResult({
      count: sessions.length,
      sessions: sessions.map((s) => ({
        key: s.key,
        channel: s.channel,
        chatId: s.chatId,
        status: s.status,
        messageCount: s.messageCount,
        contextTotalTokens: s.contextTotalTokens,
        lastActivityAt: s.lastActivityAt,
        createdAt: s.createdAt,
        parentSessionKey: s.parentSessionKey,
      })),
    });
  }

  async function handleHistory(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const sessionId = readStringParam(args, "sessionId");
    if (!sessionId) {
      return errorResult("sessionId is required for history action.");
    }

    const rawLimit = readNumberParam(args, "limit", { integer: true });
    const limit = Math.min(rawLimit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);

    // Verify session exists
    const session = await sessionService.getSession(sessionId);
    if (!session) {
      return errorResult(`Session "${sessionId}" not found.`);
    }

    const messages = await sessionService.getMessages(sessionId, limit);

    return jsonResult({
      sessionKey: sessionId,
      status: session.status,
      messageCount: session.messageCount,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        contentText: m.contentText.slice(0, 1000),
        tokenCount: m.tokenCount,
        occurredAt: m.occurredAt,
      })),
    });
  }

  async function handleSend(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const sessionId = readStringParam(args, "sessionId");
    const message = readStringParam(args, "message");

    if (!sessionId) {
      return errorResult("sessionId is required for send action.");
    }
    if (!message) {
      return errorResult("message is required for send action.");
    }

    // Ensure session exists (create if needed)
    await sessionService.getOrCreateSession(sessionId);

    const inboundIdempotencyKey = `sessions-tool:${sessionId}:${Date.now().toString(36)}:user`;

    // Add the user message
    const messageRecord = await sessionService.addMessage(sessionId, {
      role: "user",
      content: message,
      contentText: message,
      idempotencyKey: inboundIdempotencyKey,
    });

    const historyMessages = await sessionService
      .getMessages(sessionId, SESSION_CONTEXT_HISTORY_LIMIT + 1)
      .then((messages) => {
        const mapped = messages
          .filter((entry) => entry.idempotencyKey !== inboundIdempotencyKey)
          .map(mapSessionMessageToAgentMessage)
          .filter((entry): entry is FridayAgentMessage => entry !== null);
        if (mapped.length <= SESSION_CONTEXT_HISTORY_LIMIT) {
          return mapped;
        }
        return mapped.slice(mapped.length - SESSION_CONTEXT_HISTORY_LIMIT);
      })
      .catch(() => [] as FridayAgentMessage[]);

    // P2-SEC: Guard against recursive unbounded execution via sessions:send
    const currentDepth = activeSessionSendDepth.get(sessionId) ?? 0;
    if (currentDepth >= MAX_SESSION_SEND_DEPTH) {
      return errorResult(`Maximum sessions:send recursion depth (${MAX_SESSION_SEND_DEPTH}) exceeded. Cannot trigger further nested agent runs.`);
    }

    // Trigger agent execution on this session
    activeSessionSendDepth.set(sessionId, currentDepth + 1);
    const runtime = getRuntime();
    let result;
    try {
      result = await runtime.executeRun({
        task: message,
        sessionKey: sessionId,
        signal,
        historyMessages,
        timezone: getFridayAgentToolExecutionContext(signal)?.timezone,
      });
    } finally {
      const depth = activeSessionSendDepth.get(sessionId) ?? 1;
      if (depth <= 1) activeSessionSendDepth.delete(sessionId);
      else activeSessionSendDepth.set(sessionId, depth - 1);
    }

    return jsonResult({
      sessionKey: sessionId,
      messageId: messageRecord.id,
      agentRun: {
        runId: result.runId,
        status: result.status,
        response: result.response.slice(0, 2000),
        toolCallCount: result.toolCallCount,
        durationMs: result.durationMs,
      },
    });
  }

  async function handleSpawn(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const sessionId = readStringParam(args, "sessionId");
    const agentId = readStringParam(args, "agentId");
    const message = readStringParam(args, "message");

    // Build session key
    const sessionKey = sessionId ?? `agent:${agentId ?? "main"}:${Date.now().toString(36)}`;

    // Create the session
    const session = await sessionService.getOrCreateSession(sessionKey);

    // Optionally add an initial message
    let messageId: string | undefined;
    if (message) {
      const record = await sessionService.addMessage(sessionKey, {
        role: "user",
        content: message,
      });
      messageId = record.id;
    }

    return jsonResult({
      spawned: true,
      sessionKey: session.key,
      status: session.status,
      messageId,
    });
  }
}
