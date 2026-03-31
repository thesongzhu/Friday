import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  Command,
  LayoutTemplate,
  Loader2,
  MonitorCog,
  RefreshCcw,
  ShieldAlert,
  Wand2,
  Waypoints,
} from "lucide-react";
import { toast } from "sonner";
import { useAgentRunEvents } from "@/hooks/use-agent-run-events";
import { agentApi } from "@/lib/api/agent";
import { assistantDiagnosticsApi } from "@/lib/api/assistant-diagnostics";
import { fleetApi } from "@/lib/api/fleet";
import {
  marketplaceApi,
  type FridayCreatorProfile,
  type FridayMarketplaceAssetKind,
  type FridayMarketplaceRequestPost,
} from "@/lib/api/marketplace";
import { skillsApi } from "@/lib/api/skills";
import { systemApi } from "@/lib/api/system";
import { workflowsApi } from "@/lib/api/workflows";
import { automationsApi } from "@/lib/api/automations";
import type {
  FridayActionTemplateSummary,
  FridayAgentLoopPolicy,
  FridayAgentLoopRunRecord,
  FridayAutoFixMetricsResponse,
  FridayBeginnerIntentResolution,
  FridayFixPlanRecord,
  FridayIssueCard,
  FridayObservabilityAlertSummary,
  FridayObservabilityOverview,
  FridaySystemIntentAction,
  FridaySystemSession,
  FridaySystemSnapshot,
  FridayWorkflowOverview,
} from "@/lib/api/system-types";
import type {
  AgentTaskProfileId,
  AssistantDiagnostics,
  AgentRunRecord,
  FridayFleetOverviewResponse,
  FridayFleetSatelliteCard,
  FridayPendingSatellitePairingRequest,
  SkillCatalogItem,
  SkillLifecycleSummary,
  SkillSourceRecord,
} from "@/lib/api/types";
import { ActionButton, FieldLabel, ShellCard, StatusPill } from "@/components/core/primitives";
import {
  FRIDAY_ASSISTANT_STARTER_TASKS,
  getAssistantStarterTask,
} from "@/lib/assistant/starter-tasks";
import {
  deriveAssistantOutcomeReceipt,
  normalizeAssistantTask,
  type FridayAssistantOutcomeReceipt,
} from "@/lib/assistant/outcome-receipts";
import {
  buildAssistantIssuePlaybook,
  buildAssistantQuickActions,
  buildAssistantRecoveryPaths,
  type FridayAssistantQuickAction,
} from "@/lib/assistant/view-models";
import { buildFleetHref } from "@/lib/fleet/view-models";
import {
  buildMarketplaceAssistantCards,
  buildMarketplaceHref,
  summarizeCreatorSupport,
  summarizeMarketplaceRequestState,
} from "@/lib/marketplace/view-models";
import { buildObservabilityHref } from "@/lib/observability/view-models";
import { buildSkillGeneratorHref, buildSkillHref } from "@/lib/skills/view-models";
import { buildWorkflowBuilderHref, buildWorkflowHref } from "@/lib/workflows/view-models";

const OPERATOR_ID = "assistant-shell";
const ASSISTANT_UIX_SESSION_KEY = `ui:assistant:${OPERATOR_ID}`;
const ASSISTANT_OUTCOME_RECEIPT_COOLDOWN_KEY = "friday.assistant.outcome-receipt.cooldowns";
const ACTIVE_ASSISTANT_RUN_STATUSES = [
  "pending",
  "planning",
  "awaiting_clarification",
  "awaiting_plan_approval",
  "executing",
  "testing",
  "fixing",
] as const;

function isAssistantActiveRunStatus(status: string): status is (typeof ACTIVE_ASSISTANT_RUN_STATUSES)[number] {
  return ACTIVE_ASSISTANT_RUN_STATUSES.includes(status as (typeof ACTIVE_ASSISTANT_RUN_STATUSES)[number]);
}
const QUICK_INTENTS = [
  "Help me figure out what I should do next.",
  "Generate and deploy a workflow for weekly reporting.",
  "Review what Friday has already detected and tell me the safest next recovery step.",
  "This system looks unhealthy. Figure out what is wrong and guide me.",
] as const;

const ASSISTANT_TASK_STORIES = [
  {
    templateId: "workflow-builder-launch",
    title: "Open workflow builder",
    description: "Jump straight into the template-first builder so you can instantiate a stable starter, create a draft, and publish from one place.",
    outcome: "A direct path from idea to draft lifecycle without bouncing back to the control plane first.",
  },
  {
    templateId: "idea-clarifier",
    title: "Clarify an idea",
    description: "Turn a rough request into a bounded objective, the missing scope questions, and the next planning step before implementation starts.",
    outcome: "A concrete first milestone instead of a vague idea dump.",
  },
  {
    templateId: "implementation-plan-review",
    title: "Review implementation plan",
    description: "Check architecture, edge cases, tests, rollback, and observability before you spend time building the wrong thing.",
    outcome: "An execution review with the biggest plan gap called out clearly.",
  },
  {
    templateId: "browser-qa-report",
    title: "QA this page or app",
    description: "Run a browser-backed QA pass with screenshot, console, request failure, and accessibility snapshot evidence.",
    outcome: "A real QA report instead of a guess about whether the page works.",
  },
  {
    templateId: "workspace-diff-review",
    title: "Review current changes",
    description: "Inspect the live workspace diff with a pre-landing mindset and call out the structural hotspots first.",
    outcome: "A focused diff review with the riskiest area already prioritized.",
  },
  {
    templateId: "release-doc-sync",
    title: "Sync release docs",
    description: "Keep README, changelog, and architecture notes aligned with what actually changed in the workspace.",
    outcome: "A bounded documentation sync instead of stale release-facing docs.",
  },
  {
    templateId: "integration-mode-review",
    title: "Review integration mode",
    description: "See whether a capability should stay as a stable skill, shift to CLI-first execution, or remain MCP-backed before you add more tool surface.",
    outcome: "A clearer decision on skill vs CLI vs MCP before the surface area sprawls.",
  },
  {
    templateId: "context-governance-review",
    title: "Review context governance",
    description: "Inspect task profiles, MCP loading, preprocessors, and context cost so the assistant stays predictable and cheaper to run.",
    outcome: "A diagnostics-first path to trim context and choose the right task profile.",
  },
] as const;

