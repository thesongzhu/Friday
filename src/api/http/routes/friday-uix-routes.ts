import { FridayDomainError } from "#errors";
import type { FridayUixSurfaceService } from "../../../uix/services/friday-uix-surface-service.js";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayBeginnerIntentResolution,
  FridayInvestigateResponse,
  FridayUixDiagnosticsResponse,
  FridayUixIssuesResponse,
  FridayUixTemplateExecutionResponse,
  FridayUixTemplatesResponse,
  FridayUixWizardResponse,
  FridayUserProfileResponse,
  FridayUserProfileType,
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

function readAssistantSessionKey(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const value = (body as Record<string, unknown>).assistantSessionKey;
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
          assistantSessionKey: readAssistantSessionKey(ctx.body),
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
        return deps.service.startWizard({
          wizardId,
          userId,
          assistantSessionKey: readAssistantSessionKey(ctx.body),
        });
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
        return deps.service.continueWizard({
          wizardId,
          contextId,
          userId,
          values,
          assistantSessionKey: readAssistantSessionKey(ctx.body),
        });
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
    {
      operationId: "uix.user.profile.get",
      method: "GET",
      path: "/v1/uix/user-profile",
      auth: { public: false, anyOfScopes: ["agent.run"] },
      async handler(ctx): Promise<FridayUserProfileResponse> {
        const userId = requireUserId(ctx.principal);
        const prefs = deps.service.listPreferences({ userId, category: "uix" });
        const profilePref = prefs.items.find((p) => p.key === "user.profile_type");
        const onboardedPref = prefs.items.find((p) => p.key === "user.onboarded_at");
        return {
          profileType: (profilePref?.value as FridayUserProfileType | undefined) ?? null,
          onboardedAt: (onboardedPref?.value as string | undefined) ?? null,
        };
      },
    },
    {
      operationId: "uix.user.profile.update",
      method: "PUT",
      path: "/v1/uix/user-profile",
      auth: { public: false, anyOfScopes: ["agent.run"] },
      async handler(ctx): Promise<FridayUserProfileResponse> {
        const userId = requireUserId(ctx.principal);
        const body = (ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body))
          ? ctx.body as Record<string, unknown>
          : {};
        const profileType = typeof body.profileType === "string" ? body.profileType : undefined;
        const onboardedAt = typeof body.onboardedAt === "string" ? body.onboardedAt : undefined;
        const preferences: Array<{ category: string; key: string; value: unknown }> = [];
        if (profileType) {
          preferences.push({ category: "uix", key: "user.profile_type", value: profileType });
        }
        if (onboardedAt) {
          preferences.push({ category: "uix", key: "user.onboarded_at", value: onboardedAt });
        }
        if (preferences.length > 0) {
          deps.service.updatePreferences({
            userId,
            request: { preferences } as never,
          });
        }
        return {
          profileType: (profileType as FridayUserProfileType | undefined) ?? null,
          onboardedAt: onboardedAt ?? null,
        };
      },
    },
    {
      operationId: "uix.investigate",
      method: "POST",
      path: "/v1/uix/investigate",
      auth: { public: false, anyOfScopes: ["agent.run"] },
      async handler(ctx): Promise<FridayInvestigateResponse> {
        const userId = requireUserId(ctx.principal);
        const body = (ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body))
          ? ctx.body as Record<string, unknown>
          : {};
        const goalCategoryId = typeof body.goalCategoryId === "string" ? body.goalCategoryId.trim() : "";
        if (!goalCategoryId) {
          throw new FridayDomainError("VALIDATION_ERROR", "goalCategoryId is required", { httpStatus: 400 });
        }
        const wizardResponse = deps.service.startWizard({
          wizardId: goalCategoryId,
          userId,
          assistantSessionKey: readAssistantSessionKey(ctx.body),
        });
        return {
          runId: wizardResponse.wizard.contextId,
          wizardId: goalCategoryId,
        };
      },
    },
  ];
}
