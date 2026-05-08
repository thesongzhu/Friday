import type {
  FridayProviderKind,
  FridayProviderProfile,
  FridayProviderValidationState,
  FridayResolvedProviderRoute,
  FridayRuntimeCapabilityId,
} from "./friday-provider.types.js";
import { FRIDAY_RUNTIME_CAPABILITY_IDS } from "./friday-provider.types.js";

export type FridayRuntimeCapabilityState =
  | "available"
  | "configured_but_unverified"
  | "needs_user_auth"
  | "installable_with_approval"
  | "buildable_with_approval"
  | "unsupported"
  | "failed_verification";

export type FridayRuntimeCapabilitySourceKind =
  | "provider"
  | "tool"
  | "skill"
  | "mcp"
  | "builtin"
  | "custom";

export type FridayRuntimeCapabilitySourceStatus =
  | "verified"
  | "declared"
  | "inferred"
  | "unverified"
  | "failed";

export type FridayRuntimeCapabilityRisk =
  | "auth"
  | "paid_api"
  | "network"
  | "local_execution"
  | "third_party_install"
  | "writes_config";

export interface FridayRuntimeCapabilitySource {
  kind: FridayRuntimeCapabilitySourceKind;
  id: string;
  label: string;
  status: FridayRuntimeCapabilitySourceStatus;
  providerId?: string;
  providerKind?: FridayProviderKind;
  model?: string;
  verifiedAt?: string;
  detail?: string;
}

export interface FridayRuntimeCapabilityRepairOption {
  id: string;
  label: string;
  description: string;
  kind:
    | "configure_provider"
    | "open_docs"
    | "enable_builtin"
    | "install_skill"
    | "install_mcp"
    | "generate_tool"
    | "custom";
  requiresApproval: boolean;
  providerKind?: FridayProviderKind;
  setupHref?: string;
  href?: string;
  risks: FridayRuntimeCapabilityRisk[];
}

export interface FridayRuntimeCapabilityItem {
  capability: FridayRuntimeCapabilityId;
  label: string;
  description: string;
  state: FridayRuntimeCapabilityState;
  sources: FridayRuntimeCapabilitySource[];
  blockers: string[];
  repairOptions: FridayRuntimeCapabilityRepairOption[];
  lastVerifiedAt?: string;
}

export interface FridayRuntimeCapabilityMatrix {
  schemaVersion: "1.0";
  generatedAt: string;
  items: FridayRuntimeCapabilityItem[];
  summary: {
    available: number;
    needsVerification: number;
    needsUserAction: number;
    installable: number;
    unsupported: number;
  };
}

export interface BuildFridayRuntimeCapabilityMatrixInput {
  nowIso: string;
  readOnly?: boolean;
  providers: FridayProviderProfile[];
  webSearch?: {
    provider: string;
    latestness: "provider_backed" | "unverified";
    warning?: string;
  };
  pdfParseEnabled?: boolean;
  browserEnabled?: boolean;
  browserVerified?: boolean;
  browserDetail?: string;
  mcpServerCount?: number;
  mcpVerifiedServerCount?: number;
  skillCount?: number;
  ttsEnabled?: boolean;
  ttsVerified?: boolean;
  ttsDetail?: string;
}

const CAPABILITY_COPY: Record<FridayRuntimeCapabilityId, {
  label: string;
  description: string;
}> = {
  text: {
    label: "Text generation",
    description: "Route normal language and reasoning tasks to a configured model.",
  },
  vision: {
    label: "Image understanding",
    description: "Send image inputs to a model that is known or declared to accept images.",
  },
  ocr: {
    label: "OCR",
    description: "Extract text from images or scanned documents with a dedicated OCR path.",
  },
  embedding: {
    label: "Embeddings",
    description: "Create vectors for semantic memory and similarity search.",
  },
  web_search: {
    label: "Web search",
    description: "Search the web before fetching specific sources.",
  },
  web_fetch: {
    label: "Web fetch",
    description: "Fetch and parse specific URLs.",
  },
  pdf_parse: {
    label: "PDF parsing",
    description: "Extract text and structured content from PDFs.",
  },
  file_read: {
    label: "File read",
    description: "Read local workspace files.",
  },
  file_write: {
    label: "File write",
    description: "Write or edit local workspace files.",
  },
  tts: {
    label: "Text to speech",
    description: "Synthesize speech from text.",
  },
  browser: {
    label: "Browser",
    description: "Open and inspect web pages through the browser runtime.",
  },
  mcp: {
    label: "MCP",
    description: "Use configured Model Context Protocol servers.",
  },
  skills: {
    label: "Skills",
    description: "Discover and run installed Friday skills.",
  },
  custom: {
    label: "Custom capabilities",
    description: "User-declared or generated capabilities outside the core set.",
  },
};

