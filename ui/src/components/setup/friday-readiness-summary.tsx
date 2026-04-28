import { useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, ShieldCheck, TriangleAlert, Wrench } from "lucide-react";
import type {
  FridayHealthResponse,
  FridayRuntimeCapabilityItem,
  FridayRuntimeCapabilityState,
} from "@/lib/api/types";
import { localize } from "@/lib/i18n/localized-text";
import { cn } from "@/lib/utils/cn";

type Locale = "zh" | "en";

export const FRIDAY_SETUP_READINESS_SESSION_KEY = "friday.setupReadinessJustCompleted";

type ReadinessBucketId = "ready" | "verify" | "connect" | "approval" | "unavailable";

type ReadinessBucket = {
  id: ReadinessBucketId;
  title: string;
  helper: string;
  items: string[];
  tone: "success" | "warning" | "muted";
};

type ReadinessDetail = {
  label: string;
  state: FridayRuntimeCapabilityState;
  sources: string[];
  blockers: string[];
};

export type FridayReadinessSummary = {
  buckets: ReadinessBucket[];
  details: ReadinessDetail[];
  headline: string;
  subline: string;
};

const CAPABILITY_LABELS: Record<string, { zh: string; en: string }> = {
  text: { zh: "文本模型", en: "Text model" },
  vision: { zh: "看图", en: "Vision" },
  ocr: { zh: "OCR", en: "OCR" },
  embedding: { zh: "Embedding", en: "Embeddings" },
  web_search: { zh: "网页搜索", en: "Web search" },
  web_fetch: { zh: "网页读取", en: "Web fetch" },
  pdf_parse: { zh: "PDF", en: "PDF" },
  file_read: { zh: "读文件", en: "File read" },
  file_write: { zh: "写文件", en: "File write" },
  tts: { zh: "TTS", en: "TTS" },
  browser: { zh: "浏览器", en: "Browser" },
  mcp: { zh: "MCP", en: "MCP" },
  skills: { zh: "Skills", en: "Skills" },
  custom: { zh: "自定义工具", en: "Custom tools" },
};

const STATE_LABELS: Record<FridayRuntimeCapabilityState, { zh: string; en: string }> = {
  available: { zh: "已打开", en: "Ready" },
  configured_but_unverified: { zh: "待验证", en: "Needs verification" },
  needs_user_auth: { zh: "需要连接账号/权限", en: "Needs account or permission" },
  installable_with_approval: { zh: "审批后可安装", en: "Install after approval" },
  buildable_with_approval: { zh: "审批后可生成", en: "Build after approval" },
  unsupported: { zh: "当前不可用", en: "Unavailable" },
  failed_verification: { zh: "验证失败", en: "Verification failed" },
};

const CHANNEL_LABELS: Record<string, { zh: string; en: string }> = {
  feishu: { zh: "飞书", en: "Feishu" },
  lark: { zh: "Lark", en: "Lark" },
  telegram: { zh: "Telegram", en: "Telegram" },
  discord: { zh: "Discord", en: "Discord" },
};

function pickText(value: { zh: string; en: string }, locale: Locale): string {
  return locale === "zh" ? value.zh : value.en;
}

function capabilityLabel(item: FridayRuntimeCapabilityItem, locale: Locale): string {
  const label = CAPABILITY_LABELS[item.capability];
  if (label) return pickText(label, locale);
  return item.label;
}

function channelLabel(kind: string, locale: Locale): string {
  const label = CHANNEL_LABELS[kind];
  if (label) return pickText(label, locale);
  return kind;
}

function pushUnique(target: string[], values: string[]): void {
  for (const value of values) {
    if (value && !target.includes(value)) {
      target.push(value);
    }
  }
}

function stateBucket(state: FridayRuntimeCapabilityState): ReadinessBucketId {
  switch (state) {
    case "available":
      return "ready";
    case "configured_but_unverified":
      return "verify";
    case "needs_user_auth":
    case "failed_verification":
      return "connect";
    case "installable_with_approval":
    case "buildable_with_approval":
      return "approval";
    case "unsupported":
      return "unavailable";
  }
}

function bucketCopy(id: ReadinessBucketId, locale: Locale): Omit<ReadinessBucket, "items"> {
  switch (id) {
    case "ready":
      return {
        id,
        title: localize(locale, "已打开", "Ready"),
        helper: localize(locale, "这些现在可以直接用。", "These are available now."),
        tone: "success",
      };
    case "verify":
      return {
        id,
        title: localize(locale, "待验证", "Needs verification"),
        helper: localize(locale, "已经发现入口，但要跑一次验证才算真正可用。", "Sources exist, but Friday needs a probe before trusting them."),
        tone: "warning",
      };
    case "connect":
      return {
        id,
        title: localize(locale, "需要连接账号/权限", "Needs account or permission"),
        helper: localize(
          locale,
          "Friday 会自动使用已验证来源；没有来源时，需要你补账号、模型或本机权限。",
          "Friday will use verified sources automatically; missing sources need an account, model, or local permission.",
        ),
        tone: "warning",
      };
    case "approval":
      return {
        id,
        title: localize(locale, "需要审批后才会动", "Approval required"),
        helper: localize(
          locale,
          "MCP、生成/安装工具、第三方安装、写配置都会先发 approval。",
          "MCP, generated tools, third-party installs, and config writes pause for approval.",
        ),
        tone: "muted",
      };
    case "unavailable":
      return {
        id,
        title: localize(locale, "当前不可用", "Unavailable"),
        helper: localize(locale, "运行环境没有打开这些边界。", "The runtime has not opened these boundaries."),
        tone: "muted",
      };
  }
}

