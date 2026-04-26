import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FridayCommunicationMbti } from "@friday-operator-client";
import { CheckCircle2, MessageCircleMore, Route, Search, ShieldCheck, WandSparkles } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { healthApi } from "@/lib/api/health";
import { providersApi } from "@/lib/api/providers";
import { setupApi } from "@/lib/api/setup";
import { systemApi } from "@/lib/api/system";
import { discoveryApi } from "@/lib/api/discovery";
import type { DiscoveredProgram, IntegrationRecommendation } from "@/lib/api/discovery";
import { scanMigrateApi } from "@/lib/api/scan-migrate";
import type { BatchImportResult, LocalSkillScanItem } from "@/lib/api/scan-migrate";
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
import { ActionButton, StatusPill } from "@/components/core/primitives";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import {
  buildPersonaPreview,
  COMMUNICATION_MBTI_OPTIONS,
  getMbtiDefaults,
  getMbtiDescription,
} from "@/lib/persona/communication-persona";
import { CHANNEL_META, CHANNEL_KINDS_ORDERED } from "@/lib/channels/channel-meta";
import type { ChannelKind } from "@/lib/setup/types";
import {
  SETUP_CHANNEL_CONTROL_CONFIRMATION,
  SETUP_CHANNEL_CONTROL_GUARDS,
  SETUP_CHANNEL_CONTROL_ROUTE_STEPS,
} from "@/lib/setup/channel-control-route";
import { useSaveChannelsMutation } from "@/hooks/use-setup";

// ─── Provider recommendation helper (unchanged) ───

