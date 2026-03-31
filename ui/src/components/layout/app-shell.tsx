import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, ChartNoAxesCombined, ChevronDown, Command, Home, MessageCircle, MonitorCog, Package, ShieldCheck, ShoppingBag, Wand2, Waypoints } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { healthApi } from "@/lib/api/health";
import { systemApi } from "@/lib/api/system";
import { AGENT_OS_NAV_PRIMARY, AGENT_OS_NAV_ADVANCED, resolvePageTitle } from "@/lib/routes/agent-os-nav";
import { systemKeys } from "@/lib/system/query-keys";
import { summarizeHealthReasons } from "@/lib/system/view-models";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import { cn } from "@/lib/utils/cn";

function toneForHealth(status?: string): "neutral" | "success" | "warning" | "danger" {
  if (status === "healthy" || status === "ok") return "success";
  if (status === "safe_mode" || status === "degraded") return "warning";
  if (status === "unavailable") return "danger";
  return "neutral";
}

export function AppShell() {
  const location = useLocation();
  const { user, logout } = useAuth();

  const { data: health } = useQuery({
    queryKey: ["shell", "health"],
    queryFn: () => healthApi.getHealth(),
    refetchInterval: 30_000,
  });

  const { data: systemSession } = useQuery({
    queryKey: systemKeys.session(),
    queryFn: () => systemApi.getSession(),
    retry: 0,
    refetchInterval: 10_000,
  });

  const [showAdvanced, setShowAdvanced] = useState(false);

  const pageTitle = resolvePageTitle(location.pathname);
  const systemHealth = systemSession?.health;
  const isSimplifiedView = location.pathname === "/home" || location.pathname.startsWith("/flow/") || location.pathname === "/chat";

  return (
    <div className="min-h-screen bg-[var(--bg-canvas)] text-white">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="agent-grid absolute inset-0 opacity-30" />
        <div className="agent-orb agent-orb-left" />
        <div className="agent-orb agent-orb-right" />
      </div>

      <div className="relative mx-auto flex min-h-screen w-full max-w-[1600px] gap-6 px-4 py-4 lg:px-6">
        <aside className="hidden w-[280px] shrink-0 flex-col gap-5 lg:flex">
          <ShellCard className="overflow-hidden">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="agent-eyebrow">Friday Agent OS</p>
                <h1 className="font-[var(--font-display)] text-2xl font-semibold tracking-tight text-white">
                  Assistant-first control shell
                </h1>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/10 p-2 text-[var(--accent-strong)]">
                <Command className="h-5 w-5" />
              </div>
            </div>
            <p className="mt-3 text-sm leading-6 text-white/60">
              Start from goals, click through plans, and only drop into deep operator pages when
              you need system-level context.
            </p>
          </ShellCard>

          <nav className="flex flex-col gap-2">
            {AGENT_OS_NAV_PRIMARY.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === "/"}
                className={({ isActive }) =>
                  cn(
                    "rounded-3xl border px-4 py-4 transition-colors",
                    isActive
                      ? "border-emerald-300/40 bg-emerald-300/10"
                      : "border-white/10 bg-white/[0.04] hover:border-white/[0.16] hover:bg-white/[0.07]",
                  )
                }
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-2xl border border-white/10 bg-white/[0.07] p-2">
                    {item.path === "/chat" ? <MessageCircle className="h-4 w-4" /> : null}
                    {item.path === "/home" ? <Home className="h-4 w-4" /> : null}
                    {item.path === "/skills" ? <Package className="h-4 w-4" /> : null}
                    {item.path === "/workflows" ? <Activity className="h-4 w-4" /> : null}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white">{item.label}</p>
                    <p className="mt-1 text-xs leading-5 text-white/50">{item.description}</p>
                  </div>
                </div>
              </NavLink>
            ))}

            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-2.5 text-xs font-medium text-white/40 transition-colors hover:bg-white/[0.05] hover:text-white/60"
            >
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showAdvanced && "rotate-180")} />
              {showAdvanced ? "Hide advanced" : "Show advanced"}
            </button>

            {showAdvanced && AGENT_OS_NAV_ADVANCED.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === "/"}
                className={({ isActive }) =>
                  cn(
                    "rounded-3xl border px-4 py-4 transition-colors",
                    isActive
                      ? "border-emerald-300/40 bg-emerald-300/10"
                      : "border-white/10 bg-white/[0.04] hover:border-white/[0.16] hover:bg-white/[0.07]",
                  )
                }
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-2xl border border-white/10 bg-white/[0.07] p-2">
                    {item.path === "/assistant" ? <Wand2 className="h-4 w-4" /> : null}
                    {item.path === "/fleet" ? <Waypoints className="h-4 w-4" /> : null}
                    {item.path === "/marketplace" ? <ShoppingBag className="h-4 w-4" /> : null}
                    {item.path === "/automations" ? <Activity className="h-4 w-4" /> : null}
                    {item.path === "/observability" ? <ChartNoAxesCombined className="h-4 w-4" /> : null}
                    {item.path === "/command-center" ? <MonitorCog className="h-4 w-4" /> : null}
                    {item.path === "/settings" ? <ShieldCheck className="h-4 w-4" /> : null}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white">{item.label}</p>
                    <p className="mt-1 text-xs leading-5 text-white/50">{item.description}</p>
                  </div>
                </div>
              </NavLink>
            ))}
          </nav>

          <ShellCard title="Session" eyebrow="Operator">
            <div className="space-y-3 text-sm text-white/70">
              <div className="flex items-center justify-between gap-4">
                <span>User</span>
                <span className="font-medium text-white">{user?.displayName ?? "Unknown"}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span>Role</span>
                <StatusPill>{user?.role ?? "viewer"}</StatusPill>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span>Remote mode</span>
                <StatusPill tone={health?.capabilities?.system?.enabled ? "success" : "neutral"}>
                  {health?.capabilities?.system?.remoteMode ?? "unavailable"}
                </StatusPill>
              </div>
              <ActionButton tone="secondary" onClick={() => void logout()} className="w-full">
                Sign out
              </ActionButton>
            </div>
          </ShellCard>
        </aside>

        <main className="relative flex min-h-[calc(100vh-2rem)] flex-1 flex-col gap-4">
          {!isSimplifiedView && (
            <header className="agent-header">
              <div>
                <p className="agent-eyebrow">Friday Control Plane</p>
                <h1 className="font-[var(--font-display)] text-3xl font-semibold tracking-tight text-white">
                  {pageTitle}
                </h1>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone={toneForHealth(health?.status)}>
                  API {health?.status ?? "loading"}
                </StatusPill>
                <StatusPill tone={toneForHealth(systemHealth?.status)}>
                  System {systemHealth?.status ?? "unavailable"}
                </StatusPill>
                <StatusPill tone={systemSession?.companion.connected ? "success" : "warning"}>
                  Companion {systemSession?.companion.connected ? "connected" : "degraded"}
                </StatusPill>
              </div>
            </header>
          )}

          {systemHealth && systemHealth.status !== "healthy" ? (
            <div className="rounded-3xl border border-amber-300/[0.24] bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
              {summarizeHealthReasons(systemHealth)}
            </div>
          ) : null}

          <Outlet />
        </main>
      </div>
    </div>
  );
}
