import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, ExternalLink, QrCode, RefreshCw, Route, Search, ShieldCheck } from "lucide-react";
import QRCode from "qrcode";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { healthApi } from "@/lib/api/health";
import { providersApi } from "@/lib/api/providers";
import type { FridayProviderMutationPlan } from "@/lib/api/providers";
import {
  ProviderMutationDeclinedError,
  ProviderRoutingAfterSaveError,
  saveProviderWithRouting,
  setRoutingWithConfirmation,
} from "@/lib/providers";
import { createProviderApprovalAuthor, getDeviceKeyProvider } from "@/lib/auth/device-key";
import { setupApi } from "@/lib/api/setup";
import { discoveryApi } from "@/lib/api/discovery";
import type { DiscoveredProgram, IntegrationRecommendation } from "@/lib/api/discovery";
import { scanMigrateApi } from "@/lib/api/scan-migrate";
import type { BatchConvertResult, LocalSkillScanItem } from "@/lib/api/scan-migrate";
import { getIntegrationDescription } from "@/lib/discovery/integration-descriptions";
import {
  FRIDAY_ASSISTANT_STARTER_TASKS,
  getAssistantStarterTask,
} from "@/lib/assistant/starter-tasks";
import type {
  AuthMode,
  ProviderApi,
  ProviderKind,
  SetupStepId,
} from "@/lib/setup/types";
import type { FridayModelRoutingConfig, FridayProviderTemplate, FridayProviderValidationState } from "@/lib/api/types";
import { classifyFridaySaveProviderValidation } from "@/lib/setup/setup-status-diagnostics";
import { ActionButton, ConfirmDialog, StatusPill } from "@/components/core/primitives";
import { localize, type AppLocale } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import { CHANNEL_META } from "@/lib/channels/channel-meta";
import type { ChannelKind } from "@/lib/setup/types";
import {
  SETUP_CHANNEL_CONTROL_CONFIRMATION,
  SETUP_CHANNEL_CONTROL_GUARDS,
  SETUP_CHANNEL_CONTROL_ROUTE_STEPS,
} from "@/lib/setup/channel-control-route";
import { useSaveChannelsMutation } from "@/hooks/use-setup";
import {
  FRIDAY_SETUP_READINESS_SESSION_KEY,
  FridayReadinessSummaryPanel,
} from "@/components/setup/friday-readiness-summary";
import {
  defaultConnectionModeForProvider,
  resolveKeyAuthMode,
  supportsKeyConnection,
  supportsUseMyPlan,
  type ProviderConnectionMode,
} from "@/lib/providers/provider-connection";

export const SETUP_CHANNEL_KINDS_ORDERED: ChannelKind[] = ["telegram", "discord", "feishu"];
const SETUP_KEY_AUTH_MODES: readonly AuthMode[] = ["api-key", "bearer-token", "token"];

export const SETUP_VISIBLE_PROVIDER_KINDS = {
  international: ["openai", "openai-codex", "anthropic", "openrouter", "xai", "mistral", "groq"],
  china: ["deepseek", "moonshot", "qwen", "kimi-coding"],
} as const satisfies Record<"international" | "china", readonly ProviderKind[]>;

function isSetupReadyProviderTemplate(template: FridayProviderTemplate): boolean {
  const canConnectWithCredential = SETUP_KEY_AUTH_MODES.some((mode) => template.authModes.includes(mode));
  const canConnectWithPlan = supportsUseMyPlan(template.providerKind, template);
  return template.status === "ready"
    && template.baseUrlHints.length > 0
    && (canConnectWithCredential || canConnectWithPlan);
}

export function getSetupProviderKindsForRegion(
  providerTemplates: readonly FridayProviderTemplate[],
  region: "international" | "china",
): ProviderKind[] {
  const preferredKinds = SETUP_VISIBLE_PROVIDER_KINDS[region];
  if (providerTemplates.length === 0) {
    return [...preferredKinds];
  }
  const templatesByKind = new Map(providerTemplates.map((template) => [template.providerKind, template]));
  return preferredKinds.filter((kind) => {
    const template = templatesByKind.get(kind);
    return template ? isSetupReadyProviderTemplate(template) : false;
  });
}

// ─── Provider recommendation helper (unchanged) ───

type SetupProviderRecommendation = {
  backend: string;
  auth: string;
  why: string;
  boundary: string;
  operatorNote: string;
};

type ProviderSaveDraft = {
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  authMode: AuthMode;
  api: ProviderApi;
  apiKey?: string;
  supportedModels: string[];
  defaultModel?: string;
};

type ProviderSetupFeedback = {
  status: "idle" | "checking" | "saved" | "error";
  kind?: ProviderKind;
  defaultModel?: string;
  message?: string;
  warnings: string[];
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

type ChannelTestState = {
  validated: boolean;
  message: string;
  warnings: string[];
};

type SetupCompletionStepStateInput = {
  providerValidated: boolean;
  channelsSaved: boolean;
  skillsPromoted: boolean;
};

export function buildSetupCompletionStepState(input: SetupCompletionStepStateInput): {
  completedSteps: SetupStepId[];
  skippedSteps: SetupStepId[];
} {
  const completedSteps: SetupStepId[] = [
    "welcome",
    "security",
    ...(input.providerValidated ? (["provider"] as const) : []),
    ...(input.channelsSaved ? (["channels"] as const) : []),
    ...(input.skillsPromoted ? (["skills"] as const) : []),
    "done",
  ];
  const skippedSteps: SetupStepId[] = [
    "communication",
    ...(input.providerValidated ? [] : (["provider"] as const)),
    ...(input.channelsSaved ? [] : (["channels"] as const)),
    "network",
    ...(input.skillsPromoted ? [] : (["skills"] as const)),
  ];
  return { completedSteps, skippedSteps };
}

/**
 * Truthful setup-completion headline. Distinguishes "runtime ready" from "AI
 * provider ready": when the provider step was skipped (not validated) we must
 * NOT claim Friday is ready — the runtime is up but no AI provider is connected
 * yet. The per-capability readiness panel carries the detailed truth.
 */
export function buildSetupCompletionTitle(
  locale: AppLocale,
  providerValidated: boolean,
): { title: string; subtitle: string | null } {
  if (providerValidated) {
    return { title: localize(locale, "Friday 已就绪", "Friday is Ready"), subtitle: null };
  }
  return {
    title: localize(locale, "设置已保存", "Setup saved"),
    subtitle: localize(
      locale,
      "运行环境已就绪。连接一个 AI 提供方后 Friday 才能开始工作——详情见下方。",
      "The runtime is ready. Connect an AI provider before Friday can work — see the details below.",
    ),
  };
}

type FeishuRegistrationState = {
  status: "idle" | "starting" | "pending" | "success" | "failed";
  registrationId?: string;
  qrUrl?: string;
  qrDataUrl?: string;
  userCode?: string;
  appId?: string;
  ownerOpenId?: string;
  dmVerified?: boolean;
  welcomeMessageId?: string;
  intervalSeconds?: number;
  expiresAt?: string;
  message?: string;
  warnings: string[];
};

type TelegramVerificationState = {
  status: "idle" | "starting" | "pending" | "success" | "failed";
  verificationId?: string;
  botUserId?: string;
  botUsername?: string;
  botName?: string;
  startCode?: string;
  startUrl?: string;
  chatId?: string;
  userId?: string;
  welcomeMessageId?: string;
  expiresAt?: string;
  message?: string;
  warnings: string[];
};

type DiscordVerificationState = {
  status: "idle" | "starting" | "ready" | "success" | "failed";
  verificationId?: string;
  applicationId?: string;
  botUserId?: string;
  botUsername?: string;
  inviteUrl?: string;
  guildId?: string;
  guildVerified?: boolean;
  userId?: string;
  dmVerified?: boolean;
  welcomeMessageId?: string;
  expiresAt?: string;
  message?: string;
  warnings: string[];
};

export function getProviderBootstrapRecommendation(kind: ProviderKind): SetupProviderRecommendation {
  switch (kind) {
    case "openai":
      return {
        backend: "HTTP for native tools, Codex CLI later for consumer-plan text work",
        auth: "API key or bearer token",
        why: "OpenAI HTTP is the reliable path when Friday needs native tools, route fallback, and full run evidence.",
        boundary: "ChatGPT / Codex consumer sessions are intentionally attached later as CLI backends, not reused as HTTP OAuth credentials.",
        operatorNote: "Use Settings after setup if you want to attach Codex CLI for text-only review, analysis, or coding assistance.",
      };
    case "openai-codex":
      return {
        backend: "HTTP Codex Responses",
        auth: "OpenAI Codex device OAuth",
        why: "This connects a Friday user to their own ChatGPT/Codex subscription token for routed provider calls.",
        boundary: "Codex OAuth is per user and should not be shared as a global API key or reused for unrelated OpenAI API billing.",
        operatorNote: "Complete the Codex device login from Settings or the OAuth API before routing live runs to this provider.",
      };
    case "anthropic":
      return {
        backend: "HTTP first, Claude CLI optional later",
        auth: "API key",
        why: "Anthropic HTTP keeps tool-capable runs and verification inside Friday while Claude CLI stays a text-only backend.",
        boundary: "Claude CLI should not be treated as a native-tool backend for runs that require Friday tools.",
        operatorNote: "Attach Claude CLI later in Settings when you want a consumer-plan text route beside the HTTP provider.",
      };
    case "google":
      return {
        backend: "HTTP only",
        auth: "API key",
        why: "Google HTTP is the stable route for tool-capable work and routing explainability.",
        boundary: "The current setup flow does not promise or require a Google CLI backend.",
        operatorNote: "Use Settings later for routing, fallback, and budget policy. Google stays on the HTTP path in the current setup flow.",
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

function localSkillSourceLabel(tool: LocalSkillScanItem["sourceTool"], locale: "zh" | "en"): string {
  const labels: Record<LocalSkillScanItem["sourceTool"], { zh: string; en: string }> = {
    "claude-code": { zh: "Claude Code", en: "Claude Code" },
    cursor: { zh: "Cursor", en: "Cursor" },
    n8n: { zh: "n8n", en: "n8n" },
    codex: { zh: "Codex", en: "Codex" },
    openclaw: { zh: "OpenClaw", en: "OpenClaw" },
    friday: { zh: "Friday", en: "Friday" },
    "local-project": { zh: "本地项目", en: "Local Project" },
    unknown: { zh: "本地文件", en: "Local File" },
  };
  return labels[tool][locale];
}

function summarizeLocalSkillSources(items: LocalSkillScanItem[], locale: "zh" | "en"): string {
  const sourceLabels = Array.from(
    new Set(items.map((item) => localSkillSourceLabel(item.sourceTool, locale))),
  );
  if (sourceLabels.length <= 3) return sourceLabels.join(locale === "zh" ? "、" : ", ");
  const shown = sourceLabels.slice(0, 3).join(locale === "zh" ? "、" : ", ");
  return locale === "zh"
    ? `${shown} 等来源`
    : `${shown}, and other sources`;
}

function isDiscoveryDisabledError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("discovery is disabled")
    || message.includes("friday_discovery_enabled")
    || message.includes("program discovery is disabled");
}

// ─── Step indicator dots ───

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`block h-2 w-2 rounded-full transition-all duration-300 ${
            i < current
              ? "bg-[color:var(--color-accent)]"
              : i === current
                ? "bg-[color:var(--color-accent)] scale-125"
                : "border border-[color:var(--color-border-strong)] bg-transparent"
          }`}
        />
      ))}
    </div>
  );
}

// ─── Main component ───

