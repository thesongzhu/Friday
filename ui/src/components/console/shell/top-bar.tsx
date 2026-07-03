import { Command, Globe2, Menu, PanelRightClose } from "lucide-react";
import { ProviderTruthCompact } from "@/components/console/shell/provider-truth";
import { useProviderTruthQuery } from "@/hooks/use-provider-truth";
import { useSystemHealthQuery, type SystemHealthStatus } from "@/hooks/use-system-health";
import { localize, type AppLocale } from "@/lib/i18n/localized-text";

function navigatorMetaKeyLabel(): string {
  if (typeof navigator === "undefined") return "⌘";
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
}

function liveIndicatorParts(status: SystemHealthStatus, locale: AppLocale) {
  if (status === "offline") {
    return {
      color: "var(--rust-500)",
      label: localize(locale, "离线", "Offline"),
    };
  }
  if (status === "unavailable") {
    return {
      color: "var(--accent)",
      label: localize(locale, "能力暂不可用", "Unavailable"),
    };
  }
  if (status === "degraded") {
    return {
      color: "var(--accent)",
      label: localize(locale, "部分降级", "Degraded"),
    };
  }
  return {
    color: "var(--ok)",
    label: localize(locale, "Friday 运行中", "Friday online"),
  };
}

export function TopBar(props: {
  currentPageTitle: string;
  locale: AppLocale;
  onOpenPalette: () => void;
}) {
  const { currentPageTitle, locale, onOpenPalette } = props;
  const { data: health } = useSystemHealthQuery();
  const providerTruthQuery = useProviderTruthQuery();
  const status = health?.status ?? "healthy";
  const { color, label } = liveIndicatorParts(status, locale);
  const kbdLabel = navigatorMetaKeyLabel();

  return (
    <header
      className="sticky top-0 z-30 hidden border-b lg:flex lg:items-center lg:justify-between lg:px-5"
      style={{
        height: "var(--shell-topbar-h)",
        background: "var(--surface-1)",
        borderColor: "var(--surface-border)",
      }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          data-testid="desktop-friday-brand"
          className="shrink-0 text-sm font-semibold tracking-tight"
          style={{ color: "var(--ink-900)" }}
        >Friday</span>
        <span
          aria-hidden="true"
          className="h-4 w-px shrink-0"
          style={{ background: "var(--surface-border)" }}
        />
        <h2
          className="truncate text-sm font-semibold tracking-tight"
          style={{ color: "var(--ink-900)" }}
        >
          {currentPageTitle}
        </h2>
      </div>

      <div className="flex items-center gap-3">
        <LiveIndicator color={color} label={label} />
        <ProviderTruthCompact
          locale={locale}
          truth={providerTruthQuery.data}
          loading={providerTruthQuery.isPending}
          className="max-w-[360px]"
        />
        <button
          type="button"
          onClick={onOpenPalette}
          aria-label={localize(locale, "打开命令面板", "Open command palette")}
          className="inline-flex min-h-[36px] items-center gap-2 rounded-[var(--radius-md)] border px-3 text-xs transition-colors hover:bg-[color:var(--accent-soft)]"
          style={{
            borderColor: "rgba(15, 125, 140, 0.22)",
            background: "var(--surface-2)",
            color: "var(--ink-500)",
          }}
        >
          <Command className="h-3.5 w-3.5" />
          <span>{localize(locale, "命令面板", "Command")}</span>
          <kbd
            className="rounded border px-1 py-0.5 font-mono text-[10px]"
            style={{
              borderColor: "rgba(15, 125, 140, 0.20)",
              color: "var(--ink-300)",
              fontFamily: "var(--font-mono-jb)",
            }}
          >
            {kbdLabel}K
          </kbd>
        </button>
      </div>
    </header>
  );
}

function LiveIndicator(props: { color: string; label: string }) {
  return (
    <span
      aria-live="polite"
      className="inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{
        background: "var(--surface-2)",
        color: "var(--ink-700)",
        border: "1px solid var(--surface-border)",
      }}
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 rounded-full"
        style={{ background: props.color }}
      />
      {props.label}
    </span>
  );
}

export function MobileTopBar(props: {
  currentPageTitle: string;
  locale: AppLocale;
  showMobileMore: boolean;
  onToggleMobileMore: () => void;
  onToggleLocale: () => void;
}) {
  const { currentPageTitle, locale, showMobileMore, onToggleMobileMore, onToggleLocale } = props;
  const { data: health } = useSystemHealthQuery();
  const providerTruthQuery = useProviderTruthQuery();
  const status = health?.status ?? "healthy";
  const { color, label } = liveIndicatorParts(status, locale);

  return (
    <header
      className="sticky top-0 z-30 flex items-center justify-between border-b px-4 lg:hidden"
      style={{
        height: "var(--shell-mobile-topbar-h)",
        background: "var(--surface-1)",
        borderColor: "var(--surface-border)",
      }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onToggleMobileMore}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border"
          style={{
            borderColor: "rgba(15, 125, 140, 0.22)",
            background: "var(--surface-2)",
            color: "var(--ink-700)",
          }}
          aria-label={localize(locale, "打开命令面板", "Open command sheet")}
          aria-expanded={showMobileMore}
        >
          {showMobileMore ? <PanelRightClose className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </button>
        <div className="min-w-0">
          <p
            className="text-[10px] font-semibold uppercase tracking-[0.16em]"
            style={{ color: "var(--ink-300)" }}
          >
            Friday
          </p>
          <h1
            className="truncate text-sm font-semibold tracking-tight"
            style={{ color: "var(--ink-900)" }}
          >
            {currentPageTitle}
          </h1>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <LiveIndicator color={color} label={label} />
        <ProviderTruthCompact
          locale={locale}
          truth={providerTruthQuery.data}
          loading={providerTruthQuery.isPending}
          showModel={false}
          className="max-w-[148px] px-2.5"
        />
        <button
          type="button"
          onClick={onToggleLocale}
          className="flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] border px-2 text-xs"
          style={{
            borderColor: "rgba(15, 125, 140, 0.22)",
            background: "var(--surface-2)",
            color: "var(--ink-700)",
          }}
          aria-label={localize(locale, "切换语言", "Toggle language")}
        >
          <Globe2 className="h-4 w-4" />
          <span>{locale === "zh" ? "中" : "EN"}</span>
        </button>
      </div>
    </header>
  );
}
