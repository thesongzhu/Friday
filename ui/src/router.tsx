import { Suspense, lazy, type ReactNode } from "react";
import { Navigate, Outlet, createBrowserRouter, useLocation, useRouteError } from "react-router-dom";
import {
  AuthErrorSplash,
  LoadingSplash,
  NetworkErrorSplash,
  SetupGateSplash,
  type SplashAction,
  type SplashStep,
} from "@/components/console/shell";
import { AppShell } from "@/components/layout/app-shell";
import { useAuth } from "@/hooks/use-auth";
import { useSetupStatusQuery } from "@/hooks/use-setup";
import { useUserProfile } from "@/hooks/use-user-profile";
import { ApiError, AuthExpiredError } from "@/lib/api/types";
import { HIDE_MARKETPLACE_UI } from "@/lib/feature-flags";
import { localize, localizedText, resolveLocalizedText, type LocalizedText } from "@/lib/i18n/localized-text";
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
const PluginsPage = lazy(async () => import("@/routes/plugins-page").then((module) => ({ default: module.PluginsPage })));
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
const ChannelsPage = lazy(async () => import("@/routes/channels-page").then((module) => ({ default: module.ChannelsPage })));
const BriefPage = lazy(async () => import("@/routes/brief-page").then((module) => ({ default: module.BriefPage })));

/**
 * Router-level loading splash. Resolves `LocalizedText` into the active locale
 * and defers layout to <LoadingSplash />. Used by RequireAuth, RouteSuspense,
 * and SetupGate during `isLoading` states.
 */
function LoadingMessage(props: { title: string | LocalizedText; detail: string | LocalizedText }) {
  const { locale } = useAppLocale();
  const title = typeof props.title === "string" ? props.title : resolveLocalizedText(props.title, locale);
  const body = typeof props.detail === "string" ? props.detail : resolveLocalizedText(props.detail, locale);
  return <LoadingSplash eyebrow="Friday" title={title} body={body} />;
}

/**
 * Setup-status failure splash. Picks the splash variant based on the error
 * kind surfaced by `describeSetupStatusFailure`:
 *
 *   - `AuthExpiredError` / `ApiError(401|403)` → AuthErrorSplash
 *   - `ApiError(NETWORK_ERROR | status 0)`   → NetworkErrorSplash (retry wired)
 *   - anything else (404 / 500 / invalid)    → SetupGateSplash
 *
 * Advice strings from the diagnostic are rendered as `steps`, preserving the
 * old FullscreenMessage list shape with the new splash layout.
 */
