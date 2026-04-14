import type { ChannelKind } from "@/lib/setup/types";
import type { AppLocale } from "@/lib/i18n/localized-text";

// ─── Channel display metadata ───

export interface ChannelFieldDescriptor {
  key: string;
  label: string;
  labelZh: string;
  placeholder: string;
  placeholderZh: string;
  secret?: boolean;
  required?: boolean;
}

export interface ChannelMeta {
  kind: ChannelKind;
  name: string;
  nameZh: string;
  description: string;
  descriptionZh: string;
  emoji: string;
  color: string;
  fields: ChannelFieldDescriptor[];
  capabilities: {
    directMessages: boolean;
    groupMessages: boolean;
    typing: boolean;
  };
}

export const CHANNEL_META: Record<ChannelKind, ChannelMeta> = {
  discord: {
    kind: "discord",
    name: "Discord",
    nameZh: "Discord",
    description: "Connect to Discord servers and DMs",
    descriptionZh: "连接 Discord 服务器和私信",
    emoji: "🎮",
    color: "#5865F2",
    fields: [
      { key: "token", label: "Bot Token", labelZh: "机器人 Token", placeholder: "paste your bot token", placeholderZh: "粘贴你的机器人 Token", secret: true, required: true },
      { key: "guildId", label: "Guild ID (optional)", labelZh: "服务器 ID（可选）", placeholder: "e.g. 123456789", placeholderZh: "例如 123456789" },
    ],
    capabilities: { directMessages: true, groupMessages: true, typing: true },
  },
  telegram: {
    kind: "telegram",
    name: "Telegram",
    nameZh: "Telegram",
    description: "Connect to Telegram bots",
    descriptionZh: "连接 Telegram 机器人",
    emoji: "✈️",
    color: "#26A5E4",
    fields: [
      { key: "botToken", label: "Bot Token", labelZh: "机器人 Token", placeholder: "123456:ABC-DEF...", placeholderZh: "123456:ABC-DEF...", secret: true, required: true },
    ],
    capabilities: { directMessages: true, groupMessages: true, typing: false },
  },
  slack: {
    kind: "slack",
    name: "Slack",
    nameZh: "Slack",
    description: "Connect to Slack workspaces",
    descriptionZh: "连接 Slack 工作区",
    emoji: "💼",
    color: "#4A154B",
    fields: [
      { key: "botToken", label: "Bot Token", labelZh: "机器人 Token", placeholder: "xoxb-...", placeholderZh: "xoxb-...", secret: true, required: true },
      { key: "appToken", label: "App Token (Socket Mode)", labelZh: "应用 Token（Socket 模式）", placeholder: "xapp-...", placeholderZh: "xapp-...", secret: true },
    ],
    capabilities: { directMessages: true, groupMessages: true, typing: false },
  },
  whatsapp: {
    kind: "whatsapp",
    name: "WhatsApp",
    nameZh: "WhatsApp",
    description: "Connect to WhatsApp Business API",
    descriptionZh: "连接 WhatsApp Business API",
    emoji: "📱",
    color: "#25D366",
    fields: [
      { key: "accessToken", label: "Access Token", labelZh: "访问令牌", placeholder: "paste access token", placeholderZh: "粘贴访问令牌", secret: true, required: true },
      { key: "phoneNumberId", label: "Phone Number ID", labelZh: "电话号码 ID", placeholder: "e.g. 123456789", placeholderZh: "例如 123456789", required: true },
      { key: "webhookVerifyToken", label: "Webhook Verify Token", labelZh: "Webhook 验证令牌", placeholder: "your-verify-token", placeholderZh: "你的验证令牌", secret: true },
    ],
    capabilities: { directMessages: true, groupMessages: false, typing: false },
  },
  signal: {
    kind: "signal",
    name: "Signal",
    nameZh: "Signal",
    description: "Connect to Signal messenger",
    descriptionZh: "连接 Signal 消息",
    emoji: "🔒",
    color: "#3A76F0",
    fields: [
      { key: "apiUrl", label: "Signal CLI API URL", labelZh: "Signal CLI API 地址", placeholder: "http://localhost:8080", placeholderZh: "http://localhost:8080", required: true },
      { key: "phoneNumber", label: "Phone Number", labelZh: "手机号", placeholder: "+1234567890", placeholderZh: "+1234567890", required: true },
    ],
    capabilities: { directMessages: true, groupMessages: true, typing: false },
  },
  qq: {
    kind: "qq",
    name: "QQ",
    nameZh: "QQ",
    description: "Connect to QQ Official Bot",
    descriptionZh: "连接 QQ 官方机器人",
    emoji: "🐧",
    color: "#12B7F5",
    fields: [
      { key: "appId", label: "App ID", labelZh: "应用 ID", placeholder: "your app ID", placeholderZh: "你的应用 ID", required: true },
      { key: "appSecret", label: "App Secret", labelZh: "应用密钥", placeholder: "paste app secret", placeholderZh: "粘贴应用密钥", secret: true, required: true },
    ],
    capabilities: { directMessages: true, groupMessages: true, typing: false },
  },
  lark: {
    kind: "lark",
    name: "Lark",
    nameZh: "Lark (飞书国际版)",
    description: "Connect to Lark (international Feishu)",
    descriptionZh: "连接 Lark 飞书国际版",
    emoji: "🕊️",
    color: "#00D6B9",
    fields: [
      { key: "appId", label: "App ID", labelZh: "应用 ID", placeholder: "cli_xxx", placeholderZh: "cli_xxx", required: true },
      { key: "appSecret", label: "App Secret", labelZh: "应用密钥", placeholder: "paste app secret", placeholderZh: "粘贴应用密钥", secret: true, required: true },
    ],
    capabilities: { directMessages: true, groupMessages: true, typing: false },
  },
  feishu: {
    kind: "feishu",
    name: "Feishu",
    nameZh: "飞书",
    description: "Connect to Feishu (Chinese Lark)",
    descriptionZh: "连接飞书",
    emoji: "🕊️",
    color: "#00D6B9",
    fields: [
      { key: "appId", label: "App ID", labelZh: "应用 ID", placeholder: "cli_xxx", placeholderZh: "cli_xxx", required: true },
      { key: "appSecret", label: "App Secret", labelZh: "应用密钥", placeholder: "paste app secret", placeholderZh: "粘贴应用密钥", secret: true, required: true },
    ],
    capabilities: { directMessages: true, groupMessages: true, typing: false },
  },
  line: {
    kind: "line",
    name: "LINE",
    nameZh: "LINE",
    description: "Connect to LINE Messaging API",
    descriptionZh: "连接 LINE 消息 API",
    emoji: "💚",
    color: "#06C755",
    fields: [
      { key: "channelAccessToken", label: "Channel Access Token", labelZh: "频道访问令牌", placeholder: "paste channel access token", placeholderZh: "粘贴频道访问令牌", secret: true, required: true },
      { key: "channelSecret", label: "Channel Secret", labelZh: "频道密钥", placeholder: "paste channel secret", placeholderZh: "粘贴频道密钥", secret: true, required: true },
    ],
    capabilities: { directMessages: true, groupMessages: true, typing: false },
  },
  irc: {
    kind: "irc",
    name: "IRC",
    nameZh: "IRC",
    description: "Connect to IRC networks",
    descriptionZh: "连接 IRC 网络",
    emoji: "📡",
    color: "#8B8B8B",
    fields: [
      { key: "server", label: "Server", labelZh: "服务器", placeholder: "irc.libera.chat", placeholderZh: "irc.libera.chat", required: true },
      { key: "nick", label: "Nickname", labelZh: "昵称", placeholder: "friday-bot", placeholderZh: "friday-bot", required: true },
      { key: "password", label: "Password (optional)", labelZh: "密码（可选）", placeholder: "server password", placeholderZh: "服务器密码", secret: true },
      { key: "channels", label: "Channels (comma-separated)", labelZh: "频道（逗号分隔）", placeholder: "#general,#dev", placeholderZh: "#general,#dev" },
    ],
    capabilities: { directMessages: false, groupMessages: true, typing: false },
  },
  webchat: {
    kind: "webchat",
    name: "WebChat",
    nameZh: "网页聊天",
    description: "Built-in web chat widget",
    descriptionZh: "内置网页聊天组件",
    emoji: "🌐",
    color: "#6366F1",
    fields: [],
    capabilities: { directMessages: true, groupMessages: true, typing: false },
  },
};

export const CHANNEL_KINDS_ORDERED: ChannelKind[] = [
  "discord",
  "telegram",
  "slack",
  "whatsapp",
  "qq",
  "lark",
  "feishu",
  "line",
  "signal",
  "irc",
  "webchat",
];

export function getChannelDisplayName(kind: string, locale: AppLocale): string {
  const meta = CHANNEL_META[kind as ChannelKind];
  if (!meta) return kind;
  return locale === "zh" ? meta.nameZh : meta.name;
}

export function getChannelDescription(kind: string, locale: AppLocale): string {
  const meta = CHANNEL_META[kind as ChannelKind];
  if (!meta) return kind;
  return locale === "zh" ? meta.descriptionZh : meta.description;
}
