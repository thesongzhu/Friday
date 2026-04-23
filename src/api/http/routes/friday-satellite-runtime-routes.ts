import { FridayDomainError } from "#errors";
import type { FridayRealtimeEventEnvelope } from "../../model/friday-api-realtime.types.js";
import type { FridayHttpContext, FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridaySatelliteCapabilityReport,
  FridaySatelliteHeartbeatInput,
  FridaySyncPullInput,
  FridaySyncPullResult,
  FridaySyncPushInput,
  FridaySyncPushResult,
} from "#satellites";

type Awaitable<T> = T | Promise<T>;
type Ctx = FridayHttpContext<unknown, Record<string, string>, unknown>;

export interface FridaySatelliteRuntimeRoutesDeps {
  recordHeartbeat: (input: FridaySatelliteHeartbeatInput) => Awaitable<{
    accepted: true;
    now: string;
    expectedIntervalMs: number;
    status: string;
  }>;
  updateCapabilities: (report: FridaySatelliteCapabilityReport) => Awaitable<{
    accepted: boolean;
    reason?: string;
  }>;
  pullSync: (input: FridaySyncPullInput) => Awaitable<FridaySyncPullResult>;
  pushSync: (input: FridaySyncPushInput) => Awaitable<FridaySyncPushResult>;
  pollCommands: (input: {
    satelliteId: string;
    limit?: number;
    leaseMs?: number;
  }) => Awaitable<Array<{
    id: string;
    seq: number;
    messageType: string;
    payload: unknown;
  }>>;
  ackCommand: (input: {
    satelliteId: string;
    commandId: string;
  }) => Awaitable<{ acked: boolean }>;
  reportCommandResult?: (input: {
    satelliteId: string;
    commandId: string;
    runId: string;
    nodeId: string;
    attemptId: string;
    attempt: number;
    status: "completed" | "failed";
    output?: unknown;
    error?: {
      code: string;
      message: string;
      retryable: boolean;
      details?: unknown;
    };
  }) => Awaitable<void>;
  pullEvents: (input: {
    streamId: string;
    afterSeq: number;
    limit: number;
  }) => Awaitable<FridayRealtimeEventEnvelope[]>;
  getCheckpoint: (input: {
    principalId: string;
    streamId: string;
  }) => Awaitable<{ lastAckedSeq: number; epoch: number; cursor?: string } | null>;
}

const MAX_POLL_LIMIT = 100;
const DEFAULT_COMMAND_LIMIT = 25;
const DEFAULT_COMMAND_LEASE_MS = 60_000;
const DEFAULT_EVENT_LIMIT = 50;

function requireSatellitePrincipal(ctx: Ctx, satelliteId: string): void {
  const principal = ctx.principal;
  if (!principal) {
    throw new FridayDomainError("UNAUTHORIZED", "Authentication required", { httpStatus: 401 });
  }
  if (principal.principalType === "satellite" && principal.principalId !== satelliteId) {
    throw new FridayDomainError(
      "SATELLITE_PRINCIPAL_MISMATCH",
      "Satellite token does not match the requested satellite",
      { httpStatus: 403 },
    );
  }
}

function requirePositiveInteger(
  value: unknown,
  field: string,
  fallback?: number,
): number {
  if (value === undefined || value === null || value === "") {
    if (fallback === undefined) {
      throw new FridayDomainError("VALIDATION_ERROR", `${field} is required`, { httpStatus: 400 });
    }
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `${field} must be a non-negative integer`, {
      httpStatus: 400,
    });
  }
  return parsed;
}

function decodePayloadCiphertext(raw: string): unknown {
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(decoded) as unknown;
  } catch (err) {
    console.warn("[friday][satellite-runtime-routes] operation failed:", err instanceof Error ? err.message : String(err));
    return { raw };
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `${field} is required`, { httpStatus: 400 });
  }
  return value;
}

