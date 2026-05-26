/**
 * Lark/Feishu Channel Plugin — connects via WebSocket or webhook.
 *
 * Auth flow:
 *   1. POST appId + appSecret → tenant_access_token
 *   2. Connect WebSocket for event subscription (default)
 *   3. Send messages via REST API
 *
 * Region support:
 *   - International Lark: https://open.larksuite.com
 *   - China Feishu: https://open.feishu.cn
 *
 * References:
 *   - https://open.feishu.cn/document/server-docs/overview
 *   - https://open.larksuite.com/document/server-docs/overview
 */

import { createHash } from "node:crypto";
import { LarkDomain } from "./internal/lark-domain.js";
import { LarkEventDispatcher } from "./internal/lark-event-dispatcher.js";
import type { LarkEventHandler } from "./internal/lark-event-dispatcher.js";
import { LarkWsClient } from "./internal/lark-ws-client.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FridayDomainError } from "#errors";
import type {
  FridayChannelAttachment,
  FridayChannelAttachmentKind,
  FridayChannelMessage,
  FridayChannelPlugin,
  FridayChannelSendOptions,
} from "../friday-channel.types.js";
import type {
  FridayChannelAdapters,
  FridayChannelInboundAdapter,
  FridayChannelLifecycleAdapter,
  FridayChannelOutboundAdapter,
  FridayChannelStatus,
  FridayChannelStatusAdapter,
} from "../friday-channel-adapters.types.js";
import { formatFridayChannelOutboundText } from "../friday-channel-outbound-formatting.js";
import type { LarkWebhookRelayService } from "./lark-webhook-relay.js";

// ─── Constants ───

const FEISHU_API_BASE = "https://open.feishu.cn";
const LARK_API_BASE = "https://open.larksuite.com";

const TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const SEND_MESSAGE_PATH = "/open-apis/im/v1/messages";
const MESSAGE_RESOURCE_PATH = "/open-apis/im/v1/messages";

const TOKEN_REFRESH_BUFFER_MS = 60_000;
const WS_READY_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_INBOUND_ATTACHMENT_BYTES = 200 * 1024 * 1024;

// ─── Internal Types ───

interface LarkAccessToken {
  tenantAccessToken: string;
  expiresAt: number;
}

interface LarkConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  useFeishu: boolean;
  allowedUsers?: string[];
  allowedChats?: string[];
  receiveMode: "websocket" | "webhook";
  setupActivatedAt?: string;
}

export interface LarkChannelDeps {
  webhookRelay?: LarkWebhookRelayService;
}

type LarkMessageResourceType = "image" | "file";

interface ParsedLarkResourceRef {
  key: string;
  resourceType: LarkMessageResourceType;
  kind: FridayChannelAttachmentKind;
  filename?: string;
  messageType?: string;
}

interface ParsedLarkMessageContent {
  text: string;
  resourceRefs: ParsedLarkResourceRef[];
}

interface ParsedLarkMessageEvent {
  message: FridayChannelMessage;
  resourceRefs: ParsedLarkResourceRef[];
}

interface LarkApprovalCardInput {
  shortId: string;
  toolName: string;
  reason: string;
  expiresAt: string;
  paramsPreview?: string;
  chatType?: "direct" | "group";
}

// ─── Factory ───

