import { ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { StatusPill } from "@/components/core/primitives";
import type { ProviderTruthAlert, ProviderTruthSnapshot, ProviderTruthStatus } from "@/hooks/use-provider-truth";
import { cn } from "@/lib/utils/cn";
import { localize, type AppLocale } from "@/lib/i18n/localized-text";

function statusTone(status: ProviderTruthStatus): "success" | "warning" | "danger" {
  if (status === "offline") {
    return "danger";
  }
  if (status === "degraded" || status === "unavailable") {
    return "warning";
  }
  return "success";
}

function statusLabel(status: ProviderTruthStatus, locale: AppLocale): string {
  if (status === "offline") {
    return localize(locale, "待连接", "Connect");
  }
  if (status === "unavailable") {
    return localize(locale, "待设置", "Needs setup");
  }
  if (status === "degraded") {
    return localize(locale, "需确认", "Review");
  }
  return localize(locale, "正常", "Healthy");
}

function statusDot(status: ProviderTruthStatus): string {
  if (status === "offline") {
    return "var(--rust-500)";
  }
  if (status === "degraded" || status === "unavailable") {
    return "var(--accent)";
  }
  return "var(--ok)";
}

function backendLabel(backendKind: string | undefined, locale: AppLocale): string {
  if (!backendKind) {
    return localize(locale, "未知后端", "Unknown backend");
  }
  if (backendKind === "http") {
    return "HTTP";
  }
  if (backendKind === "cli") {
    return "CLI";
  }
  if (backendKind === "sdk") {
    return "SDK";
  }
  return backendKind.toUpperCase();
}

function alertHeadline(
  alert: ProviderTruthAlert,
  locale: AppLocale,
): string {
  if (alert.code === "selected_unhealthy") {
    return localize(locale, "当前主 provider 降级", "Current live provider is degraded");
  }
  if (alert.code === "selected_health_missing") {
    return localize(locale, "当前 provider 状态暂不可确认", "Current provider health could not be confirmed");
  }
  if (alert.code === "fallback_unhealthy") {
    return localize(locale, "备用 provider 降级", "Fallback provider is degraded");
  }
  if (alert.code === "fallback_missing") {
    return localize(locale, "缺少备用 provider", "Fallback provider is missing");
  }
  if (alert.code === "route_adjusted") {
    return localize(locale, "真实路由已偏离默认配置", "Live route has moved off the configured default");
  }
  return localize(locale, "需要连接 provider 路由", "Connect provider route");
}

function alertDetail(
  alert: ProviderTruthAlert,
  truth: ProviderTruthSnapshot | undefined,
  locale: AppLocale,
): string {
  if (alert.code === "route_adjusted" && truth?.configured && truth.current) {
    return localize(
      locale,
      `默认配置仍指向 ${truth.configured.providerName} / ${truth.configured.model}，当前真实路由是 ${truth.current.providerName} / ${truth.current.model}。`,
      `The configured default still points to ${truth.configured.providerName} / ${truth.configured.model}, while the live route is ${truth.current.providerName} / ${truth.current.model}.`,
    );
  }
  if (alert.code === "fallback_missing") {
    return localize(
      locale,
      "当前只有主链路可用。添加并配置至少一个备用 provider 后，Friday 才能在主 provider 短暂失败时自动切换。",
      "Only the primary lane is available. Add and configure at least one fallback provider so Friday can switch when the primary provider fails.",
    );
  }
  if (alert.providerName && alert.detail) {
    return `${alert.providerName} · ${alert.detail}`;
  }
  if (alert.detail) {
    return alert.detail;
  }
  if (alert.providerName) {
    return alert.providerName;
  }
  return locale === "zh"
    ? "Friday 需要先确认 provider 路由，才会把任务交给模型。"
    : "Friday needs a confirmed provider route before handing work to a model.";
}

export function ProviderTruthCompact(props: {
  locale: AppLocale;
  truth: ProviderTruthSnapshot | undefined;
  loading?: boolean;
  showModel?: boolean;
  className?: string;
}) {
  const { locale, truth, loading, showModel = true, className } = props;
  const routeStatus = truth?.status ?? truth?.currentStatus ?? "offline";
  const providerName = truth?.current?.providerName
    ?? (loading
      ? localize(locale, "读取 provider…", "Reading provider…")
      : localize(locale, "连接路由", "Connect route"));
  const modelLabel = truth?.current?.model
    ?? (loading ? localize(locale, "加载中", "Loading") : localize(locale, "选择模型", "Choose model"));

  return (
    <span
      aria-live="polite"
      className={cn(
        "inline-flex min-h-[36px] max-w-full items-center gap-2 rounded-[var(--radius-md)] border px-3 py-1.5 text-xs",
        className,
      )}
      style={{
        borderColor: "rgba(15, 125, 140, 0.22)",
        background: "var(--surface-2)",
        color: "var(--ink-700)",
      }}
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: statusDot(routeStatus) }}
      />
      <span className="min-w-0 truncate font-medium">{providerName}</span>
      {showModel ? (
        <span
          className="shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px]"
          style={{
            borderColor: "rgba(15, 125, 140, 0.20)",
            color: "var(--ink-300)",
            fontFamily: "var(--font-mono-jb)",
          }}
        >
          {modelLabel}
        </span>
      ) : null}
      {truth?.alertCount ? (
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
          style={{
            background: "var(--accent-soft)",
            color: "var(--accent)",
          }}
        >
          {localize(locale, `${truth.alertCount} 告警`, `${truth.alertCount} alerts`)}
        </span>
      ) : null}
    </span>
  );
}