function SetupFailureMessage(props: { error: unknown; origin: string; onRetry: () => void }) {
  const { locale } = useAppLocale();
  const diagnostics = describeSetupStatusFailure(props.error, props.origin);
  const steps: SplashStep[] = diagnostics.actions.map((advice) => ({ label: advice, status: "todo" }));

  const retry: SplashAction = {
    label: localize(locale, "重试", "Retry"),
    onClick: props.onRetry,
    tone: "primary",
  };
  const reload: SplashAction = {
    label: localize(locale, "刷新页面", "Reload page"),
    onClick: () => {
      if (typeof window !== "undefined") window.location.reload();
    },
    tone: "secondary",
  };

  const isAuth = props.error instanceof AuthExpiredError
    || (props.error instanceof ApiError && (props.error.statusCode === 401 || props.error.statusCode === 403));
  const isNetwork = props.error instanceof ApiError
    && (props.error.code === "NETWORK_ERROR" || props.error.statusCode === 0);

  if (isAuth) {
    return (
      <AuthErrorSplash
        eyebrow="Friday"
        title={diagnostics.title}
        body={diagnostics.detail}
        steps={steps}
        actions={[reload]}
      />
    );
  }
  if (isNetwork) {
    return (
      <NetworkErrorSplash
        eyebrow="Friday"
        title={diagnostics.title}
        body={diagnostics.detail}
        steps={steps}
        actions={[retry, reload]}
      />
    );
  }
  return (
    <SetupGateSplash
      eyebrow="Friday"
      title={diagnostics.title}
      body={diagnostics.detail}
      steps={steps}
      actions={[retry]}
    />
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { locale } = useAppLocale();
  const { isAuthenticated, isLoading, authError, retryLocalSession } = useAuth();

  if (isLoading) {
    return (
      <LoadingMessage
        title={localizedText("启动 Friday", "Starting Friday")}
        detail={localizedText("Friday 正在准备你的本地会话。", "Friday is preparing your local session.")}
      />
    );
  }

  if (!isAuthenticated) {
    const retry: SplashAction = {
      label: localize(locale, "重试本地会话", "Retry local session"),
      onClick: () => {
        void retryLocalSession();
      },
      tone: "primary",
    };
    const reload: SplashAction = {
      label: localize(locale, "刷新页面", "Reload page"),
      onClick: () => {
        if (typeof window !== "undefined") window.location.reload();
      },
      tone: "secondary",
    };
    const authDetail = authError?.message?.trim();
    return (
      <SetupGateSplash
        eyebrow="Friday"
        title={localize(locale, "本地会话未连接", "Local session not connected")}
        body={localize(
          locale,
          "Friday 启动时没有拿到本地会话，因此没有进入首页。我保留了恢复入口，但不再显示旧登录页。",
          "Friday could not attach a local session on launch, so it did not enter home. The recovery path stays here, but the old login surface is no longer shown.",
        )}
        steps={[
          { label: localize(locale, "重试建立本地会话。", "Retry creating the local session."), status: "active" },
          {
            label: authDetail
              ? localize(locale, `后端返回：${authDetail}`, `Backend said: ${authDetail}`)
              : localize(
                  locale,
                  "如果仍失败，检查本地 Friday 进程是否刚重启，或 setup 是否已完成。",
                  "If it still fails, check whether the local Friday process just restarted or setup is still incomplete.",
                ),
            status: "todo",
          },
        ]}
        actions={[retry, reload]}
      />
    );
  }

  return <>{children}</>;
}

function RouteSuspense(props: { title: string | LocalizedText; detail: string | LocalizedText; children: ReactNode }) {
  return (
    <Suspense fallback={<LoadingMessage title={props.title} detail={props.detail} />}>
      {props.children}
    </Suspense>
  );
}

function SetupGate() {
  const location = useLocation();
  const { data: setupStatus, isLoading, isError, error, refetch } = useSetupStatusQuery();
  const { isLoading: profileLoading } = useUserProfile();

  if (isLoading || profileLoading) {
    return (
      <LoadingMessage
        title={localizedText("检查本地环境", "Inspecting local setup")}
        detail={localizedText("Friday 正在确认这台机器是否已经完成引导配置。", "Friday is verifying whether this machine has already completed bootstrap.")}
      />
    );
  }

  if (isError) {
    const origin = typeof window !== "undefined" ? window.location.origin : "this origin";
    return (
      <SetupFailureMessage
        error={error}
        origin={origin}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  if (setupStatus?.needsSetup && location.pathname !== "/setup") {
    return <Navigate to="/setup" replace />;
  }

  return <Outlet />;
}

function LegacyRedirectPage() {
  const location = useLocation();
  const target = resolveLegacyRedirect(location.pathname);
  return <Navigate to={target ?? "/assistant"} replace />;
}

function RouteErrorBoundary() {
  const error = useRouteError();
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", gap: "16px", fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ margin: 0, fontSize: "20px" }}>Something went wrong</h2>
      <p style={{ margin: 0, color: "#666", maxWidth: "400px", textAlign: "center" }}>
        {error instanceof Error ? error.message : "An unexpected error occurred while loading this page."}
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{ padding: "8px 20px", borderRadius: "6px", border: "1px solid #ccc", cursor: "pointer", background: "#fff" }}
      >
        Reload Page
      </button>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    path: "/login",
    element: <Navigate to="/home" replace />,
  },
  {
    path: "/",
    errorElement: <RouteErrorBoundary />,
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
            element: <Navigate to="/home" replace />,
          },
          {
            path: "channels",
            element: (
              <RouteSuspense title={localizedText("加载渠道", "Loading channels")} detail={localizedText("Friday 正在准备渠道监控面板。", "Friday is preparing the channel monitor.")}>
                <ChannelsPage />
              </RouteSuspense>
            ),
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
              HIDE_MARKETPLACE_UI
                ? <Navigate to="/assistant" replace />
                : (
                    <RouteSuspense title={localizedText("加载市场", "Loading marketplace")} detail={localizedText("Friday 正在准备创作者生态。", "Friday is preparing the public creator ecosystem.")}>
                      <MarketplacePage />
                    </RouteSuspense>
                  )
            ),
          },
          {
            path: "plugins",
            element: (
              <RouteSuspense title={localizedText("加载插件", "Loading plugins")} detail={localizedText("Friday 正在准备插件库存和运行时状态。", "Friday is preparing the plugin inventory and runtime status.")}>
                <PluginsPage />
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
          {
            path: "brief",
            element: (
              <RouteSuspense title={localizedText("加载每日简报", "Loading daily brief")} detail={localizedText("Friday 正在准备每日语音简报面板。", "Friday is preparing the daily voice brief panel.")}>
                <BriefPage />
              </RouteSuspense>
            ),
          },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
