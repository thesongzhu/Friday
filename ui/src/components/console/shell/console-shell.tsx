import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Activity, FileText, ShieldCheck } from "lucide-react";
import { ProviderTruthCompact } from "@/components/console/shell/provider-truth";
import { CommandPalette } from "@/components/core/command-palette";
import { useCustomPacks } from "@/hooks/use-custom-packs";
import { useHomeSurfacePreferences } from "@/hooks/use-home-surface-preferences";
import { useProviderTruthQuery } from "@/hooks/use-provider-truth";
import { useSystemHealthQuery } from "@/hooks/use-system-health";
import { useUserProfile } from "@/hooks/use-user-profile";
import { onCommandPaletteOpenRequest } from "@/lib/command-palette";
import { completeClientRouteTransition } from "@/lib/diagnostics/client-stability";
import { localize, resolveLocalizedText } from "@/lib/i18n/localized-text";
import { AGENT_OS_NAV_ADVANCED, AGENT_OS_NAV_PRIMARY, resolvePageTitle } from "@/lib/routes/agent-os-nav";
import { recordNavVisit } from "@/lib/uix/adaptive-layout";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";
import { Rail } from "./rail";
import { RightRail } from "./right-rail";
import { MobileTopBar, TopBar } from "./top-bar";

const RAIL_COLLAPSED_KEY = "friday.shell.rail-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // ignore
  }
}

export function ConsoleShell() {
  const location = useLocation();
  useCustomPacks();
  const { profileType } = useUserProfile();
  const { rememberPrimarySurface } = useHomeSurfacePreferences(profileType);
  const { locale, setLocale } = useAppLocale();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [showMobileMore, setShowMobileMore] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => readCollapsed());

  const mainScrollRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<number | null>(null);

  const pageTitle = resolvePageTitle(location.pathname);
  const currentPageTitle = resolveLocalizedText(pageTitle, locale);

  // Auto-hide scrollbar — mirrors the old shell so style regression is limited.
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

  // Cmd+K / Ctrl+K toggles the command palette.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => onCommandPaletteOpenRequest(() => setPaletteOpen(true)), []);

  // Adaptive-layout bookkeeping + remember last primary surface.
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

  // Close mobile "More" overlay on route change.
  useEffect(() => {
    setShowMobileMore(false);
  }, [location.pathname]);

  // Client-stability perf marks.
  useEffect(() => {
    completeClientRouteTransition(location.pathname);
  }, [location.pathname]);

  const commandSheetItems = useMemo(
    () => [...AGENT_OS_NAV_PRIMARY, ...AGENT_OS_NAV_ADVANCED].map((item) => ({
      ...item,
      labelText: resolveLocalizedText(item.label, locale),
      descriptionText: resolveLocalizedText(item.description, locale),
    })),
    [locale],
  );

  const isOnChatPage = location.pathname === "/chat";
  const showDesktopTopBar = location.pathname !== "/home";

  return (
    <div
      className="min-h-screen"
      style={{
        background: "var(--surface-0)",
        color: "var(--ink-900)",
      }}
    >
      <div className="relative flex min-h-screen w-full lg:h-screen lg:overflow-hidden">
        <Rail
          collapsed={railCollapsed}
          onToggleCollapse={() => {
            setRailCollapsed((v) => {
              const next = !v;
              writeCollapsed(next);
              return next;
            });
          }}
        />

        <div
          ref={mainScrollRef}
          className={cn(
            "scrollbar-autohide flex min-w-0 flex-1 flex-col",
            isOnChatPage ? "overflow-hidden" : "overflow-y-auto",
          )}
        >
          {showDesktopTopBar ? (
            <TopBar
              currentPageTitle={currentPageTitle}
              locale={locale}
              onOpenPalette={() => setPaletteOpen(true)}
            />
          ) : null}
          <MobileTopBar
            currentPageTitle={currentPageTitle}
            locale={locale}
            showMobileMore={showMobileMore}
            onToggleMobileMore={() => setShowMobileMore((v) => !v)}
            onToggleLocale={() => setLocale(locale === "zh" ? "en" : "zh")}
          />

          {showMobileMore ? (
            <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
              <button
                type="button"
                aria-label={localize(locale, "关闭命令面板", "Close command sheet")}
                className="absolute inset-0 w-full bg-black/20"
                onClick={() => setShowMobileMore(false)}
              />
              <div
                className="absolute inset-x-0 bottom-0 max-h-[82vh] overflow-y-auto rounded-t-[22px] border px-4 pb-5 pt-2 shadow-[0_-12px_44px_rgba(0,0,0,0.22)]"
                style={{
                  borderColor: "rgba(122, 106, 88, 0.18)",
                  background: "var(--surface-2)",
                }}
              >
                <div
                  aria-hidden="true"
                  className="mx-auto mb-3 h-1.5 w-11 rounded-full"
                  style={{ background: "rgba(122, 106, 88, 0.22)" }}
                />
              <div className="flex items-center justify-between gap-3 border-b pb-3" style={{ borderColor: "rgba(122, 106, 88, 0.18)" }}>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--ink-300)" }}>
                    {localize(locale, "命令面板", "Command Sheet")}
                  </p>
                  <p className="mt-0.5 text-sm" style={{ color: "var(--ink-700)" }}>
                    {localize(locale, "搜索、跳转、让 Friday 处理", "Search, jump, ask Friday")}
                  </p>
                </div>
                <p className="text-xs" style={{ color: "var(--ink-500)" }}>
                  {localize(locale, "Hub 投影", "Hub projected")}
                </p>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                {commandSheetItems.map((item) => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    onClick={() => setShowMobileMore(false)}
                    className="min-h-[88px] rounded-[var(--radius-md)] border px-3 py-3"
                    style={{
                      borderColor: "rgba(122, 106, 88, 0.18)",
                      background: "var(--surface-2)",
                    }}
                  >
                    <p className="text-sm font-medium" style={{ color: "var(--ink-900)" }}>
                      {item.labelText}
                    </p>
                    <p className="mt-0.5 text-xs leading-5" style={{ color: "var(--ink-500)" }}>
                      {item.descriptionText}
                    </p>
                  </NavLink>
                ))}
              </div>
              </div>
            </div>
          ) : null}

          <DesktopHubStrip locale={locale} />

          <main
            className={cn(
              "flex w-full flex-1 justify-start px-4 pt-3 lg:px-5 lg:pt-3",
              isOnChatPage && "min-h-0 pb-3 lg:pb-4",
            )}
          >
            <div
              className={cn("w-full", isOnChatPage && "flex min-h-0 flex-1 flex-col")}
              style={{
                maxWidth: isOnChatPage ? undefined : "var(--shell-content-max-w)",
              }}
            >
              <Outlet />
            </div>
          </main>

          {!isOnChatPage ? <DesktopProofDock locale={locale} /> : null}
        </div>

        <RightRail />
      </div>

      {paletteOpen ? (
        <CommandPalette locale={locale} onClose={() => setPaletteOpen(false)} />
      ) : null}
    </div>
  );
}

