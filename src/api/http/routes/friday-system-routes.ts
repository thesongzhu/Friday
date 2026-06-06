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
  /**
   * Test-oracle only: allow the legacy TypeScript system-intent execution in
   * isolated mock/unit validation. Production/runtime callers must leave this
   * unset so POST /v1/system/intents stays fail-closed until Rust owns it.
   */
  allowTestOnlySystemIntentExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript system approval-rule mutation
   * in isolated validation. Production/runtime callers must leave this unset so
   * PATCH /v1/system/approvals/:id stays fail-closed until Rust owns it.
   */
  allowTestOnlySystemApprovalExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript remote device/session/WebAuthn
   * mutations (register/revoke/passkey, register/assert options+verify, session
   * open/heartbeat/close) in isolated validation. Production/runtime callers must
   * leave this unset so the remote-access engine stays fail-closed until Rust
   * owns it.
   */
  allowTestOnlySystemRemoteExecution?: boolean;
}

// ─── Retirement helpers ───
//
// The system intent execution, approval-rule mutation, and remote
// device/session/WebAuthn surfaces run TypeScript product logic or write
// system state (control leases, approval rules, remote device/session/challenge
// records). They fail-close by default/live until Rust owns the corresponding
// entrypoints; legacy behavior is reachable only through the explicit
// per-engine test-oracle flags above.

function throwRetiredSystem(
  code: string,
  label: string,
  replacement: string,
): never {
  throw new FridayDomainError(
    code,
    `${label} is fail-closed in default/live runtime; use the Rust-owned ${replacement} entrypoint.`,
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: `rust_owned_${replacement}_entrypoint_required`,
      },
    },
  );
}

function assertSystemIntentTestOracleAllowed(deps: FridaySystemRoutesDeps): void {
  if (deps.allowTestOnlySystemIntentExecution !== true) {
    throwRetiredSystem(
      "TS_RUNTIME_SYSTEM_INTENT_RETIRED",
      "TypeScript system intent execution",
      "system_intent_execution",
    );
  }
}

function assertSystemApprovalTestOracleAllowed(deps: FridaySystemRoutesDeps): void {
  if (deps.allowTestOnlySystemApprovalExecution !== true) {
    throwRetiredSystem(
      "TS_RUNTIME_SYSTEM_APPROVAL_RETIRED",
      "TypeScript system approval-rule mutation",
      "system_approval_rule",
    );
  }
}

function assertSystemRemoteTestOracleAllowed(deps: FridaySystemRoutesDeps): void {
  if (deps.allowTestOnlySystemRemoteExecution !== true) {
    throwRetiredSystem(
      "TS_RUNTIME_SYSTEM_REMOTE_RETIRED",
      "TypeScript system remote device/session/WebAuthn execution",
      "system_remote_access",
    );
  }
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
        assertSystemIntentTestOracleAllowed(deps);
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
        assertSystemApprovalTestOracleAllowed(deps);
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
        assertSystemRemoteTestOracleAllowed(deps);
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
        assertSystemRemoteTestOracleAllowed(deps);
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
        assertSystemRemoteTestOracleAllowed(deps);
        return deps.remote.clearPasskey(deviceId);
      },
    },
    {
      operationId: "system.remote.auth.register.options",
      method: "POST",
      path: "/v1/system/remote/auth/register/options",
      // B0 Slice A4 carve-out: WebAuthn registration challenge issuance is
      // pre-auth by protocol design — the device has no bearer yet. The challenge
      // itself is the trust handle for the downstream .register.verify step
      // (already carved out in Slice A): server-issued challengeId, device-bound
      // via the supplied deviceId, single-use (consumed in .verify), time-limited
      // via challengeTtlMs. No persistent credential or session is granted by
      // this endpoint. Negative test:
      // test/unit/api/http/routes/friday-system-routes.test.ts
      // ("A4 register.options: missing deviceId rejects before challenge issued").
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx) {
        const body = ctx.body as FridayBeginSystemRemotePasskeyRegistrationRequest;
        requireString(body, "deviceId");
        requireIdempotencyKey(body);
        assertSystemRemoteTestOracleAllowed(deps);
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
        assertSystemRemoteTestOracleAllowed(deps);
        return deps.remoteAuth.verifyRegistration(body, {
          origin: readOrigin(ctx),
        });
      },
    },
    {
      operationId: "system.remote.auth.assert.options",
      method: "POST",
      path: "/v1/system/remote/auth/assert/options",
      // B0 Slice A4 carve-out: WebAuthn assertion challenge issuance is pre-auth
      // by protocol design — same rationale as register.options. Single-use,
      // server-bound, device-bound, time-limited challenge consumed by the
      // already-carved-out .assert.verify route. Negative test:
      // test/unit/api/http/routes/friday-system-routes.test.ts
      // ("A4 assert.options: missing deviceId rejects before challenge issued").
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx) {
        const body = ctx.body as FridayBeginSystemRemotePasskeyAssertionRequest;
        requireString(body, "deviceId");
        requireIdempotencyKey(body);
        assertSystemRemoteTestOracleAllowed(deps);
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
        assertSystemRemoteTestOracleAllowed(deps);
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
        assertSystemRemoteTestOracleAllowed(deps);
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
      // B0 Slice A4 carve-out: the remote-session id minted by the carved-out
      // `sessions.create` (which itself verifies the one-time assertionToken from
      // a prior verifyAssertion step) is the trust handle here. The sessionId is
      // a high-entropy server-issued UUIDv4, bound to a specific device row, and
      // its lifecycle is owned by the server. Trust is verified by
      // `deps.remote.heartbeatSession` → `systemService.touchRemoteSession`
      // (`src/system/engine/friday-system-service.ts:1746-1794`): on unknown
      // sessionId the lookup returns null before any write; on an inactive
      // session the existing row is returned without touch; on a revoked device
      // the session is auto-closed instead of touched. Negative test:
      // test/unit/api/http/routes/friday-system-routes.test.ts
      // ("A4 sessions.heartbeat: unknown sessionId is verified by deps.remote
      //  and does not mutate state").
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx) {
        const { sessionId } = ctx.params as { sessionId: string };
        const body = ctx.body as FridayHeartbeatSystemRemoteSessionRequest;
        requireIdempotencyKey(body);
        assertSystemRemoteTestOracleAllowed(deps);
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
      // B0 Slice A4 carve-out: same sessionId-bearer rationale as
      // sessions.heartbeat above. `deps.remote.closeSession` ultimately calls
      // `repository.closeRemoteSession(db, id, ...)` which targets the row by id
      // — an unknown id affects zero rows. The handler returns
      // `{ closed: <bool>, sessionId }` truthfully reflecting whether a row was
      // closed; no other session state is mutated. Negative test:
      // test/unit/api/http/routes/friday-system-routes.test.ts
      // ("A4 sessions.delete: unknown sessionId yields closed=false without
      //  side effect on other sessions").
      auth: { public: true, allowUnauthenticatedMutation: true },
      async handler(ctx) {
        const { sessionId } = ctx.params as { sessionId: string };
        assertSystemRemoteTestOracleAllowed(deps);
        return deps.remote.closeSession(sessionId);
      },
    },
  ];
}
