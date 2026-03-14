import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";

import type {
  FridayCompleteAnthropicOAuthCallbackRequest,
  FridayCompleteAnthropicOAuthCallbackResponse,
  FridayCreateProviderRequest,
  FridayCreateProviderResponse,
  FridayDeleteProviderResponse,
  FridayGetProviderResponse,
  FridayGetRoutingConfigResponse,
  FridayInitiateAnthropicOAuthRequest,
  FridayInitiateAnthropicOAuthResponse,
  FridayListProvidersResponse,
  FridaySetRoutingConfigRequest,
  FridaySetRoutingConfigResponse,
  FridayUpdateProviderRequest,
  FridayUpdateProviderResponse,
  FridayValidateProviderResponse,
} from "../../model/friday-api-provider.types.js";

import type { FridayProviderService } from "#providers";
import { FRIDAY_PROVIDER_APIS, FRIDAY_PROVIDER_KINDS } from "#providers";
import { FridayDomainError } from "#errors";
import {
  resolveExistingOAuthProvider,
  resolveOrProvisionOAuthProvider,
} from "../../../providers/services/friday-provider-oauth-selection.js";

// ─── Validation helpers ───

const VALID_KINDS = new Set<string>(FRIDAY_PROVIDER_KINDS);
const VALID_APIS = new Set<string>(FRIDAY_PROVIDER_APIS);
const VALID_AUTH_MODES = new Set(["api-key", "bearer-token", "oauth", "none"]);

function validateCreateBody(body: unknown): asserts body is FridayCreateProviderRequest {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof b.kind !== "string" || !VALID_KINDS.has(b.kind)) {
    errors.push(`kind must be one of: ${[...VALID_KINDS].join(", ")}`);
  }
  if (typeof b.name !== "string" || b.name.trim() === "") {
    errors.push("name is required and must be a non-empty string");
  }
  if (typeof b.baseUrl !== "string" || b.baseUrl.trim() === "") {
    errors.push("baseUrl is required and must be a non-empty string");
  }
  if (typeof b.authMode !== "string" || !VALID_AUTH_MODES.has(b.authMode)) {
    errors.push(`authMode must be one of: ${[...VALID_AUTH_MODES].join(", ")}`);
  }
  if (typeof b.api !== "string" || !VALID_APIS.has(b.api)) {
    errors.push(`api must be one of: ${[...VALID_APIS].join(", ")}`);
  }
  if (!Array.isArray(b.supportedModels) || b.supportedModels.length === 0 || !b.supportedModels.every((m: unknown) => typeof m === "string")) {
    errors.push("supportedModels must be a non-empty array of strings");
  }
  if (b.apiKey !== undefined && typeof b.apiKey !== "string") {
    errors.push("apiKey must be a string when provided");
  }
  if (b.defaultModel !== undefined && typeof b.defaultModel !== "string") {
    errors.push("defaultModel must be a string when provided");
  }
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") {
    errors.push("enabled must be a boolean when provided");
  }
  if (b.validateOnSave !== undefined && typeof b.validateOnSave !== "boolean") {
    errors.push("validateOnSave must be a boolean when provided");
  }
  if (b.headers !== undefined && (b.headers == null || typeof b.headers !== "object" || Array.isArray(b.headers))) {
    errors.push("headers must be an object when provided");
  }

  if (errors.length > 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `Invalid request body: ${errors.join("; ")}`, { httpStatus: 400 });
  }
}

