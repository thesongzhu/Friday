import type { FridayBriefConfig, FridayBriefRunRecord, FridayBriefService } from "#brief";
import {
  FridayBriefConfigSchema,
  isFridayBriefSecretSlot,
  normalizeFridayBriefFallbackOrder,
} from "#brief";
import { FridayDomainError } from "#errors";

import type { FridayHttpContext, FridayRouteDefinition } from "../../model/friday-api-common.types.js";

export interface FridayBriefRoutesDeps {
  service: FridayBriefService;
}

interface GetConfigResponse {
  config: FridayBriefConfig;
}

interface UpdateConfigResponse {
  config: FridayBriefConfig;
}

interface TriggerNowResponse {
  run: FridayBriefRunRecord;
}

interface ListHistoryResponse {
  items: FridayBriefRunRecord[];
  nextCursor?: string;
}

interface GetRunResponse {
  run: FridayBriefRunRecord;
}

interface ListSecretsResponse {
  slots: Array<{ slot: string; configured: boolean; refKey?: string }>;
}

interface SetSecretResponse {
  config: FridayBriefConfig;
}

interface ClearSecretResponse {
  config: FridayBriefConfig;
}

function parseLimit(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 200);
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.min(Math.trunc(value), 200);
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function createFridayBriefRoutes(
  deps: FridayBriefRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  const getConfigHandler = async (
    _ctx: FridayHttpContext<unknown, unknown, unknown>,
  ): Promise<GetConfigResponse> => {
    return { config: deps.service.getConfig() };
  };

  const updateConfigHandler = async (
    ctx: FridayHttpContext<unknown, unknown, unknown>,
  ): Promise<UpdateConfigResponse> => {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const parsed = FridayBriefConfigSchema.safeParse(body);
    if (!parsed.success) {
      throw new FridayDomainError("VALIDATION_ERROR", "Invalid brief configuration", {
        httpStatus: 400,
        details: { issues: parsed.error.issues.slice(0, 12) },
      });
    }
    const normalized: FridayBriefConfig = {
      ...parsed.data,
      fallbackOrder: normalizeFridayBriefFallbackOrder(parsed.data.fallbackOrder),
    };
    return { config: deps.service.updateConfig(normalized) };
  };

  const triggerNowHandler = async (
    ctx: FridayHttpContext<unknown, unknown, unknown>,
  ): Promise<TriggerNowResponse> => {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const windowStartIso = readString(body.windowStartIso);
    const windowEndIso = readString(body.windowEndIso);
    const triggerHint = readString(body.triggeredBy);
    const triggeredBy =
      triggerHint === "manual_cli" || triggerHint === "replay"
        ? triggerHint
        : "manual_http";
    const run = await deps.service.runOnce({
      triggeredBy,
      windowStartIso,
      windowEndIso,
    });
    return { run };
  };

  const listHistoryHandler = async (
    ctx: FridayHttpContext<unknown, unknown, unknown>,
  ): Promise<ListHistoryResponse> => {
    const query = (ctx.query ?? {}) as Record<string, unknown>;
    const limit = parseLimit(query.limit) ?? 50;
    const beforeId = readString(query.beforeId);
    const items = deps.service.listHistory({ limit, beforeId });
    const nextCursor = items.length === limit ? items[items.length - 1]?.id : undefined;
    return { items, nextCursor };
  };

  const getRunHandler = async (
    ctx: FridayHttpContext<unknown, unknown, unknown>,
  ): Promise<GetRunResponse> => {
    const { runId } = ctx.params as { runId: string };
    const run = deps.service.getRun(runId);
    if (!run) {
      throw new FridayDomainError("BRIEF_RUN_NOT_FOUND", "Brief run not found", {
        httpStatus: 404,
      });
    }
    return { run };
  };

  const listSecretsHandler = async (
    _ctx: FridayHttpContext<unknown, unknown, unknown>,
  ): Promise<ListSecretsResponse> => {
    return { slots: deps.service.listSecretSlots() };
  };

  const setSecretHandler = async (
    ctx: FridayHttpContext<unknown, unknown, unknown>,
  ): Promise<SetSecretResponse> => {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const slot = body.slot;
    const value = body.value;
    if (!isFridayBriefSecretSlot(slot)) {
      throw new FridayDomainError("VALIDATION_ERROR", "Unknown brief secret slot", {
        httpStatus: 400,
      });
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new FridayDomainError("VALIDATION_ERROR", "value is required", {
        httpStatus: 400,
      });
    }
    return { config: deps.service.setSecret(slot, value) };
  };

  const clearSecretHandler = async (
    ctx: FridayHttpContext<unknown, unknown, unknown>,
  ): Promise<ClearSecretResponse> => {
    const { slot } = ctx.params as { slot: string };
    if (!isFridayBriefSecretSlot(slot)) {
      throw new FridayDomainError("VALIDATION_ERROR", "Unknown brief secret slot", {
        httpStatus: 400,
      });
    }
    return { config: deps.service.clearSecret(slot) };
  };

  return [
    {
      operationId: "brief.config.get",
      method: "GET",
      path: "/v1/brief/config",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      handler: getConfigHandler,
    },
    {
      operationId: "brief.config.update",
      method: "PUT",
      path: "/v1/brief/config",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      rateLimitPolicyId: "generator.write",
      handler: updateConfigHandler,
    },
    {
      operationId: "brief.run.trigger",
      method: "POST",
      path: "/v1/brief/runs",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      rateLimitPolicyId: "generator.write",
      handler: triggerNowHandler,
    },
    {
      operationId: "brief.history.list",
      method: "GET",
      path: "/v1/brief/runs",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      handler: listHistoryHandler,
    },
    {
      operationId: "brief.history.get",
      method: "GET",
      path: "/v1/brief/runs/:runId",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      handler: getRunHandler,
    },
    {
      operationId: "brief.secrets.list",
      method: "GET",
      path: "/v1/brief/secrets",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      handler: listSecretsHandler,
    },
    {
      operationId: "brief.secrets.set",
      method: "POST",
      path: "/v1/brief/secrets",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      rateLimitPolicyId: "generator.write",
      handler: setSecretHandler,
    },
    {
      operationId: "brief.secrets.clear",
      method: "DELETE",
      path: "/v1/brief/secrets/:slot",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      handler: clearSecretHandler,
    },
  ];
}
