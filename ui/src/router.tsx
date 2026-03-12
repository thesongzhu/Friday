import { Suspense, lazy, type ReactNode } from "react";
import { Navigate, Outlet, createBrowserRouter, useLocation } from "react-router-dom";
import { AppShell } from "@/components/layout/app-shell";
import { useAuth } from "@/hooks/use-auth";
import { useSetupStatusQuery } from "@/hooks/use-setup";
import { resolveLegacyRedirect } from "@/lib/routes/legacy-routes";

const AgentPage = lazy(async () => import("@/routes/agent-page").then((module) => ({ default: module.AgentPage })));
const AssistantPage = lazy(async () => import("@/routes/assistant-page").then((module) => ({ default: module.AssistantPage })));
const AutomationsPage = lazy(async () => import("@/routes/automations-page").then((module) => ({ default: module.AutomationsPage })));
const FleetPage = lazy(async () => import("@/routes/fleet-page").then((module) => ({ default: module.FleetPage })));
const LoginPage = lazy(async () => import("@/routes/login-page").then((module) => ({ default: module.LoginPage })));
const MarketplacePage = lazy(async () => import("@/routes/marketplace-page").then((module) => ({ default: module.MarketplacePage })));
const ObservabilityPage = lazy(async () => import("@/routes/observability-page").then((module) => ({ default: module.ObservabilityPage })));
const SettingsPage = lazy(async () => import("@/routes/settings-page").then((module) => ({ default: module.SettingsPage })));
const SetupPage = lazy(async () => import("@/routes/setup-page").then((module) => ({ default: module.SetupPage })));
const SkillsPage = lazy(async () => import("@/routes/skills-page").then((module) => ({ default: module.SkillsPage })));
const WorkflowsPage = lazy(async () => import("@/routes/workflows-page").then((module) => ({ default: module.WorkflowsPage })));

function FullscreenMessage(props: { title: string; detail: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-canvas)] px-6 text-white">
      <div className="max-w-xl text-center">
        <p className="agent-eyebrow">Friday Agent OS</p>
        <h1 className="font-[var(--font-display)] text-3xl font-semibold tracking-tight">
          {props.title}
        </h1>
        <p className="mt-4 text-sm leading-7 text-white/60">{props.detail}</p>
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <FullscreenMessage
        title="Restoring session"
        detail="Friday is checking the current operator session before loading the control shell."
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
  const { data: setupStatus, isLoading, isError } = useSetupStatusQuery();

  if (isLoading) {
    return (
      <FullscreenMessage
        title="Inspecting local setup"
        detail="Friday is verifying whether the local machine has already completed bootstrap."
      />
    );
  }

  if (isError) {
    return (
      <FullscreenMessage
        title="Setup status unavailable"
        detail="The frontend could not reach the setup status route. Verify that the Friday API is running and authenticated."
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
        element: <AppShell />,
        children: [
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
            element: <Navigate to="/assistant" replace />,
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
            path: "workflows",
            element: (
              <RouteSuspense title="Loading workflows" detail="Friday is preparing workflow deploy and visualization surfaces.">
                <WorkflowsPage />
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
          { path: "memory", element: <LegacyRedirectPage /> },
          { path: "memory/*", element: <LegacyRedirectPage /> },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/assistant" replace /> },
]);
