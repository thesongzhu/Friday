import { FridayDomainError } from "#errors";
import type { FridayChannelRegistry } from "#channels";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";

export interface FridayChannelRoutesDeps {
  registry: FridayChannelRegistry;
}

// ─── In-memory channel persona store ───
// Persisted across requests but not across restarts.
// A future iteration can persist to SQLite.

const channelPersonaStore = new Map<string, FridayChannelPersonaConfig>();

export interface FridayChannelPersonaConfig {
  /** Short role description, e.g. "你是一个专业的电商客服" */
  persona: string;
  /** Full system prompt override (optional, takes precedence over persona). */
  systemPrompt: string;
  updatedAt: string;
}

export function getChannelPersona(kind: string): FridayChannelPersonaConfig | undefined {
  return channelPersonaStore.get(kind);
}

export function createFridayChannelRoutes(
  deps: FridayChannelRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "channels.list",
      method: "GET",
      path: "/v1/channels",
      auth: { public: false, anyOfScopes: ["agent.run", "diagnosis.read", "hub.admin"] },
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
      auth: { public: false, anyOfScopes: ["agent.run", "diagnosis.read", "hub.admin"] },
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
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      async handler(ctx) {
        const kind = String((ctx.params as Record<string, unknown>).kind ?? "").trim();
        const persona = channelPersonaStore.get(kind);
        return { kind, persona: persona ?? null };
      },
    },
    {
      operationId: "channels.persona.update",
      method: "PUT",
      path: "/v1/channels/:kind/persona",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      async handler(ctx) {
        const kind = String((ctx.params as Record<string, unknown>).kind ?? "").trim();
        const body = ctx.body as Record<string, unknown> | undefined;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
        }

        const personaText = typeof body.persona === "string" ? body.persona.trim() : "";
        const systemPromptText = typeof body.systemPrompt === "string" ? body.systemPrompt.trim() : "";

        if (!personaText && !systemPromptText) {
          // Clear persona
          channelPersonaStore.delete(kind);
          return { kind, persona: null, cleared: true };
        }

        const config: FridayChannelPersonaConfig = {
          persona: personaText,
          systemPrompt: systemPromptText,
          updatedAt: new Date().toISOString(),
        };
        channelPersonaStore.set(kind, config);
        return { kind, persona: config };
      },
    },
  ];
}
