import { type ReactNode, useEffect, useState } from "react";
import type {
  FridayCommunicationMbti,
  FridayCommunicationEmojiStyle,
  FridayCommunicationJargonTolerance,
  FridayCommunicationPersona,
  FridayCommunicationPersonaSettings,
} from "@friday-operator-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, Brain, CheckCircle2, Cpu, DollarSign, ExternalLink, Globe2, KeyRound, MessageCircleMore, RefreshCw, Shield, Sliders, Terminal, Wifi, Wrench } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { localize, type AppLocale } from "@/lib/i18n/localized-text";
import { HIDE_TRUSTED_DEVICE_UI } from "@/lib/feature-flags";
import { useAppLocale } from "@/providers/locale-provider";
import { ChannelConfigForm } from "@/components/core/channel-config-form";
import { DiscoveryPanel } from "@/components/core/discovery-panel";
import { CHANNEL_META } from "@/lib/channels/channel-meta";
import type { ChannelKind } from "@/lib/setup/types";
import { type FridayModelRoutingConfig, type FridayProviderCapabilityHealthState, type FridayProviderKind, type FridayProviderProfile, type FridayRuntimeCapabilityId, type FridayRuntimeCapabilityState, ApiError } from "@/lib/api/types";
import { assistantDiagnosticsApi } from "@/lib/api/assistant-diagnostics";
import { channelsApi } from "@/lib/api/channels";
import { healthApi } from "@/lib/api/health";
import { learningApi } from "@/lib/api/learning";
import { providerUsageApi } from "@/lib/api/provider-usage";
import { providersApi } from "@/lib/api/providers";
import { securityApi } from "@/lib/api/security";
import { systemApi } from "@/lib/api/system";
import { apiClient } from "@/lib/api/client";
import { ShellCard, StatusPill, ActionButton, ConfirmDialog } from "@/components/core/primitives";
import { useUixPreferences } from "@/hooks/use-uix-preferences";
import { systemKeys } from "@/lib/system/query-keys";
import { summarizeHealthReasons } from "@/lib/system/view-models";
import {
  buildPersonaDraft,
  buildPersonaPreview,
  COMMUNICATION_MBTI_OPTIONS,
  getMbtiDefaults,
} from "@/lib/persona/communication-persona";
import {
  defaultConnectionModeForProvider,
  resolveKeyAuthMode,
  supportsKeyConnection,
  supportsUseMyPlan,
  type ProviderConnectionMode,
} from "@/lib/providers/provider-connection";
import {
  classifyFridayProviderDoctorRemediation,
  type FridayProviderDoctorRemediationVerdict,
} from "@/lib/providers/provider-doctor-diagnostics";

type OpenAICodexDeviceOAuthState = {
  status: "idle" | "starting" | "pending" | "completing" | "connected" | "error";
  providerId?: string;
  deviceCodeId?: string;
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: string;
  message?: string;
};

type PendingDefaultProviderChoice = {
  providerId: string;
  providerName: string;
  defaultModel?: string;
};

type LearnedFactBoundary = {
  trustLevel: string;
  memoryBoundary: string;
  evidenceBoundary: string;
  contextUseBoundary: string;
  promptInjectionBoundary: string;
  reviewBoundary: string;
  revocationBoundary: string;
};

type LearnedFact = {
  key: string;
  value: unknown;
  confidence: number;
  evidenceCount: number;
  lastConfirmedAt: string;
  boundary?: LearnedFactBoundary;
};

type RoutingCostMode = NonNullable<FridayModelRoutingConfig["costMode"]>;

const ROUTING_COST_MODE_OPTIONS: readonly RoutingCostMode[] = [
  "frugal",
  "standard",
  "strict",
];

function routingCostModeLabel(mode: RoutingCostMode, locale: AppLocale): string {
  if (mode === "frugal") return localize(locale, "省钱", "Frugal");
  if (mode === "strict") return localize(locale, "严格", "Strict");
  return localize(locale, "标准", "Standard");
}

function learnedFactBoundaryDetails(fact: LearnedFact, locale: AppLocale): Array<{ label: string; value: string }> {
  const boundary = fact.boundary;
  return [
    {
      label: localize(locale, "记忆", "Memory"),
      value: boundary?.memoryBoundary === "separate_from_durable_memory"
        ? localize(locale, "独立于显式 Memory", "separate from explicit Memory")
        : boundary?.memoryBoundary ?? localize(locale, "边界未知", "boundary unknown"),
    },
    {
      label: localize(locale, "Prompt", "Prompt"),
      value: boundary?.promptInjectionBoundary === "not_direct_prompt_injection"
        ? localize(locale, "不直接注入", "not direct injection")
        : boundary?.promptInjectionBoundary ?? localize(locale, "边界未知", "boundary unknown"),
    },
    {
      label: localize(locale, "审核", "Review"),
      value: boundary?.reviewBoundary === "review_center_confirmed"
        ? localize(locale, "已由 Review Center 确认", "Review Center confirmed")
        : boundary?.reviewBoundary === "not_review_center_confirmed"
          ? localize(locale, "未由 Review Center 确认", "not Review Center confirmed")
          : boundary?.reviewBoundary ?? localize(locale, "边界未知", "boundary unknown"),
    },
    {
      label: localize(locale, "撤销", "Revoke"),
      value: boundary?.revocationBoundary === "clear_delete_or_synthetic_memory_delete"
        ? localize(locale, "可清除或删除", "clear or delete available")
        : boundary?.revocationBoundary ?? localize(locale, "边界未知", "boundary unknown"),
    },
  ];
}

