import { FridayDomainError } from "#errors";

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayReflexCandidateKind,
  FridayReflexCandidateStatus,
  FridayReflexService,
  FridayReflexSurface,
} from "../../../reflex/index.js";
import type { FridayUserPreferenceCategory, JsonValue } from "../../../uix/model/friday-uix.types.js";

const CANDIDATE_STATUSES = new Set<FridayReflexCandidateStatus>([
  "proposed",
  "testing",
  "ready_for_review",
  "approved",
  "rejected",
  "dismissed",
  "failed",
  "superseded",
]);

const CANDIDATE_KINDS = new Set<FridayReflexCandidateKind>([
  "memory",
  "learned_fact",
  "preference",
  "recipe",
  "skill",
  "workflow",
  "fix",
  "test_policy",
]);

const PREFERENCE_CATEGORIES = new Set<FridayUserPreferenceCategory>([
  "communication",
  "uix",
  "reflex",
]);

const SURFACES = new Set<FridayReflexSurface>(["channel", "operate", "review_center"]);

export interface FridayReflexRoutesDeps {
  service: FridayReflexService;
}

function requireUserId(principal: { userId?: string } | null): string {
  if (!principal?.userId) {
    throw new FridayDomainError("UNAUTHORIZED", "A bound Friday user principal is required", {
      httpStatus: 401,
    });
  }
  return principal.userId;
}

function readBodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  return body as Record<string, unknown>;
}

function readRequiredText(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `${key} is required`, { httpStatus: 400 });
  }
  return value.trim();
}

function readOptionalText(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readSurface(body: Record<string, unknown>): FridayReflexSurface {
  const value = body.sourceSurface;
  if (value === undefined) return "review_center";
  if (typeof value === "string" && SURFACES.has(value as FridayReflexSurface)) {
    return value as FridayReflexSurface;
  }
  throw new FridayDomainError("VALIDATION_ERROR", "sourceSurface is invalid", { httpStatus: 400 });
}

function readJsonObject(body: Record<string, unknown>, key: string): Record<string, JsonValue> {
  const value = body[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FridayDomainError("VALIDATION_ERROR", `${key} must be an object`, { httpStatus: 400 });
  }
  return value as Record<string, JsonValue>;
}

function readPreferenceCategory(value: unknown): FridayUserPreferenceCategory {
  if (typeof value === "string" && PREFERENCE_CATEGORIES.has(value as FridayUserPreferenceCategory)) {
    return value as FridayUserPreferenceCategory;
  }
  throw new FridayDomainError("VALIDATION_ERROR", "category must be communication, uix, or reflex", {
    httpStatus: 400,
  });
}

function readLimit(query: Record<string, unknown>): number | undefined {
  if (query.limit === undefined) return undefined;
  const parsed = Number(query.limit);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new FridayDomainError("VALIDATION_ERROR", "limit must be a positive integer", {
      httpStatus: 400,
    });
  }
  return Math.min(parsed, 200);
}

function readCandidateStatus(query: Record<string, unknown>): FridayReflexCandidateStatus | undefined {
  if (query.status === undefined) return undefined;
  if (typeof query.status === "string" && CANDIDATE_STATUSES.has(query.status as FridayReflexCandidateStatus)) {
    return query.status as FridayReflexCandidateStatus;
  }
  throw new FridayDomainError("VALIDATION_ERROR", "status is not a valid reflex candidate status", {
    httpStatus: 400,
  });
}

function readCandidateKind(query: Record<string, unknown>): FridayReflexCandidateKind | undefined {
  if (query.kind === undefined) return undefined;
  if (typeof query.kind === "string" && CANDIDATE_KINDS.has(query.kind as FridayReflexCandidateKind)) {
    return query.kind as FridayReflexCandidateKind;
  }
  throw new FridayDomainError("VALIDATION_ERROR", "kind is not a valid reflex candidate kind", {
    httpStatus: 400,
  });
}

