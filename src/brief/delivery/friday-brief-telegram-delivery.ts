import * as fs from "node:fs";

import type { FridayBriefChannelsConfig } from "../friday-brief-config.types.js";
import type {
  FridayBriefDeliveryClient,
  FridayBriefDeliveryPayload,
  FridayBriefDeliveryResult,
} from "./friday-brief-delivery.types.js";

export interface FridayBriefTelegramDeliveryDeps {
  getConfig: () => FridayBriefChannelsConfig;
  resolveSecret: (refKey: string | undefined) => string | undefined;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

interface TelegramSendResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
  error_code?: number;
}

export function createFridayBriefTelegramDelivery(
  deps: FridayBriefTelegramDeliveryDeps,
): FridayBriefDeliveryClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const apiBase = deps.apiBase ?? "https://api.telegram.org";

  function buildMultipart(
    fields: Record<string, string>,
    file: { fieldName: string; filename: string; contentType: string; data: Buffer },
  ): { body: Buffer; contentType: string } {
    const boundary = `--friday-${Math.random().toString(16).slice(2)}`;
    const parts: Buffer[] = [];
    for (const [name, value] of Object.entries(fields)) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
          "utf8",
        ),
      );
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
        "utf8",
      ),
    );
    parts.push(file.data);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
    return {
      body: Buffer.concat(parts),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  async function callTelegramMultipart(
    token: string,
    method: string,
    fields: Record<string, string>,
    file: { fieldName: string; filename: string; contentType: string; data: Buffer },
    signal: AbortSignal,
  ): Promise<number> {
    const { body, contentType } = buildMultipart(fields, file);
    const response = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
      signal,
    });
    if (!response.ok) throw new Error(`telegram_http_${String(response.status)}`);
    const parsed = (await response.json()) as TelegramSendResponse;
    if (!parsed.ok || !parsed.result) {
      throw new Error(`telegram_errcode_${String(parsed.error_code ?? 0)}:${parsed.description ?? ""}`);
    }
    return parsed.result.message_id;
  }

  async function callTelegramJson(
    token: string,
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(`telegram_http_${String(response.status)}`);
    const parsed = (await response.json()) as TelegramSendResponse;
    if (!parsed.ok) {
      throw new Error(`telegram_errcode_${String(parsed.error_code ?? 0)}:${parsed.description ?? ""}`);
    }
  }

  return {
    kind: "telegram",
    isConfigured(): boolean {
      const cfg = deps.getConfig().telegram;
      if (!cfg.enabled) return false;
      if (!cfg.chatId) return false;
      const token = deps.resolveSecret(cfg.botTokenRefKey);
      return typeof token === "string" && token.length > 0;
    },
    async deliver(
      payload: FridayBriefDeliveryPayload,
      signal: AbortSignal,
    ): Promise<FridayBriefDeliveryResult> {
      const cfg = deps.getConfig().telegram;
      if (!cfg.chatId) throw new Error("telegram_chat_id_missing");
      const token = deps.resolveSecret(cfg.botTokenRefKey);
      if (!token) throw new Error("telegram_token_missing");

      const audioData = fs.readFileSync(payload.audio.filePath);
      const caption = payload.includeTranscript ? payload.transcript.slice(0, 1024) : undefined;
      const fields: Record<string, string> = {
        chat_id: cfg.chatId,
      };
      if (caption) fields["caption"] = caption;
      if (payload.audio.durationSec) fields["duration"] = String(Math.round(payload.audio.durationSec));

      const messageId = await callTelegramMultipart(
        token,
        "sendAudio",
        fields,
        {
          fieldName: "audio",
          filename: `${payload.runId}.${payload.audio.format}`,
          contentType: payload.audio.mimeType,
          data: audioData,
        },
        signal,
      );

      if (payload.includeTranscript && payload.transcript.length > 1024) {
        await callTelegramJson(
          token,
          "sendMessage",
          { chat_id: cfg.chatId, text: payload.transcript },
          signal,
        );
      }

      return { messageId: String(messageId) };
    },
  };
}
