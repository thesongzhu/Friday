import { FridayDomainError } from "#errors";
import { createFridayMemoryOutputFilter } from "#memory";
import type { FridayProviderTenantContext } from "#providers";
import {
  FRIDAY_COMMUNICATION_PREFERENCE_KEYS,
  isMbti,
} from "../../../uix/services/friday-communication-persona.js";
import type { FridayUixSurfaceService } from "../../../uix/services/friday-uix-surface-service.js";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayBeginnerIntentResolution,
  FridayInvestigateResponse,
  FridayUixAssistantInboxSnapshotResponse,
  FridayUixDiagnosticsResponse,
  FridayUixHomeSnapshotResponse,
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
import {
  FRIDAY_LEARNED_FACT_CONTEXT_USE_BOUNDARY,
  FRIDAY_LEARNED_FACT_EVIDENCE_BOUNDARY,
  FRIDAY_LEARNED_FACT_MEMORY_BOUNDARY,
  FRIDAY_LEARNED_FACT_PROMPT_INJECTION_BOUNDARY,
  FRIDAY_LEARNED_FACT_REVOCATION_BOUNDARY,
  FRIDAY_LEARNED_FACT_TRUST_LEVEL,
  readLearnedFactReviewBoundary,
} from "../../../learning/services/friday-learned-fact-memory-view.js";
import { isUnauthenticatedPublicPrincipal } from "../../../security/friday-owner-session-channel-capability.js";

interface FridayUixLearnedFactItem {
  key: string;
  value: unknown;
  confidence: number;
  evidenceCount: number;
  lastConfirmedAt: string;
  metadata?: Record<string, unknown>;
}

export interface FridayUixRoutesDeps {
  service: FridayUixSurfaceService;
  readSetupCompletedAt?: () => string | null;
  /** Optional: expose learned preference facts to users for transparency. */
  listLearnedFacts?: (input: { userId: string }) => FridayUixLearnedFactItem[];
  deleteLearnedFact?: (input: { userId: string; key: string }) => boolean;
  updateLearnedFact?: (input: { userId: string; key: string; value?: unknown; confidence?: number }) => { key: string; value: unknown; confidence: number; evidenceCount: number; lastConfirmedAt: string } | null;
  clearLearnedFacts?: (input: { userId: string }) => number;
  /** Optional: emit learning events when preferences are written via the API,
   *  so the preference-extraction pipeline can produce learned facts. */
  collectLearningEvents?: (events: Array<{ eventId: string; ts: string; userId: string; kind: "user_correction"; payload: Record<string, unknown> }>) => void;
  /** Generate a unique ID for learning events. */
  idGenerator?: () => string;
}

function requireUserId(principal: { userId?: string } | null): string {
  if (isUnauthenticatedPublicPrincipal(principal as never) || !principal?.userId) {
    throw new FridayDomainError("UNAUTHORIZED", "A user-scoped assistant principal is required", {
      httpStatus: 401,
    });
  }
  return principal.userId;
}

