import { type ReactNode, useEffect, useState } from "react";
import type {
  FridayCommunicationMbti,
  FridayCommunicationEmojiStyle,
  FridayCommunicationJargonTolerance,
  FridayCommunicationPersona,
  FridayCommunicationPersonaSettings,
} from "@friday-operator-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Brain, Cpu, DollarSign, KeyRound, MessageCircleMore, Shield, Sliders, Wifi, Wrench } from "lucide-react";
import { toast } from "sonner";
import { localize, type AppLocale } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import { ChannelConfigForm } from "@/components/core/channel-config-form";
import { assistantDiagnosticsApi } from "@/lib/api/assistant-diagnostics";
import { channelsApi } from "@/lib/api/channels";
import { healthApi } from "@/lib/api/health";
import { learningApi } from "@/lib/api/learning";
import { providerUsageApi } from "@/lib/api/provider-usage";
import { providersApi } from "@/lib/api/providers";
import { securityApi } from "@/lib/api/security";
import { systemApi } from "@/lib/api/system";
import { apiClient } from "@/lib/api/client";
import { ShellCard, StatusPill, ActionButton } from "@/components/core/primitives";
import { systemKeys } from "@/lib/system/query-keys";
import { summarizeHealthReasons } from "@/lib/system/view-models";
import {
  buildPersonaDraft,
  buildPersonaPreview,
  COMMUNICATION_MBTI_OPTIONS,
  getMbtiDefaults,
} from "@/lib/persona/communication-persona";

function formatTimestamp(value?: string): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function toneForStatus(value?: string): "neutral" | "success" | "warning" | "danger" {
  if (value === "healthy" || value === "ok" || value === "granted") return "success";
  if (value === "safe_mode" || value === "degraded" || value === "not_determined") return "warning";
  if (value === "denied" || value === "restricted" || value === "unavailable") return "danger";
  return "neutral";
}

function toneForProviderLane(value: "primary" | "fallback" | "standby" | "disabled"): "neutral" | "success" | "warning" {
  if (value === "primary") return "success";
  if (value === "fallback") return "warning";
  return "neutral";
}

function toneForMcpState(value: "configured" | "discoverable" | "loaded" | "deferred"): "neutral" | "success" | "warning" {
  if (value === "loaded") return "success";
  if (value === "deferred") return "warning";
  return "neutral";
}

function toneForChannelState(value: "disconnected" | "connecting" | "connected" | "error"): "neutral" | "success" | "warning" | "danger" {
  if (value === "connected") return "success";
  if (value === "connecting") return "warning";
  if (value === "error") return "danger";
  return "neutral";
}

function toneForCredentialStatus(value: "unknown" | "configured" | "missing" | "invalid"): "neutral" | "success" | "warning" | "danger" {
  if (value === "configured") return "success";
  if (value === "missing") return "warning";
  if (value === "invalid") return "danger";
  return "neutral";
}

function applyDraftToPreferencePayload(draft: {
  mbti: FridayCommunicationPersona["mbti"] | "";
  settings: FridayCommunicationPersonaSettings;
}) {
  return [
    { category: "communication" as const, key: "persona.mbti", value: draft.mbti || null },
    { category: "communication" as const, key: "persona.tone", value: draft.settings.tone },
    { category: "communication" as const, key: "persona.verbosity", value: draft.settings.verbosity },
    { category: "communication" as const, key: "persona.structure", value: draft.settings.structure },
    { category: "communication" as const, key: "persona.question_style", value: draft.settings.questionStyle },
    { category: "communication" as const, key: "persona.directness", value: draft.settings.directness },
    { category: "communication" as const, key: "persona.emoji_style", value: draft.settings.emojiStyle },
    { category: "communication" as const, key: "persona.jargon_tolerance", value: draft.settings.jargonTolerance },
    { category: "communication" as const, key: "persona.assumption_style", value: draft.settings.assumptionStyle },
    { category: "communication" as const, key: "persona.confirmation_style", value: draft.settings.confirmationStyle },
  ];
}

