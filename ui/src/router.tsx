import { Suspense, lazy, type ReactNode } from "react";
import { Navigate, Outlet, createBrowserRouter, useLocation, useRouteError } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AuthErrorSplash,
  LoadingSplash,
  NetworkErrorSplash,
  SetupGateSplash,
  type SplashAction,
} from "@/components/console/shell";
import { AppShell } from "@/components/layout/app-shell";
import { useAuth } from "@/hooks/use-auth";
import { useSetupStatusQuery } from "@/hooks/use-setup";
import { useUserProfile } from "@/hooks/use-user-profile";
import { getBootstrapStatus } from "@/lib/api/auth";
import { ApiError, AuthExpiredError } from "@/lib/api/types";
import { localize, localizedText, resolveLocalizedText, type LocalizedText } from "@/lib/i18n/localized-text";
import { resolveLegacyRedirect } from "@/lib/routes/legacy-routes";
import { useAppLocale } from "@/providers/locale-provider";

const AgentPage = lazy(async () => import("@/routes/agent-page").then((module) => ({ default: module.AgentPage })));
const AssistantInboxPage = lazy(async () => import("@/routes/assistant-inbox-page").then((module) => ({ default: module.AssistantInboxPage })));
const AutomationsPage = lazy(async () => import("@/routes/automations-page").then((module) => ({ default: module.AutomationsPage })));
const FleetPage = lazy(async () => import("@/routes/fleet-page").then((module) => ({ default: module.FleetPage })));
const GuidedFlowPage = lazy(async () => import("@/routes/guided-flow-page").then((module) => ({ default: module.GuidedFlowPage })));
const HomePage = lazy(async () => import("@/routes/home-page").then((module) => ({ default: module.HomePage })));
const LoginPage = lazy(async () => import("@/routes/login-page").then((module) => ({ default: module.LoginPage })));
const ObservabilityPage = lazy(async () => import("@/routes/observability-page").then((module) => ({ default: module.ObservabilityPage })));
const OnboardingPage = lazy(async () => import("@/routes/onboarding-page").then((module) => ({ default: module.OnboardingPage })));
const PacksPage = lazy(async () => import("@/routes/packs-page").then((module) => ({ default: module.PacksPage })));
const PluginsPage = lazy(async () => import("@/routes/plugins-page").then((module) => ({ default: module.PluginsPage })));
const ProvidersPage = lazy(async () => import("@/routes/providers-page").then((module) => ({ default: module.ProvidersPage })));
const CrossBorderPackSetupPage = lazy(async () => import("@/routes/cross-border-pack-setup-page").then((module) => ({ default: module.CrossBorderPackSetupPage })));
const ReflexPage = lazy(async () => import("@/routes/reflex-page").then((module) => ({ default: module.ReflexPage })));
const SettingsPage = lazy(async () => import("@/routes/settings-page").then((module) => ({ default: module.SettingsPage })));
const SetupPage = lazy(async () => import("@/routes/setup-page").then((module) => ({ default: module.SetupPage })));
const FirstRunPassphraseGate = lazy(async () => import("@/routes/first-run-passphrase-gate").then((module) => ({ default: module.FirstRunPassphraseGate })));
const FirstRunDeviceClaimGate = lazy(async () => import("@/routes/first-run-device-claim-gate").then((module) => ({ default: module.FirstRunDeviceClaimGate })));
const SkillsPage = lazy(async () => import("@/routes/skills-page").then((module) => ({ default: module.SkillsPage })));
const SkillGeneratorPage = lazy(async () => import("@/routes/skill-generator-page").then((module) => ({ default: module.SkillGeneratorPage })));
const WorkflowBuilderPage = lazy(async () => import("@/routes/workflow-builder-page").then((module) => ({ default: module.WorkflowBuilderPage })));
const WorkflowGeneratorPage = lazy(async () => import("@/routes/workflow-generator-page").then((module) => ({ default: module.WorkflowGeneratorPage })));
const McpPage = lazy(async () => import("@/routes/mcp-page").then((module) => ({ default: module.McpPage })));
const UsagePage = lazy(async () => import("@/routes/usage-page").then((module) => ({ default: module.UsagePage })));
const SessionsPage = lazy(async () => import("@/routes/sessions-page").then((module) => ({ default: module.SessionsPage })));
const SessionDetailPage = lazy(async () => import("@/routes/session-detail-page").then((module) => ({ default: module.SessionDetailPage })));
const ChatPage = lazy(async () => import("@/routes/chat-page").then((module) => ({ default: module.ChatPage })));
const MemoryPage = lazy(async () => import("@/routes/memory-page").then((module) => ({ default: module.MemoryPage })));
const MissionWorkbenchPage = lazy(async () => import("@/routes/mission-workbench-page").then((module) => ({ default: module.MissionWorkbenchPage })));
const AssetsPage = lazy(async () => import("@/routes/assets-page").then((module) => ({ default: module.AssetsPage })));
const StudioPage = lazy(async () => import("@/routes/studio-page").then((module) => ({ default: module.StudioPage })));
const WorkflowsPage = lazy(async () => import("@/routes/workflows-page").then((module) => ({ default: module.WorkflowsPage })));
const ChannelsPage = lazy(async () => import("@/routes/channels-page").then((module) => ({ default: module.ChannelsPage })));
const TaskWorkflowsPage = lazy(async () => import("@/routes/task-workflows-page").then((module) => ({ default: module.TaskWorkflowsPage })));
const EvidencePage = lazy(async () => import("@/routes/evidence-page").then((module) => ({ default: module.EvidencePage })));
const CloudWorkersPage = lazy(async () => import("@/routes/cloud-workers-page").then((module) => ({ default: module.CloudWorkersPage })));

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
 * Setup-status failure splash. Picks the splash variant directly from the
 * setup-status error kind:
 *
 *   - `AuthExpiredError` / `ApiError(401|403)` → AuthErrorSplash
 *   - `ApiError(NETWORK_ERROR | status 0)`   → NetworkErrorSplash (retry wired)
 *   - anything else (404 / 500 / invalid)    → SetupGateSplash
 *
 * Internal backend messages stay hidden here because this screen is a recovery
 * path for normal users, not a diagnostic console.
 */