const OFFICIAL_SETUP_REPAIRS: Partial<Record<FridayRuntimeCapabilityId, FridayRuntimeCapabilityRepairOption[]>> = {
  text: [
    providerRepair("configure-openai", "Configure OpenAI", "Add an OpenAI-compatible text model and verify it.", "openai", "https://platform.openai.com/api-keys"),
    providerRepair("configure-qwen", "Configure Qwen", "Add DashScope/Qwen as a China-region OpenAI-compatible route.", "qwen", "https://help.aliyun.com/zh/model-studio/get-api-key"),
    providerRepair("configure-deepseek", "Configure DeepSeek", "Add DeepSeek chat or reasoner models.", "deepseek", "https://api-docs.deepseek.com/"),
  ],
  vision: [
    providerRepair("configure-google-vision", "Configure Gemini", "Add a Gemini model and run an image-understanding probe.", "google", "https://ai.google.dev/gemini-api/docs"),
    providerRepair("configure-qwen-vl", "Configure Qwen-VL", "Add a Qwen vision model and verify image understanding.", "qwen", "https://help.aliyun.com/zh/model-studio/"),
    providerRepair("configure-volcengine-vision", "Configure Doubao vision", "Create a Volcengine ModelArk multimodal endpoint and verify it.", "volcengine", "https://www.volcengine.com/docs/82379"),
  ],
  ocr: [
    providerRepair("configure-volcengine-ocr", "Configure Volcengine OCR", "Enable a dedicated OCR API and verify text extraction.", "volcengine", "https://www.volcengine.com/docs"),
    providerRepair("configure-google-vision-ocr", "Configure Google Vision OCR", "Enable Google OCR and verify text extraction.", "google", "https://cloud.google.com/vision/docs/ocr"),
    buildRepair("generate-local-ocr-tool", "Generate local OCR tool", "Create a local OCR tool in an isolated generated-tools directory after approval."),
  ],
  embedding: [
    providerRepair("configure-openai-embeddings", "Configure OpenAI embeddings", "Add an OpenAI-compatible embedding model such as text-embedding-3-small.", "openai", "https://platform.openai.com/docs/guides/embeddings"),
    providerRepair("configure-qwen-embeddings", "Configure Qwen embeddings", "Add a DashScope embedding model and verify vector generation.", "qwen", "https://help.aliyun.com/zh/model-studio/"),
  ],
  web_search: [
    customRepair("configure-serper-search", "Configure Serper search", "Add FRIDAY_SERPER_API_KEY for provider-backed web search with freshness support.", "https://serper.dev/api-key", ["auth", "paid_api", "network", "writes_config"]),
    customRepair("configure-tavily-search", "Configure Tavily search", "Add FRIDAY_TAVILY_API_KEY for provider-backed web search.", "https://app.tavily.com/home", ["auth", "paid_api", "network", "writes_config"]),
  ],
  file_write: [
    customRepair("enable-write-mode", "Use execute mode", "Run the task outside read-only mode when file writes are required.", undefined, ["writes_config"]),
  ],
  pdf_parse: [
    buildRepair("generate-pdf-parser-tool", "Generate PDF parser", "Create a local PDF parser tool after approval.", "https://mozilla.github.io/pdf.js/"),
    installRepair("install-pdf-skill", "Install PDF skill", "Install a trusted PDF parsing skill after approval."),
  ],
  tts: [
    providerRepair("configure-openai-tts", "Configure OpenAI TTS", "Add an OpenAI-compatible speech model and verify short audio synthesis.", "openai", "https://platform.openai.com/docs/guides/text-to-speech"),
    providerRepair("configure-minimax-tts", "Configure MiniMax TTS", "Add a TTS provider and verify short audio synthesis.", "minimax", "https://www.minimaxi.com/document"),
    providerRepair("configure-volcengine-tts", "Configure Volcengine TTS", "Enable a Volcengine speech service and verify synthesis.", "volcengine", "https://www.volcengine.com/docs"),
  ],
  mcp: [
    installMcpRepair("install-mcp-server", "Add MCP server", "Configure an MCP server after reviewing its permissions."),
  ],
  skills: [
    installRepair("install-skill", "Install skill", "Install a trusted skill after reviewing its source and permissions."),
    buildRepair("generate-skill", "Generate skill", "Generate a local skill in skills/generated after approval."),
  ],
  browser: [
    customRepair("enable-browser-runtime", "Enable browser runtime", "Enable the browser tool runtime and verify navigation before using browser-dependent tasks.", undefined, ["network", "local_execution", "writes_config"]),
  ],
  custom: [
    buildRepair("generate-custom-tool", "Generate custom tool", "Generate a local tool for this capability after reviewing the plan and permissions."),
    installRepair("install-capability-skill", "Install capability skill", "Install a trusted skill that provides this capability."),
    installMcpRepair("install-capability-mcp", "Install MCP server", "Configure a trusted MCP server that provides this capability."),
  ],
};

