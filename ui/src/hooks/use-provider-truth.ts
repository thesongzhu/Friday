import { useQuery } from "@tanstack/react-query";
import { providersApi } from "@/lib/api/providers";
import type {
  FridayModelRoutingConfig,
  FridayProviderBackendKind,
  FridayProviderHealthSnapshotItem,
  FridayProviderKind,
  FridayProviderProfile,
  FridayProviderRoutingExplainReport,
} from "@/lib/api/types";

export type ProviderTruthStatus = "healthy" | "degraded" | "offline";
export type ProviderTruthAlertTone = "warning" | "danger";

type ProviderTruthErrorSource = "providers" | "health" | "routing" | "explain";
type ProviderTruthAlertCode =
  | "selected_unhealthy"
  | "selected_health_missing"
  | "fallback_missing"
  | "fallback_unhealthy"
  | "route_adjusted"
  | "truth_unavailable";

export interface ProviderTruthSummary {
  providerId: string;
  providerName: string;
  providerKind?: FridayProviderKind;
  model: string;
  backendKind?: FridayProviderBackendKind;
  pinned: boolean;
  source: "routing-explain" | "routing-config";
}

export interface ProviderTruthAlert {
  id: string;
  code: ProviderTruthAlertCode;
  tone: ProviderTruthAlertTone;
  providerId?: string;
  providerName?: string;
  detail?: string;
}

export interface ProviderTruthHealthIssue {
  providerId: string;
  providerName: string;
  lane: FridayProviderHealthSnapshotItem["lane"];
  severity: ProviderTruthAlertTone;
  reasons: string[];
  suggestedAction: string;
  health: FridayProviderHealthSnapshotItem;
}

export interface ProviderTruthSnapshot {
  status: ProviderTruthStatus;
  currentStatus: ProviderTruthStatus;
  current?: ProviderTruthSummary;
  configured?: ProviderTruthSummary;
  selectedHealth?: FridayProviderHealthSnapshotItem;
  providers: FridayProviderProfile[];
  health: FridayProviderHealthSnapshotItem[];
  routing?: FridayModelRoutingConfig;
  explain?: FridayProviderRoutingExplainReport;
  degradedProviders: ProviderTruthHealthIssue[];
  degradedFallbackCount: number;
  hasFallbackLane: boolean;
  alertCount: number;
  alerts: ProviderTruthAlert[];
  errors: Array<{ source: ProviderTruthErrorSource; message: string }>;
  usingAdjustedRoute: boolean;
  reasonText?: string;
  hasPartialData: boolean;
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim().length > 0
  ) {
    return error.message;
  }
  return "Unknown provider routing error.";
}

function resolveProviderName(
  profile: FridayProviderProfile | undefined,
  providerId: string,
  providerKind?: FridayProviderKind,
): string {
  return profile?.name ?? providerKind ?? providerId;
}

function resolveModelLabel(
  explicitModel: string | undefined,
  profile: FridayProviderProfile | undefined,
): string {
  return explicitModel ?? profile?.defaultModel ?? "auto";
}

function buildConfiguredSummary(
  routing: FridayModelRoutingConfig | undefined,
  providerById: Map<string, FridayProviderProfile>,
): ProviderTruthSummary | undefined {
  if (!routing?.defaultProviderId) {
    return undefined;
  }
  const provider = providerById.get(routing.defaultProviderId);
  return {
    providerId: routing.defaultProviderId,
    providerName: resolveProviderName(provider, routing.defaultProviderId, provider?.kind),
    providerKind: provider?.kind,
    model: resolveModelLabel(routing.defaultModel, provider),
    backendKind: provider?.config.backendKind,
    pinned: false,
    source: "routing-config",
  };
}

