import type { FridaySupportedChannelKind } from "./friday-channel-config.js";
import { buildFridaySecretRef, parseFridaySecretInput } from "../security/friday-secret-ref.js";

export const FRIDAY_CHANNEL_SECRET_SCOPE = "channel"; // pragma: allowlist secret
export const FRIDAY_CHANNEL_SECRET_REF_PREFIX = "secret://channel/"; // pragma: allowlist secret

export interface FridayChannelCapabilityEntry {
  kind: FridaySupportedChannelKind;
  supportsInbound: boolean;
  supportsOutbound: boolean;
  supportsTyping: boolean;
  supportsDirectMessages: boolean;
  supportsGroupMessages: boolean;
}

export interface FridayChannelSecretFieldDescriptor {
  field: string;
  required: boolean;
  reason?: string;
}

export type FridayChannelSecretPolicy = "strict" | "compat"; // pragma: allowlist secret

const CAPABILITY_MATRIX: Record<FridaySupportedChannelKind, FridayChannelCapabilityEntry> = {
  qq: {
    kind: "qq",
    supportsInbound: true,
    supportsOutbound: true,
    supportsTyping: false,
    supportsDirectMessages: true,
    supportsGroupMessages: true,
  },
  lark: {
    kind: "lark",
    supportsInbound: true,
    supportsOutbound: true,
    supportsTyping: false,
    supportsDirectMessages: true,
    supportsGroupMessages: true,
  },
  feishu: {
    kind: "feishu",
    supportsInbound: true,
    supportsOutbound: true,
    supportsTyping: false,
    supportsDirectMessages: true,
    supportsGroupMessages: true,
  },
  discord: {
    kind: "discord",
    supportsInbound: true,
    supportsOutbound: true,
    supportsTyping: true,
    supportsDirectMessages: true,
    supportsGroupMessages: true,
  },
  telegram: {
    kind: "telegram",
    supportsInbound: true,
    supportsOutbound: true,
    supportsTyping: false,
    supportsDirectMessages: true,
    supportsGroupMessages: true,
  },
  whatsapp: {
    kind: "whatsapp",
    supportsInbound: true,
    supportsOutbound: true,
    supportsTyping: false,
    supportsDirectMessages: true,
    supportsGroupMessages: false,
  },
  signal: {
    kind: "signal",
    supportsInbound: true,
    supportsOutbound: true,
    supportsTyping: false,
    supportsDirectMessages: true,
    supportsGroupMessages: true,
  },
  slack: {
    kind: "slack",
    supportsInbound: true,
    supportsOutbound: true,
    supportsTyping: false,
    supportsDirectMessages: true,
    supportsGroupMessages: true,
  },
  webchat: {
    kind: "webchat",
    supportsInbound: true,
    supportsOutbound: true,
    supportsTyping: false,
    supportsDirectMessages: true,
    supportsGroupMessages: true,
  },
  irc: {
    kind: "irc",
    supportsInbound: true,
    supportsOutbound: true,
    supportsTyping: false,
    supportsDirectMessages: false,
    supportsGroupMessages: true,
  },
  line: {
    kind: "line",
    supportsInbound: true,
    supportsOutbound: true,
    supportsTyping: false,
    supportsDirectMessages: true,
    supportsGroupMessages: true,
  },
};

export const FRIDAY_CHANNEL_CAPABILITY_MATRIX: Readonly<Record<FridaySupportedChannelKind, FridayChannelCapabilityEntry>> =
  CAPABILITY_MATRIX;

export function getFridayChannelCapabilityEntry(
  kind: FridaySupportedChannelKind,
): FridayChannelCapabilityEntry {
  return CAPABILITY_MATRIX[kind];
}

export function resolveFridayChannelSecretPolicy(
  raw: string | undefined,
): FridayChannelSecretPolicy {
  if (raw?.trim().toLowerCase() === "compat") {
    return "compat";
  }
  return "strict";
}

export function isFridayEnvSecretRef(raw: string): boolean {
  return parseFridayEnvSecretRef(raw) !== null;
}

export function parseFridayEnvSecretRef(raw: string): string | null {
  const parsed = parseFridaySecretInput(raw, {
    secretRefPrefixes: [FRIDAY_CHANNEL_SECRET_REF_PREFIX, "secret://"],
  });
  return parsed.kind === "env-ref" ? parsed.envVar : null;
}

export function buildFridayChannelSecretRef(refKey: string): string {
  return `${FRIDAY_CHANNEL_SECRET_REF_PREFIX}${encodeURIComponent(refKey)}`;
}

export function parseFridayChannelSecretRef(raw: string): string | null {
  const parsed = parseFridaySecretInput(raw, {
    secretRefPrefixes: [FRIDAY_CHANNEL_SECRET_REF_PREFIX, "secret://"],
  });
  return parsed.kind === "secret-ref" ? parsed.refKey : null;
}

export function buildFridayGenericChannelSecretRef(refKey: string): string {
  return buildFridaySecretRef(refKey);
}

export function buildFridayChannelSecretRefKey(
  kind: FridaySupportedChannelKind,
  channelSlot: number,
  field: string,
): string {
  return `channel:${kind}:${String(channelSlot)}:${field}`;
}

export function getFridayChannelSecretFieldDescriptors(
  kind: FridaySupportedChannelKind,
  config: Record<string, unknown>,
): FridayChannelSecretFieldDescriptor[] {
  switch (kind) {
    case "qq":
      return [
        { field: "appSecret", required: true },
      ];
    case "lark":
    case "feishu":
      return [
        { field: "appSecret", required: true },
      ];
    case "discord":
      return [
        { field: "token", required: true },
      ];
    case "telegram":
      return [
        { field: "botToken", required: true },
      ];
    case "whatsapp": {
      const provider = String(config.provider ?? "cloud-api").trim().toLowerCase();
      if (provider === "cloud-api") {
        return [
          { field: "accessToken", required: true },
          { field: "webhookVerifyToken", required: false },
          { field: "appSecret", required: false },
        ];
      }
      return [
        { field: "webhookVerifyToken", required: false },
      ];
    }
    case "signal":
      return [];
    case "slack": {
      const mode = String(config.mode ?? "socket").trim().toLowerCase();
      const descriptors: FridayChannelSecretFieldDescriptor[] = [
        { field: "botToken", required: true },
      ];
      if (mode === "http") {
        descriptors.push({
          field: "signingSecret",
          required: true,
          reason: "Slack HTTP mode requires signingSecret",
        });
      } else {
        descriptors.push({
          field: "appToken",
          required: false,
        });
      }
      return descriptors;
    }
    case "webchat":
      return [];
    case "irc":
      return [
        { field: "password", required: false },
      ];
    case "line":
      return [
        { field: "channelAccessToken", required: true },
        { field: "channelSecret", required: true },
      ];
  }
}
