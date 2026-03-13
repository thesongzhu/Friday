import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type { FridayProviderService } from "../../providers/services/friday-provider-service.types.js";
import type {
  FridayProviderApi,
  FridayProviderAuthMode,
  FridayProviderKind,
} from "../../providers/model/friday-provider.types.js";
import { isFridayProviderKind } from "../../providers/model/friday-provider-catalog.js";
import { detectFridayProviderKindFromApiKey } from "../../providers/model/friday-provider-catalog.js";
import { FRIDAY_PROVIDER_KINDS, FRIDAY_PROVIDER_APIS } from "../../providers/model/friday-provider.types.js";
import {
  errorResult,
  jsonResult,
  readBooleanParam,
  readRecordParam,
  readStringArrayParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Constants ───

type ProviderAction =
  | "list"
  | "get"
  | "detect"
  | "create"
  | "update"
  | "delete"
  | "oauth_init"
  | "oauth_complete"
  | "set_default"
  | "validate";

const VALID_ACTIONS = new Set<ProviderAction>([
  "list",
  "get",
  "detect",
  "create",
  "update",
  "delete",
  "oauth_init",
  "oauth_complete",
  "set_default",
  "validate",
]);

const VALID_AUTH_MODES = new Set<FridayProviderAuthMode>([
  "api-key",
  "bearer-token",
  "oauth",
  "none",
]);

// ─── Types ───

export interface CreateFridayAgentProviderToolOptions {
  providerService: FridayProviderService;
}

// ─── Factory ───

export function createFridayAgentProviderTool(
  options: CreateFridayAgentProviderToolOptions,
): FridayAgentToolDefinition {
  const { providerService } = options;

  return {
    name: "provider",
    description:
      "Manage LLM providers and model routing. " +
      "Actions: list (list all providers), get (get provider by ID), detect (auto-detect provider type from API key), " +
      "create (create new provider), update (update existing provider), delete (delete provider), " +
      "oauth_init (start OAuth flow, returns authorization URL), oauth_complete (complete OAuth with code), " +
      "set_default (set default provider/model for routing), validate (validate provider connection).",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: Array.from(VALID_ACTIONS),
          description: "Provider action to perform.",
        },
        providerId: {
          type: "string",
          description: "Provider ID (required for get, update, delete, oauth_init, oauth_complete, validate).",
        },
        kind: {
          type: "string",
          enum: Array.from(FRIDAY_PROVIDER_KINDS),
          description: "Provider kind (required for create). E.g., openai, anthropic, ollama.",
        },
        name: {
          type: "string",
          description: "Display name for the provider (required for create, optional for update).",
        },
        baseUrl: {
          type: "string",
          description: "Base URL for the provider API (required for create, optional for update).",
        },
        apiKey: {
          type: "string",
          description: "API key or $ENV_VAR reference. Use $ENV_VAR syntax to reference environment variables.",
        },
        api: {
          type: "string",
          enum: Array.from(FRIDAY_PROVIDER_APIS),
          description: "API protocol (openai-completions, openai-responses, anthropic-messages, google-generative-ai, ollama).",
        },
        authMode: {
          type: "string",
          enum: ["api-key", "bearer-token", "oauth", "none"],
          description: "Authentication mode.",
        },
        supportedModels: {
          type: "array",
          items: { type: "string" },
          description: "List of supported model identifiers.",
        },
        defaultModel: {
          type: "string",
          description: "Default model to use for this provider.",
        },
        headers: {
          type: "object",
          description: "Additional HTTP headers to send with requests.",
        },
        enabled: {
          type: "boolean",
          description: "Whether the provider is enabled.",
        },
        authorizationCode: {
          type: "string",
          description: "OAuth authorization code (required for oauth_complete).",
        },
        state: {
          type: "string",
          description: "OAuth state parameter (optional for oauth_complete).",
        },
      },
      required: ["action"],
    },

    async execute(
      args: Record<string, unknown>,
      _signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const action = readStringParam(args, "action", { required: true }) as ProviderAction;

      if (!VALID_ACTIONS.has(action)) {
        return errorResult(
          `Invalid action "${action}". Valid: ${Array.from(VALID_ACTIONS).join(", ")}`,
        );
      }

      try {
        switch (action) {
          case "list":
            return await handleList();
          case "get":
            return await handleGet(args);
          case "detect":
            return await handleDetect(args);
          case "create":
            return await handleCreate(args);
          case "update":
            return await handleUpdate(args);
          case "delete":
            return await handleDelete(args);
          case "oauth_init":
            return await handleOAuthInit(args);
          case "oauth_complete":
            return await handleOAuthComplete(args);
          case "set_default":
            return await handleSetDefault(args);
          case "validate":
            return await handleValidate(args);
          default:
            return errorResult(`Unknown provider action: ${action as string}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Provider error: ${message}`);
      }
    },
  };

  // ─── Action handlers ───

  async function handleList(): Promise<FridayAgentToolResult> {
    const providers = await providerService.listProviders();
    const routing = await providerService.getRoutingConfig();

    return jsonResult({
      providers: providers.map((p) => ({
        id: p.id,
        kind: p.kind,
        name: p.name,
        baseUrl: p.baseUrl,
        enabled: p.enabled,
        defaultModel: p.defaultModel,
        authMode: p.config.authMode,
        api: p.config.api,
        validationStatus: p.config.validation?.status ?? "never",
        isDefault: p.id === routing.defaultProviderId,
      })),
      routing: {
        defaultProviderId: routing.defaultProviderId,
        defaultModel: routing.defaultModel,
        fallbackProviderIds: routing.fallbackProviderIds,
      },
    });
  }

  async function handleGet(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const providerId = readStringParam(args, "providerId", { required: true });
    const provider = await providerService.getProvider(providerId);

    if (!provider) {
      return errorResult(`Provider not found: ${providerId}`);
    }

    return jsonResult({
      id: provider.id,
      kind: provider.kind,
      name: provider.name,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      defaultModel: provider.defaultModel,
      config: {
        api: provider.config.api,
        authMode: provider.config.authMode,
        supportedModels: provider.config.supportedModels,
        headers: provider.config.headers,
        validation: provider.config.validation,
      },
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
    });
  }

  async function handleDetect(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const apiKey = readStringParam(args, "apiKey", { required: true });
    const detection = detectFridayProviderKindFromApiKey(apiKey);

    return jsonResult({
      detectedKind: detection.kind,
      confidence: detection.confidence,
      message: `Detected provider kind '${detection.kind}' with ${detection.confidence} confidence.`,
    });
  }

  async function handleCreate(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const kind = readStringParam(args, "kind", { required: true });
    const name = readStringParam(args, "name", { required: true });
    const baseUrl = readStringParam(args, "baseUrl", { required: true });
    const api = readStringParam(args, "api", { required: true }) as FridayProviderApi;
    const authMode = readStringParam(args, "authMode", { required: true }) as FridayProviderAuthMode;
    const apiKey = readStringParam(args, "apiKey");
    const supportedModels = readStringArrayParam(args, "supportedModels") ?? [];
    const defaultModel = readStringParam(args, "defaultModel");
    const headers = readRecordParam(args, "headers");
    const enabled = readBooleanParam(args, "enabled");

    if (!isFridayProviderKind(kind)) {
      return errorResult(
        `Invalid provider kind "${kind}". Valid kinds: ${FRIDAY_PROVIDER_KINDS.slice(0, 10).join(", ")}...`,
      );
    }

    if (!VALID_AUTH_MODES.has(authMode)) {
      return errorResult(
        `Invalid auth mode "${authMode}". Valid: ${Array.from(VALID_AUTH_MODES).join(", ")}`,
      );
    }

    const provider = await providerService.createProvider({
      kind: kind as FridayProviderKind,
      name,
      baseUrl,
      api,
      authMode,
      apiKey,
      supportedModels,
      defaultModel,
      headers,
      enabled,
    });

    return jsonResult({
      success: true,
      message: `Provider "${provider.name}" created successfully.`,
      provider: {
        id: provider.id,
        kind: provider.kind,
        name: provider.name,
        baseUrl: provider.baseUrl,
        enabled: provider.enabled,
        authMode: provider.config.authMode,
        validationStatus: provider.config.validation?.status ?? "never",
      },
    });
  }

  async function handleUpdate(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const providerId = readStringParam(args, "providerId", { required: true });
    const name = readStringParam(args, "name");
    const baseUrl = readStringParam(args, "baseUrl");
    const api = readStringParam(args, "api") as FridayProviderApi | undefined;
    const authMode = readStringParam(args, "authMode") as FridayProviderAuthMode | undefined;
    const apiKey = readStringParam(args, "apiKey");
    const supportedModels = readStringArrayParam(args, "supportedModels");
    const defaultModel = readStringParam(args, "defaultModel");
    const headers = readRecordParam(args, "headers");
    const enabled = readBooleanParam(args, "enabled");

    if (authMode && !VALID_AUTH_MODES.has(authMode)) {
      return errorResult(
        `Invalid auth mode "${authMode}". Valid: ${Array.from(VALID_AUTH_MODES).join(", ")}`,
      );
    }

    const provider = await providerService.updateProvider(providerId, {
      name,
      baseUrl,
      api,
      authMode,
      apiKey,
      supportedModels,
      defaultModel,
      headers,
      enabled,
    });

    return jsonResult({
      success: true,
      message: `Provider "${provider.name}" updated successfully.`,
      provider: {
        id: provider.id,
        kind: provider.kind,
        name: provider.name,
        baseUrl: provider.baseUrl,
        enabled: provider.enabled,
        authMode: provider.config.authMode,
        validationStatus: provider.config.validation?.status ?? "never",
      },
    });
  }

  async function handleDelete(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const providerId = readStringParam(args, "providerId", { required: true });

    // Get provider name before deletion for the message
    const provider = await providerService.getProvider(providerId);
    if (!provider) {
      return errorResult(`Provider not found: ${providerId}`);
    }

    await providerService.deleteProvider(providerId);

    return jsonResult({
      success: true,
      message: `Provider "${provider.name}" deleted successfully.`,
    });
  }

  async function handleOAuthInit(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const providerId = readStringParam(args, "providerId", { required: true });

    const initiation = await providerService.initiateOAuthLogin({ providerId });

    return jsonResult({
      success: true,
      message: "OAuth flow initiated. Direct the user to the authorization URL.",
      authorizationUrl: initiation.authorizationUrl,
      state: initiation.state,
      providerId: initiation.providerId,
      oauthProvider: initiation.oauthProvider,
      instructions: "User must visit the authorization URL and authorize the application. " +
        "After authorization, they will receive a code to complete the flow with oauth_complete.",
    });
  }

  async function handleOAuthComplete(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const providerId = readStringParam(args, "providerId", { required: true });
    const authorizationCode = readStringParam(args, "authorizationCode", { required: true });
    const state = readStringParam(args, "state");

    const result = await providerService.completeOAuthLogin({
      providerId,
      authorizationCode,
      state,
    });

    return jsonResult({
      success: true,
      message: `OAuth login completed for provider. Connected: ${result.connected}`,
      providerId: result.providerId,
      oauthProvider: result.oauthProvider,
      connected: result.connected,
      expiresAt: result.expiresAt,
    });
  }

  async function handleSetDefault(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const providerId = readStringParam(args, "providerId", { required: true });
    const defaultModel = readStringParam(args, "defaultModel");

    // Verify provider exists
    const provider = await providerService.getProvider(providerId);
    if (!provider) {
      return errorResult(`Provider not found: ${providerId}`);
    }

    // Get current routing config and update
    const currentRouting = await providerService.getRoutingConfig();
    const updatedRouting = await providerService.setRoutingConfig({
      ...currentRouting,
      defaultProviderId: providerId,
      defaultModel: defaultModel ?? currentRouting.defaultModel,
    });

    return jsonResult({
      success: true,
      message: `Default provider set to "${provider.name}"${defaultModel ? ` with model "${defaultModel}"` : ""}.`,
      routing: {
        defaultProviderId: updatedRouting.defaultProviderId,
        defaultModel: updatedRouting.defaultModel,
        fallbackProviderIds: updatedRouting.fallbackProviderIds,
      },
    });
  }

  async function handleValidate(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const providerId = readStringParam(args, "providerId", { required: true });

    const validationState = await providerService.validateProvider(providerId);

    const provider = await providerService.getProvider(providerId);
    const providerName = provider?.name ?? providerId;

    if (validationState.status === "ok") {
      return jsonResult({
        success: true,
        message: `Provider "${providerName}" validation passed.`,
        validation: validationState,
      });
    }

    return jsonResult({
      success: false,
      message: `Provider "${providerName}" validation failed: ${validationState.errorMessage ?? "Unknown error"}`,
      validation: validationState,
    });
  }
}