function buildCurrentSummary(input: {
  explain: FridayProviderRoutingExplainReport | undefined;
  routing: FridayModelRoutingConfig | undefined;
  providerById: Map<string, FridayProviderProfile>;
}): ProviderTruthSummary | undefined {
  const { explain, routing, providerById } = input;
  if (explain?.selected) {
    const provider = providerById.get(explain.selected.providerId);
    return {
      providerId: explain.selected.providerId,
      providerName: resolveProviderName(
        provider,
        explain.selected.providerId,
        explain.selected.providerKind,
      ),
      providerKind: explain.selected.providerKind,
      model: explain.selected.model,
      backendKind: explain.selected.backendKind,
      pinned: explain.selected.pinned,
      source: "routing-explain",
    };
  }

  const selectedFromExplain = explain?.selectedAfterLearning ?? explain?.selectedBeforeLearning;
  if (selectedFromExplain) {
    const provider = providerById.get(selectedFromExplain.providerId);
    return {
      providerId: selectedFromExplain.providerId,
      providerName: resolveProviderName(
        provider,
        selectedFromExplain.providerId,
        selectedFromExplain.providerKind,
      ),
      providerKind: selectedFromExplain.providerKind,
      model: selectedFromExplain.model,
      backendKind: selectedFromExplain.backendKind,
      pinned: false,
      source: "routing-explain",
    };
  }

  return buildConfiguredSummary(routing, providerById);
}

function classifyHealthSeverity(
  item: FridayProviderHealthSnapshotItem | undefined,
): "healthy" | ProviderTruthAlertTone {
  if (!item) {
    return "danger";
  }

  const hasFatalHealthState =
    item.backendHealth === "missing" ||
    item.backendHealth === "unsupported" ||
    item.authHealth === "missing" ||
    item.authHealth === "unsupported" ||
    !item.routingEligible ||
    item.validationStatus === "failed";

  if (hasFatalHealthState) {
    return "danger";
  }

  const hasWarningState =
    item.backendHealth !== "healthy" ||
    item.authHealth !== "healthy" ||
    item.circuitState === "cooldown";

  return hasWarningState ? "warning" : "healthy";
}

function buildHealthDetail(item: FridayProviderHealthSnapshotItem | undefined): string | undefined {
  if (!item) {
    return undefined;
  }
  const primaryReason = item.reasons.find((reason) => reason.trim().length > 0);
  if (primaryReason) {
    return primaryReason;
  }
  if (item.suggestedAction.trim().length > 0) {
    return item.suggestedAction;
  }
  if (!item.routingEligible) {
    return "Provider is not currently routing eligible.";
  }
  return undefined;
}