export function buildFridayReadinessSummary(
  health: FridayHealthResponse | undefined,
  locale: Locale,
): FridayReadinessSummary {
  const items = health?.capabilities?.runtime?.items ?? [];
  const grouped: Record<ReadinessBucketId, string[]> = {
    ready: [],
    verify: [],
    connect: [],
    approval: [],
    unavailable: [],
  };

  for (const item of items) {
    grouped[stateBucket(item.state)].push(capabilityLabel(item, locale));
  }

  const enabledChannels = health?.capabilities?.channels?.enabledKinds ?? [];
  pushUnique(grouped.ready, enabledChannels.map((kind) => channelLabel(kind, locale)));

  if (health?.capabilities?.system?.enabled === false) {
    pushUnique(grouped.unavailable, [localize(locale, "系统编排", "System orchestration")]);
  }
  if (health?.capabilities?.system?.companionConnected === false) {
    pushUnique(grouped.unavailable, [localize(locale, "桌面控制", "Desktop control")]);
  }
  if (health?.capabilities?.search?.latestness === "unverified") {
    pushUnique(grouped.verify, [localize(locale, "搜索时效性", "Search freshness")]);
  }
  pushUnique(grouped.approval, [
    localize(locale, "第三方安装", "Third-party installs"),
    localize(locale, "写配置", "Config writes"),
  ]);

  const details = items.map((item) => ({
    label: capabilityLabel(item, locale),
    state: item.state,
    sources: item.sources.map((source) => source.label),
    blockers: item.blockers,
  }));

  const buckets = (["ready", "verify", "connect", "approval", "unavailable"] as const).map((id) => ({
    ...bucketCopy(id, locale),
    items: grouped[id],
  }));

  const readyCount = grouped.ready.length;
  const gapCount = grouped.verify.length + grouped.connect.length + grouped.approval.length + grouped.unavailable.length;
  return {
    buckets,
    details,
    headline: localize(locale, "Friday 当前可用状态", "Friday readiness"),
    subline: gapCount > 0
      ? localize(
          locale,
          `已打开 ${readyCount} 项，还有 ${gapCount} 项需要验证、连接或审批。`,
          `${readyCount} ready, ${gapCount} need verification, connection, or approval.`,
        )
      : localize(locale, `已打开 ${readyCount} 项，可以直接使用。`, `${readyCount} ready and available.`),
  };
}

function toneClass(tone: ReadinessBucket["tone"]): string {
  if (tone === "success") return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (tone === "warning") return "border-amber-200 bg-amber-50 text-amber-950";
  return "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] text-[color:var(--color-text-primary)]";
}

function toneIcon(tone: ReadinessBucket["tone"]) {
  if (tone === "success") return <CheckCircle2 className="h-4 w-4" />;
  if (tone === "warning") return <TriangleAlert className="h-4 w-4" />;
  return <Wrench className="h-4 w-4" />;
}

export function FridayReadinessSummaryPanel({
  health,
  locale,
  className,
  onDismiss,
}: {
  health?: FridayHealthResponse;
  locale: Locale;
  className?: string;
  onDismiss?: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const summary = useMemo(() => buildFridayReadinessSummary(health, locale), [health, locale]);

  return (
    <section
      className={cn(
        "rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-5 shadow-[var(--shadow-floating)]",
        className,
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
            <ShieldCheck className="h-4 w-4 text-[color:var(--color-accent)]" />
            <span>{summary.headline}</span>
          </div>
          <p className="mt-2 text-sm leading-6 text-[color:var(--color-text-secondary)]">{summary.subline}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setShowDetails((value) => !value)}
            className="inline-flex min-h-[34px] items-center gap-1 rounded-[var(--radius-md)] border border-[color:var(--color-border-soft)] px-3 text-xs font-medium text-[color:var(--color-text-secondary)] transition hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-text-primary)]"
          >
            {localize(locale, "高级详情", "Advanced details")}
            {showDetails ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              className="min-h-[34px] rounded-[var(--radius-md)] px-3 text-xs text-[color:var(--color-text-faint)] transition hover:bg-[color:var(--color-bg-subtle)] hover:text-[color:var(--color-text-primary)]"
            >
              {localize(locale, "隐藏", "Hide")}
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {summary.buckets
          .filter((bucket) => bucket.items.length > 0)
          .slice(0, 4)
          .map((bucket) => (
            <div key={bucket.id} className={cn("rounded-[18px] border px-4 py-3", toneClass(bucket.tone))}>
              <div className="flex items-center gap-2 text-xs font-semibold">
                {toneIcon(bucket.tone)}
                <span>{bucket.title}</span>
              </div>
              <p className="mt-2 text-xs leading-5 opacity-80">{bucket.helper}</p>
              <p className="mt-3 text-sm font-medium leading-6">{bucket.items.slice(0, 5).join(locale === "zh" ? "、" : ", ")}</p>
            </div>
          ))}
      </div>

      {showDetails ? (
        <div className="mt-4 rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4">
          <div className="grid gap-2 md:grid-cols-2">
            {summary.details.map((detail) => (
              <div key={detail.label} className="rounded-[14px] bg-[color:var(--color-bg-surface)] px-3 py-3 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold text-[color:var(--color-text-primary)]">{detail.label}</span>
                  <span className="text-[color:var(--color-text-secondary)]">
                    {pickText(STATE_LABELS[detail.state], locale)}
                  </span>
                </div>
                <p className="mt-2 line-clamp-2 text-[color:var(--color-text-faint)]">
                  {detail.sources[0] ?? detail.blockers[0] ?? localize(locale, "暂无来源", "No source yet")}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