function learnedFactRevocationUnavailable(): never {
  throw new FridayDomainError(
    "UIX_LEARNED_FACT_REVOCATION_UNAVAILABLE",
    "Learned fact revocation is unavailable in this runtime",
    { httpStatus: 503 },
  );
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

function readUserProfileResponse(
  service: FridayUixSurfaceService,
  userId: string,
  readSetupCompletedAt?: () => string | null,
): FridayUserProfileResponse {
  const prefs = service.listPreferences({ userId, category: "uix" });
  const profilePref = prefs.items.find((p) => p.key === "user.profile_type");
  const onboardedPref = prefs.items.find((p) => p.key === "user.onboarded_at");
  return {
    profileType: (profilePref?.value as FridayUserProfileType | undefined) ?? null,
    onboardedAt: (onboardedPref?.value as string | undefined) ?? readSetupCompletedAt?.() ?? null,
  };
}

function enrichLearnedFactBoundary<T extends {
  confidence: number;
  evidenceCount: number;
  lastConfirmedAt: string;
  metadata?: Record<string, unknown>;
}>(item: T): Omit<T, "metadata"> & {
  boundary: {
    trustLevel: string;
    memoryBoundary: string;
    evidenceBoundary: string;
    contextUseBoundary: string;
    promptInjectionBoundary: string;
    reviewBoundary: string;
    revocationBoundary: string;
  };
} {
  const { metadata: _metadata, ...publicItem } = item;
  return {
    ...publicItem,
    boundary: {
      trustLevel: FRIDAY_LEARNED_FACT_TRUST_LEVEL,
      memoryBoundary: FRIDAY_LEARNED_FACT_MEMORY_BOUNDARY,
      evidenceBoundary: FRIDAY_LEARNED_FACT_EVIDENCE_BOUNDARY,
      contextUseBoundary: FRIDAY_LEARNED_FACT_CONTEXT_USE_BOUNDARY,
      promptInjectionBoundary: FRIDAY_LEARNED_FACT_PROMPT_INJECTION_BOUNDARY,
      reviewBoundary: readLearnedFactReviewBoundary(item),
      revocationBoundary: FRIDAY_LEARNED_FACT_REVOCATION_BOUNDARY,
    },
  };
}

export function createFridayUixRoutes(
  deps: FridayUixRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  // Learned facts are written verbatim (bypassing the write-time PII guard) and are exposed
  // here for user transparency. Route the free-form `value` through the SAME production PII
  // output filter (#1607) as a final egress transform so no raw PII (full-width / CJK / ASCII)
  // leaks. `enrichLearnedFactBoundary` already strips `metadata`, so `value` is the carrier.
  const outputFilter = createFridayMemoryOutputFilter();
  const redactLearnedFact = <T extends { value: unknown }>(fact: T): T =>
    ({ ...fact, value: outputFilter.redactLearnedFactValue(fact.value) });
  return [
    {
      operationId: "uix.intents.resolve",
      method: "POST",
      path: "/v1/uix/intents/resolve",
      auth: { public: true },
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
      auth: { public: true },
      async handler(ctx): Promise<FridayUixTemplatesResponse> {
        requireUserId(ctx.principal);
        return { templates: deps.service.listTemplates() };
      },
    },
    {
      operationId: "uix.home.snapshot.get",
      method: "GET",
      path: "/v1/uix/home-snapshot",
      auth: { public: true },
      async handler(ctx): Promise<FridayUixHomeSnapshotResponse> {
        const userId = requireUserId(ctx.principal);
        return {
          snapshot: deps.service.getHomeSnapshot({ userId }),
        };
      },
    },
    {
      operationId: "uix.assistant.inbox.snapshot.get",
      method: "GET",
      path: "/v1/uix/assistant-inbox-snapshot",
      auth: { public: true },
      async handler(ctx): Promise<FridayUixAssistantInboxSnapshotResponse> {
        const userId = requireUserId(ctx.principal);
        return {
          snapshot: deps.service.getAssistantInboxSnapshot({ userId }),
        };
      },
    },
    {
      operationId: "uix.diagnostics.get",
      method: "GET",
      path: "/v1/uix/diagnostics",
      auth: { public: true },
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
      auth: { public: true },
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
      auth: { public: true },
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
            (pref as Record<string, unknown>).key === FRIDAY_COMMUNICATION_PREFERENCE_KEYS.mbti &&
            (pref as Record<string, unknown>).value !== null &&
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
      auth: { public: true },
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
      auth: { public: true },
      async handler(ctx): Promise<FridayGetCommunicationPersonaResponse> {
        const userId = requireUserId(ctx.principal);
        return {
          persona: deps.service.getPersona({ userId }),
        };
      },
    },
    {
      operationId: "uix.persona.update",
      method: "PUT",
      path: "/v1/uix/persona",
      auth: { public: true },
      async handler(ctx): Promise<FridayGetCommunicationPersonaResponse> {
        const userId = requireUserId(ctx.principal);
        const body = ctx.body as Record<string, unknown> | null;
        const settings = (body?.settings ?? {}) as Record<string, unknown>;

        // Map persona settings to user preferences with category "communication"
        const validKeys = new Map<string, string>([
          ["tone", FRIDAY_COMMUNICATION_PREFERENCE_KEYS.tone],
          ["verbosity", FRIDAY_COMMUNICATION_PREFERENCE_KEYS.verbosity],
          ["structure", FRIDAY_COMMUNICATION_PREFERENCE_KEYS.structure],
          ["questionStyle", FRIDAY_COMMUNICATION_PREFERENCE_KEYS.questionStyle],
          ["directness", FRIDAY_COMMUNICATION_PREFERENCE_KEYS.directness],
          ["emojiStyle", FRIDAY_COMMUNICATION_PREFERENCE_KEYS.emojiStyle],
          ["jargonTolerance", FRIDAY_COMMUNICATION_PREFERENCE_KEYS.jargonTolerance],
          ["assumptionStyle", FRIDAY_COMMUNICATION_PREFERENCE_KEYS.assumptionStyle],
          ["confirmationStyle", FRIDAY_COMMUNICATION_PREFERENCE_KEYS.confirmationStyle],
        ]);
        const preferences: Array<{ category: "communication"; key: string; value: string }> = [];
        for (const [key, value] of Object.entries(settings)) {
          if (validKeys.has(key) && typeof value === "string" && value.trim().length > 0) {
            preferences.push({ category: "communication", key: validKeys.get(key)!, value: value.trim() });
          }
        }

        if (preferences.length === 0) {
          throw new FridayDomainError("VALIDATION_ERROR", "At least one valid persona setting is required. Valid keys: " + [...validKeys.keys()].join(", "), { httpStatus: 400 });
        }

        deps.service.updatePreferences({
          userId,
          request: { preferences },
        });

        return {
          persona: deps.service.getPersona({ userId }),
        };
      },
    },
    {
      operationId: "uix.templates.execute",
      method: "POST",
      path: "/v1/uix/templates/:templateId/execute",
      auth: { public: true },
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
      auth: { public: true },
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
      auth: { public: true },
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
      auth: { public: true },
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
      auth: { public: true },
      async handler(ctx): Promise<FridayUserProfileResponse> {
        const userId = requireUserId(ctx.principal);
        const current = readUserProfileResponse(deps.service, userId, deps.readSetupCompletedAt);
        const profileType = current.profileType ?? "beginner";
        const onboardedAt = current.onboardedAt ?? null;
        return { profileType, onboardedAt };
      },
    },
    {
      operationId: "uix.user.profile.update",
      method: "PUT",
      path: "/v1/uix/user-profile",
      auth: { public: true },
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
        return readUserProfileResponse(deps.service, userId, deps.readSetupCompletedAt);
      },
    },
    {
      operationId: "uix.investigate",
      method: "POST",
      path: "/v1/uix/investigate",
      auth: { public: true },
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
      auth: { public: true },
      async handler(ctx) {
        const userId = requireUserId(ctx.principal);
        if (!deps.listLearnedFacts) {
          return { items: [] };
        }
        const items = deps.listLearnedFacts({ userId })
          .map(redactLearnedFact)
          .map(enrichLearnedFactBoundary);
        return { items };
      },
    },
    {
      operationId: "uix.learnedfacts.clear",
      method: "DELETE",
      path: "/v1/uix/learned-facts",
      auth: { public: true },
      async handler(ctx): Promise<{ deletedCount: number }> {
        const userId = requireUserId(ctx.principal);
        if (!deps.clearLearnedFacts) {
          learnedFactRevocationUnavailable();
        }
        return { deletedCount: deps.clearLearnedFacts({ userId }) };
      },
    },
    {
      operationId: "uix.learnedfacts.update",
      method: "PATCH",
      path: "/v1/uix/learned-facts/:factKey",
      auth: { public: true },
      async handler(ctx) {
        const userId = requireUserId(ctx.principal);
        const { factKey } = ctx.params as { factKey: string };
        const key = typeof factKey === "string" ? decodeURIComponent(factKey).trim() : "";
        if (key.length === 0) {
          throw new FridayDomainError("VALIDATION_ERROR", "factKey is required", { httpStatus: 400 });
        }
        if (!deps.updateLearnedFact) {
          throw new FridayDomainError("UIX_NOT_AVAILABLE", "Learned fact update is not available", { httpStatus: 501 });
        }
        const body = ctx.body as Record<string, unknown> | undefined;
        const value = body?.value;
        const confidence = typeof body?.confidence === "number" ? body.confidence : undefined;
        if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
          throw new FridayDomainError("VALIDATION_ERROR", "confidence must be between 0.0 and 1.0", { httpStatus: 400 });
        }
        if (value === undefined && confidence === undefined) {
          throw new FridayDomainError("VALIDATION_ERROR", "At least one of value or confidence is required", { httpStatus: 400 });
        }
        const updated = deps.updateLearnedFact({ userId, key, value, confidence });
        if (!updated) {
          throw new FridayDomainError("UIX_PREFERENCE_NOT_FOUND", `Learned fact '${key}' was not found`, { httpStatus: 404 });
        }
        return enrichLearnedFactBoundary(redactLearnedFact(updated));
      },
    },
    {
      operationId: "uix.learnedfacts.delete",
      method: "DELETE",
      path: "/v1/uix/learned-facts/:factKey",
      auth: { public: true },
      async handler(ctx): Promise<{ deleted: true; key: string }> {
        const userId = requireUserId(ctx.principal);
        const { factKey } = ctx.params as { factKey: string };
        const key = typeof factKey === "string" ? decodeURIComponent(factKey).trim() : "";
        if (key.length === 0) {
          throw new FridayDomainError("VALIDATION_ERROR", "factKey is required", { httpStatus: 400 });
        }
        if (!deps.deleteLearnedFact) {
          learnedFactRevocationUnavailable();
        }
        if (!deps.deleteLearnedFact({ userId, key })) {
          throw new FridayDomainError("UIX_PREFERENCE_NOT_FOUND", `Learned fact '${key}' was not found`, { httpStatus: 404 });
        }
        return { deleted: true, key };
      },
    },
  ];
}