export function createFridayLarkChannel(deps: LarkChannelDeps = {}): FridayChannelPlugin {
  let config: LarkConfig | null = null;
  let token: LarkAccessToken | null = null;
  let wsClient: LarkWsClient | null = null;
  let connectionStatus: FridayChannelStatus = "disconnected";
  let lastConnectionError: string | undefined;
  let stopped = false;
  const webhookRelay = deps.webhookRelay;

  function apiBase(): string {
    return config!.useFeishu ? FEISHU_API_BASE : LARK_API_BASE;
  }

  async function refreshToken(): Promise<void> {
    const response = await fetch(`${apiBase()}${TOKEN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: config!.appId,
        app_secret: config!.appSecret,
      }),
    });

    if (!response.ok) {
      throw new FridayDomainError("INTERNAL_ERROR", `Lark token refresh failed: ${response.status} ${response.statusText}`, { httpStatus: 500 });
    }

    const data = (await response.json()) as {
      code: number;
      msg: string;
      tenant_access_token: string;
      expire: number;
    };

    if (data.code !== 0) {
      throw new FridayDomainError("INTERNAL_ERROR", `Lark token refresh error: ${data.code} ${data.msg}`, { httpStatus: 500 });
    }

    token = {
      tenantAccessToken: data.tenant_access_token,
      expiresAt: Date.now() + data.expire * 1000 - TOKEN_REFRESH_BUFFER_MS,
    };
  }

  async function ensureToken(): Promise<string> {
    if (!token || Date.now() >= token.expiresAt) {
      await refreshToken();
    }
    return token!.tenantAccessToken;
  }

  function inferResourceKind(messageType: string | undefined, sourceKey: "image_key" | "file_key"): FridayChannelAttachmentKind {
    if (sourceKey === "image_key") return "image";
    switch ((messageType ?? "").toLowerCase()) {
      case "audio":
        return "audio";
      case "video":
      case "media":
        return "video";
      default:
        return "file";
    }
  }

  function maybeString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  }

  function addResourceRef(
    refs: Map<string, ParsedLarkResourceRef>,
    input: ParsedLarkResourceRef,
  ): void {
    const id = `${input.resourceType}:${input.key}`;
    const existing = refs.get(id);
    refs.set(id, {
      ...existing,
      ...input,
      filename: input.filename ?? existing?.filename,
      messageType: input.messageType ?? existing?.messageType,
    });
  }

  function collectPostContent(
    value: unknown,
    refs: Map<string, ParsedLarkResourceRef>,
    textParts: string[],
    messageType?: string,
    depth = 0,
  ): void {
    if (depth > 12 || value === null || value === undefined) return;
    if (typeof value === "string") return;
    if (Array.isArray(value)) {
      for (const item of value) collectPostContent(item, refs, textParts, messageType, depth + 1);
      return;
    }
    if (typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    const tag = maybeString(record.tag)?.toLowerCase();
    const filename = maybeString(record.file_name) ?? maybeString(record.name);
    const text = maybeString(record.text);
    if (text) textParts.push(text);

    const imageKey = maybeString(record.image_key);
    if (imageKey) {
      addResourceRef(refs, {
        key: imageKey,
        resourceType: "image",
        kind: "image",
        ...(filename ? { filename } : {}),
        ...(messageType ? { messageType } : {}),
      });
    }

    const fileKey = maybeString(record.file_key);
    if (fileKey) {
      const kind: FridayChannelAttachmentKind =
        tag === "audio" ? "audio"
          : tag === "media" || tag === "video" ? "video"
            : inferResourceKind(messageType, "file_key");
      addResourceRef(refs, {
        key: fileKey,
        resourceType: "file",
        kind,
        ...(filename ? { filename } : {}),
        ...(messageType ? { messageType } : {}),
      });
    }

    for (const child of Object.values(record)) {
      collectPostContent(child, refs, textParts, messageType, depth + 1);
    }
  }

  function parseMessageContent(content: string | undefined, messageType?: string): ParsedLarkMessageContent {
    if (!content) return { text: "", resourceRefs: [] };

    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const refs = new Map<string, ParsedLarkResourceRef>();
      const textParts: string[] = [];
      const directText = maybeString(parsed.text);
      if (directText) textParts.push(directText);
      const title = maybeString(parsed.title);
      if (title) textParts.push(title);

      const directFilename = maybeString(parsed.file_name) ?? maybeString(parsed.name);
      const imageKey = maybeString(parsed.image_key);
      if (imageKey) {
        addResourceRef(refs, {
          key: imageKey,
          resourceType: "image",
          kind: "image",
          ...(directFilename ? { filename: directFilename } : {}),
          ...(messageType ? { messageType } : {}),
        });
      }
      const fileKey = maybeString(parsed.file_key);
      if (fileKey) {
        addResourceRef(refs, {
          key: fileKey,
          resourceType: "file",
          kind: inferResourceKind(messageType, "file_key"),
          ...(directFilename ? { filename: directFilename } : {}),
          ...(messageType ? { messageType } : {}),
        });
      }

      if (parsed.post) {
        collectPostContent(parsed.post, refs, textParts, messageType);
      }

      return {
        text: textParts.join("\n").trim() || (refs.size > 0 ? "" : content),
        resourceRefs: [...refs.values()],
      };
    } catch (err) {
      console.warn("[friday][lark-channel] operation failed:", err instanceof Error ? err.message : String(err));
      return { text: content, resourceRefs: [] };
    }
  }

  function headerValue(headers: Headers, name: string): string | undefined {
    return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
  }

  function resolveImageMimeType(headers: Headers): string {
    const contentType = headerValue(headers, "content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType?.startsWith("image/")) return contentType;
    return "image/png";
  }

  function resolveAttachmentContentType(headers: Headers, kind: FridayChannelAttachmentKind): string {
    const contentType = headerValue(headers, "content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType && contentType !== "application/octet-stream") return contentType;
    if (kind === "image") return resolveImageMimeType(headers);
    if (kind === "audio") return "audio/mpeg";
    if (kind === "video") return "video/mp4";
    return "application/octet-stream";
  }

  function extensionForContentType(contentType: string, kind: FridayChannelAttachmentKind): string {
    const normalized = contentType.toLowerCase();
    if (normalized === "image/png") return ".png";
    if (normalized === "image/jpeg") return ".jpg";
    if (normalized === "image/gif") return ".gif";
    if (normalized === "image/webp") return ".webp";
    if (normalized === "image/svg+xml") return ".svg";
    if (normalized === "application/pdf") return ".pdf";
    if (normalized === "audio/mpeg") return ".mp3";
    if (normalized === "audio/wav") return ".wav";
    if (normalized === "video/mp4") return ".mp4";
    if (kind === "image") return ".png";
    if (kind === "audio") return ".audio";
    if (kind === "video") return ".video";
    return ".bin";
  }

  function safeFilename(input: string): string {
    return input
      .replace(/[/\\?%*:|"<>]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || "attachment";
  }

  function attachmentRootDir(): string {
    const configured = process.env.FRIDAY_CHANNEL_ATTACHMENT_DIR?.trim();
    return configured && configured.length > 0
      ? configured
      : path.join(os.tmpdir(), "friday-channel-attachments");
  }

  function maxInboundAttachmentBytes(): number {
    const raw = process.env.FRIDAY_CHANNEL_MAX_ATTACHMENT_BYTES?.trim();
    if (!raw) return DEFAULT_MAX_INBOUND_ATTACHMENT_BYTES;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return Number.POSITIVE_INFINITY;
    return parsed;
  }

  function failedAttachment(messageId: string, ref: ParsedLarkResourceRef, error: string): FridayChannelAttachment {
    return {
      id: `feishu:${messageId}:${ref.resourceType}:${ref.key}`,
      kind: ref.kind,
      ...(ref.filename ? { filename: ref.filename } : {}),
      status: "failed",
      error,
      platform: {
        channelKind: config!.useFeishu ? "feishu" : "lark",
        messageId,
        resourceKey: ref.key,
        resourceType: ref.resourceType,
        ...(ref.messageType ? { messageType: ref.messageType } : {}),
      },
    };
  }

  async function saveAttachmentBytes(input: {
    messageId: string;
    ref: ParsedLarkResourceRef;
    contentType: string;
    bytes: Buffer;
  }): Promise<string> {
    const digest = createHash("sha256")
      .update(input.messageId)
      .update(":")
      .update(input.ref.key)
      .update(input.bytes)
      .digest("hex")
      .slice(0, 16);
    const extFromContent = extensionForContentType(input.contentType, input.ref.kind);
    const originalName = input.ref.filename ? safeFilename(input.ref.filename) : "";
    const extension = path.extname(originalName) || extFromContent;
    const basename = originalName
      ? safeFilename(originalName.slice(0, Math.max(1, originalName.length - path.extname(originalName).length)))
      : `${input.messageId}-${input.ref.key.slice(0, 24)}`;
    const dir = path.join(attachmentRootDir(), config!.useFeishu ? "feishu" : "lark");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${safeFilename(basename)}-${digest}${extension}`);
    await fs.writeFile(filePath, input.bytes);
    return filePath;
  }

  async function downloadMessageResource(messageId: string, ref: ParsedLarkResourceRef): Promise<FridayChannelAttachment> {
    const accessToken = await ensureToken();
    const url = new URL(
      `${apiBase()}${MESSAGE_RESOURCE_PATH}/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(ref.key)}`,
    );
    url.searchParams.set("type", ref.resourceType);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.warn(
        `[friday][lark-channel] resource download failed: ${response.status} ${response.statusText} ${errorText}`.trim(),
      );
      return failedAttachment(messageId, ref, `Lark/Feishu resource download failed: ${response.status} ${response.statusText}`);
    }

    const contentType = headerValue(response.headers, "content-type");
    if (contentType?.includes("application/json")) {
      const errorText = await response.text().catch(() => "");
      console.warn(`[friday][lark-channel] resource download returned JSON instead of bytes: ${errorText}`);
      return failedAttachment(messageId, ref, `Lark/Feishu resource download returned JSON: ${errorText.slice(0, 240)}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      console.warn("[friday][lark-channel] resource download returned an empty body");
      return failedAttachment(messageId, ref, "Lark/Feishu resource download returned an empty body");
    }
    const maxBytes = maxInboundAttachmentBytes();
    if (bytes.length > maxBytes) {
      console.warn(`[friday][lark-channel] resource download exceeded ${String(maxBytes)} bytes`);
      return failedAttachment(messageId, ref, `Lark/Feishu resource exceeded maximum size (${String(maxBytes)} bytes)`);
    }

    const resolvedContentType = resolveAttachmentContentType(response.headers, ref.kind);
    const localPath = await saveAttachmentBytes({
      messageId,
      ref,
      contentType: resolvedContentType,
      bytes,
    });

    return {
      id: `feishu:${messageId}:${ref.resourceType}:${ref.key}`,
      kind: ref.kind,
      filename: path.basename(localPath),
      contentType: resolvedContentType,
      sizeBytes: bytes.length,
      localPath,
      status: "resolved",
      platform: {
        channelKind: config!.useFeishu ? "feishu" : "lark",
        messageId,
        resourceKey: ref.key,
        resourceType: ref.resourceType,
        ...(ref.messageType ? { messageType: ref.messageType } : {}),
      },
    };
  }

  async function downloadMessageResources(messageId: string, refs: ParsedLarkResourceRef[]): Promise<FridayChannelAttachment[]> {
    const unique = new Map<string, ParsedLarkResourceRef>();
    for (const ref of refs) {
      if (ref.key.trim().length === 0) continue;
      unique.set(`${ref.resourceType}:${ref.key}`, ref);
    }
    return Promise.all([...unique.values()].map((ref) => downloadMessageResource(messageId, ref)));
  }

  function resolvedImagePaths(attachments: FridayChannelAttachment[]): string[] {
    return attachments
      .filter((attachment) => attachment.kind === "image" && attachment.status === "resolved")
      .map((attachment) => attachment.localPath ?? attachment.sourceUrl ?? "")
      .filter((image) => image.length > 0);
  }

  function withAttachmentDownloadFailurePrompt(message: FridayChannelMessage, attachments: FridayChannelAttachment[]): FridayChannelMessage {
    if (message.text.trim().length > 0) return message;
    const failed = attachments.filter((attachment) => attachment.status === "failed");
    const kindList = failed.length > 0
      ? failed.map((attachment) => attachment.kind).join(", ")
      : "media";
    return {
      ...message,
      text:
        `The user sent ${kindList} in Lark/Feishu, but Friday could not download the resource bytes. ` +
        "Explain that the resource could not be read and ask the user to retry or check the bot's message resource permissions.",
      attachments,
    };
  }

  function parseCardApprovalActionEvent(event: Record<string, unknown>): FridayChannelMessage | null {
    const header = event.header as Record<string, unknown> | undefined;
    const eventType =
      maybeString(header?.event_type) ??
      maybeString(event.eventType) ??
      maybeString(event.event_type);
    const eventData = (event.event as Record<string, unknown> | undefined) ?? event;
    const action = eventData.action as Record<string, unknown> | undefined;
    const value = action?.value as Record<string, unknown> | undefined;
    const fridayAction = maybeString(value?.friday_action);

    if (eventType && eventType !== "card.action.trigger") return null;
    if (fridayAction !== "tool_approval") return null;

    const decision = maybeString(value?.decision);
    const shortId = maybeString(value?.short_id);
    if ((decision !== "approve" && decision !== "reject") || !shortId) return null;

    const context = eventData.context as Record<string, unknown> | undefined;
    const operator = eventData.operator as Record<string, unknown> | undefined;
    const chatId =
      maybeString(context?.open_chat_id) ??
      maybeString(eventData.open_chat_id) ??
      maybeString(value?.chat_id);
    const messageId =
      maybeString(context?.open_message_id) ??
      maybeString(eventData.open_message_id) ??
      maybeString(value?.message_id) ??
      `card:${shortId}`;
    const senderId =
      maybeString(operator?.open_id) ??
      maybeString(operator?.user_id) ??
      maybeString(value?.sender_id);
    if (!chatId || !senderId) return null;

    const chatType = maybeString(value?.chat_type) === "direct" ? "direct" : "group";
    const reason = maybeString(value?.reason);
    const text = decision === "approve"
      ? `批准 ${shortId}`
      : `拒绝 ${shortId}${reason ? ` ${reason}` : ""}`;

    return {
      id: `card-action:${messageId}:${senderId}:${decision}:${shortId}`,
      channelKind: config!.useFeishu ? "feishu" : "lark",
      senderId,
      senderName: maybeString(operator?.name),
      chatId,
      chatType,
      text,
      replyTo: messageId,
      timestamp: Date.now(),
      raw: event,
    };
  }

  function buildApprovalCard(input: LarkApprovalCardInput): Record<string, unknown> {
    return {
      config: {
        wide_screen_mode: true,
        enable_forward: false,
      },
      header: {
        template: "orange",
        title: {
          tag: "plain_text",
          content: `Friday 敏感操作审批 ${input.shortId}`,
        },
      },
      elements: [
        {
          tag: "markdown",
          content: [
            `**工具**: ${input.toolName}`,
            `**原因**: ${input.reason}`,
            `**过期时间**: ${input.expiresAt}`,
            input.paramsPreview ? `**参数**:\n${input.paramsPreview}` : undefined,
          ].filter((line): line is string => typeof line === "string" && line.length > 0).join("\n\n"),
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              type: "primary",
              text: { tag: "plain_text", content: "批准" },
              value: {
                friday_action: "tool_approval",
                decision: "approve",
                short_id: input.shortId,
                chat_type: input.chatType ?? "group",
              },
            },
            {
              tag: "button",
              type: "danger",
              text: { tag: "plain_text", content: "拒绝" },
              value: {
                friday_action: "tool_approval",
                decision: "reject",
                short_id: input.shortId,
                chat_type: input.chatType ?? "group",
              },
            },
          ],
        },
        {
          tag: "note",
          elements: [
            {
              tag: "plain_text",
              content: `也可以直接回复“批准 ${input.shortId}”或“拒绝 ${input.shortId}”。`,
            },
          ],
        },
      ],
    };
  }

  function parseMessageEventBase(event: Record<string, unknown>): ParsedLarkMessageEvent | null {
    const eventData = (event.event as Record<string, unknown> | undefined) ?? event;

    const message = eventData.message as Record<string, unknown> | undefined;
    const sender = eventData.sender as Record<string, unknown> | undefined;

    if (!message || !sender) return null;

    const messageId = message.message_id as string | undefined;
    const chatId = message.chat_id as string | undefined;
    const chatType = message.chat_type as string | undefined;
    const content = message.content as string | undefined;
    const createTime = message.create_time as string | undefined;
    const messageType = message.message_type as string | undefined;

    const senderId =
      (sender.sender_id as Record<string, unknown>)?.open_id as string | undefined;
    const senderName =
      (sender.sender_id as Record<string, unknown>)?.name as string | undefined;

    if (!messageId || !chatId || !senderId) return null;

    // Lark content is JSON-encoded; extract text
    const parsedContent = parseMessageContent(content, messageType);

    const resourceRefs = new Map<string, ParsedLarkResourceRef>();
    for (const ref of parsedContent.resourceRefs) {
      addResourceRef(resourceRefs, ref);
    }
    const messageImageKey = maybeString(message.image_key);
    if (messageImageKey) {
      addResourceRef(resourceRefs, {
        key: messageImageKey,
        resourceType: "image",
        kind: "image",
        ...(messageType ? { messageType } : {}),
      });
    }
    const messageFileKey = maybeString(message.file_key);
    if (messageFileKey) {
      addResourceRef(resourceRefs, {
        key: messageFileKey,
        resourceType: "file",
        kind: inferResourceKind(messageType, "file_key"),
        ...(messageType ? { messageType } : {}),
      });
    }
    const resourceRefList = [...resourceRefs.values()];

    return {
      resourceRefs: resourceRefList,
      message: {
        id: messageId,
        channelKind: config!.useFeishu ? "feishu" : "lark",
        senderId,
        senderName: senderName ?? undefined,
        chatId,
        chatType: chatType === "p2p" ? "direct" : "group",
        text: parsedContent.text,
        replyTo: (message.parent_id as string) ?? undefined,
        timestamp: createTime ? parseInt(createTime, 10) : Date.now(),
        raw: event,
      },
    };
  }

  function parseMessageEvent(event: Record<string, unknown>): FridayChannelMessage | null {
    return parseCardApprovalActionEvent(event) ?? parseMessageEventBase(event)?.message ?? null;
  }

  async function parseMessageEventWithResources(event: Record<string, unknown>): Promise<FridayChannelMessage | null> {
    const cardAction = parseCardApprovalActionEvent(event);
    if (cardAction) return cardAction;

    const parsed = parseMessageEventBase(event);
    if (!parsed) return null;
    if (parsed.resourceRefs.length === 0) return parsed.message;

    const attachments = await downloadMessageResources(parsed.message.id, parsed.resourceRefs);
    const images = resolvedImagePaths(attachments);
    if (attachments.length > 0 && attachments.every((attachment) => attachment.status !== "resolved")) {
      return withAttachmentDownloadFailurePrompt(parsed.message, attachments);
    }
    return {
      ...parsed.message,
      attachments,
      images: images.length > 0 ? images : undefined,
    };
  }

  async function connectWebSocketWithSdk(eventHandler: (rawEvent: unknown) => void): Promise<void> {
    if (!config) throw new FridayDomainError("NOT_INITIALIZED", "Lark channel not initialized", { httpStatus: 503 });
    const larkConfig = config;

    connectionStatus = "connecting";
    lastConnectionError = undefined;

    const readyTimeoutMs = Math.max(
      1_000,
      Number.parseInt(process.env.FRIDAY_LARK_WS_READY_TIMEOUT_MS ?? String(WS_READY_TIMEOUT_MS), 10) || WS_READY_TIMEOUT_MS,
    );

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const fail = (message: string): void => {
        connectionStatus = "error";
        lastConnectionError = message;
        wsClient?.close({ force: true });
        wsClient = null;
        settle(() => reject(new FridayDomainError("INTERNAL_ERROR", message, { httpStatus: 500 })));
      };
      const timer = setTimeout(() => {
        fail(
          "Lark SDK WebSocket did not become ready. Check that the Feishu app uses long-connection event subscription and has im.message.receive_v1 enabled.",
        );
      }, readyTimeoutMs);

      const client = new LarkWsClient({
        appId: larkConfig.appId,
        appSecret: larkConfig.appSecret,
        domain: larkConfig.useFeishu ? LarkDomain.Feishu : LarkDomain.Lark,
        loggerLevel: "warn",
        source: "friday",
        autoReconnect: true,
        onReady: () => {
          connectionStatus = "connected";
          lastConnectionError = undefined;
          settle(resolve);
        },
        onReconnecting: () => {
          connectionStatus = "connecting";
        },
        onReconnected: () => {
          connectionStatus = "connected";
          lastConnectionError = undefined;
        },
        onError: (error: Error) => {
          fail(`Lark WebSocket failed: ${error.message}`);
        },
      });

      wsClient = client;

      // Preserve the SDK's handler-shape contract: each registered handler
      // receives the parsed (flattened) event envelope, then re-wraps it as
      // `{ event: data, ... }` so the downstream parseMessageEventBase /
      // parseCardApprovalActionEvent code paths stay unchanged.
      const eventHandlers: Record<string, LarkEventHandler> = {
        "im.message.receive_v1": async (data) => {
          eventHandler({ event: data });
        },
        "card.action.trigger": async (data) => {
          eventHandler({ event: data, eventType: "card.action.trigger" });
        },
      };

      const eventDispatcher = new LarkEventDispatcher({
        verificationToken: larkConfig.verificationToken,
        encryptKey: larkConfig.encryptKey,
        loggerLevel: "warn",
      }).register(eventHandlers);

      void client.start({ eventDispatcher }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        fail(`Lark WebSocket failed: ${message}`);
      });
    });
  }

  // ─── Adapter wrappers ───

  const inboundAdapter: FridayChannelInboundAdapter = {
    normalize(rawEvent: unknown): FridayChannelMessage | null {
      const data = rawEvent as Record<string, unknown>;
      return parseMessageEvent(data);
    },
    normalizeAsync(rawEvent: unknown): Promise<FridayChannelMessage | null> {
      const data = rawEvent as Record<string, unknown>;
      return parseMessageEventWithResources(data);
    },
  };

  const outboundAdapter: FridayChannelOutboundAdapter = {
    async send(options: FridayChannelSendOptions): Promise<{ messageId: string }> {
      return plugin.send(options);
    },
    async update(messageId: string, options: FridayChannelSendOptions): Promise<{ messageId: string }> {
      return updateSentMessage(messageId, options);
    },
  };

  const statusAdapter: FridayChannelStatusAdapter = {
    status(): FridayChannelStatus {
      if (config?.receiveMode === "webhook") {
        if (stopped) return "disconnected";
        return webhookRelay?.isListening() ? "connected" : "disconnected";
      }
      if (stopped) return "disconnected";
      return connectionStatus;
    },
    diagnostics() {
      return {
        hasToken: token !== null,
        useFeishu: config?.useFeishu ?? false,
        appId: config?.appId,
        setupActivatedAt: config?.setupActivatedAt,
        receiveMode: config?.receiveMode ?? "websocket",
        webhookListening: webhookRelay?.isListening() ?? false,
        sdkWebSocket: config?.receiveMode !== "webhook",
        lastConnectionError,
      };
    },
  };

  // ─── Lifecycle Adapter ───

  const lifecycleAdapter: FridayChannelLifecycleAdapter = {
    async connect(eventHandler: (rawEvent: unknown) => void) {
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "Lark channel not initialized", { httpStatus: 503 });
      stopped = false;
      connectionStatus = "connecting";
      lastConnectionError = undefined;

      try {
        await refreshToken();

        if (config.receiveMode === "websocket") {
          await connectWebSocketWithSdk(eventHandler);
        } else {
          if (!webhookRelay) {
            throw new FridayDomainError("VALIDATION_ERROR", "Lark webhook mode requires webhookRelay dependency", { httpStatus: 400 });
          }
          webhookRelay.setVerificationToken(config.verificationToken);
          webhookRelay.setEncryptKey(config.encryptKey);
          await webhookRelay.start((event) => {
            eventHandler(event);
          });
          connectionStatus = "connected";
        }
      } catch (error) {
        stopped = true;
        connectionStatus = "error";
        lastConnectionError = error instanceof Error ? error.message : String(error);
        if (wsClient) { try { wsClient.close({ force: true }); } catch { /* ignore */ } wsClient = null; }
        if (webhookRelay?.isListening()) {
          await webhookRelay.stop().catch(() => { /* ignore cleanup error */ });
        }
        throw error;
      }
    },
    async disconnect() {
      stopped = true;
      connectionStatus = "disconnected";
      lastConnectionError = undefined;

      if (wsClient) { wsClient.close({ force: true }); wsClient = null; }
      if (webhookRelay?.isListening()) {
        await webhookRelay.stop();
      }
    },
  };

  const adapters: FridayChannelAdapters = {
    inbound: inboundAdapter,
    outbound: outboundAdapter,
    status: statusAdapter,
    lifecycle: lifecycleAdapter,
  };

  const plugin: FridayChannelPlugin = {
    kind: "lark",
    adapters,
    contract: {
      coreAuthority: { messageRouting: true, sessionMirroring: true, audit: true, evidence: true },
      pluginResponsibilities: { config: true, auth: true, pairing: false, outboundDelivery: true, threadResolution: false, providerRetries: false },
      supports: { directMessages: true, groupMessages: true, threads: false, typing: false },
    },

    async init(rawConfig) {
      // P1-CH-001: Use Zod schema for runtime config validation
      const { FridayLarkChannelConfigSchema } = await import("./lark-config.schema.js");
      const parsed = FridayLarkChannelConfigSchema.parse({ kind: rawConfig.useFeishu ? "feishu" : "lark", ...rawConfig });
      config = {
        appId: parsed.appId,
        appSecret: parsed.appSecret,
        verificationToken: parsed.verificationToken,
        encryptKey: parsed.encryptKey,
        useFeishu: parsed.useFeishu,
        allowedUsers: parsed.allowedUsers,
        allowedChats: parsed.allowedChats,
        receiveMode: parsed.receiveMode,
        setupActivatedAt: parsed.setupActivatedAt,
      };

      // Override kind for Feishu
      if (config.useFeishu) {
        (this as { kind: string }).kind = "feishu";
      }
    },

    async start(handler) {
      if (!config) throw new FridayDomainError("NOT_INITIALIZED", "Lark channel not initialized", { httpStatus: 503 });

      // Delegate to lifecycle adapter, then wire up the message handler
      await lifecycleAdapter.connect((event) => {
        const data = event as Record<string, unknown>;
        const cardAction = parseCardApprovalActionEvent(data);
        if (cardAction) {
          handler(cardAction);
          return;
        }
        const parsed = parseMessageEventBase(data);
        if (!parsed) return;
        if (parsed.resourceRefs.length === 0) {
          handler(parsed.message);
          return;
        }
        void (async () => {
          const msg = await parseMessageEventWithResources(data);
          if (msg) handler(msg);
        })().catch((err) => {
          console.warn("[friday][lark-channel] inbound resource normalization failed:", err instanceof Error ? err.message : String(err));
          handler(withAttachmentDownloadFailurePrompt(parsed.message, []));
        });
      });
    },

    async stop() {
      await lifecycleAdapter.disconnect();
    },

    async send(options: FridayChannelSendOptions) {
      const accessToken = await ensureToken();
      const { chatId, replyTo, approval } = options;
      const text = formatFridayChannelOutboundText("lark", options.text);

      const body: Record<string, unknown> = {
        receive_id: chatId,
        msg_type: approval ? "interactive" : "text",
        content: approval
          ? JSON.stringify(buildApprovalCard(approval))
          : JSON.stringify({ text }),
      };

      if (replyTo) {
        body.reply_in_thread = false;
      }

      const url = `${apiBase()}${SEND_MESSAGE_PATH}?receive_id_type=chat_id`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new FridayDomainError("INTERNAL_ERROR", `Lark send failed: ${response.status} ${errorText}`, { httpStatus: 500 });
      }

      const result = (await response.json()) as {
        code: number;
        data?: { message_id?: string };
      };

      if (result.code !== 0) {
        throw new FridayDomainError("INTERNAL_ERROR", `Lark send error: code ${result.code}`, { httpStatus: 500 });
      }

      return { messageId: result.data?.message_id ?? "" };
    },
  };

  async function updateSentMessage(
    messageId: string,
    options: FridayChannelSendOptions,
  ): Promise<{ messageId: string }> {
    const accessToken = await ensureToken();
    const { approval } = options;
    const text = formatFridayChannelOutboundText("lark", options.text);
    const body: Record<string, unknown> = {
      msg_type: approval ? "interactive" : "text",
      content: approval
        ? JSON.stringify(buildApprovalCard(approval))
        : JSON.stringify({ text }),
    };

    const response = await fetch(
      `${apiBase()}${MESSAGE_RESOURCE_PATH}/${encodeURIComponent(messageId)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new FridayDomainError("INTERNAL_ERROR", `Lark update failed: ${response.status} ${errorText}`, { httpStatus: 500 });
    }

    const result = (await response.json()) as {
      code: number;
      data?: { message_id?: string };
    };

    if (result.code !== 0) {
      throw new FridayDomainError("INTERNAL_ERROR", `Lark update error: code ${result.code}`, { httpStatus: 500 });
    }

    return { messageId: result.data?.message_id ?? messageId };
  }

  return plugin;
}