const CAPABILITY_RECIPE_IDS: Partial<Record<FridayRuntimeCapabilityId, string>> = {
  text: "capability-text",
  vision: "capability-vision",
  ocr: "capability-ocr",
  embedding: "capability-embedding",
  web_search: "capability-web-search",
  pdf_parse: "capability-pdf-parse",
  tts: "capability-tts",
  browser: "capability-browser",
  mcp: "capability-mcp",
  skills: "capability-skills",
  custom: "capability-custom",
};

export function buildFridayRuntimeCapabilityMatrix(
  input: BuildFridayRuntimeCapabilityMatrixInput,
): FridayRuntimeCapabilityMatrix {
  const providerSources = buildProviderSources(input.providers);
  const items = FRIDAY_RUNTIME_CAPABILITY_IDS.map((capability) => {
    const builtInSources = buildBuiltInSources(capability, input);
    const sources = [
      ...(providerSources.get(capability) ?? []),
      ...builtInSources,
    ];
    const state = resolveCapabilityState(capability, sources, input);
    const copy = CAPABILITY_COPY[capability];
    const lastVerifiedAt = sources
      .map((source) => source.verifiedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);

    return {
      capability,
      label: copy.label,
      description: copy.description,
      state,
      sources,
      blockers: buildBlockers(capability, state, input),
      repairOptions: buildRepairOptions(capability, state),
      ...(lastVerifiedAt ? { lastVerifiedAt } : {}),
    } satisfies FridayRuntimeCapabilityItem;
  });

  return {
    schemaVersion: "1.0",
    generatedAt: input.nowIso,
    items,
    summary: {
      available: items.filter((item) => item.state === "available").length,
      needsVerification: items.filter((item) => item.state === "configured_but_unverified").length,
      needsUserAction: items.filter((item) =>
        item.state === "needs_user_auth" || item.state === "failed_verification",
      ).length,
      installable: items.filter((item) =>
        item.state === "installable_with_approval" || item.state === "buildable_with_approval",
      ).length,
      unsupported: items.filter((item) => item.state === "unsupported").length,
    },
  };
}

export function filterFridayProviderRoutesByRequiredCapabilities(
  routes: readonly FridayResolvedProviderRoute[],
  requiredCapabilities: readonly FridayRuntimeCapabilityId[] | undefined,
): FridayResolvedProviderRoute[] {
  const required = normalizeRequiredCapabilities(requiredCapabilities);
  if (required.length === 0) {
    return [...routes];
  }
  return routes.filter((route) =>
    required.every((capability) => fridayProviderRouteSupportsCapability(route, capability)),
  );
}

