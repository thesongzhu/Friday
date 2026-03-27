import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ChevronRight, Loader2, Sparkles } from "lucide-react";
import { agentApi } from "@/lib/api/agent";
import { systemApi } from "@/lib/api/system";
import { GoalCard } from "@/components/guided/goal-card";
import { OneClickAction } from "@/components/guided/one-click-action";
import { JourneyTracker } from "@/components/guided/journey-tracker";
import { ShellCard, StatusPill } from "@/components/core/primitives";
import { useUserProfile } from "@/hooks/use-user-profile";
import { getGoalCategoriesForProfile } from "@/lib/guided/goal-categories";
import { buildGuidedFlowJourneyPhases, buildGuidedFlowCurrentPhaseIndex } from "@/lib/guided/flow-adapters";
import type { FridayGoalCategory } from "@/lib/guided/goal-categories";

function greetingForTimeOfDay(): string {
  const hour = new Date().getHours();
  if (hour < 6) return "Late night?";
  if (hour < 12) return "Good morning.";
  if (hour < 18) return "Good afternoon.";
  return "Good evening.";
}

function RunSummaryCard(props: {
  task: string;
  status: string;
  startedAt?: string;
}) {
  const elapsed = props.startedAt
    ? Math.floor((Date.now() - new Date(props.startedAt).getTime()) / 60_000)
    : 0;
  const timeLabel = elapsed < 1 ? "Just now" : elapsed < 60 ? `${String(elapsed)}m ago` : `${String(Math.floor(elapsed / 60))}h ago`;

  return (
    <div className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3">
      <StatusPill
        tone={
          props.status === "completed"
            ? "success"
            : props.status === "failed"
              ? "danger"
              : "neutral"
        }
      >
        {props.status}
      </StatusPill>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-white/70">{props.task}</p>
        <p className="mt-0.5 text-xs text-white/40">{timeLabel}</p>
      </div>
    </div>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  const { profileType } = useUserProfile();
  const [hoveredGoal, setHoveredGoal] = useState<string | null>(null);

  const goalCategories = useMemo(
    () => getGoalCategoriesForProfile(profileType, 6),
    [profileType],
  );

  const recentRunsQuery = useQuery({
    queryKey: ["home", "recent-runs"],
    queryFn: () => agentApi.listRuns({ limit: 3 }),
    refetchInterval: 10_000,
  });

  const alertsQuery = useQuery({
    queryKey: ["home", "alerts"],
    queryFn: () => systemApi.listObservabilityAlerts({ status: "firing", limit: 2 }),
    refetchInterval: 15_000,
  });

  const recentRuns = recentRunsQuery.data ?? [];
  const activeRun = recentRuns.find(
    (run) =>
      run.status === "pending" ||
      run.status === "executing" ||
      run.status === "planning" ||
      run.status === "awaiting_plan_approval" ||
      run.status === "awaiting_clarification",
  );

  function handleGoalClick(category: FridayGoalCategory) {
    navigate(`/flow/${encodeURIComponent(category.wizardId)}`);
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 py-4">
      {/* Greeting */}
      <div className="space-y-1">
        <p className="text-sm text-white/40">{greetingForTimeOfDay()}</p>
        <h1 className="font-[var(--font-display)] text-3xl font-semibold tracking-tight text-white">
          What do you want to achieve?
        </h1>
        <p className="text-sm leading-6 text-white/50">
          Pick a goal. Friday will investigate, present options, and guide you step by step.
        </p>
      </div>

      {/* Active flow */}
      {activeRun && (
        <JourneyTracker
          goalTitle={activeRun.task}
          phases={buildGuidedFlowJourneyPhases(null, false, activeRun.status === "executing")}
          currentPhaseIndex={buildGuidedFlowCurrentPhaseIndex(
            buildGuidedFlowJourneyPhases(null, false, activeRun.status === "executing"),
          )}
        />
      )}

      {/* Goal grid */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {goalCategories.map((category) => (
          <GoalCard
            key={category.id}
            icon={category.icon}
            title={category.title}
            subtitle={category.subtitle}
            outcome={category.outcome}
            recommended={category.recommended}
            onClick={() => handleGoalClick(category)}
          />
        ))}
      </div>

      {/* Show all goals link */}
      {goalCategories.length < 10 && (
        <button
          type="button"
          onClick={() => {
            // Show all goals - could navigate to a goals index or expand the grid
            navigate("/flow/browse");
          }}
          className="flex items-center gap-1.5 text-xs font-medium text-white/40 transition hover:text-white/70"
        >
          Show all goals
          <ChevronRight className="h-3 w-3" />
        </button>
      )}

      {/* Recent activity */}
      {recentRuns.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/40">
              Recent
            </p>
            <Link
              to="/assistant"
              className="flex items-center gap-1 text-xs text-white/40 transition hover:text-white/60"
            >
              Full dashboard
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="space-y-2">
            {recentRuns.slice(0, 3).map((run) => (
              <RunSummaryCard
                key={run.id}
                task={run.task}
                status={run.status}
                startedAt={run.startedAt}
              />
            ))}
          </div>
        </div>
      )}

      {/* Expert mode link */}
      <div className="border-t border-white/[0.06] pt-4">
        <Link
          to="/assistant"
          className="flex items-center gap-2 text-xs text-white/30 transition hover:text-white/50"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Switch to full Assistant dashboard (expert mode)
        </Link>
      </div>
    </div>
  );
}
