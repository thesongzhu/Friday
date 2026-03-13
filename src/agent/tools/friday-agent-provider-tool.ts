/**
 * Agent Provider Tool — Manage LLM providers from within the agent runtime.
 *
 * Allows the agent to list, create, update, delete providers, and handle OAuth
 * flows for providers like Anthropic (Claude Max/Pro).
 *
 * @module agent/tools/friday-agent-provider-tool
 */

import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type { FridayProviderService } from "../../providers/services/friday-provider-service.types.js";
import type {
  FridayProviderApi,
  FridayProviderAuthMode,
  FridayProviderKind,
} from "../../providers/model/friday-provider.types.js";
import {
  errorResult,
  jsonResult,
  readStringParam,
  readBooleanParam,
} from "./friday-agent-tool-helpers.js";

// ─── Types ───

export interface CreateFridayAgentProviderToolOptions {
  providerService: FridayProviderService;
}

type ProviderAction =
  | "list"
  | "get"
  | "create"
  | "update"
  | "delete"
  | "oauth_init"
  | "oauth_complete"
  | "set_default"
  | "validate"
  | "routing";

const VALID_ACTIONS = new Set<ProviderAction>([
  "list",
  "get",
  "create",
  "update",
  "delete",
  "oauth_init",
  "oauth_complete",
  "set_default",
  "validate",
  "routing",
]);

const VALID_KINDS = new Set<FridayProviderKind>([
  "openai",
  "anthropic",
  "google",
  "ollama",
  "openai-compatible",
]);

const VALID_AUTH_MODES = new Set<FridayProviderAuthMode>([
  "api-key",
  "bearer-token",
  "oauth",
  "none",
]);

const VALID_APIS = new Set<FridayProviderApi>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "ollama",
]);

// ─── Factory ───