export function SettingsPage() {
  const { locale } = useAppLocale();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => buildPersonaDraft());

  const { data: health } = useQuery({
    queryKey: ["settings", "health"],
    queryFn: () => healthApi.getHealth(),
    refetchInterval: 30_000,
  });

  const { data: me } = useQuery({
    queryKey: ["settings", "me"],
    queryFn: () => healthApi.getMe(),
  });

  const { data: providers = [] } = useQuery({
    queryKey: ["settings", "providers"],
    queryFn: () => providersApi.list(),
  });

  const { data: providerTemplates = [] } = useQuery({
    queryKey: ["settings", "provider-templates"],
    queryFn: () => providersApi.listTemplates(),
    retry: 0,
    staleTime: 30_000,
  });

  const { data: providerHealth = [] } = useQuery({
    queryKey: ["settings", "provider-health"],
    queryFn: () => providersApi.listHealth(),
    retry: 0,
    refetchInterval: 15_000,
  });

  const { data: assistantDiagnostics } = useQuery({
    queryKey: ["settings", "assistant-diagnostics"],
    queryFn: () => assistantDiagnosticsApi.get(),
    retry: 0,
    refetchInterval: 15_000,
  });

  const { data: channels = [] } = useQuery({
    queryKey: ["settings", "channels"],
    queryFn: () => channelsApi.list(),
    retry: 0,
    refetchInterval: 15_000,
  });

  const { data: systemSession } = useQuery({
    queryKey: systemKeys.session(),
    queryFn: () => systemApi.getSession(),
    retry: 0,
    refetchInterval: 10_000,
  });

  const { data: systemState } = useQuery({
    queryKey: systemKeys.state(),
    queryFn: () => systemApi.getState(),
    retry: 0,
    refetchInterval: 10_000,
  });

  const { data: persona } = useQuery({
    queryKey: systemKeys.communicationPersona(),
    queryFn: () => systemApi.getCommunicationPersona(),
    retry: 0,
  });

  const { data: budgetStatus } = useQuery({
    queryKey: ["settings", "budget"],
    queryFn: () => providerUsageApi.getBudget(),
    retry: 0,
  });

  const { data: learnedFacts = [] } = useQuery({
    queryKey: ["settings", "learnedFacts"],
    queryFn: async () => {
      const data = await apiClient.get<{ items: Array<{ key: string; value: unknown; confidence: number; evidenceCount: number; lastConfirmedAt: string }> }>("/v1/uix/learned-facts");
      return data.items;
    },
    retry: 0,
  });

  const { data: securityCenter } = useQuery({
    queryKey: ["settings", "security"],
    queryFn: () => securityApi.getCenter(),
    retry: 0,
  });

  const { data: agentLoopPolicy } = useQuery({
    queryKey: systemKeys.agentLoopPolicy(),
    queryFn: () => systemApi.getAgentLoopPolicy(),
    retry: 0,
  });

  const { data: expertMode } = useQuery({
    queryKey: systemKeys.agentLoopExpertMode(),
    queryFn: () => systemApi.getAgentLoopExpertMode(),
    retry: 0,
  });

  const { data: routingConfig } = useQuery({
    queryKey: ["settings", "routing-config"],
    queryFn: () => providersApi.getRouting(),
    retry: 0,
  });

  const { data: learningOverview } = useQuery({
    queryKey: ["settings", "learning-overview"],
    queryFn: () => learningApi.getOverview(12),
    retry: 0,
  });

  const selectedProviderId = routingConfig?.defaultProviderId ?? providers[0]?.id;
  const { data: routingExplain } = useQuery({
    queryKey: ["settings", "routing-explain", selectedProviderId],
    enabled: Boolean(selectedProviderId),
    queryFn: () => providersApi.explainRouting({
      requestedProviderId: selectedProviderId,
      taskProfileId: "review",
      estimatedInputTokens: 1200,
      complexity: "medium",
      requiresNativeTools: true,
    }),
    retry: 0,
  });

  const pinRouteMutation = useMutation({
    mutationFn: (input: { providerId: string; model: string; backendKind: "http" | "cli" | "sdk"; taskProfileId?: string }) =>
      providersApi.pinRoute({
        providerId: input.providerId,
        model: input.model,
        backendKind: input.backendKind,
        taskProfileId: input.taskProfileId,
        reason: "Pinned from settings admin",
      }),
    onSuccess: async () => {
      toast.success("Route pinned");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings", "routing-explain"] }),
        queryClient.invalidateQueries({ queryKey: ["settings", "learning-overview"] }),
      ]);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not pin route");
    },
  });

  const clearPenaltyMutation = useMutation({
    mutationFn: (input: { providerId: string; model: string; backendKind: "http" | "cli" | "sdk"; taskProfileId?: string }) =>
      providersApi.clearRoutePenalty(input),
    onSuccess: async () => {
      toast.success("Route penalty cleared");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings", "routing-explain"] }),
        queryClient.invalidateQueries({ queryKey: ["settings", "learning-overview"] }),
      ]);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not clear route penalty");
    },
  });

  const lessonToggleMutation = useMutation({
    mutationFn: (input: { lessonId: string; enabled: boolean }) =>
      learningApi.setLessonEnabled({
        lessonId: input.lessonId,
        enabled: input.enabled,
        reason: "Updated from settings admin",
      }),
    onSuccess: async () => {
      toast.success("Lesson updated");
      await queryClient.invalidateQueries({ queryKey: ["settings", "learning-overview"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not update lesson");
    },
  });

  const demotePatternMutation = useMutation({
    mutationFn: (patternId: string) =>
      learningApi.demotePattern({
        patternId,
        factor: 0.5,
        reason: "Demoted from settings admin",
      }),
    onSuccess: async () => {
      toast.success("Pattern demoted");
      await queryClient.invalidateQueries({ queryKey: ["settings", "learning-overview"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not demote pattern");
    },
  });

  useEffect(() => {
    if (persona) {
      setDraft(buildPersonaDraft(persona));
    }
  }, [persona]);

  const savePersonaMutation = useMutation({
    mutationFn: () => systemApi.updateCommunicationPreferences(applyDraftToPreferencePayload(draft)),
    onSuccess: async () => {
      toast.success("Communication preferences saved");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: systemKeys.communicationPersona() }),
        queryClient.invalidateQueries({ queryKey: systemKeys.communicationPreferences() }),
      ]);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to save communication settings");
    },
  });

  const updatePolicyMutation = useMutation({
    mutationFn: (patch: { paused?: boolean; autoApplyLowRisk?: boolean; cooldownMinutes?: number }) =>
      systemApi.updateAgentLoopPolicy(patch),
    onSuccess: () => {
      toast.success("Agent loop policy updated.");
      void queryClient.invalidateQueries({ queryKey: systemKeys.agentLoopPolicy() });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not update policy.");
    },
  });

  const toggleExpertMutation = useMutation({
    mutationFn: (enabled: boolean) => systemApi.updateAgentLoopExpertMode({ enabled }),
    onSuccess: (result) => {
      toast.success(result.enabled ? "Expert mode enabled" : "Expert mode disabled");
      void queryClient.invalidateQueries({ queryKey: systemKeys.agentLoopExpertMode() });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not toggle expert mode.");
    },
  });

  const preview = buildPersonaPreview(draft.settings);
  const mcpStates = assistantDiagnostics?.mcpServerStates ?? [];
  const loadedMcpCount = mcpStates.filter((state) => state.state === "loaded").length;
  const connectedChannelCount = channels.filter((channel) => channel.health.state === "connected").length;
  const channelAttentionCount = channels.filter((channel) =>
    channel.health.state === "error"
    || channel.health.credentialStatus === "missing"
    || channel.health.credentialStatus === "invalid"
    || Boolean(channel.health.blockedReason),
  ).length;

  return (
    <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
      <div className="space-y-4">
        <ShellCard eyebrow={localize(locale, "系统健康", "System Health")} title={localize(locale, "诊断", "Diagnostics")}>
          {health ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <DiagnosticTile icon={<Cpu className="h-4 w-4" />} label="API Status" value={health.status} />
                <DiagnosticTile icon={<Wifi className="h-4 w-4" />} label="Remote Mode" value={health.capabilities?.system?.remoteMode ?? "unavailable"} />
                <DiagnosticTile icon={<Shield className="h-4 w-4" />} label="System Enabled" value={String(Boolean(health.capabilities?.system?.enabled))} />
                <DiagnosticTile icon={<KeyRound className="h-4 w-4" />} label="Uptime" value={`${health.uptime}s`} />
              </div>
              <p className="text-sm text-[color:var(--color-text-secondary)]">
                The web shell reflects the backend truth. If native companion features are missing, this page reports them directly rather than hiding them behind placeholders.
              </p>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">Loading diagnostics...</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "身份", "Identity")} title={localize(locale, "运维访问", "Operator Access")}>
          {me ? (
            <div className="space-y-3 text-sm text-[color:var(--color-text-secondary)]">
              <div className="flex items-center justify-between gap-4">
                <span>User</span>
                <span className="font-medium text-[color:var(--color-text-primary)]">{me.user.displayName}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span>Role</span>
                <StatusPill>{me.user.role}</StatusPill>
              </div>
              <div>
                <p className="mb-2 text-[color:var(--color-text-tertiary)]">Scopes</p>
                <div className="flex flex-wrap gap-2">
                  {me.scopes.map((scope) => (
                    <StatusPill key={scope}>{scope}</StatusPill>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">Loading identity...</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "提供商", "Providers")} title={localize(locale, "模型路由基础", "Model Routing Basics")}>
          {providers.length === 0 ? (
            <p className="text-sm text-[color:var(--color-text-secondary)]">No providers configured yet.</p>
          ) : (
            <div className="space-y-3">
              {providers.map((provider) => (
                <div key={provider.id} className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                  {(() => {
                    const template = providerTemplates.find((item) => item.providerKind === provider.kind);
                    const healthItem = providerHealth.find((item) => item.providerId === provider.id);
                    return (
                      <>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">{provider.name}</p>
                      <p className="text-xs text-[color:var(--color-text-tertiary)]">{provider.kind} · {provider.baseUrl}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <StatusPill tone={provider.enabled ? "success" : "neutral"}>
                        {provider.enabled ? "enabled" : "disabled"}
                      </StatusPill>
                      {template ? <StatusPill tone={template.tier === "official" ? "success" : template.tier === "verified" ? "warning" : "neutral"}>{template.tier}</StatusPill> : null}
                      {healthItem ? <StatusPill tone={toneForProviderLane(healthItem.lane)}>{healthItem.lane}</StatusPill> : null}
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">
                    Default model: {provider.defaultModel ?? provider.config.supportedModels[0] ?? "Not set"}
                  </p>
                  {healthItem ? (
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <DiagnosticRow label="Backend health" value={healthItem.backendHealth} />
                      <DiagnosticRow label="Auth health" value={healthItem.authHealth} />
                      <DiagnosticRow label="Validation" value={healthItem.validationStatus} />
                      <DiagnosticRow label="Circuit" value={healthItem.circuitState} />
                    </div>
                  ) : null}
                  {healthItem?.cooldownRemainingMs ? (
                    <p className="mt-2 text-xs text-[color:var(--color-text-faint)]">
                      Cooldown remaining: {Math.ceil(healthItem.cooldownRemainingMs / 1000)}s
                    </p>
                  ) : null}
                  {healthItem?.suggestedAction ? (
                    <p className="mt-2 text-xs text-[color:var(--color-text-secondary)]">{healthItem.suggestedAction}</p>
                  ) : null}
                      </>
                    );
                  })()}
                </div>
              ))}
            </div>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "运维", "Operator")} title={localize(locale, "路由可解释性", "Routing Explainability")}>
          {routingExplain ? (
            <div className="space-y-4">
              <div className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-[color:var(--color-text-primary)]">Current decision</p>
                    <p className="text-xs text-[color:var(--color-text-tertiary)]">{routingExplain.reasonCode} · history window {routingExplain.historyWindow.sampleLimit}</p>
                  </div>
                  <StatusPill tone={routingExplain.learningAdjusted ? "success" : routingExplain.learningSignalsPresent ? "warning" : "neutral"}>
                    {routingExplain.learningAdjusted ? "adjusted" : routingExplain.learningSignalsPresent ? "signals present" : "configured"}
                  </StatusPill>
                </div>
                <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">{routingExplain.reasonText}</p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <DiagnosticRow
                    label="Before learning"
                    value={routingExplain.selectedBeforeLearning ? `${routingExplain.selectedBeforeLearning.providerId} / ${routingExplain.selectedBeforeLearning.model}` : "n/a"}
                  />
                  <DiagnosticRow
                    label="After learning"
                    value={routingExplain.selectedAfterLearning ? `${routingExplain.selectedAfterLearning.providerId} / ${routingExplain.selectedAfterLearning.model}` : "n/a"}
                  />
                </div>
              </div>
              <div className="space-y-3">
                {routingExplain.candidateScores.slice(0, 4).map((candidate) => (
                  <div key={`${candidate.providerId}:${candidate.model}:${candidate.backendKind}`} className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-[color:var(--color-text-primary)]">{candidate.providerId} / {candidate.model}</p>
                        <p className="text-xs text-[color:var(--color-text-tertiary)]">{candidate.backendKind} · rank {candidate.originalRank} → {candidate.finalRank}</p>
                      </div>
                      <StatusPill tone={candidate.selected ? "success" : candidate.eligible ? "neutral" : "warning"}>
                        {candidate.selected ? "selected" : candidate.eligible ? "eligible" : "blocked"}
                      </StatusPill>
                    </div>
                    <p className="mt-2 text-xs text-[color:var(--color-text-tertiary)]">
                      score {candidate.finalScore.toFixed(2)} = base {candidate.baseRankScore.toFixed(2)} + history {candidate.historyScore.toFixed(2)} + lesson {candidate.lessonScore.toFixed(2)} + pattern {candidate.patternScore.toFixed(2)} + pin {candidate.pinBonus.toFixed(2)} + penalty {candidate.routePenaltyScore.toFixed(2)}
                    </p>
                    {candidate.historyStats ? (
                      <p className="mt-2 text-xs text-[color:var(--color-text-faint)]">
                        history {candidate.historyStats.sampleCount} samples · success {(candidate.historyStats.successRate * 100).toFixed(0)}% · failure {(candidate.historyStats.failureRate * 100).toFixed(0)}%
                      </p>
                    ) : null}
                    {(candidate.matchedLessonIds.length > 0 || candidate.matchedPatternIds.length > 0) ? (
                      <p className="mt-2 text-xs text-[color:var(--color-text-faint)]">
                        matched lessons {candidate.matchedLessonIds.length} · matched patterns {candidate.matchedPatternIds.length}
                      </p>
                    ) : null}
                    {candidate.ineligibilityReasons.length > 0 ? (
                      <p className="mt-2 text-xs text-[color:var(--color-text-secondary)]">{candidate.ineligibilityReasons.join(", ")}</p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <ActionButton
                        tone="secondary"
                        disabled={pinRouteMutation.isPending}
                        onClick={() => pinRouteMutation.mutate({
                          providerId: candidate.providerId,
                          model: candidate.model,
                          backendKind: candidate.backendKind,
                          taskProfileId: routingExplain.taskProfileId,
                        })}
                      >
                        Pin Route
                      </ActionButton>
                      <ActionButton
                        tone="secondary"
                        disabled={clearPenaltyMutation.isPending}
                        onClick={() => clearPenaltyMutation.mutate({
                          providerId: candidate.providerId,
                          model: candidate.model,
                          backendKind: candidate.backendKind,
                          taskProfileId: routingExplain.taskProfileId,
                        })}
                      >
                        Clear Penalty
                      </ActionButton>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">Routing explain preview unavailable.</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "沟通", "Communication")} title={localize(locale, "人格", "Persona")}>
          <div className="space-y-4">
            <p className="text-sm text-[color:var(--color-text-secondary)]">
              MBTI is a comfort-oriented starting template. The actual behavior comes from the settings below, and it never weakens safety or approval boundaries.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-2 text-sm text-[color:var(--color-text-secondary)]">
                <span>MBTI template</span>
                <select
                  value={draft.mbti}
                  onChange={(event) => {
                    const mbti = event.target.value as FridayCommunicationMbti | "";
                    setDraft({
                      mbti,
                      settings: getMbtiDefaults(mbti || null),
                    });
                  }}
                  className="agent-select"
                >
                  <option value="">Default</option>
                  {COMMUNICATION_MBTI_OPTIONS.map((mbti) => (
                    <option key={mbti} value={mbti}>{mbti}</option>
                  ))}
                </select>
              </label>
              <PersonaField
                label="Tone"
                value={draft.settings.tone}
                onChange={(value) => setDraft((current) => ({ ...current, settings: { ...current.settings, tone: value as FridayCommunicationPersonaSettings["tone"] } }))}
                options={["warm", "neutral", "analytical", "encouraging"]}
              />
              <PersonaField
                label="Verbosity"
                value={draft.settings.verbosity}
                onChange={(value) => setDraft((current) => ({ ...current, settings: { ...current.settings, verbosity: value as FridayCommunicationPersonaSettings["verbosity"] } }))}
                options={["concise", "balanced", "detailed"]}
              />
              <PersonaField
                label="Structure"
                value={draft.settings.structure}
                onChange={(value) => setDraft((current) => ({ ...current, settings: { ...current.settings, structure: value as FridayCommunicationPersonaSettings["structure"] } }))}
                options={["compact", "balanced", "structured"]}
              />
              <PersonaField
                label="Question style"
                value={draft.settings.questionStyle}
                onChange={(value) => setDraft((current) => ({ ...current, settings: { ...current.settings, questionStyle: value as FridayCommunicationPersonaSettings["questionStyle"] } }))}
                options={["minimal", "guided", "exploratory"]}
              />
              <PersonaField
                label="Directness"
                value={draft.settings.directness}
                onChange={(value) => setDraft((current) => ({ ...current, settings: { ...current.settings, directness: value as FridayCommunicationPersonaSettings["directness"] } }))}
                options={["soft", "balanced", "direct"]}
              />
              <PersonaField
                label="Assumption style"
                value={draft.settings.assumptionStyle}
                onChange={(value) => setDraft((current) => ({ ...current, settings: { ...current.settings, assumptionStyle: value as FridayCommunicationPersonaSettings["assumptionStyle"] } }))}
                options={["ask_first", "balanced", "infer_first"]}
              />
              <PersonaField
                label="Confirmation style"
                value={draft.settings.confirmationStyle}
                onChange={(value) => setDraft((current) => ({ ...current, settings: { ...current.settings, confirmationStyle: value as FridayCommunicationPersonaSettings["confirmationStyle"] } }))}
                options={["minimal", "balanced", "explicit"]}
              />
              <PersonaField
                label="Jargon tolerance"
                value={draft.settings.jargonTolerance}
                onChange={(value) => setDraft((current) => ({ ...current, settings: { ...current.settings, jargonTolerance: value as FridayCommunicationJargonTolerance } }))}
                options={["low", "medium", "high"]}
              />
              <PersonaField
                label="Emoji style"
                value={draft.settings.emojiStyle}
                onChange={(value) => setDraft((current) => ({ ...current, settings: { ...current.settings, emojiStyle: value as FridayCommunicationEmojiStyle } }))}
                options={["none", "light"]}
              />
            </div>
            <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
              <div className="flex items-center gap-2 text-[color:var(--color-text-primary)]">
                <MessageCircleMore className="h-4 w-4" />
                <p className="font-medium">Preview</p>
              </div>
              <p className="mt-3 text-sm text-[color:var(--color-text-tertiary)]">Style: {preview.styleLabel}</p>
              <p className="mt-3 text-sm text-[color:var(--color-text-primary)]">{preview.sampleClarifier}</p>
              <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">{preview.sampleBoundary}</p>
              {persona ? (
                <p className="mt-3 text-xs text-[color:var(--color-text-faint)]">
                  Current resolved persona: {persona.mbti ?? "Default"} · tone from {persona.inheritedFrom.settings.tone}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <ActionButton onClick={() => savePersonaMutation.mutate()} disabled={savePersonaMutation.isPending}>
                Save Communication Style
              </ActionButton>
              <ActionButton
                tone="secondary"
                onClick={() => setDraft({ mbti: draft.mbti, settings: getMbtiDefaults(draft.mbti || null) })}
              >
                Reset To MBTI Defaults
              </ActionButton>
            </div>
          </div>
        </ShellCard>
      </div>

      <div className="space-y-4">
        <ShellCard eyebrow={localize(locale, "Agent OS 会话", "Agent OS Session")} title={localize(locale, "伴侣与权限", "Companion And Permissions")}>
          {systemSession && systemState ? (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <DiagnosticTile icon={<Cpu className="h-4 w-4" />} label="Workspace Root" value={systemSession.workspaceRoot} mono />
                <DiagnosticTile icon={<Wifi className="h-4 w-4" />} label="Cloud Planning" value={systemSession.cloudPlanningMode} />
                <DiagnosticTile icon={<Shield className="h-4 w-4" />} label="Health" value={systemState.health.status} />
                <DiagnosticTile icon={<KeyRound className="h-4 w-4" />} label="Started" value={formatTimestamp(systemSession.startedAt)} />
              </div>
              <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-[color:var(--color-text-primary)]">Companion bridge</p>
                    <p className="text-sm text-[color:var(--color-text-tertiary)]">
                      {systemSession.companion.runtimeKind} · {systemSession.companion.transport.mode} · {systemSession.companion.transport.protocol}
                    </p>
                  </div>
                  <StatusPill tone={toneForStatus(systemSession.health.status)}>
                    {systemSession.health.status}
                  </StatusPill>
                </div>
                <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">{summarizeHealthReasons(systemSession.health)}</p>
              </div>
              <div className="space-y-3">
                {systemState.permissions.map((permission) => (
                  <div key={permission.id} className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-[color:var(--color-text-primary)]">{permission.permission}</p>
                        <p className="text-xs text-[color:var(--color-text-faint)]">{permission.grantInstructions ?? "No extra instructions reported."}</p>
                      </div>
                      <StatusPill tone={toneForStatus(permission.status)}>{permission.status}</StatusPill>
                    </div>
                  </div>
                ))}
                {systemState.permissions.length === 0 ? (
                  <p className="text-sm text-[color:var(--color-text-secondary)]">No desktop permission telemetry is currently available.</p>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">Agent OS routes are not responding yet.</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "伴侣状态", "Companion State")} title={localize(locale, "桌面面板", "Desktop Surfaces")}>
          {systemState ? (
            <div className="space-y-3">
              <DiagnosticRow label="Frontmost App" value={systemState.frontmostAppId ?? "Unknown"} />
              <DiagnosticRow label="Frontmost Window" value={systemState.frontmostWindowId ?? "Unknown"} />
              <DiagnosticRow label="Last Snapshot" value={formatTimestamp(systemState.capturedAt)} />
              <DiagnosticRow label="Active Lease" value={systemState.controlLease?.ownerId ?? "None"} />
              <DiagnosticRow label="Permissions Updated" value={formatTimestamp(systemState.health.updatedAt)} />
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">Waiting for a system snapshot.</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "Token 经济", "Token Economy")} title={localize(locale, "LLM 预算", "LLM Budget")}>
          {budgetStatus ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <DiagnosticTile
                  icon={<DollarSign className="h-4 w-4" />}
                  label="Status"
                  value={budgetStatus.state}
                />
                <DiagnosticTile
                  icon={<DollarSign className="h-4 w-4" />}
                  label="Spent This Month"
                  value={`$${budgetStatus.spentUsd.toFixed(2)}`}
                />
              </div>
              <div className="space-y-2">
                <DiagnosticRow label="Month" value={budgetStatus.month} />
                <DiagnosticRow
                  label="Monthly Limit"
                  value={budgetStatus.config ? `$${budgetStatus.config.monthlyLimitUsd.toFixed(2)}` : "No limit set"}
                />
                <DiagnosticRow
                  label="Remaining"
                  value={budgetStatus.remainingUsd !== null ? `$${budgetStatus.remainingUsd.toFixed(2)}` : "Unlimited"}
                />
              </div>
              {budgetStatus.state !== "ok" ? (
                <div className={`rounded-2xl border p-3 text-sm ${budgetStatus.state === "over_limit" ? "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] text-[color:var(--color-text-primary)]" : "border-[color:var(--color-accent-soft)] bg-[color:var(--color-accent-muted)] text-[color:var(--color-text-primary)]"}`}>
                  {budgetStatus.state === "over_limit"
                    ? "Budget exceeded — Friday will prefer local models (Ollama) until the next billing cycle."
                    : "Approaching budget limit — Friday will prefer cheaper models when possible."}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">Budget data unavailable.</p>
          )}
        </ShellCard>

        {learnedFacts.length > 0 ? (
          <ShellCard eyebrow={localize(locale, "学习", "Learning")} title={localize(locale, "Friday 对你的了解", "What Friday Knows About You")}>
            <div className="space-y-3">
              <p className="text-sm text-[color:var(--color-text-secondary)]">
                These are preferences and facts Friday has learned from your interactions.
              </p>
              {learnedFacts.map((fact) => (
                <div key={fact.key} className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Brain className="h-3.5 w-3.5 text-[color:var(--color-text-faint)]" />
                        <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{fact.key}</p>
                      </div>
                      <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">{String(fact.value)}</p>
                    </div>
                    <StatusPill tone={fact.confidence >= 0.7 ? "success" : fact.confidence >= 0.4 ? "warning" : "neutral"}>
                      {(fact.confidence * 100).toFixed(0)}%
                    </StatusPill>
                  </div>
                  <p className="mt-2 text-xs text-[color:var(--color-text-faint)]">
                    {String(fact.evidenceCount)} evidence · last confirmed {formatTimestamp(fact.lastConfirmedAt)}
                  </p>
                </div>
              ))}
            </div>
          </ShellCard>
        ) : null}

        <ShellCard eyebrow={localize(locale, "运维", "Operator")} title={localize(locale, "学习控制", "Learning Controls")}>
          {learningOverview ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <DiagnosticTile icon={<Brain className="h-4 w-4" />} label="Lessons" value={String(learningOverview.coverage.lessons)} />
                <DiagnosticTile icon={<Brain className="h-4 w-4" />} label="Patterns" value={String(learningOverview.coverage.patterns)} />
                <DiagnosticTile icon={<Sliders className="h-4 w-4" />} label="Route Adjustments" value={String(learningOverview.coverage.routeAdjustments)} />
                <DiagnosticTile icon={<AlertTriangle className="h-4 w-4" />} label="Blocked Routes" value={String(learningOverview.coverage.blockedRoutes)} />
              </div>
              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">Lessons</p>
                {learningOverview.lessons.slice(0, 3).map((record) => (
                  <div key={record.lesson.id} className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-[color:var(--color-text-primary)]">{record.lesson.title}</p>
                        <p className="text-xs text-[color:var(--color-text-tertiary)]">{record.lesson.cause}</p>
                      </div>
                      <StatusPill tone={record.disabled ? "warning" : "success"}>
                        {record.disabled ? "disabled" : "enabled"}
                      </StatusPill>
                    </div>
                    <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">{record.lesson.fix}</p>
                    <div className="mt-3 flex gap-2">
                      <ActionButton
                        tone="secondary"
                        disabled={lessonToggleMutation.isPending}
                        onClick={() => lessonToggleMutation.mutate({
                          lessonId: record.lesson.id,
                          enabled: record.disabled,
                        })}
                      >
                        {record.disabled ? "Enable Lesson" : "Disable Lesson"}
                      </ActionButton>
                    </div>
                  </div>
                ))}
              </div>
              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">Patterns</p>
                {learningOverview.patterns.slice(0, 3).map((record) => (
                  <div key={record.patternId} className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-[color:var(--color-text-primary)]">{record.description}</p>
                        <p className="text-xs text-[color:var(--color-text-tertiary)]">{record.kind} · samples {record.sampleCount}</p>
                      </div>
                      <StatusPill tone={record.demoted ? "warning" : "neutral"}>
                        {record.demoted ? "demoted" : "active"}
                      </StatusPill>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <ActionButton
                        tone="secondary"
                        disabled={demotePatternMutation.isPending}
                        onClick={() => demotePatternMutation.mutate(record.patternId)}
                      >
                        Demote Pattern
                      </ActionButton>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">Learning controls unavailable.</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "安全", "Security")} title={localize(locale, "安全中心", "Security Center")}>
          {securityCenter ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <DiagnosticTile icon={<Shield className="h-4 w-4" />} label="Active Tokens" value={String(securityCenter.tokens.active)} />
                <DiagnosticTile icon={<KeyRound className="h-4 w-4" />} label="High Privilege" value={String(securityCenter.tokens.highPrivilegeActive)} />
              </div>
              {securityCenter.findings.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">Findings</p>
                  {securityCenter.findings.map((finding) => (
                    <div key={finding.id} className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[color:var(--color-text-faint)]" />
                          <p className="text-sm text-[color:var(--color-text-primary)]">{finding.message}</p>
                        </div>
                        <StatusPill tone={finding.severity === "high" ? "danger" : finding.severity === "medium" ? "warning" : "neutral"}>
                          {finding.severity}
                        </StatusPill>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-[color:var(--color-text-secondary)]">No security findings detected.</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">Security data unavailable.</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "能力管理", "Capability Management")} title={localize(locale, "MCP 与通道面板", "MCP And Channel Surfaces")}>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <DiagnosticTile icon={<Wrench className="h-4 w-4" />} label="MCP Loaded" value={`${loadedMcpCount}/${mcpStates.length}`} />
              <DiagnosticTile icon={<MessageCircleMore className="h-4 w-4" />} label="Channels Connected" value={`${connectedChannelCount}/${channels.length}`} />
              <DiagnosticTile icon={<AlertTriangle className="h-4 w-4" />} label="Attention Needed" value={String(channelAttentionCount)} />
            </div>

            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">MCP servers</p>
              {mcpStates.length === 0 ? (
                <p className="text-sm text-[color:var(--color-text-secondary)]">No MCP servers configured for this runtime.</p>
              ) : (
                mcpStates.map((state) => (
                  <div key={state.serverId} className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-[color:var(--color-text-primary)]">{state.serverId}</p>
                        <p className="text-xs text-[color:var(--color-text-tertiary)]">{state.transport} transport</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <StatusPill tone={toneForMcpState(state.state)}>{state.state}</StatusPill>
                        <StatusPill tone={state.lazyDiscovery ? "warning" : "neutral"}>
                          {state.lazyDiscovery ? "lazy" : "eager"}
                        </StatusPill>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <DiagnosticRow label="Tools" value={String(state.toolCount ?? 0)} />
                      <DiagnosticRow label="Resources" value={String(state.resourceCount ?? 0)} />
                      <DiagnosticRow label="Prompts" value={String(state.promptCount ?? 0)} />
                      <DiagnosticRow label="Last Loaded" value={formatTimestamp(state.lastLoadedAt)} />
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">Channel health</p>
              {channels.length === 0 ? (
                <p className="text-sm text-[color:var(--color-text-secondary)]">No channels are registered in this runtime.</p>
              ) : (
                channels.map((channel) => (
                  <div key={channel.kind} className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-[color:var(--color-text-primary)]">{channel.kind}</p>
                        <p className="text-xs text-[color:var(--color-text-tertiary)]">
                          running {String(channel.running)} · restarts {channel.health.restartCount}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <StatusPill tone={toneForChannelState(channel.health.state)}>{channel.health.state}</StatusPill>
                        <StatusPill tone={toneForCredentialStatus(channel.health.credentialStatus)}>
                          {channel.health.credentialStatus}
                        </StatusPill>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <DiagnosticRow label="Blocked Reason" value={channel.health.blockedReason ?? "None"} />
                      <DiagnosticRow label="Last Error" value={channel.health.lastError ?? "None"} />
                      <DiagnosticRow
                        label="Allowlist"
                        value={`users ${channel.allowlist.allowedUsersCount} · chats ${channel.allowlist.allowedChatsCount}`}
                      />
                      <DiagnosticRow
                        label="Support"
                        value={channel.contract?.supports
                          ? [
                              channel.contract.supports.directMessages ? "DM" : null,
                              channel.contract.supports.groupMessages ? "Group" : null,
                              channel.contract.supports.threads ? "Threads" : null,
                              channel.contract.supports.typing ? "Typing" : null,
                            ].filter(Boolean).join(", ") || "None"
                          : "Unknown"}
                      />
                    </div>
                    {channel.contract?.curatedSkillIds && channel.contract.curatedSkillIds.length > 0 ? (
                      <p className="mt-3 text-xs text-[color:var(--color-text-tertiary)]">
                        Curated skills: {channel.contract.curatedSkillIds.join(", ")}
                      </p>
                    ) : null}
                  </div>
                ))
              )}
            </div>

            <div className="mt-4 border-t border-[color:var(--color-border-soft)] pt-4">
              <p className="agent-eyebrow mb-3">{localize(locale, "添加通道", "Add Channel")}</p>
              <ChannelConfigForm locale={locale} />
            </div>
          </div>
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "能力", "Capabilities")} title={localize(locale, "工具可用性", "Tool Availability")}>
          {health ? (
            <div className="space-y-2">
              {[
                { name: "Plugins", enabled: health.capabilities?.plugins?.runtimeMode === "full" },
                { name: "Marketplace", enabled: health.capabilities?.plugins?.marketplaceAvailable === true },
                { name: "System orchestration", enabled: health.capabilities?.system?.enabled === true },
                { name: "Commerce", enabled: health.capabilities?.marketplace?.commerceEnabled === true },
                { name: "Channels", enabled: (health.capabilities?.channels?.enabledKinds?.length ?? 0) > 0 },
              ].map((tool) => (
                <div key={tool.name} className="flex items-center justify-between rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3 text-sm">
                  <div className="flex items-center gap-2">
                    <Wrench className="h-3.5 w-3.5 text-[color:var(--color-text-faint)]" />
                    <span className="text-[color:var(--color-text-secondary)]">{tool.name}</span>
                  </div>
                  <StatusPill tone={tool.enabled ? "success" : "neutral"}>
                    {tool.enabled ? "enabled" : "disabled"}
                  </StatusPill>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">Loading tool status...</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "Agent 循环", "Agent Loop")} title={localize(locale, "自动化策略", "Automation Policy")}>
          {agentLoopPolicy ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <DiagnosticTile icon={<Sliders className="h-4 w-4" />} label="Max Attempts" value={String(agentLoopPolicy.maxAttemptsPerFingerprint)} />
                <DiagnosticTile icon={<Sliders className="h-4 w-4" />} label="Cooldown" value={`${agentLoopPolicy.cooldownMinutes} min`} />
              </div>
              <div className="flex flex-wrap gap-2">
                <ActionButton
                  tone={agentLoopPolicy.paused ? "primary" : "secondary"}
                  disabled={updatePolicyMutation.isPending}
                  onClick={() => updatePolicyMutation.mutate({ paused: !agentLoopPolicy.paused })}
                >
                  {agentLoopPolicy.paused ? "Resume loop" : "Pause loop"}
                </ActionButton>
                <ActionButton
                  tone="secondary"
                  disabled={updatePolicyMutation.isPending}
                  onClick={() => updatePolicyMutation.mutate({ autoApplyLowRisk: !agentLoopPolicy.autoApplyLowRisk })}
                >
                  {agentLoopPolicy.autoApplyLowRisk ? "Disable auto-apply" : "Enable auto-apply"}
                </ActionButton>
              </div>
              <DiagnosticRow label="Require rollback plan" value={agentLoopPolicy.requireRollbackPlan ? "yes" : "no"} />
              <DiagnosticRow label="Require acceptance check" value={agentLoopPolicy.requireAcceptanceCheck ? "yes" : "no"} />
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">Agent loop policy unavailable.</p>
          )}
          {expertMode ? (
            <div className="mt-4 space-y-2 border-t border-[color:var(--color-border-soft)] pt-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">Expert Mode</p>
                <ActionButton
                  tone={expertMode.enabled ? "danger" : "primary"}
                  disabled={toggleExpertMutation.isPending}
                  onClick={() => toggleExpertMutation.mutate(!expertMode.enabled)}
                >
                  {expertMode.enabled ? "Disable" : "Enable"}
                </ActionButton>
              </div>
              {expertMode.contextInferenceAllowed !== undefined ? (
                <DiagnosticRow label="Context Inference" value={expertMode.contextInferenceAllowed ? "allowed" : "denied"} />
              ) : null}
              {expertMode.probeBudget !== undefined ? (
                <DiagnosticRow label="Probe Budget" value={String(expertMode.probeBudget)} />
              ) : null}
            </div>
          ) : null}
        </ShellCard>
      </div>
    </div>
  );
}

function PersonaField(props: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-2 text-sm text-[color:var(--color-text-secondary)]">
      <span>{props.label}</span>
      <select
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className="agent-select"
      >
        {props.options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function DiagnosticTile(props: {
  icon: ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
      <div className="flex items-center gap-2 text-[color:var(--color-text-faint)]">
        {props.icon}
        <span className="text-xs font-semibold uppercase tracking-[0.18em]">{props.label}</span>
      </div>
      <p className={`mt-3 text-sm text-[color:var(--color-text-primary)] ${props.mono ? "font-mono" : ""}`}>{props.value}</p>
    </div>
  );
}

function DiagnosticRow(props: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3 text-sm">
      <span className="text-[color:var(--color-text-tertiary)]">{props.label}</span>
      <span className="max-w-[60%] truncate text-right text-[color:var(--color-text-primary)]">{props.value}</span>
    </div>
  );
}
