/**
 * Satellite Pairing Routes — Registration, approval, handshake, and revocation.
 *
 * @module api/http/routes/friday-satellite-pairing-routes
 */

import { FridayDomainError } from "#errors";
import type { FridayHttpContext, FridayRouteDefinition } from "../../model/friday-api-common.types.js";

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
      auth: { public: false, anyOfScopes: ["satellite.read"] },
      async handler() {
        return deps.listPendingPairings();
      },
    },

    // ─── Get Pairing Status ───
    {
      operationId: "satellites.pairing.get",
      method: "GET",
      path: "/v1/satellites/:satelliteId/pairing",
      auth: { public: false, anyOfScopes: ["satellite.read"] },
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
      auth: { public: false, anyOfScopes: ["satellite.write"] },
      async handler(ctx: Ctx) {
        const params = ctx.params as Record<string, string>;
        const body = ctx.body as Record<string, unknown>;
        const pairingReq = await deps.getPairingRequest(params.satelliteId);
        if (!pairingReq) {
          throw new FridayDomainError("NOT_FOUND", "No pending pairing request", { httpStatus: 404 });
        }

        const result = await deps.approvePairing({
          satelliteId: params.satelliteId,
          requestId: pairingReq.requestId,
          resolverUserId: ctx.principal?.principalId ?? "system",
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
      auth: { public: false, anyOfScopes: ["satellite.write"] },
      async handler(ctx: Ctx) {
        const params = ctx.params as Record<string, string>;
        const body = ctx.body as Record<string, unknown>;
        const pairingReq = await deps.getPairingRequest(params.satelliteId);
        if (!pairingReq) {
          throw new FridayDomainError("NOT_FOUND", "No pending pairing request", { httpStatus: 404 });
        }

        const result = await deps.rejectPairing({
          satelliteId: params.satelliteId,
          requestId: pairingReq.requestId,
          resolverUserId: ctx.principal?.principalId ?? "system",
          reason: body.reason as string | undefined,
        });

        return { rejectedAt: result.rejectedAt };
      },
    },

    // ─── Handshake (public — token-based auth) ───
    {
      operationId: "satellites.handshake",
      method: "POST",
      path: "/v1/satellites/:satelliteId/handshake",
      auth: { public: true },
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
      auth: { public: false, anyOfScopes: ["security.write"] },
      async handler(ctx: Ctx) {
        const params = ctx.params as Record<string, string>;
        const body = ctx.body as Record<string, unknown>;

        const result = await deps.revokeSatellite({
          satelliteId: params.satelliteId,
          resolverUserId: ctx.principal?.principalId ?? "system",
          reason: body.reason as string | undefined,
        });

        return { revokedAt: result.revokedAt };
      },
    },
  ];
}
