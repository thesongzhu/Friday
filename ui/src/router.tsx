import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { Navigate, Outlet, createBrowserRouter, useLocation } from "react-router-dom";
import { AppShell } from "@/components/layout/app-shell";
import { useAuth } from "@/hooks/use-auth";
import { useSetupStatusQuery } from "@/hooks/use-setup";
import { useUserProfile } from "@/hooks/use-user-profile";
import { resolveLegacyRedirect } from "@/lib/routes/legacy-routes";
import { describeSetupStatusFailure } from "@/lib/setup/setup-status-diagnostics";

const AgentPage = lazy(async () => import("@/routes/agent-page").then((module) => ({ default: module.AgentPage })));
const AssistantPage = lazy(async () => import("@/routes/assistant-page").then((module) => ({ default: module.AssistantPage })));
const AutomationsPage = lazy(async () => import("@/routes/automations-page").then((module) => ({ default: module.AutomationsPage })));
const FleetPage = lazy(async () => import("@/routes/fleet-page").then((module) => ({ default: module.FleetPage })));
const GuidedFlowPage = lazy(async () => import("@/routes/guided-flow-page").then((module) => ({ default: module.GuidedFlowPage })));
const HomePage = lazy(async () => import("@/routes/home-page").then((module) => ({ default: module.HomePage })));
const LoginPage = lazy(async () => import("@/routes/login-page").then((module) => ({ default: module.LoginPage })));
const MarketplacePage = lazy(async () => import("@/routes/marketplace-page").then((module) => ({ default: module.MarketplacePage })));
const ObservabilityPage = lazy(async () => import("@/routes/observability-page").then((module) => ({ default: module.ObservabilityPage })));
const OnboardingPage = lazy(async () => import("@/routes/onboarding-page").then((module) => ({ default: module.OnboardingPage })));
const SettingsPage = lazy(async () => import("@/routes/settings-page").then((module) => ({ default: module.SettingsPage })));
const SetupPage = lazy(async () => import("@/routes/setup-page").then((module) => ({ default: module.SetupPage })));
const SkillsPage = lazy(async () => import("@/routes/skills-page").then((module) => ({ default: module.SkillsPage })));
const SkillGeneratorPage = lazy(async () => import("@/routes/skill-generator-page").then((module) => ({ default: module.SkillGeneratorPage })));
const WorkflowBuilderPage = lazy(async () => import("@/routes/workflow-builder-page").then((module) => ({ default: module.WorkflowBuilderPage })));
const ChatPage = lazy(async () => import("@/routes/chat-page").then((module) => ({ default: module.ChatPage })));
const MemoryPage = lazy(async () => import("@/routes/memory-page").then((module) => ({ default: module.MemoryPage })));
const WorkflowsPage = lazy(async () => import("@/routes/workflows-page").then((module) => ({ default: module.WorkflowsPage })));

