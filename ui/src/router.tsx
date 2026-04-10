import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, createBrowserRouter, useLocation } from "react-router-dom";
import { AppShell } from "@/components/layout/app-shell";
import { useAuth } from "@/hooks/use-auth";
import { useHomeSurfacePreferences } from "@/hooks/use-home-surface-preferences";
import { useSetupStatusQuery } from "@/hooks/use-setup";
import { useUserProfile } from "@/hooks/use-user-profile";
import { uixSnapshotsApi } from "@/lib/api/uix-snapshots";
import { localizedText, resolveLocalizedText, type LocalizedText } from "@/lib/i18n/localized-text";
import { resolveLegacyRedirect } from "@/lib/routes/legacy-routes";
import { describeSetupStatusFailure } from "@/lib/setup/setup-status-diagnostics";
import { useAppLocale } from "@/providers/locale-provider";

const AgentPage = lazy(async () => import("@/routes/agent-page").then((module) => ({ default: module.AgentPage })));
const AssistantInboxPage = lazy(async () => import("@/routes/assistant-inbox-page").then((module) => ({ default: module.AssistantInboxPage })));
const AutomationsPage = lazy(async () => import("@/routes/automations-page").then((module) => ({ default: module.AutomationsPage })));
const FleetPage = lazy(async () => import("@/routes/fleet-page").then((module) => ({ default: module.FleetPage })));
const GuidedFlowPage = lazy(async () => import("@/routes/guided-flow-page").then((module) => ({ default: module.GuidedFlowPage })));
const HomePage = lazy(async () => import("@/routes/home-page").then((module) => ({ default: module.HomePage })));

const MarketplacePage = lazy(async () => import("@/routes/marketplace-page").then((module) => ({ default: module.MarketplacePage })));
const ObservabilityPage = lazy(async () => import("@/routes/observability-page").then((module) => ({ default: module.ObservabilityPage })));
const OnboardingPage = lazy(async () => import("@/routes/onboarding-page").then((module) => ({ default: module.OnboardingPage })));
const PacksPage = lazy(async () => import("@/routes/packs-page").then((module) => ({ default: module.PacksPage })));
const CrossBorderPackSetupPage = lazy(async () => import("@/routes/cross-border-pack-setup-page").then((module) => ({ default: module.CrossBorderPackSetupPage })));
const SettingsPage = lazy(async () => import("@/routes/settings-page").then((module) => ({ default: module.SettingsPage })));
const SetupPage = lazy(async () => import("@/routes/setup-page").then((module) => ({ default: module.SetupPage })));
const SkillsPage = lazy(async () => import("@/routes/skills-page").then((module) => ({ default: module.SkillsPage })));
const SkillGeneratorPage = lazy(async () => import("@/routes/skill-generator-page").then((module) => ({ default: module.SkillGeneratorPage })));
const WorkflowBuilderPage = lazy(async () => import("@/routes/workflow-builder-page").then((module) => ({ default: module.WorkflowBuilderPage })));
const McpPage = lazy(async () => import("@/routes/mcp-page").then((module) => ({ default: module.McpPage })));
const UsagePage = lazy(async () => import("@/routes/usage-page").then((module) => ({ default: module.UsagePage })));
const SessionsPage = lazy(async () => import("@/routes/sessions-page").then((module) => ({ default: module.SessionsPage })));
const ChatPage = lazy(async () => import("@/routes/chat-page").then((module) => ({ default: module.ChatPage })));
const MemoryPage = lazy(async () => import("@/routes/memory-page").then((module) => ({ default: module.MemoryPage })));
const WorkflowsPage = lazy(async () => import("@/routes/workflows-page").then((module) => ({ default: module.WorkflowsPage })));