function validateUpdateBody(body: unknown): asserts body is FridayUpdateProviderRequest {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (b.kind !== undefined) {
    errors.push("kind cannot be changed after creation");
  }
  if (b.name !== undefined && (typeof b.name !== "string" || b.name.trim() === "")) {
    errors.push("name must be a non-empty string when provided");
  }
  if (b.baseUrl !== undefined && (typeof b.baseUrl !== "string" || b.baseUrl.trim() === "")) {
    errors.push("baseUrl must be a non-empty string when provided");
  }
  if (b.authMode !== undefined && (typeof b.authMode !== "string" || !VALID_AUTH_MODES.has(b.authMode))) {
    errors.push(`authMode must be one of: ${[...VALID_AUTH_MODES].join(", ")}`);
  }
  if (b.api !== undefined && (typeof b.api !== "string" || !VALID_APIS.has(b.api))) {
    errors.push(`api must be one of: ${[...VALID_APIS].join(", ")}`);
  }
  if (b.supportedModels !== undefined && (!Array.isArray(b.supportedModels) || !b.supportedModels.every((m: unknown) => typeof m === "string"))) {
    errors.push("supportedModels must be an array of strings when provided");
  }
  if (b.apiKey !== undefined && typeof b.apiKey !== "string") {
    errors.push("apiKey must be a string when provided");
  }
  if (b.defaultModel !== undefined && typeof b.defaultModel !== "string") {
    errors.push("defaultModel must be a string when provided");
  }
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") {
    errors.push("enabled must be a boolean when provided");
  }
  if (b.validateOnSave !== undefined && typeof b.validateOnSave !== "boolean") {
    errors.push("validateOnSave must be a boolean when provided");
  }
  if (b.headers !== undefined && (b.headers == null || typeof b.headers !== "object" || Array.isArray(b.headers))) {
    errors.push("headers must be an object when provided");
  }

  if (errors.length > 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `Invalid request body: ${errors.join("; ")}`, { httpStatus: 400 });
  }
}

function validateRoutingBody(body: unknown): asserts body is FridaySetRoutingConfigRequest {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof b.defaultProviderId !== "string") {
    errors.push("defaultProviderId is required and must be a string");
  }
  if (!Array.isArray(b.fallbackProviderIds) || !b.fallbackProviderIds.every((id: unknown) => typeof id === "string")) {
    errors.push("fallbackProviderIds is required and must be an array of strings");
  }
  if (b.defaultModel !== undefined && typeof b.defaultModel !== "string") {
    errors.push("defaultModel must be a string when provided");
  }

  if (errors.length > 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `Invalid request body: ${errors.join("; ")}`, { httpStatus: 400 });
  }
}

// ─── Dependencies ───

export interface FridayProviderRoutesDeps {
  providerService: FridayProviderService;
}

// ─── Factory ───

