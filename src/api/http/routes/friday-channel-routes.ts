import { FridayDomainError } from "#errors";
import type { FridayChannelRegistry } from "#channels";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";

export interface FridayChannelRoutesDeps {
  registry: FridayChannelRegistry;
  /** Channel kinds supported by the runtime even when no instance is currently enabled. */
  supportedKinds?: readonly string[];
  nowIso?: () => string;
  persistPersona?: (kind: string, config: FridayChannelPersonaConfig | null) => void | Promise<void>;
}

const channelPersonaStore = new Map<string, FridayChannelPersonaConfig>();

export interface FridayChannelPersonaConfig {
  /** Short role description, e.g. "你是一个专业的电商客服" */
  persona: string;
  /** Full system prompt override (optional, takes precedence over persona). */
  systemPrompt: string;
  updatedAt: string;
}

function normalizeChannelPersonaConfig(value: unknown): FridayChannelPersonaConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const persona = typeof record.persona === "string" ? record.persona.trim() : "";
  const systemPrompt = typeof record.systemPrompt === "string" ? record.systemPrompt.trim() : "";
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : "";
  if (!persona && !systemPrompt) {
    return null;
  }
  return {
    persona,
    systemPrompt,
    updatedAt: updatedAt || new Date().toISOString(),
  };
}

export function getChannelPersona(kind: string): FridayChannelPersonaConfig | undefined {
  return channelPersonaStore.get(kind);
}

export function hydrateChannelPersonaStore(input: Record<string, unknown> | null | undefined): void {
  channelPersonaStore.clear();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return;
  }
  for (const [kind, value] of Object.entries(input)) {
    const normalized = normalizeChannelPersonaConfig(value);
    if (normalized) {
      channelPersonaStore.set(kind, normalized);
    }
  }
}

export function resetChannelPersonaStore(): void {
  channelPersonaStore.clear();
}

function requireRegisteredChannel(
  deps: FridayChannelRoutesDeps,
  kind: string,
): void {
  const channel = deps.registry.describe(kind);
  if (!channel) {
    throw new FridayDomainError("CHANNEL_NOT_FOUND", `Channel "${kind}" is not registered`, {
      httpStatus: 404,
    });
  }
}

function requirePersonaChannelKind(
  deps: FridayChannelRoutesDeps,
  kind: string,
): void {
  if (deps.registry.describe(kind)) {
    return;
  }
  if ((deps.supportedKinds ?? []).includes(kind)) {
    return;
  }
  throw new FridayDomainError("CHANNEL_NOT_FOUND", `Channel "${kind}" is not registered`, {
    httpStatus: 404,
  });
}

export function createFridayChannelRoutes(
  deps: FridayChannelRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "channels.list",
      method: "GET",
      path: "/v1/channels",
      auth: { public: true },
      async handler() {
        const views = deps.registry.listViews();
        // Enrich with persona config
        const enriched = views.map((view) => {
          const persona = channelPersonaStore.get(view.kind);
          return { ...view, persona: persona ?? null };
        });
        return { items: enriched };
      },
    },
    {
      operationId: "channels.get",
      method: "GET",
      path: "/v1/channels/:kind",
      auth: { public: true },
      async handler(ctx) {
        const kind = String((ctx.params as Record<string, unknown>).kind ?? "").trim();
        const channel = deps.registry.describe(kind);
        if (!channel) {
          throw new FridayDomainError("CHANNEL_NOT_FOUND", `Channel "${kind}" is not registered`, {
            httpStatus: 404,
          });
        }
        const persona = channelPersonaStore.get(kind);
        return { channel: { ...channel, persona: persona ?? null } };
      },
    },
    {
      operationId: "channels.persona.get",
      method: "GET",
      path: "/v1/channels/:kind/persona",
      auth: { public: true },
      async handler(ctx) {
        const kind = String((ctx.params as Record<string, unknown>).kind ?? "").trim();
        requirePersonaChannelKind(deps, kind);
        const persona = channelPersonaStore.get(kind);
        return { kind, persona: persona ?? null };
      },
    },
    {
      operationId: "channels.persona.update",
      method: "PUT",
      path: "/v1/channels/:kind/persona",
      auth: { public: true },
      async handler(ctx) {
        const kind = String((ctx.params as Record<string, unknown>).kind ?? "").trim();
        requirePersonaChannelKind(deps, kind);
        const body = ctx.body as Record<string, unknown> | undefined;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
        }

        const personaText = typeof body.persona === "string" ? body.persona.trim() : "";
        const systemPromptText = typeof body.systemPrompt === "string" ? body.systemPrompt.trim() : "";

        if (!personaText && !systemPromptText) {
          await deps.persistPersona?.(kind, null);
          channelPersonaStore.delete(kind);
          return { kind, persona: null, cleared: true };
        }

        const config: FridayChannelPersonaConfig = {
          persona: personaText,
          systemPrompt: systemPromptText,
          updatedAt: deps.nowIso ? deps.nowIso() : new Date().toISOString(),
        };
        await deps.persistPersona?.(kind, config);
        channelPersonaStore.set(kind, config);
        return { kind, persona: config };
      },
    },
  ];
}