function FullscreenMessage(props: { title: string | LocalizedText; detail: string | LocalizedText; actions?: Array<string | LocalizedText> }) {
  const { locale } = useAppLocale();
  return (
    <div className="flex min-h-screen items-center justify-center bg-[color:var(--color-bg-base)] px-6 text-[color:var(--color-text-primary)]">
      <div className="max-w-xl text-center">
        <p className="agent-eyebrow">Friday</p>
        <h1 className="font-[var(--font-display)] text-3xl font-semibold tracking-tight">
          {typeof props.title === "string" ? props.title : resolveLocalizedText(props.title, locale)}
        </h1>
        <p className="mt-4 text-sm leading-7 text-[color:var(--color-text-secondary)]">
          {typeof props.detail === "string" ? props.detail : resolveLocalizedText(props.detail, locale)}
        </p>
        {props.actions && props.actions.length > 0
          ? (
            <ul className="mt-6 space-y-3 text-left text-sm leading-6 text-[color:var(--color-text-secondary)]">
              {props.actions.map((action) => (
                <li key={typeof action === "string" ? action : `${action.zh}:${action.en}`} className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3">
                  {typeof action === "string" ? action : resolveLocalizedText(action, locale)}
                </li>
              ))}
            </ul>
          )
          : null}
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, login: doLogin } = useAuth();
  const [retrying, setRetrying] = useState(false);

  // Auto-login silently — no login page, just keep trying local auth.
  useEffect(() => {
    if (!isLoading && !isAuthenticated && !retrying) {
      setRetrying(true);
      doLogin({ local: true }).catch(() => {
        // Retry once more after a short delay (server may still be booting).
        setTimeout(() => {
          doLogin({ local: true }).catch(() => {
            // Silent failure — stay on loading screen.
          });
        }, 2000);
      });
    }
  }, [isLoading, isAuthenticated, retrying, doLogin]);

  if (isLoading || !isAuthenticated) {
    return (
      <FullscreenMessage
        title={localizedText("启动 Friday", "Starting Friday")}
        detail={localizedText("Friday 正在准备你的本地会话。", "Friday is preparing your local session.")}
      />
    );
  }

  return <>{children}</>;
}

function RouteSuspense(props: { title: string | LocalizedText; detail: string | LocalizedText; children: ReactNode }) {
  return (
    <Suspense fallback={<FullscreenMessage title={props.title} detail={props.detail} />}>
      {props.children}
    </Suspense>
  );
}

function DefaultEntryRedirect() {
  const { profileType, isFirstVisit, isLoading: profileLoading } = useUserProfile();
  const { lastPrimarySurface } = useHomeSurfacePreferences(profileType);
  const homeSnapshotQuery = useQuery({
    queryKey: ["router", "default-entry", "home-snapshot"],
    queryFn: () => uixSnapshotsApi.getHome(),
    staleTime: 15_000,
  });

  if (profileLoading || homeSnapshotQuery.isLoading) {
    return (
      <FullscreenMessage
        title={localizedText("正在整理你的入口", "Choosing your entry point")}
        detail={localizedText("Friday 正在根据你最近的任务和待处理事项决定先把你带到哪里。", "Friday is choosing the best surface based on your recent work and pending actions.")}
      />
    );
  }

  const snapshot = homeSnapshotQuery.data;
  const runs = snapshot?.runs ?? [];
  const hasLiveWork = runs.some((run) =>
    run.status === "pending"
    || run.status === "planning"
    || run.status === "awaiting_clarification"
    || run.status === "awaiting_plan_approval"
    || run.status === "awaiting_tool_approval"
    || run.status === "executing"
    || run.status === "testing"
    || run.status === "fixing",
  );
  const hasPendingApprovals = (snapshot?.pendingApprovals.length ?? 0) > 0;
  const hasScheduledSoon = (snapshot?.scheduledAutomations ?? []).some((automation) =>
    automation.enabled
    && automation.nextRunAt != null
    && (new Date(automation.nextRunAt).getTime() - Date.now()) <= 2 * 60 * 60 * 1000
  );

  if (isFirstVisit || hasLiveWork || hasPendingApprovals || hasScheduledSoon || lastPrimarySurface === "home") {
    return <Navigate to="/home" replace />;
  }

  return <Navigate to="/chat" replace />;
}

