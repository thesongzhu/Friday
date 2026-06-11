import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import type { FridayMcpAdapter } from "../../agent/mcp/friday-mcp-adapter.types.js";
import type { FridayAutonomyCanaryStats } from "../model/friday-autonomy-upgrade.types.js";
import type { FridayAutonomySubjectUpgradeStateRepository } from "../persistence/friday-autonomy-subject-upgrade-state-repository.js";
import type { FridayAutonomySubjectUpgradeState } from "../persistence/friday-autonomy-subject-upgrade-state-repository.js";
import {
  createFridayMutatingActionDigest,
  type FridayCanonicalApprovalResolution,
  type FridayMutatingActionActor,
  type FridayMutatingActionGate,
  type FridayMutatingActionRequest,
  type FridayMutatingActionRollbackScope,
  type FridayMutatingActionTicket,
} from "../../security/friday-mutating-action-gate.js";
import { resolveSafePath, safeDirName } from "#utilities";
import { redactContext } from "../../rules/engine/context-redactor.js";
import type { JsonObject } from "../../rules/model/friday-rules-engine.types.js";

type FridayMcpServerLifecycleAction = "shadow" | "canary" | "promote" | "rollback";

export interface FridayMcpServerLifecycleApprovalRequestInput {
  action: FridayMcpServerLifecycleAction;
  serverId: string;
  shadowVersionId?: string;
  runtimeVersion: string;
  providerModel?: string;
  actor: FridayMutatingActionActor;
  surface: string;
  planDigest: string;
  idempotencyKey?: string;
  rollback?: FridayMutatingActionRollbackScope;
}

export interface FridayMcpServerLifecycleEvidenceSummary {
  serverId: string;
  shadowVersionId?: string;
  stage: "shadow" | "canary" | "active" | "rolled_back";
  lastEventAt: string;
  canarySuccessCount: number;
  canaryFailureCount: number;
  rollbackPointerAvailable: boolean;
  serverConfigDigest?: string;
}

