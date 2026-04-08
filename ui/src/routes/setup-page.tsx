import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FridayCommunicationMbti } from "@friday-operator-client";
import { CheckCircle2, MessageCircleMore, Network, PlugZap, ShieldCheck, WandSparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { healthApi } from "@/lib/api/health";
import { providersApi } from "@/lib/api/providers";
import { setupApi } from "@/lib/api/setup";
import { skillsApi } from "@/lib/api/skills";
import { systemApi } from "@/lib/api/system";
import {
  FRIDAY_ASSISTANT_STARTER_TASKS,
  getAssistantStarterTask,
} from "@/lib/assistant/starter-tasks";
import { trackStarterSkillBatch } from "@/lib/skills/starter-skill-telemetry";
import type {
  AuthMode,
  ChannelKind,
  ProviderApi,
  ProviderKind,
  SetupStepId,
} from "@/lib/setup/types";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import {
  buildPersonaPreview,
  COMMUNICATION_MBTI_OPTIONS,
  getMbtiDefaults,
} from "@/lib/persona/communication-persona";

const DEFAULT_CHANNELS: ChannelKind[] = [
  "discord",
  "telegram",
  "slack",
  "webchat",
  "line",
  "irc",
  "signal",
  "qq",
  "lark",
  "feishu",
  "whatsapp",
];

const STARTER_SKILL_EXAMPLES: Record<string, string> = {
  "idea-clarifier": "Clarify this idea and turn it into a concrete first milestone.",
  "implementation-plan-review": "Review this implementation plan before I start coding.",
  "browser-qa-report": "QA this page or app and show me the evidence.",
  "workspace-diff-review": "Review the current changes and call out what is risky.",
  "release-doc-sync": "Sync the release docs for the current workspace changes.",
  "repo-health-check": "Review repo health and tell me the next useful step.",
  "workspace-change-risk-review": "Review the current diff and call out change risk.",
  "release-readiness-check": "Check whether this workspace is ready to ship.",
  "system-health-snapshot": "Capture Friday's current system snapshot and summarize runtime health.",
  "review-open-issues": "Review what Friday has already detected and tell me the top issue to inspect next.",
  "autofix-readiness-review": "Show which planned repairs are approval-gated and which are still safe to inspect.",
  "failed-deploy-recovery-brief": "Summarize the failed deploy and the safest recovery path without executing it.",
  "log-error-triage": "Cluster recurring errors from today's local logs.",
  "local-service-diagnose": "Diagnose the local service on port 3141 and explain what looks wrong.",
  "incident-brief-generator": "Turn these logs and notes into a concise incident brief.",
};

type SetupProviderRecommendation = {
  backend: string;
  auth: string;
  why: string;
  boundary: string;
  operatorNote: string;
};

function getProviderBootstrapRecommendation(kind: ProviderKind): SetupProviderRecommendation {
  switch (kind) {
    case "openai":
      return {
        backend: "HTTP for native tools, Codex CLI later for consumer-plan text work",
        auth: "API key or bearer token",
        why: "OpenAI HTTP is the reliable path when Friday needs native tools, route fallback, and full run evidence.",
        boundary: "ChatGPT / Codex consumer sessions are intentionally attached later as CLI backends, not reused as HTTP OAuth credentials.",
        operatorNote: "Use Settings after setup if you want to attach Codex CLI for text-only review, analysis, or coding assistance.",
      };
    case "anthropic":
      return {
        backend: "HTTP first, Claude CLI optional later",
        auth: "API key, token/setup-token, or OAuth",
        why: "Anthropic HTTP keeps tool-capable runs and verification inside Friday while Claude CLI stays a text-only backend.",
        boundary: "Claude CLI should not be treated as a native-tool backend for runs that require Friday tools.",
        operatorNote: "Attach Claude CLI later in Settings when you want a consumer-plan text route beside the HTTP provider.",
      };
    case "google":
      return {
        backend: "HTTP first, Gemini CLI only if explicitly installed",
        auth: "API key",
        why: "Google HTTP is the stable route for tool-capable work and routing explainability.",
        boundary: "Gemini CLI is optional and environment-dependent; setup does not assume it exists.",
        operatorNote: "If Gemini CLI is installed later, attach it as an external-session backend from Settings.",
      };
    case "ollama":
      return {
        backend: "Local/self-hosted HTTP",
        auth: "None or local token if configured",
        why: "Ollama is the preferred no-egress or local-only route and stays fully explainable inside Friday's HTTP stack.",
        boundary: "Local models trade cost and privacy benefits against capability and latency differences.",
        operatorNote: "Use local-only policies in Settings when you want Ollama to outrank hosted providers for sensitive tasks.",
      };
    case "openai-compatible":
      return {
        backend: "HTTP",
        auth: "API key or bearer token",
        why: "OpenAI-compatible gateways fit Friday's routed HTTP path and keep doctor, explain, and fallback behavior consistent.",
        boundary: "Friday only treats officially compatible HTTP gateways as first-class here; it does not infer hidden consumer OAuth flows.",
        operatorNote: "Add region and no-egress constraints later in Settings if this gateway fronts a local or regional deployment.",
      };
    default:
      return {
        backend: "HTTP",
        auth: "API key",
        why: "HTTP keeps Friday's provider routing, auditing, and explainability intact during setup.",
        boundary: "Specialized backend behavior is added later from Settings if the provider family supports it.",
        operatorNote: "Finish setup with the stable HTTP path first, then attach advanced backends after the shell is healthy.",
      };
  }
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function toneForTemplateTier(tier?: "official" | "verified" | "community" | "experimental"): "success" | "warning" | "neutral" {
  if (tier === "official") return "success";
  if (tier === "verified") return "warning";
  return "neutral";
}

export function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [acknowledgedSecurity, setAcknowledgedSecurity] = useState(false);
  const [providerKind, setProviderKind] = useState<ProviderKind>("openai");
  const [providerName, setProviderName] = useState("");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [providerBaseUrl, setProviderBaseUrl] = useState("");
  const [providerModels, setProviderModels] = useState<string[]>([]);
  const [providerDefaultModel, setProviderDefaultModel] = useState("");
  const [providerApi, setProviderApi] = useState<ProviderApi>("openai-responses");
  const [providerAuthMode, setProviderAuthMode] = useState<AuthMode>("api-key");
  const [providerValidated, setProviderValidated] = useState(false);
  const [networkMode, setNetworkMode] = useState<"local" | "network" | "custom">("local");
  const [networkHost, setNetworkHost] = useState("127.0.0.1");
  const [networkPort, setNetworkPort] = useState("3141");
  const [selectedChannels, setSelectedChannels] = useState<Set<ChannelKind>>(new Set());
  const [communicationMbti, setCommunicationMbti] = useState<FridayCommunicationMbti | "">("");
  const [communicationSaved, setCommunicationSaved] = useState(false);
  const [starterTaskId, setStarterTaskId] = useState(FRIDAY_ASSISTANT_STARTER_TASKS[0]?.id ?? "");

  const { data: setupStatus } = useQuery({
    queryKey: ["setup", "status"],
    queryFn: () => setupApi.getStatus(),
    staleTime: 5_000,
    retry: 0,
  });

  const { data: supportedHealth } = useQuery({
    queryKey: ["setup", "health-capabilities"],
    queryFn: () => healthApi.getHealth(),
    retry: 0,
  });

  const { data: networkConfig } = useQuery({
    queryKey: ["setup", "network"],
    queryFn: () => setupApi.getNetwork(),
    retry: 0,
  });

  const { data: existingProviders = [] } = useQuery({
    queryKey: ["setup", "providers"],
    queryFn: () => providersApi.list(),
    retry: 0,
  });

  const { data: providerTemplates = [] } = useQuery({
    queryKey: ["setup", "provider-templates"],
    queryFn: () => providersApi.listTemplates(),
    retry: 0,
    staleTime: 30_000,
  });

  const { data: persona } = useQuery({
    queryKey: ["setup", "persona"],
    queryFn: () => systemApi.getCommunicationPersona(),
    retry: 0,
  });

  const { data: starterSkills = [] } = useQuery({
    queryKey: ["setup", "starter-skills"],
    queryFn: async () => {
      const skills = await skillsApi.listSkills();
      return skills.filter((skill) => skill.starter);
    },
    retry: 0,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (setupStatus && !setupStatus.needsSetup) {
      navigate("/", { replace: true });
    }
  }, [navigate, setupStatus]);

  useEffect(() => {
    if (!networkConfig) return;
    setNetworkMode(networkConfig.mode);
    setNetworkHost(networkConfig.host);
    setNetworkPort(String(networkConfig.port));
  }, [networkConfig]);

  useEffect(() => {
    if (existingProviders.length === 0) return;
    const first = existingProviders[0];
    setProviderKind(first.kind);
    setProviderName(first.name);
    setProviderBaseUrl(first.baseUrl);
    setProviderApi(first.config.api);
    setProviderAuthMode(first.config.authMode);
    setProviderModels(first.config.supportedModels ?? []);
    setProviderDefaultModel(first.defaultModel ?? first.config.supportedModels[0] ?? "");
    setProviderValidated(true);
  }, [existingProviders]);

  useEffect(() => {
    if (existingProviders.length > 0) return;
    if (providerTemplates.length === 0) return;
    if (providerBaseUrl.trim().length > 0 || providerModels.length > 0) return;
    applyProviderTemplate(providerKind);
  }, [existingProviders.length, providerBaseUrl, providerKind, providerModels.length, providerTemplates]);

  useEffect(() => {
    if (!persona) return;
    setCommunicationMbti(persona.mbti ?? "");
    setCommunicationSaved(true);
  }, [persona]);

  useEffect(() => {
    if (starterSkills.length === 0) return;
    trackStarterSkillBatch("starter_skill_shown", {
      skillIds: starterSkills.map((skill) => skill.skillId),
      source: "setup_preview",
      metadata: { count: starterSkills.length },
    });
  }, [starterSkills]);

  const supportedChannels = useMemo(() => {
    const discovered = supportedHealth?.capabilities?.channels?.supportedKinds ?? [];
    return discovered.length > 0
      ? discovered.filter((kind): kind is ChannelKind => DEFAULT_CHANNELS.includes(kind as ChannelKind))
      : DEFAULT_CHANNELS;
  }, [supportedHealth?.capabilities?.channels?.supportedKinds]);

  const providerRecommendation = useMemo(
    () => getProviderBootstrapRecommendation(providerKind),
    [providerKind],
  );

  const selectedTemplate = useMemo(
    () => providerTemplates.find((template) => template.providerKind === providerKind) ?? null,
    [providerKind, providerTemplates],
  );

  function applyProviderTemplate(templateId: ProviderKind): void {
    const template = providerTemplates.find((item) => item.providerKind === templateId);
    setProviderKind(templateId);
    if (!template) {
      setProviderValidated(false);
      return;
    }
    setProviderName((current) => current.trim().length > 0 ? current : `${template.displayName} Provider`);
    setProviderBaseUrl(template.baseUrlHints[0] ?? "");
    setProviderApi(template.api);
    setProviderAuthMode(template.authModes[0] ?? "api-key");
    const modelExamples = template.modelDefaults.examples ?? [];
    setProviderModels(modelExamples);
    setProviderDefaultModel(
      template.modelDefaults.recommended
        ?? template.modelDefaults.fallback
        ?? modelExamples[0]
        ?? "",
    );
    setProviderValidated(false);
  }

  const detectProviderMutation = useMutation({
    mutationFn: () =>
      setupApi.detectProvider({
        kind: providerKind,
        apiKey: providerApiKey.trim() || undefined,
        baseUrl: providerBaseUrl.trim() || undefined,
      }),
    onSuccess: (result) => {
      setProviderBaseUrl(result.baseUrl);
      setProviderApi(result.api);
      setProviderAuthMode(result.authMode);
      setProviderModels(result.availableModels);
      setProviderDefaultModel(result.defaultModel ?? result.availableModels[0] ?? "");
      setProviderValidated(result.validated);
      if (result.warnings.length > 0) {
        toast.warning(result.warnings.join(" · "));
      } else {
        toast.success(`Detected ${result.kind}`);
      }
    },
    onError: (error) => {
      setProviderValidated(false);
      toast.error(error instanceof Error ? error.message : "Provider detection failed");
    },
  });

  const saveProviderMutation = useMutation({
    mutationFn: async () => {
      const existing = existingProviders[0];
      const commonPayload = {
        name: providerName.trim() || `${titleCase(providerKind)} Provider`,
        baseUrl: providerBaseUrl.trim(),
        authMode: providerAuthMode,
        api: providerApi,
        apiKey: providerApiKey.trim() || undefined,
        supportedModels: providerModels,
        defaultModel: providerDefaultModel.trim() || undefined,
        enabled: true,
      };

      const provider = existing
        ? (await providersApi.update(existing.id, commonPayload)).provider
        : (await providersApi.create({
          kind: providerKind,
          ...commonPayload,
        })).provider;

      await providersApi.setRouting({
        defaultProviderId: provider.id,
        defaultModel: providerDefaultModel.trim() || undefined,
        fallbackProviderIds: [],
      });
    },
    onSuccess: () => {
      toast.success("Provider saved");
      setProviderValidated(true);
      void queryClient.invalidateQueries({ queryKey: ["setup", "providers"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to save provider");
    },
  });

  const saveNetworkMutation = useMutation({
    mutationFn: () =>
      setupApi.saveNetwork({
        mode: networkMode,
        host: networkMode === "custom" ? networkHost.trim() : undefined,
        port: Number.parseInt(networkPort, 10),
      }),
    onSuccess: () => {
      toast.success("Network settings saved");
      void queryClient.invalidateQueries({ queryKey: ["setup", "network"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to save network settings");
    },
  });

  const saveChannelsMutation = useMutation({
    mutationFn: () =>
      setupApi.saveChannels({
        channels: supportedChannels
          .filter((kind) => selectedChannels.has(kind))
          .map((kind) => ({
            kind,
            enabled: true,
            config: {},
          })),
      }),
    onSuccess: () => {
      toast.success("Channel selections saved");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to save channel selections");
    },
  });

  const saveCommunicationMutation = useMutation({
    mutationFn: () => {
      const defaults = getMbtiDefaults(communicationMbti || null);
      return systemApi.updateCommunicationPreferences([
        { category: "communication", key: "persona.mbti", value: communicationMbti || null },
        { category: "communication", key: "persona.tone", value: defaults.tone },
        { category: "communication", key: "persona.verbosity", value: defaults.verbosity },
        { category: "communication", key: "persona.structure", value: defaults.structure },
        { category: "communication", key: "persona.question_style", value: defaults.questionStyle },
        { category: "communication", key: "persona.directness", value: defaults.directness },
        { category: "communication", key: "persona.emoji_style", value: defaults.emojiStyle },
        { category: "communication", key: "persona.jargon_tolerance", value: defaults.jargonTolerance },
        { category: "communication", key: "persona.assumption_style", value: defaults.assumptionStyle },
        { category: "communication", key: "persona.confirmation_style", value: defaults.confirmationStyle },
      ]);
    },
    onSuccess: async () => {
      setCommunicationSaved(true);
      toast.success("Communication style saved");
      await queryClient.invalidateQueries({ queryKey: ["setup", "persona"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to save communication style");
    },
  });

  const completeSetupMutation = useMutation({
    mutationFn: (_selectedStarterTaskId?: string) =>
      {
        const completedSteps: SetupStepId[] = [
          "welcome",
          "security",
          ...(communicationSaved ? (["communication"] as const) : []),
          "network",
          ...(providerValidated ? (["provider"] as const) : []),
          ...(selectedChannels.size > 0 ? (["channels"] as const) : []),
          "done",
        ];
        const skippedSteps: SetupStepId[] = [
          ...(communicationSaved ? [] : (["communication"] as const)),
          ...(providerValidated ? [] : (["provider"] as const)),
          ...(selectedChannels.size > 0 ? [] : (["channels", "skills"] as const)),
        ];
        return setupApi.completeSetup({
          completedSteps,
          skippedSteps,
        });
      },
    onSuccess: async (_data, selectedStarterTaskId) => {
      const starterTask = getAssistantStarterTask(selectedStarterTaskId);
      toast.success("Setup complete");
      await queryClient.invalidateQueries({ queryKey: ["setup", "status"] });
      navigate("/assistant", {
        replace: true,
        state: starterTask
          ? {
            starterTaskId: starterTask.id,
            starterGoal: starterTask.goal,
            starterSource: "setup",
          }
          : undefined,
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to complete setup");
    },
  });

  return (
    <div className="relative min-h-screen bg-[color:var(--color-bg-base)] px-4 py-6 text-[color:var(--color-text-primary)] lg:px-6">
      <div className="pointer-events-none absolute inset-0">
        <div className="agent-grid absolute inset-0 opacity-30" />
        <div className="agent-orb agent-orb-left" />
        <div className="agent-orb agent-orb-right" />
      </div>

      <div className="relative mx-auto flex w-full max-w-[1480px] flex-col gap-4">
        <ShellCard>
          <p className="agent-eyebrow">Friday Agent OS Setup</p>
          <h1 className="font-[var(--font-display)] text-4xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
            Bootstrap the new operator shell
          </h1>
          <p className="mt-4 max-w-4xl text-base leading-7 text-[color:var(--color-text-secondary)]">
            This setup flow has been rebuilt from scratch. It keeps the backend bootstrap APIs intact while removing the previous wizard UI and builder framing.
          </p>
        </ShellCard>

        <div className="grid gap-4 xl:grid-cols-2">
          <ShellCard eyebrow="1. Security" title="Operator acknowledgement">
            <div className="space-y-4">
              <p className="text-sm leading-6 text-[color:var(--color-text-secondary)]">
                Friday Agent OS can request control leases, read local status, and orchestrate risky actions behind explicit approvals. Confirm that you are setting up a single-user local machine.
              </p>
              <label className="inline-flex items-center gap-3 text-sm text-[color:var(--color-text-primary)]">
                <input
                  type="checkbox"
                  checked={acknowledgedSecurity}
                  onChange={(event) => setAcknowledgedSecurity(event.target.checked)}
                  className="rounded border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-surface)]"
                />
                I understand this is a supervised local operator shell, not a full operating system replacement.
              </label>
            </div>
          </ShellCard>

          <ShellCard eyebrow="2. Provider" title="Model bootstrap">
            <div className="space-y-3">
              <select
                value={providerKind}
                onChange={(event) => applyProviderTemplate(event.target.value as ProviderKind)}
                className="agent-select"
              >
                {providerTemplates.length > 0 ? providerTemplates.map((template) => (
                  <option key={template.id} value={template.providerKind}>
                    {template.displayName} ({template.tier})
                  </option>
                )) : (
                  <>
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="google">Google</option>
                    <option value="ollama">Ollama</option>
                    <option value="openai-compatible">OpenAI-compatible</option>
                  </>
                )}
              </select>
              {providerTemplates.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {providerTemplates
                    .filter((template) => template.tier === "official" || template.tier === "verified")
                    .slice(0, 8)
                    .map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        onClick={() => applyProviderTemplate(template.providerKind)}
                        className="rounded-2xl border border-[color:var(--color-border-soft)] px-3 py-2 text-left text-xs text-[color:var(--color-text-secondary)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-text-primary)]"
                        data-active={template.providerKind === providerKind}
                      >
                        <span className="font-medium text-[color:var(--color-text-primary)]">{template.displayName}</span>
                        <span className="ml-2 text-[color:var(--color-text-faint)]">{template.tier}</span>
                      </button>
                    ))}
                </div>
              ) : null}
              <input
                value={providerName}
                onChange={(event) => setProviderName(event.target.value)}
                className="agent-input"
                placeholder="Provider name"
              />
              <input
                value={providerBaseUrl}
                onChange={(event) => setProviderBaseUrl(event.target.value)}
                className="agent-input"
                placeholder="Base URL"
              />
              <input
                value={providerApiKey}
                onChange={(event) => setProviderApiKey(event.target.value)}
                type="password"
                className="agent-input"
                placeholder={selectedTemplate?.requiredSecrets[0]?.label ?? "API key"}
              />
              <div className="flex flex-wrap gap-2">
                <ActionButton tone="secondary" onClick={() => detectProviderMutation.mutate()}>
                  <WandSparkles className="mr-2 h-4 w-4" />
                  Detect
                </ActionButton>
                <ActionButton
                  onClick={() => saveProviderMutation.mutate()}
                  disabled={!providerBaseUrl.trim() || providerModels.length === 0}
                >
                  Save Provider
                </ActionButton>
                <StatusPill tone={providerValidated ? "success" : "neutral"}>
                  {providerValidated ? "validated" : "not validated"}
                </StatusPill>
              </div>
              {providerModels.length > 0 ? (
                <div className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
                    Models
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {providerModels.slice(0, 6).map((model) => (
                      <StatusPill key={model} tone={model === providerDefaultModel ? "success" : "neutral"}>
                        {model}
                      </StatusPill>
                    ))}
                  </div>
                </div>
              ) : null}
              {selectedTemplate ? (
                <div className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">{selectedTemplate.displayName}</p>
                      <p className="text-xs text-[color:var(--color-text-tertiary)]">
                        {selectedTemplate.providerKind} · {selectedTemplate.backendKind} · {selectedTemplate.regionTag}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <StatusPill tone={toneForTemplateTier(selectedTemplate.tier)}>{selectedTemplate.tier}</StatusPill>
                      <StatusPill>{selectedTemplate.status}</StatusPill>
                    </div>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">{selectedTemplate.description}</p>
                  {selectedTemplate.baseUrlHints.length > 0 ? (
                    <p className="mt-2 text-xs text-[color:var(--color-text-faint)]">
                      Base URL hint: {selectedTemplate.baseUrlHints.join(" · ")}
                    </p>
                  ) : (
                    <p className="mt-2 text-xs text-[color:var(--color-text-faint)]">
                      This template needs an explicit base URL before validation.
                    </p>
                  )}
                  {selectedTemplate.reasoningHints.length > 0 ? (
                    <ul className="mt-3 space-y-2 text-xs text-[color:var(--color-text-secondary)]">
                      {selectedTemplate.reasoningHints.slice(0, 2).map((hint) => (
                        <li key={hint}>{hint}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              <div className="rounded-[22px] border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-secondary)]">
                  Recommended backend/auth
                </p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">Backend</p>
                    <p className="mt-1 text-sm font-medium text-[color:var(--color-text-primary)]">{providerRecommendation.backend}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">Auth</p>
                    <p className="mt-1 text-sm font-medium text-[color:var(--color-text-primary)]">{providerRecommendation.auth}</p>
                  </div>
                </div>
                <p className="mt-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">{providerRecommendation.why}</p>
                <p className="mt-3 text-sm leading-6 text-[color:var(--color-text-tertiary)]">{providerRecommendation.boundary}</p>
                <p className="mt-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">{providerRecommendation.operatorNote}</p>
              </div>
            </div>
          </ShellCard>

          <ShellCard eyebrow="3. Network" title="Local bind settings">
            <div className="space-y-3">
              <select
                value={networkMode}
                onChange={(event) => setNetworkMode(event.target.value as "local" | "network" | "custom")}
                className="agent-select"
              >
                <option value="local">Local only</option>
                <option value="network">Local network</option>
                <option value="custom">Custom</option>
              </select>
              <div className="grid gap-3 md:grid-cols-2">
                <input
                  value={networkHost}
                  onChange={(event) => setNetworkHost(event.target.value)}
                  className="agent-input"
                  placeholder="Host"
                  disabled={networkMode !== "custom"}
                />
                <input
                  value={networkPort}
                  onChange={(event) => setNetworkPort(event.target.value)}
                  className="agent-input"
                  placeholder="Port"
                />
              </div>
              <ActionButton onClick={() => saveNetworkMutation.mutate()}>
                <Network className="mr-2 h-4 w-4" />
                Save Network
              </ActionButton>
            </div>
          </ShellCard>

          <ShellCard eyebrow="4. Channels" title="Optional ingress surfaces">
            <div className="space-y-4">
              <p className="text-sm text-[color:var(--color-text-secondary)]">
                Channel setup is optional in phase 1. Select only the kinds you want Friday to persist now.
              </p>
              <div className="flex flex-wrap gap-2">
                {supportedChannels.map((channel) => {
                  const active = selectedChannels.has(channel);
                  return (
                    <button
                      key={channel}
                      type="button"
                      onClick={() => {
                        setSelectedChannels((previous) => {
                          const next = new Set(previous);
                          if (next.has(channel)) next.delete(channel);
                          else next.add(channel);
                          return next;
                        });
                      }}
                      className={`rounded-full border px-3 py-2 text-sm transition ${
                        active
                          ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-text-primary)]"
                          : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] text-[color:var(--color-text-secondary)] hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-text-primary)]"
                      }`}
                    >
                      {titleCase(channel)}
                    </button>
                  );
                })}
              </div>
              <ActionButton tone="secondary" onClick={() => saveChannelsMutation.mutate()}>
                <PlugZap className="mr-2 h-4 w-4" />
                Save Channels
              </ActionButton>
            </div>
          </ShellCard>

          <ShellCard eyebrow="5. Communication" title="How Friday should guide you">
            <div className="space-y-4">
              <p className="text-sm text-[color:var(--color-text-secondary)]">
                Pick a comfort-oriented communication template. You can skip this now and change it later in Settings.
              </p>
              <select
                value={communicationMbti}
                onChange={(event) => {
                  setCommunicationMbti(event.target.value as FridayCommunicationMbti | "");
                  setCommunicationSaved(false);
                }}
                className="agent-select"
              >
                <option value="">Default</option>
                {COMMUNICATION_MBTI_OPTIONS.map((mbti) => (
                  <option key={mbti} value={mbti}>{mbti}</option>
                ))}
              </select>
              <div className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                {(() => {
                  const preview = buildPersonaPreview(getMbtiDefaults(communicationMbti || null));
                  return (
                    <>
                      <div className="flex items-center gap-2 text-[color:var(--color-text-primary)]">
                        <MessageCircleMore className="h-4 w-4" />
                        <span className="font-medium">Preview</span>
                      </div>
                      <p className="mt-3 text-sm text-[color:var(--color-text-tertiary)]">{preview.styleLabel}</p>
                      <p className="mt-3 text-sm text-[color:var(--color-text-primary)]">{preview.sampleClarifier}</p>
                      <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">{preview.sampleBoundary}</p>
                    </>
                  );
                })()}
              </div>
              <div className="flex flex-wrap gap-2">
                <ActionButton tone="secondary" onClick={() => saveCommunicationMutation.mutate()}>
                  <MessageCircleMore className="mr-2 h-4 w-4" />
                  Save Communication Style
                </ActionButton>
                <StatusPill tone={communicationSaved ? "success" : "neutral"}>
                  communication {communicationSaved ? "ready" : "default"}
                </StatusPill>
              </div>
            </div>
          </ShellCard>
        </div>

        <ShellCard eyebrow="6. Starter Pack" title="Bundled skills ship ready">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <div className="space-y-3">
              <p className="text-sm leading-6 text-[color:var(--color-text-secondary)]">
                Friday now ships with a bundled starter pack for local development and diagnostics. These starter skills are already installed, model-invocable, and non-destructive by default.
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {starterSkills.length === 0 ? (
                  <p className="text-sm text-[color:var(--color-text-tertiary)]">Starter pack inventory will appear once the local skill registry is available.</p>
                ) : starterSkills.map((skill) => (
                  <div key={skill.skillId} className="agent-subcard">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{skill.name}</p>
                        <p className="mt-2 text-sm leading-6 text-[color:var(--color-text-secondary)]">{skill.description ?? "Bundled starter skill."}</p>
                      </div>
                      <StatusPill tone="success">starter</StatusPill>
                    </div>
                    <p className="mt-3 text-xs uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">Example</p>
                    <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
                      {STARTER_SKILL_EXAMPLES[skill.skillId] ?? "Run this starter skill from Assistant or Command Center."}
                    </p>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[color:var(--color-text-faint)]">
                Default boundaries
              </p>
              <div className="mt-4 space-y-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">
                <p>Starter skills are role-first: they can clarify ideas, review plans, inspect runtime health, and guide the next safe action without dropping you into a blank builder flow.</p>
                <p>They are bundled with Friday, so there is nothing to install during setup.</p>
                <p>They can clarify ideas, review plans, QA pages, inspect diffs, and sync bounded docs before they reach for heavier automation.</p>
              </div>
            </div>
          </div>
        </ShellCard>

        <ShellCard eyebrow="7. Finish" title="Enter Friday">
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
            <div className="space-y-4">
              <div className="space-y-2 text-sm text-[color:var(--color-text-secondary)]">
                <p>Setup status: {setupStatus?.needsSetup ? "not completed" : "completed"}</p>
                <p>Configured providers: {existingProviders.length}</p>
                <p>Selected channels: {selectedChannels.size}</p>
                <p>Communication style: {communicationSaved ? (communicationMbti || "default") : "default"}</p>
              </div>
              <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[color:var(--color-text-faint)]">
                  Pick a first task
                </p>
                <div className="mt-4 grid gap-3">
                  {FRIDAY_ASSISTANT_STARTER_TASKS.map((task) => {
                    const active = task.id === starterTaskId;
                    return (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => setStarterTaskId(task.id)}
                        className={`text-left transition ${
                          active ? "agent-selection-card ring-1 ring-[color:var(--color-focus-ring)]" : "agent-subcard hover:border-[color:var(--color-border-strong)]"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{task.title}</p>
                            <p className="mt-2 text-sm leading-6 text-[color:var(--color-text-secondary)]">{task.description}</p>
                          </div>
                          <StatusPill tone={active ? "success" : "neutral"}>
                            {active ? "selected" : "recommended"}
                          </StatusPill>
                        </div>
                        <p className="mt-3 text-xs uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">Outcome</p>
                        <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">{task.outcome}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="flex flex-col justify-between gap-4">
              <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[color:var(--color-text-faint)]">
                  What happens next
                </p>
                {(() => {
                  const selectedStarterTask = getAssistantStarterTask(starterTaskId);
                  return selectedStarterTask ? (
                    <div className="mt-4 space-y-3">
                      <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{selectedStarterTask.title}</p>
                      <p className="text-sm leading-6 text-[color:var(--color-text-secondary)]">
                        Friday will open the assistant with a skill-backed first task, so you can use the bundled starter pack immediately instead of starting from a generator flow.
                      </p>
                      <div className="agent-subcard">
                        <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">Goal Friday will start with</p>
                        <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">{selectedStarterTask.goal}</p>
                      </div>
                    </div>
                  ) : null;
                })()}
              </div>
              <div className="flex flex-wrap gap-2">
                <StatusPill tone={acknowledgedSecurity ? "success" : "warning"}>
                  security {acknowledgedSecurity ? "acknowledged" : "pending"}
                </StatusPill>
                <StatusPill tone={providerValidated ? "success" : "neutral"}>
                  provider {providerValidated ? "ready" : "skipped"}
                </StatusPill>
                <ActionButton
                  onClick={() => completeSetupMutation.mutate(starterTaskId)}
                  disabled={!acknowledgedSecurity}
                >
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  Complete Setup And Open Assistant
                </ActionButton>
              </div>
            </div>
          </div>
        </ShellCard>
      </div>
    </div>
  );
}
