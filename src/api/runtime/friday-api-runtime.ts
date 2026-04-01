import { FridayDomainError } from "#errors";
import { createFridayMemoryGuardServiceFactory } from "#memory";
import { createFridaySecretAdminService } from "#providers";
import {
  createFridaySessionMemoryExtractionService,
  createFridaySessionService,
  finalizeFridayConversationFocus,
  prepareFridayConversationTurn,
} from "#sessions";
import type { FridayConversationBlock, FridaySessionMessageRecord } from "#sessions";
import {
  createFridayStableWorkflowDraftBundle,
  createFridayWorkflowBuilderRuntime,
  createFridayWorkflowProductService,
  createFridayWorkflowRuntime,
  createFridayWorkflowTriggerRepository,
  listFridayStableWorkflowTemplates,
} from "#workflows";
import type { JsonObject } from "#workflows";

import { classifyFridayExecution } from "../../sessions/services/friday-execution-classifier.js";
import { dispatchDeterministic } from "../../sessions/services/friday-deterministic-dispatch.js";
import type { FridayDeterministicDispatchDeps } from "../../sessions/services/friday-deterministic-dispatch.js";
import { dispatchManagedAsync } from "../../sessions/services/friday-managed-async-dispatch.js";
import type { FridayManagedAsyncDispatchDeps } from "../../sessions/services/friday-managed-async-dispatch.js";
import type { CreateFridayApiRuntimeDeps, FridayApiRuntime } from "./friday-api-runtime.types.js";
import { createFridayAuthService } from "../auth/friday-auth-service.js";
import { createFridayTokenValidator } from "../auth/friday-token-validator.js";
import { createFridayRateLimitService } from "../auth/friday-rate-limit-service.js";
import { createFridayAuthMiddlewareFactory } from "../auth/friday-auth-middleware.js";
import { createFridayRealtimeEventBus } from "../realtime/friday-realtime-event-bus.js";
import { createFridayRealtimeEventRepository } from "../persistence/friday-realtime-event-repository.js";
import { createFridayRealtimeCheckpointRepository } from "../persistence/friday-realtime-checkpoint-repository.js";
import { createFridayRealtimeSubscriptionService } from "../realtime/friday-realtime-subscription-service.js";
import { createFridayRealtimeWsGateway } from "../realtime/friday-realtime-ws-gateway.js";
import { createFridayFleetDashboardService } from "../fleet/friday-fleet-dashboard-service.js";
import { createFridayWorkflowConflictService } from "../conflicts/friday-workflow-conflict-service.js";
import { createFridayHttpRouteRegistry } from "../http/friday-http-route-registry.js";
import { createFridayAuthRoutes } from "../http/routes/friday-auth-routes.js";
import { createFridayRuntimeAdminRoutes } from "../http/routes/friday-runtime-admin-routes.js";
import { createFridaySecretRoutes } from "../http/routes/friday-secret-routes.js";
import { createFridayWorkflowRoutes } from "../http/routes/friday-workflow-routes.js";
import {
  createFridayWorkflowBuilderRoutes,
  createFridayWorkflowBuilderTemplateRoutes,
} from "../http/routes/friday-workflow-builder-routes.js";
import { createFridayWorkflowProductRoutes } from "../http/routes/friday-workflow-product-routes.js";
import { createFridayWorkflowRunRoutes } from "../http/routes/friday-workflow-run-routes.js";
import { createFridayWorkflowConflictRoutes } from "../http/routes/friday-workflow-conflict-routes.js";
import { createFridayFleetRoutes } from "../http/routes/friday-fleet-routes.js";
import { createFridaySecurityRoutes } from "../http/routes/friday-security-routes.js";
import { createFridayRealtimeRoutes } from "../http/routes/friday-realtime-routes.js";
import { createFridayProviderRoutes } from "../http/routes/friday-provider-routes.js";
import { createFridayProviderUsageRoutes } from "../http/routes/friday-provider-usage-routes.js";
import { createFridaySkillGeneratorRoutes } from "../http/routes/friday-skill-generator-routes.js";
import { createFridayDiagnosisRoutes } from "../http/routes/friday-diagnosis-routes.js";
import { createFridayAutoFixRoutes } from "../http/routes/friday-auto-fix-routes.js";
import { createFridayAgentLoopRoutes } from "../http/routes/friday-agent-loop-routes.js";
import { createFridaySkillConverterRoutes } from "../http/routes/friday-skill-converter-routes.js";
import { createFridayWorkflowGeneratorRoutes } from "../http/routes/friday-workflow-generator-routes.js";
import { createFridayDeterministicPipelineRoutes } from "../http/routes/friday-deterministic-pipeline-routes.js";
import { createFridayMemoryRoutes } from "../http/routes/friday-memory-routes.js";
import { createFridaySessionRoutes } from "../http/routes/friday-session-routes.js";
import { createFridaySessionUsageRoutes } from "../http/routes/friday-session-usage-routes.js";
import { createFridayPluginRoutes } from "../http/routes/friday-plugin-routes.js";
import { createFridayAgentRoutes } from "../http/routes/friday-agent-routes.js";
import { createFridaySubagentRoutes } from "../http/routes/friday-subagent-routes.js";
import { createFridaySetupRoutes } from "../http/routes/friday-setup-routes.js";
import { createFridaySkillRoutes } from "../http/routes/friday-skill-routes.js";
import { createFridayDesktopRoutes } from "../http/routes/friday-desktop-routes.js";
import { createFridaySystemRoutes } from "../http/routes/friday-system-routes.js";
import { createFridayUixRoutes } from "../http/routes/friday-uix-routes.js";
import { createFridayDiscoveryRoutes } from "../http/routes/friday-discovery-routes.js";
import { createFridayMcpServerRoutes } from "../http/routes/friday-mcp-server-routes.js";
import { createFridayMarketplaceCommerceRoutes } from "../http/routes/friday-marketplace-commerce-routes.js";
import { createFridayMarketplaceAssetRoutes } from "../http/routes/friday-marketplace-asset-routes.js";
import { createFridayMarketplaceCreatorRoutes } from "../http/routes/friday-marketplace-creator-routes.js";
import { createFridayMarketplaceRequestRoutes } from "../http/routes/friday-marketplace-request-routes.js";
import { createFridaySkillMarketplaceRoutes } from "../http/routes/friday-skill-marketplace-routes.js";
import { createFridayMultiTenantSecurityRoutes } from "../http/routes/friday-multi-tenant-security-routes.js";
import { createFridayObservabilityRoutes } from "../http/routes/friday-observability-routes.js";
import { createFridaySatellitePairingRoutes } from "../http/routes/friday-satellite-pairing-routes.js";
import { createFridaySatelliteRuntimeRoutes } from "../http/routes/friday-satellite-runtime-routes.js";
import { createFridayChannelWebhookRoutes } from "../http/routes/friday-channel-webhook-routes.js";
import {
  createFridayAgentAutomationRepository,
  createFridayAgentAutomationService,
  createFridayAgentPlanningGateService,
  createFridayAgentRunEventRepository,
  createFridayAgentRunRepository,
} from "#agent";
import type {
  FridayAgentAutomationService,
  FridayAgentExecutionContext,
  FridayAgentMessage,
  FridayAgentRunStatus,
  FridayAgentTaskProfileInput,
} from "#agent";
import { buildFridayEvidenceBlocks } from "#agent";
import { createFridayOrchestrationEngine } from "#engine";
import type { FridayEngineRunResult } from "#engine";
import type { CreateFridayEngineTurnPreparerDeps } from "#engine";
import type { CreateFridayEngineRunExecutorDeps } from "#engine";
import { createFridayHealthRoutes } from "../http/routes/friday-health-routes.js";
import { createFridayApiTokenRepository } from "../persistence/friday-api-token-repository.js";
import type { FridayAuthPrincipal } from "../model/friday-api-common.types.js";
import type {
  FridayGetRunEvidenceQuery,
  FridayRunTimelineEntry,
} from "../model/friday-api-workflow.types.js";

const DEFAULT_ACCESS_TTL = 900; // 15 min
const DEFAULT_REFRESH_TTL = 604_800; // 7 days
const CURRENT_EPOCH = 1;
const SESSION_CONTEXT_HISTORY_LIMIT = 24;

function readStringListQuery(
  value: unknown,
): string[] | undefined {
  if (typeof value === "string") {
    const parts = value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return parts.length > 0 ? parts : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .filter((item): item is string => typeof item === "string")
      .flatMap((item) =>
        item
          .split(",")
          .map((part) => part.trim()),
      )
      .filter((part) => part.length > 0);
    return parts.length > 0 ? parts : undefined;
  }
  return undefined;
}

