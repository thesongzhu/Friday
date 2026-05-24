import { FridayDomainError } from "../../../errors/friday-domain-error.js";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayBeginSystemRemotePasskeyAssertionRequest,
  FridayBeginSystemRemotePasskeyAssertionResponse,
  FridayBeginSystemRemotePasskeyRegistrationRequest,
  FridayBeginSystemRemotePasskeyRegistrationResponse,
  FridayCreateSystemRemoteSessionRequest,
  FridayCreateSystemRemoteSessionResponse,
  FridayDeleteSystemRemoteDeviceResponse,
  FridayDeleteSystemRemotePasskeyResponse,
  FridayDeleteSystemRemoteSessionResponse,
  FridayExecuteSystemIntentRequest,
  FridayExecuteSystemIntentResponse,
  FridayGetSystemSessionResponse,
  FridayGetSystemStateResponse,
  FridayHeartbeatSystemRemoteSessionRequest,
  FridayHeartbeatSystemRemoteSessionResponse,
  FridayListSystemApprovalsQuery,
  FridayListSystemApprovalsResponse,
  FridayListSystemEventsQuery,
  FridayListSystemEventsResponse,
  FridayListSystemRemoteDevicesResponse,
  FridayListSystemRemoteSessionsQuery,
  FridayListSystemRemoteSessionsResponse,
  FridayRegisterSystemRemoteDeviceRequest,
  FridayRegisterSystemRemoteDeviceResponse,
  FridayUpdateSystemApprovalRequest,
  FridayUpdateSystemApprovalResponse,
  FridayVerifySystemRemotePasskeyAssertionRequest,
  FridayVerifySystemRemotePasskeyAssertionResponse,
  FridayVerifySystemRemotePasskeyRegistrationRequest,
  FridayVerifySystemRemotePasskeyRegistrationResponse,
} from "../../model/friday-api-system.types.js";
import type { FridaySystemEvent } from "../../../system/model/friday-system.types.js";

const SYSTEM_SSE_KEEPALIVE_MS = 15_000;

interface FridaySseResponse {
  writeHead(statusCode: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(chunk?: string): void;
  on(event: "close", listener: () => void): void;
}

const TRUSTED_DEVICE_PLATFORMS = new Set(["browser", "ios", "android"]);

export interface FridaySystemRoutesDeps {
  session: {
    get(): Promise<FridayGetSystemSessionResponse>;
  };
  state: {
    get(): Promise<FridayGetSystemStateResponse>;
  };
  intents: {
    execute(req: FridayExecuteSystemIntentRequest): Promise<FridayExecuteSystemIntentResponse>;
  };
  approvals: {
    list(query: FridayListSystemApprovalsQuery): FridayListSystemApprovalsResponse;
    update(
      approvalId: string,
      req: FridayUpdateSystemApprovalRequest,
    ): FridayUpdateSystemApprovalResponse;
  };
  events: {
    list(query: FridayListSystemEventsQuery): FridayListSystemEventsResponse;
    subscribe(listener: (event: FridaySystemEvent) => void): () => void;
  };
  remote: {
    list(): FridayListSystemRemoteDevicesResponse;
    register(req: FridayRegisterSystemRemoteDeviceRequest): FridayRegisterSystemRemoteDeviceResponse;
    revoke(deviceId: string): FridayDeleteSystemRemoteDeviceResponse;
    clearPasskey(deviceId: string): Promise<FridayDeleteSystemRemotePasskeyResponse>;
    listSessions(query: FridayListSystemRemoteSessionsQuery): FridayListSystemRemoteSessionsResponse;
    openSession(
      req: FridayCreateSystemRemoteSessionRequest,
      meta: { ipAddress?: string; userAgent?: string },
    ): Promise<FridayCreateSystemRemoteSessionResponse>;
    heartbeatSession(
      sessionId: string,
      req: FridayHeartbeatSystemRemoteSessionRequest,
      meta: { ipAddress?: string; userAgent?: string },
    ): Promise<FridayHeartbeatSystemRemoteSessionResponse>;
    closeSession(sessionId: string): Promise<FridayDeleteSystemRemoteSessionResponse>;
  };
  remoteAuth: {
    beginRegistration(
      req: FridayBeginSystemRemotePasskeyRegistrationRequest,
      meta: { origin?: string },
    ): Promise<FridayBeginSystemRemotePasskeyRegistrationResponse>;
    verifyRegistration(
      req: FridayVerifySystemRemotePasskeyRegistrationRequest,
      meta: { origin?: string },
    ): Promise<FridayVerifySystemRemotePasskeyRegistrationResponse>;
    beginAssertion(
      req: FridayBeginSystemRemotePasskeyAssertionRequest,
      meta: { origin?: string },
    ): Promise<FridayBeginSystemRemotePasskeyAssertionResponse>;
    verifyAssertion(
      req: FridayVerifySystemRemotePasskeyAssertionRequest,
      meta: { origin?: string; ipAddress?: string; userAgent?: string },
    ): Promise<FridayVerifySystemRemotePasskeyAssertionResponse>;
  };
}

function requireString(body: unknown, field: string): void {
  const obj = body as Record<string, unknown> | undefined | null;
  if (!obj || typeof obj[field] !== "string" || (obj[field] as string).trim().length === 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `${field} is required`, { httpStatus: 400 });
  }
}