export function SetupPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { locale, setLocale } = useAppLocale();
  const setupDeepLinkApplied = useRef(false);

  // ── Step state machine ──
  type SetupStep = 0 | 1 | 2 | 3 | 4 | 5;
  const [currentStep, setCurrentStep] = useState<SetupStep>(0);
  const [providerRegion, setProviderRegion] = useState<"international" | "china">(
    locale === "zh" ? "china" : "international",
  );
  const [showRegionLimitedTemplates, setShowRegionLimitedTemplates] = useState<boolean>(false);

  // ── Existing state (kept intact) ──
  const [acknowledgedSecurity, setAcknowledgedSecurity] = useState(false);
  const [providerKind, setProviderKind] = useState<ProviderKind>(locale === "zh" ? "moonshot" : "openai");
  const [providerName, setProviderName] = useState("");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [providerBaseUrl, setProviderBaseUrl] = useState("");
  const [providerModels, setProviderModels] = useState<string[]>([]);
  const [providerDefaultModel, setProviderDefaultModel] = useState("");
  const [providerApi, setProviderApi] = useState<ProviderApi>("openai-responses");
  const [providerAuthMode, setProviderAuthMode] = useState<AuthMode>("api-key");
  const [providerConnectionMode, setProviderConnectionMode] = useState<ProviderConnectionMode>("api-key");
  const [providerCostMode, setProviderCostMode] = useState<RoutingCostMode>("standard");
  const [providerValidated, setProviderValidated] = useState(false);
  const [providerFeedback, setProviderFeedback] = useState<ProviderSetupFeedback>({
    status: "idle",
    warnings: [],
  });
  const [openAICodexOAuth, setOpenAICodexOAuth] = useState<OpenAICodexDeviceOAuthState>({
    status: "idle",
  });
  const [pendingDefaultProviderChoice, setPendingDefaultProviderChoice] = useState<PendingDefaultProviderChoice | null>(null);
  const [routingUpdatePending, setRoutingUpdatePending] = useState(false);
  // CORE-A CR-2: the server-derived provider mutation plan awaiting THIS owner's
  // explicit confirmation. `resolve` is the pending `saveProviderWithValidation`
  // handshake — resolving false aborts before any approval is minted or any
  // mutation is sent. Never auto-confirmed.
  const [pendingProviderPlan, setPendingProviderPlan] = useState<{
    plan: FridayProviderMutationPlan;
    resolve: (confirmed: boolean) => void;
  } | null>(null);
  const hasSetupDeepLink = Boolean(
    searchParams.get("step")
      ?? searchParams.get("providerKind")
      ?? searchParams.get("recipeId"),
  );

  // ── Channel state ──
  const [enabledChannels, setEnabledChannels] = useState<Set<ChannelKind>>(new Set());
  const [channelConfigs, setChannelConfigs] = useState<Record<string, Record<string, string>>>({});
  const [channelsSaved, setChannelsSaved] = useState(false);
  const [expandedChannel, setExpandedChannel] = useState<ChannelKind | null>(null);
  const [advancedChannelConfig, setAdvancedChannelConfig] = useState<Set<ChannelKind>>(new Set());
  const [channelControlConfirmed, setChannelControlConfirmed] = useState(false);
  const [testingChannel, setTestingChannel] = useState<ChannelKind | null>(null);
  const [channelTestStatus, setChannelTestStatus] = useState<Record<string, ChannelTestState>>({});
  const [feishuRegistration, setFeishuRegistration] = useState<FeishuRegistrationState>({
    status: "idle",
    warnings: [],
  });
  const feishuRegistrationPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [telegramVerification, setTelegramVerification] = useState<TelegramVerificationState>({
    status: "idle",
    warnings: [],
  });
  const telegramVerificationPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [discordVerification, setDiscordVerification] = useState<DiscordVerificationState>({
    status: "idle",
    warnings: [],
  });

  // ── Discovery state (new) ──
  const [discoveryScanned, setDiscoveryScanned] = useState(false);
  const [discoveryScanning, setDiscoveryScanning] = useState(false);
  const [discoveredPrograms, setDiscoveredPrograms] = useState<DiscoveredProgram[]>([]);
  const [discoveryRecommendations, setDiscoveryRecommendations] = useState<IntegrationRecommendation[]>([]);
  const [discoveryProgramCount, setDiscoveryProgramCount] = useState(0);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  // ── Skill scan state ──
  const [skillScanItems, setSkillScanItems] = useState<LocalSkillScanItem[]>([]);
  const [skillScanDone, setSkillScanDone] = useState(false);
  const [skillScanLoading, setSkillScanLoading] = useState(false);
  const [skillScanError, setSkillScanError] = useState<string | null>(null);
  const [selectedSkillPaths, setSelectedSkillPaths] = useState<Set<string>>(new Set());
  const [skillImporting, setSkillImporting] = useState(false);
  const [skillImportResult, setSkillImportResult] = useState<BatchConvertResult | null>(null);
  // ── Existing queries ──

  const { data: setupStatus } = useQuery({
    queryKey: ["setup", "status"],
    queryFn: () => setupApi.getStatus(),
    staleTime: 5_000,
    retry: 0,
  });

  const capabilityHealthQuery = useQuery({
    queryKey: ["health", "capabilities", "setup"],
    queryFn: () => healthApi.getCapabilityHealth(),
    refetchInterval: currentStep === 5 ? 12_000 : false,
    staleTime: 5_000,
    retry: 0,
  });
  const refetchCapabilityHealth = capabilityHealthQuery.refetch;

  useEffect(() => {
    if (currentStep === 5) {
      void refetchCapabilityHealth();
    }
  }, [currentStep, refetchCapabilityHealth]);

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

  const { data: routingConfig } = useQuery({
    queryKey: ["setup", "routing-config"],
    queryFn: () => providersApi.getRouting(),
    retry: 0,
  });

  useEffect(() => {
    if (routingConfig?.costMode) {
      setProviderCostMode(routingConfig.costMode);
    }
  }, [routingConfig?.costMode]);

  // ── Redirects ──

  useEffect(() => {
    if (setupStatus && !setupStatus.needsSetup && !hasSetupDeepLink) {
      navigate("/home", { replace: true });
    }
  }, [hasSetupDeepLink, navigate, setupStatus]);

  useEffect(() => () => {
    if (feishuRegistrationPollTimer.current) {
      clearTimeout(feishuRegistrationPollTimer.current);
    }
    if (telegramVerificationPollTimer.current) {
      clearTimeout(telegramVerificationPollTimer.current);
    }
  }, []);

  // Note: during first-run setup we intentionally do NOT pre-fill from existingProviders.
  // The user should configure from scratch. Existing provider data is only relevant
  // when re-visiting setup, which is handled by the template applicator below.

  // Auto-apply template when provider kind changes or templates load
  useEffect(() => {
    if (providerTemplates.length === 0) return;
    if (hasSetupDeepLink && !setupDeepLinkApplied.current) return;
    applyProviderTemplate(providerKind);
  }, [hasSetupDeepLink, providerKind, providerTemplates.length]);

  useEffect(() => {
    if (setupDeepLinkApplied.current) return;

    const step = searchParams.get("step");
    const requestedChannel = searchParams.get("channel");
    const channelKind = SETUP_CHANNEL_KINDS_ORDERED.find((kind) => kind === requestedChannel);

    if (step !== "channels" && !channelKind) return;

    setCurrentStep(4);
    if (channelKind) {
      setEnabledChannels((prev) => new Set([...prev, channelKind]));
      setExpandedChannel(channelKind);
    }
    setupDeepLinkApplied.current = true;
  }, [searchParams]);

  useEffect(() => {
    if (setupDeepLinkApplied.current || providerTemplates.length === 0) return;

    const step = searchParams.get("step");
    const recipeId = searchParams.get("recipeId");
    const providerKindParam = searchParams.get("providerKind");
    const recipeProviderKind = recipeId?.startsWith("provider-")
      ? recipeId.slice("provider-".length)
      : undefined;
    const requestedProviderKind = providerKindParam ?? recipeProviderKind;

    if (step !== "provider" && !requestedProviderKind) return;

    const template = providerTemplates.find((candidate) =>
      candidate.providerKind === requestedProviderKind,
    );
    if (template) {
      setProviderRegion(template.regionTag === "china" ? "china" : "international");
      applyProviderTemplate(template.providerKind);
    }
    setCurrentStep(2);
    setupDeepLinkApplied.current = true;
  }, [providerTemplates, searchParams]);

  // ── Template applicator ──

  const selectedTemplate = useMemo(
    () => providerTemplates.find((template) => template.providerKind === providerKind) ?? null,
    [providerKind, providerTemplates],
  );

  function selectProviderConnectionMode(mode: ProviderConnectionMode): void {
    setProviderConnectionMode(mode);
    setProviderAuthMode(mode === "use-my-plan" ? "oauth" : resolveKeyAuthMode(selectedTemplate));
    setProviderValidated(false);
    setProviderFeedback({ status: "idle", warnings: [] });
    setOpenAICodexOAuth({ status: "idle" });
  }

  function applyProviderTemplate(templateId: ProviderKind): void {
    const template = providerTemplates.find((item) => item.providerKind === templateId);
    setProviderKind(templateId);
    setProviderFeedback({ status: "idle", warnings: [] });
    if (!template) {
      setProviderValidated(false);
      return;
    }
    setProviderName(`${template.displayName} Provider`);
    setProviderBaseUrl(template.baseUrlHints[0] ?? "");
    setProviderApi(template.api);
    const nextConnectionMode = defaultConnectionModeForProvider(templateId, template);
    setProviderConnectionMode(nextConnectionMode);
    setProviderAuthMode(nextConnectionMode === "use-my-plan" ? "oauth" : resolveKeyAuthMode(template));
    const modelExamples = template.modelDefaults.examples ?? [];
    setProviderModels(modelExamples);
    setProviderDefaultModel(
      template.modelDefaults.recommended
        ?? template.modelDefaults.fallback
        ?? modelExamples[0]
        ?? "",
    );
    setProviderValidated(false);
    setOpenAICodexOAuth({ status: "idle" });
  }

  function providerDisplayName(kind: ProviderKind): string {
    return providerTemplates.find((template) => template.providerKind === kind)?.displayName ?? titleCase(kind);
  }

  function buildCurrentProviderSaveDraft(): ProviderSaveDraft {
    return {
      kind: providerKind,
      name: providerName.trim() || `${providerDisplayName(providerKind)} Provider`,
      baseUrl: providerBaseUrl.trim(),
      authMode: providerAuthMode,
      api: providerApi,
      apiKey: providerApiKey.trim() || undefined,
      supportedModels: providerModels,
      defaultModel: providerDefaultModel.trim() || undefined,
    };
  }

  // SEC-APPROVAL-AUTHORITY-001 (CR-2): the owner DEVICE authors provider approvals.
  // The Hub holds no signing key — this author signs a P-256 transcript with the
  // durable device key the owner bootstrap created.
  const providerApprovalAuthor = useMemo(
    () => createProviderApprovalAuthor(getDeviceKeyProvider()),
    [],
  );

  // The owner reviews the SERVER-derived, secret-free plan summary and explicitly
  // confirms before any device approval is authored. Resolving false aborts.
  function confirmProviderPlan(plan: FridayProviderMutationPlan): Promise<boolean> {
    return new Promise<boolean>((resolve) => setPendingProviderPlan({ plan, resolve }));
  }

  async function saveProviderDraft(
    draft: ProviderSaveDraft,
  ): Promise<{ validation: FridayProviderValidationState | undefined }> {
    const existingSameKind = existingProviders.find((provider) => provider.kind === draft.kind);
    const commonPayload = {
      name: draft.name,
      baseUrl: draft.baseUrl,
      authMode: draft.authMode,
      api: draft.api,
      apiKey: draft.apiKey,
      supportedModels: draft.supportedModels,
      defaultModel: draft.defaultModel,
      enabled: true,
    };

    // Validate-before-persist via the same live create/update path the Settings
    // page uses (validateOnSave: true), then set default-routing as PART of the
    // SAME owner-reviewed operation. Advisor #1628 finding #3: routing is a first
    // class confirmed, device-authored mutation, so it can NEVER 403-after-persist
    // and strand a created-but-unrouted provider.
    const response = await saveProviderWithRouting(
      providersApi,
      existingSameKind,
      { kind: draft.kind, ...commonPayload },
      (provider) => ({
        defaultProviderId: provider.id,
        defaultModel: draft.defaultModel,
        fallbackProviderIds: [],
        costMode: providerCostMode,
        enforceRequestedModel: routingConfig?.enforceRequestedModel,
      }),
      confirmProviderPlan,
      providerApprovalAuthor,
    );

    return { validation: response.validation };
  }

  async function setProviderAsDefault(providerId: string, defaultModel?: string): Promise<void> {
    setRoutingUpdatePending(true);
    try {
      await setRoutingWithConfirmation(
        providersApi,
        {
          defaultProviderId: providerId,
          defaultModel,
          fallbackProviderIds: (routingConfig?.fallbackProviderIds ?? []).filter((id) => id !== providerId),
          costMode: providerCostMode,
          enforceRequestedModel: routingConfig?.enforceRequestedModel,
        },
        confirmProviderPlan,
        providerApprovalAuthor,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["setup", "routing-config"] }),
        queryClient.invalidateQueries({ queryKey: ["setup", "providers"] }),
        queryClient.invalidateQueries({ queryKey: ["shell", "provider-truth"] }),
      ]);
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

  async function startOpenAICodexDeviceOAuth(): Promise<void> {
    setOpenAICodexOAuth({ status: "starting" });
    setProviderFeedback({ status: "checking", kind: "openai-codex", warnings: [] });
    try {
      const existingOAuthProvider = existingProviders.find((provider) =>
        provider.kind === "openai-codex" && provider.config.authMode === "oauth"
      );
      const oauth = await providersApi.initiateOpenAICodexDeviceOAuth(existingOAuthProvider?.id);
      setProviderAuthMode("oauth");
      setProviderKind("openai-codex");
      setOpenAICodexOAuth({
        status: "pending",
        providerId: oauth.providerId,
        deviceCodeId: oauth.deviceCodeId,
        verificationUrl: oauth.verificationUrl,
        userCode: oauth.userCode,
        expiresAt: oauth.expiresAt,
      });
      setProviderFeedback({
        status: "idle",
        warnings: [],
      });
      window.open(oauth.verificationUrl, "_blank", "noopener,noreferrer");
      toast.success(localize(locale, "请在浏览器中完成 OpenAI 授权", "Complete OpenAI authorization in your browser"));
    } catch (error) {
      const message = error instanceof Error ? error.message : localize(locale, "无法启动 OpenAI 授权", "Could not start OpenAI authorization");
      setOpenAICodexOAuth({ status: "error", message });
      setProviderFeedback({
        status: "error",
        kind: "openai-codex",
        message,
        warnings: [],
      });
      toast.error(message);
    }
  }

  async function completeOpenAICodexDeviceOAuth(options: { advance: boolean }): Promise<void> {
    if (!openAICodexOAuth.deviceCodeId) {
      toast.error(localize(locale, "请先开始 OpenAI 授权", "Start OpenAI authorization first"));
      return;
    }
    setOpenAICodexOAuth((current) => ({ ...current, status: "completing", message: undefined }));
    setProviderFeedback({ status: "checking", kind: "openai-codex", warnings: [] });
    try {
      const oauth = await providersApi.completeOpenAICodexDeviceOAuth({
        providerId: openAICodexOAuth.providerId,
        deviceCodeId: openAICodexOAuth.deviceCodeId,
      });
      const provider = existingProviders.find((item) => item.id === oauth.providerId);
      const connectedProviderName = provider?.name ?? "OpenAI Codex";
      setProviderValidated(true);
      setProviderKind("openai-codex");
      setProviderAuthMode("oauth");
      setProviderFeedback({
        status: "saved",
        kind: "openai-codex",
        defaultModel: providerDefaultModel,
        warnings: [],
      });
      setOpenAICodexOAuth({
        status: "connected",
        providerId: oauth.providerId,
        deviceCodeId: openAICodexOAuth.deviceCodeId,
        verificationUrl: openAICodexOAuth.verificationUrl,
        userCode: openAICodexOAuth.userCode,
        expiresAt: oauth.expiresAt,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["setup", "providers"] }),
        queryClient.invalidateQueries({ queryKey: ["setup", "provider-health"] }),
        queryClient.invalidateQueries({ queryKey: ["shell", "provider-truth"] }),
      ]);
      await promptOrSetDefaultProvider({
        providerId: oauth.providerId,
        providerName: connectedProviderName,
        defaultModel: providerDefaultModel || undefined,
      });
      toast.success(localize(locale, "OpenAI 账号已连接", "OpenAI account connected"));
      if (options.advance && !routingConfig?.defaultProviderId) {
        goNext();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : localize(locale, "OpenAI 授权未完成", "OpenAI authorization is not complete yet");
      setOpenAICodexOAuth((current) => ({ ...current, status: "error", message }));
      setProviderFeedback({
        status: "error",
        kind: "openai-codex",
        message,
        warnings: [],
      });
      toast.error(message);
    }
  }

  // ── Mutations ──

  const saveProviderMutation = useMutation({
    mutationFn: (draft?: ProviderSaveDraft) => saveProviderDraft(draft ?? buildCurrentProviderSaveDraft()),
    onMutate: () => {
      setProviderFeedback({
        status: "checking",
        kind: providerKind,
        warnings: [],
      });
    },
    onSuccess: () => {
      toast.success(localize(locale, "提供方已保存", "Provider saved"));
      setProviderValidated(true);
      void queryClient.invalidateQueries({ queryKey: ["setup", "providers"] });
      void queryClient.invalidateQueries({ queryKey: ["shell", "provider-truth"] });
    },
    onError: (error) => {
      // CORE-A CR-2: the owner reviewed the server-derived plan and declined it.
      // No canonical approval was minted and no mutation was sent — this is a
      // deliberate cancel, NOT a validation failure, so it must not be surfaced
      // as an error state (which would wrongly imply the key was rejected).
      if (error instanceof ProviderMutationDeclinedError) {
        setProviderFeedback({
          status: "idle",
          kind: providerKind,
          message: localize(locale, "已取消：未保存任何更改。", "Cancelled — nothing was saved."),
          warnings: [],
        });
        return;
      }
      // Advisor #1628 finding #3: the provider WAS saved but its default-routing
      // could not be set. Report the partial state TRUTHFULLY (the provider exists)
      // instead of implying the key was rejected. The provider was validated, so
      // mark it validated and tell the owner to finish routing from the list.
      if (error instanceof ProviderRoutingAfterSaveError) {
        setProviderValidated(true);
        void queryClient.invalidateQueries({ queryKey: ["setup", "providers"] });
        void queryClient.invalidateQueries({ queryKey: ["shell", "provider-truth"] });
        setProviderFeedback({
          status: "error",
          kind: providerKind,
          message: localize(
            locale,
            `提供方“${error.provider.name}”已保存，但默认路由未设置。请在提供方列表中将其设为默认。`,
            `Provider "${error.provider.name}" was saved, but default routing was not set. Set it as default from the provider list.`,
          ),
          warnings: [],
        });
        toast.error(localize(locale, "提供方已保存，但路由未设置", "Provider saved, but routing was not set"));
        return;
      }
      // Validate-before-persist rejected the key (e.g. invalid / unreachable):
      // it was NOT persisted. Surface the invalid state, do not advance.
      setProviderValidated(false);
      const message = error instanceof Error ? error.message : localize(locale, "保存提供方失败", "Failed to save provider");
      setProviderFeedback({
        status: "error",
        kind: providerKind,
        message,
        warnings: [],
      });
      toast.error(message);
    },
  });

  const saveChannelsMutation = useSaveChannelsMutation();

  function isLarkLikeChannel(kind: ChannelKind): boolean {
    return kind === "lark" || kind === "feishu";
  }

  function isFeishuQrChannel(kind: ChannelKind): boolean {
    return kind === "feishu";
  }

  function buildChannelConfigForSave(kind: ChannelKind): Record<string, string> {
    const config = { ...(channelConfigs[kind] ?? {}) };
    if (kind === "feishu") {
      config.useFeishu = "true";
      config.receiveMode = "websocket";
    } else if (kind === "telegram" && telegramVerification.status === "success" && telegramVerification.verificationId) {
      config.setupVerificationId = telegramVerification.verificationId;
    } else if (kind === "discord" && discordVerification.status === "success" && discordVerification.verificationId) {
      config.setupVerificationId = discordVerification.verificationId;
    } else if (isLarkLikeChannel(kind) && !config.receiveMode) {
      config.receiveMode = "websocket";
    }
    return config;
  }

  function clearFeishuRegistrationPoll(): void {
    if (feishuRegistrationPollTimer.current) {
      clearTimeout(feishuRegistrationPollTimer.current);
      feishuRegistrationPollTimer.current = null;
    }
  }

  function clearTelegramVerificationPoll(): void {
    if (telegramVerificationPollTimer.current) {
      clearTimeout(telegramVerificationPollTimer.current);
      telegramVerificationPollTimer.current = null;
    }
  }

  function updateFeishuRegistrationConfig(input: {
    registrationId: string;
    appId?: string;
    ownerOpenId?: string;
  }): void {
    setChannelConfigs((prev) => {
      const existing = prev.feishu ?? {};
      return {
        ...prev,
        feishu: {
          ...existing,
          registrationId: input.registrationId,
          ...(input.appId ? { appId: input.appId } : {}),
          ...(input.ownerOpenId && !existing.allowedUsers ? { allowedUsers: input.ownerOpenId } : {}),
          receiveMode: "websocket",
          useFeishu: "true",
        },
      };
    });
  }

  function scheduleFeishuRegistrationPoll(registrationId: string, delaySeconds: number): void {
    clearFeishuRegistrationPoll();
    feishuRegistrationPollTimer.current = setTimeout(() => {
      void pollFeishuRegistration(registrationId);
    }, Math.max(delaySeconds, 2) * 1000);
  }

  async function startFeishuRegistration(): Promise<void> {
    clearFeishuRegistrationPoll();
    setFeishuRegistration({ status: "starting", warnings: [] });
    try {
      const result = await setupApi.beginFeishuRegistration();
      const qrDataUrl = await QRCode.toDataURL(result.qrUrl, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 220,
      });
      updateFeishuRegistrationConfig({ registrationId: result.registrationId });
      setFeishuRegistration({
        status: "pending",
        registrationId: result.registrationId,
        qrUrl: result.qrUrl,
        qrDataUrl,
        userCode: result.userCode,
        intervalSeconds: result.intervalSeconds,
        expiresAt: result.expiresAt,
        warnings: result.warnings,
      });
      scheduleFeishuRegistrationPoll(result.registrationId, result.intervalSeconds);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : localize(locale, "无法创建飞书扫码流程", "Could not start Feishu QR setup");
      setFeishuRegistration({ status: "failed", message, warnings: [] });
      toast.error(message);
    }
  }

  async function pollFeishuRegistration(registrationId: string): Promise<void> {
    try {
      const result = await setupApi.pollFeishuRegistration({ registrationId });
      if (result.status === "success") {
        clearFeishuRegistrationPoll();
        updateFeishuRegistrationConfig({
          registrationId: result.registrationId,
          appId: result.appId,
          ownerOpenId: result.ownerOpenId ?? result.suggestedAllowedUsers?.[0],
        });
        setFeishuRegistration((prev) => ({
          ...prev,
          status: "success",
          registrationId: result.registrationId,
          appId: result.appId,
          ownerOpenId: result.ownerOpenId ?? result.suggestedAllowedUsers?.[0],
          dmVerified: result.dmVerified === true,
          welcomeMessageId: result.welcomeMessageId,
          expiresAt: result.expiresAt ?? prev.expiresAt,
          warnings: result.warnings,
        }));
        toast.success(localize(locale, "飞书私聊已验证", "Feishu private chat verified"));
        return;
      }

      if (result.status === "pending" || result.status === "slow_down") {
        setFeishuRegistration((prev) => ({
          ...prev,
          status: "pending",
          intervalSeconds: result.intervalSeconds ?? prev.intervalSeconds,
          expiresAt: result.expiresAt ?? prev.expiresAt,
          warnings: result.warnings,
        }));
        scheduleFeishuRegistrationPoll(registrationId, result.intervalSeconds ?? feishuRegistration.intervalSeconds ?? 5);
        return;
      }

      clearFeishuRegistrationPoll();
      const message = result.status === "dm_failed"
        ? (result.message ?? localize(locale, "Friday 已创建飞书应用，但无法发送欢迎私聊", "Friday created the Feishu app but could not send a welcome private message"))
        : result.status === "access_denied"
        ? localize(locale, "飞书扫码已取消", "Feishu QR authorization was denied")
        : result.status === "expired"
          ? localize(locale, "飞书二维码已过期，请重新生成", "Feishu QR code expired. Start again.")
          : (result.message ?? localize(locale, "飞书扫码创建失败", "Feishu QR setup failed"));
      setFeishuRegistration((prev) => ({
        ...prev,
        status: "failed",
        message,
        warnings: result.warnings,
      }));
      toast.error(message);
    } catch (error) {
      clearFeishuRegistrationPoll();
      const message = error instanceof Error
        ? error.message
        : localize(locale, "飞书扫码状态检查失败", "Feishu QR status check failed");
      setFeishuRegistration((prev) => ({ ...prev, status: "failed", message, warnings: [] }));
      toast.error(message);
    }
  }

  function scheduleTelegramVerificationPoll(verificationId: string, delaySeconds = 2): void {
    clearTelegramVerificationPoll();
    telegramVerificationPollTimer.current = setTimeout(() => {
      void pollTelegramVerification(verificationId);
    }, Math.max(delaySeconds, 2) * 1000);
  }

  async function startTelegramVerification(): Promise<void> {
    const botToken = (channelConfigs.telegram?.botToken ?? "").trim();
    if (!botToken) {
      toast.error(localize(locale, "请先填写 Telegram Bot Token", "Enter the Telegram Bot Token first"));
      return;
    }
    clearTelegramVerificationPoll();
    setTelegramVerification({ status: "starting", warnings: [] });
    try {
      const result = await setupApi.beginTelegramVerification({ botToken });
      setTelegramVerification({
        status: "pending",
        verificationId: result.verificationId,
        botUserId: result.botUserId,
        botUsername: result.botUsername,
        botName: result.botName,
        startCode: result.startCode,
        startUrl: result.startUrl,
        expiresAt: result.expiresAt,
        warnings: result.warnings,
      });
      scheduleTelegramVerificationPoll(result.verificationId);
      toast.success(localize(locale, "Telegram token 已验证，请打开机器人发送验证码", "Telegram token verified. Open the bot and send the setup code."));
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : localize(locale, "Telegram 验证启动失败", "Telegram verification could not start");
      setTelegramVerification({ status: "failed", message, warnings: [] });
      toast.error(message);
    }
  }

  async function pollTelegramVerification(verificationId: string): Promise<void> {
    try {
      const result = await setupApi.pollTelegramVerification({ verificationId });
      if (result.status === "success") {
        clearTelegramVerificationPoll();
        setTelegramVerification((prev) => ({
          ...prev,
          status: "success",
          verificationId: result.verificationId,
          botUserId: result.botUserId ?? prev.botUserId,
          botUsername: result.botUsername ?? prev.botUsername,
          chatId: result.chatId,
          userId: result.userId,
          welcomeMessageId: result.welcomeMessageId,
          expiresAt: result.expiresAt ?? prev.expiresAt,
          warnings: result.warnings,
        }));
        toast.success(localize(locale, "Telegram 私聊已验证", "Telegram private chat verified"));
        return;
      }

      if (result.status === "pending") {
        setTelegramVerification((prev) => ({
          ...prev,
          status: "pending",
          botUserId: result.botUserId ?? prev.botUserId,
          botUsername: result.botUsername ?? prev.botUsername,
          expiresAt: result.expiresAt ?? prev.expiresAt,
          warnings: result.warnings,
        }));
        scheduleTelegramVerificationPoll(verificationId);
        return;
      }

      clearTelegramVerificationPoll();
      const message = result.message
        ?? (result.status === "expired"
          ? localize(locale, "Telegram 验证已过期，请重新开始", "Telegram verification expired. Start again.")
          : localize(locale, "Telegram 验证失败", "Telegram verification failed"));
      setTelegramVerification((prev) => ({
        ...prev,
        status: "failed",
        message,
        warnings: result.warnings,
      }));
      toast.error(message);
    } catch (error) {
      clearTelegramVerificationPoll();
      const message = error instanceof Error
        ? error.message
        : localize(locale, "Telegram 验证状态检查失败", "Telegram verification check failed");
      setTelegramVerification((prev) => ({ ...prev, status: "failed", message, warnings: [] }));
      toast.error(message);
    }
  }

  async function startDiscordVerification(): Promise<void> {
    const token = (channelConfigs.discord?.token ?? "").trim();
    if (!token) {
      toast.error(localize(locale, "请先填写 Discord Bot Token", "Enter the Discord Bot Token first"));
      return;
    }
    setDiscordVerification({ status: "starting", warnings: [] });
    try {
      const result = await setupApi.beginDiscordVerification({
        token,
        guildId: channelConfigs.discord?.guildId?.trim() || undefined,
      });
      setDiscordVerification({
        status: "ready",
        verificationId: result.verificationId,
        applicationId: result.applicationId,
        botUserId: result.botUserId,
        botUsername: result.botUsername,
        inviteUrl: result.inviteUrl,
        guildId: result.guildId,
        guildVerified: result.guildVerified,
        expiresAt: result.expiresAt,
        warnings: result.warnings,
      });
      toast.success(localize(locale, "Discord token 已验证", "Discord token verified"));
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : localize(locale, "Discord 验证启动失败", "Discord verification could not start");
      setDiscordVerification({ status: "failed", message, warnings: [] });
      toast.error(message);
    }
  }

  async function completeDiscordVerification(): Promise<void> {
    const verificationId = discordVerification.verificationId;
    const userId = (channelConfigs.discord?.setupUserId ?? "").trim();
    if (!verificationId) {
      toast.error(localize(locale, "请先验证 Discord token", "Verify the Discord token first"));
      return;
    }
    if (!userId) {
      toast.error(localize(locale, "请填写你的 Discord 用户 ID", "Enter your Discord user ID"));
      return;
    }
    setDiscordVerification((prev) => ({ ...prev, status: "starting", message: undefined }));
    try {
      const result = await setupApi.completeDiscordVerification({
        verificationId,
        userId,
        guildId: channelConfigs.discord?.guildId?.trim() || undefined,
      });
      if (result.status === "success") {
        setDiscordVerification((prev) => ({
          ...prev,
          status: "success",
          verificationId: result.verificationId,
          applicationId: result.applicationId ?? prev.applicationId,
          botUserId: result.botUserId ?? prev.botUserId,
          botUsername: result.botUsername ?? prev.botUsername,
          guildId: result.guildId ?? prev.guildId,
          guildVerified: result.guildVerified ?? prev.guildVerified,
          userId: result.userId,
          dmVerified: result.dmVerified,
          welcomeMessageId: result.welcomeMessageId,
          warnings: result.warnings,
        }));
        toast.success(localize(locale, "Discord 私聊已验证", "Discord private DM verified"));
        return;
      }
      const message = result.message
        ?? (result.status === "expired"
          ? localize(locale, "Discord 验证已过期，请重新开始", "Discord verification expired. Start again.")
          : localize(locale, "Discord 私聊验证失败", "Discord DM verification failed"));
      setDiscordVerification((prev) => ({
        ...prev,
        status: "failed",
        guildId: result.guildId ?? prev.guildId,
        guildVerified: result.guildVerified ?? prev.guildVerified,
        userId: result.userId ?? userId,
        dmVerified: result.dmVerified,
        message,
        warnings: result.warnings,
      }));
      toast.error(message);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : localize(locale, "Discord 私聊验证失败", "Discord DM verification failed");
      setDiscordVerification((prev) => ({ ...prev, status: "failed", message, warnings: [] }));
      toast.error(message);
    }
  }

  useEffect(() => {
    if (enabledChannels.has("feishu") && expandedChannel === "feishu" && feishuRegistration.status === "idle") {
      void startFeishuRegistration();
    }
  }, [enabledChannels, expandedChannel, feishuRegistration.status]);

  function validateAndSaveProvider(options: { advance: boolean }): void {
    if (!providerApiKey.trim()) {
      toast.error(localize(locale, "请先输入 API 密钥", "Please enter an API key first"));
      return;
    }
    // Validate-before-persist via the SAME live create path the Settings page
    // uses (providersApi.create/update with validateOnSave:true). Friday
    // validates the selected provider and will not switch to another provider
    // automatically; this no longer depends on the retired /v1/providers/detect
    // route (which is fail-closed 503 in the default runtime). An invalid key is
    // rejected here (handled by the mutation's onError) and never persisted.
    saveProviderMutation.mutate(buildCurrentProviderSaveDraft(), {
      onSuccess: ({ validation }) => {
        const verdict = classifyFridaySaveProviderValidation(validation);
        const savedProviderName = providerDisplayName(providerKind);
        if (verdict === "validation_failed") {
          setProviderFeedback({
            status: "error",
            kind: providerKind,
            message: localize(
              locale,
              `${savedProviderName} 已保存，但后端验证未通过。请到设置中重新验证；详情可通过 doctor 检查。`,
              `${savedProviderName} was saved, but backend validation did not pass. Re-validate from Settings; check the doctor report for details.`,
            ),
            warnings: [],
          });
        } else {
          setProviderFeedback({
            status: "saved",
            kind: providerKind,
            defaultModel: providerDefaultModel.trim() || providerModels[0],
            warnings: [],
          });
        }
        if (options.advance) {
          goNext();
        }
      },
    });
  }

  function handleSaveChannels() {
    if (enabledChannels.has("feishu") && feishuRegistration.status !== "success") {
      toast.error(localize(locale, "请先完成飞书扫码创建", "Finish Feishu QR setup first"));
      return;
    }
    if (enabledChannels.has("telegram") && telegramVerification.status !== "success") {
      toast.error(localize(locale, "请先完成 Telegram 私聊验证", "Finish Telegram private chat verification first"));
      return;
    }
    if (enabledChannels.has("discord") && discordVerification.status !== "success") {
      toast.error(localize(locale, "请先完成 Discord 私聊验证", "Finish Discord private DM verification first"));
      return;
    }
    const channelsPayload = Array.from(enabledChannels).map((kind) => ({
      kind,
      enabled: true,
      config: buildChannelConfigForSave(kind),
    }));
    saveChannelsMutation.mutate(
      { channels: channelsPayload, controlConfirmed: enabledChannels.size > 0 ? channelControlConfirmed : undefined },
      {
        onSuccess: (result) => {
          const activation = result.activation;
          if (activation?.failed.length) {
            toast.error(
              localize(
                locale,
                `渠道已保存，但 ${activation.failed[0]!.kind} 未能启动：${activation.failed[0]!.message}`,
                `Channels saved, but ${activation.failed[0]!.kind} did not start: ${activation.failed[0]!.message}`,
              ),
            );
            setChannelsSaved(true);
            return;
          }
          if (activation?.restartRequired) {
            toast.warning(
              activation.warnings[0]
                ?? localize(locale, "渠道已保存，重启 Friday 后生效。", "Channels saved. Restart Friday to activate them."),
            );
            setChannelsSaved(true);
            return;
          }
          setChannelsSaved(true);
          toast.success(
            activation?.startedKinds.length
              ? localize(locale, "渠道已保存并启动，可以回到聊天应用验证。", "Channels saved and started. You can verify in the chat app.")
              : localize(locale, "渠道已保存", "Channels saved"),
          );
          goNext();
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : localize(locale, "保存渠道失败", "Failed to save channels"));
        },
      },
    );
  }

  async function handleTestChannel(kind: ChannelKind): Promise<void> {
    const config = buildChannelConfigForSave(kind);
    const appId = config.appId?.trim() ?? "";
    const appSecret = config.appSecret?.trim() ?? "";
    if (kind === "lark" && (!appId || !appSecret)) {
      toast.error(localize(locale, "请先填写 App ID 和 App Secret", "Enter App ID and App Secret first"));
      return;
    }

    setTestingChannel(kind);
    setChannelTestStatus((prev) => {
      const next = { ...prev };
      delete next[kind];
      return next;
    });
    try {
      const result = await setupApi.testChannel({ kind, config });
      setChannelTestStatus((prev) => ({
        ...prev,
        [kind]: {
          validated: result.validated,
          message: localize(locale, "凭证可用", "Credentials validated"),
          warnings: result.warnings,
        },
      }));
      toast.success(localize(locale, "飞书连接测试通过", "Feishu/Lark connection test passed"));
      if (result.warnings.length > 0) {
        toast.warning(result.warnings[0]);
      }
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : localize(locale, "连接测试失败", "Connection test failed");
      setChannelTestStatus((prev) => ({
        ...prev,
        [kind]: { validated: false, message, warnings: [] },
      }));
      toast.error(message);
    } finally {
      setTestingChannel(null);
    }
  }

  const completeSetupMutation = useMutation({
    mutationFn: () => {
      const { completedSteps, skippedSteps } = buildSetupCompletionStepState({
        providerValidated,
        channelsSaved,
        skillsPromoted: false,
      });
      return setupApi.completeSetup({ completedSteps, skippedSteps });
    },
    onSuccess: async () => {
      const starterTaskId = FRIDAY_ASSISTANT_STARTER_TASKS[0]?.id ?? "";
      const starterTask = getAssistantStarterTask(starterTaskId);
      toast.success(localize(locale, "设置完成", "Setup complete"), { duration: 4000 });
      await queryClient.invalidateQueries({ queryKey: ["setup", "status"] });
      await queryClient.invalidateQueries({ queryKey: ["health", "capabilities"] });
      window.sessionStorage.setItem(FRIDAY_SETUP_READINESS_SESSION_KEY, "1");
      navigate("/home", {
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

  // ── Discovery + skill scan handler (runs automatically on step 3 mount) ──

  async function handleStep3Load() {
    const timeout = setTimeout(() => {
      setDiscoveryScanning(false);
      setSkillScanLoading(false);
      setDiscoveryError((current) => current ?? localize(locale, "程序扫描超时，请稍后在设置中重试。", "Program discovery timed out. Retry later from Settings."));
      setSkillScanError((current) => current ?? localize(locale, "本地 AI 配置扫描超时，请稍后在设置中重试。", "Local AI config scan timed out. Retry later from Settings."));
      setSkillScanDone(true);
    }, 30000);

    setDiscoveryError(null);
    setSkillScanError(null);
    setDiscoveryScanning(true);
    setSkillScanLoading(true);

    try {
      try {
        const status = await discoveryApi.getStatus();
        if (!status.enabled) {
          setDiscoveryScanned(false);
          setDiscoveryProgramCount(0);
          setDiscoveredPrograms([]);
          setDiscoveryRecommendations([]);
        } else {
          const scanResult = await discoveryApi.scan();
          setDiscoveryProgramCount(scanResult.catalog.programCount);
          try {
            const programsResult = await discoveryApi.getPrograms();
            setDiscoveredPrograms(programsResult.programs.slice(0, 5));
          } catch {
            setDiscoveredPrograms([]);
          }
          try {
            const recsResult = await discoveryApi.getRecommendations({ minConfidence: 0.5 });
            setDiscoveryRecommendations(recsResult.recommendations.slice(0, 5));
          } catch {
            // recommendations are optional
          }
          setDiscoveryScanned(true);
        }
      } catch (error) {
        setDiscoveryScanned(false);
        setDiscoveredPrograms([]);
        setDiscoveryRecommendations([]);
        if (!isDiscoveryDisabledError(error)) {
          setDiscoveryError(
            error instanceof Error
              ? error.message
              : localize(locale, "程序扫描正在等待本机授权或服务连接。", "Program discovery is waiting for local permission or service connection."),
          );
        }
      } finally {
        setDiscoveryScanning(false);
      }

      try {
        const result = await scanMigrateApi.scanLocal();
        const sorted = [...result.items]
          .filter((item) => item.convertible && item.sourceTool !== "friday")
          .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
        setSkillScanItems(sorted);
        setSelectedSkillPaths(new Set(sorted.map((i) => i.sourcePath)));
        setSkillScanDone(true);
      } catch (error) {
        setSkillScanItems([]);
        setSelectedSkillPaths(new Set());
        setSkillScanError(
          error instanceof Error
            ? error.message
            : localize(locale, "无法扫描本地 AI 配置。", "Could not scan local AI configs."),
        );
        setSkillScanDone(true);
      } finally {
        setSkillScanLoading(false);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async function handleSkillImport() {
    if (selectedSkillPaths.size === 0) return;
    setSkillImporting(true);
    setSkillImportResult(null);
    try {
      const items = skillScanItems
        .filter((item) => selectedSkillPaths.has(item.sourcePath))
        .map((item) => ({ sourcePath: item.sourcePath, formatHint: item.converterHint }));
      const result = await scanMigrateApi.convertBatch(items);
      setSkillImportResult(result);
      const convertedCount = result.convertedCount;
      toast.success(
        localize(
          locale,
          `已预览 ${convertedCount} 个候选草稿`,
          `Previewed ${convertedCount} draft candidates`,
        ),
      );
      if (result.failedCount > 0) {
        toast.warning(
          localize(
            locale,
            `${result.failedCount} 个预览失败`,
            `${result.failedCount} failed to preview`,
          ),
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : localize(locale, "预览失败", "Preview failed"),
      );
    } finally {
      setSkillImporting(false);
    }
  }

  // ── Navigation helpers ──

  function goNext() {
    if (currentStep < 5) setCurrentStep((currentStep + 1) as SetupStep);
  }
  function goBack() {
    if (currentStep > 0) setCurrentStep((currentStep - 1) as SetupStep);
  }

  // ── Shared layout wrapper for each step ──

  function StepContainer({ children }: { children: React.ReactNode }) {
    return (
      <div
        key={currentStep}
        data-testid="setup-page"
        className="setup-step-enter flex min-h-screen flex-col items-center justify-center px-6 text-center"
      >
        {children}
      </div>
    );
  }

  // ── Shared UI fragments ──

  function BackLink() {
    return (
      <button
        type="button"
        onClick={goBack}
        className="fixed left-6 top-6 z-10 text-sm text-[color:var(--color-text-tertiary)] transition hover:text-[color:var(--color-text-primary)]"
      >
        {localize(locale, "\u2190 返回", "\u2190 Back")}
      </button>
    );
  }

  function Eyebrow({ step }: { step: number }) {
    return (
      <p className="agent-eyebrow mb-4">
        {localize(locale, `步骤 ${step} / 5`, `Step ${step} of 5`)}
      </p>
    );
  }

  function ContinueButton({
    onClick,
    disabled,
    label,
  }: {
    onClick: () => void;
    disabled?: boolean;
    label?: string;
  }) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="mt-10 rounded-full bg-[color:var(--color-accent)] px-10 py-3.5 text-base font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {label ?? localize(locale, "继续", "Continue")}
      </button>
    );
  }

  function SkipLink({ onClick }: { onClick: () => void }) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="mt-4 text-sm text-[color:var(--color-text-tertiary)] transition hover:text-[color:var(--color-text-primary)]"
      >
        {localize(locale, "跳过", "Skip")}
      </button>
    );
  }

  function BottomDots() {
    return (
      <div className="fixed bottom-8 left-0 right-0">
        <StepDots current={currentStep} total={6} />
      </div>
    );
  }

  // ─── STEP 0 — Language ───

  function renderStep0() {
    return (
      <StepContainer>
        <p className="agent-eyebrow mb-4">Friday</p>
        <h1 className="text-4xl font-semibold tracking-tight text-[color:var(--color-text-primary)] sm:text-5xl">
          {locale === "zh" ? "选择你的语言" : "Choose Your Language"}
        </h1>
        <p className="mt-4 text-lg text-[color:var(--color-text-secondary)]">
          {locale === "zh" ? "你随时可以在设置中更改。" : "You can change this anytime in Settings."}
        </p>
        <div className="mt-10 flex gap-5">
          <button
            type="button"
            onClick={() => {
              setLocale("zh");
              goNext();
            }}
            className="rounded-[28px] border-2 border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-10 py-5 text-xl font-medium text-[color:var(--color-text-primary)] transition hover:border-[color:var(--color-accent)] hover:bg-[color:var(--color-accent-muted)]"
          >
            中文
          </button>
          <button
            type="button"
            onClick={() => {
              setLocale("en");
              goNext();
            }}
            className="rounded-[28px] border-2 border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-10 py-5 text-xl font-medium text-[color:var(--color-text-primary)] transition hover:border-[color:var(--color-accent)] hover:bg-[color:var(--color-accent-muted)]"
          >
            English
          </button>
        </div>
      </StepContainer>
    );
  }

  // ─── STEP 1 — Security ───

  function renderStep1() {
    return (
      <StepContainer>
        <BackLink />
        <Eyebrow step={1} />
        <h1 className="text-4xl font-semibold tracking-tight text-[color:var(--color-text-primary)] sm:text-5xl">
          {localize(locale, "安全确认", "Security Confirmation")}
        </h1>
        <p className="mt-4 max-w-lg text-lg leading-relaxed text-[color:var(--color-text-secondary)]">
          {localize(
            locale,
            "Friday 可以读取本地状态、请求控制租约，并在你批准后执行操作。请确认这是你的本地设备。",
            "Friday can read local state, request control leases, and execute actions behind your approval. Confirm this is your local device.",
          )}
        </p>
        <div className="mt-6 max-w-lg rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-bg-surface)] p-4 text-sm leading-relaxed text-[color:var(--color-text-tertiary)]">
          <p className="font-medium text-[color:var(--color-text-secondary)]">
            {localize(locale, "免责声明", "Disclaimer")}
          </p>
          <p className="mt-2">
            {localize(
              locale,
              "Friday 是一个开源项目，按\u201C现状\u201D提供，不附带任何明示或暗示的担保。作者和贡献者不对因使用本软件而产生的任何直接或间接损失承担责任。本软件不包含也永远不会包含任何收费功能、内购或付费订阅。",
              "Friday is an open-source project provided \"as is\" without warranty of any kind, express or implied. The authors and contributors shall not be held liable for any direct or indirect damages arising from the use of this software. This software does not and will never include any paid features, in-app purchases, or subscriptions.",
            )}
          </p>
        </div>
        <label className="mt-6 inline-flex cursor-pointer items-center gap-3 text-base text-[color:var(--color-text-primary)]">
          <input
            type="checkbox"
            checked={acknowledgedSecurity}
            onChange={(e) => setAcknowledgedSecurity(e.target.checked)}
            className="h-5 w-5 rounded border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-surface)] accent-[color:var(--color-accent)]"
          />
          {localize(
            locale,
            "我已阅读上述免责声明，并了解这是一个受监控的本地操作终端。",
            "I have read the disclaimer above and understand this is a supervised local operator shell.",
          )}
        </label>
        <ContinueButton onClick={goNext} disabled={!acknowledgedSecurity} />
        <BottomDots />
      </StepContainer>
    );
  }

  // ─── STEP 2 — Provider ───

  function renderStep2() {
    const internationalKinds = getSetupProviderKindsForRegion(providerTemplates, "international");
    const chinaKinds = getSetupProviderKindsForRegion(providerTemplates, "china");

    const providerKinds = providerRegion === "china" ? chinaKinds : internationalKinds;
    const selectedProviderName = providerDisplayName(providerKind);
    const providerBusy = saveProviderMutation.isPending;
    const useMyPlanAvailable = supportsUseMyPlan(providerKind, selectedTemplate);
    const keyConnectionAvailable = supportsKeyConnection(selectedTemplate);
    const oauthBusy = openAICodexOAuth.status === "starting" || openAICodexOAuth.status === "completing" || routingUpdatePending;
    const isUseMyPlanMode = providerConnectionMode === "use-my-plan" && useMyPlanAvailable;
    const providerPrimaryLabel = providerBusy
      ? localize(locale, "正在验证并保存", "Validating & saving")
      : isUseMyPlanMode
        ? oauthBusy
          ? (openAICodexOAuth.status === "completing" ? localize(locale, "正在完成授权", "Completing authorization") : localize(locale, "正在连接", "Connecting"))
          : providerValidated
            ? localize(locale, "继续下一步", "Continue")
            : openAICodexOAuth.status === "pending"
              ? localize(locale, "我已完成授权", "I completed authorization")
              : localize(locale, "Use my plan", "Use my plan")
      : providerApiKey.trim() && !providerValidated
        ? localize(locale, "验证并保存", "Validate & Save")
        : localize(locale, "继续下一步", "Continue");

    return (
      <StepContainer>
        <BackLink />
        <Eyebrow step={2} />
        <h1 className="text-4xl font-semibold tracking-tight text-[color:var(--color-text-primary)] sm:text-5xl">
          {localize(locale, "连接 AI 模型", "Connect AI Model")}
        </h1>
        <p className="mt-4 max-w-lg text-lg text-[color:var(--color-text-secondary)]">
          {localize(locale, "选择你的 AI 提供方和连接方式", "Choose your AI provider and connection method")}
        </p>

        {/* Region tabs */}
        <div className="mt-6 flex items-center justify-center gap-1 rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-1">
          <button
            type="button"
            onClick={() => {
              setProviderRegion("international");
              const firstIntl = internationalKinds[0];
              if (firstIntl) applyProviderTemplate(firstIntl);
            }}
            className={`rounded-full px-5 py-2 text-sm font-medium transition ${
              providerRegion === "international"
                ? "bg-[color:var(--color-accent)] text-white"
                : "text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
            }`}
          >
            {localize(locale, "国际", "International")}
          </button>
          <button
            type="button"
            onClick={() => {
              setProviderRegion("china");
              const firstChina = chinaKinds[0];
              if (firstChina) applyProviderTemplate(firstChina);
            }}
            className={`rounded-full px-5 py-2 text-sm font-medium transition ${
              providerRegion === "china"
                ? "bg-[color:var(--color-accent)] text-white"
                : "text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
            }`}
          >
            {localize(locale, "国内", "China")}
          </button>
        </div>

        {/* Provider pill buttons */}
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {providerKinds.map((kind) => {
            const tpl = providerTemplates.find((t) => t.providerKind === kind);
            // Use short display name; for Chinese providers show Chinese name when in zh locale
            const label = tpl?.displayName
              ? (locale === "zh" ? tpl.displayName : tpl.displayName.replace(/^[^\(]+\(([^\)]+)\)$/, "$1").trim() || tpl.displayName)
              : titleCase(kind);
            const active = kind === providerKind;
            return (
              <button
                key={kind}
                type="button"
                onClick={() => applyProviderTemplate(kind)}
                className={`rounded-full border px-5 py-2.5 text-sm font-medium transition ${
                  active
                    ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-text-primary)]"
                    : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] text-[color:var(--color-text-secondary)] hover:border-[color:var(--color-border-strong)]"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* More providers (region-limited): opposite-region templates rendered in a
            collapsed section. Selecting an item reuses applyProviderTemplate() and the
            existing setup save path with validateOnSave=true; the provider is never
            marked ready/available/routing-eligible without validation passing. */}
        {(() => {
          const oppositeRegion: "international" | "china" = providerRegion === "china" ? "international" : "china";
          const oppositeKinds = providerRegion === "china" ? internationalKinds : chinaKinds;
          if (oppositeKinds.length === 0) return null;
          return (
            <div className="mt-3 w-full max-w-md">
              <button
                type="button"
                onClick={() => setShowRegionLimitedTemplates((v) => !v)}
                aria-expanded={showRegionLimitedTemplates}
                className="flex w-full items-center justify-between rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
              >
                <span>{localize(locale, "更多提供方（地区限定）", "More providers (region-limited)")}</span>
                <span aria-hidden="true">{showRegionLimitedTemplates ? "▾" : "▸"}</span>
              </button>
              {showRegionLimitedTemplates ? (
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  {oppositeKinds.map((kind) => {
                    const tpl = providerTemplates.find((t) => t.providerKind === kind);
                    const label = tpl?.displayName
                      ? (locale === "zh" ? tpl.displayName : tpl.displayName.replace(/^[^\(]+\(([^\)]+)\)$/, "$1").trim() || tpl.displayName)
                      : titleCase(kind);
                    return (
                      <button
                        key={kind}
                        type="button"
                        onClick={() => {
                          setProviderRegion(oppositeRegion);
                          applyProviderTemplate(kind);
                        }}
                        className="flex items-center gap-2 rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-2.5 text-sm font-medium text-[color:var(--color-text-secondary)] hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-text-primary)]"
                      >
                        <span>{label}</span>
                        <StatusPill tone="neutral">{localize(locale, "地区限定", "Region-limited")}</StatusPill>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })()}

        <div className="mt-6 flex items-center justify-center gap-1 rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-1">
          {ROUTING_COST_MODE_OPTIONS.map((mode) => {
            const active = providerCostMode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setProviderCostMode(mode)}
                className={`rounded-full px-5 py-2 text-sm font-medium transition ${
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

        {(useMyPlanAvailable && keyConnectionAvailable) ? (
          <div className="mt-6 flex items-center justify-center gap-1 rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-1">
            <button
              type="button"
              onClick={() => selectProviderConnectionMode("api-key")}
              className={`rounded-full px-5 py-2 text-sm font-medium transition ${
                providerConnectionMode === "api-key"
                  ? "bg-[color:var(--color-accent)] text-white"
                  : "text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
              }`}
            >
              {localize(locale, "API 密钥", "API Key")}
            </button>
            <button
              type="button"
              onClick={() => selectProviderConnectionMode("use-my-plan")}
              className={`rounded-full px-5 py-2 text-sm font-medium transition ${
                isUseMyPlanMode
                  ? "bg-[color:var(--color-accent)] text-white"
                  : "text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
              }`}
            >
              Use my plan
            </button>
          </div>
        ) : null}

        {isUseMyPlanMode ? (
          <div className="mt-6 w-full max-w-md rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4 text-left">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 text-[color:var(--color-accent)]" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">
                  {localize(locale, "连接你的 OpenAI / ChatGPT 计划", "Connect your OpenAI / ChatGPT plan")}
                </p>
                <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                  {localize(
                    locale,
                    "Friday 会显示一次性 code。你在 OpenAI 页面授权后，Friday 会加密保存这个用户自己的 OAuth token。",
                    "Friday will show a one-time code. After you authorize on OpenAI, Friday stores this user's OAuth token encrypted.",
                  )}
                </p>
                {openAICodexOAuth.status === "pending" && openAICodexOAuth.userCode ? (
                  <div className="mt-4 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-3">
                    <p className="text-xs text-[color:var(--color-text-tertiary)]">{localize(locale, "一次性 code", "One-time code")}</p>
                    <p className="mt-1 font-mono text-2xl font-semibold tracking-[0.14em] text-[color:var(--color-text-primary)]">{openAICodexOAuth.userCode}</p>
                    {openAICodexOAuth.verificationUrl ? (
                      <a
                        href={openAICodexOAuth.verificationUrl}
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
                {openAICodexOAuth.status === "connected" ? (
                  <p className="mt-3 text-xs font-medium text-[color:var(--ok)]">
                    {localize(locale, "已连接，可以继续。", "Connected. You can continue.")}
                  </p>
                ) : null}
                {openAICodexOAuth.status === "error" && openAICodexOAuth.message ? (
                  <p className="mt-3 text-xs font-medium text-[color:var(--danger)]">{openAICodexOAuth.message}</p>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-6 w-full max-w-md">
            <input
              value={providerApiKey}
              onChange={(e) => {
                setProviderApiKey(e.target.value);
                setProviderValidated(false);
                setProviderFeedback({ status: "idle", warnings: [] });
              }}
              type="password"
              className="agent-input w-full text-center"
              placeholder={localize(locale, `粘贴 ${selectedProviderName} API 密钥`, `Paste ${selectedProviderName} API key`)}
            />
          </div>
        )}

        {providerFeedback.status !== "idle" && (
          <div className={`mt-5 w-full max-w-md rounded-2xl border px-4 py-3 text-left shadow-sm ${
            providerFeedback.status === "error"
              ? "border-[color:var(--danger-soft)] bg-[color:var(--danger-soft)]"
              : providerFeedback.status === "saved"
                ? "border-[color:var(--ok-soft)] bg-[color:var(--ok-soft)]"
                : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)]"
          }`}
          >
            <div className="flex items-start gap-3">
              {providerFeedback.status === "checking" ? (
                <RefreshCw className="mt-0.5 h-4 w-4 animate-spin text-[color:var(--color-accent)]" />
              ) : providerFeedback.status === "saved" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-[color:var(--ok)]" />
              ) : (
                <AlertCircle className="mt-0.5 h-4 w-4 text-[color:var(--danger)]" />
              )}
              <div className="min-w-0">
                <p className={`text-sm font-semibold ${
                  providerFeedback.status === "error"
                    ? "text-[color:var(--danger)]"
                    : providerFeedback.status === "saved"
                      ? "text-[color:var(--ok)]"
                      : "text-[color:var(--color-text-primary)]"
                }`}
                >
                  {providerFeedback.status === "checking"
                    ? localize(locale, `正在验证 ${selectedProviderName}`, `Validating ${selectedProviderName}`)
                    : providerFeedback.status === "saved"
                      ? localize(locale, `${providerDisplayName(providerFeedback.kind ?? providerKind)} 已验证并保存`, `${providerDisplayName(providerFeedback.kind ?? providerKind)} validated and saved`)
                      : localize(locale, `${selectedProviderName} 验证失败`, `${selectedProviderName} validation failed`)}
                </p>
                <p className={`mt-1 text-xs leading-5 ${
                  providerFeedback.status === "error"
                    ? "text-[color:var(--danger)]"
                    : providerFeedback.status === "saved"
                      ? "text-[color:var(--ok)]"
                      : "text-[color:var(--color-text-secondary)]"
                }`}
                >
                  {providerFeedback.status === "saved"
                    ? localize(
                      locale,
                      `默认模型：${(providerFeedback.defaultModel ?? providerDefaultModel) || "未指定"}。点击继续进入下一步。`,
                      `Default model: ${(providerFeedback.defaultModel ?? providerDefaultModel) || "not set"}. Continue to the next step.`,
                    )
                    : providerFeedback.status === "error"
                      ? providerFeedback.message
                      : localize(locale, "正在检查密钥、模型列表和默认路由。", "Checking the key, model list, and default route.")}
                </p>
                {providerFeedback.warnings.length > 0 && (
                  <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-tertiary)]">
                    {providerFeedback.warnings[0]}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
        <p className="mt-2 max-w-md text-center text-xs text-[color:var(--color-text-faint)]">
          {isUseMyPlanMode
            ? localize(
              locale,
              "OpenAI Codex 会使用当前 Friday 用户自己的计划，不会复用别人的全局 token。",
              "OpenAI Codex uses this Friday user's own plan and will not reuse someone else's global token.",
            )
            : localize(
              locale,
              "Friday 会按当前选择的提供方验证密钥，不会自动跳到其它提供方。",
              "Friday validates the selected provider and will not switch to another provider automatically.",
            )}
        </p>

        {/* Models detected */}
        {providerModels.length > 0 && (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {providerModels.slice(0, 4).map((model) => (
              <StatusPill key={model} tone={model === providerDefaultModel ? "success" : "neutral"}>
                {model}
              </StatusPill>
            ))}
          </div>
        )}

        <ContinueButton
          onClick={() => {
            if (isUseMyPlanMode) {
              if (providerValidated) {
                goNext();
              } else if (openAICodexOAuth.status === "pending") {
                void completeOpenAICodexDeviceOAuth({ advance: false });
              } else {
                void startOpenAICodexDeviceOAuth();
              }
            } else if (providerApiKey.trim() && !providerValidated) {
              validateAndSaveProvider({ advance: false });
            } else if (providerValidated) {
              goNext();
            } else {
              goNext();
            }
          }}
          label={providerPrimaryLabel}
          disabled={providerBusy || oauthBusy}
        />
        <SkipLink onClick={goNext} />
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
        {/*
          CORE-A CR-2 owner-confirm gate. The summary lines are produced by the
          SERVER from the sanitized parameters (secret-free); the owner must
          explicitly confirm this exact plan before any canonical approval is
          minted. Cancelling resolves false — nothing is minted, nothing is saved.
        */}
        <ConfirmDialog
          open={pendingProviderPlan !== null}
          title={localize(locale, "确认提供方变更", "Confirm provider change")}
          description={pendingProviderPlan?.plan.humanReadableSummary.join(" · ")}
          confirmLabel={localize(locale, "确认并保存", "Confirm and save")}
          cancelLabel={localize(locale, "取消", "Cancel")}
          tone="primary"
          onCancel={() => {
            const pending = pendingProviderPlan;
            setPendingProviderPlan(null);
            pending?.resolve(false);
          }}
          onConfirm={() => {
            const pending = pendingProviderPlan;
            setPendingProviderPlan(null);
            pending?.resolve(true);
          }}
        />
        <BottomDots />
      </StepContainer>
    );
  }

  // ─── STEP 3 — Program Discovery + Skill Import ───

  // Auto-load data when entering step 3
  useEffect(() => {
    if (currentStep === 3 && !skillScanDone && !skillScanLoading && !discoveryScanning) {
      void handleStep3Load();
    }
  }, [currentStep, discoveryScanning, skillScanDone, skillScanLoading]);

  function toggleSkillPath(path: string) {
    setSelectedSkillPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderStep3() {
    const isLoading = discoveryScanning || (skillScanLoading && !skillScanDone);
    const hasDiscoveryCards = discoveryRecommendations.length > 0 || discoveredPrograms.length > 0;

    return (
      <StepContainer>
        <BackLink />
        <Eyebrow step={3} />
        <h1 className="text-4xl font-semibold tracking-tight text-[color:var(--color-text-primary)] sm:text-5xl">
          {localize(locale, "发现你的工具", "Discover Your Tools")}
        </h1>
        <p className="mt-4 max-w-lg text-lg text-[color:var(--color-text-secondary)]">
          {localize(
            locale,
            "Friday 正在扫描你电脑上的程序和已有的 AI 配置。",
            "Friday is scanning your programs and existing AI configs.",
          )}
        </p>

        {isLoading && (
          <div className="mt-10 flex items-center gap-3 text-[color:var(--color-text-tertiary)]">
            <Search className="h-5 w-5 animate-pulse" />
            <span className="text-base">{localize(locale, "扫描中...", "Scanning...")}</span>
          </div>
        )}

        <div className="mt-8 w-full max-w-xl space-y-10 text-left">
          {/* ── Sub-section A: Program Discovery ── */}
          {(discoveryScanned || discoveryError) && (
            <div>
              <h2 className="text-lg font-semibold text-[color:var(--color-text-primary)]">
                {localize(locale, "发现你电脑上的工具", "Discover Your Tools")}
              </h2>
              {discoveryError ? (
                <div className="mt-4 rounded-2xl border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] px-4 py-3">
                  <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                    {localize(locale, "程序扫描这次没有完成", "Program discovery did not complete this time")}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                    {discoveryError}
                  </p>
                </div>
              ) : (
                <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
                  {localize(
                    locale,
                    `Friday 发现了你安装的 ${discoveryProgramCount} 个程序，以下是可以帮你自动化的功能。`,
                    `Friday found ${discoveryProgramCount} programs on your computer. Here's what it can automate for you.`,
                  )}
                </p>
              )}
              <div className="mt-4 space-y-2">
                {!discoveryError && discoveryRecommendations.length > 0
                  ? discoveryRecommendations.slice(0, 5).map((rec) => {
                      const friendlyDesc = getIntegrationDescription(rec.programName, locale);
                      return (
                        <div
                          key={rec.programId}
                          className="flex items-center justify-between rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">
                              {rec.programName}
                            </p>
                            <p className="mt-0.5 text-xs text-[color:var(--color-text-tertiary)]">
                              {friendlyDesc ?? rec.rationale}
                            </p>
                          </div>
                          <StatusPill tone="neutral" className="ml-3 shrink-0">
                            {titleCase(rec.integrationPath)}
                          </StatusPill>
                        </div>
                      );
                    })
                  : !discoveryError && hasDiscoveryCards
                    ? discoveredPrograms.slice(0, 5).map((prog) => (
                        <div
                          key={prog.id}
                          className="flex items-center justify-between rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">
                              {prog.name}
                            </p>
                            <p className="mt-0.5 text-xs text-[color:var(--color-text-tertiary)]">
                              {titleCase(prog.category)}{prog.version ? ` · ${prog.version}` : ""}
                            </p>
                          </div>
                          <StatusPill tone="neutral" className="ml-3 shrink-0">
                            {titleCase(prog.category)}
                          </StatusPill>
                        </div>
                      ))
                    : (
                        <p className="text-sm text-[color:var(--color-text-tertiary)]">
                          {localize(
                            locale,
                            discoveryError
                              ? "程序扫描没有成功返回结果，但你仍然可以继续导入已有的 AI 配置。"
                              : "这次没有拿到可展示的程序推荐，但你仍然可以继续导入已有的 AI 配置。",
                            discoveryError
                              ? "Program discovery did not return usable results, but you can still import existing AI configs."
                              : "No program recommendations were available this time, but you can still import existing AI configs.",
                          )}
                        </p>
                      )}
              </div>
            </div>
          )}

          {/* ── Sub-section B: Skill Import ── */}
          {skillScanDone && (
            <div>
              <h2 className="text-lg font-semibold text-[color:var(--color-text-primary)]">
                {localize(locale, "导入已有的 AI 配置", "Import Existing AI Configs")}
              </h2>
              {skillScanItems.length > 0 ? (
                <>
                  <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
                    {localize(
                      locale,
                      `Friday 在你的电脑上找到了 ${skillScanItems.length} 个来自 ${summarizeLocalSkillSources(skillScanItems, locale)} 的技能配置。`,
                      `Friday found ${skillScanItems.length} skill configs from ${summarizeLocalSkillSources(skillScanItems, locale)} on your computer.`,
                    )}
                  </p>
                  <div className="mt-4 max-h-[28rem] space-y-2 overflow-y-auto pr-1">
                    {skillScanItems.map((item) => (
                      <label
                        key={item.sourcePath}
                        className="flex cursor-pointer items-center gap-3 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3 transition hover:border-[color:var(--color-border-strong)]"
                      >
                        <input
                          type="checkbox"
                          checked={selectedSkillPaths.has(item.sourcePath)}
                          onChange={() => toggleSkillPath(item.sourcePath)}
                          className="h-4 w-4 shrink-0 rounded border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-surface)] accent-[color:var(--color-accent)]"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                            {item.name}
                          </p>
                          {item.description && (
                            <p className="mt-0.5 truncate text-xs text-[color:var(--color-text-tertiary)]">
                              {item.description}
                            </p>
                          )}
                        </div>
                        <StatusPill tone="neutral" className="ml-2 shrink-0">
                          {localSkillSourceLabel(item.sourceTool, locale)}
                        </StatusPill>
                      </label>
                    ))}
                  </div>
                  {selectedSkillPaths.size > 0 && (
                    <div className="mt-4 flex justify-center">
                      <ActionButton
                        tone="secondary"
                        onClick={handleSkillImport}
                        disabled={skillImporting}
                      >
                        {skillImporting
                          ? localize(locale, "预览中...", "Previewing...")
                          : localize(locale, `预览候选 (${selectedSkillPaths.size})`, `Preview Candidates (${selectedSkillPaths.size})`)}
                      </ActionButton>
                    </div>
                  )}
                  {(skillImportResult?.failedCount ?? 0) > 0 && (
                    <div className="mt-4 space-y-2">
                      {skillImportResult!.results.filter((entry) => !entry.success).map((entry) => (
                        <div
                          key={entry.sourcePath}
                          className="rounded-2xl border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] px-4 py-3 text-left"
                        >
                          <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                            {entry.sourcePath.split("/").at(-2) ?? entry.sourcePath}
                          </p>
                          <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                            {entry.error ?? localize(locale, "预览失败，但后端没有返回更具体的原因。", "Preview failed, but the backend did not return a more specific reason.")}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : skillScanError ? (
                <div className="mt-4 rounded-2xl border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] px-4 py-3">
                  <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                    {localize(locale, "本地 AI 配置扫描失败", "Local AI config scan failed")}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                    {skillScanError}
                  </p>
                </div>
              ) : (
                <p className="mt-2 text-sm text-[color:var(--color-text-tertiary)]">
                  {localize(locale, "未找到本地 AI 配置", "No local AI configs found")}
                </p>
              )}
            </div>
          )}
        </div>

        <ContinueButton onClick={goNext} />
        <SkipLink onClick={goNext} />
        <BottomDots />
      </StepContainer>
    );
  }

  // ─── STEP 4 — Connect Channels ───

  function toggleChannel(kind: ChannelKind) {
    setChannelControlConfirmed(false);
    setEnabledChannels((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) {
        next.delete(kind);
        if (expandedChannel === kind) setExpandedChannel(null);
        if (kind === "feishu") {
          clearFeishuRegistrationPoll();
          setFeishuRegistration({ status: "idle", warnings: [] });
        }
        if (kind === "telegram") {
          clearTelegramVerificationPoll();
          setTelegramVerification({ status: "idle", warnings: [] });
        }
        if (kind === "discord") {
          setDiscordVerification({ status: "idle", warnings: [] });
        }
      } else {
        next.add(kind);
        setExpandedChannel(kind);
      }
      return next;
    });
  }

  function toggleAdvancedChannelConfig(kind: ChannelKind) {
    setAdvancedChannelConfig((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) {
        next.delete(kind);
      } else {
        next.add(kind);
      }
      return next;
    });
  }

  function updateChannelConfig(kind: ChannelKind, key: string, value: string) {
    setChannelConfigs((prev) => ({
      ...prev,
      [kind]: { ...prev[kind], [key]: value },
    }));
    if (kind === "telegram" && key === "botToken") {
      clearTelegramVerificationPoll();
      setTelegramVerification({ status: "idle", warnings: [] });
    }
    if (kind === "discord" && (key === "token" || key === "guildId")) {
      setDiscordVerification({ status: "idle", warnings: [] });
    }
    setChannelTestStatus((prev) => {
      if (!prev[kind]) return prev;
      const next = { ...prev };
      delete next[kind];
      return next;
    });
  }

  function renderStep4() {
    return (
      <StepContainer>
        <BackLink />
        <Eyebrow step={4} />
        <h1 className="text-4xl font-semibold tracking-tight text-[color:var(--color-text-primary)] sm:text-5xl">
          {localize(locale, "连接你的渠道", "Connect Your Channels")}
        </h1>
        <p className="mt-4 max-w-lg text-lg text-[color:var(--color-text-secondary)]">
          {localize(
            locale,
            "选择渠道后，用户可以直接从这些对话里让 Friday 做事。稍后也可以在设置中更改。",
            "After you choose channels, users can ask Friday to act directly from those conversations. You can change this later in Settings.",
          )}
        </p>

        <div className="mt-6 w-full max-w-2xl rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4 text-left">
          <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
            <Route className="h-4 w-4" />
            {localize(locale, "打通路线", "Control Route")}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {SETUP_CHANNEL_CONTROL_ROUTE_STEPS.map((step, index) => (
              <div key={step.en} className="flex items-center gap-2">
                <span className="rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-1 text-xs font-medium text-[color:var(--color-text-secondary)]">
                  {localize(locale, step.zh, step.en)}
                </span>
                {index < SETUP_CHANNEL_CONTROL_ROUTE_STEPS.length - 1 && (
                  <span className="text-xs text-[color:var(--color-text-tertiary)]">→</span>
                )}
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-start gap-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">
            <ShieldCheck className="mt-0.5 h-4 w-4 flex-none text-[color:var(--color-accent)]" />
            <div>
              {SETUP_CHANNEL_CONTROL_GUARDS.map((guard) => (
                <p key={guard.en}>{localize(locale, guard.zh, guard.en)}</p>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-8 w-full max-w-2xl space-y-2 text-left">
          {SETUP_CHANNEL_KINDS_ORDERED.map((kind) => {
            const meta = CHANNEL_META[kind];
            const enabled = enabledChannels.has(kind);
            const expanded = expandedChannel === kind && enabled;
            const config = channelConfigs[kind] ?? {};
            const simpleFields = meta.fields.filter((field) => !field.advanced);
            const advancedFields = meta.fields.filter((field) => field.advanced);
            const advancedExpanded = advancedChannelConfig.has(kind);
            const larkLike = isLarkLikeChannel(kind);
            const feishuQr = isFeishuQrChannel(kind);
            const hasConfigSurface = meta.fields.length > 0 || feishuQr;
            const testStatus = channelTestStatus[kind];

            return (
              <div
                key={kind}
                className={`rounded-2xl border-2 transition ${
                  enabled
                    ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)]"
                    : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => toggleChannel(kind)}
                  className="flex w-full items-center gap-3 px-4 py-3"
                >
                  <span className="text-xl">{meta.emoji}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">
                      {localize(locale, meta.nameZh, meta.name)}
                    </p>
                    <p className="text-xs text-[color:var(--color-text-tertiary)]">
                      {localize(locale, meta.descriptionZh, meta.description)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {meta.capabilities.directMessages && (
                      <StatusPill tone="neutral">DM</StatusPill>
                    )}
                    {meta.capabilities.groupMessages && (
                      <StatusPill tone="neutral">{localize(locale, "群组", "Group")}</StatusPill>
                    )}
                    <div className={`h-5 w-9 rounded-full transition ${enabled ? "bg-[color:var(--color-accent)]" : "bg-[color:var(--color-border-strong)]"} flex items-center ${enabled ? "justify-end" : "justify-start"} px-0.5`}>
                      <div className="h-4 w-4 rounded-full bg-white shadow" />
                    </div>
                  </div>
                </button>

                {expanded && hasConfigSurface && (
                  <div className="border-t border-[color:var(--color-border-soft)] px-4 pb-4 pt-3">
                    <div className="space-y-3">
                      {kind === "lark" && (
                        <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-3 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                          <p className="font-medium text-[color:var(--color-text-primary)]">
                            {localize(locale, "飞书准备", "Feishu setup")}
                          </p>
                          <p className="mt-1">
                            {localize(
                              locale,
                              "使用 Lark workspace 自建应用。Friday 默认使用长连接，不需要公网回调地址。",
                              "Use a Lark workspace custom app. Friday defaults to WebSocket mode, so a public callback URL is not required.",
                            )}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span>{localize(locale, "开发者后台 → 创建企业自建应用 → 凭证与基础信息 → 复制 App ID / App Secret", "Developer Console → Create custom app → Credentials & Basic Info → copy App ID / App Secret")}</span>
                            <a
                              href="https://open.larksuite.com/app"
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 font-medium text-[color:var(--color-accent)]"
                            >
                              {localize(locale, "打开", "Open")}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </div>
                        </div>
                      )}

                      {feishuQr && (
                        <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-3">
                          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                            <div className="flex min-h-[232px] w-full max-w-[232px] items-center justify-center rounded-lg border border-[color:var(--color-border-soft)] bg-white p-2">
                              {feishuRegistration.qrDataUrl ? (
                                <img
                                  src={feishuRegistration.qrDataUrl}
                                  alt={localize(locale, "飞书扫码创建 Friday 应用", "Scan to create the Friday Feishu app")}
                                  className="h-[220px] w-[220px]"
                                />
                              ) : (
                                <QrCode className="h-12 w-12 text-[color:var(--color-text-faint)]" />
                              )}
                            </div>
                            <div className="min-w-0 flex-1 space-y-3">
                              <div>
                                <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">
                                  {localize(locale, "扫码自动创建 Friday 飞书应用", "Create the Friday Feishu app by QR")}
                                </p>
                                <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                                  {localize(
                                    locale,
                                    "用飞书手机 App 扫码确认后，Friday 会自动拿到并加密保存应用凭证，默认使用长连接，不需要公网回调地址。",
                                    "Scan with the Feishu mobile app. Friday will receive and encrypt the app credentials automatically, using WebSocket mode without a public callback URL.",
                                  )}
                                </p>
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <ActionButton
                                  tone="secondary"
                                  onClick={() => void startFeishuRegistration()}
                                  disabled={feishuRegistration.status === "starting"}
                                  className="gap-2"
                                >
                                  <RefreshCw className="h-4 w-4" />
                                  {feishuRegistration.status === "starting"
                                    ? localize(locale, "生成中...", "Starting...")
                                    : feishuRegistration.status === "success"
                                      ? localize(locale, "重新验证", "Verify again")
                                      : localize(locale, "生成二维码", "Generate QR")}
                                </ActionButton>
                                {feishuRegistration.status === "pending" && (
                                  <StatusPill tone="warning">
                                    {localize(locale, "等待扫码", "Waiting for scan")}
                                  </StatusPill>
                                )}
                                {feishuRegistration.status === "success" && (
                                  <StatusPill tone="success">
                                    {localize(locale, "私聊已验证", "DM verified")}
                                  </StatusPill>
                                )}
                                {feishuRegistration.status === "failed" && (
                                  <StatusPill tone="danger">
                                    {localize(locale, "失败", "Failed")}
                                  </StatusPill>
                                )}
                              </div>
                              {feishuRegistration.userCode && feishuRegistration.status === "pending" && (
                                <p className="text-xs text-[color:var(--color-text-tertiary)]">
                                  {localize(locale, "验证码", "Code")}: <span className="font-mono text-[color:var(--color-text-secondary)]">{feishuRegistration.userCode}</span>
                                </p>
                              )}
                              {feishuRegistration.appId && (
                                <p className="truncate text-xs text-[color:var(--color-text-tertiary)]">
                                  App ID: <span className="font-mono text-[color:var(--color-text-secondary)]">{feishuRegistration.appId}</span>
                                </p>
                              )}
                              {feishuRegistration.ownerOpenId && (
                                <p className="truncate text-xs text-[color:var(--color-text-tertiary)]">
                                  {localize(locale, "审批 allowlist", "Approval allowlist")}:{" "}
                                  <span className="font-mono text-[color:var(--color-text-secondary)]">{feishuRegistration.ownerOpenId}</span>
                                </p>
                              )}
                              {feishuRegistration.welcomeMessageId && (
                                <p className="truncate text-xs text-[color:var(--color-text-tertiary)]">
                                  {localize(locale, "欢迎私聊", "Welcome DM")}:{" "}
                                  <span className="font-mono text-[color:var(--color-text-secondary)]">{feishuRegistration.welcomeMessageId}</span>
                                </p>
                              )}
                              {feishuRegistration.dmVerified && (
                                <p className="text-xs leading-5 text-[color:var(--color-text-success)]">
                                  {localize(
                                    locale,
                                    "Friday 已向你的飞书私聊发送验证消息。点击“保存并启动”后，就可以直接在飞书里跟 Friday 沟通。",
                                    "Friday sent a verification message to your Feishu DM. After Save & Start, you can chat with Friday there.",
                                  )}
                                </p>
                              )}
                              {feishuRegistration.message && (
                                <p className="text-xs leading-5 text-[color:var(--color-danger)]">{feishuRegistration.message}</p>
                              )}
                              {feishuRegistration.qrUrl && (
                                <a
                                  href={feishuRegistration.qrUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-xs font-medium text-[color:var(--color-accent)]"
                                >
                                  {localize(locale, "无法扫码时打开确认页", "Open confirmation page")}
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      )}

                      {simpleFields.map((field) => (
                        <div key={field.key}>
                          <label className="mb-1 block text-xs font-medium text-[color:var(--color-text-tertiary)]">
                            {localize(locale, field.labelZh, field.label)}
                            {field.required && <span className="ml-1 text-[color:var(--color-danger)]">*</span>}
                          </label>
                          <input
                            type={field.secret ? "password" : "text"}
                            placeholder={localize(locale, field.placeholderZh, field.placeholder)}
                            value={config[field.key] ?? ""}
                            onChange={(e) => updateChannelConfig(kind, field.key, e.target.value)}
                            className="agent-input px-3 py-2 text-sm"
                            autoComplete="off"
                          />
                        </div>
                      ))}

                      {kind === "telegram" && (
                        <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <ActionButton
                              tone="secondary"
                              onClick={() => void startTelegramVerification()}
                              disabled={telegramVerification.status === "starting"}
                              className="gap-2"
                            >
                              <RefreshCw className="h-4 w-4" />
                              {telegramVerification.status === "starting"
                                ? localize(locale, "验证中...", "Verifying...")
                                : telegramVerification.status === "success"
                                  ? localize(locale, "重新验证", "Verify again")
                                  : localize(locale, "验证 Telegram", "Verify Telegram")}
                            </ActionButton>
                            {telegramVerification.status === "pending" && (
                              <StatusPill tone="warning">{localize(locale, "等待私聊", "Waiting for DM")}</StatusPill>
                            )}
                            {telegramVerification.status === "success" && (
                              <StatusPill tone="success">{localize(locale, "私聊已验证", "DM verified")}</StatusPill>
                            )}
                            {telegramVerification.status === "failed" && (
                              <StatusPill tone="danger">{localize(locale, "失败", "Failed")}</StatusPill>
                            )}
                          </div>
                          {telegramVerification.botUsername && (
                            <p className="mt-2 truncate text-xs text-[color:var(--color-text-tertiary)]">
                              Bot: <span className="font-mono text-[color:var(--color-text-secondary)]">@{telegramVerification.botUsername}</span>
                            </p>
                          )}
                          {telegramVerification.startCode && telegramVerification.status === "pending" && (
                            <p className="mt-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                              {localize(locale, "打开机器人并发送验证码", "Open the bot and send this setup code")}:{" "}
                              <span className="font-mono">{telegramVerification.startCode}</span>
                            </p>
                          )}
                          {telegramVerification.startUrl && telegramVerification.status === "pending" && (
                            <a
                              href={telegramVerification.startUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[color:var(--color-accent)]"
                            >
                              {localize(locale, "打开 Telegram 机器人", "Open Telegram bot")}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                          {telegramVerification.welcomeMessageId && (
                            <p className="mt-2 truncate text-xs text-[color:var(--color-text-tertiary)]">
                              {localize(locale, "验证消息", "Verification message")}:{" "}
                              <span className="font-mono text-[color:var(--color-text-secondary)]">{telegramVerification.welcomeMessageId}</span>
                            </p>
                          )}
                          {telegramVerification.status === "success" && (
                            <p className="mt-2 text-xs leading-5 text-[color:var(--color-text-success)]">
                              {localize(
                                locale,
                                "Friday 已收到你的 Telegram 私聊并发送验证回复。保存后即可在 Telegram 里跟 Friday 沟通。",
                                "Friday received your Telegram DM and sent a verification reply. After saving, you can chat with Friday in Telegram.",
                              )}
                            </p>
                          )}
                          {telegramVerification.message && (
                            <p className="mt-2 text-xs leading-5 text-[color:var(--color-danger)]">{telegramVerification.message}</p>
                          )}
                        </div>
                      )}

                      {kind === "discord" && (
                        <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <ActionButton
                              tone="secondary"
                              onClick={() => void startDiscordVerification()}
                              disabled={discordVerification.status === "starting"}
                              className="gap-2"
                            >
                              <RefreshCw className="h-4 w-4" />
                              {discordVerification.status === "starting"
                                ? localize(locale, "验证中...", "Verifying...")
                                : discordVerification.status === "success"
                                  ? localize(locale, "重新验证", "Verify again")
                                  : localize(locale, "验证 Token", "Verify Token")}
                            </ActionButton>
                            <ActionButton
                              tone="secondary"
                              onClick={() => void completeDiscordVerification()}
                              disabled={!discordVerification.verificationId || discordVerification.status === "starting"}
                              className="gap-2"
                            >
                              <CheckCircle2 className="h-4 w-4" />
                              {localize(locale, "发送验证私聊", "Send Verification DM")}
                            </ActionButton>
                            {discordVerification.status === "ready" && (
                              <StatusPill tone="warning">{localize(locale, "等待私聊验证", "Waiting for DM check")}</StatusPill>
                            )}
                            {discordVerification.status === "success" && (
                              <StatusPill tone="success">{localize(locale, "私聊已验证", "DM verified")}</StatusPill>
                            )}
                            {discordVerification.status === "failed" && (
                              <StatusPill tone="danger">{localize(locale, "失败", "Failed")}</StatusPill>
                            )}
                          </div>
                          {discordVerification.botUsername && (
                            <p className="mt-2 truncate text-xs text-[color:var(--color-text-tertiary)]">
                              Bot: <span className="font-mono text-[color:var(--color-text-secondary)]">{discordVerification.botUsername}</span>
                            </p>
                          )}
                          {discordVerification.inviteUrl && (
                            <a
                              href={discordVerification.inviteUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[color:var(--color-accent)]"
                            >
                              {localize(locale, "邀请机器人到 Discord 服务器", "Invite bot to Discord server")}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                          {discordVerification.guildId && (
                            <p className="mt-2 truncate text-xs text-[color:var(--color-text-tertiary)]">
                              {localize(locale, "服务器验证", "Server check")}:{" "}
                              <span className={discordVerification.guildVerified ? "text-[color:var(--color-text-success)]" : "text-[color:var(--color-text-tertiary)]"}>
                                {discordVerification.guildVerified
                                  ? localize(locale, "已加入", "joined")
                                  : localize(locale, "待邀请后重试", "invite then retry")}
                              </span>
                            </p>
                          )}
                          {discordVerification.welcomeMessageId && (
                            <p className="mt-2 truncate text-xs text-[color:var(--color-text-tertiary)]">
                              {localize(locale, "验证私聊", "Verification DM")}:{" "}
                              <span className="font-mono text-[color:var(--color-text-secondary)]">{discordVerification.welcomeMessageId}</span>
                            </p>
                          )}
                          {discordVerification.status === "success" && (
                            <p className="mt-2 text-xs leading-5 text-[color:var(--color-text-success)]">
                              {localize(
                                locale,
                                "Friday 已向你的 Discord 私信发送验证消息。保存后即可在 Discord 里跟 Friday 沟通。",
                                "Friday sent a verification DM to you. After saving, you can chat with Friday in Discord.",
                              )}
                            </p>
                          )}
                          {discordVerification.message && (
                            <p className="mt-2 text-xs leading-5 text-[color:var(--color-danger)]">{discordVerification.message}</p>
                          )}
                        </div>
                      )}

                      {kind === "lark" && (
                        <div className="flex flex-wrap items-center gap-2">
                          <ActionButton
                            tone="secondary"
                            onClick={() => void handleTestChannel(kind)}
                            disabled={testingChannel === kind}
                          >
                            {testingChannel === kind
                              ? localize(locale, "测试中...", "Testing...")
                              : localize(locale, "测试连接", "Test Connection")}
                          </ActionButton>
                          {testStatus && (
                            <StatusPill tone={testStatus.validated ? "success" : "danger"}>
                              {testStatus.validated
                                ? localize(locale, "已验证", "Validated")
                                : localize(locale, "未通过", "Failed")}
                            </StatusPill>
                          )}
                          {testStatus?.message && (
                            <span className="text-xs text-[color:var(--color-text-tertiary)]">{testStatus.message}</span>
                          )}
                        </div>
                      )}

                      {advancedFields.length > 0 && (
                        <div className="pt-1">
                          <button
                            type="button"
                            onClick={() => toggleAdvancedChannelConfig(kind)}
                            className="text-xs font-medium text-[color:var(--color-accent)] transition hover:opacity-80"
                          >
                            {advancedExpanded
                              ? localize(locale, "隐藏高级设置", "Hide advanced settings")
                              : localize(locale, "高级设置", "Advanced settings")}
                          </button>
                          {advancedExpanded && (
                            <div className="mt-3 space-y-3 rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-3">
                              {larkLike && (
                                <p className="text-xs leading-5 text-[color:var(--color-text-secondary)]">
                                  {localize(
                                    locale,
                                    "允许审批用户用于限制哪些飞书用户可以触发和批准敏感操作。此配置只能由 Friday 本地管理员在设置里修改。",
                                    "Allowed approver users restrict who can trigger and approve sensitive actions. Only the local Friday admin can edit this setting.",
                                  )}
                                </p>
                              )}
                              {advancedFields.map((field) => (
                                <div key={field.key}>
                                  <label className="mb-1 block text-xs font-medium text-[color:var(--color-text-tertiary)]">
                                    {localize(locale, field.labelZh, field.label)}
                                    {field.required && <span className="ml-1 text-[color:var(--color-danger)]">*</span>}
                                  </label>
                                  <input
                                    type={field.secret ? "password" : "text"}
                                    placeholder={localize(locale, field.placeholderZh, field.placeholder)}
                                    value={config[field.key] ?? ""}
                                    onChange={(e) => updateChannelConfig(kind, field.key, e.target.value)}
                                    className="agent-input px-3 py-2 text-sm"
                                    autoComplete="off"
                                  />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {expanded && meta.fields.length === 0 && (
                  <div className="border-t border-[color:var(--color-border-soft)] px-4 pb-3 pt-2">
                    <p className="text-xs text-[color:var(--color-text-tertiary)]">
                      {localize(locale, "此渠道无需额外配置。", "No additional configuration needed.")}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {enabledChannels.size > 0 && (
          <div className="mt-4 w-full max-w-2xl space-y-3 text-left">
            <div className="text-sm text-[color:var(--color-text-secondary)]">
              {localize(
                locale,
                `已选择 ${enabledChannels.size} 个渠道`,
                `${enabledChannels.size} channel${enabledChannels.size > 1 ? "s" : ""} selected`,
              )}
            </div>
            <label className="flex items-start gap-3 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4 text-sm text-[color:var(--color-text-primary)]">
              <input
                type="checkbox"
                checked={channelControlConfirmed}
                onChange={(event) => setChannelControlConfirmed(event.target.checked)}
                className="mt-1 h-4 w-4 accent-[color:var(--color-accent)]"
              />
              <span>{localize(locale, SETUP_CHANNEL_CONTROL_CONFIRMATION.zh, SETUP_CHANNEL_CONTROL_CONFIRMATION.en)}</span>
            </label>
          </div>
        )}

        <ContinueButton
          onClick={() => {
            if (enabledChannels.size > 0) {
              handleSaveChannels();
            } else {
              goNext();
            }
          }}
          label={enabledChannels.size > 0
            ? localize(locale, "保存并启动", "Save & Start")
            : localize(locale, "继续", "Continue")}
          disabled={saveChannelsMutation.isPending || (enabledChannels.size > 0 && !channelControlConfirmed)}
        />
        <SkipLink onClick={goNext} />
        <BottomDots />
      </StepContainer>
    );
  }

  // ─── STEP 5 — Completion ───

  function renderStep5() {
    // Truthful completion headline — does not claim "ready" if the AI provider
    // step was skipped (runtime-ready vs provider-ready).
    const completionTitle = buildSetupCompletionTitle(locale, providerValidated);
    // Build summary lines
    const summaryItems: string[] = [];
    if (providerValidated) {
      const tpl = providerTemplates.find((t) => t.providerKind === providerKind);
      summaryItems.push(tpl?.displayName ?? titleCase(providerKind));
    }
    if (discoveryScanned) {
      summaryItems.push(
        localize(locale, `${discoveryProgramCount} 个程序`, `${discoveryProgramCount} programs`),
      );
    }
    const convertedSkillCount = skillImportResult?.convertedCount ?? 0;
    if (convertedSkillCount > 0) {
      summaryItems.push(
        localize(locale, `${convertedSkillCount} 个候选预览`, `${convertedSkillCount} candidate previews`),
      );
    }
    if (channelsSaved && enabledChannels.size > 0) {
      summaryItems.push(
        localize(locale, `${enabledChannels.size} 个渠道`, `${enabledChannels.size} channels`),
      );
    }
    return (
      <StepContainer>
        <BackLink />

        {/* Animated checkmark */}
        <div className="setup-completion-pulse mb-6 flex h-24 w-24 items-center justify-center rounded-full bg-[color:var(--color-accent-soft)]">
          <CheckCircle2 className="h-12 w-12 text-[color:var(--color-accent)]" />
        </div>

        <h1 className="text-4xl font-semibold tracking-tight text-[color:var(--color-text-primary)] sm:text-5xl">
          {completionTitle.title}
        </h1>

        {completionTitle.subtitle && (
          <p className="mt-3 max-w-2xl text-base text-[color:var(--color-text-secondary)]">
            {completionTitle.subtitle}
          </p>
        )}

        {summaryItems.length > 0 && (
          <p className="mt-4 text-lg text-[color:var(--color-text-secondary)]">
            {summaryItems.join(" · ")}
          </p>
        )}

        <FridayReadinessSummaryPanel
          health={capabilityHealthQuery.data}
          locale={locale}
          className="mt-8 w-full max-w-3xl text-left"
        />

        {/* Optional advanced entrypoint: user-owned cloud worker setup.
            Live cloud certification stays in safe preparation until protected
            GitHub environments, dedicated DNS, and budget/teardown controls
            are configured. Friday does not host user data; ordinary users
            never paste FRIDAY_MASTER_KEY or FRIDAY_TOKEN_SECRET; HTTPS is
            required and only dedicated subdomains are accepted. */}
        <section
          data-testid="setup-cloud-worker-advanced"
          className="mt-8 w-full max-w-3xl rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-5 text-left"
        >
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
            {localize(locale, "可选 · 高级", "Optional · Advanced")}
          </p>
          <h2 className="mt-1 text-lg font-semibold text-[color:var(--color-text-primary)]">
            {localize(locale, "部署你自己的云端 Worker", "Deploy your own cloud worker")}
          </h2>
          <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
            {localize(
              locale,
              "Friday 不托管用户数据，也不接收长期凭证。云端 Worker 部署在你自己的云上，使用 HTTPS、专用子域、Owner 配对和体检/拆机回执；FRIDAY_MASTER_KEY 与 FRIDAY_TOKEN_SECRET 是内部 runtime 秘钥，普通用户无需手动填写。",
              "Friday does not host user data and never receives long-lived credentials. The cloud worker runs in your own cloud over HTTPS on a dedicated subdomain, with owner pairing and doctor/teardown receipts. FRIDAY_MASTER_KEY and FRIDAY_TOKEN_SECRET are internal runtime secrets; ordinary users do not paste them.",
            )}
          </p>
          <p className="mt-2 text-xs text-[color:var(--color-text-tertiary)]">
            {localize(
              locale,
              "真实云端认证需要受保护的 GitHub Environment、专用 DNS 凭证和预算/拆机控制；连接前此处只用于安全准备。",
              "Live cloud certification requires protected GitHub Environment Secrets, dedicated DNS credentials, and budget/teardown controls; until then, this area is for safe preparation.",
            )}
          </p>
          <button
            type="button"
            onClick={() => navigate("/cloud-workers")}
            className="mt-4 inline-flex items-center rounded-full border border-[color:var(--color-accent)] px-5 py-2 text-sm font-semibold text-[color:var(--color-accent)] transition hover:bg-[color:var(--color-accent-soft)]"
          >
            {localize(locale, "前往云端 Worker 设置", "Open cloud worker setup")}
          </button>
        </section>

        <button
          type="button"
          onClick={() => completeSetupMutation.mutate()}
          disabled={completeSetupMutation.isPending}
          className="mt-10 rounded-full bg-[color:var(--color-accent)] px-12 py-4 text-lg font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {localize(locale, "开始使用", "Get Started")}
        </button>

        <BottomDots />
      </StepContainer>
    );
  }

  // ─── Render ───

  return (
    <div className="relative min-h-screen bg-[color:var(--color-bg-base)] text-[color:var(--color-text-primary)]">
      <div className="relative">
        {currentStep === 0 && renderStep0()}
        {currentStep === 1 && renderStep1()}
        {currentStep === 2 && renderStep2()}
        {currentStep === 3 && renderStep3()}
        {currentStep === 4 && renderStep4()}
        {currentStep === 5 && renderStep5()}
      </div>
    </div>
  );
}