function SetupGate() {
  const location = useLocation();
  const { data: setupStatus, isLoading, isError, error } = useSetupStatusQuery();
  const { isFirstVisit, isLoading: profileLoading } = useUserProfile();

  if (isLoading || profileLoading) {
    return (
      <FullscreenMessage
        title={localizedText("检查本地环境", "Inspecting local setup")}
        detail={localizedText("Friday 正在确认这台机器是否已经完成引导配置。", "Friday is verifying whether this machine has already completed bootstrap.")}
      />
    );
  }

  if (isError) {
    const diagnostics = describeSetupStatusFailure(
      error,
      typeof window !== "undefined" ? window.location.origin : "this origin",
    );
    return (
      <FullscreenMessage
        title={diagnostics.title}
        detail={diagnostics.detail}
        actions={diagnostics.actions}
      />
    );
  }

  if (setupStatus?.needsSetup && location.pathname !== "/setup") {
    return <Navigate to="/setup" replace />;
  }

  if (!setupStatus?.needsSetup && isFirstVisit && location.pathname !== "/onboarding") {
    return <Navigate to="/onboarding" replace />;
  }

  return <Outlet />;
}

function LegacyRedirectPage() {
  const location = useLocation();
  const target = resolveLegacyRedirect(location.pathname);
  return <Navigate to={target ?? "/assistant"} replace />;
}

