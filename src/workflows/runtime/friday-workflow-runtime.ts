import { FridayDomainError } from "#errors";
import * as fs from "node:fs";
import * as path from "node:path";

import type { FridaySqliteLayer } from "#state";
import { safeJsonParse } from "#utilities";
import {
  AcceptanceTestSuiteRunner,
  type FridayAcceptanceArtifactType,
  type FridayAcceptanceCheckConfig,
  type FridayAcceptanceTest,
  InMemoryTestRegistry,
} from "#acceptance";
import {
  createNodeRunnerPipeline,
  type FridayNodeArtifact,
  NodeAdapterRegistry,
} from "#node-runner";
import {
  createLearningEngine,
  createPlaybookMatcher,
  createPromotionEngine,
  createScoreCalculator,
  createSqlitePlaybookStore,
  createVersionManager,
  FRIDAY_DEFAULT_PROMOTION_RULES,
  FRIDAY_PLAYBOOK_TIE_BREAK_ORDER,
  type FridayPlaybookEngineConfig,
} from "#playbook";
import {
  createFridayRulesRepository,
  type FridayEvaluationContext,
  type FridayEvaluationResult,
  type FridayPolicyBundle,
  type FridayPolicyBundleRow,
  type FridayRule,
  FridayRuleEngine,
  type FridayRuleRow,
} from "#rules";
import type {
  FridayFailureCategory,
  FridayRetryCircuitBreakerRecord,
  FridayRetryEscalationTarget,
  FridayRetryPolicy,
  FridayRetryPolicyRow,
} from "../../retry/model/friday-retry-engine.types.js";
import { createFridayRetryRepository } from "../../retry/persistence/friday-retry-repository.js";
import {
  buildDefaultRetryPolicy,
  DEFAULT_UNIFIED_RETRY_POLICY_ID,
} from "../../retry/engine/friday-default-retry-policy.js";
import type {
  JsonObject,
} from "../model/friday-workflow.types.js";
import type { FridayCompiledWorkflowGraphV2 } from "../model/friday-workflow-graph.types.js";
import type {
  FridayWorkflowEvidenceEvent,
  FridayWorkflowEvidenceModule,
  FridayWorkflowPlaybookEvidenceTrace,
  FridayWorkflowRetryEvidenceTrace,
  FridayWorkflowRunEvidenceCorrelationRow,
  FridayWorkflowRunEvidenceExport,
  FridayWorkflowRunEvidenceExportDownload,
  FridayWorkflowRunEvidenceExportRecord,
  FridayWorkflowRunEvidenceQuery,
  FridayWorkflowRunEvidenceResponse,
  FridayWorkflowRunEvidenceSummary,
  FridayWorkflowRuntime,
} from "./friday-workflow-runtime.types.js";
import type { FridayWorkflowRunEvidenceStatus } from "../model/friday-workflow.types.js";
import type { FridayWorkflowTriggerRepository } from "../persistence/friday-workflow-trigger-repository.js";

import { createFridayWorkflowRepository } from "../persistence/friday-workflow-repository.js";
import { createFridayWorkflowRunRepository } from "../persistence/friday-workflow-run-repository.js";
import { createFridayWorkflowRunNodeRepository } from "../persistence/friday-workflow-run-node-repository.js";
import { createFridayWorkflowArtifactRepository } from "../persistence/friday-workflow-artifact-repository.js";
import { createFridayWorkflowEvidenceRepository } from "../persistence/friday-workflow-evidence-repository.js";

import { createFridayExpressionEvaluator } from "../engine/friday-workflow-expression-evaluator.js";
import { createFridayWorkflowDagScheduler } from "../engine/friday-workflow-dag-scheduler.js";
import { createFridayWorkflowRunMachine } from "../engine/friday-workflow-run-machine.js";
import { createFridayWorkflowNodeMachine } from "../engine/friday-workflow-node-machine.js";
import { createFridayWorkflowRetryManager } from "../engine/friday-workflow-retry-manager.js";
import { createFridayWorkflowNodeExecutor } from "../engine/friday-workflow-node-executor.js";
import {
  classifyWorkflowNodeSideEffect,
  type FridayNodeCompletionVerification,
  resolveNodeCompletionVerification,
} from "./friday-workflow-node-acceptance.js";
import {
  type FridayFilesystemWriteTarget,
  type FridaySnapshot,
  resolveFilesystemWriteTarget,
  snapshotTarget,
  verifyFsWriteEvidence,
} from "./friday-workflow-fs-write-verifier.js";
import { createFridayWorkflowArtifactWriter } from "../engine/friday-workflow-artifact-writer.js";
import { createFridayWorkflowNodeRunnerFacade } from "../engine/friday-workflow-node-runner-facade.js";
import { createFridayWorkflowAcceptanceGate } from "../engine/friday-workflow-acceptance-gate.js";
import {
  resolveFridayPipelineRetryConfig,
  resolveFridayPipelineRuntimeConfig,
} from "../engine/friday-workflow-pipeline-mode.js";
import { createWorkflowPlaybookBridge } from "../engine/friday-workflow-playbook-bridge.js";
import { classifyWorkflowError, createWorkflowUnifiedRetryBridge } from "../engine/friday-workflow-unified-retry-bridge.js";
import { createPipelineEventEmitter, type PipelineEvent } from "../engine/friday-workflow-pipeline-event-taxonomy.js";
import { createWorkflowNodeRunnerDelegatingAdapters } from "../engine/friday-workflow-node-runner-adapters.js";

import { createFridayWorkflowCrudService } from "../services/friday-workflow-crud-service.js";
import { createFridayWorkflowExecutionService } from "../services/friday-workflow-execution-service.js";
import type { CreateWorkflowExecutionServiceDeps } from "../services/friday-workflow-execution-service.js";
import { createFridayWorkflowTriggerService } from "../services/friday-workflow-trigger-service.js";
import { createFridayWorkflowApprovalRepository } from "../persistence/friday-workflow-approval-repository.js";
import { createFridayWorkflowApprovalService } from "../services/friday-workflow-approval-service.js";

const RULES_EVALUATE_SCOPE = "rules:evaluate";
const WORKFLOW_NODE_RUNNER_DEFAULT_TIMEOUT_MS = 30_000;
const ALL_EVIDENCE_MODULES: readonly FridayWorkflowEvidenceModule[] = [
  "rules",
  "node-runner",
  "acceptance",
  "retry",
  "playbook",
] as const;

const ACCEPTANCE_ARTIFACT_TYPES: readonly FridayAcceptanceArtifactType[] = [
  "json",
  "text",
  "file",
  "image",
  "audio",
  "video",
] as const;
const ZERO_RETRY_COST = { tokens: 0, apiCalls: 0, computeMs: 0 } as const;
const DEFAULT_UNIFIED_RETRY_POLICY_ETAG = `${DEFAULT_UNIFIED_RETRY_POLICY_ID}-v1`;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRetryCategoryRetryable(category: FridayFailureCategory): boolean {
  return category === "timeout" || category === "transient" || category === "rate_limit";
}

function toRetryFailureSeverity(category: FridayFailureCategory): "critical" | "major" | "minor" | "info" {
  switch (category) {
    case "auth":
    case "rate_limit":
      return "critical";
    case "timeout":
    case "transient":
    case "resource":
    case "logic":
      return "major";
    case "unknown":
      return "minor";
  }
}

function toRetryEscalationTarget(category: FridayFailureCategory): FridayRetryEscalationTarget {
  switch (category) {
    case "logic":
    case "transient":
    case "unknown":
      return "developer";
    default:
      return "operator";
  }
}

function toWorkflowRetryTraceStatus(decision: {
  shouldRetry: boolean;
  budgetExhausted: boolean;
  escalateToDlq: boolean;
}): "in_progress" | "budget_exceeded" | "escalated" | "exhausted" {
  if (decision.shouldRetry) {
    return "in_progress";
  }
  if (decision.budgetExhausted) {
    return "budget_exceeded";
  }
  if (decision.escalateToDlq) {
    return "escalated";
  }
  return "exhausted";
}

function buildRetryTargetId(workflowId: string, nodeId: string): string {
  return `${workflowId}:${nodeId}`;
}

function toEvidenceModule(value: string): FridayWorkflowEvidenceModule | null {
  return (ALL_EVIDENCE_MODULES as readonly string[]).includes(value)
    ? value as FridayWorkflowEvidenceModule
    : null;
}

function normalizeEvidenceQuery(
  query: FridayWorkflowRunEvidenceQuery | undefined,
): FridayWorkflowRunEvidenceQuery {
  const modules = (query?.modules ?? [])
    .map((module) => toEvidenceModule(module))
    .filter((module): module is FridayWorkflowEvidenceModule => module !== null);

  const eventNames = (query?.eventNames ?? [])
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  const limit = typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
    ? Math.floor(query.limit)
    : undefined;
  const attempt = typeof query?.attempt === "number" && Number.isFinite(query.attempt)
    ? Math.floor(query.attempt)
    : undefined;

  return {
    modules: modules.length > 0 ? modules : undefined,
    eventNames: eventNames.length > 0 ? eventNames : undefined,
    nodeId: asString(query?.nodeId),
    attempt,
    limit,
  };
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value || value.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return asRecord(parsed);
  } catch (err) {
    console.warn("[friday][workflow-runtime] parse-json-object:", err instanceof Error ? err.message : String(err));
    return {};
  }
}

function stringifyForKey(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch (err) {
    console.warn("[friday][workflow-runtime] stringify-for-key:", err instanceof Error ? err.message : String(err));
    return "";
  }
}

function normalizePositiveLimit(limit: number | undefined, fallback: number): number {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : fallback;
}

function toFileUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return `file://${normalized}`;
}

function fromFileUri(uri: string): string | null {
  if (!uri.startsWith("file://")) {
    return null;
  }
  return uri.slice("file://".length);
}

function createEmptyEvidenceSummary(): FridayWorkflowRunEvidenceSummary {
  return {
    totalEvents: 0,
    byModule: {
      rules: 0,
      "node-runner": 0,
      acceptance: 0,
      retry: 0,
      playbook: 0,
    },
    retryTraceCount: 0,
    playbookTraceCount: 0,
    acceptanceDecisions: {
      passed: 0,
      warned: 0,
      failed: 0,
    },
  };
}

