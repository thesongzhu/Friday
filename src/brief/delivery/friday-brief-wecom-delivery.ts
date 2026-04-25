import * as fs from "node:fs";
import * as path from "node:path";

import type { FridayBriefChannelsConfig } from "../friday-brief-config.types.js";
import type {
  FridayBriefDeliveryClient,
  FridayBriefDeliveryPayload,
  FridayBriefDeliveryResult,
} from "./friday-brief-delivery.types.js";

export interface FridayBriefWeComDeliveryDeps {
  getConfig: () => FridayBriefChannelsConfig;
  resolveSecret: (refKey: string | undefined) => string | undefined;
  fetchImpl?: typeof fetch;
  /** Optional override of the WeCom API base — test hook. */
  apiBase?: string;
  /** Audio converter: mp3 buffer → amr buffer (WeCom requires amr for voice).
   *  When not provided, voice upload is skipped and audio is sent as file. */
  mp3ToAmr?: (mp3: Buffer, signal: AbortSignal) => Promise<Buffer>;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

function isoSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`wecom_invalid_json:${text.slice(0, 240)}`);
  }
}

interface WeComTokenResponse {
  errcode: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
}

interface WeComMediaUploadResponse {
  errcode: number;
  errmsg?: string;
  type?: string;
  media_id?: string;
  created_at?: string;
}

interface WeComMessageSendResponse {
  errcode: number;
  errmsg?: string;
  msgid?: string;
}

export function createFridayBriefWeComDelivery(
  deps: FridayBriefWeComDeliveryDeps,
): FridayBriefDeliveryClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const apiBase = deps.apiBase ?? "https://qyapi.weixin.qq.com";
  let cachedToken: CachedToken | null = null;

  async function fetchAccessToken(signal: AbortSignal): Promise<string> {
    const cfg = deps.getConfig().wecom;
    if (!cfg.corpId) throw new Error("wecom_corp_id_missing");
    const secret = deps.resolveSecret(cfg.secretRefKey);
    if (!secret) throw new Error("wecom_secret_missing");

    if (cachedToken && cachedToken.expiresAt > isoSeconds() + 60) {
      return cachedToken.token;
    }
    const url = `${apiBase}/cgi-bin/gettoken?corpid=${encodeURIComponent(
      cfg.corpId,
    )}&corpsecret=${encodeURIComponent(secret)}`;
    const response = await fetchImpl(url, { method: "GET", signal });
    if (!response.ok) throw new Error(`wecom_token_http_${String(response.status)}`);
    const body = await readJson<WeComTokenResponse>(response);
    if (body.errcode !== 0 || !body.access_token) {
      throw new Error(`wecom_token_errcode_${String(body.errcode)}:${body.errmsg ?? ""}`);
    }
    cachedToken = {
      token: body.access_token,
      expiresAt: isoSeconds() + (body.expires_in ?? 7200),
    };
    return cachedToken.token;
  }

  async function uploadMedia(
    token: string,
    type: "voice" | "file",
    filePath: string,
    filename: string,
    contentType: string,
    signal: AbortSignal,
  ): Promise<string> {
    const data = fs.readFileSync(filePath);
    const boundary = `--friday-${Math.random().toString(16).slice(2)}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
      "utf8",
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const body = Buffer.concat([head, data, tail]);

    const response = await fetchImpl(
      `${apiBase}/cgi-bin/media/upload?access_token=${encodeURIComponent(token)}&type=${type}`,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body,
        signal,
      },
    );
    if (!response.ok) throw new Error(`wecom_upload_http_${String(response.status)}`);
    const parsed = await readJson<WeComMediaUploadResponse>(response);
    if (parsed.errcode !== 0 || !parsed.media_id) {
      throw new Error(`wecom_upload_errcode_${String(parsed.errcode)}:${parsed.errmsg ?? ""}`);
    }
    return parsed.media_id;
  }

  async function sendMessage(
    token: string,
    message: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await fetchImpl(
      `${apiBase}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
        signal,
      },
    );
    if (!response.ok) throw new Error(`wecom_send_http_${String(response.status)}`);
    const parsed = await readJson<WeComMessageSendResponse>(response);
    if (parsed.errcode !== 0) {
      throw new Error(`wecom_send_errcode_${String(parsed.errcode)}:${parsed.errmsg ?? ""}`);
    }
    return parsed.msgid ?? "";
  }

  return {
    kind: "wecom",
    isConfigured(): boolean {
      const cfg = deps.getConfig().wecom;
      if (!cfg.enabled) return false;
      if (!cfg.corpId || !cfg.agentId) return false;
      const secret = deps.resolveSecret(cfg.secretRefKey);
      return typeof secret === "string" && secret.length > 0;
    },
    async deliver(
      payload: FridayBriefDeliveryPayload,
      signal: AbortSignal,
    ): Promise<FridayBriefDeliveryResult> {
      const cfg = deps.getConfig().wecom;
      if (!cfg.agentId) throw new Error("wecom_agent_id_missing");
      const agentIdNumber = Number(cfg.agentId);
      if (!Number.isFinite(agentIdNumber)) throw new Error("wecom_agent_id_invalid");

      const token = await fetchAccessToken(signal);

      // Convert mp3 → amr when converter available; WeCom voice requires amr.
      let voiceMediaId: string | null = null;
      if (deps.mp3ToAmr) {
        const amrBuffer = await deps.mp3ToAmr(
          fs.readFileSync(payload.audio.filePath),
          signal,
        );
        const amrPath = path.join(
          path.dirname(payload.audio.filePath),
          `${path.basename(payload.audio.filePath, path.extname(payload.audio.filePath))}.amr`,
        );
        fs.writeFileSync(amrPath, amrBuffer);
        try {
          voiceMediaId = await uploadMedia(
            token,
            "voice",
            amrPath,
            `${payload.runId}.amr`,
            "audio/amr",
            signal,
          );
        } finally {
          fs.rmSync(amrPath, { force: true });
        }
      }

      let messageId: string;
      if (voiceMediaId) {
        messageId = await sendMessage(
          token,
          {
            touser: cfg.toUser,
            msgtype: "voice",
            agentid: agentIdNumber,
            voice: { media_id: voiceMediaId },
          },
          signal,
        );
      } else {
        const fileMediaId = await uploadMedia(
          token,
          "file",
          payload.audio.filePath,
          `${payload.runId}.${payload.audio.format}`,
          payload.audio.mimeType,
          signal,
        );
        messageId = await sendMessage(
          token,
          {
            touser: cfg.toUser,
            msgtype: "file",
            agentid: agentIdNumber,
            file: { media_id: fileMediaId },
          },
          signal,
        );
      }

      if (payload.includeTranscript) {
        await sendMessage(
          token,
          {
            touser: cfg.toUser,
            msgtype: "text",
            agentid: agentIdNumber,
            text: { content: payload.transcript },
          },
          signal,
        );
      }

      return { messageId };
    },
  };
}
