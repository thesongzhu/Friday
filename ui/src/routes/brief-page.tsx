import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CircleDot,
  Clock,
  Hourglass,
  KeyRound,
  Mic,
  Play,
  RefreshCcw,
  RotateCcw,
  Save,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { ActionButton, ShellCard, SkeletonList, StatusPill } from "@/components/core/primitives";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import {
  type BriefSecretSlot,
  type BriefSecretSlotState,
  type FridayBriefChannelKind,
  type FridayBriefConfig,
  type FridayBriefLength,
  type FridayBriefRunRecord,
  type FridayBriefSourceKind,
  type FridayBriefTtsProviderKind,
  briefApi,
  readBriefSlotRefKey,
  writeBriefSlotRefKey,
} from "@/lib/api/brief";

const SOURCE_ORDER: FridayBriefSourceKind[] = [
  "friday_history",
  "git_repos",
  "slack",
  "mail",
  "calendar",
  "issues",
];

const CHANNEL_ORDER: FridayBriefChannelKind[] = ["wecom", "telegram", "email"];

const LENGTH_OPTIONS: FridayBriefLength[] = ["short", "normal", "long"];

const TTS_OPTIONS: FridayBriefTtsProviderKind[] = ["azure", "google", "local"];

function sourceLabel(kind: FridayBriefSourceKind, locale: "zh" | "en"): string {
  switch (kind) {
    case "friday_history":
      return localize(locale, "Friday 历史", "Friday history");
    case "git_repos":
      return localize(locale, "Git 仓库", "Git repos");
    case "slack":
      return "Slack";
    case "mail":
      return localize(locale, "邮件", "Mail");
    case "calendar":
      return localize(locale, "日历", "Calendar");
    case "issues":
      return "Issues";
  }
}

function channelLabel(kind: FridayBriefChannelKind, locale: "zh" | "en"): string {
  switch (kind) {
    case "wecom":
      return localize(locale, "企业微信", "WeCom");
    case "telegram":
      return "Telegram";
    case "email":
      return localize(locale, "邮箱", "Email");
  }
}

function statusTone(status: FridayBriefRunRecord["status"]): "success" | "warning" | "danger" | "neutral" {
  if (status === "delivered") return "success";
  if (status === "failed") return "danger";
  if (status === "skipped") return "neutral";
  return "warning";
}

function formatTimestamp(value?: string): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function moveItem<T>(list: T[], index: number, direction: -1 | 1): T[] {
  const next = list.slice();
  const target = index + direction;
  if (target < 0 || target >= next.length) return list;
  const item = next[index]!;
  next[index] = next[target]!;
  next[target] = item;
  return next;
}

function normalizeFallbackOrder(raw: FridayBriefChannelKind[] | undefined | null): FridayBriefChannelKind[] {
  const valid = new Set<FridayBriefChannelKind>(["wecom", "telegram", "email"]);
  const out: FridayBriefChannelKind[] = [];
  for (const entry of raw ?? []) {
    if (valid.has(entry) && !out.includes(entry)) out.push(entry);
  }
  for (const kind of CHANNEL_ORDER) {
    if (!out.includes(kind)) out.push(kind);
  }
  return out;
}