export function ProviderTruthCard(props: {
  locale: AppLocale;
  truth: ProviderTruthSnapshot | undefined;
  loading?: boolean;
  variant?: "home" | "rail";
  className?: string;
}) {
  const { locale, truth, loading, variant = "home", className } = props;
  const routeStatus = truth?.status ?? truth?.currentStatus ?? "offline";
  const currentProviderStatus = truth?.currentStatus ?? routeStatus;
  const primaryAlert = truth?.alerts[0];
  const current = truth?.current;
  const cardCopy = {
    eyebrow: localize(locale, "当前实际路由", "Current live route"),
    title: current?.providerName
      ?? (loading
        ? localize(locale, "正在读取当前 provider", "Reading current provider")
        : localize(locale, "连接 provider 路由", "Connect provider route")),
    model: current?.model ?? (loading ? localize(locale, "加载中", "Loading") : localize(locale, "未选择", "Not selected")),
    success: localize(
      locale,
      "当前真实链路已确认，provider health 与 routing explain 一致。",
      "The live route is confirmed and provider health matches routing explain.",
    ),
    source: localize(
      locale,
      "这不是 setup 输入回显；这是 Friday 当前执行任务会实际使用的路由。数据来自 /v1/providers/health、/v1/model-routing、/v1/providers/routing/explain。",
      "This is not a setup form echo; it is the route Friday will actually use for work. Data comes from /v1/providers/health, /v1/model-routing, and /v1/providers/routing/explain.",
    ),
  };

  return (
    <section
      className={cn(
        "rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)]",
        variant === "home" ? "px-4 py-4 shadow-[var(--shadow-floating)]" : "px-4 py-4",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">
            {cardCopy.eyebrow}
          </p>
          <h3
            className={cn(
              "mt-2 text-[color:var(--color-text-primary)]",
              variant === "home" ? "text-lg font-semibold" : "text-base font-semibold",
            )}
            style={{ fontFamily: "var(--font-serif)" }}
          >
            {cardCopy.title}
          </h3>
          <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
            {cardCopy.model} · {backendLabel(current?.backendKind, locale)}
          </p>
        </div>
        <StatusPill tone={statusTone(routeStatus)}>
          {statusLabel(routeStatus, locale)}
        </StatusPill>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">
            {localize(locale, "Provider 状态", "Provider status")}
          </p>
          <div className="mt-2 flex items-center gap-2">
            {currentProviderStatus === "healthy" ? (
              <ShieldCheck className="h-4 w-4 shrink-0" style={{ color: "var(--ok)" }} />
            ) : (
              <ShieldAlert
                className="h-4 w-4 shrink-0"
                style={{ color: currentProviderStatus === "offline" ? "var(--rust-500)" : "var(--accent)" }}
              />
            )}
            <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
              {statusLabel(currentProviderStatus, locale)}
            </p>
          </div>
        </div>

        <div className="rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">
            {localize(locale, "当前模型", "Current model")}
          </p>
          <p
            className="mt-2 break-all text-sm font-medium text-[color:var(--color-text-primary)]"
            style={{ fontFamily: "var(--font-mono-jb)" }}
          >
            {cardCopy.model}
          </p>
        </div>
      </div>

      {primaryAlert ? (
        <div
          className={cn(
            "mt-4 rounded-[18px] border px-3 py-3",
            primaryAlert.tone === "danger"
              ? "border-[color:var(--color-border-danger)] bg-[color:var(--color-bg-danger-subtle)]"
              : "border-[color:var(--color-border-warning)] bg-[color:var(--color-bg-warning-subtle)]",
          )}
        >
          <div className="flex items-start gap-2">
            <TriangleAlert
              className="mt-0.5 h-4 w-4 shrink-0"
              style={{ color: primaryAlert.tone === "danger" ? "var(--color-text-danger)" : "var(--color-text-warning)" }}
            />
            <div className="min-w-0">
              <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                {alertHeadline(primaryAlert, locale)}
              </p>
              <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                {alertDetail(primaryAlert, truth, locale)}
              </p>
              {truth && truth.alerts.length > 1 ? (
                <p className="mt-1 text-[11px] text-[color:var(--color-text-faint)]">
                  {localize(locale, `另有 ${truth.alerts.length - 1} 条相关告警。`, `${truth.alerts.length - 1} more related alerts.`)}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <p className="mt-4 text-sm leading-6 text-[color:var(--color-text-secondary)]">
          {cardCopy.success}
        </p>
      )}

      {truth?.configured ? (
        <p className="mt-3 text-xs leading-5 text-[color:var(--color-text-secondary)]">
          {localize(
            locale,
            `Setup / 默认配置: ${truth.configured.providerName} / ${truth.configured.model}`,
            `Setup / configured default: ${truth.configured.providerName} / ${truth.configured.model}`,
          )}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[color:var(--color-text-faint)]">
        <span>{cardCopy.source}</span>
        {truth?.degradedFallbackCount ? (
          <span>
            {localize(
              locale,
              `${truth.degradedFallbackCount} 个备用 provider 正在降级`,
              `${truth.degradedFallbackCount} fallback providers are degraded`,
            )}
          </span>
        ) : null}
      </div>
    </section>
  );
}