export const router = createBrowserRouter([
  {
    path: "/login",
    element: <Navigate to="/" replace />,
  },
  {
    path: "/",
    element: (
      <RequireAuth>
        <SetupGate />
      </RequireAuth>
    ),
    children: [
      {
        path: "setup",
        element: (
          <RouteSuspense
            title={localizedText("加载设置", "Loading setup")}
            detail={localizedText("Friday 正在准备本地设置流程。", "Friday is preparing the local setup workflow.")}
          >
            <SetupPage />
          </RouteSuspense>
        ),
      },
      {
        path: "onboarding",
        element: (
          <RouteSuspense
            title={localizedText("欢迎使用", "Welcome")}
            detail={localizedText("Friday 正在准备首次引导。", "Friday is preparing your onboarding experience.")}
          >
            <OnboardingPage />
          </RouteSuspense>
        ),
      },
      {
        element: <AppShell />,
        children: [
          {
            path: "chat",
            element: (
              <RouteSuspense
                title={localizedText("加载聊天", "Loading chat")}
                detail={localizedText("Friday 正在准备新任务入口。", "Friday is preparing your conversation.")}
              >
                <ChatPage />
              </RouteSuspense>
            ),
          },
          {
            path: "home",
            element: (
              <RouteSuspense
                title={localizedText("加载首页", "Loading home")}
                detail={localizedText("Friday 正在准备你的任务首页。", "Friday is preparing your goal-first home screen.")}
              >
                <HomePage />
              </RouteSuspense>
            ),
          },
          {
            path: "packs",
            element: (
              <RouteSuspense
                title={localizedText("加载行业与任务", "Loading packs")}
                detail={localizedText("Friday 正在准备行业与任务库。", "Friday is preparing the industry and task library.")}
              >
                <PacksPage />
              </RouteSuspense>
            ),
          },
          {
            path: "packs/cross-border/setup",
            element: (
              <RouteSuspense
                title={localizedText("加载跨境经营引导包", "Loading cross-border operating pack")}
                detail={localizedText("Friday 正在准备跨境经营设置和默认流程。", "Friday is preparing the cross-border operating setup and default workflows.")}
              >
                <CrossBorderPackSetupPage />
              </RouteSuspense>
            ),
          },
          {
            path: "flow/:wizardId",
            element: (
              <RouteSuspense
                title={localizedText("加载引导流程", "Loading guided flow")}
                detail={localizedText("Friday 正在准备你的分步引导。", "Friday is preparing your guided experience.")}
              >
                <GuidedFlowPage />
              </RouteSuspense>
            ),
          },
          {
            path: "assistant",
            element: (
              <RouteSuspense
                title={localizedText("加载助手收件箱", "Loading assistant")}
                detail={localizedText("Friday 正在准备审批、问题和恢复入口。", "Friday is preparing the assistant inbox.")}
              >
                <AssistantInboxPage />
              </RouteSuspense>
            ),
          },
          {
            index: true,
            element: <DefaultEntryRedirect />,
          },
          {
            path: "command-center",
            element: (
              <RouteSuspense title={localizedText("加载控制中心", "Loading control center")} detail={localizedText("Friday 正在准备主控台。", "Friday is preparing the main operator console.")}>
                <AgentPage />
              </RouteSuspense>
            ),
          },
          {
            path: "fleet",
            element: (
              <RouteSuspense title={localizedText("加载设备集群", "Loading fleet")} detail={localizedText("Friday 正在准备集群管理面板。", "Friday is preparing the fleet control plane.")}>
                <FleetPage />
              </RouteSuspense>
            ),
          },
          {
            path: "marketplace",
            element: (
              <RouteSuspense title={localizedText("加载市场", "Loading marketplace")} detail={localizedText("Friday 正在准备创作者生态。", "Friday is preparing the public creator ecosystem.")}>
                <MarketplacePage />
              </RouteSuspense>
            ),
          },
          {
            path: "automations",
            element: (
              <RouteSuspense title={localizedText("加载自动化", "Loading automations")} detail={localizedText("Friday 正在准备自动化队列。", "Friday is preparing the automation queue.")}>
                <AutomationsPage />
              </RouteSuspense>
            ),
          },
          {
            path: "observability",
            element: (
              <RouteSuspense title={localizedText("加载可观测性", "Loading observability")} detail={localizedText("Friday 正在准备追踪、审计、告警和健康视图。", "Friday is preparing trace, audit, alert, and health views.")}>
                <ObservabilityPage />
              </RouteSuspense>
            ),
          },
          {
            path: "skills",
            element: (
              <RouteSuspense title={localizedText("加载技能", "Loading skills")} detail={localizedText("Friday 正在准备技能生命周期面板。", "Friday is preparing the skills lifecycle surface.")}>
                <SkillsPage />
              </RouteSuspense>
            ),
          },
          {
            path: "skills/generator",
            element: (
              <RouteSuspense title={localizedText("加载技能生成器", "Loading skill generator")} detail={localizedText("Friday 正在准备技能生成工作流。", "Friday is preparing the skill generator workflow.")}>
                <SkillGeneratorPage />
              </RouteSuspense>
            ),
          },
          {
            path: "workflows",
            element: (
              <RouteSuspense title={localizedText("加载工作流", "Loading workflows")} detail={localizedText("Friday 正在准备工作流部署和可视化面板。", "Friday is preparing workflow deploy and visualization surfaces.")}>
                <WorkflowsPage />
              </RouteSuspense>
            ),
          },
          {
            path: "workflows/builder",
            element: (
              <RouteSuspense title={localizedText("加载工作流编辑器", "Loading workflow builder")} detail={localizedText("Friday 正在准备模板驱动的工作流编辑。", "Friday is preparing template-first workflow authoring surfaces.")}>
                <WorkflowBuilderPage />
              </RouteSuspense>
            ),
          },
          { path: "automations/:automationId", element: <LegacyRedirectPage /> },
          {
            path: "mcp",
            element: (
              <RouteSuspense title={localizedText("加载 MCP", "Loading MCP")} detail={localizedText("Friday 正在准备 MCP 服务器管理面板。", "Friday is preparing the MCP server management surface.")}>
                <McpPage />
              </RouteSuspense>
            ),
          },
          {
            path: "usage",
            element: (
              <RouteSuspense title={localizedText("加载用量", "Loading usage")} detail={localizedText("Friday 正在准备用量和成本仪表盘。", "Friday is preparing the usage and cost dashboard.")}>
                <UsagePage />
              </RouteSuspense>
            ),
          },
          {
            path: "settings",
            element: (
              <RouteSuspense title={localizedText("加载设置", "Loading settings")} detail={localizedText("Friday 正在准备运行时设置和诊断。", "Friday is preparing runtime settings and diagnostics.")}>
                <SettingsPage />
              </RouteSuspense>
            ),
          },
          { path: "skills/*", element: <Navigate to="/skills" replace /> },
          { path: "workflows/*", element: <LegacyRedirectPage /> },
          {
            path: "sessions",
            element: (
              <RouteSuspense title={localizedText("加载会话", "Loading sessions")} detail={localizedText("Friday 正在准备会话浏览器。", "Friday is preparing the session browser.")}>
                <SessionsPage />
              </RouteSuspense>
            ),
          },
          {
            path: "memory",
            element: (
              <RouteSuspense title={localizedText("加载记忆", "Loading memory")} detail={localizedText("Friday 正在准备记忆存储视图。", "Friday is preparing the memory store view.")}>
                <MemoryPage />
              </RouteSuspense>
            ),
          },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