export function createFridayReflexRoutes(
  deps: FridayReflexRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "reflex.onboarding.get",
      method: "GET",
      path: "/v1/reflex/onboarding",
      auth: { public: true },
      async handler(ctx) {
        return deps.service.getOnboarding(requireUserId(ctx.principal));
      },
    },
    {
      operationId: "reflex.onboarding.start",
      method: "POST",
      path: "/v1/reflex/onboarding/start",
      auth: { public: true },
      async handler(ctx) {
        const userId = requireUserId(ctx.principal);
        const body = readBodyObject(ctx.body);
        return deps.service.startOnboarding({
          userId,
          primaryChannelKind: readOptionalText(body, "primaryChannelKind"),
          primaryChannelUserId: readOptionalText(body, "primaryChannelUserId"),
        });
      },
    },
    {
      operationId: "reflex.onboarding.answer",
      method: "POST",
      path: "/v1/reflex/onboarding/answer",
      auth: { public: true },
      async handler(ctx) {
        const userId = requireUserId(ctx.principal);
        const body = readBodyObject(ctx.body);
        return deps.service.answerOnboarding({
          userId,
          questionId: readRequiredText(body, "questionId"),
          answer: readJsonObject(body, "answer"),
          sourceSurface: readSurface(body),
        });
      },
    },
    {
      operationId: "reflex.onboarding.skip",
      method: "POST",
      path: "/v1/reflex/onboarding/skip",
      auth: { public: true },
      async handler(ctx) {
        const userId = requireUserId(ctx.principal);
        const body = readBodyObject(ctx.body);
        return deps.service.skipOnboarding({
          userId,
          questionId: readRequiredText(body, "questionId"),
          sourceSurface: readSurface(body),
        });
      },
    },
    {
      operationId: "reflex.candidates.list",
      method: "GET",
      path: "/v1/reflex/candidates",
      auth: { public: true },
      async handler(ctx) {
        const userId = requireUserId(ctx.principal);
        const query = ctx.query as Record<string, unknown>;
        return {
          items: deps.service.listCandidates({
            userId,
            status: readCandidateStatus(query),
            kind: readCandidateKind(query),
            limit: readLimit(query),
          }),
        };
      },
    },
    {
      operationId: "reflex.candidates.get",
      method: "GET",
      path: "/v1/reflex/candidates/:id",
      auth: { public: true },
      async handler(ctx) {
        const userId = requireUserId(ctx.principal);
        const { id } = ctx.params as { id: string };
        return deps.service.getCandidate({ userId, candidateId: id });
      },
    },
    {
      operationId: "reflex.candidates.test",
      method: "POST",
      path: "/v1/reflex/candidates/:id/test",
      auth: { public: true },
      async handler(ctx) {
        const userId = requireUserId(ctx.principal);
        const { id } = ctx.params as { id: string };
        const body = readBodyObject(ctx.body);
        return deps.service.testCandidate({
          userId,
          candidateId: id,
          requestedModel: readOptionalText(body, "requestedModel"),
        });
      },
    },
    {
      operationId: "reflex.candidates.approve",
      method: "POST",
      path: "/v1/reflex/candidates/:id/approve",
      auth: { public: true },
      async handler(ctx) {
        const userId = requireUserId(ctx.principal);
        const { id } = ctx.params as { id: string };
        return deps.service.approveCandidate({ userId, candidateId: id });
      },
    },
    {
      operationId: "reflex.candidates.reject",
      method: "POST",
      path: "/v1/reflex/candidates/:id/reject",
      auth: { public: true },
      async handler(ctx) {
        const userId = requireUserId(ctx.principal);
        const { id } = ctx.params as { id: string };
        const body = readBodyObject(ctx.body);
        return deps.service.rejectCandidate({
          userId,
          candidateId: id,
          reason: readOptionalText(body, "reason"),
        });
      },
    },
    {
      operationId: "reflex.candidates.dismiss",
      method: "POST",
      path: "/v1/reflex/candidates/:id/dismiss",
      auth: { public: true },
      async handler(ctx) {
        const userId = requireUserId(ctx.principal);
        const { id } = ctx.params as { id: string };
        const body = readBodyObject(ctx.body);
        return deps.service.dismissCandidate({
          userId,
          candidateId: id,
          reason: readOptionalText(body, "reason"),
        });
      },
    },
    {
      operationId: "reflex.preferences.list",
      method: "GET",
      path: "/v1/reflex/preferences",
      auth: { public: true },
      async handler(ctx) {
        return { items: deps.service.listPreferences(requireUserId(ctx.principal)) };
      },
    },
    {
      operationId: "reflex.preferences.revoke",
      method: "POST",
      path: "/v1/reflex/preferences/:id/revoke",
      auth: { public: true },
      async handler(ctx) {
        const userId = requireUserId(ctx.principal);
        const { id } = ctx.params as { id: string };
        const body = readBodyObject(ctx.body);
        return deps.service.revokePreference({
          userId,
          preferenceId: id,
          sourceSurface: readSurface(body),
        });
      },
    },
    {
      operationId: "reflex.preferences.update",
      method: "PATCH",
      path: "/v1/reflex/preferences/:key",
      auth: { public: true },
      async handler(ctx) {
        const userId = requireUserId(ctx.principal);
        const { key } = ctx.params as { key: string };
        const body = readBodyObject(ctx.body);
        if (!("value" in body)) {
          throw new FridayDomainError("VALIDATION_ERROR", "value is required", { httpStatus: 400 });
        }
        return deps.service.requestPreferenceUpdate({
          userId,
          category: readPreferenceCategory(body.category),
          key,
          value: body.value as JsonValue,
          sourceSurface: readSurface(body),
        });
      },
    },
  ];
}