function FullscreenMessage(props: { title: string; detail: string; actions?: string[] }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-canvas)] px-6 text-white">
      <div className="max-w-xl text-center">
        <p className="agent-eyebrow">Friday Agent OS</p>
        <h1 className="font-[var(--font-display)] text-3xl font-semibold tracking-tight">
          {props.title}
        </h1>
        <p className="mt-4 text-sm leading-7 text-white/60">{props.detail}</p>
        {props.actions && props.actions.length > 0
          ? (
            <ul className="mt-6 space-y-3 text-left text-sm leading-6 text-white/70">
              {props.actions.map((action) => (
                <li key={action} className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                  {action}
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

  // If not authenticated and not loading, retry local auto-login once before showing login page.
  useEffect(() => {
    if (!isLoading && !isAuthenticated && !retrying) {
      setRetrying(true);
      doLogin({ local: true }).catch(() => {
        // Auto-login failed — will fall through to login page.
      });
    }
  }, [isLoading, isAuthenticated, retrying, doLogin]);

  if (isLoading || (!isAuthenticated && retrying)) {
    return (
      <FullscreenMessage
        title="Starting Friday"
        detail="Friday is preparing your local session."
      />
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function RouteSuspense(props: { title: string; detail: string; children: ReactNode }) {
  return (
    <Suspense fallback={<FullscreenMessage title={props.title} detail={props.detail} />}>
      {props.children}
    </Suspense>
  );
}

function SetupGate() {
  const location = useLocation();
  const { data: setupStatus, isLoading, isError, error } = useSetupStatusQuery();
  const { isFirstVisit, isLoading: profileLoading } = useUserProfile();

  if (isLoading || profileLoading) {
    return (
      <FullscreenMessage
        title="Inspecting local setup"
        detail="Friday is verifying whether the local machine has already completed bootstrap."
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
    element: (
      <RouteSuspense title="Loading login" detail="Friday is preparing the sign-in surface.">
        <LoginPage />
      </RouteSuspense>
    ),
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
          <RouteSuspense title="Loading setup" detail="Friday is preparing the local setup workflow.">
            <SetupPage />
          </RouteSuspense>
        ),
      },
      {
        path: "onboarding",
        element: (
          <RouteSuspense title="Welcome" detail="Friday is preparing your onboarding experience.">
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
              <RouteSuspense title="Loading chat" detail="Friday is preparing your conversation.">
                <ChatPage />
              </RouteSuspense>
            ),
          },
          {
            path: "home",
            element: (
              <RouteSuspense title="Loading home" detail="Friday is preparing your goal-first home screen.">
                <HomePage />
              </RouteSuspense>
            ),
          },
          {
            path: "flow/:wizardId",
            element: (
              <RouteSuspense title="Loading guided flow" detail="Friday is preparing your guided experience.">
                <GuidedFlowPage />
              </RouteSuspense>
            ),
          },
          {
            path: "assistant",
            element: (
              <RouteSuspense title="Loading assistant" detail="Friday is preparing the beginner-first assistant surface.">
                <AssistantPage />
              </RouteSuspense>
            ),
          },
          {
            index: true,
            element: <Navigate to="/chat" replace />,
          },
          {
            path: "command-center",
            element: (
              <RouteSuspense title="Loading control center" detail="Friday is preparing the main operator console.">
                <AgentPage />
              </RouteSuspense>
            ),
          },
          {
            path: "fleet",
            element: (
              <RouteSuspense title="Loading fleet" detail="Friday is preparing the fleet control plane.">
                <FleetPage />
              </RouteSuspense>
            ),
          },
          {
            path: "marketplace",
            element: (
              <RouteSuspense title="Loading marketplace" detail="Friday is preparing the public creator ecosystem.">
                <MarketplacePage />
              </RouteSuspense>
            ),
          },
          {
            path: "automations",
            element: (
              <RouteSuspense title="Loading automations" detail="Friday is preparing the automation queue.">
                <AutomationsPage />
              </RouteSuspense>
            ),
          },
          {
            path: "observability",
            element: (
              <RouteSuspense title="Loading observability" detail="Friday is preparing trace, audit, alert, and health views.">
                <ObservabilityPage />
              </RouteSuspense>
            ),
          },
          {
            path: "skills",
            element: (
              <RouteSuspense title="Loading skills" detail="Friday is preparing the skills lifecycle surface.">
                <SkillsPage />
              </RouteSuspense>
            ),
          },
          {
            path: "skills/generator",
            element: (
              <RouteSuspense title="Loading skill generator" detail="Friday is preparing the skill generator workflow.">
                <SkillGeneratorPage />
              </RouteSuspense>
            ),
          },
          {
            path: "workflows",
            element: (
              <RouteSuspense title="Loading workflows" detail="Friday is preparing workflow deploy and visualization surfaces.">
                <WorkflowsPage />
              </RouteSuspense>
            ),
          },
          {
            path: "workflows/builder",
            element: (
              <RouteSuspense title="Loading workflow builder" detail="Friday is preparing template-first workflow authoring surfaces.">
                <WorkflowBuilderPage />
              </RouteSuspense>
            ),
          },
          { path: "automations/:automationId", element: <LegacyRedirectPage /> },
          {
            path: "settings",
            element: (
              <RouteSuspense title="Loading settings" detail="Friday is preparing runtime settings and diagnostics.">
                <SettingsPage />
              </RouteSuspense>
            ),
          },
          { path: "skills/*", element: <Navigate to="/skills" replace /> },
          { path: "workflows/*", element: <LegacyRedirectPage /> },
          { path: "sessions", element: <LegacyRedirectPage /> },
          { path: "sessions/*", element: <LegacyRedirectPage /> },
          {
            path: "memory",
            element: (
              <RouteSuspense title="Loading memory" detail="Friday is preparing the memory store view.">
                <MemoryPage />
              </RouteSuspense>
            ),
          },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/chat" replace /> },
]);