function parseCapabilities(
  body: Record<string, unknown>,
): FridaySatelliteCapabilityReport["capabilities"] {
  const raw = body.capabilities;
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new FridayDomainError("VALIDATION_ERROR", "capabilities must be an array when provided", {
      httpStatus: 400,
    });
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `capabilities[${String(index)}] must be an object`,
        { httpStatus: 400 },
      );
    }
    const record = entry as Record<string, unknown>;
    const key = typeof record.key === "string" ? record.key.trim() : "";
    if (key.length === 0) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `capabilities[${String(index)}].key is required`,
        { httpStatus: 400 },
      );
    }
    if (typeof record.available !== "boolean") {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `capabilities[${String(index)}].available must be a boolean`,
        { httpStatus: 400 },
      );
    }
    const metadata = record.metadata;
    if (
      metadata !== undefined
      && (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))
    ) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `capabilities[${String(index)}].metadata must be an object when provided`,
        { httpStatus: 400 },
      );
    }
    const limits = record.limits;
    if (
      limits !== undefined
      && (limits === null || typeof limits !== "object" || Array.isArray(limits))
    ) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `capabilities[${String(index)}].limits must be an object when provided`,
        { httpStatus: 400 },
      );
    }
    return {
      key,
      available: record.available,
      metadata: metadata as Record<string, unknown> | undefined,
      limits: limits as FridaySatelliteCapabilityReport["capabilities"][number]["limits"] | undefined,
    };
  });
}

