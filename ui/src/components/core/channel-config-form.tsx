import { useState } from "react";
import { ActionButton } from "@/components/core/primitives";
import { localize, type AppLocale } from "@/lib/i18n/localized-text";

interface ChannelTemplate {
  kind: string;
  label: string;
  labelZh: string;
  fields: { key: string; label: string; labelZh: string; placeholder: string; placeholderZh: string; secret?: boolean }[];
  envFormat: (values: Record<string, string>) => string;
}

const CHANNEL_TEMPLATES: ChannelTemplate[] = [
  {
    kind: "discord",
    label: "Discord",
    labelZh: "Discord",
    fields: [
      { key: "token", label: "Bot Token", labelZh: "机器人 Token", placeholder: "paste your bot token", placeholderZh: "粘贴你的机器人 Token", secret: true },
      { key: "guildId", label: "Guild ID (optional)", labelZh: "服务器 ID（可选）", placeholder: "e.g. 123456789", placeholderZh: "例如 123456789" },
    ],
    envFormat: (v) => JSON.stringify({ kind: "discord", token: v.token || "<TOKEN>", guildId: v.guildId || undefined }),
  },
  {
    kind: "slack",
    label: "Slack Socket Mode",
    labelZh: "Slack Socket Mode",
    fields: [
      { key: "appToken", label: "App Token", labelZh: "应用 Token", placeholder: "xapp-...", placeholderZh: "xapp-...", secret: true },
      { key: "botToken", label: "Bot Token", labelZh: "机器人 Token", placeholder: "xoxb-...", placeholderZh: "xoxb-...", secret: true },
    ],
    envFormat: (v) => JSON.stringify({ kind: "slack", mode: "socket", appToken: v.appToken || "<APP_TOKEN>", botToken: v.botToken || "<BOT_TOKEN>" }),
  },
  {
    kind: "telegram",
    label: "Telegram",
    labelZh: "Telegram",
    fields: [
      { key: "token", label: "Bot Token", labelZh: "机器人 Token", placeholder: "123456:ABC-DEF...", placeholderZh: "123456:ABC-DEF...", secret: true },
    ],
    envFormat: (v) => JSON.stringify({ kind: "telegram", token: v.token || "<TOKEN>" }),
  },
  {
    kind: "wechat",
    label: "WeChat / 企业微信",
    labelZh: "微信 / 企业微信",
    fields: [
      { key: "corpId", label: "Corp ID", labelZh: "企业 ID", placeholder: "ww...", placeholderZh: "ww..." },
      { key: "agentId", label: "Agent ID", labelZh: "应用 ID", placeholder: "1000002", placeholderZh: "1000002" },
      { key: "secret", label: "Secret", labelZh: "密钥", placeholder: "paste secret", placeholderZh: "粘贴密钥", secret: true },
    ],
    envFormat: (v) => JSON.stringify({ kind: "lark", corpId: v.corpId || "<CORP_ID>", agentId: v.agentId || "<AGENT_ID>", secret: v.secret || "<SECRET>" }),
  },
];

export function ChannelConfigForm(props: { locale: AppLocale }) {
  const { locale } = props;
  const [selectedKind, setSelectedKind] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  const template = CHANNEL_TEMPLATES.find((t) => t.kind === selectedKind);

  function handleCopy() {
    if (!template) return;
    const envValue = template.envFormat(values);
    void navigator.clipboard.writeText(envValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-[color:var(--color-text-secondary)]">
        {localize(locale,
          "选择通道类型，填写凭据，然后将生成的配置添加到 FRIDAY_CHANNELS 环境变量中。",
          "Choose a channel type, fill in credentials, then add the generated config to the FRIDAY_CHANNELS environment variable.",
        )}
      </p>

      <div className="flex flex-wrap gap-2">
        {CHANNEL_TEMPLATES.map((t) => (
          <button
            key={t.kind}
            type="button"
            onClick={() => { setSelectedKind(t.kind); setValues({}); setCopied(false); }}
            className={`rounded-xl border px-3 py-1.5 text-sm font-medium transition-all ${
              selectedKind === t.kind
                ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]"
                : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] text-[color:var(--color-text-secondary)] hover:border-[color:var(--color-border-strong)]"
            }`}
          >
            {localize(locale, t.labelZh, t.label)}
          </button>
        ))}
      </div>

      {template && (
        <div className="space-y-3 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
          {template.fields.map((field) => (
            <div key={field.key}>
              <label className="mb-1 block text-xs text-[color:var(--color-text-tertiary)]">
                {localize(locale, field.labelZh, field.label)}
              </label>
              <input
                type={field.secret ? "password" : "text"}
                placeholder={localize(locale, field.placeholderZh, field.placeholder)}
                value={values[field.key] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                className="agent-input px-3 py-2 text-sm"
                autoComplete="off"
              />
            </div>
          ))}

          <div className="rounded-xl bg-[color:var(--color-bg-surface-strong)] p-3">
            <p className="mb-1 text-xs text-[color:var(--color-text-faint)]">
              {localize(locale, "添加到 FRIDAY_CHANNELS 环境变量：", "Add to FRIDAY_CHANNELS env variable:")}
            </p>
            <code className="block whitespace-pre-wrap break-all text-xs text-[color:var(--color-text-primary)]">
              {template.envFormat(values)}
            </code>
          </div>

          <ActionButton onClick={handleCopy}>
            {copied
              ? localize(locale, "已复制！", "Copied!")
              : localize(locale, "复制配置", "Copy Config")}
          </ActionButton>
        </div>
      )}
    </div>
  );
}