function requireIdempotencyKey(body: unknown): void {
  requireString(body, "idempotencyKey");
}

function requireTrustedDevicePlatform(body: unknown, field: string): void {
  const obj = body as Record<string, unknown> | undefined | null;
  const value = obj?.[field];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || !TRUSTED_DEVICE_PLATFORMS.has(value)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${field} must be one of: browser, ios, android`,
      { httpStatus: 400 },
    );
  }
}

function parsePositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const raw = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(raw) || raw < 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `${field} must be a non-negative integer`, {
      httpStatus: 400,
    });
  }
  return Math.floor(raw);
}

function readClientIp(ctx: { ip?: string; socketIp?: string }): string | undefined {
  return ctx.ip ?? ctx.socketIp;
}

function readUserAgent(ctx: { userAgent?: string; headers: Record<string, string | undefined> }): string | undefined {
  return ctx.userAgent ?? ctx.headers["user-agent"];
}

function readOrigin(ctx: { headers: Record<string, string | undefined> }): string | undefined {
  const origin = ctx.headers.origin?.trim();
  if (origin) {
    return origin;
  }
  const referer = ctx.headers.referer?.trim();
  if (!referer) {
    return undefined;
  }
  try {
    return new URL(referer).origin;
  } catch (err) {
    console.warn("[friday][system-routes] operation failed:", err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

export function createFridaySystemRoutes(
  deps: FridaySystemRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "system.session.get",
      method: "GET",
      path: "/v1/system/session",
      auth: { public: true },
      async handler() {
        return deps.session.get();
      },
    },
    {
      operationId: "system.state.get",
      method: "GET",
      path: "/v1/system/state",
      auth: { public: true },
      async handler() {
        return deps.state.get();
      },
    },
    {
      operationId: "system.intents.execute",
      method: "POST",
      path: "/v1/system/intents",
      auth: { public: true },
      async handler(ctx) {
        const body = ctx.body as FridayExecuteSystemIntentRequest;
        requireString(body, "action");
        requireIdempotencyKey(body);
        const { canonicalApproval: _ignoredCanonicalApproval, ...safeBody } =
          body as FridayExecuteSystemIntentRequest & { canonicalApproval?: unknown };
        return deps.intents.execute(safeBody);
      },
    },
    {
      operationId: "system.approvals.list",
      method: "GET",
      path: "/v1/system/approvals",
      auth: { public: true },
      async handler(ctx) {
        const query = ctx.query as FridayListSystemApprovalsQuery;
        return deps.approvals.list({
          ...query,
          limit: parsePositiveInt(query.limit, "limit"),
        });
      },
    },
    {
      operationId: "system.approvals.update",
      method: "PATCH",
      path: "/v1/system/approvals/:approvalId",
      auth: { public: true },
      async handler(ctx) {
        const { approvalId } = ctx.params as { approvalId: string };
        const body = ctx.body as FridayUpdateSystemApprovalRequest;
        requireIdempotencyKey(body);
        return deps.approvals.update(approvalId, body);
      },
    },
    {
      operationId: "system.events.stream",
      method: "GET",
      path: "/v1/system/events",
      auth: { public: true },
      async handler(ctx) {
        const query = ctx.query as FridayListSystemEventsQuery;
        const rawRes = (ctx as unknown as Record<string, unknown>)._raw as FridaySseResponse | undefined;
        const afterSeq = parsePositiveInt(query.afterSeq, "afterSeq");
        const limit = parsePositiveInt(query.limit, "limit");
        const parsedQuery = {
          ...query,
          afterSeq,
          limit,
        };

        if (!rawRes || query.stream === "false") {
          return deps.events.list(parsedQuery);
        }

        rawRes.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const replay = deps.events.list(parsedQuery);
        for (const item of replay.items) {
          rawRes.write(`data: ${JSON.stringify(item)}\n\n`);
        }

        let closed = false;
        const keepalive = setInterval(() => {
          if (!closed) {
            rawRes.write(":keepalive\n\n");
          }
        }, SYSTEM_SSE_KEEPALIVE_MS);

        const unsubscribe = deps.events.subscribe((event) => {
          if (closed) return;
          if (afterSeq !== undefined && event.seq <= afterSeq) return;
          rawRes.write(`data: ${JSON.stringify(event)}\n\n`);
        });

        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(keepalive);
          unsubscribe();
        };

        rawRes.on("close", cleanup);
        return undefined as unknown as FridayListSystemEventsResponse;
      },
    },
    {
      operationId: "system.remote.devices.list",
      method: "GET",
      path: "/v1/system/remote/devices",
      auth: { public: true },
      async handler() {
        return deps.remote.list();
      },
    },
    {
      operationId: "system.remote.devices.register",
      method: "POST",
      path: "/v1/system/remote/devices/register",
      auth: { public: true },
      async handler(ctx) {
        const body = ctx.body as FridayRegisterSystemRemoteDeviceRequest;
        requireString(body, "label");
        requireString(body, "fingerprint");
        requireTrustedDevicePlatform(body, "platform");
        requireIdempotencyKey(body);
        return deps.remote.register(body);
      },
    },
    {
      operationId: "system.remote.devices.delete",
      method: "DELETE",
      path: "/v1/system/remote/devices/:deviceId",
      auth: { public: true },
      async handler(ctx) {
        const { deviceId } = ctx.params as { deviceId: string };
        return deps.remote.revoke(deviceId);
      },
    },
    {
      operationId: "system.remote.devices.passkey.delete",
      method: "DELETE",
      path: "/v1/system/remote/devices/:deviceId/passkey",
      auth: { public: true },
      async handler(ctx) {
        const { deviceId } = ctx.params as { deviceId: string };
        return deps.remote.clearPasskey(deviceId);
      },
    },
    {
      operationId: "system.remote.auth.register.options",
      method: "POST",
      path: "/v1/system/remote/auth/register/options",
      auth: { public: true },
      async handler(ctx) {
        const body = ctx.body as FridayBeginSystemRemotePasskeyRegistrationRequest;
        requireString(body, "deviceId");
        requireIdempotencyKey(body);
        return deps.remoteAuth.beginRegistration(body, {
          origin: readOrigin(ctx),
        });
      },
    },
    {
      operationId: "system.remote.auth.register.verify",
      method: "POST",
      path: "/v1/system/remote/auth/register/verify",
      // Pre-auth surface: WebAuthn registration verify completes a passkey
      // enrollment for a device that has no bearer yet. deps.remoteAuth
      // .verifyRegistration consumes the server-issued challengeId and verifies
      // the attestation/signature before persisting the credential. Bad/missing
      // challengeId or tampered response fails closed with no passkey persisted.
      // Negative test: test/unit/api/http/routes/friday-system-routes.test.ts
      // (verifyRegistration rejection does not persist a passkey).
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx) {
        const body = ctx.body as FridayVerifySystemRemotePasskeyRegistrationRequest;
        requireString(body, "deviceId");
        requireString(body, "challengeId");
        requireIdempotencyKey(body);
        return deps.remoteAuth.verifyRegistration(body, {
          origin: readOrigin(ctx),
        });
      },
    },
    {
      operationId: "system.remote.auth.assert.options",
      method: "POST",
      path: "/v1/system/remote/auth/assert/options",
      auth: { public: true },
      async handler(ctx) {
        const body = ctx.body as FridayBeginSystemRemotePasskeyAssertionRequest;
        requireString(body, "deviceId");
        requireIdempotencyKey(body);
        return deps.remoteAuth.beginAssertion(body, {
          origin: readOrigin(ctx),
        });
      },
    },
    {
      operationId: "system.remote.auth.assert.verify",
      method: "POST",
      path: "/v1/system/remote/auth/assert/verify",
      // Pre-auth surface: WebAuthn assertion verify is the device-login step
      // that exchanges a signed challenge for an assertionToken; the caller
      // has no bearer yet. deps.remoteAuth.verifyAssertion verifies the
      // signature against the server-issued challengeId before issuing a
      // token. Bad/forged response fails closed with no token minted.
      // Negative test: test/unit/api/http/routes/friday-system-routes.test.ts
      // (verifyAssertion rejection does not mint an assertion token).
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx) {
        const body = ctx.body as FridayVerifySystemRemotePasskeyAssertionRequest;
        requireString(body, "deviceId");
        requireString(body, "challengeId");
        requireIdempotencyKey(body);
        return deps.remoteAuth.verifyAssertion(body, {
          origin: readOrigin(ctx),
          ipAddress: readClientIp(ctx),
          userAgent: readUserAgent(ctx),
        });
      },
    },
    {
      operationId: "system.remote.sessions.list",
      method: "GET",
      path: "/v1/system/remote/sessions",
      auth: { public: true },
      async handler(ctx) {
        const query = ctx.query as FridayListSystemRemoteSessionsQuery;
        return deps.remote.listSessions({
          ...query,
          limit: parsePositiveInt(query.limit, "limit"),
        });
      },
    },
    {
      operationId: "system.remote.sessions.create",
      method: "POST",
      path: "/v1/system/remote/sessions",
      // Pre-auth surface: trades the one-time assertionToken from a prior
      // verifyAssertion step for a remote session; the caller has no bearer
      // yet. deps.remote.openSession verifies the assertionToken before
      // minting a session. Bad/missing token fails closed with no session.
      // Negative test: test/unit/api/http/routes/friday-system-routes.test.ts
      // (openSession rejection does not create a remote session).
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx) {
        const body = ctx.body as FridayCreateSystemRemoteSessionRequest;
        requireString(body, "deviceId");
        requireString(body, "assertionToken");
        requireIdempotencyKey(body);
        return deps.remote.openSession(body, {
          ipAddress: readClientIp(ctx),
          userAgent: readUserAgent(ctx),
        });
      },
    },
    {
      operationId: "system.remote.sessions.heartbeat",
      method: "POST",
      path: "/v1/system/remote/sessions/:sessionId/heartbeat",
      auth: { public: true },
      async handler(ctx) {
        const { sessionId } = ctx.params as { sessionId: string };
        const body = ctx.body as FridayHeartbeatSystemRemoteSessionRequest;
        requireIdempotencyKey(body);
        return deps.remote.heartbeatSession(sessionId, body, {
          ipAddress: readClientIp(ctx),
          userAgent: readUserAgent(ctx),
        });
      },
    },
    {
      operationId: "system.remote.sessions.delete",
      method: "DELETE",
      path: "/v1/system/remote/sessions/:sessionId",
      auth: { public: true },
      async handler(ctx) {
        const { sessionId } = ctx.params as { sessionId: string };
        return deps.remote.closeSession(sessionId);
      },
    },
  ];
}