function DesktopHubStrip(props: { locale: "zh" | "en" }) {
  const { locale } = props;
  const { data: health } = useSystemHealthQuery();
  const providerTruthQuery = useProviderTruthQuery();
  const hubOnline = health?.status !== "offline";

  return (
    <div
      className="hidden items-center gap-2 border-b px-4 py-2 text-xs lg:flex"
      style={{
        background: "var(--amber-100)",
        borderColor: "rgba(122, 106, 88, 0.18)",
        color: "var(--ink-700)",
      }}
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: hubOnline ? "var(--jade-500)" : "var(--rust-500)" }}
      />
      <strong style={{ color: "var(--ink-900)" }}>Rust Hub / Core</strong>
      <span>{localize(locale, "真相源投影", "source-of-truth projection")}</span>
      <ProviderTruthCompact
        locale={locale}
        truth={providerTruthQuery.data}
        loading={providerTruthQuery.isPending}
        className="ml-auto min-h-0 px-2 py-1"
      />
    </div>
  );
}

function DesktopProofDock(props: { locale: "zh" | "en" }) {
  const { locale } = props;
  const { data: health } = useSystemHealthQuery();
  const status = health?.status ?? "healthy";

  return (
    <section
      className="hidden border-t px-4 py-3 lg:block"
      aria-label={localize(locale, "证据时间线", "Proof timeline")}
      style={{
        background: "var(--surface-2)",
        borderColor: "rgba(122, 106, 88, 0.18)",
      }}
    >
      <div
        className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em]"
        style={{ color: "var(--ink-700)" }}
      >
        <ShieldCheck className="h-3.5 w-3.5" />
        <span>{localize(locale, "证据检查器 · 底部时间线", "Proof inspector · bottom timeline")}</span>
        <span className="ml-auto text-[10.5px] normal-case tracking-normal" style={{ color: "var(--ink-300)" }}>
          {localize(locale, "Hub 投影 · 非独立真相源", "Hub-projected · not an independent source of truth")}
        </span>
      </div>
      <div className="mt-2 grid gap-2 text-[11.5px] md:grid-cols-3" style={{ color: "var(--ink-500)" }}>
        <span className="inline-flex items-center gap-1.5">
          <Activity className="h-3 w-3" />
          {localize(locale, `runtime: ${status}`, `runtime: ${status}`)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <FileText className="h-3 w-3" />
          {localize(locale, "动作必须绑定 receipt / audit", "actions bind receipt / audit")}
        </span>
        <span className="inline-flex items-center gap-1.5 font-mono">
          {localize(locale, "source: Rust Hub/Core", "source: Rust Hub/Core")}
        </span>
      </div>
    </section>
  );
}
