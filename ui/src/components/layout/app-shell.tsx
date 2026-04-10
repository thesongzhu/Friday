import { useEffect, useMemo, useState } from "react";
import { Globe2, Home, ListFilter, Menu, MessageCircle, PanelRightClose, ShieldCheck, Sparkles, type LucideIcon } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { useHomeSurfacePreferences } from "@/hooks/use-home-surface-preferences";
import { useUserProfile } from "@/hooks/use-user-profile";
import { completeClientRouteTransition } from "@/lib/diagnostics/client-stability";
import { resolveLocalizedText, localize } from "@/lib/i18n/localized-text";
import { AGENT_OS_NAV_PRIMARY, AGENT_OS_NAV_ADVANCED, resolvePageTitle } from "@/lib/routes/agent-os-nav";
import { ActionButton, LiveIndicator } from "@/components/core/primitives";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";
import { QuickAccessBar } from "@/components/layout/quick-access-bar";

const PRIMARY_NAV_ICONS: Record<string, LucideIcon> = {
  "/home": Home,
  "/chat": MessageCircle,
  "/packs": ListFilter,
  "/assistant": Sparkles,
};

export function AppShell() {
  const location = useLocation();
  const { user, logout } = useAuth();
  const { profileType } = useUserProfile();
  const { rememberPrimarySurface } = useHomeSurfacePreferences(profileType);
  const { locale, setLocale } = useAppLocale();
  const [showMore, setShowMore] = useState(locale === "zh");

  const pageTitle = resolvePageTitle(location.pathname);

  useEffect(() => {
    if (location.pathname === "/home") {
      rememberPrimarySurface("home");
    } else if (location.pathname === "/chat") {
      rememberPrimarySurface("chat");
    } else if (location.pathname === "/packs") {
      rememberPrimarySurface("packs");
    } else if (location.pathname === "/assistant") {
      rememberPrimarySurface("assistant");
    }
  }, [location.pathname, rememberPrimarySurface]);

  useEffect(() => {
    if (locale === "zh") {
      setShowMore(true);
    } else {
      setShowMore(false);
    }
  }, [location.pathname, locale]);

  useEffect(() => {
    completeClientRouteTransition(location.pathname);
  }, [location.pathname]);

  const currentPageTitle = resolveLocalizedText(pageTitle, locale);
  const primaryNav = useMemo(
    () => AGENT_OS_NAV_PRIMARY.map((item) => ({
      ...item,
      labelText: resolveLocalizedText(item.label, locale),
      descriptionText: resolveLocalizedText(item.description, locale),
      Icon: PRIMARY_NAV_ICONS[item.path] ?? Sparkles,
    })),
    [locale],
  );
  const advancedNav = useMemo(
    () => AGENT_OS_NAV_ADVANCED.map((item) => ({
      ...item,
      labelText: resolveLocalizedText(item.label, locale),
      descriptionText: resolveLocalizedText(item.description, locale),
    })),
    [locale],
  );

  return (
    <div className="min-h-screen bg-[color:var(--color-bg-base)] text-[color:var(--color-text-primary)]">
      <div className="relative flex min-h-screen w-full pb-24 lg:pb-0">
        <aside data-testid="app-shell-rail" role="navigation" aria-label="Main navigation" className="hidden lg:block lg:w-[248px] lg:shrink-0">
          <div className="sticky top-0 flex min-h-screen flex-col border-r border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-chrome)] px-4 py-5 shadow-[inset_-1px_0_0_rgba(51,41,34,0.04)] backdrop-blur-md">
            <div className="border-b border-[color:var(--color-border-soft)] pb-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[color:var(--color-text-faint)]">Friday</p>
              <h1 className="mt-2 text-xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
                {currentPageTitle}
              </h1>
            </div>

            <nav className="mt-4 space-y-1.5">
              {primaryNav.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={({ isActive }) => cn(
                    "flex items-center gap-3 px-3 transition-colors",
                    locale === "zh"
                      ? "min-h-[44px] rounded-[14px] py-2.5"
                      : "min-h-[48px] rounded-[18px] py-3",
                    isActive
                      ? "bg-[color:var(--color-accent-soft)] text-[color:var(--color-text-primary)]"
                      : "text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-subtle)] hover:text-[color:var(--color-text-primary)]",
                  )}
                >
                  <item.Icon className="h-4 w-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{item.labelText}</p>
                  </div>
                </NavLink>
              ))}
            </nav>

            <div className="mt-4 border-t border-[color:var(--color-border-soft)] pt-4">
              <button
                type="button"
                onClick={() => setShowMore((value) => !value)}
                className="flex w-full min-h-[44px] items-center justify-between rounded-2xl px-3 text-sm text-[color:var(--color-text-secondary)] transition hover:bg-[color:var(--color-bg-subtle)] hover:text-[color:var(--color-text-primary)]"
              >
                <span>{localize(locale, "更多入口", "More")}</span>
                {showMore ? <PanelRightClose className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
              </button>

              {showMore ? (
                <div className="mt-2 space-y-2">
                  {advancedNav.map((item) => (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      className="block rounded-2xl px-3 py-2.5 transition hover:bg-[color:var(--color-bg-subtle)]"
                    >
                      <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{item.labelText}</p>
                      <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">{item.descriptionText}</p>
                    </NavLink>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="mt-auto space-y-2 border-t border-[color:var(--color-border-soft)] pt-4">
              {locale === "zh" && (
                <LiveIndicator label="Friday 运行中" active className="px-3 pb-1" />
              )}
              <button
                type="button"
                onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
                className="flex min-h-[44px] w-full items-center gap-2 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-secondary)] transition hover:text-[color:var(--color-text-primary)]"
              >
                <Globe2 className="h-4 w-4" />
                <span>{locale === "zh" ? "中文" : "English"}</span>
              </button>
              <ActionButton tone="secondary" onClick={() => void logout()} className="w-full justify-start">
                <ShieldCheck className="mr-2 h-4 w-4" />
                {user?.displayName ?? localize(locale, "当前用户", "Current User")}
              </ActionButton>
            </div>
          </div>
        </aside>

        <div className="min-w-0 flex flex-1 flex-col px-4 pt-4 lg:px-8 lg:pt-5">
          <header className="sticky top-4 z-30 rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-chrome)] px-4 py-3 shadow-[var(--shadow-floating)] backdrop-blur-md lg:hidden">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">Friday</p>
                <h1 className="truncate text-base font-semibold tracking-tight text-[color:var(--color-text-primary)]">
                  {currentPageTitle}
                </h1>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
                  className="flex min-h-[44px] items-center gap-2 rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-secondary)] transition hover:text-[color:var(--color-text-primary)]"
                >
                  <Globe2 className="h-4 w-4" />
                  <span>{locale === "zh" ? "中文" : "English"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowMore((value) => !value)}
                  className="flex min-h-[44px] items-center gap-2 rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-secondary)] transition hover:text-[color:var(--color-text-primary)]"
                >
                  {showMore ? <PanelRightClose className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
                  <span>{localize(locale, "更多", "More")}</span>
                </button>
              </div>
            </div>
          </header>

          {showMore ? (
            <div className="mt-4 rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4 shadow-[var(--shadow-floating)] lg:hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--color-border-soft)] pb-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
                    {localize(locale, "操作入口", "More")}
                  </p>
                  <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
                    {user?.displayName ?? localize(locale, "当前用户", "Current User")}
                  </p>
                </div>
                <ActionButton tone="secondary" onClick={() => void logout()}>
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  {localize(locale, "退出登录", "Sign Out")}
                </ActionButton>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {advancedNav.map((item) => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    onClick={() => setShowMore(false)}
                    className="rounded-3xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4 transition hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-surface-strong)]"
                  >
                    <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">
                      {item.labelText}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                      {item.descriptionText}
                    </p>
                  </NavLink>
                ))}
              </div>
            </div>
          ) : null}

          <main className="flex w-full flex-1 justify-start pt-4 lg:pt-2">
            <div className="w-full max-w-5xl">
              {locale === "zh" && (
                <QuickAccessBar items={AGENT_OS_NAV_ADVANCED} locale={locale} />
              )}
              <Outlet />
            </div>
          </main>
        </div>
      </div>

      <nav aria-label="Mobile navigation" className="fixed inset-x-0 bottom-0 z-30 border-t border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-chrome-strong)] px-3 py-2 backdrop-blur-xl lg:hidden">
        <div className="mx-auto grid max-w-2xl grid-cols-5 gap-2">
          {primaryNav.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) => cn(
                "flex min-h-[52px] flex-col items-center justify-center rounded-2xl text-[11px] font-medium transition-colors",
                isActive
                  ? "bg-[color:var(--color-accent-soft)] text-[color:var(--color-text-primary)]"
                  : "text-[color:var(--color-text-secondary)]",
              )}
            >
              {item.path === "/home" ? <Home className="mb-1 h-4 w-4" /> : null}
              {item.path === "/chat" ? <MessageCircle className="mb-1 h-4 w-4" /> : null}
              {item.path === "/packs" ? <ListFilter className="mb-1 h-4 w-4" /> : null}
              {item.path === "/assistant" ? <Sparkles className="mb-1 h-4 w-4" /> : null}
              <span>{item.labelText}</span>
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => setShowMore((value) => !value)}
            className="flex min-h-[52px] flex-col items-center justify-center rounded-2xl text-[11px] font-medium text-[color:var(--color-text-secondary)]"
          >
            <Menu className="mb-1 h-4 w-4" />
            <span>{localize(locale, "更多", "More")}</span>
          </button>
        </div>
      </nav>
    </div>
  );
}