export function fridayProviderRouteSupportsCapability(
  route: FridayResolvedProviderRoute,
  capability: FridayRuntimeCapabilityId,
): boolean {
  if (!isProviderLifecycleAvailableForRuntime(route.provider)) {
    return false;
  }
  if (route.provider.config.validation?.status !== "ok") {
    return false;
  }
  switch (capability) {
    case "text": {
      const explicit = explicitProviderCapabilityStatus(route.provider, "text", route.model);
      return explicit?.status === "verified";
    }
    case "vision": {
      const explicit = explicitProviderCapabilityStatus(route.provider, "vision", route.model);
      return explicit?.status === "verified";
    }
    case "embedding": {
      const explicit = explicitProviderCapabilityStatus(route.provider, "embedding", route.model);
      return explicit?.status === "verified";
    }
    case "ocr":
    case "tts":
    case "custom":
      return explicitProviderCapabilityStatus(route.provider, capability, route.model)?.status === "verified";
    default:
      return false;
  }
}

function buildProviderSources(
  providers: readonly FridayProviderProfile[],
): Map<FridayRuntimeCapabilityId, FridayRuntimeCapabilitySource[]> {
  const byCapability = new Map<FridayRuntimeCapabilityId, FridayRuntimeCapabilitySource[]>();
  const push = (capability: FridayRuntimeCapabilityId, source: FridayRuntimeCapabilitySource) => {
    byCapability.set(capability, [...(byCapability.get(capability) ?? []), source]);
  };

  for (const provider of providers) {
    if (!provider.enabled) {
      continue;
    }
    const providerValidationStatus = provider.config.validation?.status ?? "never";
    const lifecycleAvailable = isProviderLifecycleAvailableForRuntime(provider);
    const models = provider.config.supportedModels.length > 0
      ? provider.config.supportedModels
      : provider.defaultModel
        ? [provider.defaultModel]
        : [];

    for (const model of models) {
      const textExplicitStatus = explicitProviderCapabilityStatus(provider, "text", model);
      const textStatus = textExplicitStatus
        ? providerValidatedSourceStatus(
            providerValidationStatus,
            lifecycleAvailable ? explicitStatusToSourceStatus(textExplicitStatus.status) : "unverified",
          )
        : providerValidationStatus === "failed"
          ? "failed"
          : "unverified";
      push("text", providerSource(provider, model, textStatus, textExplicitStatus));

      const visionStatus = explicitProviderCapabilityStatus(provider, "vision", model);
      if (visionStatus || inferFridayModelSupportsVision(provider.kind, model)) {
        push("vision", providerSource(
          provider,
          model,
          providerValidatedSourceStatus(
            providerValidationStatus,
            lifecycleAvailable
              ? visionStatus ? explicitStatusToSourceStatus(visionStatus.status) : "inferred"
              : "unverified",
          ),
          visionStatus,
        ));
      }
      const embeddingStatus = explicitProviderCapabilityStatus(provider, "embedding", model);
      if (embeddingStatus || inferFridayModelSupportsEmbedding(model)) {
        push("embedding", providerSource(
          provider,
          model,
          providerValidatedSourceStatus(
            providerValidationStatus,
            lifecycleAvailable
              ? embeddingStatus ? explicitStatusToSourceStatus(embeddingStatus.status) : "inferred"
              : "unverified",
          ),
          embeddingStatus,
        ));
      }
      for (const capability of ["ocr", "tts", "custom"] as const) {
        const explicitStatus = explicitProviderCapabilityStatus(provider, capability, model);
        if (explicitStatus) {
          push(capability, providerSource(
            provider,
            model,
            providerValidatedSourceStatus(
              providerValidationStatus,
              lifecycleAvailable ? explicitStatusToSourceStatus(explicitStatus.status) : "unverified",
            ),
            explicitStatus,
          ));
        }
      }
    }
  }
  return byCapability;
}

function isProviderLifecycleAvailableForRuntime(provider: FridayProviderProfile): boolean {
  const promotionChannel = provider.promotionChannel ?? "none";
  return promotionChannel === "none" || promotionChannel === "active";
}