export function createFridayAgentProviderTool(
  options: CreateFridayAgentProviderToolOptions,
): FridayAgentToolDefinition {
  const { providerService } = options;

  return {
    name: "provider",
    description:
      "Manage LLM providers (OpenAI, Anthropic, Google, Ollama). " +
      "Actions: list (show all providers), get (single provider by ID), " +
      "create (add new provider), update (modify provider), delete (remove provider), " +
      "oauth_init (start OAuth flow for Claude Max/Pro - returns authorization URL), " +
      "oauth_complete (finish OAuth with authorization code), " +
      "set_default (set default provider and model), " +
      "validate (test provider connection), " +
      "routing (get current routing config).",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: Array.from(VALID_ACTIONS),
          description: "Provider management action.",
        },
        providerId: {
          type: "string",
          description: "Provider ID (required for get/update/delete/oauth_init/oauth_complete/set_default/validate).",
        },
        kind: {
          type: "string",
          enum: Array.from(VALID_KINDS),
          description: "Provider kind (required for create): openai, anthropic, google, ollama, openai-compatible.",
        },
        name: {
          type: "string",
          description: "Display name for create/update.",
        },
        baseUrl: {
          type: "string",
          description: "API base URL for create/update.",
        },
        authMode: {
          type: "string",
          enum: Array.from(VALID_AUTH_MODES),
          description: "Authentication mode: api-key, bearer-token, oauth, none.",
        },
        api: {
          type: "string",
          enum: Array.from(VALID_APIS),
          description: "API format: openai-completions, openai-responses, anthropic-messages, google-generative-ai, ollama.",
        },
        apiKey: {
          type: "string",
          description: "API key for create/update. Use $ENV_VAR syntax for environment variable reference.",
        },
        supportedModels: {
          type: "array",
          items: { type: "string" },
          description: "List of supported model IDs for create/update.",
        },
        defaultModel: {
          type: "string",
          description: "Default model ID for create/update/set_default.",
        },
        enabled: {
          type: "boolean",
          description: "Whether the provider is enabled (default: true).",
        },
        code: {
          type: "string",
          description: "OAuth authorization code for oauth_complete. Format: 'code' or 'code#state'.",
        },
        state: {
          type: "string",
          description: "OAuth state for oauth_complete (if not included in code).",
        },
      },
      required: ["action"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
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
          case "routing":
            return await handleRouting();
          default:
            return errorResult(`Unknown provider action: ${action as string}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("Provider action aborted.");
        }
        return errorResult(`Provider error: ${message}`);
      }
    },
  };

  // ─── Action Handlers ───

  async function handleList(): Promise<FridayAgentToolResult> {
    const providers = await providerService.listProviders();
    return jsonResult({
      count: providers.length,
      providers: providers.map(sanitizeProvider),
    });
  }

  async function handleGet(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const providerId = readStringParam(args, "providerId", { required: true });
    const provider = await providerService.getProvider(providerId);

    if (!provider) {
      return errorResult(`Provider "${providerId}" not found.`);
    }

    return jsonResult({ provider: sanitizeProvider(provider) });
  }

  async function handleCreate(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const kind = readStringParam(args, "kind", { required: true }) as FridayProviderKind;
    if (!VALID_KINDS.has(kind)) {
      return errorResult(`Invalid kind "${kind}". Valid: ${Array.from(VALID_KINDS).join(", ")}`);
    }

    const name = readStringParam(args, "name") ?? `${kind} Provider`;
    const baseUrl = readStringParam(args, "baseUrl") ?? getDefaultBaseUrl(kind);
    const authMode = (readStringParam(args, "authMode") ?? "api-key") as FridayProviderAuthMode;
    const api = (readStringParam(args, "api") ?? getDefaultApi(kind)) as FridayProviderApi;
    const apiKey = readStringParam(args, "apiKey");
    const supportedModels = (args.supportedModels as string[]) ?? getDefaultModels(kind);
    const defaultModel = readStringParam(args, "defaultModel") ?? supportedModels[0];
    const enabled = readBooleanParam(args, "enabled") ?? true;

    const provider = await providerService.createProvider({
      kind,
      name,
      baseUrl,
      authMode,
      api,
      apiKey,
      supportedModels,
      defaultModel,
      enabled,
    });

    return jsonResult({
      created: true,
      provider: sanitizeProvider(provider),
    });
  }

  async function handleUpdate(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const providerId = readStringParam(args, "providerId", { required: true });

    const patch: Record<string, unknown> = {};
    const name = readStringParam(args, "name");
    const baseUrl = readStringParam(args, "baseUrl");
    const authMode = readStringParam(args, "authMode") as FridayProviderAuthMode | undefined;
    const api = readStringParam(args, "api") as FridayProviderApi | undefined;
    const apiKey = readStringParam(args, "apiKey");
    const supportedModels = args.supportedModels as string[] | undefined;
    const defaultModel = readStringParam(args, "defaultModel");
    const enabled = readBooleanParam(args, "enabled");

    if (name !== undefined) patch.name = name;
    if (baseUrl !== undefined) patch.baseUrl = baseUrl;
    if (authMode !== undefined) patch.authMode = authMode;
    if (api !== undefined) patch.api = api;
    if (apiKey !== undefined) patch.apiKey = apiKey;
    if (supportedModels !== undefined) patch.supportedModels = supportedModels;
    if (defaultModel !== undefined) patch.defaultModel = defaultModel;
    if (enabled !== undefined) patch.enabled = enabled;

    const provider = await providerService.updateProvider(providerId, patch);

    return jsonResult({
      updated: true,
      provider: sanitizeProvider(provider),
    });
  }

  async function handleDelete(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const providerId = readStringParam(args, "providerId", { required: true });

    await providerService.deleteProvider(providerId);

    return jsonResult({
      deleted: true,
      providerId,
    });
  }

  async function handleOAuthInit(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const providerId = readStringParam(args, "providerId", { required: true });

    const result = await providerService.initiateOAuthLogin({ providerId });

    return jsonResult({
      authorizationUrl: result.authorizationUrl,
      state: result.state,
      scopes: result.scopes,
      providerId: result.providerId,
      instructions:
        "1. Open the authorizationUrl in your browser\n" +
        "2. Log in with your Claude Max/Pro account\n" +
        "3. Click 'Allow' to authorize\n" +
        "4. Copy the code shown (format: code#state)\n" +
        "5. Call oauth_complete with the code",
    });
  }

  async function handleOAuthComplete(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const providerId = readStringParam(args, "providerId", { required: true });
    const code = readStringParam(args, "code", { required: true });
    const state = readStringParam(args, "state");

    const result = await providerService.completeOAuthLogin({
      providerId,
      authorizationCode: code,
      state,
    });

    // Fetch the updated provider after OAuth completion
    const provider = await providerService.getProvider(result.providerId);

    return jsonResult({
      success: true,
      providerId: result.providerId,
      oauthProvider: result.oauthProvider,
      connected: result.connected,
      expiresAt: result.expiresAt,
      provider: provider ? sanitizeProvider(provider) : null,
      message: "OAuth completed successfully. Provider is now configured and ready to use.",
    });
  }

  async function handleSetDefault(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const providerId = readStringParam(args, "providerId", { required: true });
    const defaultModel = readStringParam(args, "defaultModel");

    const routing = await providerService.setRoutingConfig({
      defaultProviderId: providerId,
      defaultModel,
      fallbackProviderIds: [],
    });

    return jsonResult({
      success: true,
      routing,
      message: `Default provider set to "${providerId}"${defaultModel ? ` with model "${defaultModel}"` : ""}.`,
    });
  }

  async function handleValidate(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const providerId = readStringParam(args, "providerId", { required: true });

    const validation = await providerService.validateProvider(providerId);

    return jsonResult({
      providerId,
      status: validation.status,
      checkedAt: validation.checkedAt,
      errorMessage: validation.errorMessage,
    });
  }

  async function handleRouting(): Promise<FridayAgentToolResult> {
    const routing = await providerService.getRoutingConfig();

    return jsonResult({ routing });
  }

  // ─── Helpers ───

  function sanitizeProvider(provider: {
    id: string;
    kind: string;
    name: string;
    baseUrl: string;
    enabled: boolean;
    defaultModel?: string;
    config: {
      api: string;
      authMode: string;
      supportedModels?: string[];
      validation?: { status: string; checkedAt?: string; errorMessage?: string };
    };
  }): Record<string, unknown> {
    // Never expose API keys in output
    return {
      id: provider.id,
      kind: provider.kind,
      name: provider.name,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      defaultModel: provider.defaultModel,
      api: provider.config.api,
      authMode: provider.config.authMode,
      supportedModels: provider.config.supportedModels ?? [],
      validation: provider.config.validation ?? { status: "never" },
    };
  }

  function getDefaultBaseUrl(kind: FridayProviderKind): string {
    switch (kind) {
      case "openai":
        return "https://api.openai.com";
      case "anthropic":
        return "https://api.anthropic.com";
      case "google":
        return "https://generativelanguage.googleapis.com";
      case "ollama":
        return "http://localhost:11434";
      default:
        return "";
    }
  }

  function getDefaultApi(kind: FridayProviderKind): FridayProviderApi {
    switch (kind) {
      case "openai":
      case "openai-compatible":
        return "openai-completions";
      case "anthropic":
        return "anthropic-messages";
      case "google":
        return "google-generative-ai";
      case "ollama":
        return "ollama";
      default:
        return "openai-completions";
    }
  }

  function getDefaultModels(kind: FridayProviderKind): string[] {
    switch (kind) {
      case "openai":
        return ["gpt-4o", "gpt-4o-mini", "gpt-4.1"];
      case "anthropic":
        return ["claude-sonnet-4-20250514", "claude-opus-4-20250514"];
      case "google":
        return ["gemini-2.0-flash", "gemini-1.5-pro"];
      case "ollama":
        return ["llama3.2:3b", "qwen2.5-coder:7b"];
      default:
        return [];
    }
  }
}