export function createFridayProviderRoutes(
  deps: FridayProviderRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    // ─── List providers ───
    {
      operationId: "providers.list",
      method: "GET",
      path: "/v1/providers",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      async handler(): Promise<FridayListProvidersResponse> {
        const items = await deps.providerService.listProviders();
        return { items };
      },
    },

    // ─── Get provider ───
    {
      operationId: "providers.get",
      method: "GET",
      path: "/v1/providers/:providerId",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      async handler(ctx): Promise<FridayGetProviderResponse> {
        const { providerId } = ctx.params as { providerId: string };
        const provider = await deps.providerService.getProvider(providerId);
        if (!provider) {
          throw new FridayDomainError(
            "PROVIDER_NOT_FOUND",
            "Provider not found",
            { httpStatus: 404 },
          );
        }
        return { provider };
      },
    },

    // ─── Create provider ───
    {
      operationId: "providers.create",
      method: "POST",
      path: "/v1/providers",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridayCreateProviderResponse> {
        // DX-001: Accept both flat and nested (config) formats.
        // If the body has a `config` object with provider fields, lift them to top level.
        const raw = ctx.body as Record<string, unknown> | null;
        if (raw && typeof raw === "object" && raw.config && typeof raw.config === "object") {
          const config = raw.config as Record<string, unknown>;
          const liftFields = ["api", "authMode", "supportedModels", "apiKey", "defaultModel", "headers"] as const;
          for (const field of liftFields) {
            if (config[field] !== undefined && raw[field] === undefined) {
              raw[field] = config[field];
            }
          }
        }
        validateCreateBody(ctx.body);
        const body = ctx.body;
        const provider = await deps.providerService.createProvider(body);
        return {
          provider,
          validation: provider.config.validation,
        };
      },
    },

    // ─── Update provider ───
    {
      operationId: "providers.update",
      method: "PATCH",
      path: "/v1/providers/:providerId",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridayUpdateProviderResponse> {
        const { providerId } = ctx.params as { providerId: string };
        validateUpdateBody(ctx.body);
        const body = ctx.body;
        const provider = await deps.providerService.updateProvider(
          providerId,
          body,
        );
        return {
          provider,
          validation: provider.config.validation,
        };
      },
    },

    // ─── Delete provider ───
    {
      operationId: "providers.delete",
      method: "DELETE",
      path: "/v1/providers/:providerId",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridayDeleteProviderResponse> {
        const { providerId } = ctx.params as { providerId: string };
        await deps.providerService.deleteProvider(providerId);
        return { deleted: true };
      },
    },

    // ─── Validate provider ───
    {
      operationId: "providers.validate",
      method: "POST",
      path: "/v1/providers/:providerId/validate",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      rateLimitPolicyId: "provider.validate",
      async handler(ctx): Promise<FridayValidateProviderResponse> {
        const { providerId } = ctx.params as { providerId: string };
        const validation =
          await deps.providerService.validateProvider(providerId);
        return { validation };
      },
    },

    // ─── Get routing config ───
    {
      operationId: "providers.routing.get",
      method: "GET",
      path: "/v1/model-routing",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      async handler(): Promise<FridayGetRoutingConfigResponse> {
        const routing = await deps.providerService.getRoutingConfig();
        return { routing };
      },
    },

    // ─── Set routing config ───
    {
      operationId: "providers.routing.set",
      method: "PUT",
      path: "/v1/model-routing",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridaySetRoutingConfigResponse> {
        validateRoutingBody(ctx.body);
        const body = ctx.body;
        const routing = await deps.providerService.setRoutingConfig(body);
        return { routing };
      },
    },

    // ─── OAuth: Initiate Anthropic login ───
    {
      operationId: "auth.oauth.anthropic.initiate",
      method: "POST",
      path: "/v1/auth/oauth/anthropic/initiate",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridayInitiateAnthropicOAuthResponse> {
        const body = ctx.body as Record<string, unknown> | null;
        const selection = await resolveOrProvisionOAuthProvider(
          deps.providerService,
          readOAuthSelectionInput(body),
        );
        const oauth = await deps.providerService.initiateOAuthLogin({
          providerId: selection.provider.id,
        });
        return { oauth };
      },
    },

    // ─── OAuth: Complete Anthropic callback ───
    {
      operationId: "auth.oauth.anthropic.callback",
      method: "POST",
      path: "/v1/auth/oauth/anthropic/callback",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      rateLimitPolicyId: "provider.write",
      async handler(ctx): Promise<FridayCompleteAnthropicOAuthCallbackResponse> {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "Request body is required",
            { httpStatus: 400 },
          );
        }
        if (typeof body.authorizationCode !== "string" || body.authorizationCode.trim() === "") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "authorizationCode is required and must be a non-empty string",
            { httpStatus: 400 },
          );
        }
        const selection = await resolveExistingOAuthProvider(
          deps.providerService,
          readOAuthSelectionInput(body),
          "oauth_complete",
        );
        const providerId = selection.provider.id;
        const authorizationCode = body.authorizationCode;
        const state = typeof body.state === "string" ? body.state : undefined;
        const oauth = await deps.providerService.completeOAuthLogin({
          providerId,
          authorizationCode,
          state,
        });
        return { oauth };
      },
    },
  ];
}

function readOAuthSelectionInput(body: Record<string, unknown> | null): {
  providerId?: string;
  kind?: "anthropic";
  name?: string;
  defaultModel?: string;
} {
  return {
    providerId: typeof body?.providerId === "string" && body.providerId.trim().length > 0
      ? body.providerId.trim()
      : undefined,
    kind: typeof body?.kind === "string" && body.kind.trim().length > 0
      ? body.kind.trim() as "anthropic"
      : undefined,
    name: typeof body?.name === "string" && body.name.trim().length > 0
      ? body.name.trim()
      : undefined,
    defaultModel: typeof body?.defaultModel === "string" && body.defaultModel.trim().length > 0
      ? body.defaultModel.trim()
      : undefined,
  };
}