function SetupFailureMessage(props: { error: unknown; onRetry: () => void }) {
  const { locale } = useAppLocale();

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
        title={localize(locale, "需要重新连接本机 Friday", "Reconnect local Friday")}
        body={localize(
          locale,
          "Friday 已打开，但本机服务连接没有通过。刷新后会重新连接，并继续进入 setup 或首页。",
          "Friday is open, but the local service connection was not accepted. Reload to reconnect and continue to setup or home.",
        )}
        steps={[
          {
            label: localize(locale, "不会显示后端原始错误。", "Internal backend errors stay hidden."),
            status: "done",
          },
          {
            label: localize(locale, "刷新后继续到 setup 或首页。", "Reload, then continue to setup or home."),
            status: "active",
          },
        ]}
        actions={[reload]}
      />
    );
  }
  if (isNetwork) {
    return (
      <NetworkErrorSplash
        eyebrow="Friday"
        title={localize(locale, "Friday 后台还没连上", "Friday backend is not connected yet")}
        body={localize(
          locale,
          "前台已经打开，但本地服务还没有响应。等几秒重试；如果还不行，确认 Friday 进程正在运行。",
          "The UI is open, but the local service is not responding yet. Wait a few seconds and retry; if it still fails, confirm Friday is running.",
        )}
        steps={[
          {
            label: localize(locale, "确认本地服务正在启动。", "Confirm the local service is starting."),
            status: "active",
          },
          {
            label: localize(locale, "继续失败时重新打开 Friday。", "If it keeps failing, reopen Friday."),
            status: "todo",
          },
        ]}
        actions={[retry, reload]}
      />
    );
  }
  return (
    <SetupGateSplash
      eyebrow="Friday"
      title={localize(locale, "设置状态暂时不可用", "Setup status is temporarily unavailable")}
      body={localize(
        locale,
        "Friday 没能确认这台机器是否完成 setup。先重试；如果还不行，重新打开本地入口。",
        "Friday could not confirm whether this machine has completed setup. Retry first; if it still fails, reopen the local entrypoint.",
      )}
      steps={[
        {
          label: localize(locale, "重试读取设置状态。", "Retry reading setup status."),
          status: "active",
        },
        {
          label: localize(locale, "重新打开本地 Friday。", "Reopen local Friday."),
          status: "todo",
        },
      ]}
      actions={[retry, reload]}
    />
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();
  const bootstrapStatusQuery = useQuery({
    queryKey: ["auth", "bootstrap", "status"],
    queryFn: getBootstrapStatus,
    enabled: !isAuthenticated && !isLoading,
    staleTime: 5_000,
    retry: 1,
  });

  if (isLoading) {
    return (
      <LoadingMessage
        title={localizedText("启动 Friday", "Starting Friday")}
        detail={localizedText("Friday 正在连接本机服务。", "Friday is connecting to the local service.")}
      />
    );
  }

  if (!isAuthenticated) {
    if (bootstrapStatusQuery.isLoading) {
      return (
        <LoadingMessage
          title={localizedText("检查本机设置", "Checking local setup")}
          detail={localizedText("Friday 正在确认这台机器的本地安全设置状态。", "Friday is checking this machine's local security setup status.")}
        />
      );
    }
    if (bootstrapStatusQuery.isError) {
      return (
        <SetupFailureMessage
          error={bootstrapStatusQuery.error}
          onRetry={() => {
            void bootstrapStatusQuery.refetch();
          }}
        />
      );
    }
    if (bootstrapStatusQuery.data?.bootstrapRequired) {
      // Backend is reachable and reports a fresh machine → offer the first-run local
      // security gate, NOT a misleading "connecting" screen.
      //
      // SEC-SETUP-BOOTSTRAP-001 (CR-1): when the backend reports device-owner
      // authority is enabled (deviceClaimAvailable — server-derived, requires the
      // native-IPC attestation precondition), route to the DEVICE-CLAIM gate as the
      // authoritative first-run path. Otherwise (the current release build, where
      // attestation is honestly unavailable) keep the passphrase gate. The
      // passphrase gate is NOT offered as the authoritative path when device-claim
      // is available.
      if (bootstrapStatusQuery.data.deviceClaimAvailable === true) {
        return (
          <RouteSuspense
            title={localizedText("绑定本机设备", "Bind this device")}
            detail={localizedText("Friday 正在准备本机设备安全设置。", "Friday is preparing device-bound security setup.")}
          >
            <FirstRunDeviceClaimGate />
          </RouteSuspense>
        );
      }
      return (
        <RouteSuspense
          title={localizedText("创建本机口令", "Create local passphrase")}
          detail={localizedText("Friday 正在准备本机安全设置。", "Friday is preparing local security setup.")}
        >
          <FirstRunPassphraseGate />
        </RouteSuspense>
      );
    }
    const nextPath = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/login?next=${encodeURIComponent(nextPath)}`} replace />;
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
    return (
      <SetupFailureMessage
        error={error}
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
  useRouteError();
  const { locale } = useAppLocale();
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", gap: "16px", fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ margin: 0, fontSize: "20px" }}>
        {localize(locale, "Friday 暂时卡住了", "Friday hit a snag")}
      </h2>
      <p style={{ margin: 0, color: "var(--muted)", maxWidth: "400px", textAlign: "center" }}>
        {localize(
          locale,
          "页面加载时遇到意外问题。刷新后 Friday 会重新进入 setup、解锁或首页。",
          "The page hit an unexpected problem. Reload and Friday will return to setup, unlock, or home.",
        )}
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{ padding: "8px 20px", borderRadius: "6px", border: "1px solid var(--line)", cursor: "pointer", background: "var(--paper-strong)" }}
      >
        {localize(locale, "刷新页面", "Reload page")}
      </button>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    path: "/login",
    element: (
      <RouteSuspense
        title={localizedText("加载登录", "Loading login")}
        detail={localizedText("Friday 正在准备本机解锁。", "Friday is preparing local unlock.")}
      >
        <LoginPage />
      </RouteSuspense>
    ),
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
            path: "studio",
            element: (
              <RouteSuspense
                title={localizedText("加载 Studio", "Loading Studio")}
                detail={localizedText("Friday 正在准备开箱即用的工作产品入口。", "Friday is preparing ready-to-use work product entrypoints.")}
              >
                <StudioPage />
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
            path: "cloud-workers",
            element: (
              <RouteSuspense
                title={localizedText("加载云端 Worker", "Loading cloud workers")}
                detail={localizedText("Friday 正在准备用户自有云 Worker 设置 UX。", "Friday is preparing the user-owned cloud worker setup UX.")}
              >
                <CloudWorkersPage />
              </RouteSuspense>
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
            path: "providers",
            element: (
              <RouteSuspense title={localizedText("加载提供方", "Loading providers")} detail={localizedText("Friday 正在准备提供方认证、能力和路由真值。", "Friday is preparing provider auth, capability, and routing truth.")}>
                <ProvidersPage />
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
            path: "evidence",
            element: (
              <RouteSuspense title={localizedText("加载证据", "Loading evidence")} detail={localizedText("Friday 正在准备证据搜索、回执车道和脱敏检查器。", "Friday is preparing evidence search, receipt lanes, and the redacted inspector.")}>
                <EvidencePage />
              </RouteSuspense>
            ),
          },
          {
            path: "task-workflows",
            element: (
              <RouteSuspense title={localizedText("加载任务工作流", "Loading task workflows")} detail={localizedText("Friday 正在准备监督员视图和证据浏览器。", "Friday is preparing the supervisor view and evidence explorer.")}>
                <TaskWorkflowsPage />
              </RouteSuspense>
            ),
          },
          {
            path: "mission-workbench",
            element: (
              <RouteSuspense title={localizedText("加载任务工作台", "Loading mission workbench")} detail={localizedText("Friday 正在准备任务、证据和时间线视图。", "Friday is preparing the mission, evidence, and timeline view.")}>
                <MissionWorkbenchPage />
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
          {
            path: "workflows/generator",
            element: (
              <RouteSuspense title={localizedText("加载工作流生成器", "Loading workflow generator")} detail={localizedText("Friday 正在准备需求澄清和草案生成。", "Friday is preparing requirement capture and draft generation.")}>
                <WorkflowGeneratorPage />
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
            path: "sessions/:sessionKey",
            element: (
              <RouteSuspense title={localizedText("加载会话详情", "Loading session detail")} detail={localizedText("Friday 正在准备会话生命周期、证明和控制真值。", "Friday is preparing session lifecycle, proof, and control truth.")}>
                <SessionDetailPage />
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
            path: "assets",
            element: (
              <RouteSuspense title={localizedText("加载资产库", "Loading assets")} detail={localizedText("Friday 正在准备统一资产库存视图。", "Friday is preparing the unified asset inventory view.")}>
                <AssetsPage />
              </RouteSuspense>
            ),
          },
          {
            path: "reflex",
            element: (
              <RouteSuspense title={localizedText("加载成长中心", "Loading Reflex")} detail={localizedText("Friday 正在准备候选审批和 onboarding 同步。", "Friday is preparing candidate review and onboarding sync.")}>
                <ReflexPage />
              </RouteSuspense>
            ),
          },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
