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
  socketIp?: string;
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
    | {
        public: true;
        /**
         * Per-route opt-out from the server-level public-mutation gate.
         *
         * The gate (friday-http-server) rejects POST/PUT/PATCH/DELETE on
         * `auth:{public:true}` routes when the request resolves to the
         * synthetic default-public principal (no/invalid Authorization
         * header). Setting `allowUnauthenticatedMutation: true` opts a single
         * route out of that floor. It MUST only be set when the handler
         * enforces an alternative trust boundary BEFORE any side effect
         * (HMAC/signature verifier, one-time bootstrap token, setup-session
         * challenge, WebAuthn challenge, etc.) AND a negative test exercises
         * that boundary. It is never a generic "make-public-writes-work"
         * convenience flag. See B0 batch spec for the per-route review bar.
         */
        allowUnauthenticatedMutation?: true;
      }
    | { public: false; anyOfScopes: FridayScope[]; anyOfRoles?: FridayRole[] };
  rateLimitPolicyId?: FridayRateLimitPolicyId;
  handler: FridayRouteHandler<TParams, TQuery, TBody, TResponse>;
}