function formatTimestamp(value?: string): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function resolveFirstSupportedModel(provider: {
  config: {
    supportedModels?: string[];
  };
}): string | undefined {
  return provider.config.supportedModels?.find((model) => typeof model === "string" && model.trim().length > 0);
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

function describeFridayProviderDoctorRemediation(
  verdict: FridayProviderDoctorRemediationVerdict,
  locale: AppLocale,
): { title: string; hint: string } | null {
  switch (verdict) {
    case "healthy":
      return null;
    case "provider_disabled":
      return {
        title: localize(locale, "Provider 已停用", "Provider is disabled"),
        hint: localize(locale, "启用此 provider 才能继续路由。", "Enable this provider before it can route."),
      };
    case "cli_problem":
      return {
        title: localize(locale, "CLI 会话问题", "CLI session problem"),
        hint: localize(
          locale,
          "CLI 后端尚未配置或会话已过期。请重新登录或检查 CLI 配置。",
          "The CLI backend is not configured or its session has expired. Re-login or check the CLI configuration.",
        ),
      };
    case "oauth_reauth_required":
      return {
        title: localize(locale, "OAuth 需要重新授权", "OAuth re-authorization required"),
        hint: localize(
          locale,
          "请通过 OAuth 流程重新连接此 provider。",
          "Reconnect this provider through the OAuth flow.",
        ),
      };
    case "credential_problem":
      return {
        title: localize(locale, "凭据问题", "Credential problem"),
        hint: localize(
          locale,
          "API 密钥或环境变量似乎无效或缺失。请重新输入或设置环境变量。",
          "The API key or environment variable appears invalid or missing. Re-enter the key or set the environment variable.",
        ),
      };
    case "payment_required":
      return {
        title: localize(locale, "账户或验证需关注", "Account or validation needs attention"),
        hint: localize(
          locale,
          "此 provider 当前不可路由。详情请通过 provider doctor 查看。",
          "This provider is currently not routable. Check the provider doctor for details.",
        ),
      };
    case "connectivity_problem":
      return {
        title: localize(locale, "连接问题", "Connectivity problem"),
        hint: localize(
          locale,
          "无法到达此 provider。请检查 baseURL 与网络。",
          "Cannot reach this provider. Check the baseURL and network connectivity.",
        ),
      };
    case "model_problem":
      return {
        title: localize(locale, "模型问题", "Model problem"),
        hint: localize(
          locale,
          "所选模型不可用或可用模型列表为空。请检查 model 配置。",
          "The selected model is not ready, or the supported-model list is empty. Check the model configuration.",
        ),
      };
    case "unverified_or_unknown":
      return {
        title: localize(locale, "尚未验证", "Not yet verified"),
        hint: localize(
          locale,
          "此 provider 还未通过 doctor 验证。请运行 validate 或 doctor。",
          "This provider has not passed doctor validation yet. Run validate or doctor.",
        ),
      };
    case "out_of_scope_health":
      return {
        title: localize(locale, "健康降级", "Health degraded"),
        hint: localize(
          locale,
          "后端或认证状态非健康，但未匹配到具体修复项。请通过 provider doctor 进一步排查。",
          "Backend or auth health is degraded but no specific remediation matched. Investigate via the provider doctor.",
        ),
      };
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
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

function toneForCapabilityState(value: FridayRuntimeCapabilityState): "neutral" | "success" | "warning" | "danger" {
  if (value === "available") return "success";
  if (value === "configured_but_unverified" || value === "installable_with_approval" || value === "buildable_with_approval") return "warning";
  if (value === "failed_verification" || value === "needs_user_auth") return "danger";
  return "neutral";
}

function toneForProviderCapabilityHealthState(
  value: FridayProviderCapabilityHealthState,
): "neutral" | "success" | "warning" | "danger" {
  if (value === "available") return "success";
  if (value === "proof_pending" || value === "setup_needed") return "warning";
  if (value === "disabled" || value === "unsupported") return "neutral";
  return "neutral";
}

function labelForProviderCapabilityHealthState(
  locale: AppLocale,
  value: FridayProviderCapabilityHealthState,
): string {
  const labels: Record<FridayProviderCapabilityHealthState, string> = {
    available: localize(locale, "可用", "available"),
    setup_needed: localize(locale, "需配置", "setup needed"),
    proof_pending: localize(locale, "待证明", "proof pending"),
    disabled: localize(locale, "已停用", "disabled"),
    unsupported: localize(locale, "不支持", "unsupported"),
  };
  return labels[value];
}

function labelForCapabilityState(locale: AppLocale, value: FridayRuntimeCapabilityState): string {
  const labels: Record<FridayRuntimeCapabilityState, string> = {
    available: localize(locale, "可用", "available"),
    configured_but_unverified: localize(locale, "待验证", "unverified"),
    needs_user_auth: localize(locale, "需配置", "needs setup"),
    installable_with_approval: localize(locale, "可安装", "installable"),
    buildable_with_approval: localize(locale, "可生成", "buildable"),
    unsupported: localize(locale, "不支持", "unsupported"),
    failed_verification: localize(locale, "验证失败", "failed"),
  };
  return labels[value];
}

function resolveMacPermissionSettingsUrl(permission: string): string {
  switch (permission) {
    case "screen_recording":
      return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
    case "input_monitoring":
      return "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent";
    case "automation":
      return "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";
    default:
      return "x-apple.systempreferences:com.apple.preference.security";
  }
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

interface GuideLensState {
  preferences: {
    enabled: boolean;
    triggerPolicy: "manual" | "confirm_first" | "trusted_context_auto";
    defaultSurface: string;
    parserProvider: string;
    chatboxPolicy: string;
    avatar: {
      kind: "default_f" | "profile_image" | "local_image";
      imageUrl?: string;
      localPath?: string;
      initials?: string;
      sizePx: number;
    };
  };
  activeSession?: {
    status: string;
    surface: string;
  };
}

export function SettingsPage() {
  const { locale } = useAppLocale();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => buildPersonaDraft());
  const [connectProviderKind, setConnectProviderKind] = useState<FridayProviderKind>("openai-codex");
  const [connectMode, setConnectMode] = useState<ProviderConnectionMode>("use-my-plan");
  const [connectApiKey, setConnectApiKey] = useState("");
  const [connectOAuth, setConnectOAuth] = useState<OpenAICodexDeviceOAuthState>({ status: "idle" });
  const [pendingDefaultProviderChoice, setPendingDefaultProviderChoice] = useState<PendingDefaultProviderChoice | null>(null);
  const [routingUpdatePending, setRoutingUpdatePending] = useState(false);

  const { data: health } = useQuery({
    queryKey: ["settings", "health"],
    queryFn: () => healthApi.getCapabilityHealth(),
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

  const { data: providerCapabilityHealth = [] } = useQuery({
    queryKey: ["settings", "provider-capability-health"],
    queryFn: () => providersApi.listCapabilityHealth(),
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

  const { data: guideLensState } = useQuery({
    queryKey: ["settings", "guide-lens"],
    queryFn: () => apiClient.get<GuideLensState>("/v1/guide-lens/state"),
    retry: 0,
    refetchInterval: 15_000,
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
      const data = await apiClient.get<{ items: LearnedFact[] }>("/v1/uix/learned-facts");
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
  const selectedProviderHealth = providerHealth.find((item) => item.providerId === selectedProviderId);
  const { data: routingExplain } = useQuery({
    queryKey: ["settings", "routing-explain", selectedProviderId],
    enabled: Boolean(selectedProviderId) && selectedProviderHealth?.routingEligible === true,
    queryFn: () => providersApi.explainRouting({
      requestedProviderId: selectedProviderId,
      taskProfileId: "review",
      estimatedInputTokens: 1200,
      complexity: "medium",
      requiresNativeTools: true,
    }),
    retry: 0,
  });

  const connectTemplate = providerTemplates.find((item) => item.providerKind === connectProviderKind) ?? null;
  const connectUseMyPlanAvailable = supportsUseMyPlan(connectProviderKind, connectTemplate);
  const connectKeyAvailable = supportsKeyConnection(connectTemplate);
  const connectIsUseMyPlan = connectMode === "use-my-plan" && connectUseMyPlanAvailable;
  const connectProviderDisplayName = connectTemplate?.displayName ?? connectProviderKind;
  const connectProviderModels = connectTemplate?.modelDefaults.examples ?? [];
  const connectProviderDefaultModel =
    connectTemplate?.modelDefaults.recommended
      ?? connectTemplate?.modelDefaults.fallback
      ?? connectProviderModels[0];

  function selectConnectProviderKind(kind: FridayProviderKind): void {
    const template = providerTemplates.find((item) => item.providerKind === kind) ?? null;
    setConnectProviderKind(kind);
    setConnectMode(defaultConnectionModeForProvider(kind, template));
    setConnectApiKey("");
    setConnectOAuth({ status: "idle" });
  }

  function selectConnectMode(mode: ProviderConnectionMode): void {
    setConnectMode(mode);
    setConnectOAuth({ status: "idle" });
  }

  async function refreshProviderQueries(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["settings", "providers"] }),
      queryClient.invalidateQueries({ queryKey: ["settings", "provider-health"] }),
      queryClient.invalidateQueries({ queryKey: ["settings", "provider-capability-health"] }),
      queryClient.invalidateQueries({ queryKey: ["settings", "routing-config"] }),
      queryClient.invalidateQueries({ queryKey: ["settings", "routing-explain"] }),
      queryClient.invalidateQueries({ queryKey: ["shell", "provider-truth"] }),
    ]);
  }

  async function setProviderAsDefault(providerId: string, defaultModel?: string): Promise<void> {
    setRoutingUpdatePending(true);
    try {
      await providersApi.setRouting({
        defaultProviderId: providerId,
        defaultModel,
        fallbackProviderIds: (routingConfig?.fallbackProviderIds ?? []).filter((id) => id !== providerId),
        costMode: routingConfig?.costMode ?? "standard",
        enforceRequestedModel: routingConfig?.enforceRequestedModel,
      });
      await refreshProviderQueries();
      toast.success(localize(locale, "默认模型提供方已更新", "Default model provider updated"));
    } finally {
      setRoutingUpdatePending(false);
    }
  }

  async function promptOrSetDefaultProvider(input: PendingDefaultProviderChoice): Promise<void> {
    if (routingConfig?.defaultProviderId && routingConfig.defaultProviderId !== input.providerId) {
      setPendingDefaultProviderChoice(input);
      return;
    }
    await setProviderAsDefault(input.providerId, input.defaultModel);
  }

  function findReusableOpenAICodexOAuthProvider(): FridayProviderProfile | undefined {
    const routed = providers.find((provider) =>
      provider.id === routingConfig?.defaultProviderId
      && provider.kind === "openai-codex"
      && provider.config.authMode === "oauth"
    );
    if (routed) return routed;
    return providers.find((provider) =>
      provider.kind === "openai-codex" && provider.config.authMode === "oauth"
    );
  }

  async function startOpenAICodexDeviceOAuth(providerId?: string): Promise<void> {
    setConnectOAuth({ status: "starting", providerId });
    try {
      const oauth = await providersApi.initiateOpenAICodexDeviceOAuth(providerId ?? findReusableOpenAICodexOAuthProvider()?.id);
      setConnectProviderKind("openai-codex");
      setConnectMode("use-my-plan");
      setConnectOAuth({
        status: "pending",
        providerId: oauth.providerId,
        deviceCodeId: oauth.deviceCodeId,
        verificationUrl: oauth.verificationUrl,
        userCode: oauth.userCode,
        expiresAt: oauth.expiresAt,
      });
      window.open(oauth.verificationUrl, "_blank", "noopener,noreferrer");
      toast.success(localize(locale, "请在浏览器中完成 OpenAI 授权", "Complete OpenAI authorization in your browser"));
    } catch (error) {
      const message = error instanceof Error ? error.message : localize(locale, "无法启动 OpenAI 授权", "Could not start OpenAI authorization");
      setConnectOAuth({ status: "error", providerId, message });
      toast.error(message);
    }
  }

  async function completeOpenAICodexDeviceOAuth(): Promise<void> {
    if (!connectOAuth.deviceCodeId) {
      toast.error(localize(locale, "请先开始 OpenAI 授权", "Start OpenAI authorization first"));
      return;
    }
    setConnectOAuth((current) => ({ ...current, status: "completing", message: undefined }));
    try {
      const oauth = await providersApi.completeOpenAICodexDeviceOAuth({
        providerId: connectOAuth.providerId,
        deviceCodeId: connectOAuth.deviceCodeId,
      });
      const provider = providers.find((item) => item.id === oauth.providerId);
      setConnectOAuth({
        status: "connected",
        providerId: oauth.providerId,
        deviceCodeId: connectOAuth.deviceCodeId,
        verificationUrl: connectOAuth.verificationUrl,
        userCode: connectOAuth.userCode,
        expiresAt: oauth.expiresAt,
      });
      await refreshProviderQueries();
      await promptOrSetDefaultProvider({
        providerId: oauth.providerId,
        providerName: provider?.name ?? "OpenAI Codex",
        defaultModel: provider?.defaultModel ?? connectProviderDefaultModel,
      });
      toast.success(localize(locale, "OpenAI 账号已连接", "OpenAI account connected"));
    } catch (error) {
      const message = error instanceof Error ? error.message : localize(locale, "OpenAI 授权未完成", "OpenAI authorization is not complete yet");
      setConnectOAuth((current) => ({ ...current, status: "error", message }));
      toast.error(message);
    }
  }

  async function saveApiKeyProviderFromSettings(): Promise<void> {
    if (!connectApiKey.trim()) {
      toast.error(localize(locale, "请先输入 API 密钥", "Enter an API key first"));
      return;
    }
    if (!connectTemplate) {
      toast.error(localize(locale, "请选择有效提供方", "Choose a valid provider"));
      return;
    }

    const authMode = resolveKeyAuthMode(connectTemplate);
    const existing = providers.find((provider) =>
      provider.kind === connectProviderKind && provider.config.authMode !== "oauth"
    );
    const payload = {
      name: existing?.name ?? `${connectProviderDisplayName} Provider`,
      baseUrl: connectTemplate.baseUrlHints[0] ?? "",
      authMode,
      api: connectTemplate.api,
      apiKey: connectApiKey.trim(),
      supportedModels: connectProviderModels,
      defaultModel: connectProviderDefaultModel,
      enabled: true,
      validateOnSave: true,
    };
    const response = existing
      ? await providersApi.update(existing.id, payload)
      : await providersApi.create({ kind: connectProviderKind, ...payload });

    setConnectApiKey("");
    await refreshProviderQueries();
    await promptOrSetDefaultProvider({
      providerId: response.provider.id,
      providerName: response.provider.name,
      defaultModel: response.provider.defaultModel ?? connectProviderDefaultModel,
    });
    toast.success(localize(locale, "提供方已保存", "Provider saved"));
  }

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
      toast.success(localize(locale, "路由已固定", "Route pinned"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings", "routing-explain"] }),
        queryClient.invalidateQueries({ queryKey: ["settings", "learning-overview"] }),
      ]);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法固定路由", "Could not pin route"));
    },
  });

  const clearPenaltyMutation = useMutation({
    mutationFn: (input: { providerId: string; model: string; backendKind: "http" | "cli" | "sdk"; taskProfileId?: string }) =>
      providersApi.clearRoutePenalty(input),
    onSuccess: async () => {
      toast.success(localize(locale, "路由惩罚已清除", "Route penalty cleared"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings", "routing-explain"] }),
        queryClient.invalidateQueries({ queryKey: ["settings", "learning-overview"] }),
      ]);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法清除路由惩罚", "Could not clear route penalty"));
    },
  });

  const routingCostModeMutation = useMutation({
    mutationFn: (costMode: RoutingCostMode) => {
      const defaultProviderId = routingConfig?.defaultProviderId;
      if (!defaultProviderId) {
        throw new Error(localize(locale, "请先配置默认模型提供方", "Configure a default model provider first"));
      }
      return providersApi.setRouting({
        defaultProviderId,
        defaultModel: routingConfig?.defaultModel,
        fallbackProviderIds: routingConfig?.fallbackProviderIds ?? [],
        costMode,
        enforceRequestedModel: routingConfig?.enforceRequestedModel,
      });
    },
    onSuccess: async () => {
      toast.success(localize(locale, "路由模式已更新", "Routing mode updated"));
      await refreshProviderQueries();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法更新路由模式", "Could not update routing mode"));
    },
  });

  // B7 / FRI-AUD-012/013/014/017 minimal UI lane-truth surface: after the
  // operator runs a capability doctor probe, surface per-provider per-lane
  // failure advisories in the provider settings card. Backend doctor-probe
  // already returns lane-specific truth-labels (Ollama embeddings not wired,
  // Codex subscription has no embeddings, Google Generative AI runtime not
  // wired, etc.) — we just stop throwing that data away in favor of a
  // toast count. The global provider pill semantics are unchanged. The
  // advisory only appears for lanes whose status !== "verified".
  // The persisted capability-health dashboard below is backend-snapshot
  // driven; this transient map only keeps the latest just-ran doctor output
  // visible before query invalidation completes.
  type ProviderLaneAdvisory = {
    capability: FridayRuntimeCapabilityId;
    status: "verified" | "declared" | "failed" | "unsupported";
    message: string;
    checkedAt: string;
  };
  const [capabilityLaneResultsByProvider, setCapabilityLaneResultsByProvider] = useState<
    Record<string, ProviderLaneAdvisory[]>
  >({});

  const capabilityDoctorMutation = useMutation({
    mutationFn: () => providersApi.runCapabilityDoctor(),
    onSuccess: async (result) => {
      toast.success(localize(
        locale,
        `能力检查完成：${result.providerValidations.length} 个提供方、${result.capabilityResults.length} 项能力已检查`,
        `Capability doctor completed: ${result.providerValidations.length} provider(s), ${result.capabilityResults.length} capability probe(s) checked`,
      ));
      // B7 capture: group per-provider so the provider card can render
      // lane-specific advisories. Replace any prior result for a probed
      // provider; leave unprobed providers' prior results untouched.
      const grouped: Record<string, ProviderLaneAdvisory[]> = {};
      for (const r of result.capabilityResults) {
        if (!grouped[r.providerId]) grouped[r.providerId] = [];
        grouped[r.providerId]!.push({
          capability: r.capability,
          status: r.status,
          message: r.message,
          checkedAt: r.checkedAt,
        });
      }
      setCapabilityLaneResultsByProvider((prev) => ({ ...prev, ...grouped }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings", "health"] }),
        queryClient.invalidateQueries({ queryKey: ["settings", "providers"] }),
        queryClient.invalidateQueries({ queryKey: ["settings", "provider-health"] }),
        queryClient.invalidateQueries({ queryKey: ["settings", "provider-capability-health"] }),
      ]);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "能力检查失败", "Capability doctor failed"));
    },
  });

  const validateMutation = useMutation({
    mutationFn: (providerId: string) => providersApi.validate(providerId),
    onSuccess: async (validation) => {
      // Toast outcome is driven by the returned validation.status, not by
      // HTTP success alone. The backend returns 2xx + status="failed" when
      // the credential resolves but the provider rejects it; that path
      // must surface as a failure, not a success.
      if (validation.status === "ok") {
        toast.success(localize(locale, "验证通过", "Validation passed"));
      } else if (validation.status === "failed") {
        const code = validation.errorCode ?? "VALIDATION_FAILED";
        toast.error(localize(locale, `验证失败:${code}`, `Validation failed: ${code}`));
      } else {
        // status === "never" or any future value: stay neutral, never imply pass.
        toast(localize(locale, "验证已完成", "Validation complete"));
      }
      await refreshProviderQueries();
    },
    onError: (error) => {
      // Do NOT echo error.message or validation.errorMessage — those may
      // contain provider/network response text. Only surface the structured
      // ApiError.code when available, otherwise a fixed generic copy.
      const code = error instanceof ApiError ? error.code : "UNKNOWN_ERROR";
      toast.error(localize(locale, `验证请求失败:${code}`, `Validate request failed: ${code}`));
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
      toast.success(localize(locale, "经验已更新", "Lesson updated"));
      await queryClient.invalidateQueries({ queryKey: ["settings", "learning-overview"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法更新经验", "Could not update lesson"));
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
      toast.success(localize(locale, "模式已降级", "Pattern demoted"));
      await queryClient.invalidateQueries({ queryKey: ["settings", "learning-overview"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法降级模式", "Could not demote pattern"));
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
      toast.success(localize(locale, "沟通偏好已保存", "Communication preferences saved"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: systemKeys.communicationPersona() }),
        queryClient.invalidateQueries({ queryKey: systemKeys.communicationPreferences() }),
      ]);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "保存沟通设置失败", "Failed to save communication settings"));
    },
  });

  const updatePolicyMutation = useMutation({
    mutationFn: (patch: { paused?: boolean; autoApplyLowRisk?: boolean; cooldownMinutes?: number }) =>
      systemApi.updateAgentLoopPolicy(patch),
    onSuccess: () => {
      toast.success(localize(locale, "Agent 循环策略已更新。", "Agent loop policy updated."));
      void queryClient.invalidateQueries({ queryKey: systemKeys.agentLoopPolicy() });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法更新策略。", "Could not update policy."));
    },
  });

  const updateGuideLensPreferencesMutation = useMutation({
    mutationFn: (patch: Partial<GuideLensState["preferences"]>) =>
      apiClient.patch<Partial<GuideLensState["preferences"]>, GuideLensState["preferences"]>("/v1/guide-lens/preferences", patch),
    onSuccess: async () => {
      toast.success(localize(locale, "引导模式已更新", "Guide Mode updated"));
      await queryClient.invalidateQueries({ queryKey: ["settings", "guide-lens"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法更新引导模式", "Could not update Guide Mode"));
    },
  });

  const updateGuideLensAvatarMutation = useMutation({
    mutationFn: (avatar: Partial<GuideLensState["preferences"]["avatar"]>) =>
      apiClient.post<Partial<GuideLensState["preferences"]["avatar"]>, GuideLensState["preferences"]["avatar"]>("/v1/guide-lens/avatar", avatar),
    onSuccess: async () => {
      toast.success(localize(locale, "引导头像已更新", "Guide avatar updated"));
      await queryClient.invalidateQueries({ queryKey: ["settings", "guide-lens"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法更新引导头像", "Could not update guide avatar"));
    },
  });

  const toggleExpertMutation = useMutation({
    mutationFn: (enabled: boolean) => systemApi.updateAgentLoopExpertMode({ enabled }),
    onSuccess: (result) => {
      toast.success(result.enabled ? localize(locale, "专家模式已启用", "Expert mode enabled") : localize(locale, "专家模式已禁用", "Expert mode disabled"));
      void queryClient.invalidateQueries({ queryKey: systemKeys.agentLoopExpertMode() });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法切换专家模式。", "Could not toggle expert mode."));
    },
  });

  const openPermissionSettingsMutation = useMutation({
    mutationFn: (permission: string) =>
      systemApi.executeIntent({
        action: "open_url",
        actorId: "settings-page",
        actorKind: "api",
        reason: `Open macOS settings for ${permission}`,
        url: resolveMacPermissionSettingsUrl(permission),
      }),
    onSuccess: (result) => {
      toast.success(result.message);
      void queryClient.invalidateQueries({ queryKey: systemKeys.state() });
      void queryClient.invalidateQueries({ queryKey: systemKeys.session() });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法打开系统设置。", "Could not open System Settings."));
    },
  });

  const preview = buildPersonaPreview(draft.settings, locale, draft.mbti || null);
  const mcpStates = assistantDiagnostics?.mcpServerStates ?? [];
  const loadedMcpCount = mcpStates.filter((state) => state.state === "loaded").length;
  const connectedChannelCount = channels.filter((channel) => channel.health.state === "connected").length;
  const channelAttentionCount = channels.filter((channel) =>
    channel.health.state === "error"
    || channel.health.credentialStatus === "missing"
    || channel.health.credentialStatus === "invalid"
    || Boolean(channel.health.blockedReason),
  ).length;
  const runtimeMatrix = health?.capabilities?.runtime;

  return (
    <div className="space-y-6">
      {/* ── Advanced Ops quick links ── */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Link to="/command-center" className="group flex flex-col justify-between rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-5 transition hover:border-[color:var(--color-border-strong)] hover:shadow-[var(--shadow-card-hover)]">
          <div className="flex items-center gap-2.5 text-[color:var(--color-text-secondary)]">
            <Terminal className="h-4 w-4 shrink-0" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">{localize(locale, "操作控制台", "Operator Console")}</span>
          </div>
          <p className="mt-4 text-[13px] leading-relaxed text-[color:var(--color-text-secondary)]">
            {localize(locale, "审批、系统控制与运行态快照", "Approvals, system controls, and runtime snapshots")}
          </p>
        </Link>
        <Link to="/observability" className="group flex flex-col justify-between rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-5 transition hover:border-[color:var(--color-border-strong)] hover:shadow-[var(--shadow-card-hover)]">
          <div className="flex items-center gap-2.5 text-[color:var(--color-text-secondary)]">
            <Activity className="h-4 w-4 shrink-0" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">{localize(locale, "可观测性", "Observability")}</span>
          </div>
          <p className="mt-4 text-[13px] leading-relaxed text-[color:var(--color-text-secondary)]">
            {localize(locale, "Trace、审计、告警、健康", "Traces, audit, alerts, health")}
          </p>
        </Link>
        <Link to="/fleet" className="group flex flex-col justify-between rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-5 transition hover:border-[color:var(--color-border-strong)] hover:shadow-[var(--shadow-card-hover)]">
          <div className="flex items-center gap-2.5 text-[color:var(--color-text-secondary)]">
            <Globe2 className="h-4 w-4 shrink-0" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">{localize(locale, "执行节点", "Fleet")}</span>
          </div>
          <p className="mt-4 text-[13px] leading-relaxed text-[color:var(--color-text-secondary)]">
            {localize(locale, "节点管理、任务放置、分布式执行", "Node management, placement, distributed execution")}
          </p>
        </Link>
      </div>

      {/* ── Program Discovery ── */}
      <DiscoveryPanel />

      <div className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-4 text-sm text-[color:var(--color-text-secondary)]">
        {localize(
          locale,
          "这个页面混合了 operator-only、环境依赖和仅当前机器可见的状态。空卡片、降级或未配置不代表 Friday 对所有用户都可用或不可用，只代表当前 runtime 的真实快照。",
          "This page mixes operator-only, env-gated, and machine-local surfaces. Empty cards, degraded states, or missing config describe the current runtime snapshot only; they are not universal product promises.",
        )}
      </div>

    <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
      <div className="space-y-4">
        <ShellCard eyebrow={localize(locale, "系统健康", "System Health")} title={localize(locale, "诊断", "Diagnostics")}>
          {health ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <DiagnosticTile icon={<Cpu className="h-4 w-4" />} label={localize(locale, "API 状态", "API Status")} value={health.status} />
                {HIDE_TRUSTED_DEVICE_UI ? null : (
                  <DiagnosticTile icon={<Wifi className="h-4 w-4" />} label={localize(locale, "远程模式", "Remote Mode")} value={health.capabilities?.system?.remoteMode ?? localize(locale, "待连接", "waiting")} />
                )}
                <DiagnosticTile icon={<Shield className="h-4 w-4" />} label={localize(locale, "系统已启用", "System Enabled")} value={String(Boolean(health.capabilities?.system?.enabled))} />
                <DiagnosticTile icon={<KeyRound className="h-4 w-4" />} label={localize(locale, "运行时间", "Uptime")} value={`${health.uptime}s`} />
              </div>
              <p className="text-sm text-[color:var(--color-text-secondary)]">
                {localize(locale, "Web Shell 反映后端实际状态。如果原生伴侣功能缺失，此页面会直接报告，而不是隐藏在占位符后面。", "The web shell reflects the backend truth. If native companion features are missing, this page reports them directly rather than hiding them behind placeholders.")}
              </p>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "正在加载诊断信息…", "Loading diagnostics...")}</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "引导模式", "Guide Mode")} title={localize(locale, "Native Companion Overlay", "Native Companion Overlay")}>
          {guideLensState ? (
            <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
              <div className="flex items-center gap-4 rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                <div className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-[#c4c7c5] text-xl font-semibold text-white">
                  {guideLensState.preferences.avatar.kind === "default_f" ? (guideLensState.preferences.avatar.initials ?? "F") : "F"}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-[color:var(--color-text-primary)]">
                    {localize(locale, "只读引导，不接管操作", "Read-only guidance, no input takeover")}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-[color:var(--color-text-tertiary)]">
                    {localize(locale, "默认灰色 F 头像，可切换复用 profile 或本地图片；蓝色焦点框会显示在 native companion 上。", "Default grey F avatar, with profile/local image options; blue focus frames render in the native companion.")}
                  </p>
                </div>
                <StatusPill tone={guideLensState.preferences.enabled ? "success" : "neutral"}>
                  {guideLensState.preferences.enabled ? "enabled" : "disabled"}
                </StatusPill>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-[color:var(--color-text-tertiary)]">{localize(locale, "触发方式", "Trigger")}</span>
                  <select
                    className="w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-2 text-sm text-[color:var(--color-text-primary)]"
                    value={guideLensState.preferences.triggerPolicy}
                    onChange={(event) => updateGuideLensPreferencesMutation.mutate({ triggerPolicy: event.target.value as GuideLensState["preferences"]["triggerPolicy"] })}
                  >
                    <option value="confirm_first">{localize(locale, "首次确认后弹出", "Confirm first")}</option>
                    <option value="manual">{localize(locale, "只手动触发", "Manual only")}</option>
                    <option value="trusted_context_auto">{localize(locale, "信任场景自动弹出", "Trusted auto")}</option>
                  </select>
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-[color:var(--color-text-tertiary)]">{localize(locale, "头像来源", "Avatar")}</span>
                  <select
                    className="w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-2 text-sm text-[color:var(--color-text-primary)]"
                    value={guideLensState.preferences.avatar.kind}
                    onChange={(event) => updateGuideLensAvatarMutation.mutate({ kind: event.target.value as GuideLensState["preferences"]["avatar"]["kind"] })}
                  >
                    <option value="default_f">{localize(locale, "默认灰色 F", "Default grey F")}</option>
                    <option value="profile_image">{localize(locale, "复用 profile 图片", "Use profile image")}</option>
                    <option value="local_image">{localize(locale, "本地图片路径", "Local image path")}</option>
                  </select>
                </label>
              </div>

              <label className="space-y-1.5">
                <span className="text-xs font-medium text-[color:var(--color-text-tertiary)]">{localize(locale, "本地图片路径", "Local image path")}</span>
                <input
                  className="w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-2 text-sm text-[color:var(--color-text-primary)]"
                  defaultValue={guideLensState.preferences.avatar.localPath ?? ""}
                  placeholder="/Users/me/Pictures/profile.png"
                  onBlur={(event) => updateGuideLensAvatarMutation.mutate({ kind: "local_image", localPath: event.target.value })}
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-3">
                <DiagnosticRow label={localize(locale, "Parser", "Parser")} value={guideLensState.preferences.parserProvider} />
                <DiagnosticRow label={localize(locale, "Chatbox", "Chatbox")} value={guideLensState.preferences.chatboxPolicy} />
                <DiagnosticRow label={localize(locale, "Session", "Session")} value={guideLensState.activeSession?.status ?? "idle"} />
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "引导模式未启用或系统伴侣未连接。", "Guide Mode is not enabled or the companion is not connected.")}</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "身份", "Identity")} title={localize(locale, "运维访问", "Operator Access")}>
          {me ? (
            <div className="space-y-3 text-sm text-[color:var(--color-text-secondary)]">
              <div className="flex items-center justify-between gap-4">
                <span>{localize(locale, "用户", "User")}</span>
                <span className="font-medium text-[color:var(--color-text-primary)]">{me.user.displayName}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span>{localize(locale, "角色", "Role")}</span>
                <StatusPill>{me.user.role}</StatusPill>
              </div>
              <div>
                <p className="mb-2 text-[color:var(--color-text-tertiary)]">{localize(locale, "权限范围", "Scopes")}</p>
                <div className="flex flex-wrap gap-2">
                  {me.scopes.map((scope) => (
                    <StatusPill key={scope}>{scope}</StatusPill>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "正在加载身份信息…", "Loading identity...")}</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "提供商", "Providers")} title={localize(locale, "模型路由基础", "Model Routing Basics")}>
          <div className="mb-4 rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">
                  {localize(locale, "连接模型账号", "Connect model account")}
                </p>
                <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                  {localize(
                    locale,
                    "OpenAI API 使用 API key；OpenAI Codex 可以选择 API key/bearer token 或连接你的 ChatGPT 计划。",
                    "OpenAI API uses an API key; OpenAI Codex can use an API key/bearer token or connect your ChatGPT plan.",
                  )}
                </p>
              </div>
              {connectOAuth.status === "connected" ? (
                <StatusPill tone="success">{localize(locale, "已连接", "connected")}</StatusPill>
              ) : null}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {(["openai", "openai-codex"] as FridayProviderKind[]).map((kind) => {
                const template = providerTemplates.find((item) => item.providerKind === kind);
                if (!template) return null;
                const active = connectProviderKind === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => selectConnectProviderKind(kind)}
                    className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
                      active
                        ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-text-primary)]"
                        : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] text-[color:var(--color-text-secondary)] hover:border-[color:var(--color-border-strong)]"
                    }`}
                  >
                    {template.displayName}
                  </button>
                );
              })}
            </div>

            {connectUseMyPlanAvailable && connectKeyAvailable ? (
              <div className="mt-4 flex w-fit items-center gap-1 rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-1">
                <button
                  type="button"
                  onClick={() => selectConnectMode("api-key")}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                    connectMode === "api-key"
                      ? "bg-[color:var(--color-accent)] text-white"
                      : "text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
                  }`}
                >
                  {localize(locale, "API 密钥", "API Key")}
                </button>
                <button
                  type="button"
                  onClick={() => selectConnectMode("use-my-plan")}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                    connectIsUseMyPlan
                      ? "bg-[color:var(--color-accent)] text-white"
                      : "text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
                  }`}
                >
                  Use my plan
                </button>
              </div>
            ) : null}

            {connectIsUseMyPlan ? (
              <div className="mt-4 rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
                <div className="flex items-start gap-3">
                  {connectOAuth.status === "starting" || connectOAuth.status === "completing" ? (
                    <RefreshCw className="mt-0.5 h-4 w-4 animate-spin text-[color:var(--color-accent)]" />
                  ) : connectOAuth.status === "connected" ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 text-[color:var(--ok)]" />
                  ) : (
                    <KeyRound className="mt-0.5 h-4 w-4 text-[color:var(--color-accent)]" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                      {localize(locale, "连接你的 OpenAI / ChatGPT 计划", "Connect your OpenAI / ChatGPT plan")}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                      {localize(
                        locale,
                        "Friday 会打开 OpenAI 授权页。授权完成后回到这里点击完成。",
                        "Friday opens the OpenAI authorization page. After authorizing, return here and complete the connection.",
                      )}
                    </p>
                    {connectOAuth.status === "pending" && connectOAuth.userCode ? (
                      <div className="mt-3 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-3">
                        <p className="text-xs text-[color:var(--color-text-tertiary)]">{localize(locale, "一次性 code", "One-time code")}</p>
                        <p className="mt-1 font-mono text-xl font-semibold tracking-[0.14em] text-[color:var(--color-text-primary)]">{connectOAuth.userCode}</p>
                        {connectOAuth.verificationUrl ? (
                          <a
                            href={connectOAuth.verificationUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[color:var(--color-accent)] hover:underline"
                          >
                            {localize(locale, "打开 OpenAI 授权页面", "Open OpenAI authorization page")}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : null}
                      </div>
                    ) : null}
                    {connectOAuth.status === "error" && connectOAuth.message ? (
                      <p className="mt-2 text-xs font-medium text-[color:var(--danger)]">{connectOAuth.message}</p>
                    ) : null}
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <ActionButton
                    tone="primary"
                    disabled={connectOAuth.status === "starting" || connectOAuth.status === "completing" || routingUpdatePending}
                    onClick={() => {
                      if (connectOAuth.status === "pending") {
                        void completeOpenAICodexDeviceOAuth();
                      } else {
                        void startOpenAICodexDeviceOAuth();
                      }
                    }}
                  >
                    {connectOAuth.status === "pending"
                      ? localize(locale, "我已完成授权", "I completed authorization")
                      : connectOAuth.status === "starting" || connectOAuth.status === "completing"
                        ? localize(locale, "处理中", "Working")
                        : "Use my plan"}
                  </ActionButton>
                </div>
              </div>
            ) : (
              <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]">
                <input
                  value={connectApiKey}
                  onChange={(event) => setConnectApiKey(event.target.value)}
                  type="password"
                  className="w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3 text-sm text-[color:var(--color-text-primary)] outline-none transition placeholder:text-[color:var(--color-text-faint)] focus:border-[color:var(--color-accent)]"
                  placeholder={localize(locale, `粘贴 ${connectProviderDisplayName} API 密钥`, `Paste ${connectProviderDisplayName} API key`)}
                />
                <ActionButton
                  tone="primary"
                  disabled={!connectKeyAvailable || routingUpdatePending}
                  onClick={() => void saveApiKeyProviderFromSettings()}
                >
                  {localize(locale, "验证并保存", "Validate & Save")}
                </ActionButton>
              </div>
            )}
          </div>

          {providers.length === 0 ? (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "尚未配置任何提供方。", "No providers configured yet.")}</p>
          ) : (
            <div className="space-y-3">
              {providers.map((provider) => (
                <div key={provider.id} className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                  {(() => {
                    const template = providerTemplates.find((item) => item.providerKind === provider.kind);
                    const healthItem = providerHealth.find((item) => item.providerId === provider.id);
                    const capabilityHealthItem = providerCapabilityHealth.find((item) => item.providerId === provider.id);
                    const remediationVerdict = healthItem
                      ? classifyFridayProviderDoctorRemediation({
                          enabled: provider.enabled,
                          validationStatus: healthItem.validationStatus,
                          validationErrorCode: provider.config.validation?.errorCode,
                          reasons: healthItem.reasons,
                          backendHealth: healthItem.backendHealth,
                          authHealth: healthItem.authHealth,
                          routingEligible: healthItem.routingEligible,
                        })
                      : undefined;
                    const remediationHint = remediationVerdict
                      ? describeFridayProviderDoctorRemediation(remediationVerdict, locale)
                      : null;
                    const isValidatingThisProvider =
                      validateMutation.isPending && validateMutation.variables === provider.id;
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
                    {localize(locale, "默认模型：", "Default model: ")}{provider.defaultModel ?? resolveFirstSupportedModel(provider) ?? localize(locale, "未设置", "Not set")}
                  </p>
                  {remediationHint ? (
                    <div className="mt-3 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-3">
                      <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{remediationHint.title}</p>
                      <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">{remediationHint.hint}</p>
                    </div>
                  ) : null}
                  {healthItem ? (
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <DiagnosticRow label={localize(locale, "后端健康", "Backend health")} value={healthItem.backendHealth} />
                      <DiagnosticRow label={localize(locale, "认证健康", "Auth health")} value={healthItem.authHealth} />
                      <DiagnosticRow label={localize(locale, "验证", "Validation")} value={healthItem.validationStatus} />
                      <DiagnosticRow label={localize(locale, "断路器", "Circuit")} value={healthItem.circuitState} />
                    </div>
                  ) : null}
                  {healthItem?.cooldownRemainingMs ? (
                    <p className="mt-2 text-xs text-[color:var(--color-text-faint)]">
                      {localize(locale, "冷却剩余：", "Cooldown remaining: ")}{Math.ceil(healthItem.cooldownRemainingMs / 1000)}s
                    </p>
                  ) : null}
                  {healthItem?.suggestedAction ? (
                    <p className="mt-2 text-xs text-[color:var(--color-text-secondary)]">{healthItem.suggestedAction}</p>
                  ) : null}
                  {capabilityHealthItem?.capabilities.length ? (
                    <div data-testid="provider-capability-health-dashboard" className="mt-3 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">
                          {localize(locale, "能力健康", "Capability health")}
                        </p>
                        <StatusPill tone={toneForProviderLane(capabilityHealthItem.lane)}>
                          {capabilityHealthItem.lane}
                        </StatusPill>
                      </div>
                      <ul className="mt-2 space-y-2">
                        {capabilityHealthItem.capabilities.map((capability) => (
                          <li key={`${capability.capability}-${capability.model ?? "any"}`} className="text-xs">
                            <div className="flex flex-wrap items-center gap-2">
                              <StatusPill tone={toneForProviderCapabilityHealthState(capability.state)}>
                                {labelForProviderCapabilityHealthState(locale, capability.state)}
                              </StatusPill>
                              <span className="font-medium text-[color:var(--color-text-primary)]">
                                {capability.capability}{capability.model ? ` · ${capability.model}` : ""}
                              </span>
                              <span className="text-[color:var(--color-text-faint)]">{capability.source}</span>
                            </div>
                            <p className="mt-1 leading-5 text-[color:var(--color-text-secondary)]">{capability.message}</p>
                            {capability.lastVerifiedAt ? (
                              <p className="mt-1 text-[10px] text-[color:var(--color-text-faint)]">
                                {localize(locale, "上次证明：", "Last proof: ")}{formatTimestamp(capability.lastVerifiedAt)}
                              </p>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {/*
                   * B7 / FRI-AUD-012/013/014/017 minimal lane-truth surface:
                   * after a Run-capability-doctor probe, show per-lane
                   * (text/embedding/vision/auth/media) advisories for THIS
                   * provider whose status !== "verified". Hidden until the
                   * operator runs the doctor; hidden for providers whose
                   * every probed lane verified. Does NOT change the
                   * "enabled" pill above.
                   */}
                  {(() => {
                    const laneAdvisories = (capabilityLaneResultsByProvider[provider.id] ?? [])
                      .filter((r) => r.status !== "verified");
                    if (laneAdvisories.length === 0) return null;
                    return (
                      <div
                        data-testid="provider-capability-lane-advisory"
                        className="mt-3 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-3"
                      >
                        <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">
                          {localize(
                            locale,
                            "能力 lane 提示（B7 / FRI-AUD-012/013/014/017）",
                            "Capability-lane advisory (B7 / FRI-AUD-012/013/014/017)",
                          )}
                        </p>
                        <ul className="mt-2 space-y-1">
                          {laneAdvisories.map((r) => (
                            <li key={`${r.capability}-${r.checkedAt}`} className="flex items-start gap-2 text-xs">
                              <StatusPill tone={r.status === "failed" ? "danger" : "warning"}>
                                {r.capability} · {r.status}
                              </StatusPill>
                              <span className="text-[color:var(--color-text-secondary)]">{r.message}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-2 text-[10px] text-[color:var(--color-text-faint)]">
                          {localize(
                            locale,
                            "来自最近一次 'Run capability doctor' 探针；其他 lane 已验证或未探测；此提示仅为 per-lane 真相披露，并不代表 provider 整体不可用。",
                            "From the latest 'Run capability doctor' probe; other lanes verified or unprobed; this advisory is per-lane truth-label, not a provider-global availability claim.",
                          )}
                        </p>
                      </div>
                    );
                  })()}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <ActionButton
                      tone="secondary"
                      disabled={validateMutation.isPending}
                      onClick={() => validateMutation.mutate(provider.id)}
                    >
                      {isValidatingThisProvider
                        ? localize(locale, "验证中...", "Validating...")
                        : localize(locale, "立即验证", "Validate now")}
                    </ActionButton>
                  </div>
                  {provider.kind === "openai-codex" && provider.config.authMode === "oauth" ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <ActionButton
                        tone="secondary"
                        disabled={connectOAuth.status === "starting" || connectOAuth.status === "completing"}
                        onClick={() => void startOpenAICodexDeviceOAuth(provider.id)}
                      >
                        {localize(locale, "重新连接计划", "Reconnect plan")}
                      </ActionButton>
                    </div>
                  ) : null}
                      </>
                    );
                  })()}
                </div>
              ))}
            </div>
          )}
          <ConfirmDialog
            open={pendingDefaultProviderChoice !== null}
            title={localize(locale, "设为默认模型提供方？", "Set as default model provider?")}
            description={localize(
              locale,
              `${pendingDefaultProviderChoice?.providerName ?? "OpenAI Codex"} 已连接。是否把它设为默认路由？`,
              `${pendingDefaultProviderChoice?.providerName ?? "OpenAI Codex"} is connected. Use it as the default route?`,
            )}
            confirmLabel={localize(locale, "设为默认", "Set default")}
            cancelLabel={localize(locale, "保留当前默认", "Keep current")}
            tone="primary"
            loading={routingUpdatePending}
            onCancel={() => setPendingDefaultProviderChoice(null)}
            onConfirm={() => {
              const pending = pendingDefaultProviderChoice;
              if (!pending) return;
              void setProviderAsDefault(pending.providerId, pending.defaultModel).then(() => {
                setPendingDefaultProviderChoice(null);
              });
            }}
          />
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "运维", "Operator")} title={localize(locale, "路由可解释性", "Routing Explainability")}>
          <div className="space-y-4">
            <div className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-[color:var(--color-text-primary)]">{localize(locale, "模型路由模式", "Model routing mode")}</p>
                  <p className="text-xs text-[color:var(--color-text-tertiary)]">{routingConfig?.costMode ?? routingExplain?.costMode ?? "standard"}</p>
                </div>
                <div className="flex items-center gap-1 rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-1">
                  {ROUTING_COST_MODE_OPTIONS.map((mode) => {
                    const active = (routingConfig?.costMode ?? "standard") === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        disabled={routingCostModeMutation.isPending}
                        onClick={() => routingCostModeMutation.mutate(mode)}
                        className={`rounded-full px-4 py-2 text-xs font-medium transition ${
                          active
                            ? "bg-[color:var(--color-accent)] text-white"
                            : "text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
                        }`}
                      >
                        {routingCostModeLabel(mode, locale)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            {routingExplain ? (
              <>
              <div className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-[color:var(--color-text-primary)]">{localize(locale, "当前决策", "Current decision")}</p>
                    <p className="text-xs text-[color:var(--color-text-tertiary)]">{routingExplain.reasonCode} · history window {routingExplain.historyWindow.sampleLimit}</p>
                  </div>
                  <StatusPill tone={routingExplain.learningAdjusted ? "success" : routingExplain.learningSignalsPresent ? "warning" : "neutral"}>
                    {routingExplain.learningAdjusted ? "adjusted" : routingExplain.learningSignalsPresent ? "signals present" : "configured"}
                  </StatusPill>
                </div>
                <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">{routingExplain.reasonText}</p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <DiagnosticRow
                    label={localize(locale, "学习前", "Before learning")}
                    value={routingExplain.selectedBeforeLearning ? `${routingExplain.selectedBeforeLearning.providerId} / ${routingExplain.selectedBeforeLearning.model}` : "n/a"}
                  />
                  <DiagnosticRow
                    label={localize(locale, "学习后", "After learning")}
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
                        {localize(locale, "固定路由", "Pin Route")}
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
                        {localize(locale, "清除惩罚", "Clear Penalty")}
                      </ActionButton>
                    </div>
                  </div>
                ))}
              </div>
              </>
            ) : (
              <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "路由解释预览待连接。", "Routing explain preview is waiting for data.")}</p>
            )}
          </div>
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "沟通", "Communication")} title={localize(locale, "人格", "Persona")}>
          <div className="space-y-4">
            <p className="text-sm text-[color:var(--color-text-secondary)]">
              {localize(locale, "MBTI 是一个以舒适为导向的起始模板。实际行为由下方设置决定，且不会削弱安全或审批边界。", "MBTI is a comfort-oriented starting template. The actual behavior comes from the settings below, and it never weakens safety or approval boundaries.")}
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-2 text-sm text-[color:var(--color-text-secondary)]">
                <span>{localize(locale, "MBTI 模板", "MBTI template")}</span>
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
                  <option value="">{localize(locale, "默认", "Default")}</option>
                  {COMMUNICATION_MBTI_OPTIONS.map((mbti) => (
                    <option key={mbti} value={mbti}>{mbti}</option>
                  ))}
                </select>
              </label>
              <PersonaField
                label={localize(locale, "语调", "Tone")}
                value={draft.settings.tone}
                onChange={(value) => setDraft((current) => ({ ...current, settings: { ...current.settings, tone: value as FridayCommunicationPersonaSettings["tone"] } }))}
                options={["warm", "neutral", "analytical", "encouraging"]}
              />
              <PersonaField
                label={localize(locale, "详细程度", "Verbosity")}
                value={draft.settings.verbosity}
                onChange={(value) => setDraft((current) => ({ ...current, settings: { ...current.settings, verbosity: value as FridayCommunicationPersonaSettings["verbosity"] } }))}
                options={["concise", "balanced", "detailed"]}
              />
              <PersonaField
                label={localize(locale, "结构", "Structure")}
                value={draft.settings.structure}
                onChange={(value) => setDraft((current) => ({ ...current, settings: { ...current.settings, structure: value as FridayCommunicationPersonaSettings["structure"] } }))}
                options={["compact", "balanced", "structured"]}
              />
              <PersonaField
                label={localize(locale, "提问风格", "Question style")}
                value={draft.settings.questionStyle}
                onChange={(value) => setDraft((current) => ({ ...current, settings: { ...current.settings, questionStyle: value as FridayCommunicationPersonaSettings["questionStyle"] } }))}
                options={["minimal", "guided", "exploratory"]}
              />
              <PersonaField
                label={localize(locale, "直接程度", "Directness")}
                value={draft.settings.directness}
                onChange={(value) => setDraft((current) => ({ ...current, settings: { ...current.settings, directness: value as FridayCommunicationPersonaSettings["directness"] } }))}
                options={["soft", "balanced", "direct"]}
              />
              <PersonaField
                label={localize(locale, "假设风格", "Assumption style")}
                value={draft.settings.assumptionStyle}
                onChange={(value) => setDraft((current) => ({ ...current, settings: { ...current.settings, assumptionStyle: value as FridayCommunicationPersonaSettings["assumptionStyle"] } }))}
                options={["ask_first", "balanced", "infer_first"]}
              />
              <PersonaField
                label={localize(locale, "确认风格", "Confirmation style")}
                value={draft.settings.confirmationStyle}
                onChange={(value) => setDraft((current) => ({ ...current, settings: { ...current.settings, confirmationStyle: value as FridayCommunicationPersonaSettings["confirmationStyle"] } }))}
                options={["minimal", "balanced", "explicit"]}
              />
              <PersonaField
                label={localize(locale, "术语容忍度", "Jargon tolerance")}
                value={draft.settings.jargonTolerance}
                onChange={(value) => setDraft((current) => ({ ...current, settings: { ...current.settings, jargonTolerance: value as FridayCommunicationJargonTolerance } }))}
                options={["low", "medium", "high"]}
              />
              <PersonaField
                label={localize(locale, "表情风格", "Emoji style")}
                value={draft.settings.emojiStyle}
                onChange={(value) => setDraft((current) => ({ ...current, settings: { ...current.settings, emojiStyle: value as FridayCommunicationEmojiStyle } }))}
                options={["none", "light"]}
              />
            </div>
            <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
              <div className="flex items-center gap-2 text-[color:var(--color-text-primary)]">
                <MessageCircleMore className="h-4 w-4" />
                <p className="font-medium">{localize(locale, "预览", "Preview")}</p>
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
                {localize(locale, "保存沟通风格", "Save Communication Style")}
              </ActionButton>
              <ActionButton
                tone="secondary"
                onClick={() => setDraft({ mbti: draft.mbti, settings: getMbtiDefaults(draft.mbti || null) })}
              >
                {localize(locale, "重置为 MBTI 默认值", "Reset To MBTI Defaults")}
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
                <DiagnosticTile icon={<Cpu className="h-4 w-4" />} label={localize(locale, "工作区根目录", "Workspace Root")} value={systemSession.workspaceRoot} mono />
                <DiagnosticTile icon={<Wifi className="h-4 w-4" />} label={localize(locale, "云规划", "Cloud Planning")} value={systemSession.cloudPlanningMode} />
                <DiagnosticTile icon={<Shield className="h-4 w-4" />} label={localize(locale, "健康状态", "Health")} value={systemState.health.status} />
                <DiagnosticTile icon={<KeyRound className="h-4 w-4" />} label={localize(locale, "启动时间", "Started")} value={formatTimestamp(systemSession.startedAt)} />
              </div>
              <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-[color:var(--color-text-primary)]">{localize(locale, "伴侣桥接", "Companion bridge")}</p>
                    <p className="text-sm text-[color:var(--color-text-tertiary)]">
                      {systemSession.companion.runtimeKind} · {systemSession.companion.transport.mode} · {systemSession.companion.transport.protocol}
                    </p>
                  </div>
                  <StatusPill tone={toneForStatus(systemSession.health.status)}>
                    {systemSession.health.status}
                  </StatusPill>
                </div>
                <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">{summarizeHealthReasons(systemSession.health, locale)}</p>
              </div>
              <div className="space-y-3">
                {systemState.permissions.map((permission) => (
                  <div key={permission.id} className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-[color:var(--color-text-primary)]">{permission.permission}</p>
                        <p className="text-xs text-[color:var(--color-text-faint)]">{permission.grantInstructions ?? localize(locale, "无额外说明。", "No extra instructions reported.")}</p>
                      </div>
                      <StatusPill tone={toneForStatus(permission.status)}>{permission.status}</StatusPill>
                    </div>
                    {systemSession.companion.platform === "darwin" && permission.status !== "granted" ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <ActionButton
                          tone="secondary"
                          disabled={openPermissionSettingsMutation.isPending}
                          onClick={() => openPermissionSettingsMutation.mutate(permission.permission)}
                        >
                          {localize(locale, "打开系统设置", "Open System Settings")}
                        </ActionButton>
                      </div>
                    ) : null}
                  </div>
                ))}
                {systemState.permissions.length === 0 ? (
                  <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "当前没有可用的桌面权限遥测数据。", "No desktop permission telemetry is currently available.")}</p>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "Agent OS 路由尚未响应。", "Agent OS routes are not responding yet.")}</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "伴侣状态", "Companion State")} title={localize(locale, "桌面面板", "Desktop Surfaces")}>
          {systemState ? (
            <div className="space-y-3">
              <DiagnosticRow label={localize(locale, "前台应用", "Frontmost App")} value={systemState.frontmostAppId ?? localize(locale, "未知", "Unknown")} />
              <DiagnosticRow label={localize(locale, "前台窗口", "Frontmost Window")} value={systemState.frontmostWindowId ?? localize(locale, "未知", "Unknown")} />
              <DiagnosticRow label={localize(locale, "最后快照", "Last Snapshot")} value={formatTimestamp(systemState.capturedAt)} />
              <DiagnosticRow label={localize(locale, "活跃租约", "Active Lease")} value={systemState.controlLease?.ownerId ?? localize(locale, "无", "None")} />
              <DiagnosticRow label={localize(locale, "权限更新时间", "Permissions Updated")} value={formatTimestamp(systemState.health.updatedAt)} />
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "等待系统快照…", "Waiting for a system snapshot.")}</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "Token 经济", "Token Economy")} title={localize(locale, "LLM 预算", "LLM Budget")}>
          {budgetStatus ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <DiagnosticTile
                  icon={<DollarSign className="h-4 w-4" />}
                  label={localize(locale, "状态", "Status")}
                  value={budgetStatus.state}
                />
                <DiagnosticTile
                  icon={<DollarSign className="h-4 w-4" />}
                  label={localize(locale, "本月已用", "Spent This Month")}
                  value={`$${budgetStatus.spentUsd.toFixed(2)}`}
                />
              </div>
              <div className="space-y-2">
                <DiagnosticRow label={localize(locale, "月份", "Month")} value={budgetStatus.month} />
                <DiagnosticRow
                  label={localize(locale, "月度限额", "Monthly Limit")}
                  value={budgetStatus.config ? `$${budgetStatus.config.monthlyLimitUsd.toFixed(2)}` : localize(locale, "未设限", "No limit set")}
                />
                <DiagnosticRow
                  label={localize(locale, "剩余", "Remaining")}
                  value={budgetStatus.remainingUsd !== null ? `$${budgetStatus.remainingUsd.toFixed(2)}` : localize(locale, "无限制", "Unlimited")}
                />
              </div>
              {budgetStatus.state !== "ok" ? (
                <div className={`rounded-2xl border p-3 text-sm ${budgetStatus.state === "over_limit" ? "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] text-[color:var(--color-text-primary)]" : "border-[color:var(--color-accent-soft)] bg-[color:var(--color-accent-muted)] text-[color:var(--color-text-primary)]"}`}>
                  {budgetStatus.state === "over_limit"
                    ? localize(locale, "预算已超 — Friday 将优先使用本地模型（Ollama）直到下一个计费周期。", "Budget exceeded — Friday will prefer local models (Ollama) until the next billing cycle.")
                    : localize(locale, "即将达到预算上限 — Friday 将尽可能优先使用更便宜的模型。", "Approaching budget limit — Friday will prefer cheaper models when possible.")}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "预算数据待连接。", "Budget data is waiting for data.")}</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "学习", "Learning")} title={localize(locale, "Friday 对你的了解", "What Friday Knows About You")}>
          <div className="space-y-3">
            <p className="text-sm text-[color:var(--color-text-secondary)]">
              {localize(
                locale,
                "这些是 Friday 从互动中学到的置信度事实；它们独立于显式 Memory，不会作为原始 learned fact 直接注入 prompt。",
                "These are confidence-scored facts Friday learned from interactions; they are separate from explicit Memory and are not injected into prompts as raw learned facts.",
              )}
            </p>
            <p className="text-xs leading-5 text-[color:var(--color-text-tertiary)]">
              {localize(
                locale,
                "只有通信 persona 或 runtime context resolver 明确使用时才会产生影响；执行、测试、安全和 User Constitution 偏好仍需要 Review Center 确认后才会作为 Reflex 偏好进入 prompt。",
                "They can influence behavior only when a communication persona or runtime context resolver explicitly uses them; execution, testing, safety, and User Constitution preferences still need Review Center confirmation before entering prompts as Reflex preferences.",
              )}
            </p>
            {learnedFacts.length === 0 ? (
              <p className="text-sm text-[color:var(--color-text-secondary)]">
                {localize(locale, "还没有 learned facts。边界仍然生效：显式 Memory、learned fact、Reflex 偏好和 User Constitution 是分开的。", "No learned facts yet. The boundary still applies: explicit Memory, learned facts, Reflex preferences, and User Constitution settings are separate.")}
              </p>
            ) : learnedFacts.map((fact) => (
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
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {learnedFactBoundaryDetails(fact, locale).map((item) => (
                    <div key={item.label} className="min-w-0 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg)] px-3 py-2">
                      <p className="text-[11px] uppercase text-[color:var(--color-text-faint)]">{item.label}</p>
                      <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">{item.value}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-[color:var(--color-text-faint)]">
                  {String(fact.evidenceCount)} evidence · last confirmed {formatTimestamp(fact.lastConfirmedAt)}
                </p>
              </div>
            ))}
          </div>
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "运维", "Operator")} title={localize(locale, "学习控制", "Learning Controls")}>
          {learningOverview ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <DiagnosticTile icon={<Brain className="h-4 w-4" />} label={localize(locale, "经验", "Lessons")} value={String(learningOverview.coverage.lessons)} />
                <DiagnosticTile icon={<Brain className="h-4 w-4" />} label={localize(locale, "模式", "Patterns")} value={String(learningOverview.coverage.patterns)} />
                <DiagnosticTile icon={<Sliders className="h-4 w-4" />} label={localize(locale, "路由调整", "Route Adjustments")} value={String(learningOverview.coverage.routeAdjustments)} />
                <DiagnosticTile icon={<AlertTriangle className="h-4 w-4" />} label={localize(locale, "被阻止的路由", "Blocked Routes")} value={String(learningOverview.coverage.blockedRoutes)} />
              </div>
              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "经验", "Lessons")}</p>
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
                        {record.disabled ? localize(locale, "启用经验", "Enable Lesson") : localize(locale, "禁用经验", "Disable Lesson")}
                      </ActionButton>
                    </div>
                  </div>
                ))}
              </div>
              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "模式", "Patterns")}</p>
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
                        {localize(locale, "降级模式", "Demote Pattern")}
                      </ActionButton>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "学习控制待连接。", "Learning controls are waiting for data.")}</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "安全", "Security")} title={localize(locale, "安全中心", "Security Center")}>
          {securityCenter ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <DiagnosticTile icon={<Shield className="h-4 w-4" />} label={localize(locale, "活跃令牌", "Active Tokens")} value={String(securityCenter.tokens.active)} />
                <DiagnosticTile icon={<KeyRound className="h-4 w-4" />} label={localize(locale, "高权限", "High Privilege")} value={String(securityCenter.tokens.highPrivilegeActive)} />
              </div>
              {securityCenter.findings.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "发现", "Findings")}</p>
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
                <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "未检测到安全问题。", "No security findings detected.")}</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "安全数据待连接。", "Security data is waiting for data.")}</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "能力管理", "Capability Management")} title={localize(locale, "MCP 与通道面板", "MCP And Channel Surfaces")}>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <DiagnosticTile icon={<Wrench className="h-4 w-4" />} label={localize(locale, "MCP 已加载", "MCP Loaded")} value={`${loadedMcpCount}/${mcpStates.length}`} />
              <DiagnosticTile icon={<MessageCircleMore className="h-4 w-4" />} label={localize(locale, "通道已连接", "Channels Connected")} value={`${connectedChannelCount}/${channels.length}`} />
              <DiagnosticTile icon={<AlertTriangle className="h-4 w-4" />} label={localize(locale, "需要关注", "Attention Needed")} value={String(channelAttentionCount)} />
            </div>

            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "MCP 服务器", "MCP servers")}</p>
              {mcpStates.length === 0 ? (
                <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "此运行时未配置任何 MCP 服务器。", "No MCP servers configured for this runtime.")}</p>
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
                      <DiagnosticRow label={localize(locale, "工具", "Tools")} value={String(state.toolCount ?? 0)} />
                      <DiagnosticRow label={localize(locale, "资源", "Resources")} value={String(state.resourceCount ?? 0)} />
                      <DiagnosticRow label={localize(locale, "提示", "Prompts")} value={String(state.promptCount ?? 0)} />
                      <DiagnosticRow label={localize(locale, "最后加载", "Last Loaded")} value={formatTimestamp(state.lastLoadedAt)} />
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "通道健康", "Channel health")}</p>
                <Link to="/channels" className="text-xs font-medium text-[color:var(--color-accent)] transition hover:opacity-80">
                  {localize(locale, "查看渠道对话 →", "View channel conversations →")}
                </Link>
              </div>
              {channels.length === 0 ? (
                <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "此运行时未注册任何通道。", "No channels are registered in this runtime.")}</p>
              ) : (
                channels.map((channel) => {
                  const meta = CHANNEL_META[channel.kind as ChannelKind];
                  return (
                  <div key={channel.kind} className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2">
                        {meta && <span className="text-lg">{meta.emoji}</span>}
                        <div>
                          <p className="font-medium text-[color:var(--color-text-primary)]">{meta?.name ?? channel.kind}</p>
                          <p className="text-xs text-[color:var(--color-text-tertiary)]">
                            running {String(channel.running)} · restarts {channel.health.restartCount}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <StatusPill tone={toneForChannelState(channel.health.state)}>{channel.health.state}</StatusPill>
                        <StatusPill tone={toneForCredentialStatus(channel.health.credentialStatus)}>
                          {channel.health.credentialStatus}
                        </StatusPill>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <DiagnosticRow label={localize(locale, "阻止原因", "Blocked Reason")} value={channel.health.blockedReason ?? localize(locale, "无", "None")} />
                      <DiagnosticRow label={localize(locale, "最后错误", "Last Error")} value={channel.health.lastError ?? localize(locale, "无", "None")} />
                      <DiagnosticRow
                        label={localize(locale, "白名单", "Allowlist")}
                        value={`users ${channel.allowlist.allowedUsersCount} · chats ${channel.allowlist.allowedChatsCount}`}
                      />
                      <DiagnosticRow
                        label={localize(locale, "支持", "Support")}
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
                        {localize(locale, "精选技能：", "Curated skills: ")}{channel.contract.curatedSkillIds.join(", ")}
                      </p>
                    ) : null}
                  </div>
                  );
                })
              )}
            </div>

            <div className="mt-4 border-t border-[color:var(--color-border-soft)] pt-4">
              <p className="agent-eyebrow mb-3">{localize(locale, "添加通道", "Add Channel")}</p>
              <ChannelConfigForm locale={locale} />
            </div>
          </div>
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "能力", "Capabilities")} title={localize(locale, "能力矩阵", "Capability Matrix")}>
          {health ? (
            <div className="space-y-3">
              {runtimeMatrix ? (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-5">
                    <DiagnosticTile icon={<Wrench className="h-4 w-4" />} label={localize(locale, "可用", "Available")} value={String(runtimeMatrix.summary.available)} />
                    <DiagnosticTile icon={<AlertTriangle className="h-4 w-4" />} label={localize(locale, "需验证", "Needs Verification")} value={String(runtimeMatrix.summary.needsVerification)} />
                    <DiagnosticTile icon={<AlertTriangle className="h-4 w-4" />} label={localize(locale, "需配置", "Needs Setup")} value={String(runtimeMatrix.summary.needsUserAction)} />
                    <DiagnosticTile icon={<Wrench className="h-4 w-4" />} label={localize(locale, "可补齐", "Installable")} value={String(runtimeMatrix.summary.installable)} />
                    <DiagnosticTile icon={<Shield className="h-4 w-4" />} label={localize(locale, "不支持", "Unsupported")} value={String(runtimeMatrix.summary.unsupported)} />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-[color:var(--color-text-tertiary)]">
                      {localize(locale, "能力状态来自实际 runtime、提供方验证和保守模型能力推断。", "Capability state comes from runtime wiring, provider validation, and conservative model capability inference.")}
                    </p>
                    <ActionButton
                      tone="secondary"
                      disabled={capabilityDoctorMutation.isPending}
                      onClick={() => capabilityDoctorMutation.mutate()}
                    >
                      {capabilityDoctorMutation.isPending
                        ? localize(locale, "检查中", "Checking")
                        : localize(locale, "重新检查", "Run Doctor")}
                    </ActionButton>
                  </div>
                  <div className="grid gap-3 xl:grid-cols-2">
                    {runtimeMatrix.items.map((item) => {
                      const primarySource = item.sources[0];
                      const primaryRepair = item.repairOptions[0];
                      return (
                        <div key={item.capability} className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-medium text-[color:var(--color-text-primary)]">{item.label}</p>
                              <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">{item.description}</p>
                            </div>
                            <StatusPill tone={toneForCapabilityState(item.state)}>
                              {labelForCapabilityState(locale, item.state)}
                            </StatusPill>
                          </div>
                          <p className="mt-3 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                            {primarySource
                              ? `${primarySource.label} · ${primarySource.status}`
                              : item.blockers[0] ?? localize(locale, "暂无来源", "No source")}
                          </p>
                          {item.lastVerifiedAt ? (
                            <p className="mt-1 text-xs text-[color:var(--color-text-faint)]">
                              {localize(locale, "上次验证：", "Last verified: ")}{formatTimestamp(item.lastVerifiedAt)}
                            </p>
                          ) : null}
                          {primaryRepair ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {primaryRepair.setupHref ? (
                                <a
                                  className="inline-flex min-h-[44px] items-center justify-center rounded-2xl border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-primary)] transition hover:bg-[color:var(--color-bg-surface-strong)]"
                                  href={primaryRepair.setupHref}
                                >
                                  {localize(locale, "进入配置", "Configure")}
                                </a>
                              ) : null}
                              {primaryRepair.href ? (
                                <a
                                  className="inline-flex min-h-[44px] items-center justify-center rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-secondary)] transition hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-surface-strong)] hover:text-[color:var(--color-text-primary)]"
                                  href={primaryRepair.href}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {primaryRepair.setupHref ? localize(locale, "查看文档", "Docs") : primaryRepair.label}
                                </a>
                              ) : (
                                primaryRepair.setupHref ? null : <StatusPill tone="warning">{primaryRepair.label}</StatusPill>
                              )}
                              {primaryRepair.requiresApproval ? (
                                <StatusPill tone="warning">{localize(locale, "需要确认", "approval required")}</StatusPill>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              {[
                { name: localize(locale, "插件", "Plugins"), enabled: health.capabilities?.plugins?.runtimeMode === "full" },
                { name: localize(locale, "系统编排", "System orchestration"), enabled: health.capabilities?.system?.enabled === true },
                { name: localize(locale, "通道", "Channels"), enabled: (health.capabilities?.channels?.enabledKinds?.length ?? 0) > 0 },
              ].map((tool) => (
                <div key={tool.name} className="flex items-center justify-between rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3 text-sm">
                  <div className="flex items-center gap-2">
                    <Wrench className="h-3.5 w-3.5 text-[color:var(--color-text-faint)]" />
                    <span className="text-[color:var(--color-text-secondary)]">{tool.name}</span>
                  </div>
                  <StatusPill tone={tool.enabled ? "success" : "neutral"}>
                    {tool.enabled ? localize(locale, "已启用", "enabled") : localize(locale, "已禁用", "disabled")}
                  </StatusPill>
                </div>
              ))}
              <div className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <div className="flex items-center gap-2">
                    <Wrench className="h-3.5 w-3.5 text-[color:var(--color-text-faint)]" />
                    <span className="text-[color:var(--color-text-secondary)]">{localize(locale, "搜索时效性", "Search latestness")}</span>
                  </div>
                  <StatusPill tone={health.capabilities?.search?.latestness === "provider_backed" ? "success" : "warning"}>
                    {health.capabilities?.search?.latestness === "provider_backed"
                      ? localize(locale, "已验证", "verified")
                      : localize(locale, "未验证", "unverified")}
                  </StatusPill>
                </div>
                <p className="mt-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                  {health.capabilities?.search?.warning
                    ?? localize(
                      locale,
                      "当前没有额外的搜索时效性告警。",
                      "No additional search-latestness warning is reported for this runtime.",
                    )}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "正在加载工具状态…", "Loading tool status...")}</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "Agent 循环", "Agent Loop")} title={localize(locale, "自动化策略", "Automation Policy")}>
          {agentLoopPolicy ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <DiagnosticTile icon={<Sliders className="h-4 w-4" />} label={localize(locale, "最大尝试次数", "Max Attempts")} value={String(agentLoopPolicy.maxAttemptsPerFingerprint)} />
                <DiagnosticTile icon={<Sliders className="h-4 w-4" />} label={localize(locale, "冷却时间", "Cooldown")} value={`${agentLoopPolicy.cooldownMinutes} min`} />
              </div>
              <div className="flex flex-wrap gap-2">
                <ActionButton
                  tone={agentLoopPolicy.paused ? "primary" : "secondary"}
                  disabled={updatePolicyMutation.isPending}
                  onClick={() => updatePolicyMutation.mutate({ paused: !agentLoopPolicy.paused })}
                >
                  {agentLoopPolicy.paused ? localize(locale, "恢复循环", "Resume loop") : localize(locale, "暂停循环", "Pause loop")}
                </ActionButton>
                <ActionButton
                  tone="secondary"
                  disabled={updatePolicyMutation.isPending}
                  onClick={() => updatePolicyMutation.mutate({ autoApplyLowRisk: !agentLoopPolicy.autoApplyLowRisk })}
                >
                  {agentLoopPolicy.autoApplyLowRisk ? localize(locale, "禁用自动应用", "Disable auto-apply") : localize(locale, "启用自动应用", "Enable auto-apply")}
                </ActionButton>
              </div>
              <DiagnosticRow label={localize(locale, "要求回滚计划", "Require rollback plan")} value={agentLoopPolicy.requireRollbackPlan ? localize(locale, "是", "yes") : localize(locale, "否", "no")} />
              <DiagnosticRow label={localize(locale, "要求验收检查", "Require acceptance check")} value={agentLoopPolicy.requireAcceptanceCheck ? localize(locale, "是", "yes") : localize(locale, "否", "no")} />
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "Agent 循环策略待连接。", "Agent loop policy is waiting for data.")}</p>
          )}
          {expertMode ? (
            <div className="mt-4 space-y-2 border-t border-[color:var(--color-border-soft)] pt-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "专家模式", "Expert Mode")}</p>
                <ActionButton
                  tone={expertMode.enabled ? "danger" : "primary"}
                  disabled={toggleExpertMutation.isPending}
                  onClick={() => toggleExpertMutation.mutate(!expertMode.enabled)}
                >
                  {expertMode.enabled ? localize(locale, "禁用", "Disable") : localize(locale, "启用", "Enable")}
                </ActionButton>
              </div>
              {expertMode.contextInferenceAllowed !== undefined ? (
                <DiagnosticRow label={localize(locale, "上下文推断", "Context Inference")} value={expertMode.contextInferenceAllowed ? localize(locale, "已允许", "allowed") : localize(locale, "已拒绝", "denied")} />
              ) : null}
              {expertMode.probeBudget !== undefined ? (
                <DiagnosticRow label={localize(locale, "探测预算", "Probe Budget")} value={String(expertMode.probeBudget)} />
              ) : null}
            </div>
          ) : null}
        </ShellCard>

        <ShellCard
          eyebrow={localize(locale, "云端 Worker", "Cloud Workers")}
          title={localize(locale, "用户自有云 Worker 管理", "User-owned cloud worker management")}
        >
          <div
            data-testid="settings-cloud-worker-card"
            className="space-y-3 text-sm text-[color:var(--color-text-secondary)]"
          >
            <p>
              {localize(
                locale,
                "Friday 不托管用户数据，也不接收长期凭证。云端 Worker 部署在你自己的云上：使用 HTTPS、专用子域（worker.friday-test.<你的域>）、Owner 配对、体检与拆机回执。",
                "Friday does not host user data and does not receive long-lived credentials. Cloud workers run in your own cloud over HTTPS on a dedicated subdomain (worker.friday-test.<your-domain>), with owner pairing, doctor, and teardown receipts.",
              )}
            </p>
            <p>
              {localize(
                locale,
                "FRIDAY_MASTER_KEY 与 FRIDAY_TOKEN_SECRET 是内部 runtime 秘钥，由用户自有云 runtime 自动生成；普通用户不需要手动填写。",
                "FRIDAY_MASTER_KEY and FRIDAY_TOKEN_SECRET are internal runtime secrets generated by your cloud runtime; ordinary users do not paste them.",
              )}
            </p>
            <p className="text-xs text-[color:var(--color-text-tertiary)]">
              {localize(
                locale,
                "云端 Worker 设置会先准备服务商目录、部署预览、部署包、DNS 校验、体检和拆机回执。真实云端认证需要受保护的 GitHub Environment Secrets、专用 DNS 凭证与 TTL/预算控制。",
                "Cloud worker setup prepares the provider catalog, deployment preview, deployment package, DNS validation, doctor, and teardown receipts first. Live cloud certification requires protected GitHub Environment Secrets, dedicated DNS tokens, and TTL/budget controls.",
              )}
            </p>
            <Link
              to="/cloud-workers"
              className="inline-flex items-center gap-1 rounded-full border border-[color:var(--color-accent)] px-4 py-2 text-sm font-semibold text-[color:var(--color-accent)] transition hover:bg-[color:var(--color-accent-soft)]"
            >
              {localize(locale, "打开云端 Worker 设置", "Open cloud worker setup")}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>
        </ShellCard>

        <SupervisorModeDefaultCard locale={locale} />
      </div>

    </div>
    </div>
  );
}

type SupervisorModeDefault = "off" | "light" | "standard" | "strict";

const SUPERVISOR_MODE_DEFAULTS: readonly SupervisorModeDefault[] = [
  "off",
  "light",
  "standard",
  "strict",
];

function isSupervisorModeDefault(value: unknown): value is SupervisorModeDefault {
  return (
    typeof value === "string" &&
    (SUPERVISOR_MODE_DEFAULTS as readonly string[]).includes(value)
  );
}

function SupervisorModeDefaultCard(props: { locale: AppLocale }) {
  const { locale } = props;
  const { values, setPreference, isLoading } = useUixPreferences();
  const stored = values["task_workflow_supervisor_mode_default"];
  const current: SupervisorModeDefault = isSupervisorModeDefault(stored)
    ? stored
    : "standard";
  const [pending, setPending] = useState<SupervisorModeDefault | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleSelect = (next: SupervisorModeDefault) => {
    if (next === current) return;
    setPending(next);
    setConfirmOpen(true);
  };

  const handleConfirm = () => {
    if (pending) {
      setPreference("task_workflow_supervisor_mode_default", pending);
      toast.success(
        localize(
          locale,
          `已将任务工作流默认监督员模式设为 ${pending}`,
          `Task workflow supervisor default set to ${pending}`,
        ),
      );
    }
    setConfirmOpen(false);
    setPending(null);
  };

  const handleCancel = () => {
    setConfirmOpen(false);
    setPending(null);
  };

  return (
    <ShellCard
      eyebrow={localize(locale, "任务工作流", "Task Workflows")}
      title={localize(locale, "默认监督员模式", "Default supervisor mode")}
    >
      <p className="mb-3 text-xs text-[color:var(--color-text-tertiary)]">
        {localize(
          locale,
          "选择新任务工作流的默认监督员模式。必选确定性门禁永远不可被模式或用户配置关闭。",
          "Default supervisor mode for new task workflows. Required deterministic gates cannot be disabled by mode or user configuration.",
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {SUPERVISOR_MODE_DEFAULTS.map((mode) => (
          <ActionButton
            key={mode}
            tone={mode === current ? "primary" : "secondary"}
            disabled={isLoading}
            onClick={() => handleSelect(mode)}
          >
            {mode}
          </ActionButton>
        ))}
        <span className="ml-2 text-xs text-[color:var(--color-text-tertiary)]">
          {localize(locale, "当前", "Current")}: <code>{current}</code>
        </span>
      </div>
      <p className="mt-3 text-xs text-[color:var(--color-text-tertiary)]">
        {localize(
          locale,
          "保存后存入 UIX 偏好,不写入记忆系统。",
          "Saved to UIX preferences only; never written to the memory system.",
        )}
      </p>
      <ConfirmDialog
        open={confirmOpen}
        title={localize(locale, "确认更改默认监督员模式", "Confirm supervisor default change")}
        description={localize(
          locale,
          `从 ${current} 切换到 ${pending ?? ""}。这是 UIX 偏好,不会影响必选门禁。`,
          `Switching from ${current} to ${pending ?? ""}. This is a UIX preference and does not change required gates.`,
        )}
        confirmLabel={localize(locale, "保存", "Save")}
        cancelLabel={localize(locale, "取消", "Cancel")}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </ShellCard>
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
