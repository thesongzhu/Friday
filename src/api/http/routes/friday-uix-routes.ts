import { FridayDomainError } from "#errors";
import type { FridayUixSurfaceService } from "../../../uix/services/friday-uix-surface-service.js";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayBeginnerIntentResolution,
  FridayUixDiagnosticsResponse,
  FridayUixIssuesResponse,
  FridayUixTemplateExecutionResponse,
  FridayUixTemplatesResponse,
  FridayUixWizardResponse,
} from "../../model/friday-api-uix-surface.types.js";
import type {
  FridayDeleteUserPreferenceResponse,
  FridayGetCommunicationPersonaResponse,
  FridayListUserPreferencesResponse,
  FridayUpdateUserPreferencesResponse,
} from "../../../uix/api/friday-uix-api.types.js";

export interface FridayUixRoutesDeps {
  service: FridayUixSurfaceService;
}

function requireUserId(principal: { userId?: string } | null): string {
  if (!principal?.userId) {
    throw new FridayDomainError("UNAUTHORIZED", "A user-scoped assistant principal is required", {
      httpStatus: 401,
    });
  }
  return principal.userId;
}

function readText(body: unknown, key: string): string {
  if (!body || typeof body !== "object") {
    throw new FridayDomainError("VALIDATION_ERROR", `${key} is required`, { httpStatus: 400 });
  }
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `${key} is required`, { httpStatus: 400 });
  }
  return value.trim();
}

function readValues(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") {
    return {};
  }
  const values = (body as Record<string, unknown>).values;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return {};
  }
  return values as Record<string, unknown>;
}

export function createFridayUixRoutes(
  deps: FridayUixRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "uix.intents.resolve",
      method: "POST",
      path: "/v1/uix/intents/resolve",
      auth: { public: false, anyOfScopes: ["skill.read", "diagnosis.read", "agent.run"] },
      async handler(ctx): Promise<FridayBeginnerIntentResolution> {
        const userId = requireUserId(ctx.principal);
        const text = readText(ctx.body, "text");
        return deps.service.resolveIntent({ text, userId });
      },
    },
    {
      operationId: "uix.templates.list",
      method: "GET",
      path: "/v1/uix/templates",
      auth: { public: false, anyOfScopes: ["skill.read", "diagnosis.read", "agent.run"] },
      async handler(ctx): Promise<FridayUixTemplatesResponse> {
        requireUserId(ctx.principal);
        return { templates: deps.service.listTemplates() };
      },
    },
    {
      operationId: "uix.diagnostics.get",
      method: "GET",
      path: "/v1/uix/diagnostics",
      auth: { public: false, anyOfScopes: ["skill.read", "diagnosis.read", "agent.run"] },
      async handler(ctx): Promise<FridayUixDiagnosticsResponse> {
        const userId = requireUserId(ctx.principal);
        return {
          assistant: deps.service.getDiagnostics({ userId }),
        };
      },
    },
    {
      operationId: "uix.preferences.list",
      method: "GET",
      path: "/v1/uix/preferences",
      auth: { public: false, anyOfScopes: ["agent.run"] },
      async handler(ctx): Promise<FridayListUserPreferencesResponse> {
        const userId = requireUserId(ctx.principal);
        const category = typeof (ctx.query as Record<string, unknown> | undefined)?.category === "string"
          ? ((ctx.query as Record<string, unknown>).category as FridayListUserPreferencesResponse["items"][number]["category"])
          : undefined;
        return deps.service.listPreferences({ userId, category });
      },
    },
    {
      operationId: "uix.preferences.update",
      method: "PUT",
      path: "/v1/uix/preferences",
      auth: { public: false, anyOfScopes: ["agent.run"] },
      async handler(ctx): Promise<FridayUpdateUserPreferencesResponse> {
        const userId = requireUserId(ctx.principal);
        const body = (ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body))
          ? (ctx.body as { preferences?: unknown }).preferences
          : undefined;
        const preferences = Array.isArray(body) ? body : [];
        return deps.service.updatePreferences({
          userId,
          request: {
            preferences: preferences as FridayUpdateUserPreferencesResponse["preferences"],
          },
        });
      },
    },
    {
      operationId: "uix.preferences.delete",
      method: "DELETE",
      path: "/v1/uix/preferences/:preferenceId",
      auth: { public: false, anyOfScopes: ["agent.run"] },
      async handler(ctx): Promise<FridayDeleteUserPreferenceResponse> {
        const userId = requireUserId(ctx.principal);
        const { preferenceId } = ctx.params as { preferenceId: string };
        return deps.service.deletePreference({ userId, preferenceId });
      },
    },
    {
      operationId: "uix.persona.get",
      method: "GET",
      path: "/v1/uix/persona",
      auth: { public: false, anyOfScopes: ["agent.run"] },
      async handler(ctx): Promise<FridayGetCommunicationPersonaResponse> {
        const userId = requireUserId(ctx.principal);
        return {
          persona: deps.service.getPersona({ userId }),
        };
      },
    },
    {
      operationId: "uix.templates.execute",
      method: "POST",
      path: "/v1/uix/templates/:templateId/execute",
      auth: { public: false, anyOfScopes: ["skill.write", "diagnosis.read", "agent.run"] },
      rateLimitPolicyId: "generator.write",
      async handler(ctx): Promise<FridayUixTemplateExecutionResponse> {
        const userId = requireUserId(ctx.principal);
        const { templateId } = ctx.params as { templateId: string };
        const parameters = (ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body))
          ? ((ctx.body as Record<string, unknown>).parameters as Record<string, unknown> | undefined) ?? {}
          : {};
        return deps.service.executeTemplate({
          templateId,
          userId,
          parameters,
        });
      },
    },
    {
      operationId: "uix.wizards.start",
      method: "POST",
      path: "/v1/uix/wizards/:wizardId/start",
      auth: { public: false, anyOfScopes: ["skill.read", "diagnosis.read", "agent.run"] },
      async handler(ctx): Promise<FridayUixWizardResponse> {
        const userId = requireUserId(ctx.principal);
        const { wizardId } = ctx.params as { wizardId: string };
        return deps.service.startWizard({ wizardId, userId });
      },
    },
    {
      operationId: "uix.wizards.continue",
      method: "POST",
      path: "/v1/uix/wizards/:wizardId/continue",
      auth: { public: false, anyOfScopes: ["skill.write", "diagnosis.read", "agent.run"] },
      async handler(ctx): Promise<FridayUixWizardResponse> {
        const userId = requireUserId(ctx.principal);
        const { wizardId } = ctx.params as { wizardId: string };
        const contextId = readText(ctx.body, "contextId");
        const values = readValues(ctx.body);
        return deps.service.continueWizard({ wizardId, contextId, userId, values });
      },
    },
    {
      operationId: "uix.issues.list",
      method: "GET",
      path: "/v1/uix/issues",
      auth: { public: false, anyOfScopes: ["diagnosis.read"] },
      async handler(ctx): Promise<FridayUixIssuesResponse> {
        const userId = requireUserId(ctx.principal);
        const query = (ctx.query ?? {}) as Record<string, unknown>;
        const limitRaw = query.limit;
        const limit = typeof limitRaw === "string"
          ? Number.parseInt(limitRaw, 10)
          : typeof limitRaw === "number"
            ? Math.floor(limitRaw)
            : undefined;
        return {
          items: deps.service.listIssues({ userId, limit: Number.isFinite(limit) ? limit : undefined }),
        };
      },
    },
  ];
}
