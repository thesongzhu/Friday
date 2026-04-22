import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { CommandPalette } from "@/components/core/command-palette";
import { useCustomPacks } from "@/hooks/use-custom-packs";
import { useHomeSurfacePreferences } from "@/hooks/use-home-surface-preferences";
import { useUserProfile } from "@/hooks/use-user-profile";
import { onCommandPaletteOpenRequest } from "@/lib/command-palette";
import { completeClientRouteTransition } from "@/lib/diagnostics/client-stability";
import { localize, resolveLocalizedText } from "@/lib/i18n/localized-text";
import { AGENT_OS_NAV_ADVANCED, resolvePageTitle } from "@/lib/routes/agent-os-nav";
import { recordNavVisit } from "@/lib/uix/adaptive-layout";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";
import { MobileNav, Rail } from "./rail";
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

  const advancedForMobileMore = useMemo(
    () => AGENT_OS_NAV_ADVANCED.map((item) => ({
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
      <div className="relative flex min-h-screen w-full pb-[72px] lg:h-screen lg:overflow-hidden lg:pb-0">
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
            <div
              className="mx-4 mt-3 rounded-[var(--radius-lg)] border p-4 lg:hidden"
              style={{
                borderColor: "rgba(122, 106, 88, 0.18)",
                background: "var(--surface-1)",
              }}
            >
              <div className="flex items-center justify-between gap-3 border-b pb-3" style={{ borderColor: "rgba(122, 106, 88, 0.18)" }}>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--ink-300)" }}>
                    {localize(locale, "更多", "More")}
                  </p>
                  <p className="mt-0.5 text-sm" style={{ color: "var(--ink-700)" }}>
                    {localize(locale, "Friday Console", "Friday Console")}
                  </p>
                </div>
                <p className="text-xs" style={{ color: "var(--ink-500)" }}>
                  {localize(locale, "本地会话", "Local session")}
                </p>
              </div>

              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {advancedForMobileMore.map((item) => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    onClick={() => setShowMobileMore(false)}
                    className="rounded-[var(--radius-md)] border px-3 py-3"
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
          ) : null}

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
        </div>

        <RightRail />
      </div>

      <MobileNav onOpenMore={() => setShowMobileMore((v) => !v)} />

      {paletteOpen ? (
        <CommandPalette locale={locale} onClose={() => setPaletteOpen(false)} />
      ) : null}
    </div>
  );
}