function providerValidatedSourceStatus(
  providerValidationStatus: FridayProviderValidationState["status"],
  sourceStatus: FridayRuntimeCapabilitySourceStatus,
): FridayRuntimeCapabilitySourceStatus {
  if (providerValidationStatus === "failed") {
    return "failed";
  }
  if (providerValidationStatus !== "ok") {
    return "unverified";
  }
  return sourceStatus;
}

function buildBuiltInSources(
  capability: FridayRuntimeCapabilityId,
  input: BuildFridayRuntimeCapabilityMatrixInput,
): FridayRuntimeCapabilitySource[] {
  switch (capability) {
    case "web_search":
      return [{
        kind: "tool",
        id: "web_search",
        label: `web_search (${input.webSearch?.provider ?? "auto"})`,
        status: input.webSearch?.latestness === "provider_backed" ? "verified" : "unverified",
        detail: input.webSearch?.warning,
      }];
    case "web_fetch":
      return [toolSource("web_fetch", "web_fetch", "verified")];
    case "pdf_parse":
      return input.pdfParseEnabled
        ? [toolSource("pdf_parse", "pdf_parse", "verified")]
        : [];
    case "file_read":
      return [toolSource("read", "read", "verified")];
    case "file_write":
      return input.readOnly ? [] : [toolSource("write/edit", "write + edit", "verified")];
    case "browser":
      return input.browserEnabled
        ? [toolSource(
            "browser",
            "browser",
            input.browserVerified ? "verified" : "unverified",
            input.browserDetail,
          )]
        : [];
    case "mcp":
      return buildMcpSources(input);
    case "skills":
      return (input.skillCount ?? 0) > 0
        ? [{
            kind: "skill",
            id: "skills",
            label: `${String(input.skillCount ?? 0)} installed skill(s)`,
            status: "verified",
          }]
        : [];
    case "tts":
      return input.ttsEnabled ? [toolSource(
        "tts",
        "tts",
        input.ttsVerified ? "verified" : "unverified",
        input.ttsDetail,
      )] : [];
    default:
      return [];
  }
}

function buildMcpSources(
  input: BuildFridayRuntimeCapabilityMatrixInput,
): FridayRuntimeCapabilitySource[] {
  const configured = input.mcpServerCount ?? 0;
  const verified = input.mcpVerifiedServerCount ?? 0;
  if (configured <= 0) {
    return [];
  }
  const sources: FridayRuntimeCapabilitySource[] = [];
  if (verified > 0) {
    sources.push({
      kind: "mcp",
      id: "mcp:verified",
      label: `${String(verified)} verified MCP server(s)`,
      status: "verified",
    });
  }
  const unverified = Math.max(0, configured - verified);
  if (unverified > 0) {
    sources.push({
      kind: "mcp",
      id: "mcp:configured",
      label: `${String(unverified)} configured but unverified MCP server(s)`,
      status: "unverified",
      detail: "Run MCP discovery/list_tools to verify the server starts, authenticates, and returns tools.",
    });
  }
  return sources;
}

function resolveCapabilityState(
  capability: FridayRuntimeCapabilityId,
  sources: readonly FridayRuntimeCapabilitySource[],
  input: BuildFridayRuntimeCapabilityMatrixInput,
): FridayRuntimeCapabilityState {
  if (sources.some((source) => source.status === "verified")) {
    return "available";
  }
  if (sources.some((source) => source.status === "failed")) {
    return "failed_verification";
  }
  if (sources.length > 0) {
    return "configured_but_unverified";
  }
  if (capability === "file_write" && input.readOnly) {
    return "unsupported";
  }
  if (capability === "pdf_parse") {
    return "buildable_with_approval";
  }
  if (capability === "browser" || capability === "mcp" || capability === "skills") {
    return "installable_with_approval";
  }
  if (capability === "custom") {
    return "buildable_with_approval";
  }
  if (capability === "ocr" || capability === "embedding" || capability === "vision" || capability === "tts" || capability === "text") {
    return "needs_user_auth";
  }
  return "unsupported";
}