export function BriefPage() {
  const { locale } = useAppLocale();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<FridayBriefConfig | null>(null);

  const {
    data: config,
    isLoading: configLoading,
    refetch: refetchConfig,
  } = useQuery({
    queryKey: ["brief", "config"],
    queryFn: async () => {
      const value = await briefApi.getConfig();
      setDraft((prev) => prev ?? value);
      return value;
    },
  });

  const {
    data: history,
    isLoading: historyLoading,
    refetch: refetchHistory,
  } = useQuery({
    queryKey: ["brief", "history"],
    queryFn: () => briefApi.listHistory({ limit: 10 }),
  });

  const dirty = useMemo(() => {
    if (!config || !draft) return false;
    return JSON.stringify(draft) !== JSON.stringify(config);
  }, [config, draft]);

  const updateMutation = useMutation({
    mutationFn: (next: FridayBriefConfig) => briefApi.updateConfig(next),
    onSuccess: (saved) => {
      setDraft(saved);
      queryClient.setQueryData(["brief", "config"], saved);
      toast.success(localize(locale, "每日简报配置已保存", "Daily brief settings saved"));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : localize(locale, "保存失败", "Save failed"));
    },
  });

  const triggerMutation = useMutation({
    mutationFn: () => briefApi.triggerNow({ triggeredBy: "manual_http" }),
    onSuccess: (run) => {
      toast.success(
        localize(
          locale,
          `简报已触发（${run.status}）`,
          `Brief triggered (${run.status})`,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: ["brief", "history"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : localize(locale, "触发失败", "Trigger failed"));
    },
  });

  const replayMutation = useMutation({
    mutationFn: async (runId: string) => {
      const prior = await briefApi.getRun(runId);
      return briefApi.triggerNow({
        triggeredBy: "replay",
        windowStartIso: prior.windowStartAt,
        windowEndIso: prior.windowEndAt,
      });
    },
    onSuccess: (run) => {
      toast.success(localize(locale, `已重放（${run.status}）`, `Replayed (${run.status})`));
      void queryClient.invalidateQueries({ queryKey: ["brief", "history"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : localize(locale, "重放失败", "Replay failed"));
    },
  });

  function updateDraft(mutator: (prev: FridayBriefConfig) => FridayBriefConfig) {
    setDraft((prev) => (prev ? mutator(prev) : prev));
  }

  function resetDraft() {
    if (config) setDraft(config);
  }

  function handleSave() {
    if (!draft) return;
    updateMutation.mutate({
      ...draft,
      fallbackOrder: normalizeFallbackOrder(draft.fallbackOrder),
    });
  }

  const effective = draft ?? config;

  return (
    <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
      <div className="space-y-4">
        <ShellCard
          eyebrow={localize(locale, "每日语音简报", "Daily Voice Brief")}
          title={localize(locale, "功能配置", "Feature Settings")}
          aside={
            <div className="flex flex-wrap gap-2">
              <ActionButton tone="secondary" onClick={() => void refetchConfig()}>
                <RefreshCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                {localize(locale, "刷新", "Reload")}
              </ActionButton>
              <ActionButton
                tone="secondary"
                onClick={() => resetDraft()}
                disabled={!dirty}
              >
                <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                {localize(locale, "重置", "Reset")}
              </ActionButton>
              <ActionButton
                onClick={handleSave}
                disabled={!dirty || updateMutation.isPending}
              >
                <Save className="mr-2 h-4 w-4" aria-hidden="true" />
                {updateMutation.isPending
                  ? localize(locale, "保存中...", "Saving...")
                  : localize(locale, "保存", "Save")}
              </ActionButton>
            </div>
          }
        >
          {configLoading || !effective ? (
            <SkeletonList rows={4} />
          ) : (
            <div className="space-y-5">
              <div className="flex items-center justify-between rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3">
                <div>
                  <p className="font-medium text-[color:var(--color-text-primary)]">
                    {localize(locale, "功能总开关", "Feature enabled")}
                  </p>
                  <p className="text-xs text-[color:var(--color-text-faint)]">
                    {localize(
                      locale,
                      "关闭后定时任务不会触发，但仍可手动点“立即生成”。",
                      "When off, scheduled runs are skipped, but Brief Now still works.",
                    )}
                  </p>
                </div>
                <input
                  type="checkbox"
                  className="h-5 w-5"
                  checked={effective.enabled}
                  onChange={(e) => updateDraft((prev) => ({ ...prev, enabled: e.target.checked }))}
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="block text-sm">
                  <span className="mb-1 block text-xs uppercase tracking-wide text-[color:var(--color-text-faint)]">
                    {localize(locale, "Cron 表达式", "Cron expression")}
                  </span>
                  <input
                    className="agent-input"
                    value={effective.cronExpression}
                    onChange={(e) =>
                      updateDraft((prev) => ({ ...prev, cronExpression: e.target.value }))
                    }
                    placeholder="0 20 * * *"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-xs uppercase tracking-wide text-[color:var(--color-text-faint)]">
                    {localize(locale, "时区", "Timezone")}
                  </span>
                  <input
                    className="agent-input"
                    value={effective.timezone}
                    onChange={(e) =>
                      updateDraft((prev) => ({ ...prev, timezone: e.target.value }))
                    }
                    placeholder="Asia/Shanghai"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-xs uppercase tracking-wide text-[color:var(--color-text-faint)]">
                    {localize(locale, "长度", "Length")}
                  </span>
                  <select
                    className="agent-input"
                    value={effective.length}
                    onChange={(e) =>
                      updateDraft((prev) => ({
                        ...prev,
                        length: e.target.value as FridayBriefLength,
                      }))
                    }
                  >
                    {LENGTH_OPTIONS.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-xs uppercase tracking-wide text-[color:var(--color-text-faint)]">
                    {localize(locale, "语言（留空自动）", "Language (blank = auto)")}
                  </span>
                  <input
                    className="agent-input"
                    value={effective.languageOverride}
                    onChange={(e) =>
                      updateDraft((prev) => ({ ...prev, languageOverride: e.target.value }))
                    }
                    placeholder="auto"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-xs uppercase tracking-wide text-[color:var(--color-text-faint)]">
                    {localize(locale, "TTS 提供商", "TTS provider")}
                  </span>
                  <select
                    className="agent-input"
                    value={effective.tts.provider}
                    onChange={(e) =>
                      updateDraft((prev) => ({
                        ...prev,
                        tts: { ...prev.tts, provider: e.target.value as FridayBriefTtsProviderKind },
                      }))
                    }
                  >
                    {TTS_OPTIONS.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-3 rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={effective.includeTranscript}
                    onChange={(e) =>
                      updateDraft((prev) => ({ ...prev, includeTranscript: e.target.checked }))
                    }
                  />
                  <span>{localize(locale, "附带文字稿", "Include text transcript")}</span>
                </label>
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-faint)]">
                  {localize(locale, "数据源开关", "Data sources")}
                </p>
                <div className="grid gap-2 md:grid-cols-2">
                  {SOURCE_ORDER.map((kind) => {
                    const src = effective.sources[kind] as { enabled: boolean };
                    return (
                      <label
                        key={kind}
                        className="flex items-center justify-between rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3 text-sm"
                      >
                        <span>{sourceLabel(kind, locale)}</span>
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={src.enabled}
                          onChange={(e) =>
                            updateDraft((prev) => ({
                              ...prev,
                              sources: {
                                ...prev.sources,
                                [kind]: { ...(prev.sources[kind] as object), enabled: e.target.checked },
                              },
                            }))
                          }
                        />
                      </label>
                    );
                  })}
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-faint)]">
                  {localize(locale, "投递通道与回退顺序", "Channels & fallback order")}
                </p>
                <div className="space-y-2">
                  {normalizeFallbackOrder(effective.fallbackOrder).map((kind, index, list) => {
                    const ch = effective.channels[kind] as { enabled: boolean };
                    return (
                      <div
                        key={kind}
                        className="flex items-center justify-between gap-3 rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3 text-sm"
                      >
                        <div className="flex items-center gap-3">
                          <span className="rounded-full bg-[color:var(--color-bg-surface)] px-2 py-0.5 text-xs text-[color:var(--color-text-faint)]">
                            {String(index + 1)}
                          </span>
                          <span>{channelLabel(kind, locale)}</span>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              className="h-4 w-4"
                              checked={ch.enabled}
                              onChange={(e) =>
                                updateDraft((prev) => ({
                                  ...prev,
                                  channels: {
                                    ...prev.channels,
                                    [kind]: { ...(prev.channels[kind] as object), enabled: e.target.checked },
                                  },
                                }))
                              }
                            />
                            <span className="text-xs text-[color:var(--color-text-faint)]">
                              {localize(locale, "启用", "enabled")}
                            </span>
                          </label>
                        </div>
                        <div className="flex gap-1">
                          <button
                            type="button"
                            aria-label={localize(locale, "上移", "Move up")}
                            className="rounded-md border border-[color:var(--color-border-soft)] p-1 text-[color:var(--color-text-faint)] hover:text-[color:var(--color-text-primary)] disabled:opacity-40"
                            disabled={index === 0}
                            onClick={() =>
                              updateDraft((prev) => ({
                                ...prev,
                                fallbackOrder: moveItem(normalizeFallbackOrder(prev.fallbackOrder), index, -1),
                              }))
                            }
                          >
                            <ArrowUp className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            aria-label={localize(locale, "下移", "Move down")}
                            className="rounded-md border border-[color:var(--color-border-soft)] p-1 text-[color:var(--color-text-faint)] hover:text-[color:var(--color-text-primary)] disabled:opacity-40"
                            disabled={index === list.length - 1}
                            onClick={() =>
                              updateDraft((prev) => ({
                                ...prev,
                                fallbackOrder: moveItem(normalizeFallbackOrder(prev.fallbackOrder), index, 1),
                              }))
                            }
                          >
                            <ArrowDown className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </ShellCard>

        {effective ? (
          <BriefCredentialsCard
            draft={effective}
            updateDraft={updateDraft}
            locale={locale}
          />
        ) : null}

        <ShellCard
          eyebrow={localize(locale, "立即生成", "Trigger Now")}
          title={localize(locale, "手动触发一次简报", "Run the brief right now")}
        >
          <div className="space-y-3">
            <p className="text-sm text-[color:var(--color-text-secondary)]">
              {localize(
                locale,
                "按当前保存的配置运行一次，默认窗口为过去 24 小时。失败或被跳过的运行会记录在下方历史中。",
                "Runs with the currently saved settings. Default window is the past 24 hours. Failures and skipped runs are recorded in history below.",
              )}
            </p>
            <ActionButton
              onClick={() => triggerMutation.mutate()}
              disabled={triggerMutation.isPending}
            >
              <Mic className="mr-2 h-4 w-4" aria-hidden="true" />
              {triggerMutation.isPending
                ? localize(locale, "生成中...", "Generating...")
                : localize(locale, "立即生成", "Brief Now")}
            </ActionButton>
          </div>
        </ShellCard>
      </div>

      <ShellCard
        eyebrow={localize(locale, "近期运行", "Recent Runs")}
        title={localize(locale, "简报历史", "Brief History")}
        aside={
          <ActionButton tone="secondary" onClick={() => void refetchHistory()}>
            <RefreshCcw className="mr-2 h-4 w-4" aria-hidden="true" />
            {localize(locale, "刷新", "Refresh")}
          </ActionButton>
        }
      >
        {historyLoading ? (
          <SkeletonList rows={4} />
        ) : !history || history.items.length === 0 ? (
          <p className="rounded-[22px] border border-dashed border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-8 text-center text-sm text-[color:var(--color-text-secondary)]">
            {localize(locale, "暂无历史记录。", "No brief runs yet.")}
          </p>
        ) : (
          <div className="space-y-3">
            {history.items.map((run) => (
              <RunCard
                key={run.id}
                run={run}
                onReplay={() => replayMutation.mutate(run.id)}
                isReplaying={replayMutation.isPending}
                locale={locale}
              />
            ))}
          </div>
        )}
      </ShellCard>
    </div>
  );
}

// ─── Credential panel ──────────────────────────────────────────────────────

type UpdateDraftFn = (mutator: (prev: FridayBriefConfig) => FridayBriefConfig) => void;

function BriefCredentialsCard(props: {
  draft: FridayBriefConfig;
  updateDraft: UpdateDraftFn;
  locale: "zh" | "en";
}) {
  const { draft, updateDraft, locale } = props;
  const queryClient = useQueryClient();

  const { data: secrets, refetch: refetchSecrets } = useQuery({
    queryKey: ["brief", "secrets"],
    queryFn: () => briefApi.listSecrets(),
  });

  const slotState = useMemo(() => {
    const map = new Map<BriefSecretSlot, BriefSecretSlotState>();
    for (const slot of secrets ?? []) map.set(slot.slot, slot);
    return map;
  }, [secrets]);

  async function handleSecretChange(nextConfig: FridayBriefConfig, slot: BriefSecretSlot) {
    queryClient.setQueryData(["brief", "config"], nextConfig);
    // Also fold the new refKey into the local draft so a subsequent global
    // Save doesn't overwrite the just-saved slot back to its old refKey.
    const refKey = readBriefSlotRefKey(nextConfig, slot);
    updateDraft((prev) => writeBriefSlotRefKey(prev, slot, refKey));
    await refetchSecrets();
  }

  return (
    <ShellCard
      eyebrow={localize(locale, "凭据与参数", "Credentials & details")}
      title={localize(locale, "数据源 / 投递 / 语音", "Sources / Delivery / TTS")}
    >
      <div className="space-y-6">
        <TtsDetails draft={draft} updateDraft={updateDraft} locale={locale} slotState={slotState} onSecretChanged={handleSecretChange} />
        <div className="h-px bg-[color:var(--color-border-soft)]" />
        <SourcesDetails draft={draft} updateDraft={updateDraft} locale={locale} slotState={slotState} onSecretChanged={handleSecretChange} />
        <div className="h-px bg-[color:var(--color-border-soft)]" />
        <ChannelsDetails draft={draft} updateDraft={updateDraft} locale={locale} slotState={slotState} onSecretChanged={handleSecretChange} />
      </div>
    </ShellCard>
  );
}

function SectionHeader(props: { zh: string; en: string; locale: "zh" | "en"; enabled?: boolean }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-text-faint)]">
        {localize(props.locale, props.zh, props.en)}
      </h3>
      {props.enabled === false ? (
        <StatusPill>{localize(props.locale, "未启用", "Disabled")}</StatusPill>
      ) : null}
    </div>
  );
}

function TextField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "number" | "url" | "email";
  className?: string;
}) {
  return (
    <label className={`block text-sm ${props.className ?? ""}`}>
      <span className="mb-1 block text-xs uppercase tracking-wide text-[color:var(--color-text-faint)]">
        {props.label}
      </span>
      <input
        type={props.type ?? "text"}
        className="agent-input"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
      />
    </label>
  );
}

function ListField(props: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  return (
    <TextField
      label={props.label}
      value={props.value.join(", ")}
      placeholder={props.placeholder}
      onChange={(raw) =>
        props.onChange(
          raw
            .split(/[,\n]/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        )
      }
    />
  );
}

function CheckboxField(props: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2 text-sm">
      <input
        type="checkbox"
        className="h-4 w-4"
        checked={props.value}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span>{props.label}</span>
    </label>
  );
}

function SecretField(props: {
  slot: BriefSecretSlot;
  label: string;
  placeholder?: string;
  slotState: Map<BriefSecretSlot, BriefSecretSlotState>;
  onChanged: (next: FridayBriefConfig, slot: BriefSecretSlot) => Promise<void>;
  locale: "zh" | "en";
}) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const state = props.slotState.get(props.slot);
  const configured = !!state?.configured;

  async function save() {
    if (value.trim().length === 0) {
      toast.error(localize(props.locale, "请输入值", "Please enter a value"));
      return;
    }
    setPending(true);
    try {
      const next = await briefApi.setSecret(props.slot, value);
      setValue("");
      await props.onChanged(next, props.slot);
      toast.success(localize(props.locale, "密钥已保存", "Secret saved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : localize(props.locale, "保存失败", "Save failed"));
    } finally {
      setPending(false);
    }
  }

  async function clear() {
    setPending(true);
    try {
      const next = await briefApi.clearSecret(props.slot);
      await props.onChanged(next, props.slot);
      toast.success(localize(props.locale, "密钥已清除", "Secret cleared"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : localize(props.locale, "清除失败", "Clear failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="block text-sm">
      <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-[color:var(--color-text-faint)]">
        <KeyRound className="h-3 w-3" />
        <span>{props.label}</span>
        {configured ? (
          <StatusPill tone="success">
            {localize(props.locale, "已配置", "Configured")}
          </StatusPill>
        ) : (
          <StatusPill tone="warning">
            {localize(props.locale, "未配置", "Not set")}
          </StatusPill>
        )}
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          className="agent-input flex-1"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={
            configured
              ? localize(props.locale, "已保存。输入新值可覆盖", "Saved. Enter new value to replace")
              : props.placeholder ?? localize(props.locale, "输入密钥后点保存", "Enter secret then Save")
          }
          autoComplete="new-password"
          disabled={pending}
        />
        <ActionButton tone="secondary" onClick={save} disabled={pending || value.trim().length === 0}>
          {pending ? "..." : localize(props.locale, "保存", "Save")}
        </ActionButton>
        {configured ? (
          <ActionButton tone="danger" onClick={clear} disabled={pending}>
            <Trash2 className="h-4 w-4" />
          </ActionButton>
        ) : null}
      </div>
    </div>
  );
}

// ─── TTS details ───

function TtsDetails(props: {
  draft: FridayBriefConfig;
  updateDraft: UpdateDraftFn;
  locale: "zh" | "en";
  slotState: Map<BriefSecretSlot, BriefSecretSlotState>;
  onSecretChanged: (next: FridayBriefConfig, slot: BriefSecretSlot) => Promise<void>;
}) {
  const { draft, updateDraft, locale, slotState, onSecretChanged } = props;
  const provider = draft.tts.provider;

  return (
    <div>
      <SectionHeader zh="语音合成（TTS）" en="Text-to-Speech (TTS)" locale={locale} />
      <p className="mb-3 text-xs text-[color:var(--color-text-faint)]">
        {localize(
          locale,
          `当前提供商：${provider}。下方只显示当前提供商的配置。`,
          `Active provider: ${provider}. Only active provider's fields are shown.`,
        )}
      </p>
      {provider === "azure" ? (
        <div className="grid gap-3 md:grid-cols-2">
          <TextField
            label={localize(locale, "Azure 区域", "Azure region")}
            value={draft.tts.azure.region ?? ""}
            onChange={(v) =>
              updateDraft((prev) => ({
                ...prev,
                tts: { ...prev.tts, azure: { ...prev.tts.azure, region: v || undefined } },
              }))
            }
            placeholder="eastus"
          />
          <TextField
            label={localize(locale, "中文/默认 voice", "Default voice")}
            value={draft.tts.azure.voice}
            onChange={(v) =>
              updateDraft((prev) => ({
                ...prev,
                tts: { ...prev.tts, azure: { ...prev.tts.azure, voice: v } },
              }))
            }
            placeholder="zh-CN-XiaoxiaoNeural"
          />
          <TextField
            label={localize(locale, "英文 voice", "English voice")}
            value={draft.tts.azure.voiceEn}
            onChange={(v) =>
              updateDraft((prev) => ({
                ...prev,
                tts: { ...prev.tts, azure: { ...prev.tts.azure, voiceEn: v } },
              }))
            }
            placeholder="en-US-AvaNeural"
          />
          <div className="md:col-span-2">
            <SecretField
              slot="tts.azure.key"
              label={localize(locale, "Azure 订阅密钥", "Azure subscription key")}
              slotState={slotState}
              onChanged={onSecretChanged}
              locale={locale}
            />
          </div>
        </div>
      ) : null}
      {provider === "google" ? (
        <div className="grid gap-3 md:grid-cols-2">
          <TextField
            label={localize(locale, "中文/默认 voice", "Default voice")}
            value={draft.tts.google.voice}
            onChange={(v) =>
              updateDraft((prev) => ({
                ...prev,
                tts: { ...prev.tts, google: { ...prev.tts.google, voice: v } },
              }))
            }
            placeholder="cmn-CN-Wavenet-A"
          />
          <TextField
            label={localize(locale, "英文 voice", "English voice")}
            value={draft.tts.google.voiceEn}
            onChange={(v) =>
              updateDraft((prev) => ({
                ...prev,
                tts: { ...prev.tts, google: { ...prev.tts.google, voiceEn: v } },
              }))
            }
            placeholder="en-US-Neural2-F"
          />
          <div className="md:col-span-2">
            <SecretField
              slot="tts.google.apiKey"
              label={localize(locale, "Google Cloud API Key", "Google Cloud API key")}
              slotState={slotState}
              onChanged={onSecretChanged}
              locale={locale}
            />
          </div>
        </div>
      ) : null}
      {provider === "local" ? (
        <div className="grid gap-3 md:grid-cols-2">
          <TextField
            label={localize(locale, "中文 voice (macOS say)", "CJK voice (macOS say)")}
            value={draft.tts.local.voice}
            onChange={(v) =>
              updateDraft((prev) => ({
                ...prev,
                tts: { ...prev.tts, local: { ...prev.tts.local, voice: v } },
              }))
            }
            placeholder="Tingting"
          />
          <TextField
            label={localize(locale, "英文 voice (macOS say)", "English voice (macOS say)")}
            value={draft.tts.local.voiceEn}
            onChange={(v) =>
              updateDraft((prev) => ({
                ...prev,
                tts: { ...prev.tts, local: { ...prev.tts.local, voiceEn: v } },
              }))
            }
            placeholder="Samantha"
          />
          <p className="md:col-span-2 text-xs text-[color:var(--color-text-faint)]">
            {localize(
              locale,
              "本地 TTS 使用 macOS `say` + `afconvert`，无需密钥。仅在 macOS 上可用。",
              "Local TTS uses macOS `say` + `afconvert`, no key required. macOS only.",
            )}
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ─── Sources details ───

function SourcesDetails(props: {
  draft: FridayBriefConfig;
  updateDraft: UpdateDraftFn;
  locale: "zh" | "en";
  slotState: Map<BriefSecretSlot, BriefSecretSlotState>;
  onSecretChanged: (next: FridayBriefConfig, slot: BriefSecretSlot) => Promise<void>;
}) {
  const { draft, updateDraft, locale, slotState, onSecretChanged } = props;
  const { sources } = draft;

  return (
    <div>
      <SectionHeader zh="数据源配置" en="Source configuration" locale={locale} />

      {/* git_repos */}
      <div className="mb-4 rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">{localize(locale, "Git 仓库", "Git repositories")}</p>
          <StatusPill tone={sources.git_repos.enabled ? "success" : "neutral"}>
            {sources.git_repos.enabled ? localize(locale, "已启用", "Enabled") : localize(locale, "未启用", "Disabled")}
          </StatusPill>
        </div>
        {sources.git_repos.enabled ? (
          <GitReposEditor
            value={sources.git_repos.repos}
            onChange={(repos) =>
              updateDraft((prev) => ({
                ...prev,
                sources: { ...prev.sources, git_repos: { ...prev.sources.git_repos, repos } },
              }))
            }
            locale={locale}
          />
        ) : null}
      </div>

      {/* slack */}
      <div className="mb-4 rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">Slack</p>
          <StatusPill tone={sources.slack.enabled ? "success" : "neutral"}>
            {sources.slack.enabled ? localize(locale, "已启用", "Enabled") : localize(locale, "未启用", "Disabled")}
          </StatusPill>
        </div>
        {sources.slack.enabled ? (
          <div className="grid gap-3 md:grid-cols-2">
            <TextField
              label={localize(locale, "用户 ID", "User ID")}
              value={sources.slack.userId ?? ""}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  sources: { ...prev.sources, slack: { ...prev.sources.slack, userId: v || undefined } },
                }))
              }
              placeholder="U0123ABCD"
            />
            <CheckboxField
              label={localize(locale, "包含私信", "Include DMs")}
              value={sources.slack.includeDms}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  sources: { ...prev.sources, slack: { ...prev.sources.slack, includeDms: v } },
                }))
              }
            />
            <ListField
              label={localize(locale, "频道 ID（留空=全部）", "Channel IDs (blank = all)")}
              value={sources.slack.channels}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  sources: { ...prev.sources, slack: { ...prev.sources.slack, channels: v } },
                }))
              }
              placeholder="C01234, C05678"
            />
            <div className="md:col-span-2">
              <SecretField
                slot="sources.slack.token"
                label={localize(locale, "Slack Bot Token", "Slack bot token")}
                slotState={slotState}
                onChanged={onSecretChanged}
                locale={locale}
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* mail */}
      <div className="mb-4 rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">{localize(locale, "邮件", "Mail")}</p>
          <StatusPill tone={sources.mail.enabled ? "success" : "neutral"}>
            {sources.mail.enabled ? localize(locale, "已启用", "Enabled") : localize(locale, "未启用", "Disabled")}
          </StatusPill>
        </div>
        {sources.mail.enabled ? (
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-[color:var(--color-text-faint)]">
                {localize(locale, "提供商", "Provider")}
              </span>
              <select
                className="agent-input"
                value={sources.mail.provider ?? ""}
                onChange={(e) =>
                  updateDraft((prev) => ({
                    ...prev,
                    sources: {
                      ...prev.sources,
                      mail: {
                        ...prev.sources.mail,
                        provider: (e.target.value || undefined) as "gmail" | "outlook" | undefined,
                      },
                    },
                  }))
                }
              >
                <option value="">{localize(locale, "（选择）", "(choose)")}</option>
                <option value="gmail">Gmail</option>
                <option value="outlook">Outlook</option>
              </select>
            </label>
            <TextField
              label={localize(locale, "邮箱地址", "Account email")}
              value={sources.mail.account ?? ""}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  sources: { ...prev.sources, mail: { ...prev.sources.mail, account: v || undefined } },
                }))
              }
              placeholder="you@example.com"
              type="email"
            />
            <CheckboxField
              label={localize(locale, "包含收到的邮件（VIP）", "Include received (VIP)")}
              value={sources.mail.includeReceived}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  sources: { ...prev.sources, mail: { ...prev.sources.mail, includeReceived: v } },
                }))
              }
            />
            <ListField
              label={localize(locale, "VIP 发件人", "VIP senders")}
              value={sources.mail.vipSenders}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  sources: { ...prev.sources, mail: { ...prev.sources.mail, vipSenders: v } },
                }))
              }
              placeholder="ceo@company.com, lead@company.com"
            />
            <div className="md:col-span-2">
              <SecretField
                slot="sources.mail.credential"
                label={localize(locale, "OAuth 凭据（JSON）", "OAuth credential (JSON)")}
                slotState={slotState}
                onChanged={onSecretChanged}
                locale={locale}
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* calendar */}
      <div className="mb-4 rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">{localize(locale, "日历", "Calendar")}</p>
          <StatusPill tone={sources.calendar.enabled ? "success" : "neutral"}>
            {sources.calendar.enabled ? localize(locale, "已启用", "Enabled") : localize(locale, "未启用", "Disabled")}
          </StatusPill>
        </div>
        {sources.calendar.enabled ? (
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-[color:var(--color-text-faint)]">
                {localize(locale, "提供商", "Provider")}
              </span>
              <select
                className="agent-input"
                value={sources.calendar.provider ?? ""}
                onChange={(e) =>
                  updateDraft((prev) => ({
                    ...prev,
                    sources: {
                      ...prev.sources,
                      calendar: {
                        ...prev.sources.calendar,
                        provider: (e.target.value || undefined) as "google" | "outlook" | undefined,
                      },
                    },
                  }))
                }
              >
                <option value="">{localize(locale, "（选择）", "(choose)")}</option>
                <option value="google">Google</option>
                <option value="outlook">Outlook</option>
              </select>
            </label>
            <TextField
              label={localize(locale, "邮箱地址", "Account email")}
              value={sources.calendar.account ?? ""}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  sources: { ...prev.sources, calendar: { ...prev.sources.calendar, account: v || undefined } },
                }))
              }
              type="email"
            />
            <CheckboxField
              label={localize(locale, "包含已拒绝的事件", "Include declined events")}
              value={sources.calendar.includeDeclined}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  sources: { ...prev.sources, calendar: { ...prev.sources.calendar, includeDeclined: v } },
                }))
              }
            />
            <ListField
              label={localize(locale, "日历 ID（留空=主日历）", "Calendar IDs (blank = primary)")}
              value={sources.calendar.calendarIds}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  sources: { ...prev.sources, calendar: { ...prev.sources.calendar, calendarIds: v } },
                }))
              }
            />
            <div className="md:col-span-2">
              <SecretField
                slot="sources.calendar.credential"
                label={localize(locale, "OAuth 凭据（JSON）", "OAuth credential (JSON)")}
                slotState={slotState}
                onChanged={onSecretChanged}
                locale={locale}
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* issues */}
      <div className="mb-2 rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">Issues</p>
          <StatusPill tone={sources.issues.enabled ? "success" : "neutral"}>
            {sources.issues.enabled ? localize(locale, "已启用", "Enabled") : localize(locale, "未启用", "Disabled")}
          </StatusPill>
        </div>
        {sources.issues.enabled ? (
          <div className="space-y-4">
            {/* Linear */}
            <div className="rounded-[14px] border border-[color:var(--color-border-soft)] p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold">Linear</p>
                <CheckboxField
                  label={localize(locale, "启用", "Enable")}
                  value={sources.issues.linear.enabled}
                  onChange={(v) =>
                    updateDraft((prev) => ({
                      ...prev,
                      sources: {
                        ...prev.sources,
                        issues: {
                          ...prev.sources.issues,
                          linear: { ...prev.sources.issues.linear, enabled: v },
                        },
                      },
                    }))
                  }
                />
              </div>
              {sources.issues.linear.enabled ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <TextField
                    label={localize(locale, "Linear 用户 ID", "Linear user ID")}
                    value={sources.issues.linear.userId ?? ""}
                    onChange={(v) =>
                      updateDraft((prev) => ({
                        ...prev,
                        sources: {
                          ...prev.sources,
                          issues: {
                            ...prev.sources.issues,
                            linear: { ...prev.sources.issues.linear, userId: v || undefined },
                          },
                        },
                      }))
                    }
                  />
                  <div className="md:col-span-2">
                    <SecretField
                      slot="sources.issues.linear.apiKey"
                      label={localize(locale, "Linear API Key", "Linear API key")}
                      slotState={slotState}
                      onChanged={onSecretChanged}
                      locale={locale}
                    />
                  </div>
                </div>
              ) : null}
            </div>
            {/* Jira */}
            <div className="rounded-[14px] border border-[color:var(--color-border-soft)] p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold">Jira</p>
                <CheckboxField
                  label={localize(locale, "启用", "Enable")}
                  value={sources.issues.jira.enabled}
                  onChange={(v) =>
                    updateDraft((prev) => ({
                      ...prev,
                      sources: {
                        ...prev.sources,
                        issues: {
                          ...prev.sources.issues,
                          jira: { ...prev.sources.issues.jira, enabled: v },
                        },
                      },
                    }))
                  }
                />
              </div>
              {sources.issues.jira.enabled ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <TextField
                    label={localize(locale, "Jira 站点 URL", "Jira site URL")}
                    value={sources.issues.jira.baseUrl ?? ""}
                    onChange={(v) =>
                      updateDraft((prev) => ({
                        ...prev,
                        sources: {
                          ...prev.sources,
                          issues: {
                            ...prev.sources.issues,
                            jira: { ...prev.sources.issues.jira, baseUrl: v || undefined },
                          },
                        },
                      }))
                    }
                    type="url"
                    placeholder="https://your-company.atlassian.net"
                  />
                  <TextField
                    label={localize(locale, "Account ID", "Account ID")}
                    value={sources.issues.jira.accountId ?? ""}
                    onChange={(v) =>
                      updateDraft((prev) => ({
                        ...prev,
                        sources: {
                          ...prev.sources,
                          issues: {
                            ...prev.sources.issues,
                            jira: { ...prev.sources.issues.jira, accountId: v || undefined },
                          },
                        },
                      }))
                    }
                  />
                  <div className="md:col-span-2">
                    <SecretField
                      slot="sources.issues.jira.credential"
                      label={localize(locale, "Jira email + API token (JSON)", "Jira email + API token (JSON)")}
                      slotState={slotState}
                      onChanged={onSecretChanged}
                      locale={locale}
                    />
                  </div>
                </div>
              ) : null}
            </div>
            {/* GitHub */}
            <div className="rounded-[14px] border border-[color:var(--color-border-soft)] p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold">GitHub</p>
                <CheckboxField
                  label={localize(locale, "启用", "Enable")}
                  value={sources.issues.github.enabled}
                  onChange={(v) =>
                    updateDraft((prev) => ({
                      ...prev,
                      sources: {
                        ...prev.sources,
                        issues: {
                          ...prev.sources.issues,
                          github: { ...prev.sources.issues.github, enabled: v },
                        },
                      },
                    }))
                  }
                />
              </div>
              {sources.issues.github.enabled ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <TextField
                    label={localize(locale, "GitHub 用户名", "GitHub username")}
                    value={sources.issues.github.username ?? ""}
                    onChange={(v) =>
                      updateDraft((prev) => ({
                        ...prev,
                        sources: {
                          ...prev.sources,
                          issues: {
                            ...prev.sources.issues,
                            github: { ...prev.sources.issues.github, username: v || undefined },
                          },
                        },
                      }))
                    }
                  />
                  <ListField
                    label={localize(locale, "仓库（owner/repo，留空=全部）", "Repos (owner/repo, blank = all)")}
                    value={sources.issues.github.repos}
                    onChange={(v) =>
                      updateDraft((prev) => ({
                        ...prev,
                        sources: {
                          ...prev.sources,
                          issues: {
                            ...prev.sources.issues,
                            github: { ...prev.sources.issues.github, repos: v },
                          },
                        },
                      }))
                    }
                    placeholder="anthropic/claude-code"
                  />
                  <div className="md:col-span-2">
                    <SecretField
                      slot="sources.issues.github.token"
                      label={localize(locale, "GitHub Personal Access Token", "GitHub personal access token")}
                      slotState={slotState}
                      onChanged={onSecretChanged}
                      locale={locale}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function GitReposEditor(props: {
  value: FridayBriefConfig["sources"]["git_repos"]["repos"];
  onChange: (repos: FridayBriefConfig["sources"]["git_repos"]["repos"]) => void;
  locale: "zh" | "en";
}) {
  return (
    <div className="space-y-3">
      {props.value.map((repo, idx) => (
        <div key={idx} className="grid gap-2 rounded-[14px] border border-[color:var(--color-border-soft)] p-3 md:grid-cols-2">
          <TextField
            label={localize(props.locale, "标签", "Label")}
            value={repo.label}
            onChange={(v) => {
              const next = props.value.slice();
              next[idx] = { ...repo, label: v };
              props.onChange(next);
            }}
          />
          <TextField
            label={localize(props.locale, "绝对路径", "Absolute path")}
            value={repo.path}
            onChange={(v) => {
              const next = props.value.slice();
              next[idx] = { ...repo, path: v };
              props.onChange(next);
            }}
            placeholder="/Users/you/Projects/foo"
          />
          <ListField
            label={localize(props.locale, "作者（留空=全部）", "Authors (blank = all)")}
            value={repo.authors}
            onChange={(v) => {
              const next = props.value.slice();
              next[idx] = { ...repo, authors: v };
              props.onChange(next);
            }}
          />
          <ListField
            label={localize(props.locale, "分支（留空=当前 HEAD）", "Branches (blank = HEAD)")}
            value={repo.branches}
            onChange={(v) => {
              const next = props.value.slice();
              next[idx] = { ...repo, branches: v };
              props.onChange(next);
            }}
          />
          <div className="md:col-span-2 flex justify-end">
            <ActionButton
              tone="danger"
              onClick={() => props.onChange(props.value.filter((_, i) => i !== idx))}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {localize(props.locale, "删除", "Remove")}
            </ActionButton>
          </div>
        </div>
      ))}
      <ActionButton
        tone="secondary"
        onClick={() =>
          props.onChange([
            ...props.value,
            { label: "", path: "", authors: [], branches: [] },
          ])
        }
      >
        + {localize(props.locale, "添加仓库", "Add repository")}
      </ActionButton>
    </div>
  );
}

// ─── Channels details ───

function ChannelsDetails(props: {
  draft: FridayBriefConfig;
  updateDraft: UpdateDraftFn;
  locale: "zh" | "en";
  slotState: Map<BriefSecretSlot, BriefSecretSlotState>;
  onSecretChanged: (next: FridayBriefConfig, slot: BriefSecretSlot) => Promise<void>;
}) {
  const { draft, updateDraft, locale, slotState, onSecretChanged } = props;
  const { channels } = draft;

  return (
    <div>
      <SectionHeader zh="投递通道配置" en="Delivery channel configuration" locale={locale} />

      {/* WeCom */}
      <div className="mb-4 rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">{localize(locale, "企业微信", "WeCom")}</p>
          <StatusPill tone={channels.wecom.enabled ? "success" : "neutral"}>
            {channels.wecom.enabled ? localize(locale, "已启用", "Enabled") : localize(locale, "未启用", "Disabled")}
          </StatusPill>
        </div>
        {channels.wecom.enabled ? (
          <div className="grid gap-3 md:grid-cols-2">
            <TextField
              label={localize(locale, "企业 ID (corpId)", "Corp ID")}
              value={channels.wecom.corpId ?? ""}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  channels: { ...prev.channels, wecom: { ...prev.channels.wecom, corpId: v || undefined } },
                }))
              }
              placeholder="ww..."
            />
            <TextField
              label={localize(locale, "应用 Agent ID", "Agent ID")}
              value={channels.wecom.agentId ?? ""}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  channels: { ...prev.channels, wecom: { ...prev.channels.wecom, agentId: v || undefined } },
                }))
              }
            />
            <TextField
              label={localize(locale, "接收用户 (|分隔或 @all)", "Recipients (| or @all)")}
              value={channels.wecom.toUser}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  channels: { ...prev.channels, wecom: { ...prev.channels.wecom, toUser: v || "@all" } },
                }))
              }
              placeholder="@all"
            />
            <div className="md:col-span-2">
              <SecretField
                slot="channels.wecom.secret"
                label={localize(locale, "Corp 应用 Secret", "Corp app secret")}
                slotState={slotState}
                onChanged={onSecretChanged}
                locale={locale}
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* Telegram */}
      <div className="mb-4 rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">Telegram</p>
          <StatusPill tone={channels.telegram.enabled ? "success" : "neutral"}>
            {channels.telegram.enabled ? localize(locale, "已启用", "Enabled") : localize(locale, "未启用", "Disabled")}
          </StatusPill>
        </div>
        {channels.telegram.enabled ? (
          <div className="grid gap-3 md:grid-cols-2">
            <TextField
              label={localize(locale, "Chat ID", "Chat ID")}
              value={channels.telegram.chatId ?? ""}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  channels: { ...prev.channels, telegram: { ...prev.channels.telegram, chatId: v || undefined } },
                }))
              }
              placeholder="123456789"
            />
            <div>
              <SecretField
                slot="channels.telegram.botToken"
                label={localize(locale, "Bot Token", "Bot token")}
                slotState={slotState}
                onChanged={onSecretChanged}
                locale={locale}
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* Email */}
      <div className="mb-2 rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">{localize(locale, "邮箱（SMTP）", "Email (SMTP)")}</p>
          <StatusPill tone={channels.email.enabled ? "success" : "neutral"}>
            {channels.email.enabled ? localize(locale, "已启用", "Enabled") : localize(locale, "未启用", "Disabled")}
          </StatusPill>
        </div>
        {channels.email.enabled ? (
          <div className="grid gap-3 md:grid-cols-2">
            <TextField
              label={localize(locale, "SMTP 主机", "SMTP host")}
              value={channels.email.host ?? ""}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  channels: { ...prev.channels, email: { ...prev.channels.email, host: v || undefined } },
                }))
              }
              placeholder="smtp.gmail.com"
            />
            <TextField
              label={localize(locale, "SMTP 端口", "SMTP port")}
              value={String(channels.email.port)}
              onChange={(v) => {
                const parsed = Number.parseInt(v, 10);
                updateDraft((prev) => ({
                  ...prev,
                  channels: {
                    ...prev.channels,
                    email: {
                      ...prev.channels.email,
                      port: Number.isFinite(parsed) && parsed > 0 ? parsed : prev.channels.email.port,
                    },
                  },
                }));
              }}
              type="number"
              placeholder="465"
            />
            <CheckboxField
              label={localize(locale, "使用 TLS (secure)", "Use TLS (secure)")}
              value={channels.email.secure}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  channels: { ...prev.channels, email: { ...prev.channels.email, secure: v } },
                }))
              }
            />
            <TextField
              label={localize(locale, "SMTP 用户名", "SMTP username")}
              value={channels.email.username ?? ""}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  channels: { ...prev.channels, email: { ...prev.channels.email, username: v || undefined } },
                }))
              }
            />
            <TextField
              label={localize(locale, "发件人邮箱", "From address")}
              value={channels.email.fromAddress ?? ""}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  channels: { ...prev.channels, email: { ...prev.channels.email, fromAddress: v || undefined } },
                }))
              }
              type="email"
            />
            <TextField
              label={localize(locale, "发件人名称", "From name")}
              value={channels.email.fromName}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  channels: { ...prev.channels, email: { ...prev.channels.email, fromName: v || "Friday" } },
                }))
              }
            />
            <TextField
              label={localize(locale, "收件人邮箱", "To address")}
              value={channels.email.toAddress ?? ""}
              onChange={(v) =>
                updateDraft((prev) => ({
                  ...prev,
                  channels: { ...prev.channels, email: { ...prev.channels.email, toAddress: v || undefined } },
                }))
              }
              type="email"
            />
            <div className="md:col-span-2">
              <SecretField
                slot="channels.email.password"
                label={localize(locale, "SMTP 密码", "SMTP password")}
                slotState={slotState}
                onChanged={onSecretChanged}
                locale={locale}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RunCard(props: {
  run: FridayBriefRunRecord;
  onReplay: () => void;
  isReplaying: boolean;
  locale: "zh" | "en";
}) {
  const [expanded, setExpanded] = useState(false);
  const { run, onReplay, isReplaying, locale } = props;
  const statusIcon = run.status === "delivered"
    ? <CheckCircle2 className="h-4 w-4" />
    : run.status === "failed"
      ? <XCircle className="h-4 w-4" />
      : run.status === "skipped"
        ? <CircleDot className="h-4 w-4" />
        : <Hourglass className="h-4 w-4" />;
  return (
    <div className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <StatusPill tone={statusTone(run.status)}>
              <span className="mr-1 inline-flex items-center">{statusIcon}</span>
              {run.status}
            </StatusPill>
            <StatusPill>{run.triggeredBy}</StatusPill>
            {run.language ? <StatusPill>{run.language}</StatusPill> : null}
            {run.audio ? (
              <StatusPill>
                {run.audio.provider}/{run.audio.voice}
              </StatusPill>
            ) : null}
          </div>
          <p className="text-xs text-[color:var(--color-text-faint)]">
            <Clock className="mr-1 inline-block h-3 w-3" />
            {formatTimestamp(run.createdAt)}
          </p>
          <p className="text-xs text-[color:var(--color-text-faint)]">
            {localize(locale, "窗口", "Window")}: {formatTimestamp(run.windowStartAt)} → {formatTimestamp(run.windowEndAt)}
          </p>
          {run.skipReason ? (
            <p className="text-xs text-[color:var(--color-text-faint)]">
              {localize(locale, "跳过原因", "Skip reason")}: {run.skipReason}
            </p>
          ) : null}
          {run.error ? (
            <p className="text-xs text-red-500">
              {run.error.code}: {run.error.message}
            </p>
          ) : null}
        </div>
        <div className="flex gap-2">
          <ActionButton tone="secondary" onClick={() => setExpanded((v) => !v)}>
            {expanded ? localize(locale, "收起", "Collapse") : localize(locale, "展开", "Expand")}
          </ActionButton>
          <ActionButton tone="secondary" onClick={onReplay} disabled={isReplaying}>
            <Play className="mr-2 h-4 w-4" aria-hidden="true" />
            {localize(locale, "重放", "Replay")}
          </ActionButton>
        </div>
      </div>
      {expanded ? (
        <div className="mt-4 space-y-3 text-sm">
          {run.sourceResults.length > 0 ? (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-faint)]">
                {localize(locale, "来源", "Sources")}
              </p>
              <ul className="space-y-1">
                {run.sourceResults.map((source) => (
                  <li key={source.source} className="text-xs text-[color:var(--color-text-secondary)]">
                    {source.source}: {source.eventCount} events · {source.durationMs}ms
                    {source.skipped ? ` · skipped${source.skipReason ? ` (${source.skipReason})` : ""}` : ""}
                    {source.error ? ` · error: ${source.error.code}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {run.deliveryAttempts.length > 0 ? (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-faint)]">
                {localize(locale, "投递", "Delivery")}
              </p>
              <ul className="space-y-1">
                {run.deliveryAttempts.map((attempt, idx) => (
                  <li key={`${attempt.channel}-${idx}`} className="text-xs text-[color:var(--color-text-secondary)]">
                    #{attempt.order + 1} {attempt.channel}: {attempt.ok ? "ok" : `failed — ${attempt.error?.code ?? "unknown"}`}
                    {attempt.audioAttached ? " · audio" : " · text only"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {run.transcript ? (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-faint)]">
                {localize(locale, "文字稿", "Transcript")}
              </p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-3 text-xs text-[color:var(--color-text-secondary)]">
                {run.transcript}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