function readPositiveIntQuery(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function parseRunEvidenceQuery(source: Record<string, unknown>): FridayGetRunEvidenceQuery {
  const modules = readStringListQuery(source.modules);
  const eventNames = readStringListQuery(source.eventNames);
  const nodeIdRaw = source.nodeId;
  const nodeId = typeof nodeIdRaw === "string" && nodeIdRaw.trim().length > 0
    ? nodeIdRaw
    : undefined;
  return {
    modules: modules as FridayGetRunEvidenceQuery["modules"],
    eventNames,
    nodeId,
    attempt: readPositiveIntQuery(source.attempt),
    limit: readPositiveIntQuery(source.limit),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function resolveWorkflowRealtimeStreamId(
  event: string,
  payload: Record<string, unknown>,
): string | null {
  if (!event.startsWith("workflow.")) {
    return null;
  }

  const runId = asString(payload.runId);
  if (runId) {
    return `run:${runId}`;
  }

  const workflowId = asString(payload.workflowId);
  if (workflowId) {
    return `workflow:${workflowId}`;
  }

  return null;
}

function isPrivilegedRunEvidencePrincipal(principal: FridayAuthPrincipal | null): boolean {
  if (!principal) {
    return false;
  }
  if (principal.scopes.includes("hub.admin")) {
    return true;
  }
  return principal.role === "owner" || principal.role === "admin";
}

function resolvePrincipalTenantId(principal: FridayAuthPrincipal | null): string | null {
  if (!principal) {
    return null;
  }
  if (typeof principal.tenantId === "string" && principal.tenantId.trim().length > 0) {
    return principal.tenantId.trim();
  }
  return principal.principalId;
}

function assertTenantScopedAccess(
  principal: FridayAuthPrincipal | null,
  tenantId: string,
): void {
  if (isPrivilegedRunEvidencePrincipal(principal)) {
    return;
  }
  if (!principal) {
    throw new FridayDomainError("UNAUTHORIZED", "Authentication required", { httpStatus: 401 });
  }
  if (principal.principalType === "satellite") {
    throw new FridayDomainError("FORBIDDEN", "Satellite principal cannot access tenant-scoped security routes", {
      httpStatus: 403,
    });
  }
  if (resolvePrincipalTenantId(principal) !== tenantId) {
    throw new FridayDomainError("FORBIDDEN", "Tenant access denied", { httpStatus: 403 });
  }
}

function resolveTenantIdFromContext(ctx: {
  params?: unknown;
  query?: unknown;
  body?: unknown;
}): string | undefined {
  const params = asRecord(ctx.params);
  const query = asRecord(ctx.query);
  const body = asRecord(ctx.body);
  return (
    asString(params.tenantId)
    ?? asString(query.tenantId)
    ?? asString(body.tenantId)
    ?? asString(query.buyerTenantId)
    ?? asString(body.buyerTenantId)
  );
}

export function createFridayApiRuntime(deps: CreateFridayApiRuntimeDeps): FridayApiRuntime {
  const accessTokenTtlSec = Math.min(deps.accessTokenTtlSec ?? DEFAULT_ACCESS_TTL, DEFAULT_ACCESS_TTL);
  const refreshTokenTtlSec = deps.refreshTokenTtlSec ?? DEFAULT_REFRESH_TTL;
  const serverVersion = deps.serverVersion ?? "1.0.0";
  const stateDir = deps.stateDir ?? ".";

  // Auth
  const tokenRepo = createFridayApiTokenRepository();

  // ─── In-memory access token revocation map (SEC-005) ───
  // Load persisted revocations from DB on startup
  const revokedAccessTokens = new Map<string, number>(); // tokenId → expiry epoch sec
  {
    const nowSec = Math.floor(new Date(deps.nowIso()).getTime() / 1000);
    const persisted = deps.db.withReadConnection((db) =>
      tokenRepo.loadRevokedAccessTokens(db, nowSec),
    );
    for (const row of persisted) {
      revokedAccessTokens.set(row.token_id, row.expires_at_epoch);
    }
    // Purge expired entries from DB
    deps.db.withWriteTransaction((db) => {
      tokenRepo.purgeExpiredAccessTokenRevocations(db, nowSec);
    });
  }

  function markAccessTokenRevoked(tokenId: string, expSec: number): void {
    revokedAccessTokens.set(tokenId, expSec);
    // Persist to DB so revocations survive restarts (SEC-005)
    deps.db.withWriteTransaction((db) => {
      tokenRepo.revokeAccessToken(db, tokenId, expSec, deps.nowIso());
    });
  }

  /** Lazy cleanup: remove expired entries, then check if tokenId is revoked. */
  function isAccessTokenRevokedInMemory(tokenId: string): boolean {
    const nowSec = Math.floor(new Date(deps.nowIso()).getTime() / 1000);
    for (const [id, exp] of revokedAccessTokens) {
      if (exp < nowSec) {
        revokedAccessTokens.delete(id);
      }
    }
    return revokedAccessTokens.has(tokenId);
  }

  const tokenValidator = createFridayTokenValidator({
    tokenSecret: deps.tokenSecret,
    nowMs: () => new Date(deps.nowIso()).getTime(),
    lookupTokenRevocation: (tokenId) =>
      isAccessTokenRevokedInMemory(tokenId) ||
      deps.db.withReadConnection((db) => tokenRepo.isRevoked(db, tokenId)),
    lookupSatelliteTokenVersion: (satelliteId) => {
      const row = deps.db.withReadConnection((db) =>
        db
          .prepare("SELECT token_version FROM satellites WHERE id = ?")
          .get(satelliteId) as { token_version: number } | undefined,
      );
      return row?.token_version ?? null;
    },
    resolveTenantId: (claims) =>
      deps.resolveAuthTenantId?.({
        principalType: claims.principalType,
        principalId: claims.principalId,
        userId: claims.userId,
        role: claims.role,
        tenantId: claims.tenantId,
        claims,
      }),
  });

  const rateLimiter = createFridayRateLimitService({
    db: deps.db,
    nowIso: deps.nowIso,
  });

  const authService = createFridayAuthService({
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    tokenSecret: deps.tokenSecret,
    accessTokenTtlSec,
    refreshTokenTtlSec,
    allowPasswordlessLocalLogin: deps.allowPasswordlessLocalLogin ?? false,
    allowLocalBypassLogin: deps.allowLocalBypassLogin ?? false,
    markAccessTokenRevoked,
    rateLimiter,
    resolveTenantId: (input) =>
      deps.resolveAuthTenantId?.({
        principalType: input.principalType,
        principalId: input.principalId,
        userId: input.userId,
        role: input.role,
      }),
  });

  const middleware = createFridayAuthMiddlewareFactory({
    tokenValidator,
    rateLimitService: rateLimiter,
  });

  // Realtime
  const eventRepo = createFridayRealtimeEventRepository();
  const checkpointRepo = createFridayRealtimeCheckpointRepository();

  const eventBus = createFridayRealtimeEventBus({
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    persistEvent: (envelope) => {
      deps.db.withWriteTransaction((db) => {
        eventRepo.append(db, envelope);
      });
    },
    db: deps.db,
    eventRepo,
  });

  const subscriptions = createFridayRealtimeSubscriptionService({
    db: deps.db,
    eventRepo,
    checkpointRepo,
    nowIso: deps.nowIso,
    currentEpoch: CURRENT_EPOCH,
    cursorSecret: deps.tokenSecret,
  });

  const wsGateway = createFridayRealtimeWsGateway({
    tokenValidator,
    subscriptionService: subscriptions,
    eventBus,
    nowIso: deps.nowIso,
    serverVersion,
    currentEpoch: CURRENT_EPOCH,
  });

  const publishWorkflowRealtimeEvent = async (
    event: string,
    payload: unknown,
  ): Promise<void> => {
    const normalizedPayload = asRecord(payload);
    const streamId = resolveWorkflowRealtimeStreamId(event, normalizedPayload);
    if (!streamId) {
      return;
    }

    eventBus.publish(
      streamId,
      event as never,
      normalizedPayload as never,
    );
  };

  // Fleet
  const fleet = createFridayFleetDashboardService({
    db: deps.db,
    nowIso: deps.nowIso,
    idGenerator: deps.idGenerator,
    outboxQueueService: deps.outboxQueueService,
  });

  // Conflicts
  const conflicts = createFridayWorkflowConflictService({
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // ─── Workflow runtime (use provided or create new for backward compat) ───
  const workflowRuntime = deps.workflowRuntime ?? (() => {
    const triggerRepo = createFridayWorkflowTriggerRepository({ db: deps.db });
    return createFridayWorkflowRuntime({
      db: deps.db,
      idGenerator: deps.idGenerator,
      nowIso: deps.nowIso,
      computeChecksum: deps.computeChecksum,
      resolveSkill: deps.resolveSkill,
      invokeSkill: deps.invokeSkill,
      publishEvent: publishWorkflowRealtimeEvent,
      triggerRepo,
    });
  })();

  const resolveAuthorizedRun = (
    runId: string,
    principal: FridayAuthPrincipal | null,
    options?: { evidence?: boolean },
  ) => {
    const run = workflowRuntime.execution.getRun(runId);
    if (!run) {
      throw new FridayDomainError("WORKFLOW_RUN_NOT_FOUND", "Workflow run not found", { httpStatus: 404 });
    }

    if (isPrivilegedRunEvidencePrincipal(principal)) {
      return run;
    }

    if (!principal) {
      throw new FridayDomainError("UNAUTHORIZED", "Authentication required", { httpStatus: 401 });
    }

    if (principal.userId && run.startedByUserId === principal.userId) {
      return run;
    }

    if (principal.principalType === "satellite" && run.startedBySatelliteId === principal.principalId) {
      return run;
    }

    const runContext = asRecord(run.context);
    const securityContext = asRecord(runContext.security);
    const ownerPrincipalId = asString(securityContext.ownerPrincipalId);
    const ownerUserId = asString(securityContext.ownerUserId);
    const tenantId = asString(securityContext.tenantId)
      ?? asString(runContext.tenantId)
      ?? asString(runContext.accountId);

    if (ownerPrincipalId && ownerPrincipalId === principal.principalId) {
      return run;
    }

    if (ownerUserId && principal.userId && ownerUserId === principal.userId) {
      return run;
    }

    if (tenantId && tenantId === principal.principalId) {
      return run;
    }

    if (options?.evidence) {
      throw new FridayDomainError(
        "WORKFLOW_RUN_EVIDENCE_FORBIDDEN",
        "You do not have permission to access this run evidence",
        { httpStatus: 403 },
      );
    }
    throw new FridayDomainError(
      "WORKFLOW_RUN_FORBIDDEN",
      "You do not have permission to access this workflow run",
      { httpStatus: 403 },
    );
  };

  const resolveAuthorizedRunForEvidence = (
    runId: string,
    principal: FridayAuthPrincipal | null,
  ) => {
    return resolveAuthorizedRun(runId, principal, { evidence: true });
  };

  // ─── Builder runtime ───
  const builderRuntime = createFridayWorkflowBuilderRuntime({
    db: deps.db,
    crudService: workflowRuntime.crud,
    skillRegistry: deps.skillRegistry,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    computeChecksum: deps.computeChecksum,
  });
  const workflowProductService = createFridayWorkflowProductService({
    builderRuntime,
    workflowRuntime,
    workflowGenerator: deps.workflowGenerator,
    observability: deps.observabilityService,
    selfHealing: deps.diagnosis?.service,
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // Route registry
  const routes = createFridayHttpRouteRegistry();
  const secretAdminService = createFridaySecretAdminService({
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // Register health routes FIRST (public, no auth)
  for (const route of createFridayHealthRoutes({
    version: serverVersion,
    getCapabilities: async () => {
      const searchHealth = typeof deps.searchHealth === "function"
        ? await Promise.resolve(deps.searchHealth())
        : deps.searchHealth;
      const systemHealth = typeof deps.systemHealth === "function"
        ? await Promise.resolve(deps.systemHealth())
        : deps.systemHealth;

      return {
        schemaVersion: "1.0" as const,
        auth: {
          allowPasswordlessLocalLogin: deps.allowPasswordlessLocalLogin ?? false,
          allowLocalBypassLogin: deps.allowLocalBypassLogin ?? false,
        },
        plugins: {
          runtimeMode: deps.pluginRuntimeMode ?? "stub",
          marketplaceAvailable: deps.pluginMarketplaceAvailable ?? false,
        },
        marketplace: {
          commerceEnabled: deps.marketplaceCommerce !== undefined,
          skillSourceEnabled: deps.skillMarketplace !== undefined,
          pluginMarketplaceEnabled: deps.pluginMarketplaceAvailable ?? false,
        },
        channels: {
          supportedKinds: deps.supportedChannelKinds ?? [],
          enabledKinds: deps.enabledChannelKinds ?? [],
        },
        search: searchHealth ?? {
          provider: "duckduckgo_html",
          latestness: "unverified" as const,
        },
        system: systemHealth ?? {
          enabled: false,
          remoteMode: "unavailable" as const,
          companionReadiness: "unavailable" as const,
        },
      };
    },
  })) {
    routes.register(route);
  }

  for (const route of createFridayRuntimeAdminRoutes({
    version: {
      get: () => ({
        version: serverVersion,
        apiVersion: "v1",
      }),
    },
    config: deps.configManager
      ? {
        get: async (query) => {
          const [currentConfig, snapshot] = await Promise.all([
            deps.configManager!.getCurrentConfig(),
            deps.configManager!.getConfig(query.keys),
          ]);
          return {
            revision: snapshot.revision,
            settings: snapshot.settings,
            currentConfig,
          };
        },
        update: async (request) => {
          const validation = await deps.configManager!.validatePatch(request.patch);
          if (!validation.valid) {
            throw new FridayDomainError("VALIDATION_ERROR", "Config patch validation failed", {
              httpStatus: 400,
              details: { errors: validation.errors },
            });
          }
          const result = await deps.configManager!.applyPatch(request);
          return {
            ...result,
            validation: {
              valid: true as const,
              errors: [] as [],
            },
          };
        },
        listRevisions: (query) => deps.configManager!.listRevisions(query.cursor, query.limit),
        revert: (request) => deps.configManager!.revertToRevision(request.toRevision),
      }
      : undefined,
    auditLogs: deps.observability
      ? {
        list: (query) => deps.observability!.audit.search(query),
      }
      : undefined,
  })) {
    routes.register(route);
  }

  // Register auth routes
  for (const route of createFridayAuthRoutes({ authService })) {
    routes.register(route);
  }

  for (const route of createFridaySecretRoutes({
    service: secretAdminService,
  })) {
    routes.register(route);
  }

  // Register workflow routes (real service wiring)
  for (const route of createFridayWorkflowRoutes({
    listWorkflows: (query) => {
      const workflows = workflowRuntime.crud.listWorkflows({
        tag: query.tag,
        archived: query.archived,
        cursor: query.cursor,
        limit: query.limit,
      });
      return { items: workflows };
    },
    createWorkflow: (input) => {
      return workflowRuntime.crud.createWorkflowWithVersion(
        {
          slug: input.slug,
          name: input.name,
          description: input.description,
          tags: input.tags,
        },
        input.graph,
      );
    },
    getWorkflow: (workflowId) => {
      const workflow = workflowRuntime.crud.getWorkflow(workflowId);
      if (!workflow) {
        throw new FridayDomainError("WORKFLOW_NOT_FOUND", "Workflow not found", { httpStatus: 404 });
      }
      const versions = workflowRuntime.crud.listVersions(workflowId, 1);
      const latestVersion = versions[0];
      if (!latestVersion) {
        throw new FridayDomainError("WORKFLOW_VERSION_NOT_FOUND", "Workflow version not found", { httpStatus: 404 });
      }
      const publishedVersion =
        workflowRuntime.crud.getPublishedVersion(workflowId) ?? undefined;
      return { workflow, latestVersion, publishedVersion };
    },
    updateWorkflow: (workflowId, input) => {
      const workflow = workflowRuntime.crud.updateWorkflow({
        workflowId,
        expectedRevision: input.expectedRevision,
        etag: input.etag,
        name: input.name,
        description: input.description,
        tags: input.tags,
      });
      let version;
      if (input.graph) {
        version = workflowRuntime.crud.createVersion(workflowId, input.graph);
      }
      return { workflow, version };
    },
    archiveWorkflow: (workflowId) => {
      workflowRuntime.crud.archiveWorkflow(workflowId, "api");
      return { archived: true };
    },
    publishWorkflow: (_workflowId, input) => {
      const publishedVersion = workflowRuntime.crud.publishVersion(
        _workflowId,
        input.versionNumber,
      );
      return { publishedVersion };
    },
    listVersions: (workflowId, query) => {
      const versions = workflowRuntime.crud.listVersions(
        workflowId,
        query.limit,
      );
      return { items: versions };
    },
    getVersion: (versionId) => {
      const version = workflowRuntime.crud.getVersion(versionId);
      if (!version) {
        throw new FridayDomainError("WORKFLOW_VERSION_NOT_FOUND", "Workflow version not found", {
          httpStatus: 404,
        });
      }
      return { version };
    },
  })) {
    routes.register(route);
  }

  // Register builder routes (real service wiring)
  for (const route of createFridayWorkflowBuilderTemplateRoutes({
    listTemplates: ({ scope }) => ({
      items: builderRuntime.templates.listTemplates(
        scope === "user" || scope === "global" ? scope : undefined,
      ),
      stableItems: listFridayStableWorkflowTemplates(),
    }),
    getTemplate: (templateId) => {
      const template = builderRuntime.templates.getTemplate(templateId);
      if (!template) {
        throw new FridayDomainError("TEMPLATE_NOT_FOUND", "Template not found", { httpStatus: 404 });
      }
      return { template };
    },
    instantiateTemplate: (templateId, body) => {
      if (!body || typeof body !== "object") {
        throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
      }
      if (typeof body.workflowId !== "string" || body.workflowId.length === 0) {
        throw new FridayDomainError("VALIDATION_ERROR", "workflowId is required", { httpStatus: 400 });
      }
      if (typeof body.title !== "string" || body.title.trim().length === 0) {
        throw new FridayDomainError("VALIDATION_ERROR", "title is required", { httpStatus: 400 });
      }
      if (typeof body.taskProfileId !== "undefined" && typeof body.taskProfileId !== "string") {
        throw new FridayDomainError("VALIDATION_ERROR", "taskProfileId must be a string when provided", {
          httpStatus: 400,
        });
      }
      const stableBundle = createFridayStableWorkflowDraftBundle({
        templateId,
        workflowId: body.workflowId,
        title: body.title,
        taskProfileId: body.taskProfileId,
      });
      if (stableBundle) {
        return {
          draft: builderRuntime.drafts.createDraft({
            workflowId: body.workflowId,
            title: body.title,
            spec: stableBundle.spec,
            visual: stableBundle.visual,
            ownerUserId: body.ownerUserId,
          }),
        };
      }
      return {
        draft: builderRuntime.templates.instantiateTemplate(
          templateId,
          body.workflowId,
          body.title,
          body.ownerUserId,
        ),
      };
    },
  })) {
    routes.register(route);
  }

  for (const route of createFridayWorkflowBuilderRoutes({
    createDraft: (workflowId, input) => {
      const draft = builderRuntime.drafts.createDraft({
        workflowId,
        title: input.title,
        spec: input.spec,
        visual: input.visual,
        ownerUserId: input.ownerUserId,
        baseWorkflowVersionId: input.baseWorkflowVersionId,
      });
      return { draft };
    },
    listDrafts: (workflowId, _query) => {
      const drafts = builderRuntime.drafts.listDrafts(workflowId);
      return { items: drafts };
    },
    getDraft: (workflowId, draftId) => {
      const draft = builderRuntime.drafts.getDraft(draftId);
      if (!draft) {
        throw new FridayDomainError("DRAFT_NOT_FOUND", "Draft not found", { httpStatus: 404 });
      }
      if (draft.workflowId !== workflowId) {
        throw new FridayDomainError("DRAFT_WORKFLOW_MISMATCH", "Draft does not belong to this workflow", { httpStatus: 409 });
      }
      return { draft };
    },
    exportDraftBundle: (workflowId, draftId) => {
      const draft = builderRuntime.drafts.getDraft(draftId);
      if (!draft) {
        throw new FridayDomainError("DRAFT_NOT_FOUND", "Draft not found", { httpStatus: 404 });
      }
      if (draft.workflowId !== workflowId) {
        throw new FridayDomainError("DRAFT_WORKFLOW_MISMATCH", "Draft does not belong to this workflow", { httpStatus: 409 });
      }
      return {
        bundle: builderRuntime.importExport.exportDraft(draftId),
      };
    },
    importWorkflowBundle: (workflowId, input) => {
      if (!input || typeof input !== "object") {
        throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
      }
      if (!input.bundle || typeof input.bundle !== "object") {
        throw new FridayDomainError("VALIDATION_ERROR", "bundle is required", { httpStatus: 400 });
      }
      const result = builderRuntime.importExport.importBundle(
        input.bundle,
        workflowId,
        input.ownerUserId,
        { force: input.force === true },
      );
      return { result };
    },
    saveDraft: (workflowId, draftId, input) => {
      const existing = builderRuntime.drafts.getDraft(draftId);
      if (!existing) {
        throw new FridayDomainError("DRAFT_NOT_FOUND", "Draft not found", { httpStatus: 404 });
      }
      if (existing.workflowId !== workflowId) {
        throw new FridayDomainError("DRAFT_WORKFLOW_MISMATCH", "Draft does not belong to this workflow", { httpStatus: 409 });
      }
      const draft = builderRuntime.drafts.saveDraft({
        draftId,
        expectedRevision: input.expectedRevision,
        lockToken: input.lockToken,
        title: input.title,
        spec: input.spec,
        visual: input.visual,
        autosave: input.autosave,
      });
      return { draft };
    },
    autosaveDraft: (workflowId, draftId, input) => {
      const existing = builderRuntime.drafts.getDraft(draftId);
      if (!existing) {
        throw new FridayDomainError("DRAFT_NOT_FOUND", "Draft not found", { httpStatus: 404 });
      }
      if (existing.workflowId !== workflowId) {
        throw new FridayDomainError("DRAFT_WORKFLOW_MISMATCH", "Draft does not belong to this workflow", { httpStatus: 409 });
      }
      const draft = builderRuntime.drafts.autosaveDraft({
        draftId,
        lockToken: input.lockToken,
        spec: input.spec,
        visual: input.visual,
      });
      return { draft };
    },
    compileDraft: (workflowId, draftId) => {
      const draft = builderRuntime.drafts.getDraft(draftId);
      if (!draft) {
        throw new FridayDomainError("DRAFT_NOT_FOUND", "Draft not found", { httpStatus: 404 });
      }
      if (draft.workflowId !== workflowId) {
        throw new FridayDomainError("DRAFT_WORKFLOW_MISMATCH", "Draft does not belong to this workflow", { httpStatus: 409 });
      }
      return builderRuntime.compositor.compileDraft(draftId);
    },
    publishDraft: (workflowId, draftId, input) => {
      return builderRuntime.compositor.publishDraft({
        draftId,
        workflowId,
        lockToken: input.lockToken,
        createdByUserId: input.createdByUserId,
        changeNote: input.changeNote,
        publishNow: input.publishNow,
      });
    },
    acquireLock: (workflowId, input) => {
      const result = builderRuntime.collaboration.acquireLock({
        workflowId,
        ownerUserId: input.ownerUserId,
        ownerSessionId: input.ownerSessionId,
        ttlSec: input.ttlSec,
      });
      return {
        acquired: result.acquired,
        lock: result.lock,
        conflict: result.conflict,
      };
    },
    renewLock: (workflowId, input) => {
      const lock = builderRuntime.collaboration.renewLock(
        workflowId,
        input.lockToken,
        input.ttlSec,
      );
      return { lock };
    },
    releaseLock: (workflowId, input) => {
      builderRuntime.collaboration.releaseLock(workflowId, input.lockToken);
      return { released: true };
    },
  })) {
    routes.register(route);
  }

  for (const route of createFridayWorkflowProductRoutes({
    service: workflowProductService,
  })) {
    routes.register(route);
  }

  // Register run routes (real service wiring)
  for (const route of createFridayWorkflowRunRoutes({
    assertListingEntitled: async (listingId, principal) => {
      if (!deps.marketplaceEntitlementCheck) return;
      if (!principal?.principalId) {
        throw new FridayDomainError("UNAUTHORIZED", "Authentication required", { httpStatus: 401 });
      }
      await deps.marketplaceEntitlementCheck({
        listingId,
        principalId: principal.principalId,
      });
    },
    startRun: async (input, principal) => {
      const runSecurityContext = principal
        ? {
          security: {
            ownerPrincipalId: principal.principalId,
            ownerPrincipalType: principal.principalType,
            ownerUserId: principal.userId ?? null,
            tenantId: resolvePrincipalTenantId(principal) ?? principal.principalId,
            tokenId: principal.tokenId,
          },
        }
        : undefined;
      const run = await workflowRuntime.execution.startRun({
        workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId,
        triggerType: input.triggerType,
        triggerPayload: input.triggerPayload,
        startedByUserId: principal?.userId,
        startedBySatelliteId: principal?.principalType === "satellite"
          ? principal.principalId
          : undefined,
        context: runSecurityContext,
        dryRun: input.dryRun,
      });
      return { run };
    },
    getRun: (runId, principal) => {
      const run = resolveAuthorizedRun(runId, principal);
      return { run };
    },
    listRunNodes: (runId, query, principal) => {
      resolveAuthorizedRun(runId, principal);
      const nodes = workflowRuntime.execution.getRunNodes(
        runId,
        query.status,
      );
      return { items: nodes };
    },
    getRunTimeline: (runId, query, principal) => {
      resolveAuthorizedRun(runId, principal);
      const streamId = `run:${runId}`;
      const afterSeq = query.afterSeq ?? 0;
      const limit = query.limit ?? 50;
      const envelopes = deps.db.withReadConnection((db) =>
        eventRepo.listAfterSeq(db, streamId, afterSeq, limit),
      );
      const items: FridayRunTimelineEntry[] = envelopes.map((e) => {
        const p = e.payload as JsonObject;
        return {
          seq: e.seq,
          streamId: e.streamId,
          event: e.event,
          emittedAt: e.emittedAt,
          nodeId: p.nodeId as string | undefined,
          attempt: p.attempt as number | undefined,
          status: p.status as FridayRunTimelineEntry["status"] | undefined,
          payload: p,
        };
      });
      return { items };
    },
    getRunEvidence: (runId, query, principal) => {
      resolveAuthorizedRunForEvidence(runId, principal);
      return workflowRuntime.evidence.getRunEvidence(
        runId,
        parseRunEvidenceQuery(query as Record<string, unknown>),
      );
    },
    listRunEvidenceExports: (runId, query, principal) => {
      resolveAuthorizedRunForEvidence(runId, principal);
      const limit = readPositiveIntQuery((query as Record<string, unknown>).limit) ?? 20;
      return {
        items: workflowRuntime.evidence.listRunEvidenceExports(runId, limit),
      };
    },
    exportRunEvidence: (runId, input, principal) => {
      resolveAuthorizedRunForEvidence(runId, principal);
      return workflowRuntime.evidence.exportRunEvidence(
        runId,
        parseRunEvidenceQuery((input ?? {}) as Record<string, unknown>),
      );
    },
    getRunEvidenceExport: (runId, exportId, principal) => {
      resolveAuthorizedRunForEvidence(runId, principal);
      const record = workflowRuntime.evidence.getRunEvidenceExport(runId, exportId);
      if (!record) {
        throw new FridayDomainError("WORKFLOW_RUN_EVIDENCE_EXPORT_NOT_FOUND", "Workflow run evidence export not found", {
          httpStatus: 404,
        });
      }
      return record;
    },
    downloadRunEvidenceExport: (runId, exportId, principal) => {
      resolveAuthorizedRunForEvidence(runId, principal);
      const download = workflowRuntime.evidence.downloadRunEvidenceExport(runId, exportId);
      if (!download) {
        throw new FridayDomainError("WORKFLOW_RUN_EVIDENCE_EXPORT_NOT_FOUND", "Workflow run evidence export not found", {
          httpStatus: 404,
        });
      }
      return download;
    },
    cancelRun: async (runId, input, principal) => {
      resolveAuthorizedRun(runId, principal);
      const run = await workflowRuntime.execution.cancelRun(
        runId,
        input.reason,
      );
      return { run };
    },
    retryRun: async (runId, input, principal) => {
      resolveAuthorizedRun(runId, principal);
      const run = await workflowRuntime.execution.retryRun(
        runId,
        input.nodeIds,
      );
      return { run, retriedNodes: input.nodeIds ?? [] };
    },
    resumeRun: async (runId, principal) => {
      resolveAuthorizedRun(runId, principal);
      const run = await workflowRuntime.execution.resumeRun(runId);
      return { run };
    },
  })) {
    routes.register(route);
  }

  // ─── Approval service (from workflow runtime — no duplicate) ───
  const approvalService = workflowRuntime.approval;
  const listWorkflowApprovals = async (ctx: {
    query: unknown;
  }) => {
    const query = ctx.query as { approverUserId?: string; limit?: string; cursor?: string };
    const items = approvalService.listPending({
      approverUserId: query.approverUserId,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      cursor: query.cursor,
    });
    return { items };
  };
  const getWorkflowApproval = async (ctx: {
    params: unknown;
  }) => {
    const { approvalId } = ctx.params as { approvalId: string };
    const approval = approvalService.getById(approvalId);
    if (!approval) {
      throw new FridayDomainError("WORKFLOW_APPROVAL_NOT_FOUND", "Approval request not found", { httpStatus: 404 });
    }
    return { approval };
  };
  const approveWorkflowApproval = async (ctx: {
    params: unknown;
    body: unknown;
    principal?: { userId?: string } | null;
  }) => {
    const { approvalId } = ctx.params as { approvalId: string };
    const body = ctx.body as { comment?: string };
    const userId = ctx.principal?.userId;
    if (!userId) {
      throw new FridayDomainError("AUTH_REQUIRED", "Authenticated user required for approval", { httpStatus: 401 });
    }
    return approvalService.approve({
      approvalId,
      decidedByUserId: userId,
      comment: body.comment,
    });
  };
  const rejectWorkflowApproval = async (ctx: {
    params: unknown;
    body: unknown;
    principal?: { userId?: string } | null;
  }) => {
    const { approvalId } = ctx.params as { approvalId: string };
    const body = ctx.body as { comment?: string };
    const userId = ctx.principal?.userId;
    if (!userId) {
      throw new FridayDomainError("AUTH_REQUIRED", "Authenticated user required for rejection", { httpStatus: 401 });
    }
    return approvalService.reject({
      approvalId,
      decidedByUserId: userId,
      comment: body.comment,
    });
  };

  // Approval API routes — wired to real service
  routes.register({
    operationId: "workflows.approvals.list",
    method: "GET",
    path: "/v1/workflow-approvals",
    auth: { public: false, anyOfScopes: ["workflow.run"] },
    handler: listWorkflowApprovals,
  });

  routes.register({
    operationId: "workflows.approvals.get",
    method: "GET",
    path: "/v1/workflow-approvals/:approvalId",
    auth: { public: false, anyOfScopes: ["workflow.run"] },
    handler: getWorkflowApproval,
  });

  routes.register({
    operationId: "workflows.approvals.approve",
    method: "POST",
    path: "/v1/workflow-approvals/:approvalId/approve",
    auth: { public: false, anyOfScopes: ["workflow.run"] },
    handler: approveWorkflowApproval,
  });

  routes.register({
    operationId: "workflows.approvals.reject",
    method: "POST",
    path: "/v1/workflow-approvals/:approvalId/reject",
    auth: { public: false, anyOfScopes: ["workflow.run"] },
    handler: rejectWorkflowApproval,
  });

  routes.register({
    operationId: "approvals.list",
    method: "GET",
    path: "/v1/approvals",
    auth: { public: false, anyOfScopes: ["workflow.run"] },
    handler: listWorkflowApprovals,
  });

  routes.register({
    operationId: "approvals.get",
    method: "GET",
    path: "/v1/approvals/:approvalId",
    auth: { public: false, anyOfScopes: ["workflow.run"] },
    handler: getWorkflowApproval,
  });

  routes.register({
    operationId: "approvals.approve",
    method: "POST",
    path: "/v1/approvals/:approvalId/approve",
    auth: { public: false, anyOfScopes: ["workflow.run"] },
    handler: approveWorkflowApproval,
  });

  routes.register({
    operationId: "approvals.reject",
    method: "POST",
    path: "/v1/approvals/:approvalId/reject",
    auth: { public: false, anyOfScopes: ["workflow.run"] },
    handler: rejectWorkflowApproval,
  });

  // ─── Trigger routes (Issue 6: setEnabled) ───
  routes.register({
    operationId: "workflows.triggers.list",
    method: "GET",
    path: "/v1/workflows/:workflowId/triggers",
    auth: { public: false, anyOfScopes: ["workflow.read"] },
    async handler(ctx) {
      const { workflowId } = ctx.params as { workflowId: string };
      const items = workflowRuntime.triggers.listRegistrations(workflowId);
      return { items };
    },
  });

  routes.register({
    operationId: "workflows.triggers.update",
    method: "PATCH",
    path: "/v1/workflow-triggers/:registrationId",
    auth: { public: false, anyOfScopes: ["workflow.write"] },
    async handler(ctx) {
      const { registrationId } = ctx.params as { registrationId: string };
      const body = ctx.body as { enabled?: boolean };
      if (body.enabled != null) {
        await workflowRuntime.triggers.setRegistrationEnabled(
          registrationId,
          body.enabled,
        );
      }
      return { updated: true };
    },
  });

  routes.register({
    operationId: "workflows.triggers.resync",
    method: "POST",
    path: "/v1/workflows/:workflowId/triggers/resync",
    auth: { public: false, anyOfScopes: ["workflow.write"] },
    async handler(ctx) {
      const { workflowId } = ctx.params as { workflowId: string };
      await workflowRuntime.triggers.syncPublishedVersionTriggers(workflowId);
      return { synced: true };
    },
  });

  // ─── Webhook route (Issue 2: proper trigger repo lookup + M4 HMAC verification) ───
  routes.register({
    operationId: "workflows.webhooks.invoke",
    method: "POST",
    path: "/v1/workflow-webhooks/:pathToken",
    auth: { public: true },
    async handler(ctx) {
      const { pathToken } = ctx.params as { pathToken: string };
      const body = (ctx.body ?? {}) as JsonObject;
      const headers = ctx.headers as Record<string, string> | undefined;
      const result = await workflowRuntime.triggers.handleWebhook({
        pathToken,
        body,
        headers,
        rawBody: ctx.rawBody,
      });
      if (!result.accepted) {
        if (result.statusCode === 401) {
          throw new FridayDomainError(
            result.errorCode ?? "WEBHOOK_SIGNATURE_MISSING",
            "Webhook signature header is missing",
            { httpStatus: 401 },
          );
        }
        if (result.statusCode === 403) {
          throw new FridayDomainError(
            result.errorCode ?? "WEBHOOK_SIGNATURE_INVALID",
            "Webhook signature verification failed",
            { httpStatus: 403 },
          );
        }
        throw new FridayDomainError("WORKFLOW_WEBHOOK_NOT_FOUND", "Webhook not found or disabled", { httpStatus: 404 });
      }
      return { accepted: true, runId: result.runId };
    },
  });

  // Register conflict routes
  for (const route of createFridayWorkflowConflictRoutes({
    listConflicts: (workflowId, query) => ({
      items: conflicts.listConflicts(workflowId, query.status, query.limit),
    }),
    resolveConflict: (workflowId, conflictId, input, userId) =>
      conflicts.resolveConflict(conflictId, input, userId),
  })) {
    routes.register(route);
  }

  // Register fleet routes
  for (const route of createFridayFleetRoutes({ fleetService: fleet })) {
    routes.register(route);
  }

  // Register security routes
  for (const route of createFridaySecurityRoutes({
    fleetService: fleet,
    revokeToken: (tokenId) => {
      const changed = deps.db.withWriteTransaction((db) =>
        tokenRepo.revoke(db, tokenId, deps.nowIso()),
      );
      return { revoked: changed, tokenId };
    },
    revokeSatellite: (satelliteId, reason) => {
      deps.db.withWriteTransaction((db) => {
        db.prepare(
          "UPDATE satellites SET pairing_status = 'revoked', updated_at = ? WHERE id = ?",
        ).run(deps.nowIso(), satelliteId);
      });
      return { revoked: true, satelliteId };
    },
  })) {
    routes.register(route);
  }

  // Register multi-tenant security routes (optional)
  if (deps.multiTenantSecurity) {
    for (const route of createFridayMultiTenantSecurityRoutes(deps.multiTenantSecurity)) {
      const guardedRoute = route.path.includes("/tenants/:tenantId")
        ? {
          ...route,
          async handler(ctx: Parameters<typeof route.handler>[0]) {
            const params = ctx.params as Record<string, unknown>;
            const tenantId = asString(params.tenantId);
            if (tenantId) {
              assertTenantScopedAccess(ctx.principal, tenantId);
            }
            return route.handler(ctx);
          },
        }
        : route;
      routes.register(guardedRoute);
    }
  }

  // Register observability routes (optional)
  if (deps.observability) {
    for (const route of createFridayObservabilityRoutes(deps.observability)) {
      routes.register(route);
    }
  }

  // Register desktop runtime routes (optional)
  if (deps.desktop) {
    for (const route of createFridayDesktopRoutes(deps.desktop)) {
      routes.register(route);
    }
  }

  // Register self-healing routes (optional)
  if (deps.diagnosis) {
    for (const route of createFridayDiagnosisRoutes(deps.diagnosis)) {
      routes.register(route);
    }
  }

  if (deps.autoFix) {
    for (const route of createFridayAutoFixRoutes(deps.autoFix)) {
      routes.register(route);
    }
  }

  if (deps.agentLoop) {
    for (const route of createFridayAgentLoopRoutes(deps.agentLoop)) {
      routes.register(route);
    }
  }

  // Register Agent OS system routes (optional)
  if (deps.system) {
    for (const route of createFridaySystemRoutes(deps.system)) {
      routes.register(route);
    }
  }

  // Register local discovery routes (optional)
  if (deps.discovery) {
    for (const route of createFridayDiscoveryRoutes(deps.discovery)) {
      routes.register(route as unknown as Parameters<typeof routes.register>[0]);
    }
  }

  // Register MCP server routes (optional)
  if (deps.mcpServer) {
    for (const route of createFridayMcpServerRoutes(deps.mcpServer)) {
      routes.register(route as unknown as Parameters<typeof routes.register>[0]);
    }
  }

  // Register marketplace commerce routes (optional)
  if (deps.marketplaceCommerce) {
    for (const route of createFridayMarketplaceCommerceRoutes(deps.marketplaceCommerce)) {
      const guardedRoute = route.operationId.startsWith("marketplace.")
        ? {
          ...route,
          async handler(ctx: Parameters<typeof route.handler>[0]) {
            const tenantId = resolveTenantIdFromContext(ctx);
            if (tenantId) {
              assertTenantScopedAccess(ctx.principal, tenantId);
            }
            return route.handler(ctx);
          },
        }
        : route;
      routes.register(guardedRoute as unknown as Parameters<typeof routes.register>[0]);
    }
  }

  // Register unified marketplace asset catalog routes (optional)
  if (deps.marketplaceAssets) {
    for (const route of createFridayMarketplaceAssetRoutes(deps.marketplaceAssets)) {
      const guardedRoute = route.operationId.startsWith("marketplace.")
        ? {
          ...route,
          async handler(ctx: Parameters<typeof route.handler>[0]) {
            const tenantId = resolveTenantIdFromContext(ctx);
            if (tenantId) {
              assertTenantScopedAccess(ctx.principal, tenantId);
            }
            return route.handler(ctx);
          },
        }
        : route;
      routes.register(guardedRoute as unknown as Parameters<typeof routes.register>[0]);
    }
  }

  // Register marketplace creator support/profile routes (optional)
  if (deps.marketplaceCreators) {
    for (const route of createFridayMarketplaceCreatorRoutes(deps.marketplaceCreators)) {
      const guardedRoute = route.operationId.startsWith("marketplace.")
        ? {
          ...route,
          async handler(ctx: Parameters<typeof route.handler>[0]) {
            const tenantId = resolveTenantIdFromContext(ctx);
            if (tenantId) {
              assertTenantScopedAccess(ctx.principal, tenantId);
            }
            return route.handler(ctx);
          },
        }
        : route;
      routes.register(guardedRoute as unknown as Parameters<typeof routes.register>[0]);
    }
  }

  if (deps.marketplaceRequests) {
    for (const route of createFridayMarketplaceRequestRoutes(deps.marketplaceRequests)) {
      const guardedRoute = route.operationId.startsWith("marketplace.")
        ? {
          ...route,
          async handler(ctx: Parameters<typeof route.handler>[0]) {
            const tenantId = resolveTenantIdFromContext(ctx);
            if (tenantId) {
              assertTenantScopedAccess(ctx.principal, tenantId);
            }
            return route.handler(ctx);
          },
        }
        : route;
      routes.register(guardedRoute as unknown as Parameters<typeof routes.register>[0]);
    }
  }

  // Register skill marketplace control-plane routes (optional)
  if (deps.skillMarketplace) {
    for (const route of createFridaySkillMarketplaceRoutes(deps.skillMarketplace)) {
      const guardedRoute = route.operationId.startsWith("marketplace.")
        ? {
          ...route,
          async handler(ctx: Parameters<typeof route.handler>[0]) {
            const tenantId = resolveTenantIdFromContext(ctx);
            if (tenantId) {
              assertTenantScopedAccess(ctx.principal, tenantId);
            }
            return route.handler(ctx);
          },
        }
        : route;
      routes.register(guardedRoute as unknown as Parameters<typeof routes.register>[0]);
    }
  }

  // Register satellite pairing routes (optional)
  if (deps.satellitePairing) {
    for (const route of createFridaySatellitePairingRoutes(deps.satellitePairing)) {
      routes.register(route as unknown as Parameters<typeof routes.register>[0]);
    }
  }

  if (deps.satelliteRuntime) {
    for (const route of createFridaySatelliteRuntimeRoutes({
      ...deps.satelliteRuntime,
      pullEvents: ({ streamId, afterSeq, limit }) =>
        subscriptions.pullEvents(streamId, afterSeq, limit),
      getCheckpoint: ({ principalId, streamId }) =>
        subscriptions.getCheckpoint(principalId, streamId),
    })) {
      routes.register(route as unknown as Parameters<typeof routes.register>[0]);
    }
  }

  // Register channel webhook relay routes (optional)
  if (deps.channelWebhooks) {
    for (const route of createFridayChannelWebhookRoutes(deps.channelWebhooks)) {
      routes.register(route);
    }
  }

  // Register realtime routes
  for (const route of createFridayRealtimeRoutes({
    subscriptionService: subscriptions,
    currentEpoch: CURRENT_EPOCH,
  })) {
    routes.register(route);
  }

  // Keep provider usage/budget routes grouped ahead of provider CRUD routes.
  // Route lookup now prefers more specific static patterns, so this order
  // stays readable without being correctness-critical for dispatch.
  for (const route of createFridayProviderUsageRoutes({
    providerService: deps.providerService,
  })) {
    routes.register(route);
  }

  // Register provider routes (BYOK)
  for (const route of createFridayProviderRoutes({
    providerService: deps.providerService,
  })) {
    routes.register(route);
  }

  // Register setup wizard routes
  if (deps.skillRegistry) {
    for (const route of createFridaySetupRoutes({
      db: deps.db,
      providerService: deps.providerService,
      skillRegistry: deps.skillRegistry,
      nowIso: deps.nowIso,
      runningHost: deps.serverHost ?? "127.0.0.1",
      runningPort: deps.serverPort ?? 3141,
      allowPrivateNetwork: deps.allowPrivateNetwork,
    })) {
      routes.register(route);
    }
  }

  // Register skill list route (GET /v1/skills)
  if (deps.skillRegistry || deps.skillLifecycle) {
    for (const route of createFridaySkillRoutes({
      skillRegistry: deps.skillRegistry,
      lifecycle: deps.skillLifecycle,
    })) {
      routes.register(route);
    }
  }

  // Register skill generator routes (optional — only if service is provided)
  if (deps.skillGenerator && deps.skillRegistry) {
    for (const route of createFridaySkillGeneratorRoutes({
      skillGenerator: deps.skillGenerator,
      registry: deps.skillRegistry,
      selfHealing: deps.diagnosis?.service,
      observability: deps.observabilityService,
    })) {
      routes.register(route);
    }
  }

  if (deps.uix) {
    for (const route of createFridayUixRoutes(deps.uix)) {
      routes.register(route);
    }
  }

  // Register skill converter routes (optional — only if service is provided)
  if (deps.converterService) {
    for (const route of createFridaySkillConverterRoutes({
      converterService: deps.converterService,
    })) {
      routes.register(route);
    }
  }

  // Register workflow generator routes (optional — only if service is provided)
  if (deps.workflowGenerator) {
    for (const route of createFridayWorkflowGeneratorRoutes({
      workflowGenerator: deps.workflowGenerator,
    })) {
      routes.register(route);
    }
  }

  // Register deterministic pipeline routes (optional — only if service is provided)
  if (deps.deterministicPipeline) {
    for (const route of createFridayDeterministicPipelineRoutes(deps.deterministicPipeline)) {
      routes.register(route);
    }
  }

  // Register memory routes (optional — only if service is provided)
  let memoryGuardFactory: ReturnType<typeof createFridayMemoryGuardServiceFactory> | undefined;
  if (deps.memoryService) {
    memoryGuardFactory = createFridayMemoryGuardServiceFactory({
      core: deps.memoryService,
      db: deps.db,
      nowIso: deps.nowIso,
      nowMs: () => new Date(deps.nowIso()).getTime(),
    });

    for (const route of createFridayMemoryRoutes({
      memoryGuardFactory,
    })) {
      routes.register(route);
    }
  }

  // Register session routes
  const sessionService = deps.sessionService ?? createFridaySessionService({
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  async function loadSessionHistoryMessages(sessionKey: string): Promise<FridaySessionMessageRecord[]> {
    return sessionService
      .getMessages(sessionKey, SESSION_CONTEXT_HISTORY_LIMIT * 2)
      .catch(() => [] as FridaySessionMessageRecord[]);
  }

  const agentRepo = deps.agentRuntime ? createFridayAgentRunRepository() : undefined;
  const agentRunEventRepo = deps.agentRuntime ? createFridayAgentRunEventRepository() : undefined;
  const agentPlanningGate = deps.agentRuntime && deps.agentEventEmitter && agentRepo
    ? createFridayAgentPlanningGateService({
      repo: agentRepo,
      runEventRepository: agentRunEventRepo,
      runtime: deps.agentRuntime,
      eventEmitter: deps.agentEventEmitter,
      db: deps.db,
      idGenerator: deps.idGenerator,
      nowIso: deps.nowIso,
    })
    : undefined;

  const resolveAgentMirrorIdempotencyKey = (input: {
    runId: string;
    kind: "planning" | "assistant" | "planning-reject" | "deterministic";
    status?: FridayAgentRunStatus;
  }): string => {
    if (input.kind === "planning-reject" || input.kind === "deterministic" || !agentRepo) {
      return `agent-run:${input.runId}:${input.kind}`;
    }
    const run = deps.db.withReadConnection((reader) => agentRepo.getById(reader, input.runId));
    const gateState = run?.planReview?.gate?.state ?? "none";
    const answerCount = run?.planReview?.gate?.answers?.length ?? 0;
    const status = input.status ?? run?.status ?? "unknown";
    return `agent-run:${input.runId}:${input.kind}:${status}:${gateState}:${String(answerCount)}`;
  };

  // ── Orchestration Engine (Initiative A-WIRE) ──
  // Alignment invariant: the engine's turn preparer loads loadSessionHistoryMessages(sessionKey)
  // and injects historyMessages, into agentRuntime.executeRun() internally.
  const apiDispatchDeps: FridayDeterministicDispatchDeps = {
    capabilitySnapshotGetter: deps.capabilitySnapshotGetter,
    taskStatusSnapshotGetter: deps.taskStatusSnapshotGetter,
    getDaemonStatus: deps.daemonStatusGetter,
    listMcpServers: deps.listMcpServers,
    approvalService,
    workflowExecutionService: workflowRuntime.execution,
  };
  const managedAsyncDeps: FridayManagedAsyncDispatchDeps = {
    workflowExecutionService: workflowRuntime.execution,
  };

  // Narrow session deps to the engine's expected interface
  const engineSessionDeps = {
    getMessages: (key: string, limit?: number) => sessionService.getMessages(key, limit),
    addMessage: (key: string, msg: Parameters<typeof sessionService.addMessage>[1]) =>
      sessionService.addMessage(key, msg),
    getConversationFocus: (key: string) => sessionService.getConversationFocus(key),
    setConversationFocus: (key: string, state: Parameters<typeof sessionService.setConversationFocus>[1]) =>
      sessionService.setConversationFocus(key, state).then(() => undefined),
  };

  const orchestrationEngine = deps.agentRuntime
    ? createFridayOrchestrationEngine({
      turnPreparerDeps: {
        sessionDeps: engineSessionDeps,
        historyLimit: SESSION_CONTEXT_HISTORY_LIMIT,
        nowIso: deps.nowIso,
        prepareTurn: prepareFridayConversationTurn as CreateFridayEngineTurnPreparerDeps["prepareTurn"],
        buildEvidenceBlocks: buildFridayEvidenceBlocks as CreateFridayEngineTurnPreparerDeps["buildEvidenceBlocks"],
        classifyExecution: classifyFridayExecution,
        capabilitySnapshotGetter: deps.capabilitySnapshotGetter as CreateFridayEngineTurnPreparerDeps["capabilitySnapshotGetter"],
        taskStatusSnapshotGetter: deps.taskStatusSnapshotGetter as CreateFridayEngineTurnPreparerDeps["taskStatusSnapshotGetter"],
      },
      runExecutorDeps: {
        agentRuntime: deps.agentRuntime!,
        sessionDeps: engineSessionDeps,
        planningGate: agentPlanningGate,
        nowIso: deps.nowIso,
        dispatchDeterministic,
        dispatchManagedAsync,
        finalizeFocus: finalizeFridayConversationFocus as CreateFridayEngineRunExecutorDeps["finalizeFocus"],
        deterministicDispatchDeps: apiDispatchDeps as unknown as Record<string, unknown>,
        managedAsyncDispatchDeps: managedAsyncDeps as unknown as Record<string, unknown>,
        resolveIdempotencyKey: resolveAgentMirrorIdempotencyKey,
      },
    })
    : undefined;

  /**
   * Map `FridayEngineRunResult` back to the `FridayAgentRuntimeResult`-compatible
   * shape that existing callers (agent routes, session routes) expect.
   */
  function engineResultToRuntimeResult(
    engineResult: FridayEngineRunResult,
  ): {
    runId: string;
    status: FridayAgentRunStatus;
    response: string;
    toolCallCount: number;
    durationMs: number;
    usageInput: number;
    usageOutput: number;
    images?: string[];
    finalResponse?: string;
    contextCostSummary?: FridayEngineRunResult["contextCostSummary"];
    taskProfile?: FridayEngineRunResult["taskProfile"];
  } {
    return {
      runId: engineResult.runId,
      status: engineResult.status as FridayAgentRunStatus,
      response: engineResult.response ?? "",
      toolCallCount: engineResult.toolCallCount,
      durationMs: engineResult.durationMs,
      usageInput: engineResult.usageInput ?? 0,
      usageOutput: engineResult.usageOutput ?? 0,
      images: engineResult.images,
      finalResponse: engineResult.response,
      contextCostSummary: engineResult.contextCostSummary,
      taskProfile: engineResult.taskProfile,
    };
  }

  const executeAgentRunWithSessionContext = orchestrationEngine
    ? async (input: {
      task: string;
      runId: string;
      sessionKey?: string;
      providerId?: string;
      model?: string;
      replyToMessageId?: string;
      timezone?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      reviewRequired?: boolean;
      constraints?: { readOnly?: boolean };
      principalId?: string;
      scopes?: string[];
      executionContext?: FridayAgentExecutionContext;
      taskProfile?: FridayAgentTaskProfileInput;
      persistTaskMessage?: boolean;
      taskAlreadyInHistory?: boolean;
      idempotencyPrefix: "api-agent-run" | "api-session-run";
    }) => {
      const engineResult = await orchestrationEngine.executeRun({
        task: input.task,
        runId: input.runId,
        sessionKey: input.sessionKey,
        providerId: input.providerId,
        model: input.model,
        replyToMessageId: input.replyToMessageId,
        timezone: input.timezone,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        reviewRequired: input.reviewRequired,
        constraints: input.constraints,
        principalId: input.principalId,
        scopes: input.scopes,
        executionContext: input.executionContext,
        taskProfile: input.taskProfile,
        taskAlreadyInHistory: input.taskAlreadyInHistory ?? (input.persistTaskMessage === false),
        idempotencyPrefix: input.idempotencyPrefix,
      });
      return engineResultToRuntimeResult(engineResult);
    }
    : undefined;

  // Extraction service (optional — requires memory + provider services)
  let extractionService: ReturnType<typeof createFridaySessionMemoryExtractionService> | undefined;
  if (deps.memoryService) {
    extractionService = createFridaySessionMemoryExtractionService({
      db: deps.db,
      sessionService,
      memoryService: deps.memoryService,
      providerService: deps.providerService,
      idGenerator: deps.idGenerator,
      nowIso: deps.nowIso,
    });
  }

  const runSession = deps.agentRuntime
    ? async (input: {
      sessionKey: string;
      task: string;
      providerId?: string;
      model?: string;
      replyToMessageId?: string;
      timezone?: string;
      timeoutMs?: number;
      principalId?: string;
      scopes?: string[];
      executionContext?: FridayAgentExecutionContext;
      taskProfile?: FridayAgentTaskProfileInput;
      persistTaskMessage?: boolean;
      taskAlreadyInHistory?: boolean;
    }) => {
      const runId = deps.idGenerator();
      return executeAgentRunWithSessionContext!({
        task: input.task,
        runId,
        sessionKey: input.sessionKey,
        providerId: input.providerId,
        model: input.model,
        replyToMessageId: input.replyToMessageId,
        timezone: input.timezone,
        timeoutMs: input.timeoutMs,
        principalId: input.principalId,
        scopes: input.scopes,
        executionContext: input.executionContext,
        taskProfile: input.taskProfile,
        persistTaskMessage: input.persistTaskMessage,
        taskAlreadyInHistory: input.taskAlreadyInHistory,
        idempotencyPrefix: "api-session-run",
      });
    }
    : undefined;

  // OC-012: Keep session usage routes grouped ahead of main session routes.
  // Route lookup now prefers more specific static patterns, so this order
  // documents intent without being a shadowing workaround.
  for (const route of createFridaySessionUsageRoutes({ db: deps.db })) {
    routes.register(route);
  }

  for (const route of createFridaySessionRoutes({ sessionService, extractionService, runSession })) {
    routes.register(route);
  }

  // Register plugin routes (optional — only if service is provided)
  if (deps.pluginService && deps.pluginManifestLoader) {
    for (const route of createFridayPluginRoutes({
      pluginService: deps.pluginService,
      manifestLoader: deps.pluginManifestLoader,
    })) {
      routes.register(route);
    }
  }

  // Register agent routes (optional — only if runtime and emitter are provided)
  let agentAutomationService: FridayAgentAutomationService | undefined;
  if (deps.agentRuntime && deps.agentEventEmitter && agentRepo && agentRunEventRepo) {
    const agentAbortControllers = new Map<string, AbortController>();

    const startRun = async (input: {
      task: string;
      sessionKey?: string;
      providerId?: string;
      model?: string;
      replyToMessageId?: string;
      timezone?: string;
      timeoutMs?: number;
      requireReview?: boolean;
      constraints?: { readOnly?: boolean };
      executionContext?: FridayAgentExecutionContext;
      taskProfile?: FridayAgentTaskProfileInput;
      principalId?: string;
      scopes?: string[];
    }) => {
      // Create the AbortController and pre-generate the runId BEFORE starting
      // the run so that cancelRun can abort in-flight execution.
      const abortController = new AbortController();
      const runId = deps.idGenerator();
      agentAbortControllers.set(runId, abortController);

      try {
        return await executeAgentRunWithSessionContext!({
          task: input.task,
          runId,
          sessionKey: input.sessionKey,
          providerId: input.providerId,
          model: input.model,
          replyToMessageId: input.replyToMessageId,
          timezone: input.timezone,
          timeoutMs: input.timeoutMs,
          signal: abortController.signal,
          reviewRequired: input.requireReview,
          constraints: input.constraints,
          principalId: input.principalId,
          scopes: input.scopes,
          executionContext: input.executionContext,
          taskProfile: input.taskProfile,
          idempotencyPrefix: "api-agent-run",
        });
      } finally {
        agentAbortControllers.delete(runId);
      }
    };

    agentAutomationService = createFridayAgentAutomationService({
      db: deps.db,
      repository: createFridayAgentAutomationRepository(),
      startRun,
      idGenerator: deps.idGenerator,
      nowIso: deps.nowIso,
      learningEventWriter: deps.learningEventWriter,
      learningUserId: deps.learningUserId,
      resolveSourceSessionKey: (sourceRunId) =>
        deps.db.withReadConnection((db) => agentRepo.getById(db, sourceRunId)?.sessionKey ?? null),
    });

    for (const route of createFridayAgentRoutes({
      assertListingEntitled: async (listingId, principalId) => {
        if (!deps.marketplaceEntitlementCheck) return;
        await deps.marketplaceEntitlementCheck({
          listingId,
          principalId,
        });
      },
      startRun,
      getRun: (runId) => {
        return deps.db.withReadConnection((db) =>
          agentRepo.getById(db, runId),
        );
      },
      listRuns: (query) => {
        return deps.db.withReadConnection((db) =>
          agentRepo.list(db, query),
        );
      },
      listRunEvents: (runId, afterSeq) => {
        return deps.db.withReadConnection((db) =>
          agentRunEventRepo.list(db, runId, afterSeq),
        );
      },
      cancelRun: (runId) => {
        const controller = agentAbortControllers.get(runId);
        if (controller) {
          controller.abort(new Error("Cancelled via API"));
          agentAbortControllers.delete(runId);
        }
      },
      approvePlan: async (runId) => {
        if (!agentPlanningGate) {
          throw new FridayDomainError("AGENT_PLAN_NOT_AVAILABLE", "Planning gate is not available", { httpStatus: 501 });
        }
        const result = await agentPlanningGate.approvePlan({ runId });
        const run = deps.db.withReadConnection((db) => agentRepo.getById(db, runId));
        if (run?.sessionKey) {
          await sessionService.addMessage(run.sessionKey, {
            role: "assistant",
            content: result.response,
            contentText: result.response,
            idempotencyKey: `agent-run:${result.runId}:response`,
          }).catch(() => undefined);
          const currentFocus = await sessionService.getConversationFocus(run.sessionKey).catch(() => null);
          const nextPendingPlanRunId = result.status === "awaiting_clarification"
            || result.status === "awaiting_plan_approval"
            ? result.runId
            : null;
          await sessionService.setConversationFocus(
            run.sessionKey,
            finalizeFridayConversationFocus({
              task: run.task,
              responseText: result.response,
              runId: result.runId,
              turnKind: result.status === "awaiting_clarification"
                ? "clarification"
                : "continue_active_task",
              focusState: currentFocus,
              pendingPlanRunId: nextPendingPlanRunId,
              nowIso: deps.nowIso(),
            }),
          ).catch(() => undefined);
        }
        return result;
      },
      rejectPlan: async (runId) => {
        if (!agentPlanningGate) {
          throw new FridayDomainError("AGENT_PLAN_NOT_AVAILABLE", "Planning gate is not available", { httpStatus: 501 });
        }
        const result = agentPlanningGate.rejectPlan({ runId });
        const run = deps.db.withReadConnection((db) => agentRepo.getById(db, runId));
        if (run?.sessionKey) {
          await sessionService.addMessage(run.sessionKey, {
            role: "assistant",
            content: result.response,
            contentText: result.response,
            idempotencyKey: resolveAgentMirrorIdempotencyKey({
              runId: result.runId,
              kind: "planning-reject",
            }),
          }).catch(() => undefined);
          const currentFocus = await sessionService.getConversationFocus(run.sessionKey).catch(() => null);
          await sessionService.setConversationFocus(run.sessionKey, {
            ...(currentFocus ?? { updatedAt: deps.nowIso() }),
            pendingPlanRunId: undefined,
            updatedAt: deps.nowIso(),
          }).catch(() => undefined);
        }
        return result;
      },
      eventEmitter: deps.agentEventEmitter,
      automationService: agentAutomationService,
    })) {
      routes.register(route);
    }
  }

  // Register sub-agent routes (optional — only if subagentRegistry is provided)
  if (deps.subagentRegistry) {
    for (const route of createFridaySubagentRoutes({
      subagentRegistry: deps.subagentRegistry,
    })) {
      routes.register(route);
    }
  }

  return {
    auth: authService,
    tokenValidator,
    rateLimiter,
    middleware,
    eventBus,
    subscriptions,
    wsGateway,
    fleet,
    conflicts,
    routes,
    workflowCrud: workflowRuntime.crud,
    workflowExecution: workflowRuntime.execution,
    draftService: builderRuntime.drafts,
    providerService: deps.providerService,
    memoryService: deps.memoryService,
    memoryGuardFactory,
    sessionService,
    extractionService,
    skillGenerator: deps.skillGenerator,
    converterService: deps.converterService,
    workflowGenerator: deps.workflowGenerator,
    pluginService: deps.pluginService,
    agentRuntime: deps.agentRuntime,
    agentEventEmitter: deps.agentEventEmitter,
    agentAutomationService,
    mcpServer: deps.mcpServer,
    deterministicPipeline: deps.deterministicPipeline,
    diagnosis: deps.diagnosis,
    autoFix: deps.autoFix,
    agentLoop: deps.agentLoop,
    uix: deps.uix,
    system: deps.system,
  };
}
