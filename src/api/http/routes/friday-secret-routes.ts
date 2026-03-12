import { FridayDomainError } from "#errors";
import type { FridaySecretAdminService } from "#providers";

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayCreateSecretRequest,
  FridayCreateSecretResponse,
  FridayDeleteSecretResponse,
  FridayGetSecretResponse,
  FridayListSecretsQuery,
  FridayListSecretsResponse,
  FridayUpdateSecretRequest,
  FridayUpdateSecretResponse,
} from "../../model/friday-api-runtime-admin.types.js";

export interface FridaySecretRoutesDeps {
  service: FridaySecretAdminService;
}

function readLimit(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

export function createFridaySecretRoutes(
  deps: FridaySecretRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "secrets.list",
      method: "GET",
      path: "/v1/secrets",
      auth: { public: false, anyOfScopes: ["security.read"] },
      async handler(ctx): Promise<FridayListSecretsResponse> {
        const query = ctx.query as Record<string, unknown>;
        return {
          items: deps.service.listSecrets({
            scope: typeof query.scope === "string" && query.scope.trim() !== "" ? query.scope : undefined,
            refKey: typeof query.refKey === "string" && query.refKey.trim() !== "" ? query.refKey : undefined,
            limit: readLimit(query.limit),
          } satisfies FridayListSecretsQuery),
        };
      },
    },
    {
      operationId: "secrets.get",
      method: "GET",
      path: "/v1/secrets/:secretId",
      auth: { public: false, anyOfScopes: ["security.read"] },
      async handler(ctx): Promise<FridayGetSecretResponse> {
        const { secretId } = ctx.params as { secretId: string };
        const secret = deps.service.getSecret(secretId);
        if (!secret) {
          throw new FridayDomainError("NOT_FOUND", "Secret not found", { httpStatus: 404 });
        }
        return { secret };
      },
    },
    {
      operationId: "secrets.create",
      method: "POST",
      path: "/v1/secrets",
      auth: { public: false, anyOfScopes: ["security.write"] },
      async handler(ctx): Promise<FridayCreateSecretResponse> {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof body.scope !== "string" || body.scope.trim() === "") {
          throw new FridayDomainError("VALIDATION_ERROR", "scope is required", { httpStatus: 400 });
        }
        if (typeof body.refKey !== "string" || body.refKey.trim() === "") {
          throw new FridayDomainError("VALIDATION_ERROR", "refKey is required", { httpStatus: 400 });
        }
        if (typeof body.value !== "string" || body.value.trim() === "") {
          throw new FridayDomainError("VALIDATION_ERROR", "value is required", { httpStatus: 400 });
        }
        return {
          secret: deps.service.createSecret(body as unknown as FridayCreateSecretRequest),
        };
      },
    },
    {
      operationId: "secrets.update",
      method: "PATCH",
      path: "/v1/secrets/:secretId",
      auth: { public: false, anyOfScopes: ["security.write"] },
      async handler(ctx): Promise<FridayUpdateSecretResponse> {
        const { secretId } = ctx.params as { secretId: string };
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        if (
          body.refKey === undefined
          && body.value === undefined
          && body.expiresAt === undefined
        ) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "at least one of refKey, value, or expiresAt must be provided",
            { httpStatus: 400 },
          );
        }
        return {
          secret: deps.service.updateSecret(secretId, body as FridayUpdateSecretRequest),
        };
      },
    },
    {
      operationId: "secrets.delete",
      method: "DELETE",
      path: "/v1/secrets/:secretId",
      auth: { public: false, anyOfScopes: ["security.write"] },
      async handler(ctx): Promise<FridayDeleteSecretResponse> {
        const { secretId } = ctx.params as { secretId: string };
        return { deleted: deps.service.deleteSecret(secretId) };
      },
    },
  ];
}