export interface FridayMcpServerUpgradeLifecycleService {
  registerShadowVersion(input: {
    serverId: string;
    shadowVersionId: string;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): void;
  recordCanaryResult(input: {
    serverId: string;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): Promise<void>;
  promote(input: {
    serverId: string;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): void;
  rollback(input: {
    serverId: string;
    runtimeVersion: string;
    providerModel?: string;
    reason?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): void;
  getLifecycleEvidence(input: { serverId: string }): FridayMcpServerLifecycleEvidenceSummary | null;
}

export interface CreateFridayMcpServerUpgradeLifecycleServiceDeps {
  db: FridaySqliteLayer;
  stateRepo: FridayAutonomySubjectUpgradeStateRepository;
  mcpAdapter: Pick<FridayMcpAdapter, "listServers" | "listTools">;
  nowIso: () => string;
  stateDir?: string;
  canonicalMutationGate?: FridayMutatingActionGate;
  /**
   * Test-oracle only: allows the legacy TypeScript MCP-server upgrade-lifecycle
   * mutations (`registerShadowVersion`/`recordCanaryResult`/`promote`/`rollback`)
   * in isolated test/validation harnesses. Default/live runtime must leave this
   * unset so the methods fail closed for ALL callers (the autonomy route guard,
   * assertAutonomyLifecycleTestOracleAllowed, is bypassed by a direct method
   * call). Reads (getLifecycleEvidence) stay live. Never default on in prod.
   */
  allowTestOnlyAutonomyLifecycleExecution?: boolean;
}

interface McpServerLifecycleSnapshot {
  lastVerifiedAt?: string;
  lastVerifiedRuntimeVersion?: string;
  lastVerifiedProviderModel?: string;
  compatibilityStatus: FridayAutonomySubjectUpgradeState["compatibilityStatus"];
  promotionChannel: FridayAutonomySubjectUpgradeState["promotionChannel"];
  shadowVersionId?: string;
  canaryStats?: FridayAutonomyCanaryStats;
}

interface McpServerLifecycleEvidenceRecord {
  schemaVersion: "friday.mcp_server.lifecycle.phase3.2C.v1";
  serverId: string;
  events: Array<Record<string, unknown>>;
  shadow?: {
    shadowVersionId: string;
    serverConfigDigest: string;
    shadowedAt: string;
    ticketId: string;
    actionDigest: string;
    planDigest?: string;
    previous: McpServerLifecycleSnapshot;
  };
  canaryRuns: Array<{
    runId: string;
    shadowVersionId?: string;
    success: boolean;
    toolCount: number;
    errorCode?: string;
    errorMessage?: string;
    ticketId: string;
    actionDigest: string;
    planDigest?: string;
    startedAt: string;
    endedAt: string;
  }>;
  promotion?: {
    promotedAt: string;
    shadowVersionId?: string;
    ticketId: string;
    actionDigest: string;
    planDigest: string;
  };
  rollback?: {
    rolledBackAt: string;
    reason?: string;
    result: "restored_previous_mcp_lifecycle_state";
    ticketId: string;
    actionDigest: string;
    planDigest: string;
  };
}

export function createFridayMcpServerLifecycleMutatingActionRequest(
  input: FridayMcpServerLifecycleApprovalRequestInput,
): FridayMutatingActionRequest {
  const parameters = {
    serverId: input.serverId,
    shadowVersionId: input.shadowVersionId,
    runtimeVersion: input.runtimeVersion,
    providerModel: input.providerModel,
  };
  return {
    action: `mcp_servers.lifecycle.${input.action}`,
    actor: input.actor,
    surface: input.surface,
    resource: {
      type: "mcp_server_lifecycle",
      id: input.serverId,
      digest: hashStableJson(parameters),
      attributes: {
        serverId: input.serverId,
        shadowVersionId: input.shadowVersionId,
        lifecycleAction: input.action,
      },
    },
    mutating: true,
    risk: "high",
    parameters,
    planDigest: input.planDigest,
    rollback: input.rollback,
    idempotencyKey: input.idempotencyKey,
    localClaims: [
      {
        guardId: "mcp_server_lifecycle_guard",
        decision: "requires_approval",
        risk: "high",
        reason: `mcp_server_${input.action}_requires_canonical_approval`,
      },
    ],
  };
}

export function createFridayMcpServerUpgradeLifecycleService(
  deps: CreateFridayMcpServerUpgradeLifecycleServiceDeps,
): FridayMcpServerUpgradeLifecycleService {
  // ─── TS Runtime Retirement: METHOD-level fail-closed guard ───
  // Defense-in-depth (orphan off-route leak audit, 2026-06-10): the autonomy MCP-
  // server upgrade-lifecycle mutations were ROUTE-only-guarded (friday-autonomy-
  // routes asserts allowTestOnlyAutonomyLifecycleExecution before the mcpServer-
  // Actions handlers). No autonomy self-upgrade scheduler is wired today (these
  // are route-deps-only), but a future auto-promotion loop would bypass the route
  // fence. Each lifecycle mutation fails closed BEFORE the canonical-ticket check
  // and any state write unless the explicit test-oracle flag is set. Mirrors the
  // route's advertised 503 code (TS_RUNTIME_AUTONOMY_LIFECYCLE_RETIRED).
  function assertAutonomyLifecycleExecutionAllowed(): void {
    if (deps.allowTestOnlyAutonomyLifecycleExecution !== true) {
      throw new FridayDomainError(
        "TS_RUNTIME_AUTONOMY_LIFECYCLE_RETIRED",
        "TypeScript MCP-server upgrade lifecycle is fail-closed in default/live runtime; use the Rust-owned autonomy lifecycle entrypoint.",
        {
          httpStatus: 503,
          details: {
            classification: "fail_closed",
            replacement: "rust_owned_autonomy_lifecycle_entrypoint_required",
          },
        },
      );
    }
  }

  function getServer(serverId: string): ReturnType<FridayMcpAdapter["listServers"]>[number] {
    const found = deps.mcpAdapter.listServers().find((server) => server.id === serverId);
    if (!found) {
      throw new FridayDomainError("MCP_SERVER_NOT_FOUND", `MCP server ${serverId} not found`, { httpStatus: 404 });
    }
    return found;
  }

  function getCanaryStats(serverId: string): FridayAutonomyCanaryStats {
    const state = deps.db.withReadConnection((db) => deps.stateRepo.get(db, "mcp_server", serverId));
    return state?.canaryStats ?? {
      sampleSize: 0,
      successCount: 0,
      failureCount: 0,
      rollbackCount: 0,
    };
  }

  function getState(serverId: string): FridayAutonomySubjectUpgradeState | null {
    return deps.db.withReadConnection((db) => deps.stateRepo.get(db, "mcp_server", serverId));
  }

  function update(
    serverId: string,
    patch: Parameters<FridayAutonomySubjectUpgradeStateRepository["setUpgradeMetadata"]>[3],
  ): void {
    getServer(serverId);
    deps.db.withWriteTransaction((db) => {
      deps.stateRepo.setUpgradeMetadata(db, "mcp_server", serverId, patch, deps.nowIso());
    });
  }

  function requireCanonicalLifecycleTicket(input: {
    action: FridayMcpServerLifecycleAction;
    serverId: string;
    shadowVersionId?: string;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest?: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
    rollback?: FridayMutatingActionRollbackScope;
  }): FridayMutatingActionTicket {
    if (!deps.canonicalMutationGate) {
      throw new FridayDomainError(
        "MCP_SERVER_LIFECYCLE_CANONICAL_GATE_UNAVAILABLE",
        "MCP server lifecycle actions require the canonical approval gate.",
        { httpStatus: 503 },
      );
    }
    const planDigest = input.planDigest;
    if (!planDigest) {
      throw new FridayDomainError(
        "MCP_SERVER_LIFECYCLE_PLAN_DIGEST_REQUIRED",
        "MCP server lifecycle actions require an approved plan digest.",
        { httpStatus: 403, details: { serverId: input.serverId } },
      );
    }

    const request = createFridayMcpServerLifecycleMutatingActionRequest({
      ...input,
      planDigest,
    });
    const gateResult = deps.canonicalMutationGate.evaluate({
      ...request,
      canonicalApproval: input.canonicalApproval,
    });
    if (gateResult.decision !== "allow" || !gateResult.ticket) {
      throw new FridayDomainError(
        gateResult.decision === "requires_approval"
          ? "MCP_SERVER_LIFECYCLE_CANONICAL_APPROVAL_REQUIRED"
          : "MCP_SERVER_LIFECYCLE_CANONICAL_APPROVAL_DENIED",
        gateResult.decision === "requires_approval"
          ? `MCP server lifecycle ${input.action} requires canonical approval before any mutation.`
          : `MCP server lifecycle ${input.action} was blocked by the canonical approval gate: ${gateResult.reason}`,
        {
          httpStatus: gateResult.decision === "requires_approval" ? 403 : 409,
          details: {
            serverId: input.serverId,
            action: input.action,
            actionDigest: gateResult.actionDigest,
            reason: gateResult.reason,
          },
        },
      );
    }
    return gateResult.ticket;
  }

  function snapshotState(serverId: string): McpServerLifecycleSnapshot {
    const state = getState(serverId);
    return {
      lastVerifiedAt: state?.lastVerifiedAt,
      lastVerifiedRuntimeVersion: state?.lastVerifiedRuntimeVersion,
      lastVerifiedProviderModel: state?.lastVerifiedProviderModel,
      compatibilityStatus: state?.compatibilityStatus ?? "unknown",
      promotionChannel: state?.promotionChannel ?? "none",
      shadowVersionId: state?.shadowVersionId,
      canaryStats: state?.canaryStats,
    };
  }

  function evidencePath(serverId: string): string | null {
    if (!deps.stateDir) return null;
    const root = resolveSafePath(deps.stateDir, "mcp-server-lifecycle");
    return resolveSafePath(root, `${safeDirName(serverId)}.json`);
  }

  function readEvidence(serverId: string): McpServerLifecycleEvidenceRecord {
    const file = evidencePath(serverId);
    if (file && existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as McpServerLifecycleEvidenceRecord;
      return {
        ...parsed,
        events: Array.isArray(parsed.events) ? parsed.events : [],
        canaryRuns: Array.isArray(parsed.canaryRuns) ? parsed.canaryRuns : [],
      };
    }
    return {
      schemaVersion: "friday.mcp_server.lifecycle.phase3.2C.v1",
      serverId,
      events: [],
      canaryRuns: [],
    };
  }

  function writeEvidence(record: McpServerLifecycleEvidenceRecord): void {
    const file = evidencePath(record.serverId);
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  function updateEvidence(
    serverId: string,
    updateRecord: (record: McpServerLifecycleEvidenceRecord) => void,
  ): McpServerLifecycleEvidenceRecord {
    const record = readEvidence(serverId);
    updateRecord(record);
    writeEvidence(record);
    return record;
  }

  function serverConfigDigest(serverId: string): string {
    const server = getServer(serverId);
    return hashStableJson({
      id: server.id,
      transport: server.transport ?? (server.url ? "http" : "stdio"),
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      url: server.url,
      policy: server.policy,
      timeoutMs: server.timeoutMs,
      envKeys: server.env ? Object.keys(server.env).sort() : [],
      headerKeys: server.headers ? Object.keys(server.headers).sort() : [],
    });
  }

  return {
    registerShadowVersion(input) {
      assertAutonomyLifecycleExecutionAllowed();
      const ticket = requireCanonicalLifecycleTicket({
        action: "shadow",
        serverId: input.serverId,
        shadowVersionId: input.shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
      });
      const previous = snapshotState(input.serverId);
      const digest = serverConfigDigest(input.serverId);
      update(input.serverId, {
        compatibilityStatus: "adaptation_required",
        promotionChannel: "shadow",
        shadowVersionId: input.shadowVersionId,
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
      updateEvidence(input.serverId, (record) => {
        record.events.push({
          type: "shadow",
          at: deps.nowIso(),
          shadowVersionId: input.shadowVersionId,
          ticketId: ticket.ticketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
        });
        record.shadow = {
          shadowVersionId: input.shadowVersionId,
          serverConfigDigest: digest,
          shadowedAt: deps.nowIso(),
          ticketId: ticket.ticketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
          previous,
        };
      });
    },

    async recordCanaryResult(input) {
      assertAutonomyLifecycleExecutionAllowed();
      const state = getState(input.serverId);
      const shadowVersionId = state?.shadowVersionId;
      if (state?.promotionChannel !== "shadow" && state?.promotionChannel !== "canary") {
        throw new FridayDomainError(
          "MCP_SERVER_CANARY_REQUIRES_SHADOW",
          "MCP server canary requires a shadow lifecycle state first.",
          { httpStatus: 409, details: { serverId: input.serverId } },
        );
      }
      const ticket = requireCanonicalLifecycleTicket({
        action: "canary",
        serverId: input.serverId,
        shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
      });
      const current = getCanaryStats(input.serverId);
      const startedAt = deps.nowIso();
      const runId = `mcp_canary_${createHash("sha256").update(`${input.serverId}:${startedAt}:${ticket.actionDigest}`).digest("hex").slice(0, 16)}`;
      let toolCount = 0;
      try {
        const tools = await deps.mcpAdapter.listTools({ serverId: input.serverId });
        toolCount = tools.length;
      } catch (error) {
        const endedAt = deps.nowIso();
        update(input.serverId, {
          compatibilityStatus: "adaptation_required",
          promotionChannel: "canary",
          canaryStats: {
            sampleSize: current.sampleSize + 1,
            successCount: current.successCount,
            failureCount: current.failureCount + 1,
            rollbackCount: current.rollbackCount,
            lastEvaluatedAt: endedAt,
          },
        });
        updateEvidence(input.serverId, (record) => {
          record.events.push({
            type: "canary",
            at: endedAt,
            success: false,
            runId,
            ticketId: ticket.ticketId,
            actionDigest: ticket.actionDigest,
            planDigest: ticket.planDigest,
          });
          record.canaryRuns.push({
            runId,
            shadowVersionId,
            success: false,
            toolCount,
            errorCode: error instanceof FridayDomainError ? error.code : "MCP_SERVER_CANARY_RUNTIME_ERROR",
            errorMessage: redactMcpLifecycleErrorMessage(error),
            ticketId: ticket.ticketId,
            actionDigest: ticket.actionDigest,
            planDigest: ticket.planDigest,
            startedAt,
            endedAt,
          });
        });
        throw new FridayDomainError(
          "MCP_SERVER_CANARY_RUNTIME_PROOF_FAILED",
          `MCP server ${input.serverId} failed read-only canary smoke: ${redactMcpLifecycleErrorMessage(error)}`,
          { httpStatus: 424, details: { serverId: input.serverId, runId } },
        );
      }
      const endedAt = deps.nowIso();
      update(input.serverId, {
        compatibilityStatus: "compatible",
        promotionChannel: "canary",
        canaryStats: {
          sampleSize: current.sampleSize + 1,
          successCount: current.successCount + 1,
          failureCount: current.failureCount,
          rollbackCount: current.rollbackCount,
          lastEvaluatedAt: endedAt,
        },
      });
      updateEvidence(input.serverId, (record) => {
        record.events.push({
          type: "canary",
          at: endedAt,
          success: true,
          runId,
          ticketId: ticket.ticketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
        });
        record.canaryRuns.push({
          runId,
          shadowVersionId,
          success: true,
          toolCount,
          ticketId: ticket.ticketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
          startedAt,
          endedAt,
        });
      });
    },

    promote(input) {
      assertAutonomyLifecycleExecutionAllowed();
      const current = getState(input.serverId);
      const evidence = readEvidence(input.serverId);
      if (current?.promotionChannel !== "canary") {
        throw new FridayDomainError(
          "MCP_SERVER_PROMOTE_REQUIRES_CANARY",
          "MCP server promote requires a canary lifecycle state first.",
          { httpStatus: 409, details: { serverId: input.serverId } },
        );
      }
      if (!current.shadowVersionId || !evidence.shadow) {
        throw new FridayDomainError(
          "MCP_SERVER_PROMOTE_REQUIRES_ROLLBACK_POINTER",
          "MCP server promote requires a shadow rollback pointer.",
          { httpStatus: 409, details: { serverId: input.serverId } },
        );
      }
      if (!current.canaryStats || current.canaryStats.successCount < 1 || current.canaryStats.failureCount > 0) {
        throw new FridayDomainError(
          "MCP_SERVER_PROMOTE_REQUIRES_GREEN_CANARY",
          "MCP server promote requires at least one successful canary and zero failed canaries.",
          { httpStatus: 409, details: { serverId: input.serverId, canaryStats: current.canaryStats } },
        );
      }
      const ticket = requireCanonicalLifecycleTicket({
        action: "promote",
        serverId: input.serverId,
        shadowVersionId: current.shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
      });
      update(input.serverId, {
        compatibilityStatus: "compatible",
        promotionChannel: "active",
        shadowVersionId: current?.shadowVersionId ?? null,
        canaryStats: current?.canaryStats ?? null,
        lastVerifiedAt: deps.nowIso(),
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
      updateEvidence(input.serverId, (record) => {
        record.events.push({
          type: "promote",
          at: deps.nowIso(),
          ticketId: ticket.ticketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
        });
        record.promotion = {
          promotedAt: deps.nowIso(),
          shadowVersionId: current.shadowVersionId,
          ticketId: ticket.ticketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest!,
        };
      });
    },

    rollback(input) {
      assertAutonomyLifecycleExecutionAllowed();
      const current = getCanaryStats(input.serverId);
      const evidence = readEvidence(input.serverId);
      const rollbackTarget = evidence.shadow?.previous;
      if (!evidence.promotion || !rollbackTarget) {
        throw new FridayDomainError(
          "MCP_SERVER_ROLLBACK_REQUIRES_PROMOTION_EVIDENCE",
          "MCP server rollback requires promotion evidence and a rollback pointer.",
          { httpStatus: 409, details: { serverId: input.serverId } },
        );
      }
      const ticket = requireCanonicalLifecycleTicket({
        action: "rollback",
        serverId: input.serverId,
        shadowVersionId: evidence.promotion.shadowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
        rollback: { planned: true, planDigest: input.planDigest, actions: ["mcp_servers.lifecycle.promote"] },
      });
      update(input.serverId, {
        compatibilityStatus: rollbackTarget.compatibilityStatus === "compatible" && rollbackTarget.promotionChannel === "active"
          ? "compatible"
          : "adaptation_required",
        promotionChannel: rollbackTarget.promotionChannel === "active" ? "active" : "rolled_back",
        shadowVersionId: rollbackTarget.shadowVersionId ?? null,
        canaryStats: {
          sampleSize: current.sampleSize,
          successCount: current.successCount,
          failureCount: current.failureCount,
          rollbackCount: current.rollbackCount + 1,
          lastEvaluatedAt: deps.nowIso(),
        },
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
      updateEvidence(input.serverId, (record) => {
        record.events.push({
          type: "rollback",
          at: deps.nowIso(),
          reason: input.reason,
          ticketId: ticket.ticketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest,
        });
        record.rollback = {
          rolledBackAt: deps.nowIso(),
          reason: input.reason,
          result: "restored_previous_mcp_lifecycle_state",
          ticketId: ticket.ticketId,
          actionDigest: ticket.actionDigest,
          planDigest: ticket.planDigest!,
        };
      });
    },

    getLifecycleEvidence(input) {
      const evidence = readEvidence(input.serverId);
      const lastEvent = evidence.events.at(-1);
      if (!lastEvent) return null;
      return {
        serverId: input.serverId,
        shadowVersionId: evidence.shadow?.shadowVersionId,
        stage: evidence.rollback ? "rolled_back" : evidence.promotion ? "active" : evidence.canaryRuns.length > 0 ? "canary" : "shadow",
        lastEventAt: typeof lastEvent.at === "string" ? lastEvent.at : deps.nowIso(),
        canarySuccessCount: evidence.canaryRuns.filter((run) => run.success).length,
        canaryFailureCount: evidence.canaryRuns.filter((run) => !run.success).length,
        rollbackPointerAvailable: evidence.shadow !== undefined,
        serverConfigDigest: evidence.shadow?.serverConfigDigest,
      };
    },
  };
}

function hashStableJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function redactMcpLifecycleErrorMessage(error: unknown): string {
  const message = sanitizeMcpLifecycleErrorMessage(error instanceof Error ? error.message : String(error));
  const redacted = redactContext({
    errorMessage: message,
  } satisfies JsonObject, {
    maxStringLength: 512,
  }).redacted;
  const value = redacted.errorMessage;
  return typeof value === "string" ? value : "[REDACTED]";
}

function sanitizeMcpLifecycleErrorMessage(message: string): string {
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_SECRET]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED_SECRET]")
    .replace(/([?&](?:token|api[_-]?key|key|secret|authorization)=)[^&\s]+/gi, "$1[REDACTED_SECRET]")
    .replace(/\b((?:token|api[_-]?key|secret|password|credential)\s*[:=]\s*)\S+/gi, "$1[REDACTED_SECRET]");
}
