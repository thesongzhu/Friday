import * as fs from "node:fs";

import type { FridayBriefChannelsConfig } from "../friday-brief-config.types.js";
import type {
  FridayBriefDeliveryClient,
  FridayBriefDeliveryPayload,
  FridayBriefDeliveryResult,
} from "./friday-brief-delivery.types.js";
import { sendFridayBriefEmail } from "./friday-brief-smtp-client.js";

export interface FridayBriefEmailDeliveryDeps {
  getConfig: () => FridayBriefChannelsConfig;
  resolveSecret: (refKey: string | undefined) => string | undefined;
  /** Test seam — override the actual SMTP send for unit tests. */
  smtpSend?: typeof sendFridayBriefEmail;
  nowIso?: () => string;
}

function encodeHeaderValue(value: string): string {
  // RFC 2047 Q-encoding — a crude but safe approximation for unicode headers.
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
}

function chunkBase64(data: Buffer, lineLength = 76): string {
  const b64 = data.toString("base64");
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += lineLength) {
    out.push(b64.slice(i, i + lineLength));
  }
  return out.join("\r\n");
}

function buildMessageId(now: Date, fromDomain: string): string {
  return `<${now.getTime().toString(16)}-${Math.random().toString(16).slice(2)}@${fromDomain}>`;
}

export function createFridayBriefEmailDelivery(
  deps: FridayBriefEmailDeliveryDeps,
): FridayBriefDeliveryClient {
  const smtpSend = deps.smtpSend ?? sendFridayBriefEmail;

  return {
    kind: "email",
    isConfigured(): boolean {
      const cfg = deps.getConfig().email;
      if (!cfg.enabled) return false;
      if (!cfg.host || !cfg.username || !cfg.fromAddress || !cfg.toAddress) return false;
      const password = deps.resolveSecret(cfg.passwordRefKey);
      return typeof password === "string" && password.length > 0; // pragma: allowlist secret
    },
    async deliver(
      payload: FridayBriefDeliveryPayload,
      signal: AbortSignal,
    ): Promise<FridayBriefDeliveryResult> {
      const cfg = deps.getConfig().email;
      if (!cfg.host) throw new Error("email_host_missing");
      if (!cfg.username) throw new Error("email_username_missing");
      if (!cfg.fromAddress) throw new Error("email_from_missing");
      if (!cfg.toAddress) throw new Error("email_to_missing");
      const password = deps.resolveSecret(cfg.passwordRefKey);
      if (!password) throw new Error("email_password_missing");

      const now = new Date();
      const fromDomain = cfg.fromAddress.split("@")[1] ?? "friday.local";
      const messageId = buildMessageId(now, fromDomain);
      const boundary = `friday-${Math.random().toString(16).slice(2)}`;
      const subject = encodeHeaderValue(`Friday Daily Brief — ${now.toISOString().slice(0, 10)}`);
      const fromHeader = `${encodeHeaderValue(cfg.fromName)} <${cfg.fromAddress}>`;

      const audioData = fs.readFileSync(payload.audio.filePath);
      const audioBase64 = chunkBase64(audioData);
      const audioFilename = `friday-brief-${payload.runId}.${payload.audio.format}`;
      const transcriptHtml = payload.includeTranscript
        ? `<pre style="font-family:ui-monospace,monospace;white-space:pre-wrap;">${payload.transcript
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")}</pre>`
        : '<p style="color:#666;">Audio attached above.</p>';
      const bodyHtml = `<html><body><h2>Friday Daily Brief</h2>${transcriptHtml}</body></html>`;
      const bodyText = payload.includeTranscript
        ? payload.transcript
        : "Friday Daily Brief — audio attached.";

      const headers = [
        `From: ${fromHeader}`,
        `To: ${cfg.toAddress}`,
        `Subject: ${subject}`,
        `Date: ${now.toUTCString()}`,
        `Message-ID: ${messageId}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ].join("\r\n");

      const parts = [
        `--${boundary}`,
        "Content-Type: multipart/alternative; boundary=\"" + boundary + "-alt\"",
        "",
        `--${boundary}-alt`,
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        bodyText,
        "",
        `--${boundary}-alt`,
        "Content-Type: text/html; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        bodyHtml,
        "",
        `--${boundary}-alt--`,
        "",
        `--${boundary}`,
        `Content-Type: ${payload.audio.mimeType}; name="${audioFilename}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${audioFilename}"`,
        "",
        audioBase64,
        "",
        `--${boundary}--`,
        "",
      ].join("\r\n");

      const message = `${headers}\r\n\r\n${parts}`;

      await smtpSend(
        {
          host: cfg.host,
          port: cfg.port,
          secure: cfg.secure,
          username: cfg.username,
          password,
          from: cfg.fromAddress,
          to: cfg.toAddress,
          message,
        },
        signal,
      );

      return { messageId };
    },
  };
}
