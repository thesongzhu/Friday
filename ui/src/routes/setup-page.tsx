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
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
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
  const { locale, setLocale } = useAppLocale();
  const [languageChosen, setLanguageChosen] = useState(false);
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
        toast.success(localize(locale, `已检测到 ${result.kind}`, `Detected ${result.kind}`));
      }
    },
    onError: (error) => {
      setProviderValidated(false);
      toast.error(error instanceof Error ? error.message : localize(locale, "提供方检测失败", "Provider detection failed"));
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
      toast.success(localize(locale, "提供方已保存", "Provider saved"));
      setProviderValidated(true);
      void queryClient.invalidateQueries({ queryKey: ["setup", "providers"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "保存提供方失败", "Failed to save provider"));
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
      toast.success(localize(locale, "网络设置已保存", "Network settings saved"));
      void queryClient.invalidateQueries({ queryKey: ["setup", "network"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "保存网络设置失败", "Failed to save network settings"));
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
      toast.success(localize(locale, "通道选择已保存", "Channel selections saved"));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "保存通道选择失败", "Failed to save channel selections"));
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
      toast.success(localize(locale, "沟通风格已保存", "Communication style saved"));
      await queryClient.invalidateQueries({ queryKey: ["setup", "persona"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "保存沟通风格失败", "Failed to save communication style"));
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
      toast.success(localize(locale, "设置完成", "Setup complete"));
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
      toast.error(error instanceof Error ? error.message : localize(locale, "完成设置失败", "Failed to complete setup"));
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
        {!languageChosen ? (
          <ShellCard>
            <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
              <p className="agent-eyebrow">Friday</p>
              <h1 className="font-[var(--font-display)] text-4xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
                {locale === "zh" ? "选择你的语言" : "Choose Your Language"}
              </h1>
              <p className="mt-3 text-base text-[color:var(--color-text-secondary)]">
                {locale === "zh" ? "你随时可以在设置中更改。" : "You can change this anytime in Settings."}
              </p>
              <div className="mt-8 flex gap-4">
                <button
                  type="button"
                  onClick={() => { setLocale("zh"); setLanguageChosen(true); }}
                  className={`rounded-[28px] border-2 px-8 py-4 text-lg font-medium transition ${locale === "zh" ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-muted)]" : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)]"} text-[color:var(--color-text-primary)] hover:border-[color:var(--color-accent)]`}
                >
                  中文
                </button>
                <button
                  type="button"
                  onClick={() => { setLocale("en"); setLanguageChosen(true); }}
                  className={`rounded-[28px] border-2 px-8 py-4 text-lg font-medium transition ${locale === "en" ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-muted)]" : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)]"} text-[color:var(--color-text-primary)] hover:border-[color:var(--color-accent)]`}
                >
                  English
                </button>
              </div>
            </div>
          </ShellCard>
        ) : (
        <>
        <ShellCard>
          <p className="agent-eyebrow">{localize(locale, "Friday Agent OS 设置", "Friday Agent OS Setup")}</p>
          <h1 className="font-[var(--font-display)] text-4xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
            {locale === "zh" ? "配置你的 Friday" : "Configure your Friday"}
          </h1>
          <p className="mt-4 max-w-4xl text-base leading-7 text-[color:var(--color-text-secondary)]">
            {locale === "zh"
              ? "按顺序完成以下步骤，让 Friday 准备就绪。"
              : "Complete the steps below to get Friday ready."}
          </p>
        </ShellCard>

        <div className="grid gap-4 xl:grid-cols-2">
          <ShellCard eyebrow={locale === "zh" ? "1. 安全" : "1. Security"} title={locale === "zh" ? "操作确认" : "Operator acknowledgement"}>
            <div className="space-y-4">
              <p className="text-sm leading-6 text-[color:var(--color-text-secondary)]">
                {localize(locale, "Friday Agent OS 可以请求控制租约、读取本地状态，并在明确批准后执行高风险操作。请确认你正在配置一台单用户本地机器。", "Friday Agent OS can request control leases, read local status, and orchestrate risky actions behind explicit approvals. Confirm that you are setting up a single-user local machine.")}
              </p>
              <label className="inline-flex items-center gap-3 text-sm text-[color:var(--color-text-primary)]">
                <input
                  type="checkbox"
                  checked={acknowledgedSecurity}
                  onChange={(event) => setAcknowledgedSecurity(event.target.checked)}
                  className="rounded border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-surface)]"
                />
                {localize(locale, "我了解这是一个受监控的本地操作终端，而非完整的操作系统替代品。", "I understand this is a supervised local operator shell, not a full operating system replacement.")}
              </label>
            </div>
          </ShellCard>

          <ShellCard eyebrow={locale === "zh" ? "2. 模型提供方" : "2. Provider"} title={locale === "zh" ? "AI 模型配置" : "Model bootstrap"}>
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
                placeholder={localize(locale, "提供方名称", "Provider name")}
              />
              <input
                value={providerBaseUrl}
                onChange={(event) => setProviderBaseUrl(event.target.value)}
                className="agent-input"
                placeholder={localize(locale, "基础 URL", "Base URL")}
              />
              <input
                value={providerApiKey}
                onChange={(event) => setProviderApiKey(event.target.value)}
                type="password"
                className="agent-input"
                placeholder={selectedTemplate?.requiredSecrets[0]?.label ?? localize(locale, "API 密钥", "API key")}
              />
              <div className="flex flex-wrap gap-2">
                <ActionButton tone="secondary" onClick={() => detectProviderMutation.mutate()}>
                  <WandSparkles className="mr-2 h-4 w-4" />
                  {localize(locale, "检测", "Detect")}
                </ActionButton>
                <ActionButton
                  onClick={() => saveProviderMutation.mutate()}
                  disabled={!providerBaseUrl.trim() || providerModels.length === 0 || saveProviderMutation.isPending}
                >
                  {localize(locale, "保存提供方", "Save Provider")}
                </ActionButton>
                <StatusPill tone={providerValidated ? "success" : "neutral"}>
                  {providerValidated ? localize(locale, "已验证", "validated") : localize(locale, "未验证", "not validated")}
                </StatusPill>
              </div>
              {providerModels.length > 0 ? (
                <div className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
                    {localize(locale, "模型", "Models")}
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
                      {localize(locale, "基础 URL 提示：", "Base URL hint: ")}{selectedTemplate.baseUrlHints.join(" · ")}
                    </p>
                  ) : (
                    <p className="mt-2 text-xs text-[color:var(--color-text-faint)]">
                      {localize(locale, "此模板需要明确的基础 URL 才能进行验证。", "This template needs an explicit base URL before validation.")}
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
                  {localize(locale, "推荐的后端/认证", "Recommended backend/auth")}
                </p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">{localize(locale, "后端", "Backend")}</p>
                    <p className="mt-1 text-sm font-medium text-[color:var(--color-text-primary)]">{providerRecommendation.backend}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">{localize(locale, "认证", "Auth")}</p>
                    <p className="mt-1 text-sm font-medium text-[color:var(--color-text-primary)]">{providerRecommendation.auth}</p>
                  </div>
                </div>
                <p className="mt-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">{providerRecommendation.why}</p>
                <p className="mt-3 text-sm leading-6 text-[color:var(--color-text-tertiary)]">{providerRecommendation.boundary}</p>
                <p className="mt-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">{providerRecommendation.operatorNote}</p>
              </div>
            </div>
          </ShellCard>

          <ShellCard eyebrow={locale === "zh" ? "3. 网络" : "3. Network"} title={locale === "zh" ? "本地绑定设置" : "Local bind settings"}>
            <div className="space-y-3">
              <select
                value={networkMode}
                onChange={(event) => setNetworkMode(event.target.value as "local" | "network" | "custom")}
                className="agent-select"
              >
                <option value="local">{localize(locale, "仅本地", "Local only")}</option>
                <option value="network">{localize(locale, "本地网络", "Local network")}</option>
                <option value="custom">{localize(locale, "自定义", "Custom")}</option>
              </select>
              <div className="grid gap-3 md:grid-cols-2">
                <input
                  value={networkHost}
                  onChange={(event) => setNetworkHost(event.target.value)}
                  className="agent-input"
                  placeholder={localize(locale, "主机", "Host")}
                  disabled={networkMode !== "custom"}
                />
                <input
                  value={networkPort}
                  onChange={(event) => setNetworkPort(event.target.value)}
                  className="agent-input"
                  placeholder={localize(locale, "端口", "Port")}
                />
              </div>
              <ActionButton onClick={() => saveNetworkMutation.mutate()}>
                <Network className="mr-2 h-4 w-4" />
                {localize(locale, "保存网络设置", "Save Network")}
              </ActionButton>
            </div>
          </ShellCard>

          <ShellCard eyebrow={locale === "zh" ? "4. 通道" : "4. Channels"} title={locale === "zh" ? "可选的消息接入" : "Optional ingress surfaces"}>
            <div className="space-y-4">
              <p className="text-sm text-[color:var(--color-text-secondary)]">
                {localize(locale, "通道设置在第一阶段是可选的。仅选择你希望 Friday 现在保留的类型。", "Channel setup is optional in phase 1. Select only the kinds you want Friday to persist now.")}
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
                {localize(locale, "保存通道", "Save Channels")}
              </ActionButton>
            </div>
          </ShellCard>

          <ShellCard eyebrow={locale === "zh" ? "5. 沟通风格" : "5. Communication"} title={locale === "zh" ? "Friday 如何与你交流" : "How Friday should guide you"}>
            <div className="space-y-4">
              <p className="text-sm text-[color:var(--color-text-secondary)]">
                {localize(locale, "选择一个以舒适为导向的沟通模板。你可以暂时跳过，稍后在设置中更改。", "Pick a comfort-oriented communication template. You can skip this now and change it later in Settings.")}
              </p>
              <select
                value={communicationMbti}
                onChange={(event) => {
                  setCommunicationMbti(event.target.value as FridayCommunicationMbti | "");
                  setCommunicationSaved(false);
                }}
                className="agent-select"
              >
                <option value="">{localize(locale, "默认", "Default")}</option>
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
                        <span className="font-medium">{localize(locale, "预览", "Preview")}</span>
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
                  {localize(locale, "保存沟通风格", "Save Communication Style")}
                </ActionButton>
                <StatusPill tone={communicationSaved ? "success" : "neutral"}>
                  {localize(locale, communicationSaved ? "沟通已就绪" : "沟通默认", communicationSaved ? "communication ready" : "communication default")}
                </StatusPill>
              </div>
            </div>
          </ShellCard>
        </div>

        <ShellCard eyebrow={locale === "zh" ? "6. 起步包" : "6. Starter Pack"} title={locale === "zh" ? "内置技能已就绪" : "Bundled skills ship ready"}>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <div className="space-y-3">
              <p className="text-sm leading-6 text-[color:var(--color-text-secondary)]">
                {localize(locale, "Friday 现已内置本地开发和诊断的起步包。这些起步技能已预装，可由模型调用，且默认不具破坏性。", "Friday now ships with a bundled starter pack for local development and diagnostics. These starter skills are already installed, model-invocable, and non-destructive by default.")}
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {starterSkills.length === 0 ? (
                  <p className="text-sm text-[color:var(--color-text-tertiary)]">{localize(locale, "起步包清单将在本地技能注册表可用后显示。", "Starter pack inventory will appear once the local skill registry is available.")}</p>
                ) : starterSkills.map((skill) => (
                  <div key={skill.skillId} className="agent-subcard">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{skill.name}</p>
                        <p className="mt-2 text-sm leading-6 text-[color:var(--color-text-secondary)]">{skill.description ?? localize(locale, "内置起步技能。", "Bundled starter skill.")}</p>
                      </div>
                      <StatusPill tone="success">starter</StatusPill>
                    </div>
                    <p className="mt-3 text-xs uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "示例", "Example")}</p>
                    <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
                      {STARTER_SKILL_EXAMPLES[skill.skillId] ?? localize(locale, "从助手或命令中心运行此起步技能。", "Run this starter skill from Assistant or Command Center.")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[color:var(--color-text-faint)]">
                {localize(locale, "默认边界", "Default boundaries")}
              </p>
              <div className="mt-4 space-y-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">
                <p>{localize(locale, "起步技能以角色为先：它们可以澄清想法、审查计划、检查运行状况，并引导下一步安全操作，而不会让你进入空白的构建流程。", "Starter skills are role-first: they can clarify ideas, review plans, inspect runtime health, and guide the next safe action without dropping you into a blank builder flow.")}</p>
                <p>{localize(locale, "它们与 Friday 捆绑提供，因此在设置过程中无需安装任何内容。", "They are bundled with Friday, so there is nothing to install during setup.")}</p>
                <p>{localize(locale, "它们可以澄清想法、审查计划、QA 页面、检查差异，并在使用更重的自动化之前同步有限范围的文档。", "They can clarify ideas, review plans, QA pages, inspect diffs, and sync bounded docs before they reach for heavier automation.")}</p>
              </div>
            </div>
          </div>
        </ShellCard>

        <ShellCard eyebrow={locale === "zh" ? "7. 完成" : "7. Finish"} title={locale === "zh" ? "进入 Friday" : "Enter Friday"}>
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
            <div className="space-y-4">
              <div className="space-y-2 text-sm text-[color:var(--color-text-secondary)]">
                <p>{localize(locale, "设置状态：", "Setup status: ")}{setupStatus?.needsSetup ? localize(locale, "未完成", "not completed") : localize(locale, "已完成", "completed")}</p>
                <p>{localize(locale, "已配置的提供方：", "Configured providers: ")}{existingProviders.length}</p>
                <p>{localize(locale, "已选通道：", "Selected channels: ")}{selectedChannels.size}</p>
                <p>{localize(locale, "沟通风格：", "Communication style: ")}{communicationSaved ? (communicationMbti || localize(locale, "默认", "default")) : localize(locale, "默认", "default")}</p>
              </div>
              <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[color:var(--color-text-faint)]">
                  {localize(locale, "选择首个任务", "Pick a first task")}
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
                            {active ? localize(locale, "已选", "selected") : localize(locale, "推荐", "recommended")}
                          </StatusPill>
                        </div>
                        <p className="mt-3 text-xs uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "预期结果", "Outcome")}</p>
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
                  {localize(locale, "接下来会发生什么", "What happens next")}
                </p>
                {(() => {
                  const selectedStarterTask = getAssistantStarterTask(starterTaskId);
                  return selectedStarterTask ? (
                    <div className="mt-4 space-y-3">
                      <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{selectedStarterTask.title}</p>
                      <p className="text-sm leading-6 text-[color:var(--color-text-secondary)]">
                        {localize(locale, "Friday 将以一个技能支持的首个任务打开助手，这样你可以立即使用内置起步包，而无需从生成器流程开始。", "Friday will open the assistant with a skill-backed first task, so you can use the bundled starter pack immediately instead of starting from a generator flow.")}
                      </p>
                      <div className="agent-subcard">
                        <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "Friday 将开始的目标", "Goal Friday will start with")}</p>
                        <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">{selectedStarterTask.goal}</p>
                      </div>
                    </div>
                  ) : null;
                })()}
              </div>
              <div className="flex flex-wrap gap-2">
                <StatusPill tone={acknowledgedSecurity ? "success" : "warning"}>
                  {localize(locale, acknowledgedSecurity ? "安全已确认" : "安全待确认", acknowledgedSecurity ? "security acknowledged" : "security pending")}
                </StatusPill>
                <StatusPill tone={providerValidated ? "success" : "neutral"}>
                  {localize(locale, providerValidated ? "提供方已就绪" : "提供方已跳过", providerValidated ? "provider ready" : "provider skipped")}
                </StatusPill>
                <ActionButton
                  onClick={() => completeSetupMutation.mutate(starterTaskId)}
                  disabled={!acknowledgedSecurity}
                >
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  {localize(locale, "完成设置并打开助手", "Complete Setup And Open Assistant")}
                </ActionButton>
              </div>
            </div>
          </div>
        </ShellCard>
        </>
        )}
      </div>
    </div>
  );
}
