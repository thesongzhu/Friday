import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Types ───

export interface FridayEmailMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
  snippet: string;
  body?: string;
  isRead: boolean;
}

export interface FridayEmailSendRequest {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  isHtml?: boolean;
}

export interface FridayEmailSendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

export interface FridayEmailListRequest {
  folder?: string;
  limit?: number;
  unreadOnly?: boolean;
}

export interface FridayEmailSearchRequest {
  query: string;
  folder?: string;
  limit?: number;
}

export interface FridayEmailService {
  send(request: FridayEmailSendRequest, signal: AbortSignal): Promise<FridayEmailSendResult>;
  list(request: FridayEmailListRequest, signal: AbortSignal): Promise<FridayEmailMessage[]>;
  read(messageId: string, signal: AbortSignal): Promise<FridayEmailMessage>;
  search(request: FridayEmailSearchRequest, signal: AbortSignal): Promise<FridayEmailMessage[]>;
}

export interface CreateFridayAgentEmailToolOptions {
  emailService: FridayEmailService;
}

// ─── Factory ───

export function createFridayAgentEmailTool(
  options: CreateFridayAgentEmailToolOptions,
): FridayAgentToolDefinition {
  const { emailService } = options;

  return {
    name: "email",
    description:
      "Send and receive emails. Operations: " +
      "'send' sends an email, 'list' lists inbox messages, " +
      "'read' reads a specific email by ID, 'search' searches emails by query. " +
      "Supports Gmail, Outlook, and generic SMTP/IMAP.",
    parameters: {
      properties: {
        operation: {
          type: "string",
          enum: ["send", "list", "read", "search"],
          description: "The email operation to perform.",
        },
        to: {
          type: "array",
          items: { type: "string" },
          description: "Recipient email addresses (for send).",
        },
        cc: {
          type: "array",
          items: { type: "string" },
          description: "CC recipients (for send, optional).",
        },
        subject: {
          type: "string",
          description: "Email subject (for send).",
        },
        body: {
          type: "string",
          description: "Email body content (for send).",
        },
        isHtml: {
          type: "boolean",
          description: "Whether the body is HTML (default: false).",
        },
        messageId: {
          type: "string",
          description: "Message ID to read (for read operation).",
        },
        query: {
          type: "string",
          description: "Search query (for search operation).",
        },
        folder: {
          type: "string",
          description: "Email folder (default: INBOX).",
        },
        limit: {
          type: "number",
          description: "Maximum number of messages to return (default: 20).",
        },
      },
      required: ["operation"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const operation = readStringParam(args, "operation", { required: true });

      try {
        switch (operation) {
          case "send": {
            const to = readStringArrayParam(args, "to", { required: true });
            const subject = readStringParam(args, "subject", { required: true });
            const body = readStringParam(args, "body", { required: true });
            const cc = readStringArrayParam(args, "cc");
            const isHtml = args["isHtml"] === true;

            const result = await emailService.send(
              { to, subject, body, cc, isHtml },
              signal,
            );
            return jsonResult({
              sent: true,
              messageId: result.messageId,
              accepted: result.accepted,
              rejected: result.rejected,
            });
          }

          case "list": {
            const folder = readStringParam(args, "folder");
            const limit = readNumberParam(args, "limit", { integer: true });
            const messages = await emailService.list(
              { folder, limit: limit ?? 20 },
              signal,
            );
            return jsonResult({
              folder: folder ?? "INBOX",
              count: messages.length,
              messages: messages.map(({ id, from, to, subject, date, snippet, isRead }) => ({
                id, from, to, subject, date, snippet, isRead,
              })),
            });
          }

          case "read": {
            const messageId = readStringParam(args, "messageId", { required: true });
            const message = await emailService.read(messageId, signal);
            return jsonResult(message);
          }

          case "search": {
            const query = readStringParam(args, "query", { required: true });
            const folder = readStringParam(args, "folder");
            const limit = readNumberParam(args, "limit", { integer: true });
            const messages = await emailService.search(
              { query, folder, limit: limit ?? 20 },
              signal,
            );
            return jsonResult({
              query,
              count: messages.length,
              messages: messages.map(({ id, from, to, subject, date, snippet, isRead }) => ({
                id, from, to, subject, date, snippet, isRead,
              })),
            });
          }

          default:
            return errorResult(
              `Unknown operation "${operation}". Valid: send, list, read, search.`,
            );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("Email operation aborted.");
        }
        return errorResult(`Email error: ${message}`);
      }
    },
  };
}
