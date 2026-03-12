import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type { FridayChannelRegistry } from "../../channels/friday-channel-registry.js";
import {
  errorResult,
  jsonResult,
  readStringArrayParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Types ───

export interface CreateFridayAgentMessageToolDeps {
  channelRegistry: FridayChannelRegistry;
}

// ─── Factory ───

export function createFridayAgentMessageTool(
  deps: CreateFridayAgentMessageToolDeps,
): FridayAgentToolDefinition {
  const { channelRegistry } = deps;

  return {
    name: "message",
    description:
      "Send a message through a channel (e.g. QQ, Lark, Discord). " +
      "Validates channel availability before sending. Returns message ID on success.",
    parameters: {
      properties: {
        channel: {
          type: "string",
          description: "Channel kind to send through (e.g. 'qq', 'lark', 'discord').",
        },
        chatId: {
          type: "string",
          description: "Target conversation/chat/group ID.",
        },
        text: {
          type: "string",
          description: "Message text content.",
        },
        images: {
          type: "array",
          description: "Optional image URLs or file paths to attach.",
        },
        replyTo: {
          type: "string",
          description: "Optional message ID to reply to.",
        },
      },
      required: ["channel", "chatId", "text"],
    },

    async execute(
      args: Record<string, unknown>,
      _signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      try {
        const channel = readStringParam(args, "channel", { required: true });
        const chatId = readStringParam(args, "chatId", { required: true });
        const text = readStringParam(args, "text", { required: true });
        const images = readStringArrayParam(args, "images");
        const replyTo = readStringParam(args, "replyTo");

        // Validate channel is registered
        const entry = channelRegistry.get(channel);
        if (!entry) {
          const available = channelRegistry.list();
          return errorResult(
            `Channel "${channel}" is not registered. Available channels: ${available.length > 0 ? available.join(", ") : "(none)"}`,
          );
        }

        // Validate channel is running
        if (!entry.running) {
          return errorResult(
            `Channel "${channel}" is registered but not running. Start it first.`,
          );
        }

        // Send message
        const result = await channelRegistry.send(channel, {
          chatId,
          text,
          images,
          replyTo,
        });

        return jsonResult({
          sent: true,
          channel,
          chatId,
          messageId: result.messageId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(`Failed to send message: ${message}`);
      }
    },
  };
}
