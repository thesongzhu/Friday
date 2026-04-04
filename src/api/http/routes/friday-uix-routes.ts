import { FridayDomainError } from "#errors";
import type { FridayProviderTenantContext } from "#providers";
import { isMbti } from "../../../uix/services/friday-communication-persona.js";
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
  /** Optional: expose learned preference facts to users for transparency. */
  listLearnedFacts?: (input: { userId: string }) => Array<{ key: string; value: unknown; confidence: number; evidenceCount: number; lastConfirmedAt: string }>;
  /** Optional: emit learning events when preferences are written via the API,
   *  so the preference-extraction pipeline can produce learned facts. */
  collectLearningEvents?: (events: Array<{ eventId: string; ts: string; userId: string; kind: "user_correction"; payload: Record<string, unknown> }>) => void;
  /** Generate a unique ID for learning events. */
  idGenerator?: () => string;
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

function buildTenantContext(principal: unknown): FridayProviderTenantContext | undefined {
  if (!principal || typeof principal !== "object") {
    return undefined;
  }
  const record = principal as {
    userId?: unknown;
    principalId?: unknown;
    tenantId?: unknown;
  };
  const userId = typeof record.userId === "string" && record.userId.trim().length > 0
    ? record.userId.trim()
    : typeof record.principalId === "string" && record.principalId.trim().length > 0
      ? record.principalId.trim()
      : undefined;
  if (!userId) {
    return undefined;
  }
  const tenantId = typeof record.tenantId === "string" && record.tenantId.trim().length > 0
    ? record.tenantId.trim()
    : userId;
  return {
    hubId: tenantId,
    userId,
    channelKind: "assistant",
  };
}

function readUserProfileResponse(service: FridayUixSurfaceService, userId: string): FridayUserProfileResponse {
  const prefs = service.listPreferences({ userId, category: "uix" });
  const profilePref = prefs.items.find((p) => p.key === "user.profile_type");
  const onboardedPref = prefs.items.find((p) => p.key === "user.onboarded_at");
  return {
    profileType: (profilePref?.value as FridayUserProfileType | undefined) ?? null,
    onboardedAt: (onboardedPref?.value as string | undefined) ?? null,
  };
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
        // P2-04: Validate MBTI type before storing to avoid silent fallback.
        for (const pref of preferences) {
          if (
            pref && typeof pref === "object" &&
            (pref as Record<string, unknown>).category === "communication" &&
            (pref as Record<string, unknown>).key === "mbtiType" &&
            !isMbti((pref as Record<string, unknown>).value)
          ) {
            throw new FridayDomainError("INVALID_MBTI_TYPE", "Invalid MBTI type. Valid values: INTJ, INTP, ENTJ, ENTP, INFJ, INFP, ENFJ, ENFP, ISTJ, ISFJ, ESTJ, ESFJ, ISTP, ISFP, ESTP, ESFP", { httpStatus: 400 });
          }
        }
        const result = await deps.service.updatePreferences({
          userId,
          request: {
            preferences: preferences as FridayUpdateUserPreferencesResponse["preferences"],
          },
        });

        // Emit learning events so the preference-extraction pipeline can
        // produce learned facts from API-driven preference writes.
        if (deps.collectLearningEvents && preferences.length > 0) {
          const now = new Date().toISOString();
          const genId = deps.idGenerator ?? (() => `evt-pref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
          deps.collectLearningEvents(
            preferences
              .filter((p): p is Record<string, unknown> => p != null && typeof p === "object")
              .map((p) => ({
                eventId: genId(),
                ts: now,
                userId,
                kind: "user_correction" as const,
                payload: {
                  correctedField: String(p.key ?? ""),
                  newValue: p.value,
                  category: p.category,
                  source: "uix_preferences_api",
                },
              })),
          );
        }

        return result;
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
          tenantContext: buildTenantContext(ctx.principal),
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
          tenantContext: buildTenantContext(ctx.principal),
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
          tenantContext: buildTenantContext(ctx.principal),
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
        const current = readUserProfileResponse(deps.service, userId);
        const profileType = current.profileType ?? "beginner";
        const onboardedAt = current.onboardedAt ?? new Date().toISOString();
        if (current.profileType === null || current.onboardedAt === null) {
          deps.service.updatePreferences({
            userId,
            request: {
              preferences: [
                ...(current.profileType === null
                  ? [{ category: "uix", key: "user.profile_type", value: profileType }]
                  : []),
                ...(current.onboardedAt === null
                  ? [{ category: "uix", key: "user.onboarded_at", value: onboardedAt }]
                  : []),
              ],
            } as never,
          });
        }
        return { profileType, onboardedAt };
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
        return readUserProfileResponse(deps.service, userId);
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

    // ── Learned Facts (learning feedback visibility) ──
    {
      operationId: "uix.learnedfacts.list",
      method: "GET",
      path: "/v1/uix/learned-facts",
      auth: { public: false, anyOfScopes: ["agent.run"] },
      async handler(ctx) {
        const userId = requireUserId(ctx.principal);
        if (!deps.listLearnedFacts) {
          return { items: [] };
        }
        const items = deps.listLearnedFacts({ userId });
        return { items };
      },
    },
  ];
}