function buildBlockers(
  capability: FridayRuntimeCapabilityId,
  state: FridayRuntimeCapabilityState,
  input: BuildFridayRuntimeCapabilityMatrixInput,
): string[] {
  if (state === "available") {
    return [];
  }
  if (capability === "file_write" && input.readOnly) {
    return ["Current run is read-only; write/edit tools are blocked."];
  }
  if (state === "configured_but_unverified") {
    return ["Capability is declared or inferred but has not passed a dedicated doctor probe."];
  }
  if (state === "failed_verification") {
    return ["At least one configured source failed validation. Re-run doctor after fixing credentials, model, or base URL."];
  }
  if (state === "needs_user_auth") {
    return ["No verified source is configured. This usually needs an account, API key, OAuth login, or cloud-console enablement."];
  }
  if (state === "installable_with_approval" || state === "buildable_with_approval") {
    return ["Friday can propose a skill/tool path, but installation or generated local execution requires user approval."];
  }
  return ["No supported source is currently wired for this capability."];
}

function buildRepairOptions(
  capability: FridayRuntimeCapabilityId,
  state: FridayRuntimeCapabilityState,
): FridayRuntimeCapabilityRepairOption[] {
  if (state === "available") {
    return [];
  }
  const repairs = OFFICIAL_SETUP_REPAIRS[capability] ?? [];
  const recipeId = CAPABILITY_RECIPE_IDS[capability];
  if (!recipeId) {
    return repairs;
  }
  const setupHref = `/setup?recipeId=${encodeURIComponent(recipeId)}&targetService=${encodeURIComponent(capability)}`;
  return repairs.map((repair) => ({
    ...repair,
    setupHref: repair.setupHref ?? setupHref,
  }));
}

function providerSource(
  provider: FridayProviderProfile,
  model: string,
  status: FridayRuntimeCapabilitySourceStatus,
  explicit?: FridayExplicitProviderCapability,
): FridayRuntimeCapabilitySource {
  return {
    kind: "provider",
    id: `${provider.id}:${model}`,
    label: `${provider.name} / ${model}`,
    status,
    providerId: provider.id,
    providerKind: provider.kind,
    model,
    verifiedAt: status === "verified"
      ? explicit?.verifiedAt ?? provider.config.validation?.checkedAt
      : undefined,
    detail: explicit?.notes ?? provider.config.validation?.errorMessage,
  };
}

function toolSource(
  id: string,
  label: string,
  status: FridayRuntimeCapabilitySourceStatus,
  detail?: string,
): FridayRuntimeCapabilitySource {
  return {
    kind: "tool",
    id,
    label,
    status,
    ...(detail ? { detail } : {}),
  };
}

function providerRepair(
  id: string,
  label: string,
  description: string,
  providerKind: FridayProviderKind,
  href: string,
): FridayRuntimeCapabilityRepairOption {
  return {
    id,
    label,
    description,
    kind: "configure_provider",
    requiresApproval: true,
    providerKind,
    setupHref: `/setup?step=provider&providerKind=${encodeURIComponent(providerKind)}&recipeId=provider-${encodeURIComponent(providerKind)}`,
    href,
    risks: ["auth", "paid_api", "network", "writes_config"],
  };
}

function installRepair(
  id: string,
  label: string,
  description: string,
): FridayRuntimeCapabilityRepairOption {
  return {
    id,
    label,
    description,
    kind: "install_skill",
    requiresApproval: true,
    risks: ["third_party_install", "local_execution", "writes_config"],
  };
}

function installMcpRepair(
  id: string,
  label: string,
  description: string,
): FridayRuntimeCapabilityRepairOption {
  return {
    id,
    label,
    description,
    kind: "install_mcp",
    requiresApproval: true,
    risks: ["third_party_install", "local_execution", "writes_config"],
  };
}

function buildRepair(
  id: string,
  label: string,
  description: string,
  href?: string,
): FridayRuntimeCapabilityRepairOption {
  return {
    id,
    label,
    description,
    kind: "generate_tool",
    requiresApproval: true,
    ...(href ? { href } : {}),
    risks: ["local_execution", "writes_config"],
  };
}