export async function loadProviderTruth(): Promise<ProviderTruthSnapshot> {
  const [providersResult, healthResult, routingResult, explainResult] = await Promise.allSettled([
    providersApi.list(),
    providersApi.listHealth(),
    providersApi.getRouting(),
    providersApi.explainRouting({}),
  ]);

  const providers = providersResult.status === "fulfilled" ? providersResult.value : [];
  const health = healthResult.status === "fulfilled" ? healthResult.value : [];
  const routing = routingResult.status === "fulfilled" ? routingResult.value : undefined;
  const explain = explainResult.status === "fulfilled" ? explainResult.value : undefined;

  const errors: ProviderTruthSnapshot["errors"] = [];
  if (providersResult.status === "rejected") {
    errors.push({ source: "providers", message: resolveErrorMessage(providersResult.reason) });
  }
  if (healthResult.status === "rejected") {
    errors.push({ source: "health", message: resolveErrorMessage(healthResult.reason) });
  }
  if (routingResult.status === "rejected") {
    errors.push({ source: "routing", message: resolveErrorMessage(routingResult.reason) });
  }
  if (explainResult.status === "rejected") {
    errors.push({ source: "explain", message: resolveErrorMessage(explainResult.reason) });
  }

  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const healthByProviderId = new Map(health.map((item) => [item.providerId, item]));

  const configured = buildConfiguredSummary(routing, providerById);
  const current = buildCurrentSummary({ explain, routing, providerById });
  const selectedHealth = current ? healthByProviderId.get(current.providerId) : undefined;
  const selectedSeverity = classifyHealthSeverity(selectedHealth);

  const degradedProviders = health
    .map((item): ProviderTruthHealthIssue | null => {
      if (!item.enabled || item.lane === "disabled") {
        return null;
      }

      const severity = classifyHealthSeverity(item);
      if (severity === "healthy") {
        return null;
      }

      const provider = providerById.get(item.providerId);
      return {
        providerId: item.providerId,
        providerName: resolveProviderName(provider, item.providerId, item.providerKind),
        lane: item.lane,
        severity,
        reasons: item.reasons,
        suggestedAction: item.suggestedAction,
        health: item,
      };
    })
    .filter((issue): issue is ProviderTruthHealthIssue => issue !== null)
    .sort((left, right) => {
      const leftSelected = left.providerId === current?.providerId ? 1 : 0;
      const rightSelected = right.providerId === current?.providerId ? 1 : 0;
      if (leftSelected !== rightSelected) {
        return rightSelected - leftSelected;
      }
      const leftDanger = left.severity === "danger" ? 1 : 0;
      const rightDanger = right.severity === "danger" ? 1 : 0;
      if (leftDanger !== rightDanger) {
        return rightDanger - leftDanger;
      }
      const laneRank: Record<FridayProviderHealthSnapshotItem["lane"], number> = {
        primary: 0,
        fallback: 1,
        standby: 2,
        disabled: 3,
      };
      return laneRank[left.lane] - laneRank[right.lane];
    });

  const degradedFallbackCount = degradedProviders.filter(
    (issue) => issue.providerId !== current?.providerId,
  ).length;

  const usingAdjustedRoute = Boolean(
    explain?.selectedAdjusted ||
      (current &&
        configured &&
        (current.providerId !== configured.providerId ||
          current.model !== configured.model ||
          current.backendKind !== configured.backendKind)),
  );

  const alerts: ProviderTruthAlert[] = [];

  if (!current) {
    alerts.push({
      id: "truth-unavailable",
      code: "truth_unavailable",
      tone: "danger",
      detail: errors[0]?.message,
    });
  } else if (!selectedHealth && healthResult.status === "rejected") {
    alerts.push({
      id: "selected-health-missing",
      code: "selected_health_missing",
      tone: "warning",
      providerId: current.providerId,
      providerName: current.providerName,
      detail: errors.find((error) => error.source === "health")?.message,
    });
  } else if (selectedSeverity !== "healthy") {
    alerts.push({
      id: `selected-unhealthy-${current.providerId}`,
      code: "selected_unhealthy",
      tone: selectedSeverity,
      providerId: current.providerId,
      providerName: current.providerName,
      detail: buildHealthDetail(selectedHealth),
    });
  }

  if (usingAdjustedRoute && current && configured) {
    alerts.push({
      id: `route-adjusted-${current.providerId}`,
      code: "route_adjusted",
      tone: "warning",
      providerId: current.providerId,
      providerName: current.providerName,
      detail: `${configured.providerName} -> ${current.providerName}`,
    });
  }

  const degradedFallback = degradedProviders.find((issue) => issue.providerId !== current?.providerId);
  if (degradedFallback) {
    alerts.push({
      id: `fallback-unhealthy-${degradedFallback.providerId}`,
      code: "fallback_unhealthy",
      tone: degradedFallback.severity,
      providerId: degradedFallback.providerId,
      providerName: degradedFallback.providerName,
      detail: buildHealthDetail(degradedFallback.health),
    });
  }

  const hasFallbackLane = Boolean(routing?.fallbackProviderIds?.length);
  if (current && routingResult.status === "fulfilled" && !hasFallbackLane) {
    alerts.push({
      id: "fallback-missing",
      code: "fallback_missing",
      tone: "warning",
      providerId: current.providerId,
      providerName: current.providerName,
      detail: "No fallback provider is configured for model routing.",
    });
  }

  const currentStatus: ProviderTruthStatus = !current
    ? "offline"
    : selectedSeverity === "healthy"
      ? "healthy"
      : "degraded";

  const hasWorkingRoute = Boolean(current);
  const status: ProviderTruthStatus = !hasWorkingRoute
    ? "offline"
    : alerts.length > 0 || degradedProviders.length > 0 || errors.length > 0
      ? "degraded"
      : "healthy";

  return {
    status,
    currentStatus,
    current,
    configured,
    selectedHealth,
    providers,
    health,
    routing,
    explain,
    degradedProviders,
    degradedFallbackCount,
    hasFallbackLane,
    alertCount: alerts.length,
    alerts,
    errors,
    usingAdjustedRoute,
    reasonText: explain?.reasonText,
    hasPartialData: errors.length > 0,
  };
}

export function useProviderTruthQuery() {
  return useQuery({
    queryKey: ["shell", "provider-truth"],
    queryFn: loadProviderTruth,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}