type SetupProviderRecommendation = {
  backend: string;
  auth: string;
  why: string;
  boundary: string;
  operatorNote: string;
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

// ─── Popular MBTI subset for the card grid ───

const POPULAR_MBTI: FridayCommunicationMbti[] = [
  "INTJ", "INTP", "ENTJ", "ENTP", "INFJ", "ENFP",
];

// ─── Main component ───

export function SetupPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { locale, setLocale } = useAppLocale();
  const setupDeepLinkApplied = useRef(false);

  // ── Step state machine ──
  type SetupStep = 0 | 1 | 2 | 3 | 4 | 5 | 6;
  const [currentStep, setCurrentStep] = useState<SetupStep>(0);
  const [providerRegion, setProviderRegion] = useState<"international" | "china">(
    locale === "zh" ? "china" : "international",
  );

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
  const [providerValidated, setProviderValidated] = useState(false);
  const [communicationMbti, setCommunicationMbti] = useState<FridayCommunicationMbti | "">("");
  const [communicationSaved, setCommunicationSaved] = useState(false);
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
  const [channelControlConfirmed, setChannelControlConfirmed] = useState(false);

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
  const [skillImportResult, setSkillImportResult] = useState<BatchImportResult | null>(null);
  // ── Existing queries ──

  const { data: setupStatus } = useQuery({
    queryKey: ["setup", "status"],
    queryFn: () => setupApi.getStatus(),
    staleTime: 5_000,
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

  // ── Redirects ──

  useEffect(() => {
    if (setupStatus && !setupStatus.needsSetup && !hasSetupDeepLink) {
      navigate("/", { replace: true });
    }
  }, [hasSetupDeepLink, navigate, setupStatus]);

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
    const channelKind = CHANNEL_KINDS_ORDERED.find((kind) => kind === requestedChannel);

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

  useEffect(() => {
    if (!persona) return;
    setCommunicationMbti(persona.mbti ?? "");
    setCommunicationSaved(true);
  }, [persona]);

  // ── Template applicator ──

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

  // ── Mutations (all kept intact) ──

  const detectProviderMutation = useMutation({
    mutationFn: () => {
      // If user has typed an API key, send without explicit kind to enable auto-detection.
      // If no API key, send the currently selected kind for base-URL probing.
      const hasKey = providerApiKey.trim().length > 0;
      return setupApi.detectProvider({
        kind: hasKey ? undefined : providerKind,
        apiKey: providerApiKey.trim() || undefined,
        baseUrl: providerBaseUrl.trim() || undefined,
      });
    },
    onSuccess: (result) => {
      // Auto-detected kind may differ from user's current selection — update it
      if (result.kind) {
        setProviderKind(result.kind as ProviderKind);
        // Switch region tab if needed
        const tpl = providerTemplates.find((t) => t.providerKind === result.kind);
        if (tpl?.regionTag === "china" && providerRegion !== "china") {
          setProviderRegion("china");
        } else if (tpl?.regionTag !== "china" && providerRegion !== "international") {
          setProviderRegion("international");
        }
      }
      setProviderBaseUrl(result.baseUrl);
      setProviderApi(result.api);
      setProviderAuthMode(result.authMode);
      setProviderModels(result.availableModels);
      setProviderDefaultModel(result.defaultModel ?? result.availableModels[0] ?? "");
      setProviderValidated(result.validated);

      const detectedName = providerTemplates.find((t) => t.providerKind === result.kind)?.displayName ?? result.kind;
      if (result.warnings.length > 0) {
        toast.warning(result.warnings.join(" · "));
      } else {
        toast.success(localize(locale, `已识别：${detectedName}`, `Detected: ${detectedName}`));
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

  const saveChannelsMutation = useSaveChannelsMutation();

  function handleSaveChannels() {
    const channelsPayload = Array.from(enabledChannels).map((kind) => ({
      kind,
      enabled: true,
      config: channelConfigs[kind] ?? {},
    }));
    saveChannelsMutation.mutate(
      { channels: channelsPayload, controlConfirmed: enabledChannels.size > 0 ? channelControlConfirmed : undefined },
      {
        onSuccess: () => {
          setChannelsSaved(true);
          toast.success(localize(locale, "渠道已保存", "Channels saved"));
          goNext();
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : localize(locale, "保存渠道失败", "Failed to save channels"));
        },
      },
    );
  }

  const completeSetupMutation = useMutation({
    mutationFn: () => {
      const starterTaskId = FRIDAY_ASSISTANT_STARTER_TASKS[0]?.id ?? "";
      const completedSteps: SetupStepId[] = [
        "welcome",
        "security",
        ...(communicationSaved ? (["communication"] as const) : []),
        ...(providerValidated ? (["provider"] as const) : []),
        ...(channelsSaved ? (["channels"] as const) : []),
        "done",
      ];
      const skippedSteps: SetupStepId[] = [
        ...(communicationSaved ? [] : (["communication"] as const)),
        ...(providerValidated ? [] : (["provider"] as const)),
        ...(channelsSaved ? [] : (["channels"] as const)),
        "network",
        "skills",
      ];
      return setupApi.completeSetup({ completedSteps, skippedSteps });
    },
    onSuccess: async () => {
      const starterTaskId = FRIDAY_ASSISTANT_STARTER_TASKS[0]?.id ?? "";
      const starterTask = getAssistantStarterTask(starterTaskId);
      toast.success(localize(locale, "设置完成", "Setup complete"), { duration: 4000 });
      await queryClient.invalidateQueries({ queryKey: ["setup", "status"] });
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
      } catch (error) {
        setDiscoveryScanned(false);
        setDiscoveryError(
          error instanceof Error
            ? error.message
            : localize(locale, "程序扫描当前不可用。", "Program discovery is unavailable right now."),
        );
      } finally {
        setDiscoveryScanning(false);
      }

      try {
        const result = await scanMigrateApi.scanLocal();
        const sorted = [...result.items]
          .filter((item) => item.convertible && item.sourceTool !== "friday")
          .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
        setSkillScanItems(sorted.slice(0, 10));
        setSelectedSkillPaths(new Set(sorted.slice(0, 10).map((i) => i.sourcePath)));
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
      const items = Array.from(selectedSkillPaths).map((sourcePath) => ({ sourcePath }));
      const result = await scanMigrateApi.importBatch(items);
      setSkillImportResult(result);
      toast.success(
        localize(
          locale,
          `已导入 ${result.importedCount} 个技能`,
          `Imported ${result.importedCount} skills`,
        ),
      );
      if (result.failedCount > 0) {
        toast.warning(
          localize(
            locale,
            `${result.failedCount} 个导入失败`,
            `${result.failedCount} failed to import`,
          ),
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : localize(locale, "导入失败", "Import failed"),
      );
    } finally {
      setSkillImporting(false);
    }
  }

  // ── Navigation helpers ──

  function goNext() {
    if (currentStep < 6) setCurrentStep((currentStep + 1) as SetupStep);
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
        {localize(locale, `步骤 ${step} / 6`, `Step ${step} of 6`)}
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
        <StepDots current={currentStep} total={7} />
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
    const internationalKinds: ProviderKind[] = providerTemplates.length > 0
      ? providerTemplates
          .filter((t) => (t.tier === "official" || t.tier === "verified") && t.regionTag !== "china")
          .slice(0, 8)
          .map((t) => t.providerKind)
      : ["openai", "anthropic", "google", "ollama", "openai-compatible"];

    // Prioritize the most popular Chinese providers, then show the rest
    const CHINA_PRIORITY: ProviderKind[] = ["deepseek", "moonshot", "qwen", "glm", "minimax", "volcengine", "qianfan"];
    const chinaKinds: ProviderKind[] = providerTemplates.length > 0
      ? (() => {
          const chinaTemplates = providerTemplates.filter((t) => t.regionTag === "china");
          const sorted = [...chinaTemplates].sort((a, b) => {
            const ai = CHINA_PRIORITY.indexOf(a.providerKind as ProviderKind);
            const bi = CHINA_PRIORITY.indexOf(b.providerKind as ProviderKind);
            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
          });
          return sorted.slice(0, 8).map((t) => t.providerKind);
        })()
      : ["deepseek", "moonshot", "qwen", "glm", "minimax"];

    const providerKinds = providerRegion === "china" ? chinaKinds : internationalKinds;

    return (
      <StepContainer>
        <BackLink />
        <Eyebrow step={2} />
        <h1 className="text-4xl font-semibold tracking-tight text-[color:var(--color-text-primary)] sm:text-5xl">
          {localize(locale, "连接 AI 模型", "Connect AI Model")}
        </h1>
        <p className="mt-4 max-w-lg text-lg text-[color:var(--color-text-secondary)]">
          {localize(locale, "选择你的 AI 提供方并输入密钥", "Choose your AI provider and enter your key")}
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

        {/* API key input */}
        <div className="mt-6 w-full max-w-md">
          <input
            value={providerApiKey}
            onChange={(e) => {
              setProviderApiKey(e.target.value);
              setProviderValidated(false);
            }}
            type="password"
            className="agent-input w-full text-center"
            placeholder={localize(locale, "粘贴任意 API 密钥，Friday 自动识别厂商", "Paste any API key — Friday auto-detects the provider")}
          />
        </div>

        {/* Auto-detect + Save */}
        <div className="mt-5 flex items-center justify-center gap-3">
          <ActionButton
            tone="secondary"
            onClick={() => {
              // Auto-detect: send key without explicit kind, let backend identify
              if (providerApiKey.trim()) {
                detectProviderMutation.mutate();
              } else {
                toast.error(localize(locale, "请先输入 API 密钥", "Please enter an API key first"));
              }
            }}
            disabled={detectProviderMutation.isPending}
          >
            <WandSparkles className="mr-2 h-4 w-4" />
            {localize(locale, "自动识别并保存", "Auto-detect & Save")}
          </ActionButton>
          {providerValidated && (
            <StatusPill tone="success">
              {localize(locale, "已验证", "Validated")}
            </StatusPill>
          )}
        </div>
        <p className="mt-2 max-w-md text-center text-xs text-[color:var(--color-text-faint)]">
          {localize(
            locale,
            "支持 OpenAI、Anthropic、DeepSeek、智谱、月之暗面、Google 等主流厂商的 API 密钥自动识别",
            "Auto-detects API keys from OpenAI, Anthropic, DeepSeek, Zhipu, Moonshot, Google, and more",
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
            if (providerApiKey.trim() && !providerValidated) {
              // Auto-detect then save then advance
              detectProviderMutation.mutate(undefined, {
                onSuccess: () => {
                  saveProviderMutation.mutate(undefined, { onSuccess: goNext });
                },
              });
            } else if (providerValidated) {
              saveProviderMutation.mutate(undefined, { onSuccess: goNext });
            } else {
              goNext();
            }
          }}
          label={
            providerApiKey.trim()
              ? localize(locale, "检测并继续", "Detect & Continue")
              : localize(locale, "继续", "Continue")
          }
        />
        <SkipLink onClick={goNext} />
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
                      `Friday 在你的电脑上找到了 ${skillScanItems.length} 个来自 Claude Code、Codex 等工具的技能配置。`,
                      `Friday found ${skillScanItems.length} skill configs from Claude Code, Codex, and other tools on your computer.`,
                    )}
                  </p>
                  <div className="mt-4 space-y-2">
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
                          {item.sourceTool}
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
                          ? localize(locale, "导入中...", "Importing...")
                          : localize(locale, `导入选中 (${selectedSkillPaths.size})`, `Import Selected (${selectedSkillPaths.size})`)}
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
                            {entry.error ?? localize(locale, "导入失败，但后端没有返回更具体的原因。", "Import failed, but the backend did not return a more specific reason.")}
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
      } else {
        next.add(kind);
        setExpandedChannel(kind);
      }
      return next;
    });
  }

  function updateChannelConfig(kind: ChannelKind, key: string, value: string) {
    setChannelConfigs((prev) => ({
      ...prev,
      [kind]: { ...prev[kind], [key]: value },
    }));
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
          {CHANNEL_KINDS_ORDERED.map((kind) => {
            const meta = CHANNEL_META[kind];
            const enabled = enabledChannels.has(kind);
            const expanded = expandedChannel === kind && enabled;
            const config = channelConfigs[kind] ?? {};

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

                {expanded && meta.fields.length > 0 && (
                  <div className="border-t border-[color:var(--color-border-soft)] px-4 pb-4 pt-3">
                    <div className="space-y-3">
                      {meta.fields.map((field) => (
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
            ? localize(locale, "保存并继续", "Save & Continue")
            : localize(locale, "继续", "Continue")}
          disabled={saveChannelsMutation.isPending || (enabledChannels.size > 0 && !channelControlConfirmed)}
        />
        <SkipLink onClick={goNext} />
        <BottomDots />
      </StepContainer>
    );
  }

  // ─── STEP 5 — Communication Style ───

  function renderStep5() {
    const preview = buildPersonaPreview(getMbtiDefaults(communicationMbti || null), locale, communicationMbti || null);

    return (
      <StepContainer>
        <BackLink />
        <Eyebrow step={5} />
        <h1 className="text-4xl font-semibold tracking-tight text-[color:var(--color-text-primary)] sm:text-5xl">
          {localize(locale, "选择沟通风格", "Choose Communication Style")}
        </h1>
        <p className="mt-4 max-w-lg text-lg text-[color:var(--color-text-secondary)]">
          {localize(
            locale,
            "Friday 会根据你的偏好调整交流方式。",
            "Friday adapts how it communicates based on your preference.",
          )}
        </p>

        {/* All 16 MBTI types in a 4-column grid with descriptions */}
        <div className="mt-8 grid w-full max-w-2xl grid-cols-2 gap-2 sm:grid-cols-4">
          {COMMUNICATION_MBTI_OPTIONS.map((mbti) => {
            const active = communicationMbti === mbti;
            return (
              <button
                key={mbti}
                type="button"
                onClick={() => {
                  setCommunicationMbti(mbti);
                  setCommunicationSaved(false);
                }}
                className={`rounded-2xl border-2 px-3 py-3 text-left transition ${
                  active
                    ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)]"
                    : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] hover:border-[color:var(--color-border-strong)]"
                }`}
              >
                <span className="text-sm font-bold text-[color:var(--color-text-primary)]">{mbti}</span>
                <p className="mt-0.5 text-[11px] leading-tight text-[color:var(--color-text-secondary)]">
                  {getMbtiDescription(mbti, locale)}
                </p>
              </button>
            );
          })}
        </div>

        {/* Preview */}
        {communicationMbti && (
          <div className="mt-6 w-full max-w-2xl rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-5 text-left">
            <div className="flex items-center gap-2 text-[color:var(--color-text-primary)]">
              <MessageCircleMore className="h-4 w-4" />
              <span className="text-sm font-medium">{localize(locale, "预览 · Friday 会这样和你说话", "Preview · Friday will talk to you like this")}</span>
            </div>
            <p className="mt-3 text-sm text-[color:var(--color-text-primary)]">{preview.sampleClarifier}</p>
            <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">{preview.sampleBoundary}</p>
          </div>
        )}

        <ContinueButton
          onClick={() => {
            if (communicationMbti) {
              saveCommunicationMutation.mutate(undefined, { onSuccess: goNext });
            } else {
              goNext();
            }
          }}
          label={communicationMbti ? localize(locale, "保存并继续", "Save & Continue") : localize(locale, "继续", "Continue")}
        />
        <SkipLink onClick={goNext} />
        <BottomDots />
      </StepContainer>
    );
  }

  // ─── STEP 6 — Completion ───

  function renderStep6() {
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
    if (channelsSaved && enabledChannels.size > 0) {
      summaryItems.push(
        localize(locale, `${enabledChannels.size} 个渠道`, `${enabledChannels.size} channels`),
      );
    }
    if (communicationSaved && communicationMbti) {
      summaryItems.push(communicationMbti);
    }

    return (
      <StepContainer>
        <BackLink />

        {/* Animated checkmark */}
        <div className="setup-completion-pulse mb-6 flex h-24 w-24 items-center justify-center rounded-full bg-[color:var(--color-accent-soft)]">
          <CheckCircle2 className="h-12 w-12 text-[color:var(--color-accent)]" />
        </div>

        <h1 className="text-4xl font-semibold tracking-tight text-[color:var(--color-text-primary)] sm:text-5xl">
          {localize(locale, "Friday 已就绪", "Friday is Ready")}
        </h1>

        {summaryItems.length > 0 && (
          <p className="mt-4 text-lg text-[color:var(--color-text-secondary)]">
            {summaryItems.join(" · ")}
          </p>
        )}

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
      {/* Subtle background orbs */}
      <div className="pointer-events-none absolute inset-0">
        <div className="agent-orb agent-orb-left" />
        <div className="agent-orb agent-orb-right" />
      </div>

      <div className="relative">
        {currentStep === 0 && renderStep0()}
        {currentStep === 1 && renderStep1()}
        {currentStep === 2 && renderStep2()}
        {currentStep === 3 && renderStep3()}
        {currentStep === 4 && renderStep4()}
        {currentStep === 5 && renderStep5()}
        {currentStep === 6 && renderStep6()}
      </div>
    </div>
  );
}
