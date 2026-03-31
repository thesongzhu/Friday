import { type ReactNode, useEffect, useState } from "react";
import type {
  FridayCommunicationMbti,
  FridayCommunicationEmojiStyle,
  FridayCommunicationJargonTolerance,
  FridayCommunicationPersona,
  FridayCommunicationPersonaSettings,
} from "@friday-operator-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Cpu, DollarSign, KeyRound, MessageCircleMore, Shield, Wifi } from "lucide-react";
import { toast } from "sonner";
import { healthApi } from "@/lib/api/health";
import { providerUsageApi } from "@/lib/api/provider-usage";
import { providersApi } from "@/lib/api/providers";
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

  const preview = buildPersonaPreview(draft.settings);

  return (
    <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
      <div className="space-y-4">
        <ShellCard eyebrow="System Health" title="Diagnostics">
          {health ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <DiagnosticTile icon={<Cpu className="h-4 w-4" />} label="API Status" value={health.status} />
                <DiagnosticTile icon={<Wifi className="h-4 w-4" />} label="Remote Mode" value={health.capabilities?.system?.remoteMode ?? "unavailable"} />
                <DiagnosticTile icon={<Shield className="h-4 w-4" />} label="System Enabled" value={String(Boolean(health.capabilities?.system?.enabled))} />
                <DiagnosticTile icon={<KeyRound className="h-4 w-4" />} label="Uptime" value={`${health.uptime}s`} />
              </div>
              <p className="text-sm text-white/60">
                The web shell reflects the backend truth. If native companion features are missing, this page reports them directly rather than hiding them behind placeholders.
              </p>
            </div>
          ) : (
            <p className="text-sm text-white/60">Loading diagnostics...</p>
          )}
        </ShellCard>

        <ShellCard eyebrow="Identity" title="Operator Access">
          {me ? (
            <div className="space-y-3 text-sm text-white/70">
              <div className="flex items-center justify-between gap-4">
                <span>User</span>
                <span className="font-medium text-white">{me.user.displayName}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span>Role</span>
                <StatusPill>{me.user.role}</StatusPill>
              </div>
              <div>
                <p className="mb-2 text-white/50">Scopes</p>
                <div className="flex flex-wrap gap-2">
                  {me.scopes.map((scope) => (
                    <StatusPill key={scope}>{scope}</StatusPill>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-white/60">Loading identity...</p>
          )}
        </ShellCard>

        <ShellCard eyebrow="Providers" title="Model Routing Basics">
          {providers.length === 0 ? (
            <p className="text-sm text-white/60">No providers configured yet.</p>
          ) : (
            <div className="space-y-3">
              {providers.map((provider) => (
                <div key={provider.id} className="rounded-[22px] border border-white/[0.08] bg-black/20 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-white">{provider.name}</p>
                      <p className="text-xs text-white/50">{provider.kind} · {provider.baseUrl}</p>
                    </div>
                    <StatusPill tone={provider.enabled ? "success" : "neutral"}>
                      {provider.enabled ? "enabled" : "disabled"}
                    </StatusPill>
                  </div>
                  <p className="mt-3 text-sm text-white/60">
                    Default model: {provider.defaultModel ?? provider.config.supportedModels[0] ?? "Not set"}
                  </p>
                </div>
              ))}
            </div>
          )}
        </ShellCard>

        <ShellCard eyebrow="Communication" title="Persona">
          <div className="space-y-4">
            <p className="text-sm text-white/60">
              MBTI is a comfort-oriented starting template. The actual behavior comes from the settings below, and it never weakens safety or approval boundaries.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-2 text-sm text-white/60">
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
            <div className="rounded-[24px] border border-white/10 bg-black/20 p-4">
              <div className="flex items-center gap-2 text-white">
                <MessageCircleMore className="h-4 w-4" />
                <p className="font-medium">Preview</p>
              </div>
              <p className="mt-3 text-sm text-white/50">Style: {preview.styleLabel}</p>
              <p className="mt-3 text-sm text-white/80">{preview.sampleClarifier}</p>
              <p className="mt-3 text-sm text-white/60">{preview.sampleBoundary}</p>
              {persona ? (
                <p className="mt-3 text-xs text-white/40">
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
        <ShellCard eyebrow="Agent OS Session" title="Companion And Permissions">
          {systemSession && systemState ? (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <DiagnosticTile icon={<Cpu className="h-4 w-4" />} label="Workspace Root" value={systemSession.workspaceRoot} mono />
                <DiagnosticTile icon={<Wifi className="h-4 w-4" />} label="Cloud Planning" value={systemSession.cloudPlanningMode} />
                <DiagnosticTile icon={<Shield className="h-4 w-4" />} label="Health" value={systemState.health.status} />
                <DiagnosticTile icon={<KeyRound className="h-4 w-4" />} label="Started" value={formatTimestamp(systemSession.startedAt)} />
              </div>
              <div className="rounded-[24px] border border-white/10 bg-black/20 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-white">Companion bridge</p>
                    <p className="text-sm text-white/50">
                      {systemSession.companion.runtimeKind} · {systemSession.companion.transport.mode} · {systemSession.companion.transport.protocol}
                    </p>
                  </div>
                  <StatusPill tone={toneForStatus(systemSession.health.status)}>
                    {systemSession.health.status}
                  </StatusPill>
                </div>
                <p className="mt-3 text-sm text-white/60">{summarizeHealthReasons(systemSession.health)}</p>
              </div>
              <div className="space-y-3">
                {systemState.permissions.map((permission) => (
                  <div key={permission.id} className="rounded-[22px] border border-white/[0.08] bg-black/20 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-white">{permission.permission}</p>
                        <p className="text-xs text-white/40">{permission.grantInstructions ?? "No extra instructions reported."}</p>
                      </div>
                      <StatusPill tone={toneForStatus(permission.status)}>{permission.status}</StatusPill>
                    </div>
                  </div>
                ))}
                {systemState.permissions.length === 0 ? (
                  <p className="text-sm text-white/60">No desktop permission telemetry is currently available.</p>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="text-sm text-white/60">Agent OS routes are not responding yet.</p>
          )}
        </ShellCard>

        <ShellCard eyebrow="Companion State" title="Desktop Surfaces">
          {systemState ? (
            <div className="space-y-3">
              <DiagnosticRow label="Frontmost App" value={systemState.frontmostAppId ?? "Unknown"} />
              <DiagnosticRow label="Frontmost Window" value={systemState.frontmostWindowId ?? "Unknown"} />
              <DiagnosticRow label="Last Snapshot" value={formatTimestamp(systemState.capturedAt)} />
              <DiagnosticRow label="Active Lease" value={systemState.controlLease?.ownerId ?? "None"} />
              <DiagnosticRow label="Permissions Updated" value={formatTimestamp(systemState.health.updatedAt)} />
            </div>
          ) : (
            <p className="text-sm text-white/60">Waiting for a system snapshot.</p>
          )}
        </ShellCard>

        <ShellCard eyebrow="Token Economy" title="LLM Budget">
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
                <div className={`rounded-2xl border p-3 text-sm ${budgetStatus.state === "over_limit" ? "border-red-500/20 bg-red-500/5 text-red-300" : "border-yellow-500/20 bg-yellow-500/5 text-yellow-300"}`}>
                  {budgetStatus.state === "over_limit"
                    ? "Budget exceeded — Friday will prefer local models (Ollama) until the next billing cycle."
                    : "Approaching budget limit — Friday will prefer cheaper models when possible."}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-white/60">Budget data unavailable.</p>
          )}
        </ShellCard>

        {learnedFacts.length > 0 ? (
          <ShellCard eyebrow="Learning" title="What Friday Knows About You">
            <div className="space-y-3">
              <p className="text-sm text-white/60">
                These are preferences and facts Friday has learned from your interactions.
              </p>
              {learnedFacts.map((fact) => (
                <div key={fact.key} className="rounded-[22px] border border-white/[0.08] bg-black/20 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Brain className="h-3.5 w-3.5 text-white/40" />
                        <p className="text-sm font-medium text-white">{fact.key}</p>
                      </div>
                      <p className="mt-1 text-sm text-white/70">{String(fact.value)}</p>
                    </div>
                    <StatusPill tone={fact.confidence >= 0.7 ? "success" : fact.confidence >= 0.4 ? "warning" : "neutral"}>
                      {(fact.confidence * 100).toFixed(0)}%
                    </StatusPill>
                  </div>
                  <p className="mt-2 text-xs text-white/30">
                    {String(fact.evidenceCount)} evidence · last confirmed {formatTimestamp(fact.lastConfirmedAt)}
                  </p>
                </div>
              ))}
            </div>
          </ShellCard>
        ) : null}
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
    <label className="space-y-2 text-sm text-white/60">
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
    <div className="rounded-[22px] border border-white/[0.08] bg-black/20 p-4">
      <div className="flex items-center gap-2 text-white/40">
        {props.icon}
        <span className="text-xs font-semibold uppercase tracking-[0.18em]">{props.label}</span>
      </div>
      <p className={`mt-3 text-sm text-white ${props.mono ? "font-mono" : ""}`}>{props.value}</p>
    </div>
  );
}

function DiagnosticRow(props: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[22px] border border-white/[0.08] bg-black/20 px-4 py-3 text-sm">
      <span className="text-white/50">{props.label}</span>
      <span className="max-w-[60%] truncate text-right text-white">{props.value}</span>
    </div>
  );
}