function mapBundleRow(row: FridayPolicyBundleRow): FridayPolicyBundle {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    version: row.version,
    priority: row.priority,
    enabled: row.enabled === 1,
    tags: (() => {
      const parsed = safeJsonParse(row.tags_json);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    })(),
    source: row.source === "import" || row.source === "system" ? row.source : "user",
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRuleRow(row: FridayRuleRow): FridayRule {
  const conditions = (() => {
    const parsed = safeJsonParse(row.conditions_json);
    return typeof parsed === "object" && parsed !== null
      ? parsed as FridayRule["conditions"]
      : {};
  })();

  return {
    id: row.id,
    policyBundleId: row.policy_bundle_id,
    name: row.name,
    description: row.description ?? undefined,
    enabled: row.enabled === 1,
    resource: row.resource as FridayRule["resource"],
    action: row.action as FridayRule["action"],
    conditions,
    decision: row.decision as FridayRule["decision"],
    message: row.message ?? undefined,
    priority: row.priority,
    version: row.version,
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildPlaybookConfig(deps: Pick<CreateFridayWorkflowRuntimeDeps, "idGenerator" | "nowIso">): FridayPlaybookEngineConfig {
  return {
    scoring: {
      weights: {
        success_rate: 0.4,
        speed: 0.25,
        cost_efficiency: 0.2,
        satisfaction: 0.15,
      },
      decayRate: 0.02,
      autoArchiveDays: 90,
      minSampleSize: 5,
    },
    selection: {
      matchThreshold: 0.6,
      similarityWeight: 0.6,
      scoreWeight: 0.4,
      minTagOverlap: 0,
      maxCandidates: 50,
      tieBreakOrder: [...FRIDAY_PLAYBOOK_TIE_BREAK_ORDER],
    },
    promotion: {
      rules: [...FRIDAY_DEFAULT_PROMOTION_RULES],
      evaluationIntervalHours: 6,
      rollbackConsecutiveWindows: 3,
      rollbackSuccessRateThreshold: 0.5,
    },
    generateId: deps.idGenerator,
    nowIso: deps.nowIso,
  };
}

function inferArtifactType(output: unknown): FridayAcceptanceArtifactType {
  if (typeof output === "string") {
    return "text";
  }
  if (output != null && typeof output === "object") {
    return "json";
  }
  return "json";
}

/**
 * Audit C Stage 2A: collect every URI / path the (UNTRUSTED) node execution
 * RESULT declares as its OWN artifact / receipt. The fs-write verifier refuses
 * to count the declared target as `verified` if it equals any of these — that
 * is exactly the forbidden "skill self-written receipt" / returned-artifact-URI
 * == target circular proof (the delta would be merely the skill's own serialized
 * output, not an independent side effect).
 *
 * Two formal channels are collected (NOT arbitrary output string leaves — a
 * skill legitimately echoing the path it changed, e.g. `summary` /
 * `details.changedPath`, must NOT trip the guard, else nothing could verify):
 *   1. `result.artifacts[].uri` — the formal artifact channel;
 *   2. string values under receipt/artifact-NAMED output keys (`runPath`,
 *      `receiptPath`, `artifactPath`/`artifactUri`, `evidencePath`,
 *      `outputPath`, `uri`, `path`) — how skills like page-benchmark-report
 *      report the evidence file they wrote and returned as their own receipt.
 * These are used ONLY for the refusal — never to source the re-read target.
 */
const RETURNED_ARTIFACT_KEYS: ReadonlySet<string> = new Set([
  "uri",
  "path",
  "runpath",
  "receiptpath",
  "artifactpath",
  "artifacturi",
  "evidencepath",
  "outputpath",
  "reportpath",
  "baselinepath",
]);

function collectReturnedArtifactPaths(result: unknown): string[] {
  const uris: string[] = [];
  const r = result as { artifacts?: unknown; output?: unknown } | null | undefined;
  if (r && typeof r === "object") {
    if (Array.isArray(r.artifacts)) {
      for (const a of r.artifacts) {
        const uri = a != null && typeof a === "object" ? (a as { uri?: unknown }).uri : undefined;
        if (typeof uri === "string" && uri.length > 0) uris.push(uri);
      }
    }
    // Walk output collecting ONLY string values under receipt/artifact-named
    // keys (bounded depth/breadth).
    const seen = new Set<unknown>();
    const walk = (value: unknown, depth: number): void => {
      if (depth > 6 || uris.length > 256) return;
      if (value == null || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) walk(item, depth + 1);
        return;
      }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === "string" && v.length > 0 && RETURNED_ARTIFACT_KEYS.has(k.toLowerCase())) {
          uris.push(v);
        } else {
          walk(v, depth + 1);
        }
      }
    };
    walk(r.output, 0);
  }
  return uris;
}

function normalizeAcceptanceContent(content: unknown): Record<string, unknown> {
  const base = { ...asRecord(content) };
  if (Object.keys(base).length === 0) {
    base.value = content ?? null;
  }
  const count = Array.isArray(content)
    ? content.length
    : typeof content === "string"
      ? Math.max(1, content.length)
      : 1;
  base.__friday_count = count;
  return base;
}