export function createFridaySatelliteRuntimeRoutes(
  deps: FridaySatelliteRuntimeRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "satellites.heartbeat",
      method: "POST",
      path: "/v1/satellites/:satelliteId/heartbeat",
      auth: { public: false, anyOfScopes: ["satellite.write"] },
      async handler(ctx) {
        const params = ctx.params as Record<string, string>;
        requireSatellitePrincipal(ctx as Ctx, params.satelliteId);
        const body = ctx.body as Record<string, unknown>;
        return deps.recordHeartbeat({
          satelliteId: params.satelliteId,
          ts: requireString(body, "ts"),
          metrics: body.metrics as FridaySatelliteHeartbeatInput["metrics"],
          queueDepth: typeof body.queueDepth === "number" ? body.queueDepth : undefined,
          activeRuns: typeof body.activeRuns === "number" ? body.activeRuns : undefined,
          lastSuccessfulCommandAt: body.lastSuccessfulCommandAt as string | undefined,
          failureRate1m: typeof body.failureRate1m === "number" ? body.failureRate1m : undefined,
          explicitDisconnect: typeof body.explicitDisconnect === "boolean" ? body.explicitDisconnect : undefined,
          details: body.details as Record<string, unknown> | undefined,
        });
      },
    },
    {
      operationId: "satellites.capabilities.update",
      method: "POST",
      path: "/v1/satellites/:satelliteId/capabilities",
      auth: { public: false, anyOfScopes: ["satellite.write"] },
      async handler(ctx) {
        const params = ctx.params as Record<string, string>;
        requireSatellitePrincipal(ctx as Ctx, params.satelliteId);
        const body = ctx.body as Record<string, unknown>;
        return deps.updateCapabilities({
          satelliteId: params.satelliteId,
          revision: requirePositiveInteger(body.revision, "revision"),
          generatedAt: requireString(body, "generatedAt"),
          runtime: body.runtime as FridaySatelliteCapabilityReport["runtime"],
          capabilities: parseCapabilities(body),
        });
      },
    },
    {
      operationId: "satellites.sync.pull",
      method: "POST",
      path: "/v1/satellites/:satelliteId/sync/pull",
      auth: { public: false, anyOfScopes: ["satellite.write"] },
      async handler(ctx) {
        const params = ctx.params as Record<string, string>;
        requireSatellitePrincipal(ctx as Ctx, params.satelliteId);
        const body = ctx.body as Record<string, unknown>;
        return deps.pullSync({
          satelliteId: params.satelliteId,
          streamId: requireString(body, "streamId"),
          lastAckedSeq: requirePositiveInteger(body.lastAckedSeq, "lastAckedSeq", 0),
          subscriptions: Array.isArray(body.subscriptions)
            ? body.subscriptions.filter((entry): entry is string => typeof entry === "string")
            : [],
          resumeCursor: body.resumeCursor as string | undefined,
        });
      },
    },
    {
      operationId: "satellites.sync.push",
      method: "POST",
      path: "/v1/satellites/:satelliteId/sync/push",
      auth: { public: false, anyOfScopes: ["satellite.write"] },
      async handler(ctx) {
        const params = ctx.params as Record<string, string>;
        requireSatellitePrincipal(ctx as Ctx, params.satelliteId);
        const body = ctx.body as Record<string, unknown>;
        return deps.pushSync({
          satelliteId: params.satelliteId,
          acks: Array.isArray(body.acks)
            ? body.acks as FridaySyncPushInput["acks"]
            : [],
          localEvents: Array.isArray(body.localEvents)
            ? body.localEvents as FridaySyncPushInput["localEvents"]
            : undefined,
          nodeResults: Array.isArray(body.nodeResults)
            ? body.nodeResults as FridaySyncPushInput["nodeResults"]
            : undefined,
        });
      },
    },
    {
      operationId: "satellites.commands.poll",
      method: "POST",
      path: "/v1/satellites/:satelliteId/commands/poll",
      auth: { public: false, anyOfScopes: ["satellite.write"] },
      async handler(ctx) {
        const params = ctx.params as Record<string, string>;
        requireSatellitePrincipal(ctx as Ctx, params.satelliteId);
        const body = ctx.body as Record<string, unknown>;
        const limit = Math.min(
          requirePositiveInteger(body.limit, "limit", DEFAULT_COMMAND_LIMIT),
          MAX_POLL_LIMIT,
        );
        const leaseMs = Math.max(
          5_000,
          requirePositiveInteger(body.leaseMs, "leaseMs", DEFAULT_COMMAND_LEASE_MS),
        );
        const commands = await deps.pollCommands({
          satelliteId: params.satelliteId,
          limit,
          leaseMs,
        });
        return {
          commands: commands.map((command) => ({
            ...command,
            payload: typeof command.payload === "string"
              ? decodePayloadCiphertext(command.payload)
              : command.payload,
          })),
        };
      },
    },
    {
      operationId: "satellites.commands.ack",
      method: "POST",
      path: "/v1/satellites/:satelliteId/commands/:commandId/ack",
      auth: { public: false, anyOfScopes: ["satellite.write"] },
      async handler(ctx) {
        const params = ctx.params as Record<string, string>;
        requireSatellitePrincipal(ctx as Ctx, params.satelliteId);
        const body = ctx.body as Record<string, unknown>;
        const status = requireString(body, "status");
        const hasTerminalResult = status === "completed" || status === "failed";

        if (deps.reportCommandResult && hasTerminalResult) {
          await deps.reportCommandResult({
            satelliteId: params.satelliteId,
            commandId: params.commandId,
            runId: requireString(body, "runId"),
            nodeId: requireString(body, "nodeId"),
            attemptId: requireString(body, "attemptId"),
            attempt: requirePositiveInteger(body.attempt, "attempt"),
            status: status as "completed" | "failed",
            output: body.output,
            error: status === "failed"
              ? {
                code: typeof body.error === "object" && body.error && typeof (body.error as Record<string, unknown>).code === "string"
                  ? (body.error as Record<string, unknown>).code as string
                  : "SATELLITE_COMMAND_FAILED",
                message: typeof body.error === "object" && body.error && typeof (body.error as Record<string, unknown>).message === "string"
                  ? (body.error as Record<string, unknown>).message as string
                  : "Satellite command execution failed",
                retryable: typeof body.error === "object" && body.error && typeof (body.error as Record<string, unknown>).retryable === "boolean"
                  ? (body.error as Record<string, unknown>).retryable as boolean
                  : true,
                details: typeof body.error === "object" && body.error
                  ? (body.error as Record<string, unknown>).details
                  : undefined,
              }
              : undefined,
          });
        }

        const ackResult = await deps.ackCommand({
          satelliteId: params.satelliteId,
          commandId: params.commandId,
        });
        if (!ackResult.acked && !hasTerminalResult) {
          throw new FridayDomainError("SATELLITE_COMMAND_NOT_LEASED", "Command is not leased to this satellite", {
            httpStatus: 409,
          });
        }

        return {
          acked: ackResult.acked,
          resultAccepted: hasTerminalResult,
        };
      },
    },
    {
      operationId: "satellites.events.poll",
      method: "POST",
      path: "/v1/satellites/:satelliteId/events/poll",
      auth: { public: false, anyOfScopes: ["satellite.write"] },
      async handler(ctx) {
        const params = ctx.params as Record<string, string>;
        requireSatellitePrincipal(ctx as Ctx, params.satelliteId);
        const body = ctx.body as Record<string, unknown>;
        const streamId = requireString(body, "streamId");
        const afterSeq = requirePositiveInteger(body.afterSeq, "afterSeq", 0);
        const limit = Math.min(
          requirePositiveInteger(body.limit, "limit", DEFAULT_EVENT_LIMIT),
          MAX_POLL_LIMIT,
        );
        const checkpoint = await deps.getCheckpoint({
          principalId: params.satelliteId,
          streamId,
        });
        const events = await deps.pullEvents({
          streamId,
          afterSeq,
          limit,
        });
        return {
          streamId,
          checkpoint,
          events,
        };
      },
    },
  ];
}