function customRepair(
  id: string,
  label: string,
  description: string,
  href: string | undefined,
  risks: FridayRuntimeCapabilityRisk[],
): FridayRuntimeCapabilityRepairOption {
  return {
    id,
    label,
    description,
    kind: "custom",
    requiresApproval: true,
    ...(href ? { href } : {}),
    risks,
  };
}

function normalizeRequiredCapabilities(
  input: readonly FridayRuntimeCapabilityId[] | undefined,
): FridayRuntimeCapabilityId[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const valid = new Set<string>(FRIDAY_RUNTIME_CAPABILITY_IDS);
  const result: FridayRuntimeCapabilityId[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!valid.has(raw) || seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    result.push(raw);
  }
  return result;
}

export function inferFridayModelSupportsVision(kind: FridayProviderKind, model: string): boolean {
  const normalized = model.toLowerCase();
  if (normalized.includes("vision") || normalized.includes("-vl") || normalized.includes("_vl") || normalized.includes("omni")) {
    return true;
  }
  if (kind === "google" && normalized.includes("gemini")) {
    return true;
  }
  if (kind === "openai" || kind === "openai-compatible" || kind === "openrouter") {
    return /\b(gpt-4o|gpt-4\.1|gpt-5|o3|o4)\b/.test(normalized);
  }
  if (kind === "qwen") {
    return normalized.includes("qwen-vl") || normalized.includes("qwen2.5-vl") || normalized.includes("qvq");
  }
  if (kind === "glm") {
    return normalized.includes("glm-4v") || normalized.includes("glm-4.5v");
  }
  return false;
}

export function inferFridayModelSupportsEmbedding(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.includes("embedding") || normalized.includes("embed") || normalized.includes("bge-") || normalized.includes("gte-");
}

type FridayExplicitProviderCapabilityStatus = "declared" | "verified" | "failed";

interface FridayExplicitProviderCapability {
  capability: FridayRuntimeCapabilityId;
  model?: string;
  status: FridayExplicitProviderCapabilityStatus;
  verified?: boolean;
  verifiedAt?: string;
  notes?: string;
}

function readExplicitProviderCapabilities(
  provider: FridayProviderProfile,
): FridayExplicitProviderCapability[] {
  const config = provider.config as unknown as Record<string, unknown>;
  const raw = config.runtimeCapabilities ?? config.capabilities;
  if (!Array.isArray(raw)) {
    return [];
  }
  const valid = new Set<string>(FRIDAY_RUNTIME_CAPABILITY_IDS);
  const result: FridayExplicitProviderCapability[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const capability = record.capability;
    if (typeof capability !== "string" || !valid.has(capability)) {
      continue;
    }
    const model = typeof record.model === "string" && record.model.trim().length > 0
      ? record.model.trim()
      : undefined;
    const status = record.status === "failed"
      ? "failed"
      : record.status === "verified" || record.verified === true
        ? "verified"
        : "declared";
    const verifiedAt = typeof record.verifiedAt === "string" && record.verifiedAt.trim().length > 0
      ? record.verifiedAt.trim()
      : undefined;
    const notes = typeof record.notes === "string" && record.notes.trim().length > 0
      ? record.notes.trim()
      : undefined;
    result.push({
      capability: capability as FridayRuntimeCapabilityId,
      ...(model ? { model } : {}),
      status,
      verified: status === "verified",
      ...(verifiedAt ? { verifiedAt } : {}),
      ...(notes ? { notes } : {}),
    });
  }
  return result;
}

function explicitProviderCapabilityStatus(
  provider: FridayProviderProfile,
  capability: FridayRuntimeCapabilityId,
  model: string,
): FridayExplicitProviderCapability | undefined {
  const entries = readExplicitProviderCapabilities(provider)
    .filter((entry) =>
      entry.capability === capability
      && (!entry.model || entry.model === model)
    );
  return entries.find((entry) => entry.status === "failed")
    ?? entries.find((entry) => entry.status === "verified")
    ?? entries[0];
}

function explicitStatusToSourceStatus(
  status: FridayExplicitProviderCapabilityStatus,
): FridayRuntimeCapabilitySourceStatus {
  switch (status) {
    case "verified":
      return "verified";
    case "failed":
      return "failed";
    case "declared":
      return "declared";
  }
}