function buildAcceptanceBaselineTest(
  id: string,
  name: string,
  artifactType: FridayAcceptanceArtifactType,
  priority: number,
  checkConfig: FridayAcceptanceCheckConfig,
  nowIso: string,
): FridayAcceptanceTest {
  return {
    id,
    name,
    artifactType,
    checkConfig,
    priority,
    enabled: true,
    shortCircuit: false,
    tags: ["built-in", "workflow"],
    version: 1,
    etag: `${id}-v1`,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

// ─── Dependencies ───

/**
 * Dependencies for creating the workflow runtime composite.
 *
 * `resolveSkill` returns any truthy value to indicate the skill exists;
 * the node executor only checks for null/existence, not the concrete type.
 */
export interface CreateFridayWorkflowRuntimeDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  computeChecksum: (content: string) => string;
  resolveSkill: (skillId: string) => unknown | null;
  /**
   * Workspace root used by the audit-C Stage 2A filesystem-write verifier to
   * anchor scope containment (`${workspaceDir}` + skill-relative resolution).
   * Wired from the hub bootstrap's `workspaceRoot` — the same root the skill
   * registry resolves skill dirs against. Optional (defaults to `process.cwd()`)
   * so existing callers/tests need no change; absent it only weakens fs-write
   * containment to the process cwd, never enabling a false `verified`.
   */
  workspaceDir?: string;
  invokeSkill: (
    skillId: string,
    runId: string,
    nodeId: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
  userRulesContextProvider?: (input: {
    task: string;
    workflowId?: string;
    runId: string;
    nodeId: string;
    surface: "workflow_ai_node";
  }) => string | null | Promise<string | null>;
  publishEvent?: (event: string, payload: unknown) => Promise<void>;
  triggerRepo?: FridayWorkflowTriggerRepository;
  /**
   * Test-oracle ONLY. Threaded into the workflow execution service so its
   * `startRun` method fails closed for every non-route caller (scheduler/cron,
   * webhook, event, channel) unless explicitly enabled. Production hub bootstrap
   * leaves this unset → fail-closed. Mirrors the route-level guard flag.
   */
  allowTestOnlyWorkflowRunExecution?: boolean;
  onRunIntake?: (input: {
    runId: string;
    workflowId: string;
    workflowVersionId: string;
    compiledGraph: FridayCompiledWorkflowGraphV2;
    triggerType: string;
    triggerPayload?: JsonObject;
    context?: JsonObject;
  }) => Promise<{ contextPatch?: JsonObject } | void>;
  onRunCompleted?: CreateWorkflowExecutionServiceDeps["onRunCompleted"];
  resolveWebhookSecretRef?: (refKey: string) => string | null | Promise<string | null>;
}

/** @deprecated Use `CreateFridayWorkflowRuntimeDeps` instead. */
export type CreateWorkflowRuntimeDeps = CreateFridayWorkflowRuntimeDeps;

// ─── Factory ───

export function createFridayWorkflowRuntime(
  deps: CreateFridayWorkflowRuntimeDeps,
): FridayWorkflowRuntime {
  const pipelineConfig = resolveFridayPipelineRuntimeConfig(process.env);
  const pipelineRetryConfig = resolveFridayPipelineRetryConfig(process.env);
  const pipelineEnabled = pipelineConfig.enabled;
  const pipelineEnforceMode = pipelineConfig.mode === "enforce";

  // 1. Repositories
  const workflowRepo = createFridayWorkflowRepository({ db: deps.db });
  const runRepo = createFridayWorkflowRunRepository();
  const nodeRepo = createFridayWorkflowRunNodeRepository();
  const artifactRepo = createFridayWorkflowArtifactRepository();
  const evidenceRepo = createFridayWorkflowEvidenceRepository();
  const retryRepository = createFridayRetryRepository();
  const resolvedDbPath = typeof deps.db.dbPath === "string" && deps.db.dbPath.length > 0
    ? deps.db.dbPath
    : ":memory:";
  const evidenceExportRootDir = resolvedDbPath !== ":memory:"
    ? path.join(path.dirname(resolvedDbPath), "artifacts", "workflow-evidence")
    : path.join(process.cwd(), ".friday", "artifacts", "workflow-evidence");

  // Audit C Stage 2A: workspace root for the filesystem-write verifier's scope
  // containment. Defaults to the process cwd when the hub did not wire it.
  const fsVerifierWorkspaceDir = typeof deps.workspaceDir === "string" && deps.workspaceDir.length > 0
    ? deps.workspaceDir
    : process.cwd();

  // Phase 14.5C: per-run evidence-status tracking. The legacy global
  // `evidencePersistenceAvailable` flag silently masked degraded persistence
  // across every run. We now track one status per run id so the workflow run
  // receipt and downstream task-workflow closeout can honestly reflect what
  // happened for that specific run; proof-required runs additionally fail
  // closed via `persistEvidenceOrFailClosed`.
  const EVIDENCE_RETRY_INTERVAL_MS = 60_000; // Re-check after 60 seconds.
  const evidenceStatusByRunId = new Map<string, FridayWorkflowRunEvidenceStatus>();
  const evidenceDisabledAtByRunId = new Map<string, number>();
  const proofRequiredByRunId = new Map<string, boolean>();

  const shouldDisableEvidencePersistence = (error: unknown): boolean =>
    error instanceof Error && error.message.toLowerCase().includes("no such table");

  const getRunEvidenceStatus = (runId: string): FridayWorkflowRunEvidenceStatus => {
    const status = evidenceStatusByRunId.get(runId) ?? "available";
    if (status === "unavailable") {
      const disabledAt = evidenceDisabledAtByRunId.get(runId) ?? 0;
      if (Date.now() - disabledAt >= EVIDENCE_RETRY_INTERVAL_MS) {
        // Auto-recover to `degraded` so subsequent writes/reads retry, but
        // never silently revert to `available`. A clean run never observed
        // a degrade; a previously-failed run is allowed to recover writes
        // but its receipt still tells the truth that proof was unavailable.
        evidenceStatusByRunId.set(runId, "degraded");
        return "degraded";
      }
    }
    return status;
  };

  const transitionRunEvidenceStatus = (
    runId: string,
    target: FridayWorkflowRunEvidenceStatus,
  ): void => {
    if (target === "available") {
      return; // Never silently downgrade existing degraded/unavailable state.
    }
    const previous = evidenceStatusByRunId.get(runId) ?? "available";
    if (target === "unavailable") {
      evidenceStatusByRunId.set(runId, "unavailable");
      evidenceDisabledAtByRunId.set(runId, Date.now());
      return;
    }
    // `degraded` only overwrites `available`; do not weaken `unavailable`.
    if (previous === "available") {
      evidenceStatusByRunId.set(runId, "degraded");
    }
  };

  // Audit C part-2: RUN-LEVEL completion-verification truth, ORTHOGONAL to
  // evidence-persistence health (`evidenceStatus`). Tracks the worst (least
  // verified) node completion-verification label observed for the run. This is
  // the run-level enforcement surface for the workflow-node false-completion
  // bypasses (arbitrary non-empty baseline pass, output==null skip, and the
  // disabled-pipeline/legacy path): a run whose aggregate is not `verified`
  // cannot be read as a clean/verified completion and is refused as proof
  // backing by the task workflow verifier — as a reason DISTINCT from
  // persistence durability. It NEVER downgrades `evidenceStatus`; conflating
  // the two would falsely report a healthy-persistence run as "degraded"
  // (a reverse lie). Stage 2(B): the worst label is ALSO persisted durably
  // (workflow_runs.completion_verification, v089) so the truth survives a hub
  // restart — the in-memory map is the per-process fast path; the read merges
  // both (worst wins). NOTE: this is C ENFORCEMENT + persistence only; letting
  // an honest side-effect node EARN `verified` from runtime-observed evidence
  // is the separate contract-change (a) PR — until then any side-effect node
  // stays `proof_pending` (no forgeable skill-output signal is accepted).
  const runCompletionVerificationByRunId = new Map<
    string,
    FridayNodeCompletionVerification
  >();
  // Worst-first rank: a LOWER number is a stronger (worse) downgrade. The run
  // aggregate keeps the worst label any node reported.
  const COMPLETION_VERIFICATION_RANK: Record<FridayNodeCompletionVerification, number> = {
    blocked: 0,
    recovery_needed: 1,
    proof_pending: 2,
    model_assessed_unverified: 3,
    verified: 4,
  };

  const isCompletionVerificationLabel = (
    value: unknown,
  ): value is FridayNodeCompletionVerification =>
    typeof value === "string" && value in COMPLETION_VERIFICATION_RANK;

  const worstCompletionVerification = (
    a: FridayNodeCompletionVerification | undefined,
    b: FridayNodeCompletionVerification | undefined,
  ): FridayNodeCompletionVerification | undefined => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return COMPLETION_VERIFICATION_RANK[a] <= COMPLETION_VERIFICATION_RANK[b] ? a : b;
  };

  // Stage 2(B): persist the run's worst label durably (best-effort). Only
  // non-verified labels are written (NULL = clean verified default). Swallow
  // errors (legacy DB with no v089 column, or the run row not yet inserted) —
  // the in-memory aggregate still enforces this run for the process lifetime.
  const persistCompletionVerification = (
    runId: string,
    label: FridayNodeCompletionVerification,
  ): void => {
    try {
      deps.db.withWriteTransaction((db) => runRepo.setCompletionVerification(db, runId, label));
    } catch {
      /* legacy DB / pre-insert; in-memory aggregate remains authoritative */
    }
  };

  const recordRunNodeCompletionVerification = (
    runId: string,
    label: FridayNodeCompletionVerification,
  ): void => {
    const previous = runCompletionVerificationByRunId.get(runId);
    if (
      previous === undefined
      || COMPLETION_VERIFICATION_RANK[label] < COMPLETION_VERIFICATION_RANK[previous]
    ) {
      runCompletionVerificationByRunId.set(runId, label);
      if (label !== "verified") {
        persistCompletionVerification(runId, label);
      }
    }
  };

  const getRunCompletionVerification = (
    runId: string,
  ): FridayNodeCompletionVerification => {
    const inMemory = runCompletionVerificationByRunId.get(runId);
    const run = execution.getRun(runId);
    // Stage 2(B): merge the in-memory aggregate with the persisted label
    // (v089) — the WORST of the two — so the truth survives a hub restart
    // (after which the in-memory map is empty but the column is not).
    const persisted = isCompletionVerificationLabel(run?.completionVerification)
      ? run?.completionVerification
      : undefined;
    const recorded = worstCompletionVerification(inMemory, persisted) ?? "verified";
    // Fail-closed for non-settled runs: a run that is not terminally
    // `completed` can NEVER be read as a clean `verified` completion — a
    // still-executing run may yet run a side-effect node, and a failed /
    // cancelled run did not complete. This closes the mid-flight
    // time-of-check race at the source so the verifier observes
    // `proof_pending` rather than a premature `verified`. A recorded stronger
    // downgrade (proof_pending / recovery_needed / blocked) is preserved.
    if (run?.status === "completed") {
      return recorded;
    }
    return recorded === "verified" ? "proof_pending" : recorded;
  };

  const isRunProofRequired = (runId: string): boolean => {
    const cached = proofRequiredByRunId.get(runId);
    if (cached !== undefined) return cached;
    try {
      const run = deps.db.withReadConnection((db) => runRepo.getRunById(db, runId));
      if (!run) {
        // The run row has not been persisted yet (e.g., the very first
        // pipeline-event emit fires inside `onRunIntake` before `insertRun`).
        // Returning `false` lets the ordinary degrade path swallow the
        // missing-table error, but we must NOT cache that reading or
        // subsequent emits during execution would never see the actual
        // proof-required flag.
        return false;
      }
      const value = run.proofRequired === true;
      proofRequiredByRunId.set(runId, value);
      return value;
    } catch {
      // Conservative default: legacy installations without the proof_required
      // column (pre-v086) cannot opt into fail-closed semantics, so behave
      // like an ordinary run rather than blowing up unrelated workflows.
      return false;
    }
  };

  const buildWorkflowEvidenceUnavailableError = (
    runId: string,
    cause: "no such table" | "persistence-disabled",
  ): FridayDomainError =>
    new FridayDomainError(
      "WORKFLOW_EVIDENCE_UNAVAILABLE",
      `proof-required workflow run "${runId}" cannot continue without durable evidence persistence (${cause}).`,
      {
        httpStatus: 503,
        details: { runId, cause, proofRequired: true },
      },
    );

  // Phase 14.5C: a proof-required run that observes an evidence-persistence
  // failure must be terminally marked failed with WORKFLOW_EVIDENCE_UNAVAILABLE
  // BEFORE the throw propagates. The downstream fail_fast policy will still
  // attempt to finalize the run with WORKFLOW_FAILED, but the repository's
  // first-writer-wins guard preserves our more specific failure code. We swallow
  // any error from this best-effort finalize (e.g., entire DB unreachable) so
  // the original WORKFLOW_EVIDENCE_UNAVAILABLE still propagates honestly.
  const failRunWithEvidenceUnavailable = (
    runId: string,
    cause: "no such table" | "persistence-disabled",
  ): void => {
    try {
      const nowIso = deps.nowIso();
      deps.db.withWriteTransaction((db) => {
        const existing = runRepo.getRunById(db, runId);
        if (!existing) {
          // Run row has not been persisted yet (the throw originated in
          // `onRunIntake`, before `insertRun`). The next emit during
          // execution will hit this path again with a persisted row.
          return;
        }
        if (
          existing.status === "completed"
          || existing.status === "failed"
          || existing.status === "cancelled"
        ) {
          return; // Already terminal; do not overwrite.
        }
        runRepo.finalizeRun(db, runId, "failed", nowIso, {
          code: "WORKFLOW_EVIDENCE_UNAVAILABLE",
          message:
            `proof-required workflow run "${runId}" cannot continue without durable evidence persistence (${cause}).`,
          details: { runId, cause, proofRequired: true },
        });
      });
    } catch {
      // Best-effort. The thrown WORKFLOW_EVIDENCE_UNAVAILABLE error will still
      // propagate; a generic finalize will record the run as failed via the
      // fail_fast policy path, but without the specific code. That degradation
      // is bounded: it only happens if the workflow_runs table itself is
      // unreachable, which is a far broader infrastructure failure.
    }
  };

  const persistEvidenceOrDegrade = (runId: string, write: () => void): void => {
    if (getRunEvidenceStatus(runId) === "unavailable") {
      return; // Persistence paused for this run; do not retry until recovery window.
    }
    try {
      write();
    } catch (error) {
      // Legacy DBs without v033 evidence tables should continue to run.
      if (shouldDisableEvidencePersistence(error)) {
        transitionRunEvidenceStatus(runId, "unavailable");
      }
    }
  };

  const persistEvidenceOrFailClosed = (runId: string, write: () => void): void => {
    const currentStatus = getRunEvidenceStatus(runId);
    if (currentStatus === "unavailable") {
      failRunWithEvidenceUnavailable(runId, "persistence-disabled");
      throw buildWorkflowEvidenceUnavailableError(runId, "persistence-disabled");
    }
    try {
      write();
    } catch (error) {
      if (shouldDisableEvidencePersistence(error)) {
        transitionRunEvidenceStatus(runId, "unavailable");
        failRunWithEvidenceUnavailable(runId, "no such table");
        throw buildWorkflowEvidenceUnavailableError(runId, "no such table");
      }
      throw error;
    }
  };

  const persistEvidenceForRun = (runId: string, write: () => void): void => {
    if (isRunProofRequired(runId)) {
      persistEvidenceOrFailClosed(runId, write);
      return;
    }
    persistEvidenceOrDegrade(runId, write);
  };
  let publicRetryPersistenceAvailable = true;
  let publicRetryDisabledAt = 0;
  const PUBLIC_RETRY_RETRY_INTERVAL_MS = 60_000;
  const isPublicRetryAvailable = (): boolean => {
    if (publicRetryPersistenceAvailable) return true;
    if (Date.now() - publicRetryDisabledAt >= PUBLIC_RETRY_RETRY_INTERVAL_MS) {
      publicRetryPersistenceAvailable = true;
      return true;
    }
    return false;
  };
  const markPublicRetryUnavailable = (): void => {
    publicRetryPersistenceAvailable = false;
    publicRetryDisabledAt = Date.now();
  };
  const persistPublicRetrySafely = (write: () => void): void => {
    if (!isPublicRetryAvailable()) {
      return;
    }
    try {
      write();
    } catch (error) {
      if (shouldDisableEvidencePersistence(error)) {
        markPublicRetryUnavailable();
      }
    }
  };
  const ensureDefaultPublicRetryPolicy = (db: Parameters<FridaySqliteLayer["withWriteTransaction"]>[0] extends (db: infer T) => unknown ? T : never): FridayRetryPolicy => {
    const existing = retryRepository.getPolicyById(db, DEFAULT_UNIFIED_RETRY_POLICY_ID);
    if (existing) {
      return existing;
    }
    const policy = buildDefaultRetryPolicy(deps.nowIso(), DEFAULT_UNIFIED_RETRY_POLICY_ETAG);
    const row: FridayRetryPolicyRow = {
      id: policy.id,
      name: policy.name,
      description: policy.description ?? null,
      version: policy.version,
      priority: policy.priority,
      enabled: policy.enabled ? 1 : 0,
      tags_json: JSON.stringify(policy.tags),
      cost_budget_json: JSON.stringify(policy.costBudget),
      strategies_json: JSON.stringify(policy.strategies),
      etag: policy.etag,
      created_at: policy.createdAt,
      updated_at: policy.updatedAt,
      deleted_at: null,
    };
    retryRepository.insertPolicy(db, row);
    retryRepository.insertPolicyVersion(db, {
      id: deps.idGenerator(),
      policy_id: row.id,
      version: row.version,
      snapshot_json: JSON.stringify(policy),
      changed_by: "workflow-runtime",
      change_note: "Provisioned unified workflow retry policy",
      created_at: row.created_at,
    });
    return policy;
  };
  let unifiedRetryBridge: ReturnType<typeof createWorkflowUnifiedRetryBridge>;
  const upsertWorkflowRetryCircuitBreaker = (
    db: Parameters<FridaySqliteLayer["withWriteTransaction"]>[0] extends (db: infer T) => unknown ? T : never,
    input: {
      workflowId: string;
      nodeId: string;
      updatedAt: string;
      openedAt?: string;
    },
  ): void => {
    const targetId = buildRetryTargetId(input.workflowId, input.nodeId);
    const existing = retryRepository.listCircuitBreakers(db).find((item) => item.targetId === targetId) ?? null;
    const state = unifiedRetryBridge.isCircuitOpen(input.nodeId) ? "open" : "closed";
    const tripCount = state === "open"
      ? existing?.state === "open"
        ? existing.tripCount
        : (existing?.tripCount ?? 0) + 1
      : existing?.tripCount ?? 0;
    retryRepository.upsertCircuitBreaker(db, {
      target_id: targetId,
      state,
      consecutive_failures: unifiedRetryBridge.getConsecutiveFailures(input.nodeId),
      failure_threshold: pipelineRetryConfig.circuitBreakerThreshold,
      last_opened_at: state === "open"
        ? existing?.state === "open"
          ? existing.lastOpenedAt ?? input.openedAt ?? input.updatedAt
          : input.openedAt ?? input.updatedAt
        : null,
      trip_count: tripCount,
      updated_at: input.updatedAt,
    });
  };
  // Phase 14.5C: read-side degrade is no longer silent. The helper still
  // returns the caller-supplied fallback (the call sites need a concrete
  // value), but the per-run evidence status transitions to `degraded` (or
  // `unavailable` for a "no such table" error) so the run receipt and the
  // task-workflow closeout gate can refuse the proof claim honestly.
  const readEvidenceSafely = <T>(
    runId: string,
    read: () => T,
    fallback: T,
  ): T => {
    if (getRunEvidenceStatus(runId) === "unavailable") {
      return fallback;
    }
    try {
      return read();
    } catch (error) {
      if (shouldDisableEvidencePersistence(error)) {
        transitionRunEvidenceStatus(runId, "unavailable");
      } else {
        transitionRunEvidenceStatus(runId, "degraded");
      }
      return fallback;
    }
  };

  // 2. Engine components
  const expressionEvaluator = createFridayExpressionEvaluator();
  const dagScheduler = createFridayWorkflowDagScheduler();
  const runMachine = createFridayWorkflowRunMachine();
  const nodeMachine = createFridayWorkflowNodeMachine();
  const retryManager = createFridayWorkflowRetryManager({
    idGenerator: deps.idGenerator,
  });
  const legacyNodeExecutor = createFridayWorkflowNodeExecutor({
    expressionEvaluator,
    resolveSkill: deps.resolveSkill,
    invokeSkill: deps.invokeSkill,
    userRulesContextProvider: deps.userRulesContextProvider,
    nowIso: deps.nowIso,
  });

  const persistPipelineEvent = (event: PipelineEvent): void => {
    persistEvidenceForRun(event.correlation.runId, () => {
      deps.db.withWriteTransaction((db) => {
        evidenceRepo.insertPipelineEvent(db, {
          event_id: event.eventId,
          run_id: event.correlation.runId,
          workflow_id: event.correlation.workflowId ?? null,
          node_id: event.correlation.nodeId ?? null,
          attempt: event.correlation.attempt ?? null,
          module: event.module,
          event_name: event.event,
          payload_json: JSON.stringify(event.payload ?? {}),
          trace_id: event.correlation.traceId ?? null,
          span_id: event.correlation.spanId ?? null,
          redacted: event.redacted ? 1 : 0,
          emitted_at: event.emittedAt,
        });
      });
    });
  };

  const pipelineEventEmitter = createPipelineEventEmitter({
    publish: (event) => {
      persistPipelineEvent(event);
      void deps.publishEvent?.(event.event, event);
    },
    generateId: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  const rulesRepository = createFridayRulesRepository();
  const rulesEngine = new FridayRuleEngine({
    auditLogSink: (entry) => {
      try {
        deps.db.withWriteTransaction((db) => {
          rulesRepository.insertEvaluationLog(db, {
            id: deps.idGenerator(),
            rule_id: entry.matchedRules[0]?.ruleId ?? null,
            policy_bundle_id: entry.matchedRules[0]?.policyBundleId ?? null,
            decision: entry.decision,
            resource: entry.resource,
            action: entry.action,
            context_redacted_json: JSON.stringify(entry.contextRedacted.redacted),
            redaction_applied: entry.contextRedacted.redactionApplied ? 1 : 0,
            redacted_fields_json: JSON.stringify(entry.contextRedacted.redactedFields),
            matched_rules_json: JSON.stringify(entry.matchedRules),
            duration_ms: entry.durationMs,
            run_id: entry.runId ?? null,
            workflow_id: entry.workflowId ?? null,
            principal_id: entry.principalId ?? null,
            created_at: entry.evaluatedAt,
          });
        });
      } catch (err) {
        // Keep rule enforcement fail-open for audit persistence write failures.
        console.warn("[friday][workflow-runtime] rule-audit-persist:", err instanceof Error ? err.message : String(err));
      }
    },
  });

  try {
    deps.db.withReadConnection((db) => {
      const bundles = rulesRepository.listPolicyBundles(db, {
        enabledOnly: false,
        limit: 10_000,
        offset: 0,
      });
      for (const bundleRow of bundles) {
        const bundle = mapBundleRow(bundleRow);
        const rules = rulesRepository
          .listRulesByBundleId(db, bundle.id, { enabledOnly: false })
          .map((row) => mapRuleRow(row));
        rulesEngine.loadDomainBundle(bundle, rules);
      }
    });
  } catch (err) {
    // Legacy instances may not have the Rules tables yet.
    console.warn("[friday][workflow-runtime] load-rules:", err instanceof Error ? err.message : String(err));
  }

  const evaluateRules = async (
    context: FridayEvaluationContext,
    _signal?: AbortSignal,
  ): Promise<FridayEvaluationResult> => {
    const scopes = new Set(context.scopes ?? []);
    scopes.add(RULES_EVALUATE_SCOPE);
    const rawResult = rulesEngine.evaluate({
      ...context,
      scopes: [...scopes],
    }, { includeTransitionTrace: true });

    const result: FridayEvaluationResult = pipelineEnabled && pipelineEnforceMode
      ? rawResult
      : (rawResult.allowed
        ? rawResult
        : {
          ...rawResult,
          decision: "warn",
          allowed: true,
          message: rawResult.message
            ? `[${pipelineConfig.mode}] ${rawResult.message}`
            : `[${pipelineConfig.mode}] policy denied but enforcement is relaxed`,
        });

    pipelineEventEmitter.emit(
      "pipeline.rules.evaluated",
      {
        bundleId: context.policyBundleIds?.[0] ?? "all",
        ruleCount: rawResult.matchedRules.length,
        outcome: rawResult.decision === "deny" ? "deny" : rawResult.decision === "warn" ? "warn" : "allow",
        durationMs: rawResult.durationMs,
      },
      {
        runId: context.workflowRunId ?? context.runId ?? "unknown-run",
        workflowId: context.workflowId,
        nodeId: context.nodeId,
      },
    );
    if (!rawResult.allowed) {
      pipelineEventEmitter.emit(
        "pipeline.rules.denied",
        {
          bundleId: context.policyBundleIds?.[0] ?? "all",
          reason: rawResult.message ?? "Denied by policy",
          ruleId: rawResult.matchedRules[0]?.ruleId,
        },
        {
          runId: context.workflowRunId ?? context.runId ?? "unknown-run",
          workflowId: context.workflowId,
          nodeId: context.nodeId,
        },
      );
    }

    return result;
  };

  const adapterRegistry = new NodeAdapterRegistry({ registerBuiltIns: false });
  for (const adapter of createWorkflowNodeRunnerDelegatingAdapters({ legacyExecutor: legacyNodeExecutor })) {
    adapterRegistry.register(adapter);
  }

  const nodeRunnerPipeline = createNodeRunnerPipeline({
    adapterRegistry,
    defaultTimeoutMs: WORKFLOW_NODE_RUNNER_DEFAULT_TIMEOUT_MS,
    evaluateRules,
    generateId: deps.idGenerator,
    nowIso: deps.nowIso,
  });
  const nodeRunnerFacade = createFridayWorkflowNodeRunnerFacade({
    pipeline: nodeRunnerPipeline,
    legacyExecutor: legacyNodeExecutor,
    config: {
      useNodeRunner: pipelineEnabled,
    },
    nowIso: deps.nowIso,
  });

  const acceptanceRegistry = new InMemoryTestRegistry();
  const acceptanceBaselineRegistered = new Set<FridayAcceptanceArtifactType>();
  const ensureAcceptanceBaseline = (artifactType: FridayAcceptanceArtifactType): void => {
    if (acceptanceBaselineRegistered.has(artifactType)) {
      return;
    }
    const now = deps.nowIso();
    acceptanceRegistry.register(buildAcceptanceBaselineTest(
      `${artifactType}-schema`,
      `${artifactType} schema baseline`,
      artifactType,
      10,
      { checkType: "schema", schema: {} },
      now,
    ));
    acceptanceRegistry.register(buildAcceptanceBaselineTest(
      `${artifactType}-quant`,
      `${artifactType} count baseline`,
      artifactType,
      20,
      { checkType: "quantitative", metricPath: "__friday_count", operator: "gte", threshold: 1 },
      now,
    ));
    acceptanceRegistry.register(buildAcceptanceBaselineTest(
      `${artifactType}-quality`,
      `${artifactType} quality baseline`,
      artifactType,
      30,
      { checkType: "quality", dimension: "completeness", minScore: 0, warnScore: 0 },
      now,
    ));
    acceptanceBaselineRegistered.add(artifactType);
  };
  for (const artifactType of ACCEPTANCE_ARTIFACT_TYPES) {
    ensureAcceptanceBaseline(artifactType);
  }
  const acceptanceRunner = new AcceptanceTestSuiteRunner({
    registry: acceptanceRegistry,
    evaluateRules,
  });
  const acceptanceGate = createFridayWorkflowAcceptanceGate({
    runAcceptanceChecks: async (params) => {
      const artifactType = params.artifactType as FridayAcceptanceArtifactType;
      ensureAcceptanceBaseline(artifactType);
      pipelineEventEmitter.emit(
        "pipeline.acceptance.started",
        {
          artifactType,
          checkCount: acceptanceRegistry.getTests(artifactType).length,
        },
        {
          runId: params.runId,
          workflowId: params.context?.workflowId as string | undefined,
          nodeId: params.context?.nodeId as string | undefined,
        },
      );

      const artifact: FridayNodeArtifact = {
        artifactType,
        uri: `memory://workflow-acceptance/${params.runId}/${deps.idGenerator()}`,
        metadata: {
          content: normalizeAcceptanceContent(params.artifactData),
        },
      };
      const executionId = asString(params.context?.executionId) ?? deps.idGenerator();
      const run = await acceptanceRunner.runForArtifact(executionId, artifact);
      return run.checks
        .filter((check): check is Extract<typeof check, { status: "executed" }> => check.status === "executed")
        .map((check) => ({
          checkId: check.testId,
          checkName: check.testId,
          verdict: check.verdict,
          severity: check.severity,
          message: check.evidence[0]?.message,
        }));
    },
    nowIso: deps.nowIso,
  });

  const playbookStore = createSqlitePlaybookStore({ db: deps.db });
  const playbookConfig = buildPlaybookConfig(deps);
  const playbookMatcher = createPlaybookMatcher({
    store: playbookStore,
    config: playbookConfig,
  });
  const learningEngine = createLearningEngine({
    store: playbookStore,
    config: playbookConfig,
  });
  const scoreCalculator = createScoreCalculator({
    store: playbookStore,
    config: playbookConfig,
  });
  const promotionEngine = createPromotionEngine({
    store: playbookStore,
    config: playbookConfig,
  });
  const versionManager = createVersionManager({
    store: playbookStore,
    config: playbookConfig,
  });
  const playbookBridge = createWorkflowPlaybookBridge({
    selector: playbookMatcher,
    learner: learningEngine,
    scoreCalculator,
    promotionEngine,
    enabled: process.env.FRIDAY_PLAYBOOK_AUTO_LEARN !== "false",
    onTrace: (trace) => {
      persistEvidenceForRun(trace.runId, () => {
        deps.db.withWriteTransaction((db) => {
          evidenceRepo.insertPlaybookTrace(db, {
            id: deps.idGenerator(),
            run_id: trace.runId,
            workflow_id: trace.workflowId,
            phase: trace.phase,
            intake_json: trace.intakeResult ? JSON.stringify(trace.intakeResult) : null,
            feedback_json: trace.feedbackResult ? JSON.stringify(trace.feedbackResult) : null,
            timestamp: trace.timestamp,
          });
        });
      });
    },
    nowIso: deps.nowIso,
  });

  unifiedRetryBridge = createWorkflowUnifiedRetryBridge({
    maxAttempts: pipelineRetryConfig.maxAttempts,
    baseDelayMs: pipelineRetryConfig.baseDelayMs,
    retryBudgetMax: pipelineRetryConfig.retryBudgetMax,
    circuitBreakerThreshold: pipelineRetryConfig.circuitBreakerThreshold,
    onRetryTrace: (trace) => {
      persistEvidenceForRun(trace.runId, () => {
        deps.db.withWriteTransaction((db) => {
          evidenceRepo.insertRetryTrace(db, {
            id: deps.idGenerator(),
            run_id: trace.runId,
            node_id: trace.nodeId,
            attempt: trace.attempt,
            category: trace.category,
            error_code: trace.errorCode,
            error_message: trace.errorMessage ?? null,
            decision_json: JSON.stringify(trace.decision),
            timestamp: trace.timestamp,
          });
        });
      });
      persistPublicRetrySafely(() => {
        deps.db.withWriteTransaction((db) => {
          const run = runRepo.getRunById(db, trace.runId);
          if (!run) {
            return;
          }
          const policy = ensureDefaultPublicRetryPolicy(db);
          const traceId = deps.idGenerator();
          const status = toWorkflowRetryTraceStatus(trace.decision);
          const escalationTarget = toRetryEscalationTarget(trace.category);
          const decisionRecord = {
            shouldRetry: trace.decision.shouldRetry,
            nextAttemptNumber: trace.decision.shouldRetry ? trace.attempt + 1 : trace.attempt,
            delayMs: trace.decision.delayMs,
            reason: trace.decision.reason,
            failureCategory: trace.category,
            strategyType: trace.decision.shouldRetry ? "exponential" : "none",
            rulesOverride: false,
            budgetConstrained: trace.decision.budgetExhausted,
            escalate: trace.decision.escalateToDlq,
            escalationChannel: trace.decision.escalateToDlq ? escalationTarget : undefined,
            idempotencyKey: `workflow:${trace.runId}:${trace.nodeId}:${trace.attempt}`,
            decidedAt: trace.timestamp,
          };
          const classifiedFailure = {
            classificationId: deps.idGenerator(),
            category: trace.category,
            severity: toRetryFailureSeverity(trace.category),
            classificationSource: trace.errorMessage ? "error_message" : "error_code",
            confidence: trace.errorMessage ? 95 : 85,
            originalErrorCode: trace.errorCode,
            originalErrorMessage: trace.errorMessage,
            retryable: isRetryCategoryRetryable(trace.category),
            classifiedAt: trace.timestamp,
            metadata: {
              source: "workflow_runtime",
              bridge: "unified_retry_bridge",
            },
          };
          retryRepository.insertTrace(db, {
            id: traceId,
            run_id: trace.runId,
            workflow_id: run.workflowId,
            node_id: trace.nodeId,
            status,
            policy_id: policy.id,
            original_failure_category: trace.category,
            original_error_code: trace.errorCode,
            original_error_message: trace.errorMessage ?? null,
            attempts_json: "[]",
            total_attempts: trace.attempt,
            cost_summary_json: JSON.stringify({ budget: policy.costBudget }),
            duration_ms: 0,
            first_failure_at: trace.timestamp,
            resolved_at: trace.decision.shouldRetry ? null : trace.timestamp,
            created_at: trace.timestamp,
            updated_at: trace.timestamp,
          });
          retryRepository.insertAttempt(db, {
            id: deps.idGenerator(),
            trace_id: traceId,
            attempt_number: trace.attempt,
            classified_failure_json: JSON.stringify(classifiedFailure),
            decision_json: JSON.stringify(decisionRecord),
            delay_ms: trace.decision.delayMs,
            execution_id: null,
            outcome: trace.decision.shouldRetry ? "failure" : status,
            cost_record_json: JSON.stringify(ZERO_RETRY_COST),
            rules_result_json: null,
            error_code: trace.errorCode,
            error_message: trace.errorMessage ?? null,
            started_at: trace.timestamp,
            completed_at: trace.timestamp,
            metadata_json: JSON.stringify({
              source: "workflow_runtime",
              workflowId: run.workflowId,
            }),
          });
          retryRepository.insertCostRecord(db, {
            id: deps.idGenerator(),
            trace_id: traceId,
            attempt_number: trace.attempt,
            run_id: trace.runId,
            node_id: trace.nodeId,
            cost_tokens: 0,
            cost_api_calls: 0,
            cost_compute_ms: 0,
            cumulative_tokens: 0,
            cumulative_api_calls: 0,
            cumulative_compute_ms: 0,
            per_attempt_budget_exceeded: 0,
            total_budget_exceeded: trace.decision.budgetExhausted ? 1 : 0,
            recorded_at: trace.timestamp,
          });
          if (trace.decision.escalateToDlq) {
            retryRepository.insertEscalation(db, {
              id: deps.idGenerator(),
              trace_id: traceId,
              target: escalationTarget,
              channel: escalationTarget,
              reason: trace.decision.reason,
              failure_category: trace.category,
              attempt_count: trace.attempt,
              total_cost_tokens: 0,
              total_cost_api_calls: 0,
              total_cost_compute_ms: 0,
              acknowledged: 0,
              escalated_at: trace.timestamp,
              acknowledged_at: null,
            });
          }
          if (trace.decision.circuitOpen) {
            upsertWorkflowRetryCircuitBreaker(db, {
              workflowId: run.workflowId,
              nodeId: trace.nodeId,
              updatedAt: trace.timestamp,
              openedAt: trace.timestamp,
            });
          }
        });
      });
    },
    nowIso: deps.nowIso,
  });

  const nodeExecutor = {
    async executeNode(input) {
      // Audit C Stage 1: derive the orthogonal completion-verification label
      // from the node's DECLARED capability (never from output). A side-effect
      // node without deterministic evidence is `proof_pending` (not a clean /
      // verified completion); informational nodes are verified / model_assessed.
      // Applied in EVERY path — pipeline-on, output==null, and the legacy/
      // pipeline-disabled bypass — so none of them can be read as verified.
      const sideEffectClass = classifyWorkflowNodeSideEffect(input.node, deps.resolveSkill);
      const baselineVerification = resolveNodeCompletionVerification(input.node, sideEffectClass);

      // Audit C Stage 2A: is this node a filesystem-write VERIFICATION candidate
      // — a write-class side effect (NO send/connect/capture/execute) with a
      // resolvable binding target sourced from trusted node/manifest inputs? If
      // so, its `proof_pending`→`verified` upgrade requires a real on-disk state
      // delta, observed AFTER the skill runs. The Stage 1 baseline label is the
      // worst-case (`proof_pending`); the verifier may upgrade it to `verified`.
      const fsWriteTarget: FridayFilesystemWriteTarget | null = resolveFilesystemWriteTarget(
        input.node,
        deps.resolveSkill,
      );

      // The FINAL completion-verification label. For non-candidates it is the
      // Stage 1 baseline. For candidates it starts at `proof_pending` and is only
      // raised to `verified` after a confirmed fs delta (see below).
      let effectiveVerification: FridayNodeCompletionVerification = baselineVerification;
      const withVerification = <T>(r: T): T => {
        (r as { completionVerification?: FridayNodeCompletionVerification }).completionVerification = effectiveVerification;
        return r;
      };

      // Run-level enforcement (audit C part-2): record this node's
      // completion-verification into the run-level aggregate (the worst label
      // wins). A node that is NOT a clean `verified` completion — a side-effect
      // node lacking deterministic evidence (`proof_pending`) or a
      // model-assessed informational node (`model_assessed_unverified`) — makes
      // the RUN aggregate non-`verified`, which the task workflow verifier
      // refuses as proof backing. This closes the run-level bypasses (arbitrary
      // non-empty baseline pass, output==null skipping the gate, and the
      // disabled-pipeline/legacy path): none can leave the run readable as
      // clean/verified. It does NOT block the node from running (no
      // over-blocking) and is ORTHOGONAL to `evidenceStatus` — recording a
      // non-verified completion must NOT touch evidence-persistence health.
      //
      // Stage 2A DEFER-AND-RECORD-ONCE: `recordRunNodeCompletionVerification` is
      // monotonic-downward, so an up-front `proof_pending` record makes a later
      // `verified` record a NO-OP. For an fs-write CANDIDATE we therefore DEFER
      // the up-front record and record exactly once AFTER the re-read (verified
      // when an fs delta is confirmed, else proof_pending). EVERY candidate exit
      // path (success / catch / !pipelineEnabled) MUST record, or a
      // candidate-only run would default-read `verified`. All non-candidate
      // nodes keep the up-front record (unchanged Stage 1/2B behavior).
      if (!fsWriteTarget) {
        recordRunNodeCompletionVerification(input.runId, baselineVerification);
      }

      if (!pipelineEnabled) {
        // Legacy / pipeline-disabled bypass must still be truth-labeled — a
        // disabled pipeline is not a verified completion. An fs-write candidate
        // is NOT verified on the legacy path (no re-read happens there); record
        // its deferred label as `proof_pending` so the run cannot read verified.
        if (fsWriteTarget) {
          recordRunNodeCompletionVerification(input.runId, baselineVerification);
        }
        return withVerification(await legacyNodeExecutor.executeNode(input));
      }

      // Stage 2A: snapshot the declared target BEFORE execution so the post-exec
      // re-read can prove a checksum change or a newly-created file.
      let fsSnapshot: FridaySnapshot | null = null;
      if (fsWriteTarget) {
        try {
          fsSnapshot = snapshotTarget(
            fsWriteTarget,
            fsVerifierWorkspaceDir,
            { computeChecksum: deps.computeChecksum },
          );
        } catch {
          fsSnapshot = null; // unreadable pre-state → treat as "no snapshot"; verify still requires post-existence + delta.
        }
      }

      try {
        const result = withVerification(await nodeRunnerFacade.executeNode(input));

        // Stage 2A: re-read the declared target and decide the candidate's
        // single recorded label. `verified` ONLY on a confirmed in-scope,
        // non-self-receipt, non-evidence-mirror fs delta; else `proof_pending`.
        if (fsWriteTarget) {
          let evidenceVerified = false;
          if (fsSnapshot) {
            try {
              const outcome = verifyFsWriteEvidence(
                {
                  target: fsWriteTarget,
                  snapshot: fsSnapshot,
                  evidenceExportRootDir,
                  workspaceDir: fsVerifierWorkspaceDir,
                  returnedArtifactUris: collectReturnedArtifactPaths(result),
                },
                { computeChecksum: deps.computeChecksum },
              );
              evidenceVerified = outcome.verified;
            } catch {
              evidenceVerified = false; // any verifier error → fail closed.
            }
          }
          effectiveVerification = resolveNodeCompletionVerification(
            input.node,
            "side_effect",
            evidenceVerified,
          );
          // Stamp the now-final label on the result before it is returned, then
          // record once. (`withVerification` reads `effectiveVerification` live,
          // so the earlier stamp is overwritten here.)
          (result as { completionVerification?: FridayNodeCompletionVerification }).completionVerification = effectiveVerification;
          recordRunNodeCompletionVerification(input.runId, effectiveVerification);
        }

        pipelineEventEmitter.emit(
          "pipeline.node.execution.completed",
          {
            status: "completed",
            durationMs: 0,
            stepCount: 6,
            artifactCount: result.artifacts?.length ?? 0,
          },
          {
            runId: input.runId,
            workflowId: input.workflowId,
            nodeId: input.nodeId,
          },
        );

        if (result.output != null) {
          const gateResult = await acceptanceGate.evaluate({
            runId: input.runId,
            workflowId: input.workflowId ?? input.runId,
            artifactType: inferArtifactType(result.output),
            artifactData: result.output,
            policy: pipelineEnforceMode
              ? undefined
              : {
                errorBlocksCompletion: false,
                warnAllowsCompletion: true,
              },
            context: {
              executionId: input.attemptId,
              nodeId: input.nodeId,
              workflowId: input.workflowId,
            },
          });

          if (gateResult.decision === "pass") {
            pipelineEventEmitter.emit(
              "pipeline.acceptance.passed",
              {
                checksRun: gateResult.checksRun,
                checksPassed: gateResult.checksPassed,
              },
              {
                runId: input.runId,
                workflowId: input.workflowId,
                nodeId: input.nodeId,
              },
            );
          } else if (gateResult.decision === "warn") {
            pipelineEventEmitter.emit(
              "pipeline.acceptance.warned",
              {
                checksRun: gateResult.checksRun,
                checksPassed: gateResult.checksPassed,
                checksWarned: gateResult.checksWarned,
              },
              {
                runId: input.runId,
                workflowId: input.workflowId,
                nodeId: input.nodeId,
              },
            );
          } else {
            pipelineEventEmitter.emit(
              "pipeline.acceptance.failed",
              {
                checksRun: gateResult.checksRun,
                checksFailed: gateResult.checksFailed,
                blocksCompletion: gateResult.blocksCompletion,
              },
              {
                runId: input.runId,
                workflowId: input.workflowId,
                nodeId: input.nodeId,
              },
            );
          }

          if (gateResult.blocksCompletion && pipelineEnforceMode) {
            throw new FridayDomainError("VALIDATION_ERROR", "NODE_ACCEPTANCE_FAILED", { httpStatus: 400 });
          }
        }

        return result;
      } catch (error) {
        // Stage 2A: a candidate that threw (execution error, OR an acceptance
        // gate failure thrown AFTER a success-path `verified` record) did NOT
        // cleanly complete — record `proof_pending`. `record...` is
        // monotonic-downward, so this safely downgrades any earlier `verified`
        // and guarantees the deferred candidate is always recorded on this exit.
        if (fsWriteTarget) {
          recordRunNodeCompletionVerification(input.runId, "proof_pending");
        }
        pipelineEventEmitter.emit(
          "pipeline.node.execution.completed",
          {
            status: "failed",
            durationMs: 0,
            stepCount: 6,
            artifactCount: 0,
          },
          {
            runId: input.runId,
            workflowId: input.workflowId,
            nodeId: input.nodeId,
          },
        );
        throw error;
      }
    },
  } satisfies CreateWorkflowExecutionServiceDeps["nodeExecutor"];

  const artifactWriter = createFridayWorkflowArtifactWriter({
    db: deps.db,
    artifactRepo,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // 3. Services

  // Late-binding callback to break circular dependency: crud → triggers
  let onPublishCallback: ((workflowId: string) => Promise<void>) | undefined;

  const crud = createFridayWorkflowCrudService({
    db: deps.db,
    workflowRepo,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    computeChecksum: deps.computeChecksum,
    computeEtag: () => deps.idGenerator().slice(0, 16),
    onPublish: async (workflowId) => {
      if (onPublishCallback) {
        await onPublishCallback(workflowId);
      }
    },
  });

  // Create a late-binding approval callback to break the circular dependency
  // between execution service and approval service
  let approvalCallback: CreateWorkflowExecutionServiceDeps["requestNodeApproval"];

  const execution = createFridayWorkflowExecutionService({
    db: deps.db,
    workflowRepo,
    runRepo,
    nodeRepo,
    artifactRepo,
    dagScheduler,
    runMachine,
    nodeMachine,
    nodeExecutor,
    retryManager,
    artifactWriter,
    expressionEvaluator,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    allowTestOnlyWorkflowRunExecution: deps.allowTestOnlyWorkflowRunExecution,
    publishEvent: deps.publishEvent,
    onRunIntake: pipelineEnabled || deps.onRunIntake ? async (input) => {
      let contextPatch: JsonObject | undefined;

      if (pipelineEnabled) {
        const workflow = deps.db.withReadConnection((db) =>
          workflowRepo.getWorkflowById(db, input.workflowId),
        );
        const workflowType = workflow?.slug ?? "workflow";
        const tags = workflow?.tags ?? [];
        const nodeSequence = input.compiledGraph.graph.nodes.map((node) => ({
          nodeType: node.type,
          adapterType: asString((node.config as Record<string, unknown>).actionType),
        }));

        const intake = await playbookBridge.selectOnIntake({
          runId: input.runId,
          workflowId: input.workflowId,
          workflowType,
          tags,
          nodeSequence,
        });

        if (intake.decision === "matched" && intake.playbookId) {
          pipelineEventEmitter.emit(
            "pipeline.playbook.selected",
            {
              playbookId: intake.playbookId,
              versionNumber: intake.versionNumber ?? 1,
              matchScore: intake.matchScore ?? 0,
            },
            {
              runId: input.runId,
              workflowId: input.workflowId,
            },
          );
        } else {
          pipelineEventEmitter.emit(
            "pipeline.playbook.no_match",
            {
              workflowType,
              reason: intake.decision,
            },
            {
              runId: input.runId,
              workflowId: input.workflowId,
            },
          );
        }

        contextPatch = {
          ...(contextPatch ?? {}),
          pipeline: {
            playbook: {
              decision: intake.decision,
              playbookId: intake.playbookId,
              versionNumber: intake.versionNumber,
              matchScore: intake.matchScore,
              evaluatedAt: intake.evaluatedAt,
            },
          },
        };
      }

      if (deps.onRunIntake) {
        const externalIntake = await deps.onRunIntake(input);
        if (externalIntake?.contextPatch) {
          contextPatch = {
            ...(contextPatch ?? {}),
            ...externalIntake.contextPatch,
          };
        }
      }

      return contextPatch ? { contextPatch } : undefined;
    } : undefined,
    onRetryDecision: pipelineEnabled ? (input) => {
      const decision = unifiedRetryBridge.evaluateRetry({
        runId: input.runId,
        nodeId: input.nodeId,
        attempt: input.attempt,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
      });
      const correlation = {
        runId: input.runId,
        workflowId: input.workflowId,
        nodeId: input.nodeId,
        attempt: input.attempt,
      };

      if (decision.shouldRetry) {
        pipelineEventEmitter.emit(
          "pipeline.retry.attempted",
          {
            category: decision.category,
            delayMs: decision.delayMs,
            budgetRemaining: unifiedRetryBridge.getRetryBudgetRemaining(input.runId),
          },
          correlation,
        );
      } else {
        pipelineEventEmitter.emit(
          "pipeline.retry.exhausted",
          {
            category: decision.category,
            totalAttempts: input.attempt,
            escalatedToDlq: decision.escalateToDlq,
          },
          correlation,
        );
        if (decision.circuitOpen) {
          pipelineEventEmitter.emit(
            "pipeline.retry.circuit.opened",
            {
              consecutiveFailures: unifiedRetryBridge.getConsecutiveFailures(input.nodeId),
              threshold: unifiedRetryBridge.getCircuitBreakerThreshold(),
            },
            correlation,
          );
        }
        if (decision.budgetExhausted) {
          pipelineEventEmitter.emit(
            "pipeline.retry.budget.exhausted",
            {
              budgetMax: unifiedRetryBridge.getRetryBudgetMax(),
              budgetUsed: unifiedRetryBridge.getRetryBudgetUsed(input.runId),
            },
            correlation,
          );
        }
      }
      return {
        shouldRetry: decision.shouldRetry,
        delayMs: decision.delayMs,
        reason: decision.reason,
      };
    } : undefined,
    onNodeAttemptResult: pipelineEnabled ? (input) => {
      unifiedRetryBridge.recordAttempt({
        runId: input.runId,
        nodeId: input.nodeId,
        attempt: input.attempt,
        category: input.status === "completed"
          ? "transient"
          : classifyWorkflowError(input.errorCode ?? "NODE_EXECUTION_FAILED", input.errorMessage),
        success: input.status === "completed",
      });
      if (input.status !== "failed") {
        return;
      }
      persistPublicRetrySafely(() => {
        deps.db.withWriteTransaction((db) => {
          const run = runRepo.getRunById(db, input.runId);
          if (!run) {
            return;
          }
          upsertWorkflowRetryCircuitBreaker(db, {
            workflowId: run.workflowId,
            nodeId: input.nodeId,
            updatedAt: deps.nowIso(),
          });
        });
      });
    } : undefined,
    onRunCompleted: async (input) => {
      if (pipelineEnabled) {
        const workflow = deps.db.withReadConnection((db) =>
          workflowRepo.getWorkflowById(db, input.workflowId),
        );
        const workflowType = workflow?.slug ?? "workflow";
        const tags = workflow?.tags ?? [];
        const toolsUsed = input.plan.compiledGraph.graph.nodes
          .map((node) => asRecord(node.config))
          .flatMap((config) => [asString(config.skillId), asString(config.ref), asString(config.toolId)])
          .filter((item): item is string => typeof item === "string");
        const parameterKeys = Array.from(new Set(
          input.plan.compiledGraph.graph.nodes.flatMap((node) => Object.keys(asRecord(node.config.args))),
        ));

        const feedback = await playbookBridge.recordFeedback({
          runId: input.runId,
          workflowId: input.workflowId,
          workflowType,
          tags,
          nodeSequence: input.plan.compiledGraph.graph.nodes.map((node) => ({
            nodeType: node.type,
            adapterType: asString((node.config as Record<string, unknown>).actionType),
          })),
          toolsUsed,
          parameterKeys,
          durationMs: 0,
          cost: {
            tokenCost: 0,
            apiCallCost: 0,
            latencyMs: 0,
          },
          success: input.status === "completed",
          completedAt: deps.nowIso(),
        });

        pipelineEventEmitter.emit(
          "pipeline.playbook.feedback.recorded",
          {
            candidateId: feedback.candidate?.id ?? null,
            success: input.status === "completed",
            durationMs: 0,
          },
          {
            runId: input.runId,
            workflowId: input.workflowId,
          },
        );

        if (feedback.promotionDecision?.decision === "promote" && feedback.candidate) {
          if (feedback.candidate.promotedPlaybookId) {
            const version = versionManager.evolve(
              feedback.candidate.promotedPlaybookId,
              feedback.candidate,
              "Auto-evolved from workflow feedback",
            );
            if (version) {
              const score = await scoreCalculator.recalculate(version.playbookId);
              pipelineEventEmitter.emit(
                "pipeline.playbook.promoted",
                {
                  candidateId: feedback.candidate.id,
                  playbookId: version.playbookId,
                  compositeScore: score.compositeScore,
                },
                {
                  runId: input.runId,
                  workflowId: input.workflowId,
                },
              );
            }
          } else {
            const created = versionManager.createFromCandidate(feedback.candidate);
            const score = await scoreCalculator.recalculate(created.playbook.id);
            pipelineEventEmitter.emit(
              "pipeline.playbook.promoted",
              {
                candidateId: feedback.candidate.id,
                playbookId: created.playbook.id,
                compositeScore: score.compositeScore,
              },
              {
                runId: input.runId,
                workflowId: input.workflowId,
              },
            );
          }
        }
      }

      await deps.onRunCompleted?.(input);
    },
    requestNodeApproval: async (input) => {
      if (approvalCallback) {
        await approvalCallback(input);
      }
    },
  });

  // Create approval service with execution reference
  const approvalRepo = createFridayWorkflowApprovalRepository({ db: deps.db });
  const approval = createFridayWorkflowApprovalService({
    approvalRepo,
    executionService: execution,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // Wire the late-binding callback
  approvalCallback = async (input) => {
    await approval.requestForNode(input);
  };

  const triggers = createFridayWorkflowTriggerService({
    db: deps.db,
    executionService: execution,
    workflowRepo,
    triggerRepo: deps.triggerRepo,
    resolveWebhookSecretRef: deps.resolveWebhookSecretRef,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // Wire the late-binding onPublish callback now that triggers exists
  onPublishCallback = async (workflowId) => {
    await triggers.syncPublishedVersionTriggers(workflowId);
  };

  const mapRuntimeEvent = (event: PipelineEvent): FridayWorkflowEvidenceEvent => ({
    eventId: event.eventId,
    event: event.event,
    module: event.module,
    emittedAt: event.emittedAt,
    redacted: event.redacted,
    correlation: {
      runId: event.correlation.runId,
      workflowId: event.correlation.workflowId,
      nodeId: event.correlation.nodeId,
      attempt: event.correlation.attempt,
      traceId: event.correlation.traceId,
      spanId: event.correlation.spanId,
    },
    payload: asRecord(event.payload),
  });

  const listPersistedEvents = (runId: string): FridayWorkflowEvidenceEvent[] =>
    readEvidenceSafely(
      runId,
      () =>
        deps.db.withReadConnection((db) =>
          evidenceRepo.listPipelineEventsByRun(db, runId).flatMap((row) => {
            const module = toEvidenceModule(row.module);
            if (!module) {
              return [];
            }
            return [{
              eventId: row.event_id,
              event: row.event_name,
              module,
              emittedAt: row.emitted_at,
              redacted: row.redacted === 1,
              correlation: {
                runId: row.run_id,
                workflowId: row.workflow_id ?? undefined,
                nodeId: row.node_id ?? undefined,
                attempt: row.attempt ?? undefined,
                traceId: row.trace_id ?? undefined,
                spanId: row.span_id ?? undefined,
              },
              payload: parseJsonObject(row.payload_json),
            }];
          }),
        ),
      [],
    );

  const mapRuntimeRetryTrace = (
    trace: ReturnType<typeof unifiedRetryBridge.getTraces>[number],
  ): FridayWorkflowRetryEvidenceTrace => ({
    runId: trace.runId,
    nodeId: trace.nodeId,
    attempt: trace.attempt,
    category: trace.category,
    errorCode: trace.errorCode,
    errorMessage: trace.errorMessage,
    decision: {
      shouldRetry: trace.decision.shouldRetry,
      delayMs: trace.decision.delayMs,
      reason: trace.decision.reason,
      maxAttempts: trace.decision.maxAttempts,
      budgetExhausted: trace.decision.budgetExhausted,
      circuitOpen: trace.decision.circuitOpen,
      escalateToDlq: trace.decision.escalateToDlq,
    },
    timestamp: trace.timestamp,
  });

  const listPersistedRetryTraces = (runId: string): FridayWorkflowRetryEvidenceTrace[] =>
    readEvidenceSafely(
      runId,
      () =>
        deps.db.withReadConnection((db) =>
          evidenceRepo.listRetryTracesByRun(db, runId).map((row) => {
            const decision = parseJsonObject(row.decision_json);
            return {
              runId: row.run_id,
              nodeId: row.node_id,
              attempt: row.attempt,
              category: row.category,
              errorCode: row.error_code,
              errorMessage: row.error_message ?? undefined,
              decision: {
                shouldRetry: decision.shouldRetry === true,
                delayMs: typeof decision.delayMs === "number" ? decision.delayMs : 0,
                reason: asString(decision.reason) ?? "unknown",
                maxAttempts: typeof decision.maxAttempts === "number" ? decision.maxAttempts : 0,
                budgetExhausted: decision.budgetExhausted === true,
                circuitOpen: decision.circuitOpen === true,
                escalateToDlq: decision.escalateToDlq === true,
              },
              timestamp: row.timestamp,
            };
          }),
        ),
      [],
    );

  const mapRuntimePlaybookTrace = (
    trace: ReturnType<typeof playbookBridge.getTraces>[number],
  ): FridayWorkflowPlaybookEvidenceTrace => ({
    runId: trace.runId,
    workflowId: trace.workflowId,
    phase: trace.phase,
    timestamp: trace.timestamp,
    intake: trace.intakeResult ? {
      decision: trace.intakeResult.decision,
      playbookId: trace.intakeResult.playbookId,
      versionNumber: trace.intakeResult.versionNumber,
      matchScore: trace.intakeResult.matchScore,
      evaluatedAt: trace.intakeResult.evaluatedAt,
    } : undefined,
    feedback: trace.feedbackResult ? {
      candidateId: trace.feedbackResult.candidate?.id ?? null,
      promotedPlaybookId: trace.feedbackResult.candidate?.promotedPlaybookId ?? null,
      promotionDecision: trace.feedbackResult.promotionDecision?.decision ?? null,
      scoreRecalculated: trace.feedbackResult.scoreRecalculated,
      recordedAt: trace.feedbackResult.recordedAt,
    } : undefined,
  });

  const listPersistedPlaybookTraces = (runId: string): FridayWorkflowPlaybookEvidenceTrace[] =>
    readEvidenceSafely(
      runId,
      () =>
        deps.db.withReadConnection((db) =>
          evidenceRepo.listPlaybookTracesByRun(db, runId).map((row) => {
            const intakeJson = parseJsonObject(row.intake_json);
            const feedbackJson = parseJsonObject(row.feedback_json);
            return {
              runId: row.run_id,
              workflowId: row.workflow_id,
              phase: row.phase,
              timestamp: row.timestamp,
              intake: row.intake_json ? {
                decision: asString(intakeJson.decision) ?? "skipped",
                playbookId: asString(intakeJson.playbookId) ?? null,
                versionNumber: typeof intakeJson.versionNumber === "number" ? intakeJson.versionNumber : null,
                matchScore: typeof intakeJson.matchScore === "number" ? intakeJson.matchScore : null,
                evaluatedAt: asString(intakeJson.evaluatedAt) ?? row.timestamp,
              } : undefined,
              feedback: row.feedback_json ? {
                candidateId: asString(feedbackJson.candidateId) ?? null,
                promotedPlaybookId: asString(feedbackJson.promotedPlaybookId) ?? null,
                promotionDecision: asString(feedbackJson.promotionDecision) ?? null,
                scoreRecalculated: feedbackJson.scoreRecalculated === true,
                recordedAt: asString(feedbackJson.recordedAt) ?? row.timestamp,
              } : undefined,
            };
          }),
        ),
      [],
    );

  const listMergedEvents = (runId: string): FridayWorkflowEvidenceEvent[] => {
    const merged = new Map<string, FridayWorkflowEvidenceEvent>();
    for (const event of listPersistedEvents(runId)) {
      merged.set(event.eventId, event);
    }
    for (const event of pipelineEventEmitter.getEvents(runId).map(mapRuntimeEvent)) {
      merged.set(event.eventId, event);
    }
    return Array.from(merged.values()).sort((a, b) => {
      if (a.emittedAt !== b.emittedAt) {
        return a.emittedAt.localeCompare(b.emittedAt);
      }
      return a.eventId.localeCompare(b.eventId);
    });
  };

  const listMergedRetryTraces = (runId: string): FridayWorkflowRetryEvidenceTrace[] => {
    const merged = new Map<string, FridayWorkflowRetryEvidenceTrace>();
    const add = (trace: FridayWorkflowRetryEvidenceTrace): void => {
      const key = [
        trace.runId,
        trace.nodeId,
        String(trace.attempt),
        trace.errorCode,
        trace.timestamp,
        trace.decision.reason,
      ].join("|");
      merged.set(key, trace);
    };
    for (const trace of listPersistedRetryTraces(runId)) {
      add(trace);
    }
    for (const trace of unifiedRetryBridge.getTraces(runId).map(mapRuntimeRetryTrace)) {
      add(trace);
    }
    return Array.from(merged.values()).sort((a, b) => {
      if (a.timestamp !== b.timestamp) {
        return a.timestamp.localeCompare(b.timestamp);
      }
      if (a.nodeId !== b.nodeId) {
        return a.nodeId.localeCompare(b.nodeId);
      }
      return a.attempt - b.attempt;
    });
  };

  const listMergedPlaybookTraces = (runId: string): FridayWorkflowPlaybookEvidenceTrace[] => {
    const merged = new Map<string, FridayWorkflowPlaybookEvidenceTrace>();
    const add = (trace: FridayWorkflowPlaybookEvidenceTrace): void => {
      const key = [
        trace.runId,
        trace.workflowId,
        trace.phase,
        trace.timestamp,
        stringifyForKey(trace.intake),
        stringifyForKey(trace.feedback),
      ].join("|");
      merged.set(key, trace);
    };
    for (const trace of listPersistedPlaybookTraces(runId)) {
      add(trace);
    }
    for (const trace of playbookBridge.getTraces(runId).map(mapRuntimePlaybookTrace)) {
      add(trace);
    }
    return Array.from(merged.values()).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  };

  const parseStoredSummary = (value: string): FridayWorkflowRunEvidenceSummary => {
    const parsed = parseJsonObject(value);
    const base = createEmptyEvidenceSummary();
    const byModule = asRecord(parsed.byModule);
    return {
      totalEvents: typeof parsed.totalEvents === "number" ? parsed.totalEvents : base.totalEvents,
      byModule: {
        rules: typeof byModule.rules === "number" ? byModule.rules : 0,
        "node-runner": typeof byModule["node-runner"] === "number" ? byModule["node-runner"] : 0,
        acceptance: typeof byModule.acceptance === "number" ? byModule.acceptance : 0,
        retry: typeof byModule.retry === "number" ? byModule.retry : 0,
        playbook: typeof byModule.playbook === "number" ? byModule.playbook : 0,
      },
      retryTraceCount: typeof parsed.retryTraceCount === "number" ? parsed.retryTraceCount : 0,
      playbookTraceCount: typeof parsed.playbookTraceCount === "number" ? parsed.playbookTraceCount : 0,
      acceptanceDecisions: {
        passed: typeof asRecord(parsed.acceptanceDecisions).passed === "number"
          ? asRecord(parsed.acceptanceDecisions).passed as number
          : 0,
        warned: typeof asRecord(parsed.acceptanceDecisions).warned === "number"
          ? asRecord(parsed.acceptanceDecisions).warned as number
          : 0,
        failed: typeof asRecord(parsed.acceptanceDecisions).failed === "number"
          ? asRecord(parsed.acceptanceDecisions).failed as number
          : 0,
      },
    };
  };

  const buildEvidenceResponse = (
    runId: string,
    query: FridayWorkflowRunEvidenceQuery = {},
  ): FridayWorkflowRunEvidenceResponse => {
    const normalizedQuery = normalizeEvidenceQuery(query);
    const allowedModules = new Set<FridayWorkflowEvidenceModule>(
      normalizedQuery.modules ?? [...ALL_EVIDENCE_MODULES],
    );
    const allowedEventNames = normalizedQuery.eventNames
      ? new Set(normalizedQuery.eventNames)
      : null;

    const eventMatches = (event: FridayWorkflowEvidenceEvent): boolean => {
      if (!allowedModules.has(event.module)) {
        return false;
      }
      if (allowedEventNames && !allowedEventNames.has(event.event)) {
        return false;
      }
      if (normalizedQuery.nodeId && event.correlation.nodeId !== normalizedQuery.nodeId) {
        return false;
      }
      if (normalizedQuery.attempt !== undefined && event.correlation.attempt !== normalizedQuery.attempt) {
        return false;
      }
      return true;
    };

    const rawEvents = listMergedEvents(runId).filter(eventMatches);
    const limitedEvents = normalizedQuery.limit !== undefined && rawEvents.length > normalizedQuery.limit
      ? rawEvents.slice(-normalizedQuery.limit)
      : rawEvents;

    const events: FridayWorkflowEvidenceEvent[] = limitedEvents;
    const acceptanceEvents = events.filter((event) => event.module === "acceptance");
    const retryEvents = events.filter((event) => event.module === "retry");

    const retryTraces: FridayWorkflowRetryEvidenceTrace[] = allowedModules.has("retry")
      ? listMergedRetryTraces(runId).filter((trace) => {
        if (normalizedQuery.nodeId && trace.nodeId !== normalizedQuery.nodeId) {
          return false;
        }
        if (normalizedQuery.attempt !== undefined && trace.attempt !== normalizedQuery.attempt) {
          return false;
        }
        return true;
      })
      : [];

    const playbookTraces: FridayWorkflowPlaybookEvidenceTrace[] = allowedModules.has("playbook")
      ? listMergedPlaybookTraces(runId)
      : [];

    const byModule = {
      rules: 0,
      "node-runner": 0,
      acceptance: 0,
      retry: 0,
      playbook: 0,
    } as Record<FridayWorkflowEvidenceModule, number>;
    for (const event of events) {
      byModule[event.module] = (byModule[event.module] ?? 0) + 1;
    }

    const acceptanceDecisions = {
      passed: acceptanceEvents.filter((event) => event.event === "pipeline.acceptance.passed").length,
      warned: acceptanceEvents.filter((event) => event.event === "pipeline.acceptance.warned").length,
      failed: acceptanceEvents.filter((event) => event.event === "pipeline.acceptance.failed").length,
    };

    const correlationMap = new Map<string, FridayWorkflowRunEvidenceCorrelationRow & { _moduleSet: Set<FridayWorkflowEvidenceModule> }>();
    const upsertCorrelation = (nodeId: string, attempt: number): FridayWorkflowRunEvidenceCorrelationRow & { _moduleSet: Set<FridayWorkflowEvidenceModule> } => {
      const key = `${nodeId}#${attempt}`;
      const existing = correlationMap.get(key);
      if (existing) {
        return existing;
      }
      const created: FridayWorkflowRunEvidenceCorrelationRow & { _moduleSet: Set<FridayWorkflowEvidenceModule> } = {
        nodeId,
        attempt,
        eventCount: 0,
        modules: [],
        retryTraceCount: 0,
        _moduleSet: new Set(),
      };
      correlationMap.set(key, created);
      return created;
    };

    for (const event of events) {
      const nodeId = event.correlation.nodeId;
      if (!nodeId) {
        continue;
      }
      const attempt = event.correlation.attempt ?? 1;
      const row = upsertCorrelation(nodeId, attempt);
      row.eventCount += 1;
      row._moduleSet.add(event.module);
    }

    for (const trace of retryTraces) {
      const row = upsertCorrelation(trace.nodeId, trace.attempt);
      row.retryTraceCount += 1;
      row._moduleSet.add("retry");
    }

    const correlationItems = Array.from(correlationMap.values())
      .map((item) => ({
        nodeId: item.nodeId,
        attempt: item.attempt,
        eventCount: item.eventCount,
        modules: Array.from(item._moduleSet.values()).sort() as FridayWorkflowEvidenceModule[],
        retryTraceCount: item.retryTraceCount,
      }))
      .sort((a, b) => {
        if (a.nodeId !== b.nodeId) {
          return a.nodeId.localeCompare(b.nodeId);
        }
        return a.attempt - b.attempt;
      });

    const evidenceStatus = getRunEvidenceStatus(runId);
    const completionVerification = getRunCompletionVerification(runId);
    const rawRun = execution.getRun(runId);
    const run = rawRun
      ? { ...rawRun, evidenceStatus, completionVerification }
      : null;
    return {
      run,
      exportedAt: deps.nowIso(),
      query: normalizedQuery,
      summary: {
        totalEvents: events.length,
        byModule,
        retryTraceCount: retryTraces.length,
        playbookTraceCount: playbookTraces.length,
        acceptanceDecisions,
      },
      events,
      playbook: {
        traces: playbookTraces,
      },
      acceptance: {
        events: acceptanceEvents,
      },
      retry: {
        events: retryEvents,
        traces: retryTraces,
      },
      correlation: {
        items: correlationItems,
      },
      evidenceStatus,
      completionVerification,
    };
  };

  const writeEvidenceExportFile = (
    runId: string,
    exportId: string,
    content: string,
  ): { uri: string; filePersisted: boolean } => {
    const defaultUri = `friday://workflow-runs/${runId}/evidence-exports/${exportId}.json`;
    try {
      const runDir = path.join(evidenceExportRootDir, runId);
      fs.mkdirSync(runDir, { recursive: true });
      const filePath = path.join(runDir, `${exportId}.json`);
      fs.writeFileSync(filePath, content, "utf8");
      return { uri: toFileUri(filePath), filePersisted: true };
    } catch (err) {
      console.warn("[friday][workflow-runtime] persist-evidence-export:", err instanceof Error ? err.message : String(err));
      return { uri: defaultUri, filePersisted: false };
    }
  };

  const parseEvidencePayloadWithFallback = (
    primaryPayloadJson: string,
    fallbackPayloadJson: string,
  ): FridayWorkflowRunEvidenceResponse => {
    try {
      return JSON.parse(primaryPayloadJson) as FridayWorkflowRunEvidenceResponse;
    } catch (err) {
      console.warn("[friday][workflow-runtime] parse-evidence-payload:", err instanceof Error ? err.message : String(err));
      return JSON.parse(fallbackPayloadJson) as FridayWorkflowRunEvidenceResponse;
    }
  };

  const readEvidenceExportContent = (
    uri: string,
    fallbackPayloadJson: string,
  ): { payloadJson: string; filePersisted: boolean; filePath?: string } => {
    const filePath = fromFileUri(uri);
    if (!filePath) {
      return { payloadJson: fallbackPayloadJson, filePersisted: false };
    }
    try {
      if (!fs.existsSync(filePath)) {
        return { payloadJson: fallbackPayloadJson, filePersisted: false, filePath };
      }
      const payloadJson = fs.readFileSync(filePath, "utf8");
      return { payloadJson, filePersisted: true, filePath };
    } catch (err) {
      console.warn("[friday][workflow-runtime] read-evidence-export:", err instanceof Error ? err.message : String(err));
      return { payloadJson: fallbackPayloadJson, filePersisted: false, filePath };
    }
  };

  const evidence = {
    getRunEvidence(runId: string, query: FridayWorkflowRunEvidenceQuery = {}) {
      return buildEvidenceResponse(runId, query);
    },
    exportRunEvidence(runId: string, query: FridayWorkflowRunEvidenceQuery = {}): FridayWorkflowRunEvidenceExportRecord {
      const evidencePayload = buildEvidenceResponse(runId, query);
      const createdAt = deps.nowIso();
      const exportId = deps.idGenerator();
      const artifactId = deps.idGenerator();
      const payloadJson = JSON.stringify(evidencePayload);
      const checksum = deps.computeChecksum(payloadJson);
      const fileWrite = writeEvidenceExportFile(runId, exportId, payloadJson);

      let persisted = true;
      const proofRequired = isRunProofRequired(runId);
      try {
        deps.db.withWriteTransaction((db) => {
          artifactRepo.insertArtifact(db, {
            id: artifactId,
            runId,
            nodeId: "__run_evidence__",
            artifactType: "json",
            uri: fileWrite.uri,
            checksum,
            metadata: {
              kind: "workflow_run_evidence_export",
              exportId,
              summary_json: JSON.stringify(evidencePayload.summary),
              query_json: JSON.stringify(evidencePayload.query),
            },
            createdAt,
            updatedAt: createdAt,
          });
          evidenceRepo.insertEvidenceExport(db, {
            id: exportId,
            run_id: runId,
            artifact_id: artifactId,
            uri: fileWrite.uri,
            checksum,
            query_json: JSON.stringify(evidencePayload.query),
            summary_json: JSON.stringify(evidencePayload.summary),
            payload_json: payloadJson,
            created_at: createdAt,
          });
        });
      } catch (error) {
        persisted = false;
        if (shouldDisableEvidencePersistence(error)) {
          transitionRunEvidenceStatus(runId, "unavailable");
          if (proofRequired) {
            throw buildWorkflowEvidenceUnavailableError(runId, "no such table");
          }
        } else if (proofRequired) {
          throw error;
        }
      }

      return {
        export: {
          exportId,
          runId,
          artifactId,
          uri: fileWrite.uri,
          checksum,
          createdAt,
          persisted,
          filePersisted: fileWrite.filePersisted,
          query: evidencePayload.query,
          summary: evidencePayload.summary,
        },
        evidence: evidencePayload,
      };
    },
    getRunEvidenceExport(runId: string, exportId: string): FridayWorkflowRunEvidenceExportRecord | null {
      return readEvidenceSafely(
        runId,
        () =>
          deps.db.withReadConnection((db) => {
            const row = evidenceRepo.getEvidenceExportById(db, runId, exportId);
            if (!row) {
              return null;
            }
            const content = readEvidenceExportContent(row.uri, row.payload_json);
            const evidencePayload = parseEvidencePayloadWithFallback(content.payloadJson, row.payload_json);
            const queryPayload = parseJsonObject(row.query_json) as FridayWorkflowRunEvidenceQuery;
            const summaryPayload = parseStoredSummary(row.summary_json);
            return {
              export: {
                exportId: row.id,
                runId: row.run_id,
                artifactId: row.artifact_id,
                uri: row.uri,
                checksum: row.checksum,
                createdAt: row.created_at,
                persisted: true,
                filePersisted: content.filePersisted,
                query: normalizeEvidenceQuery(queryPayload),
                summary: summaryPayload,
              },
              evidence: evidencePayload,
            };
          }),
        null,
      );
    },
    listRunEvidenceExports(runId: string, limit = 20): FridayWorkflowRunEvidenceExport[] {
      const normalizedLimit = normalizePositiveLimit(limit, 20);
      return readEvidenceSafely(
        runId,
        () =>
          deps.db.withReadConnection((db) =>
            evidenceRepo
              .listEvidenceExportsByRun(db, runId, normalizedLimit)
              .map((row) => {
                const filePath = fromFileUri(row.uri);
                const filePersisted = filePath ? fs.existsSync(filePath) : false;
                return {
                  exportId: row.id,
                  runId: row.run_id,
                  artifactId: row.artifact_id,
                  uri: row.uri,
                  checksum: row.checksum,
                  createdAt: row.created_at,
                  persisted: true,
                  filePersisted,
                  query: normalizeEvidenceQuery(
                    parseJsonObject(row.query_json) as FridayWorkflowRunEvidenceQuery,
                  ),
                  summary: parseStoredSummary(row.summary_json),
                };
              }),
          ),
        [],
      );
    },
    downloadRunEvidenceExport(runId: string, exportId: string): FridayWorkflowRunEvidenceExportDownload | null {
      const record = evidence.getRunEvidenceExport(runId, exportId);
      if (!record) {
        return null;
      }
      const filePath = fromFileUri(record.export.uri);
      if (filePath && fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf8");
        return {
          export: { ...record.export, filePersisted: true },
          file: {
            uri: record.export.uri,
            path: filePath,
            exists: true,
            sizeBytes: Buffer.byteLength(content, "utf8"),
          },
          content,
        };
      }
      const content = JSON.stringify(record.evidence, null, 2);
      return {
        export: { ...record.export, filePersisted: false },
        file: {
          uri: record.export.uri,
          path: filePath ?? undefined,
          exists: false,
        },
        content,
      };
    },
    getRunEvidenceStatus(runId: string): FridayWorkflowRunEvidenceStatus {
      return getRunEvidenceStatus(runId);
    },
    getRunCompletionVerification(runId: string): FridayNodeCompletionVerification {
      return getRunCompletionVerification(runId);
    },
  };

  return { crud, execution, triggers, approval, evidence };
}
