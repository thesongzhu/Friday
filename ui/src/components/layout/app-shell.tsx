import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Globe2, Home, ListFilter, Menu, MessageCircle, PanelRightClose, Settings, ShieldCheck, Sparkles, type LucideIcon } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { ChatSidePanel } from "@/components/chat/chat-side-panel";
import { useAuth } from "@/hooks/use-auth";
import { useHomeSurfacePreferences } from "@/hooks/use-home-surface-preferences";
import { useUserProfile } from "@/hooks/use-user-profile";
import { completeClientRouteTransition } from "@/lib/diagnostics/client-stability";
import { resolveLocalizedText, localize } from "@/lib/i18n/localized-text";
import { AGENT_OS_NAV_PRIMARY, AGENT_OS_NAV_ADVANCED, resolvePageTitle } from "@/lib/routes/agent-os-nav";
import { ActionButton, LiveIndicator } from "@/components/core/primitives";
import { CommandPalette } from "@/components/core/command-palette";
import { recordNavVisit, sortNavByFrequency } from "@/lib/uix/adaptive-layout";
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
  const [showCommandPalette, setShowCommandPalette] = useState(false);

  // ─── Right chat panel resize ───
  const CHAT_PANEL_STORAGE_KEY = "friday.chat-panel-width";
  const CHAT_PANEL_MIN = 280;
  const CHAT_PANEL_MAX = 520;
  const CHAT_PANEL_DEFAULT = 340;

  const isOnChatPage = location.pathname === "/chat";

  const [chatPanelWidth, setChatPanelWidth] = useState(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(CHAT_PANEL_STORAGE_KEY) : null;
    const parsed = stored ? Number.parseInt(stored, 10) : Number.NaN;
    return Number.isFinite(parsed) ? Math.max(CHAT_PANEL_MIN, Math.min(CHAT_PANEL_MAX, parsed)) : CHAT_PANEL_DEFAULT;
  });
  const isDraggingRef = useRef(false);
  const chatPanelRef = useRef<HTMLDivElement>(null);
  const mainScrollRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<number | null>(null);

  // Auto-hide scrollbar: add .is-scrolling on scroll, remove after 1s idle
  useEffect(() => {
    const el = mainScrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      el.classList.add("is-scrolling");
      if (scrollTimerRef.current !== null) {
        window.clearTimeout(scrollTimerRef.current);
      }
      scrollTimerRef.current = window.setTimeout(() => {
        el.classList.remove("is-scrolling");
        scrollTimerRef.current = null;
      }, 1000);
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
      if (scrollTimerRef.current !== null) {
        window.clearTimeout(scrollTimerRef.current);
      }
    };
  }, []);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const newWidth = window.innerWidth - ev.clientX;
      const clamped = Math.max(CHAT_PANEL_MIN, Math.min(CHAT_PANEL_MAX, newWidth));
      setChatPanelWidth(clamped);
    };

    const handleUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      // Persist
      setChatPanelWidth((w) => {
        window.localStorage.setItem(CHAT_PANEL_STORAGE_KEY, String(w));
        return w;
      });
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  }, []);

  // Cmd+K / Ctrl+K to open command palette
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowCommandPalette((v) => !v);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

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
    recordNavVisit(location.pathname);
  }, [location.pathname, rememberPrimarySurface]);

  // Mobile more panel state
  const [showMobileMore, setShowMobileMore] = useState(false);

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
  const advancedNav = useMemo(() => {
    const items = AGENT_OS_NAV_ADVANCED.map((item) => ({
      ...item,
      labelText: resolveLocalizedText(item.label, locale),
      descriptionText: resolveLocalizedText(item.description, locale),
    }));
    // Sort by visit frequency — most used pages first
    const freqOrder = sortNavByFrequency(items.map((i) => i.path));
    if (freqOrder.length > 0) {
      items.sort((a, b) => {
        const aIdx = freqOrder.indexOf(a.path);
        const bIdx = freqOrder.indexOf(b.path);
        return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
      });
    }
    return items;
  }, [locale]);

  return (
    <div className="min-h-screen bg-[color:var(--color-bg-base)] text-[color:var(--color-text-primary)] lg:h-screen lg:overflow-hidden">
      <div className="relative flex min-h-screen w-full pb-24 lg:h-full lg:min-h-0 lg:pb-0">
        <aside data-testid="app-shell-rail" role="navigation" aria-label="Main navigation" className="hidden lg:block lg:w-[248px] lg:shrink-0">
          <div className="flex h-full flex-col border-r border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-chrome)] px-4 py-5 shadow-[inset_-1px_0_0_rgba(51,41,34,0.04)] backdrop-blur-md">
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

            <nav className="mt-4 border-t border-[color:var(--color-border-soft)] pt-4">
              <NavLink
                to="/settings"
                className={({ isActive }) => cn(
                  "flex items-center gap-3 px-3",
                  locale === "zh"
                    ? "min-h-[44px] rounded-[14px] py-2.5"
                    : "min-h-[48px] rounded-[18px] py-3",
                  isActive
                    ? "bg-[color:var(--color-accent-soft)] text-[color:var(--color-text-primary)]"
                    : "text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-subtle)] hover:text-[color:var(--color-text-primary)]",
                )}
              >
                <Settings className="h-4 w-4 shrink-0" />
                <p className="text-sm font-medium">{localize(locale, "设置", "Settings")}</p>
              </NavLink>
            </nav>

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

        <div ref={mainScrollRef} className="scrollbar-autohide min-w-0 flex flex-1 flex-col overflow-y-auto px-4 pt-4 lg:px-5 lg:pt-3">
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
                  onClick={() => setShowMobileMore((value) => !value)}
                  className="flex min-h-[44px] items-center gap-2 rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-secondary)] transition hover:text-[color:var(--color-text-primary)]"
                >
                  {showMobileMore ? <PanelRightClose className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
                  <span>{localize(locale, "更多", "More")}</span>
                </button>
              </div>
            </div>
          </header>

          {showMobileMore ? (
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
                    onClick={() => setShowMobileMore(false)}
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

          <main className="flex w-full flex-1 justify-start pt-2 lg:pt-1">
            <div className={cn("w-full", isOnChatPage ? "max-w-4xl" : "")}>
              {!isOnChatPage && <QuickAccessBar items={advancedNav} locale={locale} />}
              <Outlet />
            </div>
          </main>
        </div>

        {/* ─── Right chat panel (desktop only, hidden on /chat) ─── */}
        {!isOnChatPage && (
          <aside
            ref={chatPanelRef}
            className="relative hidden lg:flex h-full flex-col shrink-0 border-l border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)]"
            style={{ width: chatPanelWidth }}
          >
            {/* Resize handle — thin strip on the left edge */}
            <div
              onMouseDown={handleResizeStart}
              className="absolute inset-y-0 left-0 z-10 w-[3px] cursor-col-resize transition-colors hover:bg-[color:var(--color-accent)] active:bg-[color:var(--color-accent)]"
              role="separator"
              aria-orientation="vertical"
            />
            <ChatSidePanel />
          </aside>
        )}
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
            onClick={() => setShowMobileMore((value) => !value)}
            className="flex min-h-[52px] flex-col items-center justify-center rounded-2xl text-[11px] font-medium text-[color:var(--color-text-secondary)]"
          >
            <Menu className="mb-1 h-4 w-4" />
            <span>{localize(locale, "更多", "More")}</span>
          </button>
        </div>
      </nav>

      {showCommandPalette && (
        <CommandPalette locale={locale} onClose={() => setShowCommandPalette(false)} />
      )}
    </div>
  );
}
