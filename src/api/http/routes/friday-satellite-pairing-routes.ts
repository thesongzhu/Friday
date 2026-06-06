/**
 * Satellite Pairing Routes — Registration, approval, handshake, and revocation.
 *
 * @module api/http/routes/friday-satellite-pairing-routes
 */

import { FridayDomainError } from "#errors";
import type { FridayHttpContext, FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import { assertBoundPrincipalForOperation } from "../../../security/friday-owner-session-channel-capability.js";

type Ctx = FridayHttpContext<unknown, Record<string, string>, unknown>;
type Route = FridayRouteDefinition<unknown, Record<string, string>, unknown, unknown>;

// ─── Deps ───

export interface FridaySatellitePairingRoutesDeps {
  registerSatellite: (input: {
    type: string;
    displayName: string;
    publicKey: string;
    runtime: {
      platform: string;
      arch: string;
      appVersion: string;
      nodeVersion: string;
    };
    transport: "ws" | "http-poll" | "mixed";
    requestedByIp?: string;
    requestedByUserAgent?: string;
  }) => Promise<{
    satelliteId: string;
    pairingStatus: string;
    pairingRequired: boolean;
    pairingRequestId: string;
    pairingCode: string;
    expiresAt: string;
    challengeNonce: string;
  }>;

  listPendingPairings: () => Promise<ReadonlyArray<{
    requestId: string;
    satelliteId: string;
    displayName: string;
    type: string;
    pairingCode: string;
    createdAt: string;
    expiresAt: string;
  }>>;

  approvePairing: (input: {
    satelliteId: string;
    requestId: string;
    resolverUserId: string;
    scopes?: string[];
    tokenTtlMs?: number;
  }) => Promise<{
    token: string;
    tokenId: string;
    expiresAt: string;
    configRevision: number;
    tokenVersion: number;
  }>;

  rejectPairing: (input: {
    satelliteId: string;
    requestId: string;
    resolverUserId: string;
    reason?: string;
  }) => Promise<{ rejectedAt: string }>;

  completeHandshake: (input: {
    satelliteId: string;
    token: string;
    signedChallenge: string;
    challengeNonce: string;
    clientEphemeralPublicKey: string;
    supportedAlgorithms?: string[];
  }) => Promise<{
    accepted: boolean;
    streamId: string;
    epoch: number;
    algorithm: string;
    serverEphemeralPublicKey: string;
  }>;

  revokeSatellite: (input: {
    satelliteId: string;
    resolverUserId: string;
    reason?: string;
  }) => Promise<{ revokedAt: string }>;

  getPairingRequest: (satelliteId: string) => Promise<{
    requestId: string;
    satelliteId: string;
    status: string;
    pairingCode: string;
    createdAt: string;
    expiresAt: string;
  } | null>;
  /**
   * Test-oracle only: allow the legacy TypeScript satellite pairing mutations
   * (register, approve, reject, handshake, revoke) in isolated mock/unit
   * validation. Production/runtime callers must leave this unset so the satellite
   * pairing engine stays fail-closed until Rust owns it. The read-only pairing
   * list/get surfaces are never gated.
   */
  allowTestOnlySatellitePairingExecution?: boolean;
}

// ─── Retirement helper ───
//
// The satellite pairing mutation surfaces (register, approve, reject, handshake,
// revoke) write hub pairing/token state inside withWriteTransaction (satellite
// registration + pairing requests, pairing status transitions, API token
// issuance/revocation, epoch bumps). They fail-close by default/live until Rust
// owns the satellite pairing entrypoint; legacy behavior is reachable only
// through the explicit allowTestOnlySatellitePairingExecution test-oracle flag.
// The GET pairing list/get surfaces are pure reads and are NOT gated.

function assertSatellitePairingTestOracleAllowed(deps: FridaySatellitePairingRoutesDeps): void {
  if (deps.allowTestOnlySatellitePairingExecution !== true) {
    throw new FridayDomainError(
      "TS_RUNTIME_SATELLITE_PAIRING_RETIRED",
      "TypeScript satellite pairing mutation is fail-closed in default/live runtime; use the Rust-owned satellite pairing entrypoint.",
      {
        httpStatus: 503,
        details: {
          classification: "fail_closed",
          replacement: "rust_owned_satellite_pairing_entrypoint_required",
        },
      },
    );
  }
}

// ─── Factory ───

export function createFridaySatellitePairingRoutes(
  deps: FridaySatellitePairingRoutesDeps,
): Route[] {
  return [
    // ─── Registration (public) ───
    {
      operationId: "satellites.register",
      method: "POST",
      path: "/v1/satellites/register",
      auth: { public: true },
      rateLimitPolicyId: "satellite.register",
      async handler(ctx: Ctx) {
        const body = ctx.body as Record<string, unknown>;
        const type = body.type as string | undefined;
        const displayName = body.displayName as string | undefined;
        const publicKey = body.publicKey as string | undefined;

        if (!type || !displayName || !publicKey) {
          return {
            error: { code: "VALIDATION_FAILED", message: "type, displayName, publicKey are required" },
          };
        }

        assertSatellitePairingTestOracleAllowed(deps);

        const rawRuntime = body.runtime as Record<string, unknown> | undefined;
        const runtime = {
          platform: typeof rawRuntime?.platform === "string" ? rawRuntime.platform : "unknown",
          arch: typeof rawRuntime?.arch === "string" ? rawRuntime.arch : "unknown",
          appVersion: typeof rawRuntime?.appVersion === "string" ? rawRuntime.appVersion : "unknown",
          nodeVersion: typeof rawRuntime?.nodeVersion === "string" ? rawRuntime.nodeVersion : "unknown",
        };
        const rawTransport = body.transport as string | undefined;
        const transport: "ws" | "http-poll" | "mixed" = rawTransport === "http-poll" || rawTransport === "mixed"
          ? rawTransport
          : "ws";

        const result = await deps.registerSatellite({
          type,
          displayName,
          publicKey,
          runtime,
          transport,
          requestedByIp: ctx.ip,
          requestedByUserAgent: ctx.userAgent,
        });

        return result;
      },
    },

    // ─── List Pending ───
    {
      operationId: "satellites.pairing.list",
      method: "GET",
      path: "/v1/satellites/pairing",
      auth: { public: true },
      async handler() {
        return deps.listPendingPairings();
      },
    },

    // ─── Get Pairing Status ───
    {
      operationId: "satellites.pairing.get",
      method: "GET",
      path: "/v1/satellites/:satelliteId/pairing",
      auth: { public: true },
      async handler(ctx: Ctx) {
        const params = ctx.params as Record<string, string>;
        const request = await deps.getPairingRequest(params.satelliteId);
        if (!request) {
          throw new FridayDomainError("NOT_FOUND", "No pairing request found", { httpStatus: 404 });
        }
        return request;
      },
    },

    // ─── Approve ───
    {
      operationId: "satellites.pairing.approve",
      method: "POST",
      path: "/v1/satellites/:satelliteId/pairing/approve",
      auth: { public: true },
      async handler(ctx: Ctx) {
        const params = ctx.params as Record<string, string>;
        const body = ctx.body as Record<string, unknown>;
        const resolver = assertBoundPrincipalForOperation(
          ctx.principal,
          "satellite.pairing.approve",
          "api",
        );
        assertSatellitePairingTestOracleAllowed(deps);
        const pairingReq = await deps.getPairingRequest(params.satelliteId);
        if (!pairingReq) {
          throw new FridayDomainError("NOT_FOUND", "No pending pairing request", { httpStatus: 404 });
        }

        const result = await deps.approvePairing({
          satelliteId: params.satelliteId,
          requestId: pairingReq.requestId,
          resolverUserId: resolver.principalId,
          scopes: body.scopes as string[] | undefined,
          tokenTtlMs: body.tokenTtlMs as number | undefined,
        });

        return result;
      },
    },

    // ─── Reject ───
    {
      operationId: "satellites.pairing.reject",
      method: "POST",
      path: "/v1/satellites/:satelliteId/pairing/reject",
      auth: { public: true },
      async handler(ctx: Ctx) {
        const params = ctx.params as Record<string, string>;
        const body = ctx.body as Record<string, unknown>;
        const resolver = assertBoundPrincipalForOperation(
          ctx.principal,
          "satellite.pairing.reject",
          "api",
        );
        assertSatellitePairingTestOracleAllowed(deps);
        const pairingReq = await deps.getPairingRequest(params.satelliteId);
        if (!pairingReq) {
          throw new FridayDomainError("NOT_FOUND", "No pending pairing request", { httpStatus: 404 });
        }

        const result = await deps.rejectPairing({
          satelliteId: params.satelliteId,
          requestId: pairingReq.requestId,
          resolverUserId: resolver.principalId,
          reason: body.reason as string | undefined,
        });

        return { rejectedAt: result.rejectedAt };
      },
    },

    // ─── Handshake (public — token-based auth) ───
    // B0 Slice A5 carve-out: handshake authenticates via the body's
    // `token + signedChallenge + challengeNonce + clientEphemeralPublicKey`,
    // verified by `deps.completeHandshake` before any persistent stream/epoch is
    // returned. Negative test: see test/unit/api/routes/friday-satellite-pairing-routes.test.ts
    // "B0 Slice A5: synthetic default-public principal cannot bypass handshake verifier".
    {
      operationId: "satellites.handshake",
      method: "POST",
      path: "/v1/satellites/:satelliteId/handshake",
      auth: { public: true, allowUnauthenticatedMutation: true },
      rateLimitPolicyId: "satellite.handshake",
      async handler(ctx: Ctx) {
        const params = ctx.params as Record<string, string>;
        const body = ctx.body as Record<string, unknown>;
        const token = body.token as string | undefined;
        const signedChallenge = body.signedChallenge as string | undefined;
        const challengeNonce = body.challengeNonce as string | undefined;
        const clientEphemeralPublicKey = body.clientEphemeralPublicKey as string | undefined;

        if (!token || !signedChallenge || !challengeNonce || !clientEphemeralPublicKey) {
          return {
            error: { code: "VALIDATION_FAILED", message: "token, signedChallenge, challengeNonce, clientEphemeralPublicKey are required" },
          };
        }

        assertSatellitePairingTestOracleAllowed(deps);

        const result = await deps.completeHandshake({
          satelliteId: params.satelliteId,
          token,
          signedChallenge,
          challengeNonce,
          clientEphemeralPublicKey,
          supportedAlgorithms: body.supportedAlgorithms as string[] | undefined,
        });

        return result;
      },
    },

    // ─── Revoke ───
    {
      operationId: "satellites.revoke",
      method: "POST",
      path: "/v1/satellites/:satelliteId/revoke",
      auth: { public: true },
      async handler(ctx: Ctx) {
        const params = ctx.params as Record<string, string>;
        const body = ctx.body as Record<string, unknown>;
        const resolver = assertBoundPrincipalForOperation(
          ctx.principal,
          "satellite.revoke",
          "api",
        );

        assertSatellitePairingTestOracleAllowed(deps);

        const result = await deps.revokeSatellite({
          satelliteId: params.satelliteId,
          resolverUserId: resolver.principalId,
          reason: body.reason as string | undefined,
        });

        return { revokedAt: result.revokedAt };
      },
    },
  ];
}