function splitSeedList(value: string): string[] {
  return value
    .split(/,|;|\band\b/gi)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function extractSection(goal: string, label: "constraints" | "risk" | "budget"): string | null {
  const pattern = new RegExp(`${label}\\s*:\\s*([^\\n.]+)`, "i");
  const match = goal.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function deriveAssistantRequestGoal(goal?: string): string {
  if (!goal) {
    return "";
  }
  return goal
    .replace(/\s+constraints\s*:\s*[^.\n]+/gi, "")
    .replace(/\s+risk\s*:\s*[^.\n]+/gi, "")
    .replace(/\s+budget\s*:\s*[^.\n]+/gi, "")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+\./g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveAssistantRequestConstraints(
  goal?: string,
  intentResult?: FridayBeginnerIntentResolution | null,
): string[] {
  const constraints = new Set<string>();
  const rawGoal = goal ?? "";
  const explicitConstraints = extractSection(rawGoal, "constraints");
  for (const entry of explicitConstraints ? splitSeedList(explicitConstraints) : []) {
    constraints.add(entry);
  }
  if (/read[- ]only/i.test(rawGoal)) {
    constraints.add("read-only");
  }
  if (/no outbound network access/i.test(rawGoal)) {
    constraints.add("no outbound network access");
  }
  if (/no production writes?/i.test(rawGoal)) {
    constraints.add("no production writes");
  }
  if (/no destructive actions?/i.test(rawGoal)) {
    constraints.add("no destructive actions");
  }
  for (const assumption of intentResult?.assumptions ?? []) {
    if (assumption.trim().length > 0) {
      constraints.add(assumption.trim());
    }
  }
  return [...constraints];
}

function deriveAssistantRequestRiskNotes(
  goal?: string,
  intentResult?: FridayBeginnerIntentResolution | null,
): string | null {
  return extractSection(goal ?? "", "risk") ?? intentResult?.fallbackPath ?? null;
}

function deriveAssistantBudgetSupportIntent(goal?: string): string | null {
  const explicitBudget = extractSection(goal ?? "", "budget");
  if (explicitBudget) {
    return explicitBudget;
  }
  const inlineBudget = goal?.match(/\$\d+\s*(?:tip|support|budget)/i)?.[0];
  return inlineBudget?.trim() ?? null;
}

function buildAssistantMarketplaceRequestHref(input: {
  requestKind: FridayMarketplaceAssetKind;
  goalSeed?: string;
  intentResult?: FridayBeginnerIntentResolution | null;
}): string {
  const goal = input.goalSeed?.trim() || input.intentResult?.objective?.trim() || "";
  const structuredGoal = deriveAssistantRequestGoal(goal) || goal;
  const assetLabel =
    input.requestKind === "workflow" || input.requestKind === "agent"
      ? input.requestKind
      : "skill";

  return buildMarketplaceHref({
    requestKind: input.requestKind,
    goal,
    title: structuredGoal ? `Need a ${assetLabel} for: ${structuredGoal}` : undefined,
    desiredOutcome: structuredGoal
      ? `A usable ${assetLabel} that solves: ${structuredGoal}`
      : undefined,
    constraints: deriveAssistantRequestConstraints(goal, input.intentResult),
    riskNotes: deriveAssistantRequestRiskNotes(goal, input.intentResult),
    budgetSupportIntent: deriveAssistantBudgetSupportIntent(goal),
  });
}

function formatTimestamp(value?: string): string {
  if (!value) return "Not yet";
  return new Date(value).toLocaleString();
}

function formatRelative(value?: string): string {
  if (!value) return "Not yet";
  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatRunDuration(valueMs?: number): string {
  if (typeof valueMs !== "number" || !Number.isFinite(valueMs) || valueMs < 0) return "0s";
  const totalSeconds = Math.floor(valueMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 1) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return `${minutes}m ${seconds}s`;
  return `${hours}h ${minutes % 60}m`;
}

function mapTone(
  value?: string,
): "neutral" | "success" | "warning" | "danger" {
  if (!value) return "neutral";
  if (["healthy", "completed", "active", "ready", "verified", "ok", "paired", "online"].includes(value)) {
    return "success";
  }
  if (["blocked", "warning", "degraded", "safe_mode", "paused", "needs_one_answer"].includes(value)) {
    return "warning";
  }
  if (["failed", "error", "danger", "out_of_boundary", "revoked", "offline"].includes(value)) {
    return "danger";
  }
  return "neutral";
}

function classifyPlanTone(state?: FridayBeginnerIntentResolution["state"]) {
  if (state === "ready_to_execute") return "success";
  if (state === "needs_one_answer") return "warning";
  if (state === "blocked_by_policy" || state === "out_of_boundary") return "danger";
  return "neutral";
}

function summarizeLoopRun(run: FridayAgentLoopRunRecord): string {
  if (run.run.verificationPassed) {
    return "Verification passed after the latest repair attempt.";
  }
  if (run.run.rollbackAttempted) {
    return "Friday rolled back the last repair after verification failed.";
  }
  if (run.run.status === "halted") {
    return run.run.haltReason ?? "Friday paused itself after repeated failures.";
  }
  if (run.run.status === "awaiting_approval") {
    return "A higher-risk fix is waiting for approval before execution.";
  }
  return run.run.planSummary ?? run.action?.summary.summary ?? run.incident?.summary.rootCauseSummary ?? "Friday is still evaluating the next step.";
}

function riskClassForFix(action?: FridayFixPlanRecord["action"]): string {
  if (!action) return "unknown";
  if (action.riskTier >= 2) {
    return "Approval required";
  }
  if (action.riskTier === 1) {
    return "Bounded repair";
  }
  return "Safe probe";
}

function latestMetricsSummary(
  metricsSummary?: FridayAutoFixMetricsResponse,
) {
  if (!metricsSummary) return undefined;
  return Array.isArray(metricsSummary.metrics)
    ? metricsSummary.metrics[0]
    : metricsSummary.metrics;
}

function workflowTone(overview: FridayWorkflowOverview): "neutral" | "success" | "warning" | "danger" {
  if (overview.latestRun?.status === "failed") return "danger";
  if (overview.latestDraft) return "warning";
  if (overview.publishedVersion) return "success";
  return "neutral";
}

function statusLabelForFleetCard(card: FridayFleetSatelliteCard): string {
  if (card.pairingStatus === "revoked") return "revoked";
  if (card.healthState === "degraded" || card.healthState === "critical") return card.healthState;
  if (card.pairingStatus === "offline") return "offline";
  if (card.pairingStatus === "paired") return "paired";
  return card.pairingStatus;
}

function compactText(text?: string): string {
  if (!text) return "No summary yet.";
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function formatEstimatedChars(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(Math.round(value));
}

function summarizeContextCostComponent(
  run: Pick<AgentRunRecord, "contextCostSummary"> | Pick<AssistantDiagnostics["recentRuns"][number], "contextCostSummary"> | null | undefined,
  kind: "workspace_context" | "starter_skills" | "mcp" | "subagents",
): string {
  const component = run?.contextCostSummary?.components.find((entry) => entry.kind === kind);
  if (!component) return "0";
  const countLabel = typeof component.count === "number" ? `${component.count} / ` : "";
  return `${countLabel}${formatEstimatedChars(component.estimatedChars)} chars`;
}

function summarizeMcpServerStates(states: AssistantDiagnostics["mcpServerStates"]) {
  const summary = {
    configured: 0,
    discoverable: 0,
    loaded: 0,
    deferred: 0,
  };
  for (const state of states) {
    summary[state.state] += 1;
  }
  return summary;
}

function isCliFirstSkill(skill: Pick<SkillLifecycleSummary, "originType" | "tags">) {
  return skill.originType === "cli-backed" || skill.tags.includes("starter.cli") || skill.tags.includes("cli-backed");
}

function describeSkillIntegrationMode(skill: Pick<SkillLifecycleSummary, "originType" | "tags">): string {
  if (skill.originType === "cli-backed" || isCliFirstSkill(skill)) {
    return "CLI-backed";
  }
  if (skill.originType === "mcp-backed") {
    return "MCP-backed";
  }
  if (skill.originType === "stabilized") {
    return "Stable skill";
  }
  return "Generated";
}

function readOutcomeReceiptCooldowns(): Record<string, string> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(ASSISTANT_OUTCOME_RECEIPT_COOLDOWN_KEY);
    return raw ? JSON.parse(raw) as Record<string, string> : {};
  } catch {
    return {};
  }
}

function getActiveOutcomeReceiptCooldownTaskKeys(nowMs = Date.now()): string[] {
  return Object.entries(readOutcomeReceiptCooldowns())
    .filter(([, until]) => new Date(until).getTime() > nowMs)
    .map(([taskKey]) => taskKey);
}

function setOutcomeReceiptCooldown(task: string, days = 14): string[] {
  const taskKey = normalizeAssistantTask(task);
  const cooldowns = readOutcomeReceiptCooldowns();
  cooldowns[taskKey] = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  if (typeof window !== "undefined") {
    window.localStorage.setItem(ASSISTANT_OUTCOME_RECEIPT_COOLDOWN_KEY, JSON.stringify(cooldowns));
  }
  return getActiveOutcomeReceiptCooldownTaskKeys();
}

function buildAssistantAutomationName(task: string): string {
  const trimmed = task.trim();
  if (trimmed.length <= 48) {
    return trimmed;
  }
  return `${trimmed.slice(0, 45)}...`;
}

function buildAutomationsPrefillHref(receipt: FridayAssistantOutcomeReceipt): string {
  const params = new URLSearchParams({
    name: buildAssistantAutomationName(receipt.task),
    task: receipt.task,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  return `/automations?${params.toString()}`;
}

export function AssistantPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [goal, setGoal] = useState("");
  const [intentResult, setIntentResult] = useState<FridayBeginnerIntentResolution | null>(null);
  const [templateValues, setTemplateValues] = useState<Record<string, Record<string, string | boolean>>>({});
  const [suppressedOutcomeTaskKeys, setSuppressedOutcomeTaskKeys] = useState<string[]>(() =>
    getActiveOutcomeReceiptCooldownTaskKeys(),
  );
  const [selectedTaskProfileId, setSelectedTaskProfileId] = useState<AgentTaskProfileId>("default");
  const setupStarterApplied = useRef(false);

  const sessionQuery = useQuery({
    queryKey: ["assistant-shell", "session"],
    queryFn: () => systemApi.getSession(),
    refetchInterval: 10_000,
  });

  const stateQuery = useQuery({
    queryKey: ["assistant-shell", "state"],
    queryFn: () => systemApi.getState(),
    refetchInterval: 10_000,
  });

  const observabilityQuery = useQuery({
    queryKey: ["assistant-shell", "observability-overview"],
    queryFn: () => systemApi.getObservabilityOverview(),
    refetchInterval: 20_000,
  });

  const templatesQuery = useQuery({
    queryKey: ["assistant-shell", "templates"],
    queryFn: () => systemApi.listAssistantTemplates(),
  });

  const issuesQuery = useQuery({
    queryKey: ["assistant-shell", "issues"],
    queryFn: () => systemApi.listAssistantIssues(12),
    refetchInterval: 20_000,
  });

  const incidentsQuery = useQuery({
    queryKey: ["assistant-shell", "incidents"],
    queryFn: () => systemApi.listDiagnosisIncidents({ limit: 8 }),
    refetchInterval: 20_000,
  });

  const autoFixQuery = useQuery({
    queryKey: ["assistant-shell", "auto-fix"],
    queryFn: () => systemApi.listAutoFixActions({ limit: 8 }),
    refetchInterval: 20_000,
  });

  const metricsQuery = useQuery({
    queryKey: ["assistant-shell", "auto-fix-metrics"],
    queryFn: () => systemApi.getAutoFixMetrics(),
    refetchInterval: 30_000,
  });

  const loopPolicyQuery = useQuery({
    queryKey: ["assistant-shell", "loop-policy"],
    queryFn: () => systemApi.getAgentLoopPolicy(),
    refetchInterval: 20_000,
  });

  const expertModeQuery = useQuery({
    queryKey: ["assistant-shell", "expert-mode"],
    queryFn: () => systemApi.getAgentLoopExpertMode(),
    refetchInterval: 20_000,
  });

  const loopRunsQuery = useQuery({
    queryKey: ["assistant-shell", "loop-runs"],
    queryFn: () => systemApi.listAgentLoopRuns({ limit: 8 }),
    refetchInterval: 20_000,
  });

  const agentRunsQuery = useQuery({
    queryKey: ["assistant-shell", "agent-runs"],
    queryFn: () => agentApi.listRuns({ limit: 8 }),
    refetchInterval: 5_000,
  });

  const diagnosticsQuery = useQuery({
    queryKey: ["assistant-shell", "diagnostics"],
    queryFn: () => assistantDiagnosticsApi.get(),
    refetchInterval: 10_000,
  });

  const workflowsQuery = useQuery({
    queryKey: ["assistant-shell", "workflows"],
    queryFn: () => workflowsApi.list({ limit: 6 }),
    refetchInterval: 20_000,
  });

  const workflowSeeds = workflowsQuery.data?.items.slice(0, 3) ?? [];
  const workflowOverviewQueries = useQueries({
    queries: workflowSeeds.map((workflow) => ({
      queryKey: ["assistant-shell", "workflow-overview", workflow.id],
      queryFn: () => systemApi.getWorkflowOverview(workflow.id, { recentRunLimit: 4 }),
      staleTime: 20_000,
    })),
  });

  const skillsQuery = useQuery({
    queryKey: ["assistant-shell", "skills"],
    queryFn: () => skillsApi.listSkills(),
    refetchInterval: 20_000,
  });

  const automationsQuery = useQuery({
    queryKey: ["assistant-shell", "automations"],
    queryFn: () => automationsApi.list({ limit: 20 }),
    refetchInterval: 15_000,
  });

  const catalogQuery = useQuery({
    queryKey: ["assistant-shell", "skill-catalog"],
    queryFn: () => skillsApi.listCatalog({ limit: 6 }),
    refetchInterval: 30_000,
  });

  const sourcesQuery = useQuery({
    queryKey: ["assistant-shell", "skill-sources"],
    queryFn: () => skillsApi.listSources(),
    refetchInterval: 30_000,
  });

  const fleetOverviewQuery = useQuery({
    queryKey: ["assistant-shell", "fleet-overview"],
    queryFn: () => fleetApi.getOverview(),
    refetchInterval: 15_000,
  });

  const satellitesQuery = useQuery({
    queryKey: ["assistant-shell", "satellites"],
    queryFn: () => fleetApi.listSatellites({ limit: 6 }),
    refetchInterval: 15_000,
  });

  const pairingRequestsQuery = useQuery({
    queryKey: ["assistant-shell", "satellite-pairing-requests"],
    queryFn: () => fleetApi.listPairingRequests(),
    refetchInterval: 15_000,
  });

  const alertsQuery = useQuery({
    queryKey: ["assistant-shell", "observability-alerts"],
    queryFn: () => systemApi.listObservabilityAlerts({ status: "firing", limit: 4 }),
    refetchInterval: 15_000,
  });

  const marketplaceAssetsQuery = useQuery({
    queryKey: ["assistant-shell", "marketplace-assets"],
    queryFn: () => marketplaceApi.listAssets(),
    refetchInterval: 30_000,
  });

  const marketplaceCreatorsQuery = useQuery({
    queryKey: ["assistant-shell", "marketplace-creators"],
    queryFn: () => marketplaceApi.listCreators(),
    refetchInterval: 30_000,
  });

  const marketplaceRequestsQuery = useQuery({
    queryKey: ["assistant-shell", "marketplace-requests"],
    queryFn: () => marketplaceApi.listRequests(),
    refetchInterval: 30_000,
  });

  const systemIntentMutation = useMutation({
    mutationFn: (input: {
      action: FridaySystemIntentAction;
      layout?: "single_focus" | "dual_pane" | "triad";
      reason?: string;
    }) =>
      systemApi.executeIntent({
        action: input.action,
        actorId: OPERATOR_ID,
        actorKind: "api",
        layout: input.layout,
        reason: input.reason,
      }),
    onSuccess: (result) => {
      toast.success(result.message);
      void queryClient.invalidateQueries({ queryKey: ["assistant-shell", "session"] });
      void queryClient.invalidateQueries({ queryKey: ["assistant-shell", "state"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "System action failed");
    },
  });

  const resolveIntentMutation = useMutation({
    mutationFn: (text: string) => systemApi.resolveAssistantIntent(text),
    onSuccess: (result) => {
      setIntentResult(result);
      toast.success("Friday turned your goal into a guided plan.");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Friday could not interpret that goal");
    },
  });

  const approvePlanMutation = useMutation({
    mutationFn: (runId: string) => agentApi.approvePlan(runId),
    onSuccess: async () => {
      toast.success("Plan approved.");
      await invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Plan approval failed");
    },
  });

  const rejectPlanMutation = useMutation({
    mutationFn: (runId: string) => agentApi.rejectPlan(runId),
    onSuccess: async () => {
      toast.success("Plan rejected.");
      await invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Plan rejection failed");
    },
  });

  const executeTemplateMutation = useMutation({
    mutationFn: (input: {
      templateId: string;
      parameters?: Record<string, unknown>;
      assistantSessionKey?: string;
    }) => systemApi.executeAssistantTemplate(input),
    onSuccess: (result) => {
      toast.success(result.summary);
      if (result.objective || result.assumptions || result.unknowns || result.state) {
        setIntentResult({
          intent: result.workflow?.kind === "blocked" ? "review_issues" : "general_help",
          confidence: 1,
          summary: result.summary,
          routeTarget: "/assistant",
          suggestedTemplateIds: [],
          state: result.state,
          objective: result.objective,
          assumptions: result.assumptions,
          unknowns: result.unknowns,
          successTest: result.successTest,
          fallbackPath: result.fallbackPath,
        });
      }
      void invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Template execution failed");
    },
  });

  const deployDraftMutation = useMutation({
    mutationFn: (input: {
      workflowId: string;
      draftId: string;
      runNow?: boolean;
      includeExport?: boolean;
    }) =>
      systemApi.deployWorkflowDraft(input.workflowId, input.draftId, {
        runNow: input.runNow,
        includeExport: input.includeExport,
        resyncTriggers: true,
        changeNote: "Triggered from assistant-first control center",
      }),
    onSuccess: (result) => {
      toast.success(
        result.run
          ? `Workflow ${result.workflowId} deployed and run started.`
          : `Workflow ${result.workflowId} deployed.`,
      );
      void invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Workflow deployment failed");
    },
  });

  const installSkillMutation = useMutation({
    mutationFn: (input: { skillId: string; sourceId?: string }) =>
      skillsApi.installSkill({
        skillId: input.skillId,
        sourceId: input.sourceId,
      }),
    onSuccess: (result) => {
      toast.success(`Installed ${result.skill.name} (${result.installation.resolvedVersion}).`);
      void invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Skill install failed");
    },
  });

  const saveAutomationMutation = useMutation({
    mutationFn: (input: { name: string; taskTemplate: string; sourceRunId?: string }) =>
      agentApi.saveAutomation({
        name: input.name,
        taskTemplate: input.taskTemplate,
        sourceRunId: input.sourceRunId,
        enabled: true,
      }),
    onSuccess: (automation) => {
      toast.success(`Saved "${automation.name}" as an automation.`);
      void invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not save this as an automation");
    },
  });

  const updateSkillMutation = useMutation({
    mutationFn: (skillId: string) => skillsApi.updateSkill(skillId),
    onSuccess: (result) => {
      toast.success(`Updated ${result.skill.name} to ${result.installation.resolvedVersion}.`);
      void invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Skill update failed");
    },
  });

  const verifySkillMutation = useMutation({
    mutationFn: (skillId: string) => skillsApi.verifySkill(skillId),
    onSuccess: (result) => {
      toast.success(result.ok ? "Skill verification passed." : "Skill verification needs attention.");
      void invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Skill verification failed");
    },
  });

  const toggleSourceMutation = useMutation({
    mutationFn: (input: { sourceId: string; enabled: boolean }) =>
      input.enabled ? skillsApi.disableSource(input.sourceId) : skillsApi.enableSource(input.sourceId),
    onSuccess: (source) => {
      toast.success(`${source.name} is now ${source.enabled ? "enabled" : "disabled"}.`);
      void invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Source update failed");
    },
  });

  const approveFixMutation = useMutation({
    mutationFn: (actionId: string) => systemApi.approveAutoFixAction(actionId),
    onSuccess: (result) => {
      toast.success(result.action.summary.title);
      void invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Approval failed");
    },
  });

  const executeFixMutation = useMutation({
    mutationFn: (actionId: string) => systemApi.executeAutoFixAction(actionId),
    onSuccess: (result) => {
      toast.success(result.action.summary.title);
      void invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Fix execution failed");
    },
  });

  const denyFixMutation = useMutation({
    mutationFn: (actionId: string) => systemApi.denyAutoFixAction(actionId),
    onSuccess: (result) => {
      toast.success(`Denied: ${result.action.summary.title}`);
      void invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Deny failed");
    },
  });

  const rollbackFixMutation = useMutation({
    mutationFn: (actionId: string) => systemApi.rollbackAutoFixAction(actionId, "Rolled back from assistant UI"),
    onSuccess: (result) => {
      toast.success(`Rolled back: ${result.action.summary.title}`);
      void invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Rollback failed");
    },
  });

  const pauseLoopMutation = useMutation({
    mutationFn: (loopRunId: string) => systemApi.pauseAgentLoopRun(loopRunId),
    onSuccess: () => {
      toast.success("Loop paused");
      void invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not pause loop");
    },
  });

  const toggleExpertModeMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      systemApi.updateAgentLoopExpertMode({ enabled }),
    onSuccess: (result) => {
      toast.success(result.enabled ? "Expert mode enabled" : "Expert mode disabled");
      void invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not update expert mode");
    },
  });

  const approvePairingMutation = useMutation({
    mutationFn: (satelliteId: string) => fleetApi.approvePairing(satelliteId),
    onSuccess: () => {
      toast.success("Satellite pairing approved.");
      void invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not approve satellite pairing");
    },
  });

  const rejectPairingMutation = useMutation({
    mutationFn: (input: { satelliteId: string; reason?: string }) =>
      fleetApi.rejectPairing(input.satelliteId, input.reason),
    onSuccess: () => {
      toast.success("Satellite pairing rejected.");
      void invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not reject satellite pairing");
    },
  });

  const acknowledgeAlertMutation = useMutation({
    mutationFn: (input: { alertId: string; note?: string }) =>
      systemApi.acknowledgeObservabilityAlert(input.alertId, input.note),
    onSuccess: () => {
      toast.success("Alert acknowledged.");
      void invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not acknowledge alert");
    },
  });

  const supportMarketplaceAssetMutation = useMutation({
    mutationFn: (assetId: string) =>
      marketplaceApi.supportAsset(assetId, {
        amount: { amount: 500, currency: "USD" },
        message: "Supported from assistant.",
      }),
    onSuccess: () => {
      toast.success("Support sent to the creator.");
      void queryClient.invalidateQueries({ queryKey: ["assistant-shell", "marketplace-creators"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not support this creator");
    },
  });

  const templates = templatesQuery.data?.templates ?? [];
  const issues = issuesQuery.data ?? [];
  const incidents = incidentsQuery.data?.items ?? [];
  const autoFixActions = autoFixQuery.data?.items ?? [];
  const loopRuns = loopRunsQuery.data ?? [];
  const workflowOverviews = workflowOverviewQueries.flatMap((query) => (query.data ? [query.data] : []));
  const installedSkills = skillsQuery.data ?? [];
  const assistantAutomations = automationsQuery.data ?? [];
  const catalogItems = catalogQuery.data?.items ?? [];
  const sources = sourcesQuery.data ?? [];
  const satellites = satellitesQuery.data?.items ?? [];
  const pairingRequests = pairingRequestsQuery.data ?? [];
  const activeAlerts = alertsQuery.data?.items ?? [];
  const marketplaceAssets = marketplaceAssetsQuery.data ?? [];
  const marketplaceCreators = marketplaceCreatorsQuery.data ?? [];
  const marketplaceRequests = marketplaceRequestsQuery.data ?? [];
  const activeAssistantRun = useMemo(
    () =>
      (agentRunsQuery.data ?? []).find((run) =>
        isAssistantActiveRunStatus(run.status),
      ) ?? null,
    [agentRunsQuery.data],
  );
  const latestAssistantRun = (agentRunsQuery.data ?? [])[0] ?? null;
  const displayedAssistantRun = activeAssistantRun ?? latestAssistantRun;
  const latestOutcomeReceipt = useMemo(
    () => deriveAssistantOutcomeReceipt({
      runs: agentRunsQuery.data ?? [],
      automations: assistantAutomations,
      suppressedTaskKeys: suppressedOutcomeTaskKeys,
    }),
    [agentRunsQuery.data, assistantAutomations, suppressedOutcomeTaskKeys],
  );
  const assistantRunEvents = useAgentRunEvents(activeAssistantRun?.id ?? null, {
    enabled: activeAssistantRun !== null,
  });

  useEffect(() => {
    const nextProfileId = activeAssistantRun?.taskProfile?.id ?? latestAssistantRun?.taskProfile?.id;
    if (!nextProfileId) {
      return;
    }
    setSelectedTaskProfileId((current) => (current === "default" ? nextProfileId : current));
  }, [activeAssistantRun?.taskProfile?.id, latestAssistantRun?.taskProfile?.id]);

  const rerunMutation = useMutation({
    mutationFn: (input: { task: string; taskProfileId: AgentTaskProfileId }) =>
      agentApi.startRun({
        task: input.task,
        executionContext: {
          surface: "assistant",
          interactive: true,
        },
        taskProfile: {
          id: input.taskProfileId,
        },
      }),
    onSuccess: async (_, input) => {
      toast.success(`Started a rerun with the ${input.taskProfileId} profile.`);
      await invalidateAssistantShell(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not start the rerun");
    },
  });

  const degradedSatellites = useMemo(
    () =>
      satellites.filter(
        (satellite) =>
          satellite.healthState === "degraded" ||
          satellite.healthState === "critical" ||
          satellite.pairingStatus === "offline",
      ),
    [satellites],
  );

  const workflowActionCards = useMemo(
    () =>
      workflowOverviews.slice(0, 3).map((overview) => ({
        id: overview.workflow.id,
        title: overview.workflow.name,
        summary: overview.latestRunNodeTimeline[0]?.message
          ? `Latest run failed: ${overview.latestRunNodeTimeline[0].message}`
          : overview.latestDraft
            ? "Draft changes are ready to deploy from the assistant."
            : overview.publishedVersion
              ? "Published and ready. Use quick actions to redeploy or export."
              : "Ready for first deployment.",
        tone: workflowTone(overview),
      })),
    [workflowOverviews],
  );

  const quickActions = useMemo(
    () =>
      buildAssistantQuickActions({
        issues,
        workflowOverviews,
        catalogItems,
        degradedSatellites,
        pairingRequests,
        alerts: activeAlerts,
      }),
    [activeAlerts, catalogItems, degradedSatellites, issues, pairingRequests, workflowOverviews],
  );

  const marketplaceCards = useMemo(
    () => buildMarketplaceAssistantCards(marketplaceAssets),
    [marketplaceAssets],
  );

  const recoveryPaths = useMemo(
    () =>
      buildAssistantRecoveryPaths({
        issues,
        workflowOverviews,
        degradedSatellites,
        alerts: activeAlerts,
      }),
    [activeAlerts, degradedSatellites, issues, workflowOverviews],
  );

  useEffect(() => {
    if (setupStarterApplied.current) {
      return;
    }
    const starterState = location.state as
      | {
        starterTaskId?: string;
        starterGoal?: string;
        starterSource?: string;
      }
      | null;
    if (!starterState) {
      return;
    }
    const starterTask = getAssistantStarterTask(starterState.starterTaskId);
    const starterGoal = starterState.starterGoal ?? starterTask?.goal;
    if (!starterGoal) {
      return;
    }
    setupStarterApplied.current = true;
    setGoal(starterGoal);
    resolveIntentMutation.mutate(starterGoal);
  }, [location.state, resolveIntentMutation]);

  const handleExecuteTemplate = (template: FridayActionTemplateSummary) => {
    if (template.id === "workflow-builder-launch") {
      navigate(buildWorkflowBuilderHref());
      toast.success("Opened the workflow builder.");
      return;
    }
    if (template.id === "integration-mode-review") {
      navigate("/skills");
      toast.success("Opened the skills surface for integration review.");
      return;
    }
    if (template.id === "context-governance-review") {
      navigate(buildObservabilityHref({ focus: "assistant" }));
      toast.success("Opened assistant diagnostics.");
      return;
    }
    executeTemplateMutation.mutate({
      templateId: template.id,
      parameters: templateValues[template.id],
      assistantSessionKey: ASSISTANT_UIX_SESSION_KEY,
    });
  };

  return (
    <div className="space-y-6">
      <ShellCard
        eyebrow="Assistant-first control center"
        title="Start with a goal, click through the plan, then dive deeper only when you need context."
        aside={
          <StatusPill tone={mapTone(sessionQuery.data?.health.status)}>
            {sessionQuery.data?.health.status ?? "loading"}
          </StatusPill>
        }
      >
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.95fr)]">
          <div className="space-y-6">
            <GoalIntakeCard
              goal={goal}
              onGoalChange={setGoal}
              onIntentClick={(text) => resolveIntentMutation.mutate(text)}
              onQuickIntent={(text) => {
                setGoal(text);
                resolveIntentMutation.mutate(text);
              }}
              loading={resolveIntentMutation.isPending}
              intentResult={intentResult}
              expertModeEnabled={expertModeQuery.data?.enabled ?? false}
            />

            <OutcomeReceiptCard
              receipt={latestOutcomeReceipt}
              savePending={saveAutomationMutation.isPending}
              onSave={(receipt) =>
                saveAutomationMutation.mutate({
                  name: buildAssistantAutomationName(receipt.task),
                  taskTemplate: receipt.task,
                  sourceRunId: receipt.runId,
                })}
              onPackage={(receipt) => {
                navigate(buildSkillGeneratorHref({
                  goal: `Create a reusable skill I can enable for this task: ${receipt.task}`,
                  from: "assistant",
                }));
                toast.success("Opened the skill generator.");
              }}
              onPublishLater={(receipt) => {
                setSuppressedOutcomeTaskKeys(setOutcomeReceiptCooldown(receipt.task));
                toast.success("Friday will keep this private for now and wait for stronger proof-of-use before asking again.");
              }}
            />

            <AssistantQuickActionsCard
              actions={quickActions}
              issues={issues}
              workflowOverviews={workflowOverviews}
              catalogItems={catalogItems}
              pairingRequests={pairingRequests}
              onApproveFix={(actionId) => approveFixMutation.mutate(actionId)}
              onDeploy={(workflowId, draftId) =>
                deployDraftMutation.mutate({ workflowId, draftId, runNow: true, includeExport: false })}
              onInstallSkill={(skillId, sourceId) =>
                installSkillMutation.mutate({ skillId, sourceId })}
              onApprovePairing={(satelliteId) => approvePairingMutation.mutate(satelliteId)}
              onRejectPairing={(satelliteId) =>
                rejectPairingMutation.mutate({
                  satelliteId,
                  reason: "Rejected from assistant quick actions.",
                })}
              onAcknowledgeAlert={(alertId) =>
                acknowledgeAlertMutation.mutate({
                  alertId,
                  note: "Acknowledged from assistant quick actions.",
                })}
              actionPending={
                approveFixMutation.isPending ||
                deployDraftMutation.isPending ||
                installSkillMutation.isPending ||
                approvePairingMutation.isPending ||
                rejectPairingMutation.isPending ||
                acknowledgeAlertMutation.isPending
              }
            />

            <PlanCardsSection
              intentResult={intentResult}
              seedGoal={goal.trim() || intentResult?.objective}
              templates={templates}
              templateValues={templateValues}
              onTemplateValueChange={(templateId, key, value) => {
                setTemplateValues((current) => ({
                  ...current,
                  [templateId]: {
                    ...(current[templateId] ?? {}),
                    [key]: value,
                  },
                }));
              }}
              onExecuteTemplate={handleExecuteTemplate}
              loadingTemplateId={
                executeTemplateMutation.variables?.templateId
              }
              templatePending={executeTemplateMutation.isPending}
            />

            <ActionCardsSection
              workflowCards={workflowActionCards}
              workflowOverviews={workflowOverviews}
              installedSkills={installedSkills}
              catalogItems={catalogItems}
              marketplaceCards={marketplaceCards}
              marketplaceCreators={marketplaceCreators}
              marketplaceRequests={marketplaceRequests}
              marketplaceGoalSeed={goal.trim() || intentResult?.objective}
              marketplaceIntentResult={intentResult}
              sources={sources}
              fleetOverview={fleetOverviewQuery.data}
              degradedSatellites={degradedSatellites}
              pairingRequests={pairingRequests}
              session={sessionQuery.data}
              snapshot={stateQuery.data}
              observability={observabilityQuery.data}
              activeAlerts={activeAlerts}
              onDeploy={(workflowId, draftId, runNow, includeExport) =>
                deployDraftMutation.mutate({ workflowId, draftId, runNow, includeExport })}
              onInstallSkill={(skillId, sourceId) =>
                installSkillMutation.mutate({ skillId, sourceId })}
              onUpdateSkill={(skillId) => updateSkillMutation.mutate(skillId)}
              onVerifySkill={(skillId) => verifySkillMutation.mutate(skillId)}
              onSupportMarketplaceAsset={(assetId) => supportMarketplaceAssetMutation.mutate(assetId)}
              onToggleSource={(sourceId, enabled) => toggleSourceMutation.mutate({ sourceId, enabled })}
              onSystemIntent={(action, layout, reason) =>
                systemIntentMutation.mutate({ action, layout, reason })}
              onApprovePairing={(satelliteId) => approvePairingMutation.mutate(satelliteId)}
              onRejectPairing={(satelliteId) =>
                rejectPairingMutation.mutate({
                  satelliteId,
                  reason: "Rejected from assistant fleet action card.",
                })}
              onAcknowledgeAlert={(alertId) =>
                acknowledgeAlertMutation.mutate({
                  alertId,
                  note: "Acknowledged from assistant observability card.",
                })}
              deployPending={deployDraftMutation.isPending}
              installPending={installSkillMutation.isPending}
              updatePending={updateSkillMutation.isPending}
              verifyPending={verifySkillMutation.isPending}
              supportPending={supportMarketplaceAssetMutation.isPending}
              toggleSourcePending={toggleSourceMutation.isPending}
              systemIntentPending={systemIntentMutation.isPending}
              pairingPending={approvePairingMutation.isPending || rejectPairingMutation.isPending}
              alertPending={acknowledgeAlertMutation.isPending}
            />
          </div>

          <div className="space-y-6">
            <AssistantRunPulseCard
              run={displayedAssistantRun}
              progress={activeAssistantRun
                ? assistantRunEvents.progress
                : {
                    phase: displayedAssistantRun?.status,
                    elapsedMs: displayedAssistantRun?.durationMs ?? 0,
                    subagentCount: 0,
                    activeTool: undefined,
                    eta: undefined,
                  }}
              diagnostics={diagnosticsQuery.data}
              selectedTaskProfileId={selectedTaskProfileId}
              onTaskProfileChange={setSelectedTaskProfileId}
              onRerun={(run) =>
                rerunMutation.mutate({
                  task: run.task,
                  taskProfileId: selectedTaskProfileId,
                })}
              onApprovePlan={(runId) => approvePlanMutation.mutate(runId)}
              onRejectPlan={(runId) => rejectPlanMutation.mutate(runId)}
              planPending={approvePlanMutation.isPending || rejectPlanMutation.isPending || rerunMutation.isPending}
            />

            <RecoveryCommandCenterSection paths={recoveryPaths} />

            <IssueInboxSection
              issues={issues}
              incidents={incidents}
              autoFixActions={autoFixActions}
              onApproveFix={(actionId) => approveFixMutation.mutate(actionId)}
              onExecuteFix={(actionId) => executeFixMutation.mutate(actionId)}
              onDenyFix={(actionId) => denyFixMutation.mutate(actionId)}
              onRollbackFix={(actionId) => rollbackFixMutation.mutate(actionId)}
              approvePending={approveFixMutation.isPending}
              executePending={executeFixMutation.isPending}
              denyPending={denyFixMutation.isPending}
              rollbackPending={rollbackFixMutation.isPending}
            />

            <OutcomeFeedSection
              loopRuns={loopRuns}
              workflowOverviews={workflowOverviews}
              observability={observabilityQuery.data}
              metricsSummary={metricsQuery.data}
              loopPolicy={loopPolicyQuery.data}
              expertModeEnabled={expertModeQuery.data?.enabled ?? false}
              onToggleExpertMode={(enabled) => toggleExpertModeMutation.mutate(enabled)}
              onPauseLoop={(loopRunId) => pauseLoopMutation.mutate(loopRunId)}
              togglePending={toggleExpertModeMutation.isPending}
              pausePending={pauseLoopMutation.isPending}
            />
          </div>
        </div>
      </ShellCard>
    </div>
  );
}

function OutcomeReceiptCard(props: {
  receipt: FridayAssistantOutcomeReceipt | null;
  savePending: boolean;
  onSave: (receipt: FridayAssistantOutcomeReceipt) => void;
  onPackage: (receipt: FridayAssistantOutcomeReceipt) => void;
  onPublishLater: (receipt: FridayAssistantOutcomeReceipt) => void;
}) {
  if (!props.receipt) {
    return null;
  }

  const receipt = props.receipt;
  const actionTone = (action: FridayAssistantOutcomeReceipt["nextRecommendedAction"]) =>
    receipt.nextRecommendedAction === action ? "primary" : "secondary";

  return (
    <ShellCard
      eyebrow="Outcome receipt"
      title="Friday turns a successful run into the next durable advantage"
      aside={<StatusPill tone="success">next best action</StatusPill>}
    >
      <div
        className="space-y-4"
        data-testid="assistant-outcome-receipt"
        data-recommended-action={receipt.nextRecommendedAction}
      >
        <div className="rounded-[24px] border border-emerald-300/15 bg-emerald-300/[0.08] p-4">
          <p className="text-sm font-medium text-emerald-100">{receipt.summary}</p>
          <p className="mt-2 text-xs uppercase tracking-[0.18em] text-emerald-100/70">
            Estimated time saved next time: {receipt.estimatedTimeSavedMinutes} min
          </p>
        </div>
        <div>
          <p className="text-sm font-medium text-white">{receipt.task}</p>
          <p className="mt-2 text-sm leading-6 text-white/62">{receipt.nextReason}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {receipt.evidence.map((line) => (
            <div key={line} className="rounded-[20px] border border-white/[0.08] bg-white/[0.04] p-3 text-sm text-white/65">
              {line}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <ActionButton
            data-testid="assistant-outcome-save"
            disabled={props.savePending || Boolean(receipt.matchingAutomation)}
            tone={actionTone("save")}
            onClick={() => props.onSave(receipt)}
          >
            {receipt.matchingAutomation ? "Already saved" : "Save"}
          </ActionButton>
          <Link
            className={`inline-flex items-center justify-center rounded-2xl px-4 py-2 text-sm font-medium transition ${
              receipt.nextRecommendedAction === "schedule"
                ? "bg-[var(--accent-strong)] text-slate-950 hover:bg-[var(--accent-soft)]"
                : "bg-white/10 text-white hover:bg-white/[0.14]"
            }`}
            data-testid="assistant-outcome-schedule"
            to={buildAutomationsPrefillHref(receipt)}
          >
            Schedule
          </Link>
          <ActionButton
            data-testid="assistant-outcome-package"
            tone={actionTone("package")}
            onClick={() => props.onPackage(receipt)}
          >
            Package
          </ActionButton>
          <ActionButton
            data-testid="assistant-outcome-publish-later"
            tone={actionTone("publish_later")}
            onClick={() => props.onPublishLater(receipt)}
          >
            Publish later
          </ActionButton>
        </div>
      </div>
    </ShellCard>
  );
}

function AssistantRunPulseCard(props: {
  run: AgentRunRecord | null;
  progress: {
    phase?: string;
    elapsedMs: number;
    subagentCount: number;
    activeTool?: string;
    eta?: number;
  };
  diagnostics?: AssistantDiagnostics;
  selectedTaskProfileId: AgentTaskProfileId;
  onTaskProfileChange: (taskProfileId: AgentTaskProfileId) => void;
  onRerun: (run: AgentRunRecord) => void;
  onApprovePlan: (runId: string) => void;
  onRejectPlan: (runId: string) => void;
  planPending: boolean;
}) {
  const presetOptions = props.diagnostics?.taskProfilePresets ?? [];
  const mcpSummary = summarizeMcpServerStates(props.diagnostics?.mcpServerStates ?? []);

  if (!props.run) {
    return (
      <ShellCard eyebrow="Live task pulse" title="No operator run is active right now">
        <div className="space-y-4 text-sm text-white/58">
          <p>Assistant will surface active operator work here once a long-running task is in flight.</p>
          <label className="grid gap-2 text-sm">
            <span className="font-medium text-white">Default task profile</span>
            <select
              value={props.selectedTaskProfileId}
              onChange={(event) => props.onTaskProfileChange(event.target.value as AgentTaskProfileId)}
              className="agent-input"
            >
              {presetOptions.length > 0 ? presetOptions.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label} · {preset.reasoningEffort}
                </option>
              )) : (
                <option value={props.selectedTaskProfileId}>{props.selectedTaskProfileId}</option>
              )}
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <MetricStat label="MCP loaded" value={String(mcpSummary.loaded)} tone={mcpSummary.loaded > 0 ? "success" : "neutral"} />
            <MetricStat label="MCP deferred" value={String(mcpSummary.deferred)} tone={mcpSummary.deferred > 0 ? "warning" : "neutral"} />
          </div>
          <Link
            className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]"
            to={buildObservabilityHref({ focus: "assistant" })}
          >
            Open assistant diagnostics
          </Link>
        </div>
      </ShellCard>
    );
  }

  const run = props.run;

  return (
    <ShellCard
      eyebrow="Live task pulse"
      title="Assistant keeps the operator run visible while work is in progress"
      aside={<StatusPill tone={mapTone(props.progress.phase ?? run.status)}>{props.progress.phase ?? run.status}</StatusPill>}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricStat label="Elapsed" value={formatRunDuration(props.progress.elapsedMs)} tone={props.progress.elapsedMs >= 30_000 ? "warning" : "neutral"} />
        <MetricStat label="ETA" value={typeof props.progress.eta === "number" ? `up to ${formatRunDuration(props.progress.eta)}` : "unknown"} />
        <MetricStat label="Subagents" value={String(props.progress.subagentCount)} tone={props.progress.subagentCount > 0 ? "success" : "neutral"} />
        <MetricStat label="Active tool" value={props.progress.activeTool ?? "none"} />
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-2 text-sm">
          <span className="font-medium text-white">Task profile</span>
          <select
            value={props.selectedTaskProfileId}
            onChange={(event) => props.onTaskProfileChange(event.target.value as AgentTaskProfileId)}
            className="agent-input"
          >
            {presetOptions.length > 0 ? presetOptions.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label} · {preset.reasoningEffort}
              </option>
            )) : (
              <option value={props.selectedTaskProfileId}>{props.selectedTaskProfileId}</option>
            )}
          </select>
        </label>
        <div className="grid gap-2 text-xs text-white/55">
          <p className="font-medium uppercase tracking-[0.18em] text-white/40">Context cost</p>
          <p>Workspace: {summarizeContextCostComponent(run, "workspace_context")}</p>
          <p>Skills: {summarizeContextCostComponent(run, "starter_skills")}</p>
          <p>MCP: {summarizeContextCostComponent(run, "mcp")}</p>
          <p>Subagents: {summarizeContextCostComponent(run, "subagents")}</p>
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <MetricStat label="MCP configured" value={String(mcpSummary.configured)} tone={mcpSummary.configured > 0 ? "success" : "neutral"} />
        <MetricStat label="MCP loaded" value={String(mcpSummary.loaded)} tone={mcpSummary.loaded > 0 ? "success" : "neutral"} />
        <MetricStat label="MCP discoverable" value={String(mcpSummary.discoverable)} tone={mcpSummary.discoverable > 0 ? "warning" : "neutral"} />
        <MetricStat label="MCP deferred" value={String(mcpSummary.deferred)} tone={mcpSummary.deferred > 0 ? "warning" : "neutral"} />
      </div>
      <p className="mt-4 text-sm leading-6 text-white/62">{run.task}</p>
      {run.status === "awaiting_clarification" && run.planReview?.gate?.clarificationQuestions?.length ? (
        <p className="mt-4 rounded-2xl border border-amber-300/20 bg-amber-300/[0.08] px-4 py-3 text-sm leading-6 text-amber-100">
          Waiting for clarification: {run.planReview.gate.clarificationQuestions[0]}
        </p>
      ) : null}
      {run.status === "awaiting_plan_approval" ? (
        <div className="mt-4 space-y-3">
          <p className="rounded-2xl border border-emerald-300/20 bg-emerald-300/[0.08] px-4 py-3 text-sm leading-6 text-emerald-100">
            {run.planReview?.gate?.approvalPrompt ?? "This plan is waiting for approval before Friday executes it."}
          </p>
          {run.planReview?.gate?.planSummary ? (
            <p className="text-sm leading-6 text-white/62">{run.planReview.gate.planSummary}</p>
          ) : null}
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]"
          to={`/command-center?runId=${encodeURIComponent(run.id)}`}
        >
          Open live run
        </Link>
        <ActionButton tone="secondary" disabled={props.planPending} onClick={() => props.onRerun(run)}>
          Re-run with profile
        </ActionButton>
        <Link
          className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]"
          to={buildObservabilityHref({ focus: "assistant" })}
        >
          Open diagnostics
        </Link>
        {run.status === "awaiting_plan_approval" ? (
          <>
            <ActionButton disabled={props.planPending} onClick={() => props.onApprovePlan(run.id)}>
              Approve Plan
            </ActionButton>
            <ActionButton tone="danger" disabled={props.planPending} onClick={() => props.onRejectPlan(run.id)}>
              Reject Plan
            </ActionButton>
          </>
        ) : null}
      </div>
    </ShellCard>
  );
}

function GoalIntakeCard(props: {
  goal: string;
  onGoalChange: (value: string) => void;
  onIntentClick: (value: string) => void;
  onQuickIntent: (value: string) => void;
  loading: boolean;
  intentResult: FridayBeginnerIntentResolution | null;
  expertModeEnabled: boolean;
}) {
  const {
    goal,
    onGoalChange,
    onIntentClick,
    onQuickIntent,
    loading,
    intentResult,
    expertModeEnabled,
  } = props;
  const location = useLocation();
  const starterState = location.state as
    | {
      starterTaskId?: string;
      starterGoal?: string;
      starterSource?: string;
    }
    | null;
  const starterTask = getAssistantStarterTask(starterState?.starterTaskId);

  return (
    <ShellCard
      eyebrow="Goal intake"
      title="Tell Friday what you are trying to accomplish"
      aside={<StatusPill tone={expertModeEnabled ? "warning" : "neutral"}>{expertModeEnabled ? "expert mode" : "guided mode"}</StatusPill>}
    >
      <div className="space-y-4">
        <FieldLabel
          label="Describe the outcome, not the tooling"
          hint="Friday will infer defaults, ask only the decisive question when needed, and turn the goal into clickable next steps."
        />
        <textarea
          data-testid="assistant-goal-input"
          value={goal}
          onChange={(event) => onGoalChange(event.target.value)}
          placeholder="Examples: help me understand why deployments keep failing, generate and deploy a workflow for weekly error digests, or fix the degraded satellite."
          className="agent-textarea min-h-[148px]"
        />
        <div className="flex flex-wrap gap-3">
          <ActionButton
            data-testid="assistant-goal-submit"
            onClick={() => onIntentClick(goal)}
            disabled={!goal.trim() || loading}
          >
            {loading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Wand2 className="mr-2 size-4" />}
            Turn this into a plan
          </ActionButton>
          <Link className="inline-flex items-center rounded-2xl bg-white/8 px-4 py-2 text-sm text-white hover:bg-white/12" to="/command-center">
            Open operator console
            <ChevronRight className="ml-2 size-4" />
          </Link>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/38">
              You may be trying to do one of these
            </p>
            <span className="text-xs text-white/45">Click a card to start with a guided plan</span>
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            {FRIDAY_ASSISTANT_STARTER_TASKS.map((task) => {
              const active = starterTask?.id === task.id && goal.trim() === task.goal;
              return (
                <button
                  key={task.id}
                  type="button"
                  className={`text-left transition ${
                    active ? "agent-selection-card ring-1 ring-emerald-300/30" : "agent-subcard hover:border-white/14"
                  }`}
                  onClick={() => onQuickIntent(task.goal)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">{task.title}</p>
                      <p className="mt-2 text-sm leading-6 text-white/58">{task.description}</p>
                    </div>
                    <StatusPill tone={active ? "success" : "neutral"}>
                      {active ? "active" : "guided"}
                    </StatusPill>
                  </div>
                  <p className="mt-3 text-xs uppercase tracking-[0.18em] text-white/35">Outcome</p>
                  <p className="mt-2 text-sm text-white/72">{task.outcome}</p>
                </button>
              );
            })}
          </div>
        </div>
        {starterTask ? (
          <div className="agent-subcard-strong">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-white/35">Setup handoff</p>
                <p className="mt-2 text-sm font-semibold text-white">{starterTask.title}</p>
              </div>
              <StatusPill tone="success">first task</StatusPill>
            </div>
            <p className="mt-3 text-sm leading-6 text-white/62">
              Friday started with this guided task so you can click through the first outcome instead of learning the whole system up front.
            </p>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {QUICK_INTENTS.map((quickIntent) => (
            <button
              key={quickIntent}
              type="button"
              className="rounded-full border border-white/10 bg-white/6 px-3 py-1.5 text-xs text-white/70 transition hover:border-white/20 hover:bg-white/10 hover:text-white"
              onClick={() => onQuickIntent(quickIntent)}
            >
              {quickIntent}
            </button>
          ))}
        </div>
        {intentResult ? (
          <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Bot className="size-4 text-[var(--accent-soft)]" />
                <p className="text-sm font-semibold text-white">{intentResult.summary}</p>
              </div>
              <StatusPill tone={classifyPlanTone(intentResult.state)}>
                {intentResult.state ?? "analyzed"}
              </StatusPill>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <PlanList title="Assumptions" items={intentResult.assumptions} emptyLabel="Friday is not assuming anything risky yet." />
              <PlanList title="Unknowns" items={intentResult.unknowns} emptyLabel="Nothing critical is missing." />
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <SummaryPanel label="Success test" value={intentResult.successTest ?? "Friday will explain success criteria after it chooses the action path."} />
              <SummaryPanel label="Fallback path" value={intentResult.fallbackPath ?? "Friday will open a visible issue card if execution is blocked or unsafe."} />
            </div>
          </div>
        ) : null}
      </div>
    </ShellCard>
  );
}

function AssistantQuickActionsCard(props: {
  actions: FridayAssistantQuickAction[];
  issues: FridayIssueCard[];
  workflowOverviews: FridayWorkflowOverview[];
  catalogItems: SkillCatalogItem[];
  pairingRequests: FridayPendingSatellitePairingRequest[];
  onApproveFix: (actionId: string) => void;
  onDeploy: (workflowId: string, draftId: string) => void;
  onInstallSkill: (skillId: string, sourceId?: string) => void;
  onApprovePairing: (satelliteId: string) => void;
  onRejectPairing: (satelliteId: string) => void;
  onAcknowledgeAlert: (alertId: string) => void;
  actionPending: boolean;
}) {
  if (props.actions.length === 0) {
    return null;
  }

  return (
    <ShellCard eyebrow="Next clicks" title="Friday turns the best next steps into direct actions">
      <div className="grid gap-3 xl:grid-cols-2">
        {props.actions.map((action) => {
          if (action.kind === "issue") {
            const issue = props.issues.find((item) => `issue:${item.id}` === action.id);
            const canApprove = issue?.kind === "approval_required" && Boolean(issue.actionId);
            return (
              <QuickActionTile
                key={action.id}
                action={action}
                ctaLabel={canApprove ? "Approve fix" : "Open issue inbox"}
                disabled={props.actionPending}
                to={canApprove ? undefined : "/assistant"}
                onClick={canApprove && issue?.actionId ? () => props.onApproveFix(issue.actionId!) : undefined}
              />
            );
          }

          if (action.kind === "workflow") {
            const workflowId = action.id.replace(/^workflow:/, "");
            const overview = props.workflowOverviews.find((item) => item.workflow.id === workflowId);
            const draftId = overview?.latestDraft?.draftId;
            return (
              <QuickActionTile
                key={action.id}
                action={action}
                ctaLabel={draftId ? "Deploy now" : "Open workflows"}
                disabled={props.actionPending}
                to={draftId ? undefined : buildWorkflowHref(workflowId, "recovery")}
                onClick={draftId ? () => props.onDeploy(workflowId, draftId) : undefined}
              />
            );
          }

          if (action.kind === "skill") {
            const skillId = action.id.replace(/^skill:/, "");
            const skill = props.catalogItems.find((item) => item.skillId === skillId);
            return (
              <QuickActionTile
                key={action.id}
                action={action}
                ctaLabel="Install"
                disabled={props.actionPending}
                onClick={() => props.onInstallSkill(skillId, skill?.sourceId)}
              />
            );
          }

          if (action.kind === "fleet") {
            const pendingPairing = props.pairingRequests.find((item) => `pairing:${item.satelliteId}` === action.id);
            return pendingPairing ? (
              <QuickActionTile
                key={action.id}
                action={action}
                ctaLabel="Approve node"
                secondaryLabel="Reject"
                disabled={props.actionPending}
                onClick={() => props.onApprovePairing(pendingPairing.satelliteId)}
                onSecondaryClick={() => props.onRejectPairing(pendingPairing.satelliteId)}
              />
            ) : (
              <QuickActionTile
                key={action.id}
                action={action}
                ctaLabel="Open fleet recovery"
                disabled={props.actionPending}
                to="/fleet"
              />
            );
          }

          const alertId = action.id.replace(/^alert:/, "");
          return (
            <QuickActionTile
              key={action.id}
              action={action}
              ctaLabel="Acknowledge"
              disabled={props.actionPending}
              onClick={() => props.onAcknowledgeAlert(alertId)}
            />
          );
        })}
      </div>
    </ShellCard>
  );
}

function PlanCardsSection(props: {
  intentResult: FridayBeginnerIntentResolution | null;
  seedGoal?: string;
  templates: FridayActionTemplateSummary[];
  templateValues: Record<string, Record<string, string | boolean>>;
  onTemplateValueChange: (templateId: string, key: string, value: string | boolean) => void;
  onExecuteTemplate: (template: FridayActionTemplateSummary) => void;
  loadingTemplateId?: string;
  templatePending: boolean;
}) {
  return (
    <ShellCard
      eyebrow="Plan cards"
      title="Friday turns goals into guided, clickable actions"
      aside={<StatusPill>{props.templates.length} templates</StatusPill>}
    >
      <div className="space-y-4">
        {props.intentResult ? (
          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-white">
              <LayoutTemplate className="size-4 text-[var(--accent-soft)]" />
              Recommended action path
            </div>
            <p className="text-sm text-white/70">{props.intentResult.summary}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {props.intentResult.suggestedTemplateIds.length > 0 ? props.intentResult.suggestedTemplateIds.map((templateId) => (
                <span key={templateId} className="rounded-full border border-white/10 bg-white/8 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-white/60">
                  {templateId}
                </span>
              )) : (
                <span className="text-xs text-white/45">Friday will use the templates below once you click the path you want.</span>
              )}
            </div>
          </div>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-2">
          {ASSISTANT_TASK_STORIES.map((story) => {
            const template = props.templates.find((item) => item.id === story.templateId);
            if (!template) {
              return null;
            }
            const currentValues = props.templateValues[template.id] ?? {};
            const goalParameter = template.parameters.find((parameter) => parameter.key === "goal" && parameter.type === "text");
            const canSeedGoal = goalParameter && !String(currentValues.goal ?? "").trim() && props.seedGoal;
            const isRunning = props.templatePending && props.loadingTemplateId === template.id;
            return (
              <article
                key={story.templateId}
                className="agent-subcard-strong"
                data-testid="assistant-task-story"
                data-template-id={story.templateId}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.22em] text-white/35">{template.category}</p>
                    <h3 className="mt-1 text-base font-semibold text-white">{story.title}</h3>
                  </div>
                  <StatusPill tone={template.parameters.length === 0 ? "success" : "neutral"}>
                    {template.parameters.length === 0 ? "one click" : "guided"}
                  </StatusPill>
                </div>
                <p className="mt-3 text-sm leading-6 text-white/62">{story.description}</p>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <SummaryPanel label="Outcome" value={story.outcome} />
                  <SummaryPanel
                    label="How Friday starts"
                    value={canSeedGoal
                      ? "Friday will reuse your current goal as the starting brief and keep approvals and rollback rules intact."
                      : template.parameters.length === 0
                        ? "Friday can start immediately and open the next safe action path."
                        : "Friday will ask only for the minimum missing inputs before execution."}
                  />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <ActionButton
                    onClick={() => {
                      if (canSeedGoal) {
                        props.onTemplateValueChange(template.id, "goal", props.seedGoal!);
                      }
                      props.onExecuteTemplate(template);
                    }}
                    disabled={isRunning}
                  >
                    {isRunning ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ArrowRight className="mr-2 size-4" />}
                    {template.parameters.length === 0 || canSeedGoal ? "Start now" : "Use guided flow"}
                  </ActionButton>
                  <p className="text-xs text-white/45">
                    {goalParameter ? "Friday will carry your goal forward when it is safe to do so." : "No extra setup required for the first step."}
                  </p>
                </div>
              </article>
            );
          })}
        </div>

        <details className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
          <summary className="cursor-pointer list-none text-sm font-semibold text-white">
            Advanced templates and parameters
          </summary>
          <p className="mt-3 text-sm text-white/55">
            Use the raw template controls if you want to override the guided task stories above.
          </p>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {props.templates.map((template) => {
            const currentValues = props.templateValues[template.id] ?? {};
            const isRunning = props.templatePending && props.loadingTemplateId === template.id;
            return (
              <article key={template.id} className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.22em] text-white/45">{template.category}</p>
                    <h3 className="mt-1 text-base font-semibold text-white">{template.label}</h3>
                  </div>
                  <StatusPill>{template.parameters.length === 0 ? "one click" : "guided"}</StatusPill>
                </div>
                <p className="text-sm text-white/65">{template.description}</p>
                {template.parameters.length > 0 ? (
                  <div className="mt-4 grid gap-3">
                    {template.parameters.map((parameter) => (
                      <label key={parameter.key} className="grid gap-1 text-sm">
                        <span className="font-medium text-white">{parameter.label}</span>
                        {parameter.type === "boolean" ? (
                          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2">
                            <input
                              type="checkbox"
                              checked={Boolean(currentValues[parameter.key])}
                              onChange={(event) =>
                                props.onTemplateValueChange(template.id, parameter.key, event.target.checked)}
                              className="size-4 rounded border-white/20 bg-transparent"
                            />
                            <span className="text-xs text-white/60">Enable this option</span>
                          </div>
                        ) : (
                          <input
                            value={String(currentValues[parameter.key] ?? "")}
                            onChange={(event) =>
                              props.onTemplateValueChange(template.id, parameter.key, event.target.value)}
                            className="agent-input"
                            placeholder={parameter.placeholder}
                          />
                        )}
                      </label>
                    ))}
                  </div>
                ) : null}
                <div className="mt-4 flex items-center gap-3">
                  <ActionButton onClick={() => props.onExecuteTemplate(template)} disabled={isRunning}>
                    {isRunning ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ArrowRight className="mr-2 size-4" />}
                    Execute
                  </ActionButton>
                  <details className="rounded-2xl border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-white/55">
                    <summary className="cursor-pointer list-none font-medium text-white/70">Advanced</summary>
                    <p className="mt-2 leading-5">
                      Friday will keep approvals, rollback, and verification requirements intact even when you use a one-click template.
                    </p>
                  </details>
                </div>
              </article>
            );
          })}
          </div>
        </details>
      </div>
    </ShellCard>
  );
}

function ActionCardsSection(props: {
  workflowCards: Array<{ id: string; title: string; summary: string; tone: "neutral" | "success" | "warning" | "danger" }>;
  workflowOverviews: FridayWorkflowOverview[];
  installedSkills: SkillLifecycleSummary[];
  catalogItems: SkillCatalogItem[];
  marketplaceCards: ReturnType<typeof buildMarketplaceAssistantCards>;
  marketplaceCreators: FridayCreatorProfile[];
  marketplaceRequests: FridayMarketplaceRequestPost[];
  marketplaceGoalSeed?: string;
  marketplaceIntentResult?: FridayBeginnerIntentResolution | null;
  sources: SkillSourceRecord[];
  fleetOverview?: FridayFleetOverviewResponse;
  degradedSatellites: FridayFleetSatelliteCard[];
  pairingRequests: FridayPendingSatellitePairingRequest[];
  session?: FridaySystemSession;
  snapshot?: FridaySystemSnapshot;
  observability?: FridayObservabilityOverview;
  activeAlerts: FridayObservabilityAlertSummary[];
  onDeploy: (workflowId: string, draftId: string, runNow?: boolean, includeExport?: boolean) => void;
  onInstallSkill: (skillId: string, sourceId?: string) => void;
  onUpdateSkill: (skillId: string) => void;
  onVerifySkill: (skillId: string) => void;
  onSupportMarketplaceAsset: (assetId: string) => void;
  onToggleSource: (sourceId: string, enabled: boolean) => void;
  onSystemIntent: (action: FridaySystemIntentAction, layout?: "single_focus" | "dual_pane" | "triad", reason?: string) => void;
  onApprovePairing: (satelliteId: string) => void;
  onRejectPairing: (satelliteId: string) => void;
  onAcknowledgeAlert: (alertId: string) => void;
  deployPending: boolean;
  installPending: boolean;
  updatePending: boolean;
  verifyPending: boolean;
  supportPending: boolean;
  toggleSourcePending: boolean;
  systemIntentPending: boolean;
  pairingPending: boolean;
  alertPending: boolean;
}) {
  return (
    <ShellCard eyebrow="Action cards" title="Click-first controls for workflows, skills, fleet, and system actions">
      <div className="grid gap-4 xl:grid-cols-2">
        <WorkflowActionCard
          workflowCards={props.workflowCards}
          workflowOverviews={props.workflowOverviews}
          onDeploy={props.onDeploy}
          pending={props.deployPending}
        />
        <SkillsActionCard
          installedSkills={props.installedSkills}
          catalogItems={props.catalogItems}
          sources={props.sources}
          onInstallSkill={props.onInstallSkill}
          onUpdateSkill={props.onUpdateSkill}
          onVerifySkill={props.onVerifySkill}
          onToggleSource={props.onToggleSource}
          installPending={props.installPending}
          updatePending={props.updatePending}
          verifyPending={props.verifyPending}
          toggleSourcePending={props.toggleSourcePending}
        />
        <MarketplaceActionCard
          marketplaceCards={props.marketplaceCards}
          creators={props.marketplaceCreators}
          requests={props.marketplaceRequests}
          goalSeed={props.marketplaceGoalSeed}
          intentResult={props.marketplaceIntentResult}
          onInstallSkill={props.onInstallSkill}
          onSupportAsset={props.onSupportMarketplaceAsset}
          installPending={props.installPending}
          supportPending={props.supportPending}
        />
        <FleetActionCard
          fleetOverview={props.fleetOverview}
          degradedSatellites={props.degradedSatellites}
          pairingRequests={props.pairingRequests}
          onApprovePairing={props.onApprovePairing}
          onRejectPairing={props.onRejectPairing}
          pending={props.pairingPending}
        />
        <SystemActionCard
          session={props.session}
          snapshot={props.snapshot}
          observability={props.observability}
          activeAlerts={props.activeAlerts}
          onSystemIntent={props.onSystemIntent}
          onAcknowledgeAlert={props.onAcknowledgeAlert}
          pending={props.systemIntentPending}
          alertPending={props.alertPending}
        />
      </div>
    </ShellCard>
  );
}

export function MarketplaceActionCard(props: {
  marketplaceCards: ReturnType<typeof buildMarketplaceAssistantCards>;
  creators: FridayCreatorProfile[];
  requests: FridayMarketplaceRequestPost[];
  goalSeed?: string;
  intentResult?: FridayBeginnerIntentResolution | null;
  onInstallSkill: (skillId: string, sourceId?: string) => void;
  onSupportAsset: (assetId: string) => void;
  installPending: boolean;
  supportPending: boolean;
}) {
  const requestSummary = summarizeMarketplaceRequestState(props.requests);
  const creatorSummary = summarizeCreatorSupport(props.creators);
  return (
    <section className="agent-subcard-strong p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-white/45">Marketplace</p>
          <h3 className="mt-1 text-lg font-semibold text-white">Install safely, support creators, or post a request</h3>
        </div>
        <Link
          className="text-sm text-[var(--accent-soft)] hover:text-white"
          data-testid="assistant-marketplace-open-all"
          to={buildMarketplaceHref()}
        >
          Open all
        </Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricStat label="Public assets" value={String(props.marketplaceCards.length)} />
        <MetricStat label="Creators" value={String(creatorSummary.creatorCount)} />
        <MetricStat
          label="Open requests"
          value={String(requestSummary.openCount)}
          tone={requestSummary.openCount > 0 ? "warning" : "neutral"}
        />
      </div>
      <div className="mt-4 space-y-3">
        {props.marketplaceCards.map((asset) => (
          <div key={asset.assetId} className="agent-subcard p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h4 className="font-medium text-white">{asset.title}</h4>
                <p className="text-xs text-white/45">{asset.assetType} · {asset.publisherName}</p>
              </div>
              <StatusPill tone={asset.installable ? "success" : mapTone(asset.maturity)}>
                {asset.installable ? "install ready" : asset.maturity.replaceAll("_", " ")}
              </StatusPill>
            </div>
            <p className="text-sm text-white/65">{compactText(asset.summary)}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                className="inline-flex items-center justify-center rounded-2xl bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/[0.14]"
                data-testid={`assistant-marketplace-open-${asset.assetId}`}
                to={buildMarketplaceHref({ assetId: asset.assetId })}
              >
                Open in marketplace
              </Link>
              {asset.installable ? (
                <ActionButton
                  data-testid={`assistant-marketplace-install-${asset.assetId}`}
                  disabled={props.installPending}
                  onClick={() => props.onInstallSkill(asset.assetId.replace(/^skill:/, ""))}
                >
                  Install
                </ActionButton>
              ) : null}
              <ActionButton
                data-testid={`assistant-marketplace-support-${asset.assetId}`}
                tone="secondary"
                disabled={props.supportPending}
                onClick={() => props.onSupportAsset(asset.assetId)}
              >
                Support creator
              </ActionButton>
            </div>
            <AssistantAdvancedPanel
              summary="Friday keeps the public marketplace permission-aware and declarative-first. If a public asset does not fit, it should guide you toward a request instead of leaving you stuck."
              operatorContext={[
                `Proof of use: ${asset.proofOfUseScore ?? "unknown"}`,
                `Trust score: ${asset.trustScore ?? "unknown"}`,
                `Reliability: ${asset.outcomeReliabilityScore ?? "unknown"}`,
                `Permission efficiency: ${asset.permissionEfficiencyScore ?? "unknown"}`,
                `Maturity: ${asset.maturity.replaceAll("_", " ")}`,
                `Installable from assistant: ${asset.installable ? "yes" : "no"}`,
              ]}
            />
          </div>
        ))}
        <div className="agent-subcard p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <h4 className="font-medium text-white">No fit? Post a custom request</h4>
              <p className="text-xs text-white/45">
                {creatorSummary.creatorCount} creators · {creatorSummary.verifiedCount} verified
              </p>
            </div>
            <StatusPill tone="warning">{requestSummary.openCount} open</StatusPill>
          </div>
          <p className="text-sm text-white/65">
            Ask the ecosystem for a personal skill, workflow, or agent when the catalog does not solve your goal cleanly.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              className="inline-flex items-center justify-center rounded-2xl bg-[var(--accent-strong)] px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-[var(--accent-soft)]"
              data-testid="assistant-marketplace-request-skill"
              to={buildAssistantMarketplaceRequestHref({
                requestKind: "skill",
                goalSeed: props.goalSeed,
                intentResult: props.intentResult,
              })}
            >
              Post skill request
            </Link>
            <Link
              className="inline-flex items-center justify-center rounded-2xl bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/[0.14]"
              data-testid="assistant-marketplace-request-workflow"
              to={buildAssistantMarketplaceRequestHref({
                requestKind: "workflow",
                goalSeed: props.goalSeed,
                intentResult: props.intentResult,
              })}
            >
              Post workflow request
            </Link>
            <Link
              className="inline-flex items-center justify-center rounded-2xl bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/[0.14]"
              data-testid="assistant-marketplace-request-agent"
              to={buildAssistantMarketplaceRequestHref({
                requestKind: "agent",
                goalSeed: props.goalSeed,
                intentResult: props.intentResult,
              })}
            >
              Post agent request
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function AssistantAdvancedPanel(props: {
  summary: string;
  operatorContext: string[];
  children?: ReactNode;
}) {
  return (
    <details className="mt-3 rounded-2xl border border-white/8 bg-white/[0.02] px-3 py-2 text-xs text-white/55">
      <summary className="cursor-pointer list-none font-medium text-white/70">Advanced</summary>
      <p className="mt-2 leading-5">{props.summary}</p>
      {props.operatorContext.length > 0 ? (
        <div className="mt-3 grid gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/40">Operator context</p>
          {props.operatorContext.map((line) => (
            <p key={line} className="leading-5">
              {line}
            </p>
          ))}
        </div>
      ) : null}
      {props.children ? <div className="mt-3">{props.children}</div> : null}
    </details>
  );
}

function WorkflowActionCard(props: {
  workflowCards: Array<{ id: string; title: string; summary: string; tone: "neutral" | "success" | "warning" | "danger" }>;
  workflowOverviews: FridayWorkflowOverview[];
  onDeploy: (workflowId: string, draftId: string, runNow?: boolean, includeExport?: boolean) => void;
  pending: boolean;
}) {
  return (
    <section className="agent-subcard-strong p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-white/45">Workflows</p>
          <h3 className="mt-1 text-lg font-semibold text-white">Generate, deploy, rerun, export</h3>
        </div>
        <div className="flex items-center gap-3">
          <Link className="text-sm text-[var(--accent-soft)] hover:text-white" to="/workflows/builder">
            Open builder
          </Link>
          <Link className="text-sm text-[var(--accent-soft)] hover:text-white" to="/workflows">
            Open all
          </Link>
        </div>
      </div>
      <div className="space-y-3">
        {props.workflowOverviews.slice(0, 3).map((overview) => (
          <div key={overview.workflow.id} className="agent-subcard p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h4 className="font-medium text-white">{overview.workflow.name}</h4>
                <p className="text-xs text-white/45">{overview.workflow.slug}</p>
              </div>
              <StatusPill tone={workflowTone(overview)}>
                {overview.latestDraft ? "draft ready" : overview.publishedVersion ? "published" : "not deployed"}
              </StatusPill>
            </div>
            <p className="text-sm text-white/65">{compactText(props.workflowCards.find((card) => card.id === overview.workflow.id)?.summary)}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {overview.latestDraft ? (
                <>
                  <ActionButton
                    disabled={props.pending}
                    onClick={() => props.onDeploy(overview.workflow.id, overview.latestDraft!.draftId, true, false)}
                  >
                    Deploy and run
                  </ActionButton>
                  <ActionButton
                    tone="secondary"
                    disabled={props.pending}
                    onClick={() => props.onDeploy(overview.workflow.id, overview.latestDraft!.draftId, false, true)}
                  >
                    Export bundle
                  </ActionButton>
                </>
              ) : null}
              <Link
                className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]"
                to={buildWorkflowBuilderHref({
                  workflowId: overview.workflow.id,
                  draftId: overview.latestDraft?.draftId,
                  focus: overview.latestDraft ? "draft" : "templates",
                })}
              >
                Open builder
              </Link>
              <Link
                className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]"
                to={buildWorkflowHref(
                  overview.workflow.id,
                  overview.latestRun?.status === "failed" ? "recovery" : overview.latestDraft ? "deploy" : "details",
                )}
              >
                Details
              </Link>
            </div>
            <AssistantAdvancedPanel
              summary="Friday keeps deployment validation, publish steps, export evidence, and rollback-aware recovery intact even when you trigger these actions from the assistant."
              operatorContext={[
                `Latest draft: ${overview.latestDraft?.title ?? "none"}`,
                `Published version: ${overview.publishedVersion ? `v${overview.publishedVersion.versionNumber}` : "none"}`,
                `Latest run: ${overview.latestRun?.status ?? "not run yet"}`,
                `Builder handoff: ${overview.latestDraft ? "draft context ready" : "template-first start"}`,
              ]}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function SkillsActionCard(props: {
  installedSkills: SkillLifecycleSummary[];
  catalogItems: SkillCatalogItem[];
  sources: SkillSourceRecord[];
  onInstallSkill: (skillId: string, sourceId?: string) => void;
  onUpdateSkill: (skillId: string) => void;
  onVerifySkill: (skillId: string) => void;
  onToggleSource: (sourceId: string, enabled: boolean) => void;
  installPending: boolean;
  updatePending: boolean;
  verifyPending: boolean;
  toggleSourcePending: boolean;
}) {
  const topInstalled = props.installedSkills.slice(0, 2);
  const installable = props.catalogItems.filter((item) => !item.installed).slice(0, 2);
  return (
    <section className="agent-subcard-strong p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-white/45">Skills</p>
          <h3 className="mt-1 text-lg font-semibold text-white">Generate, verify, install, update</h3>
        </div>
        <Link className="text-sm text-[var(--accent-soft)] hover:text-white" to="/skills">
          Open all
        </Link>
      </div>
      <div className="space-y-3">
        {topInstalled.map((skill) => (
          <div key={skill.skillId} className="agent-subcard p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h4 className="font-medium text-white">{skill.name}</h4>
                <p className="text-xs text-white/45">{skill.skillId}</p>
              </div>
              <StatusPill tone={skill.updateAvailable ? "warning" : mapTone(skill.status)}>
                {skill.updateAvailable ? "update available" : skill.status}
              </StatusPill>
            </div>
            <p className="text-sm text-white/65">{compactText(skill.description)}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <StatusPill>{describeSkillIntegrationMode(skill)}</StatusPill>
              <StatusPill tone={skill.maturity === "stable" ? "success" : skill.maturity === "verified" ? "warning" : "neutral"}>
                {skill.maturity}
              </StatusPill>
              {isCliFirstSkill(skill) ? <StatusPill tone="success">CLI-first</StatusPill> : null}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <ActionButton disabled={props.verifyPending} onClick={() => props.onVerifySkill(skill.skillId)}>
                Verify
              </ActionButton>
              {skill.updateAvailable ? (
                <ActionButton tone="secondary" disabled={props.updatePending} onClick={() => props.onUpdateSkill(skill.skillId)}>
                  Update
                </ActionButton>
              ) : null}
              <Link
                className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]"
                to={buildSkillHref(skill.skillId, "details")}
              >
                Details
              </Link>
            </div>
            <AssistantAdvancedPanel
              summary="Friday will keep verification evidence, source policy, and install/update readiness attached to this skill before applying changes."
              operatorContext={[
                `Installed version: ${skill.installedVersion ?? "not installed"}`,
                `Latest version: ${skill.latestVersion ?? "unknown"}`,
                `Source: ${skill.sourceId ?? skill.source}`,
                `Integration mode: ${describeSkillIntegrationMode(skill)}`,
              ]}
            />
          </div>
        ))}
        {installable.map((skill) => (
          <div key={`${skill.sourceId}:${skill.skillId}`} className="agent-subcard p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h4 className="font-medium text-white">{skill.skillName}</h4>
                <p className="text-xs text-white/45">{skill.sourceId}</p>
              </div>
              <StatusPill tone={skill.signatureValid ? "success" : "warning"}>
                trust {skill.trustScore}
              </StatusPill>
            </div>
            <p className="text-sm text-white/65">Install directly from the assistant, then jump to skills only if you need deeper detail.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {skill.originType ? <StatusPill>{skill.originType}</StatusPill> : null}
              {skill.maturity ? (
                <StatusPill tone={skill.maturity === "stable" ? "success" : skill.maturity === "verified" ? "warning" : "neutral"}>
                  {skill.maturity}
                </StatusPill>
              ) : null}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <ActionButton disabled={props.installPending} onClick={() => props.onInstallSkill(skill.skillId, skill.sourceId)}>
                Install
              </ActionButton>
            </div>
            <AssistantAdvancedPanel
              summary="This is a marketplace install path. Friday will preserve source trust, package verification, and registry consistency before enabling it."
              operatorContext={[
                `Publisher: ${skill.publisher ?? "unknown"}`,
                `Source: ${skill.sourceId}`,
                `Signature valid: ${skill.signatureValid ? "yes" : "no"}`,
              ]}
            />
          </div>
        ))}
        {props.sources.slice(0, 2).map((source) => (
          <div key={source.id} className="agent-subcard p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h4 className="font-medium text-white">{source.name}</h4>
                <p className="text-xs text-white/45">{source.baseUrl}</p>
              </div>
              <StatusPill tone={source.enabled ? "success" : "warning"}>
                {source.enabled ? "enabled" : "disabled"}
              </StatusPill>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <ActionButton
                tone="secondary"
                disabled={props.toggleSourcePending}
                onClick={() => props.onToggleSource(source.id, source.enabled)}
              >
                {source.enabled ? "Disable" : "Enable"}
              </ActionButton>
            </div>
            <AssistantAdvancedPanel
              summary="Source toggles affect what Friday is allowed to install or update from this registry."
              operatorContext={[
                `Trust policy: ${source.trustPolicy}`,
                `Pinned keys: ${source.pinnedKeyIds.length}`,
                `Last updated: ${formatRelative(source.updatedAt)}`,
              ]}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function FleetActionCard(props: {
  fleetOverview?: FridayFleetOverviewResponse;
  degradedSatellites: FridayFleetSatelliteCard[];
  pairingRequests: FridayPendingSatellitePairingRequest[];
  onApprovePairing: (satelliteId: string) => void;
  onRejectPairing: (satelliteId: string) => void;
  pending: boolean;
}) {
  return (
    <section className="agent-subcard-strong p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-white/45">Fleet</p>
          <h3 className="mt-1 text-lg font-semibold text-white">Recover satellites and watch execution placement</h3>
        </div>
        <Link className="text-sm text-[var(--accent-soft)] hover:text-white" to="/fleet">
          Open all
        </Link>
      </div>
      {props.fleetOverview ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <MetricStat label="Online" value={String(props.fleetOverview.totals.online)} />
          <MetricStat label="Degraded" value={String(props.fleetOverview.totals.degraded)} tone="warning" />
          <MetricStat label="Offline" value={String(props.fleetOverview.totals.offline)} tone="danger" />
          <MetricStat label="Queue depth" value={String(props.fleetOverview.queue.queued)} />
        </div>
      ) : null}
      <div className="mt-4 space-y-3">
        {props.pairingRequests.length > 0 ? props.pairingRequests.slice(0, 2).map((request) => (
          <div key={request.requestId} className="agent-subcard p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h4 className="font-medium text-white">{request.displayName}</h4>
                <p className="text-xs text-white/45">{request.satelliteId}</p>
              </div>
              <StatusPill tone="warning">pending approval</StatusPill>
            </div>
            <p className="text-sm text-white/65">
              A new node is waiting to join the fleet. You can approve or reject it without leaving the assistant.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <ActionButton disabled={props.pending} onClick={() => props.onApprovePairing(request.satelliteId)}>
                Approve
              </ActionButton>
              <ActionButton tone="secondary" disabled={props.pending} onClick={() => props.onRejectPairing(request.satelliteId)}>
                Reject
              </ActionButton>
            </div>
            <AssistantAdvancedPanel
              summary="Pairing is still policy-bound. Friday can surface the request here, but trust and authorization still need an explicit decision."
              operatorContext={[
                `Satellite: ${request.satelliteId}`,
                `Requested at: ${formatTimestamp(request.createdAt)}`,
                `Type: ${request.type}`,
              ]}
            />
          </div>
        )) : props.degradedSatellites.length > 0 ? props.degradedSatellites.slice(0, 3).map((satellite) => (
          <div key={satellite.satelliteId} className="agent-subcard p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h4 className="font-medium text-white">{satellite.displayName}</h4>
                <p className="text-xs text-white/45">{satellite.satelliteId}</p>
              </div>
              <StatusPill tone={mapTone(statusLabelForFleetCard(satellite))}>
                {statusLabelForFleetCard(satellite)}
              </StatusPill>
            </div>
            <p className="text-sm text-white/65">
              Friday will keep this issue in the inbox and route you to fleet remediation when bounded recovery is needed.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]"
                to={buildFleetHref(satellite.satelliteId, "recovery")}
              >
                Review recovery
              </Link>
            </div>
            <AssistantAdvancedPanel
              summary="Friday will keep fleet remediation bounded. Degraded nodes surface recovery here, while queue, sync, and placement details stay available in the deep fleet page."
              operatorContext={[
                `Pairing: ${satellite.pairingStatus}`,
                `Heartbeat age: ${satellite.heartbeatAgeMs ?? 0} ms`,
                `Queue depth: ${satellite.queueDepth ?? 0}`,
              ]}
            />
          </div>
        )) : (
          <EmptyAssistantState
            icon={<Waypoints className="size-5" />}
            title="No degraded satellites"
            description="Fleet issues will show up here as recoverable cards instead of forcing you to start from raw queue or sync diagnostics."
          />
        )}
      </div>
    </section>
  );
}

function SystemActionCard(props: {
  session?: FridaySystemSession;
  snapshot?: FridaySystemSnapshot;
  observability?: FridayObservabilityOverview;
  activeAlerts: FridayObservabilityAlertSummary[];
  onSystemIntent: (action: FridaySystemIntentAction, layout?: "single_focus" | "dual_pane" | "triad", reason?: string) => void;
  onAcknowledgeAlert: (alertId: string) => void;
  pending: boolean;
  alertPending: boolean;
}) {
  return (
    <section className="agent-subcard-strong p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-white/45">System and observability</p>
          <h3 className="mt-1 text-lg font-semibold text-white">Actionable controls instead of raw intent names</h3>
        </div>
        <StatusPill tone={mapTone(props.session?.health.status)}>{props.session?.health.status ?? "loading"}</StatusPill>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricStat label="Desktop apps" value={String(props.snapshot?.apps.length ?? 0)} />
        <MetricStat label="Open windows" value={String(props.snapshot?.windows.length ?? 0)} />
        <MetricStat
          label="Alerts"
          value={String(props.observability?.alerts.activeAlerts ?? 0)}
          tone={props.observability?.alerts.activeAlerts ? "warning" : "success"}
        />
        <MetricStat
          label="Health"
          value={props.observability?.health?.status ?? "n/a"}
          tone={mapTone(props.observability?.health?.status)}
        />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <ActionButton disabled={props.pending} onClick={() => props.onSystemIntent("request_control", undefined, "Assistant control request")}>
          <Command className="mr-2 size-4" />
          Request control
        </ActionButton>
        <ActionButton tone="secondary" disabled={props.pending} onClick={() => props.onSystemIntent("arrange_windows", "dual_pane", "Dual-pane layout from assistant")}>
          <MonitorCog className="mr-2 size-4" />
          Arrange windows
        </ActionButton>
        <ActionButton tone="secondary" disabled={props.pending} onClick={() => props.onSystemIntent("recover_ui", undefined, "Recover assistant task path")}>
          <RefreshCcw className="mr-2 size-4" />
          Recover UI
        </ActionButton>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]"
          to={buildObservabilityHref({ focus: "assistant" })}
        >
          Open observability
        </Link>
        <Link className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]" to="/command-center">
          Open command center
        </Link>
      </div>
      <div className="mt-4 space-y-3">
        {props.activeAlerts.length > 0 ? props.activeAlerts.slice(0, 2).map((alert) => (
          <div key={alert.id} className="agent-subcard p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h4 className="font-medium text-white">{alert.ruleName}</h4>
                <p className="text-xs text-white/45">{alert.module}</p>
              </div>
              <StatusPill tone={alert.severity === "critical" ? "danger" : "warning"}>
                {alert.severity}
              </StatusPill>
            </div>
            <p className="text-sm text-white/65">{compactText(alert.summary)}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <ActionButton tone="secondary" disabled={props.alertPending} onClick={() => props.onAcknowledgeAlert(alert.id)}>
                Acknowledge
              </ActionButton>
            </div>
            <AssistantAdvancedPanel
              summary="This alert is visible here so a user can take the next safe step immediately, while full traces, audit, and escalation routing remain in observability."
              operatorContext={[
                `Severity: ${alert.severity}`,
                `Module: ${alert.module}`,
                `Detected: ${formatTimestamp(alert.detectedAt)}`,
              ]}
            />
          </div>
        )) : null}
      </div>
    </section>
  );
}

function IssueInboxSection(props: {
  issues: FridayIssueCard[];
  incidents: Awaited<ReturnType<typeof systemApi.listDiagnosisIncidents>>["items"];
  autoFixActions: Awaited<ReturnType<typeof systemApi.listAutoFixActions>>["items"];
  onApproveFix: (actionId: string) => void;
  onExecuteFix: (actionId: string) => void;
  onDenyFix: (actionId: string) => void;
  onRollbackFix: (actionId: string) => void;
  approvePending: boolean;
  executePending: boolean;
  denyPending: boolean;
  rollbackPending: boolean;
}) {
  return (
    <ShellCard eyebrow="Issue inbox" title="Problems, blockers, approvals, and repair suggestions">
      <div className="space-y-3">
        {props.issues.length === 0 && props.incidents.length === 0 ? (
          <EmptyAssistantState
            icon={<CheckCircle2 className="size-5" />}
            title="No urgent issues"
            description="When Friday finds something wrong, this inbox becomes the single place to approve, inspect, and recover."
          />
        ) : null}
        {props.issues.map((issue) => (
          <IssueCard
            key={issue.id}
            issue={issue}
            action={props.autoFixActions.find((item) => item.action.actionId === issue.actionId) ?? null}
            onApprove={props.onApproveFix}
            onExecute={props.onExecuteFix}
            onDeny={props.onDenyFix}
            onRollback={props.onRollbackFix}
            approvePending={props.approvePending}
            executePending={props.executePending}
            denyPending={props.denyPending}
            rollbackPending={props.rollbackPending}
          />
        ))}
        {props.incidents.slice(0, 4).map((record) => (
          <IncidentCard key={record.incident.incidentId} record={record} />
        ))}
      </div>
    </ShellCard>
  );
}

function IncidentCard(props: {
  record: Awaited<ReturnType<typeof systemApi.listDiagnosisIncidents>>["items"][number];
}) {
  const { record } = props;
  const [expanded, setExpanded] = useState(false);
  const diagnosisQuery = useQuery({
    queryKey: ["diagnosis", "incident", record.incident.incidentId],
    queryFn: () => systemApi.getIncidentDiagnosis(record.incident.incidentId),
    enabled: expanded,
  });

  return (
    <article className="rounded-2xl border border-white/10 bg-black/20 p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-white">{record.summary.rootCauseSummary}</p>
          <p className="text-xs text-white/45">{formatRelative(record.incident.ts)}</p>
        </div>
        <StatusPill tone={mapTone(record.incident.severity)}>{record.incident.severity}</StatusPill>
      </div>
      <p className="text-sm text-white/65">{compactText(record.summary.rootCauseSummary)}</p>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="mt-3 flex items-center gap-1 text-xs font-medium text-white/50 transition hover:text-white/80"
      >
        <ChevronRight className={`h-3 w-3 transition ${expanded ? "rotate-90" : ""}`} />
        {expanded ? "Hide diagnosis" : "Show diagnosis"}
      </button>
      {expanded && (
        <div className="mt-3 rounded-2xl border border-white/8 bg-white/[0.02] px-3 py-2 text-xs text-white/55">
          {diagnosisQuery.isLoading ? (
            <p>Loading diagnosis...</p>
          ) : diagnosisQuery.data?.diagnosis ? (
            <div className="space-y-2">
              {diagnosisQuery.data.summary.confidence !== undefined && (
                <p>Confidence: {Math.round(diagnosisQuery.data.summary.confidence * 100)}%</p>
              )}
              {diagnosisQuery.data.summary.suggestedFixes.length > 0 && (
                <div>
                  <p className="font-medium text-white/70">Suggested fixes:</p>
                  <ul className="ml-4 mt-1 list-disc space-y-0.5">
                    {diagnosisQuery.data.summary.suggestedFixes.map((fix, i) => (
                      <li key={i}>{fix}</li>
                    ))}
                  </ul>
                </div>
              )}
              {diagnosisQuery.data.summary.matchedLessonIds.length > 0 && (
                <p>Matched lessons: {diagnosisQuery.data.summary.matchedLessonIds.length}</p>
              )}
              <p>Recurrence: {diagnosisQuery.data.summary.recurrenceCount} time(s)</p>
              <p>Auto-fix eligible: {diagnosisQuery.data.summary.autoFixEligible ? "Yes" : "No"}</p>
            </div>
          ) : (
            <p>No diagnosis available yet.</p>
          )}
        </div>
      )}
    </article>
  );
}

function OutcomeFeedSection(props: {
  loopRuns: FridayAgentLoopRunRecord[];
  workflowOverviews: FridayWorkflowOverview[];
  observability?: FridayObservabilityOverview;
  metricsSummary?: Awaited<ReturnType<typeof systemApi.getAutoFixMetrics>>;
  loopPolicy?: FridayAgentLoopPolicy;
  expertModeEnabled: boolean;
  onToggleExpertMode: (enabled: boolean) => void;
  onPauseLoop: (loopRunId: string) => void;
  togglePending: boolean;
  pausePending: boolean;
}) {
  const metrics = latestMetricsSummary(props.metricsSummary);
  return (
    <ShellCard
      eyebrow="Outcome feed"
      title="See what Friday finished, verified, rolled back, or paused"
      aside={
        <ActionButton tone="secondary" disabled={props.togglePending} onClick={() => props.onToggleExpertMode(!props.expertModeEnabled)}>
          {props.expertModeEnabled ? "Disable expert mode" : "Enable expert mode"}
        </ActionButton>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricStat label="Loop runs" value={String(props.loopRuns.length)} />
        <MetricStat label="Fixes executed" value={String(metrics?.actionsExecuted ?? 0)} tone="success" />
        <MetricStat
          label="Rollback rate"
          value={metrics?.rollbackRate !== undefined ? `${Math.round(metrics.rollbackRate * 100)}%` : "n/a"}
          tone="warning"
        />
        <MetricStat
          label="Open alerts"
          value={String(props.observability?.alerts.activeAlerts ?? 0)}
          tone={props.observability?.alerts.activeAlerts ? "warning" : "success"}
        />
      </div>
      <div className="mt-4 space-y-3">
        {props.loopRuns.slice(0, 4).map((run) => (
          <article key={run.run.loopRunId} className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-white">
                  {run.run.objective ?? run.action?.summary.title ?? run.incident?.summary.rootCauseSummary ?? "Autonomous remediation"}
                </p>
                <p className="text-xs text-white/45">{formatTimestamp(run.run.createdAt)}</p>
              </div>
              <StatusPill tone={mapTone(run.run.status)}>{run.run.status}</StatusPill>
            </div>
            <p className="text-sm text-white/65">{summarizeLoopRun(run)}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {run.run.status !== "halted" ? (
                <ActionButton tone="secondary" disabled={props.pausePending} onClick={() => props.onPauseLoop(run.run.loopRunId)}>
                  Pause loop
                </ActionButton>
              ) : null}
              <Link
                className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]"
                to={buildObservabilityHref({ focus: "loop", loopRunId: run.run.loopRunId })}
              >
                Inspect evidence
              </Link>
            </div>
          </article>
        ))}
        {props.workflowOverviews.slice(0, 2).map((overview) => (
          <article key={`run-${overview.workflow.id}`} className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-white">{overview.workflow.name}</p>
                <p className="text-xs text-white/45">Latest workflow outcome</p>
              </div>
              <StatusPill tone={mapTone(overview.latestRun?.status)}>
                {overview.latestRun?.status ?? "waiting"}
              </StatusPill>
            </div>
            <p className="text-sm text-white/65">
              {overview.latestRunNodeTimeline[0]?.message
                ? compactText(overview.latestRunNodeTimeline[0].message)
                : overview.latestRun
                  ? `Triggered ${formatRelative(overview.latestRun.startedAt)} and ${overview.latestRun.finishedAt ? "finished" : "is still running"}.`
                  : "No recent workflow run yet."}
            </p>
          </article>
        ))}
      </div>
      <details className="mt-4 rounded-2xl border border-white/8 bg-white/[0.02] px-3 py-2 text-xs text-white/55">
        <summary className="cursor-pointer list-none font-medium text-white/70">Advanced</summary>
        <p className="mt-2">
          Auto-fix verification, rollback, and halt behavior still follow the same safety boundaries. Expert mode only changes how proactively Friday explores and guides, not whether destructive work can bypass approval.
        </p>
        <p className="mt-2">
          Current loop policy: attempts per fingerprint {props.loopPolicy?.maxAttemptsPerFingerprint ?? "n/a"}, cooldown {props.loopPolicy?.cooldownMinutes ?? "n/a"}m, high-risk approvals {props.loopPolicy?.highRiskFinalApprovalRequired ? "on" : "off"}.
        </p>
      </details>
    </ShellCard>
  );
}

function RecoveryCommandCenterSection(props: {
  paths: ReturnType<typeof buildAssistantRecoveryPaths>;
}) {
  if (props.paths.length === 0) {
    return null;
  }

  return (
    <ShellCard eyebrow="Recovery command center" title="Friday surfaces the next safest recovery path first">
      <div className="space-y-3">
        {props.paths.map((path, index) => (
          <article
            key={path.id}
            className={index === 0 ? "agent-subcard-strong p-4" : "agent-subcard p-4"}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-white/35">
                  {index === 0 ? "Start here" : "Then"}
                </p>
                <h3 className="mt-2 text-base font-semibold text-white">{path.title}</h3>
              </div>
              <StatusPill tone={path.tone}>{path.kind}</StatusPill>
            </div>
            <p className="mt-3 text-sm leading-6 text-white/64">{path.summary}</p>
            <p className="mt-3 text-xs uppercase tracking-[0.18em] text-white/35">Why Friday put this first</p>
            <p className="mt-2 text-sm text-white/72">{path.reason}</p>
            <div className="mt-4">
              <Link
                className="inline-flex items-center rounded-2xl bg-[var(--accent-soft)] px-4 py-2 text-sm font-medium text-black hover:bg-white"
                to={path.routeTarget}
              >
                Open recovery path
                <ChevronRight className="ml-2 size-4" />
              </Link>
            </div>
          </article>
        ))}
      </div>
    </ShellCard>
  );
}

function PlanList(props: { title: string; items?: string[]; emptyLabel: string }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-3">
      <p className="text-xs uppercase tracking-[0.2em] text-white/45">{props.title}</p>
      {props.items && props.items.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm text-white/70">
          {props.items.map((item) => (
            <li key={item} className="flex gap-2">
              <span className="mt-1 size-1.5 rounded-full bg-[var(--accent-soft)]" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-white/55">{props.emptyLabel}</p>
      )}
    </div>
  );
}

function SummaryPanel(props: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-3">
      <p className="text-xs uppercase tracking-[0.2em] text-white/45">{props.label}</p>
      <p className="mt-2 text-sm text-white/70">{props.value}</p>
    </div>
  );
}

function MetricStat(props: {
  label: string;
  value: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-black/20 p-3">
      <p className="text-[11px] uppercase tracking-[0.2em] text-white/45">{props.label}</p>
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-2xl font-semibold text-white">{props.value}</p>
        <StatusPill tone={props.tone}>{props.tone ?? "active"}</StatusPill>
      </div>
    </div>
  );
}

function IssueCard(props: {
  issue: FridayIssueCard;
  action: FridayFixPlanRecord | null;
  onApprove: (actionId: string) => void;
  onExecute: (actionId: string) => void;
  onDeny: (actionId: string) => void;
  onRollback: (actionId: string) => void;
  approvePending: boolean;
  executePending: boolean;
  denyPending: boolean;
  rollbackPending: boolean;
}) {
  const action = props.action;
  const playbook = buildAssistantIssuePlaybook({
    issue: props.issue,
    action,
  });
  return (
    <article className="rounded-2xl border border-white/10 bg-black/20 p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl border border-white/10 bg-white/8 p-2 text-white/75">
            {props.issue.kind === "approval_required" ? <ShieldAlert className="size-4" /> : <AlertTriangle className="size-4" />}
          </div>
          <div>
            <h4 className="font-medium text-white">{props.issue.title}</h4>
            <p className="text-xs text-white/45">{formatRelative(props.issue.createdAt)}</p>
          </div>
        </div>
        <StatusPill tone={mapTone(props.issue.severity)}>{props.issue.severity}</StatusPill>
      </div>
      <p className="text-sm text-white/65">{compactText(props.issue.summary)}</p>
      <div className="mt-3 rounded-2xl border border-white/8 bg-white/[0.03] p-3">
        <p className="text-xs uppercase tracking-[0.16em] text-white/40">Friday&apos;s next suggested step</p>
        <p className="mt-2 text-sm font-medium text-white">{playbook.title}</p>
        <p className="mt-2 text-xs leading-5 text-white/60">{playbook.summary}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            className="inline-flex items-center rounded-2xl bg-[var(--accent-soft)] px-4 py-2 text-sm font-medium text-black hover:bg-white"
            to={playbook.primaryRouteTarget}
          >
            {playbook.primaryLabel}
          </Link>
          {playbook.secondaryLabel && playbook.secondaryRouteTarget ? (
            <Link
              className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]"
              to={playbook.secondaryRouteTarget}
            >
              {playbook.secondaryLabel}
            </Link>
          ) : null}
        </div>
      </div>
      {action ? (
        <div className="mt-3 rounded-2xl border border-white/8 bg-white/[0.03] p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-white">{action.summary.title}</p>
            <StatusPill tone={mapTone(action.action.status)}>{action.action.status}</StatusPill>
          </div>
          <p className="text-xs text-white/55">{compactText(action.summary.summary)}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {action.summary.requiresApproval && action.action.status !== "rejected" ? (
              <ActionButton disabled={props.approvePending} onClick={() => props.onApprove(action.action.actionId)}>
                Approve fix
              </ActionButton>
            ) : null}
            {action.action.status !== "rejected" && action.action.status !== "applied" ? (
              <ActionButton tone="secondary" disabled={props.executePending} onClick={() => props.onExecute(action.action.actionId)}>
                Execute
              </ActionButton>
            ) : null}
            {action.action.status !== "rejected" && action.action.status !== "applied" ? (
              <ActionButton tone="secondary" disabled={props.denyPending} onClick={() => props.onDeny(action.action.actionId)}>
                Deny
              </ActionButton>
            ) : null}
            {action.action.status === "applied" ? (
              <ActionButton tone="secondary" disabled={props.rollbackPending} onClick={() => props.onRollback(action.action.actionId)}>
                Rollback
              </ActionButton>
            ) : null}
            <Link
              className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]"
              to={buildObservabilityHref({ focus: "alerts", issueId: props.issue.id })}
            >
              Details
            </Link>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function QuickActionTile(props: {
  action: FridayAssistantQuickAction;
  ctaLabel: string;
  secondaryLabel?: string;
  disabled?: boolean;
  to?: string;
  onClick?: () => void;
  onSecondaryClick?: () => void;
}) {
  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-white/45">{props.action.kind}</p>
          <h3 className="mt-1 text-base font-semibold text-white">{props.action.title}</h3>
        </div>
        <StatusPill tone={props.action.tone}>{props.action.tone}</StatusPill>
      </div>
      <p className="mt-3 text-sm text-white/65">{props.action.summary}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {props.to ? (
          <Link className="inline-flex items-center rounded-2xl bg-[var(--accent-soft)] px-4 py-2 text-sm font-medium text-black hover:bg-white" to={props.to}>
            {props.ctaLabel}
          </Link>
        ) : (
          <ActionButton disabled={props.disabled} onClick={props.onClick}>
            {props.ctaLabel}
          </ActionButton>
        )}
        {props.secondaryLabel && props.onSecondaryClick ? (
          <ActionButton tone="secondary" disabled={props.disabled} onClick={props.onSecondaryClick}>
            {props.secondaryLabel}
          </ActionButton>
        ) : null}
      </div>
    </div>
  );
}

function EmptyAssistantState(props: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-3xl border border-dashed border-white/12 bg-white/[0.02] p-5">
      <div className="mb-3 flex size-10 items-center justify-center rounded-2xl border border-white/10 bg-white/8 text-white/70">
        {props.icon}
      </div>
      <h4 className="text-base font-semibold text-white">{props.title}</h4>
      <p className="mt-2 text-sm text-white/60">{props.description}</p>
    </div>
  );
}

async function invalidateAssistantShell(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["assistant-shell"] }),
    queryClient.invalidateQueries({ queryKey: ["agent-os", "runs"] }),
  ]);
}
