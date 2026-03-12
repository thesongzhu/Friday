import type { ISODateTime, JsonObject, JsonValue, UUID } from "#workflows";
import type { FridayAuthPrincipal, FridayRateLimitPolicyId, FridayRole, FridayScope } from "./friday-api-auth.types.js";

// ─── HTTP Method ───

export type FridayHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ─── Principal Type (re-export from dedicated file to break circular dep) ───

export type { FridayPrincipalType } from "./friday-api-principal.types.js";

// ─── Pagination ───

export interface FridayPaginationQuery {
  cursor?: string;
  limit?: number;
}

export interface FridayPage<TItem> {
  items: TItem[];
  nextCursor?: string;
}

// ─── Request Meta ───

export interface FridayRequestMeta {
  requestId: string;
  traceId?: string;
  receivedAt: ISODateTime;
  ip?: string;
  userAgent?: string;
}

// ─── API Error / Success ───

export interface FridayApiError {
  code: string;
  message: string;
  details?: JsonValue;
  retryable?: boolean;
  retryAfterMs?: number;
}

export interface FridayApiErrorResponse {
  ok: false;
  error: FridayApiError;
  requestId: string;
}

export interface FridayApiSuccessResponse<T> {
  ok: true;
  data: T;
  requestId: string;
}

// ─── Auth Principal (re-exported from auth types) ───

export type { FridayAuthPrincipal } from "./friday-api-auth.types.js";

// ─── HTTP Context ───

export interface FridayHttpContext<TParams, TQuery, TBody> extends FridayRequestMeta {
  params: TParams;
  query: TQuery;
  body: TBody;
  headers: Record<string, string | undefined>;
  principal: FridayAuthPrincipal | null;
  /** Raw request body string, available for signature verification. */
  rawBody?: string;
}

// ─── Route Handler + Definition ───

export type FridayRouteHandler<TParams, TQuery, TBody, TResponse> = (
  ctx: FridayHttpContext<TParams, TQuery, TBody>,
) => Promise<TResponse>;

export interface FridayRouteDefinition<TParams, TQuery, TBody, TResponse> {
  operationId: string;
  method: FridayHttpMethod;
  path: string;
  auth:
    | { public: true }
    | { public: false; anyOfScopes: FridayScope[]; anyOfRoles?: FridayRole[] };
  rateLimitPolicyId?: FridayRateLimitPolicyId;
  handler: FridayRouteHandler<TParams, TQuery, TBody, TResponse>;
}
