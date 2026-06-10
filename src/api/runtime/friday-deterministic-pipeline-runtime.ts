import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import { safeJsonParse } from "#utilities";
import {
  AcceptanceRunState,
  AcceptanceTestSuiteRunner,
  createFridayAcceptanceRepository,
  type FridayAcceptanceArtifactType,
  type FridayAcceptanceCheckConfig,
  type FridayAcceptanceRunResult,
  type FridayAcceptanceRunRow,
  type FridayAcceptanceTest,
  type FridayAcceptanceTestRow,
  type FridayAcceptanceTestVersionRow,
  InMemoryTestRegistry,
} from "#acceptance";
import {
  AgentNodeAdapter,
  createNodeRunnerPipeline,
  type FridayNodeAdapter,
  type FridayNodeArtifact,
  type FridayNodeExecutionContext,
  type FridayNodeExecutionResult,
  type FridayRetryHint,
  type FridayValidationResult,
  NodeAdapterRegistry,
  ToolNodeAdapter,
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
  type FridayPlaybookMatch,
  type FridayPlaybookSelector,
} from "#playbook";
import {
  createFridayPolicyBundleRepository,
  createFridayRulesRepository,
  type FridayEvaluationContext,
  type FridayEvaluationResult,
  type FridayPolicyBundle,
  type FridayPolicyBundleRow,
  type FridayRule,
  FridayRuleEngine,
  type FridayRuleRow,
} from "#rules";

import {
  createWorkflowUnifiedRetryBridge,
  type WorkflowRetryTrace,
} from "../../workflows/engine/friday-workflow-unified-retry-bridge.js";
import {
  createCircuitBreakerManager,
  createFailureClassifier,
  createFridayRetryRepository,
  createRetryStrategyEngine,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  type FridayClassifiedFailure,
  type FridayRetryCostBudget,
  type FridayRetryCostDimensions,
  type FridayRetryPolicy,
  type FridayRetryPolicyRow,
  type FridayRetryStrategy,
  type FridayRetryTraceRow,
} from "#retry";
import {
  resolveFridayPipelineRetryConfig,
  resolveFridayPipelineRuntimeConfig,
} from "../../workflows/engine/friday-workflow-pipeline-mode.js";
import {
  buildDefaultRetryPolicy,
  buildDefaultRetryStrategies,
  DEFAULT_UNIFIED_RETRY_POLICY_ID,
} from "../../retry/engine/friday-default-retry-policy.js";
import type { JsonObject, JsonValue } from "../../workflows/model/friday-workflow.types.js";
import type { FridayDeterministicPipelineRoutesDeps } from "../http/routes/friday-deterministic-pipeline-routes.js";

export interface CreateFridayDeterministicPipelineRuntimeDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  invokeSkill: (
    skillId: string,
    runId: string,
    nodeId: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
  /**
   * Test-oracle only: allows the legacy TypeScript node-runner EXECUTION
   * (`nodeRunner.executeNode`) in isolated test/validation harnesses.
   * Default/live runtime must leave this unset so the method fails closed for
   * ALL callers (the HTTP node-runner route guard is bypassed by a direct method
   * call on this route-deps wrapper). This guards ONLY the route-deps wrapper —
   * NOT the shared `createNodeRunnerPipeline` engine that the live workflow
   * runtime also uses (a separate instance). Never default this flag on in prod.
   */
  allowTestOnlyNodeRunnerExecution?: boolean;
  /**
   * Test-oracle only: allows the legacy TypeScript retry-pipeline mutations
   * (`retry.createPolicy`/`updatePolicy`/`deletePolicy`/`classifyFailure`/
   * `decideRetry`/`acknowledgeEscalation`) in isolated test/validation harnesses.
   * Default/live runtime must leave this unset so the methods fail closed for ALL
   * callers (the HTTP retry route guard is bypassed by a direct method call on
   * these route-deps wrappers). Guards ONLY the route-deps wrappers, not the
   * shared failure-classifier/retry repos. Never default this flag on in prod.
   */
  allowTestOnlyRetryPipelineExecution?: boolean;
}

const RULES_EVALUATE_SCOPE = "rules:evaluate";

const ACCEPTANCE_ARTIFACT_TYPES: readonly FridayAcceptanceArtifactType[] = [
  "json",
  "text",
  "file",
  "image",
  "audio",
  "video",
] as const;

const ALLOWED_RULE_RESOURCES = new Set([
  "filesystem",
  "network",
  "channel",
  "tool",
  "memory",
  "device",
  "shell",
  "skill",
  "workflow",
  "agent",
  "artifact",
  "retry",
  "playbook",
  "desktop",
]);

const ALLOWED_RULE_ACTIONS = new Set([
  "read",
  "write",
  "connect",
  "send",
  "receive",
  "execute",
  "capture",
  "create",
  "delete",
  "update",
  "accept",
  "promote",
  "select",
  "click",
  "type",
  "keypress",
  "scroll",
  "drag",
  "screenshot",
  "read_element",
  "launch_app",
  "close_app",
  "clipboard",
  "file_operation",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function coerceJsonValue(value: unknown): JsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => coerceJsonValue(item));
  }
  if (typeof value === "object" && value !== null) {
    const out: JsonObject = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = coerceJsonValue(val);
    }
    return out;
  }
  return String(value);
}

function toRuleResource(value: unknown): FridayEvaluationContext["resource"] {
  if (typeof value === "string" && ALLOWED_RULE_RESOURCES.has(value)) {
    return value as FridayEvaluationContext["resource"];
  }
  return "workflow";
}

function toRuleAction(value: unknown): FridayEvaluationContext["action"] {
  if (typeof value === "string" && ALLOWED_RULE_ACTIONS.has(value)) {
    return value as FridayEvaluationContext["action"];
  }
  return "execute";
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
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
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
    return typeof parsed === "object" && parsed !== null ? parsed as FridayRule["conditions"] : {};
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

function buildPlaybookConfig(deps: CreateFridayDeterministicPipelineRuntimeDeps): FridayPlaybookEngineConfig {
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
    tags: ["built-in", "baseline"],
    version: 1,
    etag: `${id}-v1`,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function makeEtag(generateId: () => string): string {
  return generateId().replace(/-/g, "").slice(0, 16);
}

function toAcceptanceTestRow(test: FridayAcceptanceTest): FridayAcceptanceTestRow {
  return {
    id: test.id,
    name: test.name,
    description: test.description ?? null,
    artifact_type: test.artifactType,
    check_type: test.checkConfig.checkType,
    config_json: JSON.stringify(test.checkConfig),
    priority: test.priority,
    enabled: test.enabled ? 1 : 0,
    short_circuit: test.shortCircuit ? 1 : 0,
    rule_policy_bundle_id: test.rulePolicyBundleId ?? null,
    tags_json: JSON.stringify(test.tags),
    version: test.version,
    etag: test.etag,
    created_at: test.createdAt,
    updated_at: test.updatedAt,
    deleted_at: test.deletedAt ?? null,
  };
}

function toAcceptanceRunRow(result: FridayAcceptanceRunResult, artifact: FridayNodeArtifact | null, idempotencyKey?: string): FridayAcceptanceRunRow {
  return {
    id: result.id,
    execution_id: result.executionId,
    artifact_uri: result.artifactUri,
    artifact_type: result.artifactType,
    overall_verdict: result.overallVerdict,
    overall_severity: result.overallSeverity,
    state: result.state,
    checks_total: result.checksTotal,
    checks_passed: result.checksPassed,
    checks_failed: result.checksFailed,
    checks_warned: result.checksWarned,
    checks_skipped: result.checksSkipped,
    duration_ms: result.durationMs,
    result_json: JSON.stringify(result),
    artifact_json: JSON.stringify(artifact ?? null),
    idempotency_key: idempotencyKey ?? null,
    created_at: result.createdAt,
    updated_at: result.createdAt,
  };
}

function zeroRetryCost(): FridayRetryCostDimensions {
  return { tokens: 0, apiCalls: 0, computeMs: 0 };
}

function addRetryCost(
  left: FridayRetryCostDimensions,
  right: Partial<FridayRetryCostDimensions> | undefined,
): FridayRetryCostDimensions {
  return {
    tokens: left.tokens + (right?.tokens ?? 0),
    apiCalls: left.apiCalls + (right?.apiCalls ?? 0),
    computeMs: left.computeMs + (right?.computeMs ?? 0),
  };
}

function toClassifyFailureError(value: unknown):
  | { errorCode: string; errorMessage?: string; httpStatusCode?: number }
  | { errorCode?: string; errorMessage: string; httpStatusCode?: number }
  | { errorCode?: string; errorMessage?: string; httpStatusCode: number }
  | null {
  const payload = asRecord(value);
  const errorCode = asString(payload.errorCode) ?? undefined;
  const errorMessage = asString(payload.errorMessage) ?? undefined;
  const httpStatusCode = typeof payload.httpStatusCode === "number" && Number.isFinite(payload.httpStatusCode)
    ? payload.httpStatusCode
    : undefined;
  if (errorCode) {
    return { errorCode, ...(errorMessage ? { errorMessage } : {}), ...(httpStatusCode !== undefined ? { httpStatusCode } : {}) };
  }
  if (errorMessage) {
    return { errorMessage, ...(httpStatusCode !== undefined ? { httpStatusCode } : {}) };
  }
  if (httpStatusCode !== undefined) {
    return { httpStatusCode };
  }
  return null;
}

function toRetryHint(value: unknown): FridayRetryHint | undefined {
  const payload = asRecord(value);
  if (typeof payload.retryable !== "boolean") {
    return undefined;
  }
  const backoff = asString(payload.backoff);
  const reason = asString(payload.reason);
  return {
    retryable: payload.retryable,
    ...(typeof payload.retryAfterMs === "number" && Number.isFinite(payload.retryAfterMs)
      ? { retryAfterMs: payload.retryAfterMs }
      : {}),
    ...(typeof payload.maxRetries === "number" && Number.isFinite(payload.maxRetries)
      ? { maxRetries: payload.maxRetries }
      : {}),
    ...(backoff === "none" || backoff === "fixed" || backoff === "exponential"
      ? { backoff }
      : {}),
    ...(reason ? { reason } : {}),
  };
}

function normalizeAcceptanceContent(content: unknown): JsonObject {
  const normalizedRaw = coerceJsonValue(content);
  const base: JsonObject = typeof normalizedRaw === "object" && normalizedRaw !== null && !Array.isArray(normalizedRaw)
    ? { ...(normalizedRaw as JsonObject) }
    : { value: normalizedRaw };

  const count = Array.isArray(normalizedRaw)
    ? normalizedRaw.length
    : typeof normalizedRaw === "string"
      ? Math.max(1, normalizedRaw.length)
      : 1;
  base.__friday_count = count;
  return base;
}

class DataNodeAdapter implements FridayNodeAdapter {
  readonly nodeType = "data";

  async load(context: FridayNodeExecutionContext): Promise<JsonObject> {
    return { ...(context.node.config as JsonObject) };
  }

  validateInput(): FridayValidationResult {
    return { valid: true, errors: [] };
  }

  async execute(
    _context: FridayNodeExecutionContext,
    config: JsonObject,
    input: Record<string, unknown>,
  ): Promise<JsonValue> {
    return {
      ...config,
      ...input,
      __transformedAt: new Date().toISOString(),
    } as JsonValue;
  }

  validateOutput(): FridayValidationResult {
    return { valid: true, errors: [] };
  }
}

export function createFridayDeterministicPipelineRuntime(
  deps: CreateFridayDeterministicPipelineRuntimeDeps,
): FridayDeterministicPipelineRoutesDeps {
  const pipelineConfig = resolveFridayPipelineRuntimeConfig(process.env);
  const pipelineRetryConfig = resolveFridayPipelineRetryConfig(
    process.env,
    { retryBudgetMax: 20 },
  );
  const pipelineEnabled = pipelineConfig.enabled;
  const pipelineEnforceMode = pipelineConfig.mode === "enforce";

  // ─── TS Runtime Retirement: METHOD-level fail-closed guards ───
  // Defense-in-depth (orphan off-route leak audit, 2026-06-10): node-runner
  // execution and retry-pipeline mutations were ROUTE-only-guarded (friday-
  // deterministic-pipeline-routes asserts the test-oracle flags before the
  // engine call). These guards fence the route-deps WRAPPERS that this runtime
  // returns (node.runner.execute, retry.*) — NOT the shared `createNodeRunner
  // Pipeline`/classifier engines, which the LIVE workflow runtime uses as
  // separate instances. The runtime is route-deps-only in the hub (bootstrap
  // passes it to the route factory + a no-op health-check; no scheduler/event-bus
  // consumer), so guarding the wrapper fails any future non-route caller closed
  // BEFORE the engine call, with NO effect on the live workflow pipeline. Mirror
  // the route's advertised 503 codes. Reads (get*/list*) stay live (un-guarded).
  function assertNodeRunnerExecutionAllowed(): void {
    if (deps.allowTestOnlyNodeRunnerExecution !== true) {
      throw new FridayDomainError(
        "TS_RUNTIME_NODE_RUNNER_EXECUTION_RETIRED",
        "TypeScript node-runner execution is fail-closed in default/live runtime; use the Rust-owned node-runner entrypoint.",
        {
          httpStatus: 503,
          details: {
            classification: "fail_closed",
            replacement: "rust_owned_node_runner_entrypoint_required",
          },
        },
      );
    }
  }
  function assertRetryPipelineExecutionAllowed(): void {
    if (deps.allowTestOnlyRetryPipelineExecution !== true) {
      throw new FridayDomainError(
        "TS_RUNTIME_RETRY_PIPELINE_RETIRED",
        "TypeScript retry-pipeline mutation is fail-closed in default/live runtime; use the Rust-owned retry entrypoint.",
        {
          httpStatus: 503,
          details: {
            classification: "fail_closed",
            replacement: "rust_owned_retry_pipeline_entrypoint_required",
          },
        },
      );
    }
  }

  const rulesRepository = createFridayRulesRepository();
  const policyBundleRepository = createFridayPolicyBundleRepository();
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
        console.warn("[friday][pipeline-runtime] rule-audit-persist:", err instanceof Error ? err.message : String(err));
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
    // Rules tables may not exist on very old installations; runtime can still boot.
    console.warn("[friday][pipeline-runtime] load-rules:", err instanceof Error ? err.message : String(err));
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
    if (!pipelineEnabled || !pipelineEnforceMode) {
      if (!rawResult.allowed) {
        return {
          ...rawResult,
          decision: "warn",
          allowed: true,
          message: rawResult.message
            ? `[${pipelineConfig.mode}] ${rawResult.message}`
            : `[${pipelineConfig.mode}] policy denied but enforcement is relaxed`,
        };
      }
    }
    return rawResult;
  };

  function assertRuleBundleExists(bundleId: string): void {
    if (!rulesEngine.getPolicyBundle(bundleId)) {
      throw new FridayDomainError(
        "RULES_BUNDLE_NOT_FOUND",
        `Policy bundle '${bundleId}' not found`,
        { httpStatus: 404 },
      );
    }
  }

  const adapterRegistry = new NodeAdapterRegistry({ registerBuiltIns: false });
  adapterRegistry.register(new ToolNodeAdapter({
    toolExecutor: async (context, config, input) => {
      const skillId = asString(config.skillId) ?? asString(config.skill) ?? asString(config.toolId);
      if (!skillId) {
        return coerceJsonValue(input);
      }
      const result = await deps.invokeSkill(skillId, context.runId, context.nodeId, input);
      return coerceJsonValue(result);
    },
  }));
  adapterRegistry.register(new AgentNodeAdapter({
    agentExecutor: async (_context, config, input) => {
      return {
        mode: "deterministic-agent-fallback",
        prompt: asString(config.prompt) ?? null,
        input: coerceJsonValue(input),
      } as JsonObject;
    },
  }));
  adapterRegistry.register(new DataNodeAdapter());

  const nodeRunner = createNodeRunnerPipeline({
    adapterRegistry,
    defaultTimeoutMs: 30_000,
    evaluateRules,
    generateId: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  const nodeExecutions = new Map<string, FridayNodeExecutionResult>();
  const nodeExecutionIndex = new Map<string, { runId: string; workflowId: string; nodeId: string }>();

  const acceptanceRepository = createFridayAcceptanceRepository();
  const retryRepository = createFridayRetryRepository();
  const acceptanceRegistry = new InMemoryTestRegistry();
  const acceptanceRunner = new AcceptanceTestSuiteRunner({
    registry: acceptanceRegistry,
    evaluateRules,
  });
  const acceptanceResults = new Map<string, FridayAcceptanceRunResult>();
  const acceptanceBaselineRegistered = new Set<FridayAcceptanceArtifactType>();
  let acceptancePersistenceAvailable = true;

  function syncAcceptanceRegistry(test: FridayAcceptanceTest): void {
    if (acceptanceRegistry.getById(test.id)) {
      acceptanceRegistry.unregister(test.id);
    }
    if (!test.deletedAt) {
      acceptanceRegistry.register(test);
    }
  }

  function ensureAcceptanceBaseline(artifactType: FridayAcceptanceArtifactType): void {
    if (acceptanceBaselineRegistered.has(artifactType)) {
      return;
    }
    const now = deps.nowIso();
    const baselineTests = [
      buildAcceptanceBaselineTest(
      `${artifactType}-schema`,
      `${artifactType} schema baseline`,
      artifactType,
      10,
      { checkType: "schema", schema: {} },
      now,
      ),
      buildAcceptanceBaselineTest(
      `${artifactType}-quant`,
      `${artifactType} count baseline`,
      artifactType,
      20,
      { checkType: "quantitative", metricPath: "__friday_count", operator: "gte", threshold: 1 },
      now,
      ),
      buildAcceptanceBaselineTest(
      `${artifactType}-quality`,
      `${artifactType} quality baseline`,
      artifactType,
      30,
      { checkType: "quality", dimension: "completeness", minScore: 0, warnScore: 0 },
      now,
      ),
    ];
    for (const test of baselineTests) {
      syncAcceptanceRegistry(test);
    }
    if (acceptancePersistenceAvailable) {
      try {
        deps.db.withWriteTransaction((db) => {
          for (const test of baselineTests) {
            const existing = acceptanceRepository.getTestById(db, test.id);
            if (existing) {
              continue;
            }
            acceptanceRepository.insertTest(db, toAcceptanceTestRow(test));
            const versionRow: FridayAcceptanceTestVersionRow = {
              id: deps.idGenerator(),
              test_id: test.id,
              version: test.version,
              snapshot_json: JSON.stringify(test),
              changed_by: "system",
              change_note: "Baseline registration",
              created_at: test.createdAt,
            };
            acceptanceRepository.insertVersion(db, versionRow);
          }
        });
      } catch (err) {
        console.warn("[friday][pipeline-runtime] acceptance-baseline-persist:", err instanceof Error ? err.message : String(err));
        acceptancePersistenceAvailable = false;
      }
    }
    acceptanceBaselineRegistered.add(artifactType);
  }

  try {
    deps.db.withReadConnection((db) => {
      const persistedTests = acceptanceRepository.listTests(db, {
        includeDeleted: true,
        limit: 10_000,
        offset: 0,
      });
      for (const test of persistedTests) {
        syncAcceptanceRegistry(test);
      }
    });
  } catch (err) {
    console.warn("[friday][pipeline-runtime] load-acceptance-tests:", err instanceof Error ? err.message : String(err));
    acceptancePersistenceAvailable = false;
  }

  for (const artifactType of ACCEPTANCE_ARTIFACT_TYPES) {
    if (acceptanceRegistry.getTests(artifactType).length === 0) {
      ensureAcceptanceBaseline(artifactType);
    } else {
      acceptanceBaselineRegistered.add(artifactType);
    }
  }

  const retryTraces: WorkflowRetryTrace[] = [];
  const retryBridge = createWorkflowUnifiedRetryBridge({
    maxAttempts: pipelineRetryConfig.maxAttempts,
    baseDelayMs: pipelineRetryConfig.baseDelayMs,
    retryBudgetMax: pipelineRetryConfig.retryBudgetMax,
    circuitBreakerThreshold: pipelineRetryConfig.circuitBreakerThreshold,
    onRetryTrace: (trace) => {
      retryTraces.push(trace);
    },
    nowIso: deps.nowIso,
  });
  const failureClassifier = createFailureClassifier({
    generateId: deps.idGenerator,
    nowIso: deps.nowIso,
  });
  const retryStrategyEngine = createRetryStrategyEngine({
    generateId: deps.idGenerator,
    nowIso: deps.nowIso,
  });
  const retryCircuitBreakers = createCircuitBreakerManager({
    ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
    failureThreshold: pipelineRetryConfig.circuitBreakerThreshold,
  });
  const defaultRetryPolicy = buildDefaultRetryPolicy(deps.nowIso(), `${DEFAULT_UNIFIED_RETRY_POLICY_ID}-v1`);
  let retryPersistenceAvailable = true;

  try {
    deps.db.withWriteTransaction((db) => {
      const existing = retryRepository.getPolicyById(db, defaultRetryPolicy.id);
      if (!existing) {
        const row: FridayRetryPolicyRow = {
          id: defaultRetryPolicy.id,
          name: defaultRetryPolicy.name,
          description: defaultRetryPolicy.description ?? null,
          version: defaultRetryPolicy.version,
          priority: defaultRetryPolicy.priority,
          enabled: defaultRetryPolicy.enabled ? 1 : 0,
          tags_json: JSON.stringify(defaultRetryPolicy.tags),
          cost_budget_json: JSON.stringify(defaultRetryPolicy.costBudget),
          strategies_json: JSON.stringify(defaultRetryPolicy.strategies),
          etag: defaultRetryPolicy.etag,
          created_at: defaultRetryPolicy.createdAt,
          updated_at: defaultRetryPolicy.updatedAt,
          deleted_at: null,
        };
        retryRepository.insertPolicy(db, row);
        retryRepository.insertPolicyVersion(db, {
          id: deps.idGenerator(),
          policy_id: row.id,
          version: row.version,
          snapshot_json: JSON.stringify(defaultRetryPolicy),
          changed_by: "system",
          change_note: "Default retry policy bootstrap",
          created_at: row.created_at,
        });
      }
    });
  } catch (err) {
    console.warn("[friday][pipeline-runtime] load-retry-policy:", err instanceof Error ? err.message : String(err));
    retryPersistenceAvailable = false;
  }

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

  return {
    rules: {
      listBundles: (query) => {
        const limit = asNumber(query.limit, 100);
        const offset = asNumber(query.offset, 0);
        const enabledOnly = query.enabledOnly === true || query.enabledOnly === "true";
        const bundles = deps.db.withReadConnection((db) =>
          rulesRepository.listPolicyBundles(db, { enabledOnly, limit, offset }),
        );
        return {
          items: bundles.map((row) => mapBundleRow(row)),
          total: bundles.length,
        };
      },

      getBundle: (bundleId) => {
        const row = deps.db.withReadConnection((db) =>
          rulesRepository.getPolicyBundleById(db, bundleId),
        );
        if (!row) {
          throw new FridayDomainError("RULES_BUNDLE_NOT_FOUND", "Policy bundle not found", { httpStatus: 404 });
        }
        const rules = deps.db.withReadConnection((db) =>
          rulesRepository.listRulesByBundleId(db, bundleId, { enabledOnly: false }),
        );
        return {
          bundle: mapBundleRow(row),
          rules: rules.map((item) => mapRuleRow(item)),
        };
      },

      createBundle: (body) => {
        const payload = asRecord(body);
        const id = asString(payload.id) ?? deps.idGenerator();
        const now = deps.nowIso();
        const tags = Array.isArray(payload.tags)
          ? payload.tags.filter((tag): tag is string => typeof tag === "string")
          : [];
        let domainBundle: FridayPolicyBundle | null = null;
        const domainRules: FridayRule[] = [];

        deps.db.withWriteTransaction((db) => {
          domainBundle = policyBundleRepository.create(db, {
            id,
            name: asString(payload.name) ?? "Untitled Policy Bundle",
            description: asString(payload.description) ?? undefined,
            priority: asNumber(payload.priority, 100),
            enabled: payload.enabled === false ? false : true,
            tags,
            source: "user",
            nowIso: now,
            changedBy: asString(payload.changedBy) ?? undefined,
          });
          if (Array.isArray(payload.rules)) {
            for (const rawRule of payload.rules) {
              const rulePayload = asRecord(rawRule);
              const ruleRow: FridayRuleRow = {
                id: asString(rulePayload.id) ?? deps.idGenerator(),
                policy_bundle_id: id,
                name: asString(rulePayload.name) ?? "Unnamed Rule",
                description: asString(rulePayload.description),
                enabled: rulePayload.enabled === false ? 0 : 1,
                resource: toRuleResource(rulePayload.resource),
                action: toRuleAction(rulePayload.action),
                conditions_json: JSON.stringify(asRecord(rulePayload.conditions)),
                decision: (asString(rulePayload.decision) ?? "allow"),
                message: asString(rulePayload.message),
                priority: asNumber(rulePayload.priority, 100),
                version: asNumber(rulePayload.version, 1),
                etag: deps.idGenerator().slice(0, 16),
                created_at: now,
                updated_at: now,
                deleted_at: null,
              };
              rulesRepository.insertRule(db, ruleRow);
              domainRules.push(mapRuleRow(ruleRow));
            }
          }
        });

        rulesEngine.loadDomainBundle(domainBundle!, domainRules);

        return {
          bundle: domainBundle!,
          rules: domainRules,
        };
      },

      updateBundle: (bundleId, body) => {
        const payload = asRecord(body);
        const now = deps.nowIso();
        const etag = asString(payload.etag);
        if (!etag) {
          throw new FridayDomainError("VALIDATION_ERROR", "etag is required", { httpStatus: 400 });
        }

        const normalized: {
          name?: string;
          description?: string;
          priority?: number;
          enabled?: boolean;
          tags?: string[];
        } = {};

        if (payload.name !== undefined) {
          const name = asString(payload.name);
          if (!name) {
            throw new FridayDomainError("VALIDATION_ERROR", "name must be a non-empty string", {
              httpStatus: 400,
            });
          }
          normalized.name = name;
        }
        if (payload.description !== undefined) {
          if (payload.description === null) {
            throw new FridayDomainError("VALIDATION_ERROR", "description must be a string when provided", {
              httpStatus: 400,
            });
          }
          normalized.description = asString(payload.description) ?? "";
        }
        if (payload.priority !== undefined) {
          if (typeof payload.priority !== "number" || !Number.isFinite(payload.priority) || payload.priority < 0) {
            throw new FridayDomainError("VALIDATION_ERROR", "priority must be a non-negative number", {
              httpStatus: 400,
            });
          }
          normalized.priority = payload.priority;
        }
        if (payload.enabled !== undefined) {
          if (typeof payload.enabled !== "boolean") {
            throw new FridayDomainError("VALIDATION_ERROR", "enabled must be a boolean", {
              httpStatus: 400,
            });
          }
          normalized.enabled = payload.enabled;
        }
        if (payload.tags !== undefined) {
          if (!Array.isArray(payload.tags) || payload.tags.some((tag) => typeof tag !== "string")) {
            throw new FridayDomainError("VALIDATION_ERROR", "tags must be an array of strings", {
              httpStatus: 400,
            });
          }
          normalized.tags = payload.tags as string[];
        }
        if (Object.keys(normalized).length === 0) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "At least one bundle field must be provided",
            { httpStatus: 400 },
          );
        }

        let bundle: FridayPolicyBundle | null = null;
        let rules: FridayRule[] = [];
        deps.db.withWriteTransaction((db) => {
          bundle = policyBundleRepository.update(db, {
            id: bundleId,
            etag,
            nowIso: now,
            changedBy: asString(payload.changedBy) ?? undefined,
            changeNote: asString(payload.changeNote) ?? undefined,
            ...(normalized.name !== undefined ? { name: normalized.name } : {}),
            ...(normalized.description !== undefined ? { description: normalized.description } : {}),
            ...(normalized.priority !== undefined ? { priority: normalized.priority } : {}),
            ...(normalized.enabled !== undefined ? { enabled: normalized.enabled } : {}),
            ...(normalized.tags !== undefined ? { tags: normalized.tags } : {}),
          });
          rules = rulesRepository.listRulesByBundleId(db, bundleId, { enabledOnly: false }).map((row) =>
            mapRuleRow(row)
          );
        });

        rulesEngine.loadDomainBundle(bundle!, rules);
        return {
          bundle: bundle!,
          rules,
        };
      },

      listRules: (bundleId, query) => {
        const enabledOnly = query.enabledOnly === true || query.enabledOnly === "true";
        const rules = deps.db.withReadConnection((db) =>
          rulesRepository.listRulesByBundleId(db, bundleId, { enabledOnly }),
        );
        return {
          items: rules.map((row) => mapRuleRow(row)),
          total: rules.length,
        };
      },

      evaluateRules: (body) => {
        const payload = asRecord(body);
        const bundleId = asString(payload.bundleId);
        if (!bundleId) {
          throw new FridayDomainError("VALIDATION_ERROR", "bundleId is required", { httpStatus: 400 });
        }
        assertRuleBundleExists(bundleId);
        const context: FridayEvaluationContext = {
          resource: toRuleResource(payload.resource),
          action: toRuleAction(payload.action),
          args: asRecord(payload.args) as JsonObject,
          source: "api",
          principalId: asString(payload.principalId) ?? undefined,
          runId: asString(payload.runId) ?? undefined,
          workflowId: asString(payload.workflowId) ?? undefined,
          workflowRunId: asString(payload.workflowRunId) ?? undefined,
          nodeId: asString(payload.nodeId) ?? undefined,
          sessionId: asString(payload.sessionId) ?? undefined,
          metadata: asRecord(payload.metadata) as JsonObject,
          policyBundleIds: [bundleId],
          scopes: [RULES_EVALUATE_SCOPE],
        };
        const result = rulesEngine.evaluate(context, { includeTransitionTrace: true });
        return { result };
      },

      simulateRules: (body) => {
        const payload = asRecord(body);
        const bundleId = asString(payload.bundleId);
        if (!bundleId) {
          throw new FridayDomainError("VALIDATION_ERROR", "bundleId is required", { httpStatus: 400 });
        }
        assertRuleBundleExists(bundleId);
        const context: FridayEvaluationContext = {
          resource: toRuleResource(payload.resource),
          action: toRuleAction(payload.action),
          args: asRecord(payload.args) as JsonObject,
          source: "api",
          principalId: asString(payload.principalId) ?? undefined,
          runId: asString(payload.runId) ?? undefined,
          workflowId: asString(payload.workflowId) ?? undefined,
          workflowRunId: asString(payload.workflowRunId) ?? undefined,
          nodeId: asString(payload.nodeId) ?? undefined,
          sessionId: asString(payload.sessionId) ?? undefined,
          metadata: {
            ...(asRecord(payload.metadata) as JsonObject),
            simulation: true,
          },
          policyBundleIds: [bundleId],
          scopes: [RULES_EVALUATE_SCOPE],
        };
        const result = rulesEngine.evaluate(context, { includeTransitionTrace: true });
        return { result };
      },

      listRuleVersions: (ruleId, query) => {
        const limit = asNumber(query.limit, 50);
        const offset = asNumber(query.offset, 0);
        const items = deps.db.withReadConnection((db) =>
          rulesRepository.listVersions(db, ruleId, limit, offset),
        );
        return { items, total: items.length };
      },

      listBundleVersions: (bundleId, query) => {
        const limit = asNumber(query.limit, 50);
        const offset = asNumber(query.offset, 0);
        const items = deps.db.withReadConnection((db) =>
          policyBundleRepository.listVersions(db, bundleId, limit, offset),
        );
        return { items, total: items.length };
      },

      listEvaluationAuditLog: (query) => {
        const limit = asNumber(query.limit, 100);
        const offset = asNumber(query.offset, 0);
        const ruleId = asString(query.ruleId) ?? undefined;
        const bundleId = asString(query.bundleId) ?? undefined;
        const runId = asString(query.runId) ?? undefined;
        const decision = asString(query.decision);
        const resource = asString(query.resource);
        const action = asString(query.action);
        const principalId = asString(query.principalId);
        const after = asString(query.after);
        const before = asString(query.before);
        const logs = deps.db.withReadConnection((db) =>
          rulesRepository.listEvaluationLogs(db, { ruleId, bundleId, runId, limit: 1000, offset: 0 }),
        ).filter((entry) => {
          if (decision && entry.decision !== decision) return false;
          if (resource && entry.resource !== resource) return false;
          if (action && entry.action !== action) return false;
          if (principalId && entry.principal_id !== principalId) return false;
          if (after && entry.created_at < after) return false;
          if (before && entry.created_at >= before) return false;
          return true;
        });
        const items = logs.slice(offset, offset + limit).map((entry) => ({
          id: entry.id,
          ruleId: entry.rule_id ?? undefined,
          policyBundleId: entry.policy_bundle_id ?? undefined,
          decision: entry.decision,
          resource: entry.resource,
          action: entry.action,
          context: JSON.parse(entry.context_redacted_json) as JsonObject,
          redactionApplied: entry.redaction_applied === 1,
          redactedFields: JSON.parse(entry.redacted_fields_json) as string[],
          matchedRules: JSON.parse(entry.matched_rules_json) as FridayEvaluationResult["matchedRules"],
          durationMs: entry.duration_ms,
          runId: entry.run_id ?? undefined,
          workflowId: entry.workflow_id ?? undefined,
          principalId: entry.principal_id ?? undefined,
          createdAt: entry.created_at,
        }));
        return { items, total: logs.length };
      },
    },

    nodeRunner: {
      async executeNode(body) {
        assertNodeRunnerExecutionAllowed();
        const payload = asRecord(body);
        const nodeId = asString(payload.nodeId) ?? deps.idGenerator();
        const nodeType = asString(payload.nodeType) ?? "action";
        const nodeConfig = asRecord(payload.nodeConfig);
        if (nodeType === "action" && !asString(nodeConfig.actionType)) {
          nodeConfig.actionType = "tool";
        }

        const context: FridayNodeExecutionContext = {
          executionId: asString(payload.executionId) ?? deps.idGenerator(),
          runId: asString(payload.runId) ?? deps.idGenerator(),
          workflowId: asString(payload.workflowId) ?? deps.idGenerator(),
          nodeId,
          attemptNumber: asNumber(payload.attemptNumber, 1),
          node: {
            id: nodeId,
            type: nodeType as FridayNodeExecutionContext["node"]["type"],
            label: asString(payload.label) ?? nodeId,
            config: nodeConfig as JsonObject,
            timeoutMs: asNumber(payload.timeoutMs, 30_000),
          },
          inputData: asRecord(payload.inputData),
          startedAt: deps.nowIso(),
          timeoutMs: asNumber(payload.timeoutMs, 30_000),
          metadata: asRecord(payload.metadata) as JsonObject,
        };

        try {
          const execution = await nodeRunner.execute(context);
          nodeExecutions.set(execution.executionId, execution);
          nodeExecutionIndex.set(execution.executionId, {
            runId: context.runId,
            workflowId: context.workflowId,
            nodeId: context.nodeId,
          });

          if (execution.status === "completed") {
            await learningEngine.processCompletedRun({
              runId: context.runId,
              workflowId: context.workflowId,
              workflowType: asString(payload.workflowType) ?? "workflow-node-runner",
              tags: Array.isArray(payload.tags)
                ? payload.tags.filter((tag): tag is string => typeof tag === "string")
                : [],
              nodeSequence: [{
                nodeType: context.node.type,
                adapterType: asString(context.node.config.actionType) ?? undefined,
              }],
              toolsUsed: [
                asString(context.node.config.skillId),
                asString(context.node.config.toolId),
                asString(context.node.config.adapterKey),
              ].filter((item): item is string => typeof item === "string"),
              parameterKeys: Object.keys(context.inputData),
              durationMs: execution.durationMs,
              cost: { tokenCost: 0, apiCallCost: 0, latencyMs: execution.durationMs },
              success: true,
              completedAt: deps.nowIso(),
            });
          }

          return { execution };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const code =
            (typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
              ? (error as { code: string }).code
              : "NODE_EXECUTION_FAILED");
          const retryDecision = retryBridge.evaluateRetry({
            runId: context.runId,
            nodeId: context.nodeId,
            attempt: context.attemptNumber,
            errorCode: code,
            errorMessage: message,
          });
          throw new FridayDomainError(
            "NODE_EXECUTION_FAILED",
            `Node execution failed: ${message}`,
            {
              httpStatus: 500,
              details: {
                retryDecision,
              },
            },
          );
        }
      },

      getExecution: (executionId) => {
        const execution = nodeExecutions.get(executionId);
        if (!execution) {
          throw new FridayDomainError("EXECUTION_NOT_FOUND", "Node execution not found", { httpStatus: 404 });
        }
        return { execution };
      },

      listExecutions: (query) => {
        const runId = asString(query.runId);
        const workflowId = asString(query.workflowId);
        const nodeId = asString(query.nodeId);
        const status = asString(query.status);
        let items = [...nodeExecutions.values()].map((execution) => ({
          execution,
          meta: nodeExecutionIndex.get(execution.executionId),
        }));
        if (runId) {
          items = items.filter((entry) => entry.meta?.runId === runId);
        }
        if (workflowId) {
          items = items.filter((entry) => entry.meta?.workflowId === workflowId);
        }
        if (nodeId) {
          items = items.filter((entry) => entry.meta?.nodeId === nodeId);
        }
        if (status) {
          items = items.filter((entry) => entry.execution.status === status);
        }
        return { items: items.map((entry) => entry.execution) };
      },
    },

    acceptance: {
      runChecks: async (body) => {
        const payload = asRecord(body);
        const artifactType = asString(payload.artifactType);
        if (!artifactType || !ACCEPTANCE_ARTIFACT_TYPES.includes(artifactType as FridayAcceptanceArtifactType)) {
          throw new FridayDomainError("VALIDATION_ERROR", "artifactType is required", { httpStatus: 400 });
        }
        ensureAcceptanceBaseline(artifactType as FridayAcceptanceArtifactType);

        const executionId = asString(payload.executionId) ?? deps.idGenerator();
        const content = payload.content ?? payload.artifact ?? payload.output ?? {};
        const artifact: FridayNodeArtifact = {
          artifactType: artifactType as FridayAcceptanceArtifactType,
          uri: `memory://acceptance/${deps.idGenerator()}`,
          metadata: {
            content: normalizeAcceptanceContent(content),
          },
        };
        const result = await acceptanceRunner.runForArtifact(executionId, artifact);
        acceptanceResults.set(result.id, result);
        if (acceptancePersistenceAvailable) {
          try {
            deps.db.withWriteTransaction((db) => {
              acceptanceRepository.insertRun(db, toAcceptanceRunRow(result, artifact, asString(payload.idempotencyKey) ?? undefined));
            });
          } catch (err) {
            console.warn("[friday][pipeline-runtime] acceptance-run-persist:", err instanceof Error ? err.message : String(err));
            acceptancePersistenceAvailable = false;
          }
        }
        return { result };
      },

      getResult: (resultId) => {
        const result = acceptanceResults.get(resultId) ?? (acceptancePersistenceAvailable
          ? deps.db.withReadConnection((db) => acceptanceRepository.getRunById(db, resultId))
          : null);
        if (!result) {
          throw new FridayDomainError("ACCEPTANCE_RESULT_NOT_FOUND", "Acceptance result not found", { httpStatus: 404 });
        }
        return { result };
      },

      listResults: (query) => {
        const executionId = asString(query.executionId);
        const overallVerdict = asString(query.overallVerdict);
        let items = [...acceptanceResults.values()];
        if (items.length === 0 && acceptancePersistenceAvailable) {
          try {
            items = deps.db.withReadConnection((db) =>
              acceptanceRepository.listRuns(db, {
                executionId: executionId ?? undefined,
                overallVerdict: overallVerdict ?? undefined,
                limit: asNumber(query.limit, 100),
                offset: asNumber(query.offset, 0),
              }),
            );
          } catch (err) {
            console.warn("[friday][pipeline-runtime] acceptance-list-runs:", err instanceof Error ? err.message : String(err));
            acceptancePersistenceAvailable = false;
          }
        }
        if (executionId) {
          items = items.filter((entry) => asRecord(entry).executionId === executionId);
        }
        if (overallVerdict) {
          items = items.filter((entry) => asRecord(entry).overallVerdict === overallVerdict);
        }
        return { items, total: items.length };
      },

      listTests: (query) => {
        const items = acceptancePersistenceAvailable
          ? deps.db.withReadConnection((db) =>
            acceptanceRepository.listTests(db, {
              artifactType: asString(query.artifactType) ?? undefined,
              checkType: asString(query.checkType) ?? undefined,
              enabled: typeof query.enabled === "boolean"
                ? query.enabled
                : typeof query.enabled === "string"
                  ? query.enabled === "true"
                  : undefined,
              tag: asString(query.tag) ?? undefined,
              includeDeleted: query.includeDeleted === true || query.includeDeleted === "true",
              limit: asNumber(query.limit, 100),
              offset: asNumber(query.offset, 0),
            }),
          )
          : ACCEPTANCE_ARTIFACT_TYPES.flatMap((artifactType) => acceptanceRegistry.getTests(artifactType));
        return { items, total: items.length };
      },

      getTest: (testId) => {
        const test = acceptancePersistenceAvailable
          ? deps.db.withReadConnection((db) => acceptanceRepository.getTestById(db, testId))
          : acceptanceRegistry.getById(testId) ?? null;
        if (!test) {
          throw new FridayDomainError("ACCEPTANCE_TEST_NOT_FOUND", "Acceptance test not found", { httpStatus: 404 });
        }
        return { test };
      },

      createTest: (body) => {
        const payload = asRecord(body);
        const now = deps.nowIso();
        const test: FridayAcceptanceTest = {
          id: asString(payload.id) ?? deps.idGenerator(),
          name: asString(payload.name) ?? "Untitled acceptance test",
          description: asString(payload.description) ?? undefined,
          artifactType: (asString(payload.artifactType) ?? "json") as FridayAcceptanceArtifactType,
          checkConfig: asRecord(payload.checkConfig) as unknown as FridayAcceptanceCheckConfig,
          priority: asNumber(payload.priority, 100),
          enabled: payload.enabled !== false,
          shortCircuit: payload.shortCircuit === true,
          rulePolicyBundleId: asString(payload.rulePolicyBundleId) ?? undefined,
          tags: Array.isArray(payload.tags)
            ? payload.tags.filter((item): item is string => typeof item === "string")
            : [],
          version: 1,
          etag: makeEtag(deps.idGenerator),
          createdAt: now,
          updatedAt: now,
        };
        syncAcceptanceRegistry(test);
        if (acceptancePersistenceAvailable) {
          deps.db.withWriteTransaction((db) => {
            acceptanceRepository.insertTest(db, toAcceptanceTestRow(test));
            acceptanceRepository.insertVersion(db, {
              id: deps.idGenerator(),
              test_id: test.id,
              version: 1,
              snapshot_json: JSON.stringify(test),
              changed_by: "operator",
              change_note: "Created acceptance test",
              created_at: now,
            });
          });
        }
        return { test };
      },

      updateTest: (testId, body) => {
        const payload = asRecord(body);
        const current = acceptancePersistenceAvailable
          ? deps.db.withReadConnection((db) => acceptanceRepository.getTestById(db, testId))
          : acceptanceRegistry.getById(testId) ?? null;
        if (!current) {
          throw new FridayDomainError("ACCEPTANCE_TEST_NOT_FOUND", "Acceptance test not found", { httpStatus: 404 });
        }
        if (current.etag !== asString(payload.etag)) {
          throw new FridayDomainError("ACCEPTANCE_TEST_ETAG_MISMATCH", "Acceptance test etag mismatch", { httpStatus: 409 });
        }
        const updated: FridayAcceptanceTest = {
          ...current,
          name: asString(payload.name) ?? current.name,
          description: payload.description !== undefined ? asString(payload.description) ?? undefined : current.description,
          artifactType: (asString(payload.artifactType) ?? current.artifactType) as FridayAcceptanceArtifactType,
          checkConfig: payload.checkConfig !== undefined
            ? asRecord(payload.checkConfig) as unknown as FridayAcceptanceCheckConfig
            : current.checkConfig,
          priority: payload.priority !== undefined ? asNumber(payload.priority, current.priority) : current.priority,
          enabled: payload.enabled !== undefined ? payload.enabled === true : current.enabled,
          shortCircuit: payload.shortCircuit !== undefined ? payload.shortCircuit === true : current.shortCircuit,
          rulePolicyBundleId: payload.rulePolicyBundleId !== undefined
            ? asString(payload.rulePolicyBundleId) ?? undefined
            : current.rulePolicyBundleId,
          tags: Array.isArray(payload.tags)
            ? payload.tags.filter((item): item is string => typeof item === "string")
            : current.tags,
          version: current.version + 1,
          etag: makeEtag(deps.idGenerator),
          updatedAt: deps.nowIso(),
        };
        syncAcceptanceRegistry(updated);
        if (acceptancePersistenceAvailable) {
          deps.db.withWriteTransaction((db) => {
            acceptanceRepository.updateTest(db, toAcceptanceTestRow(updated));
            acceptanceRepository.insertVersion(db, {
              id: deps.idGenerator(),
              test_id: updated.id,
              version: updated.version,
              snapshot_json: JSON.stringify(updated),
              changed_by: "operator",
              change_note: "Updated acceptance test",
              created_at: updated.updatedAt,
            });
          });
        }
        return { test: updated };
      },

      deleteTest: (testId, body) => {
        const payload = asRecord(body);
        const current = acceptancePersistenceAvailable
          ? deps.db.withReadConnection((db) => acceptanceRepository.getTestById(db, testId))
          : acceptanceRegistry.getById(testId) ?? null;
        if (!current) {
          throw new FridayDomainError("ACCEPTANCE_TEST_NOT_FOUND", "Acceptance test not found", { httpStatus: 404 });
        }
        if (current.etag !== asString(payload.etag)) {
          throw new FridayDomainError("ACCEPTANCE_TEST_ETAG_MISMATCH", "Acceptance test etag mismatch", { httpStatus: 409 });
        }
        acceptanceRegistry.unregister(testId);
        const deleted: FridayAcceptanceTest = {
          ...current,
          version: current.version + 1,
          etag: makeEtag(deps.idGenerator),
          deletedAt: deps.nowIso(),
          updatedAt: deps.nowIso(),
        };
        if (acceptancePersistenceAvailable) {
          deps.db.withWriteTransaction((db) => {
            acceptanceRepository.updateTest(db, toAcceptanceTestRow(deleted));
            acceptanceRepository.insertVersion(db, {
              id: deps.idGenerator(),
              test_id: deleted.id,
              version: deleted.version,
              snapshot_json: JSON.stringify(deleted),
              changed_by: "operator",
              change_note: "Deleted acceptance test",
              created_at: deleted.updatedAt,
            });
          });
        }
        return { deleted: true, testId };
      },

      listVersions: (testId, query) => {
        if (!acceptancePersistenceAvailable) {
          return { items: [], total: 0 };
        }
        const items = deps.db.withReadConnection((db) =>
          acceptanceRepository.listVersions(db, testId, asNumber(query.limit, 50), asNumber(query.offset, 0)),
        );
        return { items, total: items.length };
      },

      listArtifactHistory: (query) => {
        const artifactUri = asString(query.artifactUri);
        if (!artifactUri) {
          throw new FridayDomainError("VALIDATION_ERROR", "artifactUri is required", { httpStatus: 400 });
        }
        if (!acceptancePersistenceAvailable) {
          return { items: [], total: 0 };
        }
        const items = deps.db.withReadConnection((db) =>
          acceptanceRepository.listRunsByArtifact(db, artifactUri, {
            verdict: asString(query.verdict) ?? undefined,
            severity: asString(query.severity) ?? undefined,
            after: asString(query.after) ?? undefined,
            before: asString(query.before) ?? undefined,
            limit: asNumber(query.limit, 100),
            offset: asNumber(query.offset, 0),
          }),
        );
        return { items, total: items.length };
      },
    },

    retry: {
      getPolicy: (policyId) => {
        const policy = retryPersistenceAvailable
          ? deps.db.withReadConnection((db) => retryRepository.getPolicyById(db, policyId))
          : policyId === defaultRetryPolicy.id
            ? defaultRetryPolicy
            : null;
        if (!policy) {
          throw new FridayDomainError("RETRY_POLICY_NOT_FOUND", "Retry policy not found", { httpStatus: 404 });
        }
        return { policy };
      },

      listPolicies: (query) => {
        const items = retryPersistenceAvailable
          ? deps.db.withReadConnection((db) =>
            retryRepository.listPolicies(db, {
              enabled: typeof query.enabled === "boolean"
                ? query.enabled
                : typeof query.enabled === "string"
                  ? query.enabled === "true"
                  : undefined,
              tag: asString(query.tag) ?? undefined,
              includeDeleted: query.includeDeleted === true || query.includeDeleted === "true",
              limit: asNumber(query.limit, 100),
              offset: asNumber(query.offset, 0),
            }),
          )
          : [defaultRetryPolicy];
        return { items, total: items.length };
      },

      createPolicy(body) {
        assertRetryPipelineExecutionAllowed();
        const payload = asRecord(body);
        const now = deps.nowIso();
        const policy: FridayRetryPolicy = {
          id: asString(payload.id) ?? deps.idGenerator(),
          name: asString(payload.name) ?? "Untitled retry policy",
          description: asString(payload.description) ?? undefined,
          version: 1,
          priority: asNumber(payload.priority, 100),
          enabled: payload.enabled !== false,
          tags: Array.isArray(payload.tags)
            ? payload.tags.filter((item): item is string => typeof item === "string")
            : [],
          costBudget: asRecord(payload.costBudget) as unknown as FridayRetryCostBudget,
          strategies: Array.isArray(payload.strategies)
            ? payload.strategies as FridayRetryStrategy[]
            : buildDefaultRetryStrategies(),
          etag: makeEtag(deps.idGenerator),
          createdAt: now,
          updatedAt: now,
        };
        if (retryPersistenceAvailable) {
          deps.db.withWriteTransaction((db) => {
            retryRepository.insertPolicy(db, {
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
            });
            retryRepository.insertPolicyVersion(db, {
              id: deps.idGenerator(),
              policy_id: policy.id,
              version: policy.version,
              snapshot_json: JSON.stringify(policy),
              changed_by: "operator",
              change_note: "Created retry policy",
              created_at: policy.createdAt,
            });
          });
        }
        return { policy };
      },

      updatePolicy(policyId, body) {
        assertRetryPipelineExecutionAllowed();
        const payload = asRecord(body);
        const current = retryPersistenceAvailable
          ? deps.db.withReadConnection((db) => retryRepository.getPolicyById(db, policyId))
          : policyId === defaultRetryPolicy.id
            ? defaultRetryPolicy
            : null;
        if (!current) {
          throw new FridayDomainError("RETRY_POLICY_NOT_FOUND", "Retry policy not found", { httpStatus: 404 });
        }
        if (current.etag !== asString(payload.etag)) {
          throw new FridayDomainError("RETRY_POLICY_ETAG_MISMATCH", "Retry policy etag mismatch", { httpStatus: 409 });
        }
        const updated: FridayRetryPolicy = {
          ...current,
          name: asString(payload.name) ?? current.name,
          description: payload.description !== undefined ? asString(payload.description) ?? undefined : current.description,
          priority: payload.priority !== undefined ? asNumber(payload.priority, current.priority) : current.priority,
          enabled: payload.enabled !== undefined ? payload.enabled === true : current.enabled,
          tags: Array.isArray(payload.tags)
            ? payload.tags.filter((item): item is string => typeof item === "string")
            : current.tags,
          costBudget: payload.costBudget !== undefined
            ? asRecord(payload.costBudget) as unknown as FridayRetryCostBudget
            : current.costBudget,
          strategies: Array.isArray(payload.strategies) ? payload.strategies as FridayRetryStrategy[] : current.strategies,
          version: current.version + 1,
          etag: makeEtag(deps.idGenerator),
          updatedAt: deps.nowIso(),
        };
        if (retryPersistenceAvailable) {
          deps.db.withWriteTransaction((db) => {
            retryRepository.updatePolicy(db, {
              id: updated.id,
              name: updated.name,
              description: updated.description ?? null,
              version: updated.version,
              priority: updated.priority,
              enabled: updated.enabled ? 1 : 0,
              tags_json: JSON.stringify(updated.tags),
              cost_budget_json: JSON.stringify(updated.costBudget),
              strategies_json: JSON.stringify(updated.strategies),
              etag: updated.etag,
              created_at: updated.createdAt,
              updated_at: updated.updatedAt,
              deleted_at: updated.deletedAt ?? null,
            });
            retryRepository.insertPolicyVersion(db, {
              id: deps.idGenerator(),
              policy_id: updated.id,
              version: updated.version,
              snapshot_json: JSON.stringify(updated),
              changed_by: "operator",
              change_note: "Updated retry policy",
              created_at: updated.updatedAt,
            });
          });
        }
        return { policy: updated };
      },

      deletePolicy(policyId, body) {
        assertRetryPipelineExecutionAllowed();
        const payload = asRecord(body);
        const current = retryPersistenceAvailable
          ? deps.db.withReadConnection((db) => retryRepository.getPolicyById(db, policyId))
          : null;
        if (!current) {
          throw new FridayDomainError("RETRY_POLICY_NOT_FOUND", "Retry policy not found", { httpStatus: 404 });
        }
        if (current.etag !== asString(payload.etag)) {
          throw new FridayDomainError("RETRY_POLICY_ETAG_MISMATCH", "Retry policy etag mismatch", { httpStatus: 409 });
        }
        deps.db.withWriteTransaction((db) => {
          retryRepository.softDeletePolicy(db, policyId, current.etag, deps.nowIso());
        });
        return { deleted: true, policyId };
      },

      getTrace: (traceId) => {
        const trace = retryPersistenceAvailable
          ? deps.db.withReadConnection((db) => retryRepository.getTraceById(db, traceId))
          : retryTraces.find((item) => `${item.runId}:${item.nodeId}:${item.attempt}` === traceId) ?? null;
        if (!trace) {
          throw new FridayDomainError("RETRY_TRACE_NOT_FOUND", "Retry trace not found", { httpStatus: 404 });
        }
        return { trace };
      },

      listTraces: (query) => {
        if (retryPersistenceAvailable) {
          const items = deps.db.withReadConnection((db) =>
            retryRepository.listTraces(db, {
              runId: asString(query.runId) ?? undefined,
              workflowId: asString(query.workflowId) ?? undefined,
              nodeId: asString(query.nodeId) ?? undefined,
              status: asString(query.status) ?? undefined,
              failureCategory: asString(query.failureCategory) ?? undefined,
              policyId: asString(query.policyId) ?? undefined,
              after: asString(query.after) ?? undefined,
              before: asString(query.before) ?? undefined,
              limit: asNumber(query.limit, 100),
              offset: asNumber(query.offset, 0),
            }),
          );
          return { items, total: items.length };
        }
        const runId = asString(query.runId);
        return { items: runId ? retryTraces.filter((trace) => trace.runId === runId) : [...retryTraces] };
      },

      classifyFailure(body) {
        assertRetryPipelineExecutionAllowed();
        const payload = asRecord(body);
        const error = toClassifyFailureError(payload.error);
        if (!error) {
          throw new FridayDomainError("VALIDATION_ERROR", "error must include errorCode, errorMessage, or httpStatusCode", { httpStatus: 400 });
        }
        const classifiedFailure = failureClassifier.classifyError(
          error,
          toRetryHint(payload.retryHint),
        );
        return { classifiedFailure };
      },

      decideRetry(body) {
        assertRetryPipelineExecutionAllowed();
        const payload = asRecord(body);
        const classifiedFailure = payload.classifiedFailure
          ? payload.classifiedFailure as FridayClassifiedFailure
          : (() => {
            const error = toClassifyFailureError(payload.error);
            if (!error) {
              throw new FridayDomainError("VALIDATION_ERROR", "error must include errorCode, errorMessage, or httpStatusCode", { httpStatus: 400 });
            }
            return failureClassifier.classifyError(
              error,
              toRetryHint(payload.retryHint),
            );
          })();
        const policyId = asString(payload.retryPolicyId) ?? defaultRetryPolicy.id;
        const policy = retryPersistenceAvailable
          ? deps.db.withReadConnection((db) => retryRepository.getPolicyById(db, policyId))
          : defaultRetryPolicy;
        if (!policy) {
          throw new FridayDomainError("RETRY_POLICY_NOT_FOUND", "Retry policy not found", { httpStatus: 404 });
        }
        const accumulatedCost = asRecord(payload.accumulatedCost) as Partial<FridayRetryCostDimensions>;
        const currentAttemptCost = asRecord(payload.currentAttemptCost) as Partial<FridayRetryCostDimensions>;
        const decision = retryStrategyEngine.buildDecision(
          classifiedFailure,
          {
            runId: asString(payload.runId) ?? deps.idGenerator(),
            workflowId: asString(payload.workflowId) ?? deps.idGenerator(),
            nodeId: asString(payload.nodeId) ?? "node",
            currentAttemptNumber: asNumber(payload.currentAttemptNumber, 1),
            retryPolicyId: policy.id,
            accumulatedCost: addRetryCost(zeroRetryCost(), accumulatedCost),
            currentAttemptCost: addRetryCost(zeroRetryCost(), currentAttemptCost),
            costBudget: policy.costBudget,
            metadata: asRecord(payload.metadata) as JsonObject,
          },
          policy.strategies,
        );
        const targetId = asString(payload.targetId) ?? `${asString(payload.workflowId) ?? "workflow"}:${asString(payload.nodeId) ?? "node"}`;
        if (decision.shouldRetry) {
          retryCircuitBreakers.recordFailure(targetId);
        }
        const snapshot = retryCircuitBreakers.getSnapshot(targetId);
        if (retryPersistenceAvailable) {
          const now = deps.nowIso();
          const traceId = asString(payload.traceId) ?? deps.idGenerator();
          const cumulativeCost = addRetryCost(addRetryCost(zeroRetryCost(), accumulatedCost), currentAttemptCost);
          const traceRow: FridayRetryTraceRow = {
            id: traceId,
            run_id: asString(payload.runId) ?? deps.idGenerator(),
            workflow_id: asString(payload.workflowId) ?? deps.idGenerator(),
            node_id: asString(payload.nodeId) ?? "node",
            status: decision.shouldRetry ? "in_progress" : decision.escalate ? "escalated" : decision.budgetConstrained ? "budget_exceeded" : "exhausted",
            policy_id: policy.id,
            original_failure_category: classifiedFailure.category,
            original_error_code: classifiedFailure.originalErrorCode ?? null,
            original_error_message: classifiedFailure.originalErrorMessage ?? null,
            attempts_json: "[]",
            total_attempts: asNumber(payload.currentAttemptNumber, 1),
            cost_summary_json: JSON.stringify({ budget: policy.costBudget, latestAttemptCost: currentAttemptCost }),
            duration_ms: 0,
            first_failure_at: classifiedFailure.classifiedAt,
            resolved_at: decision.shouldRetry ? null : now,
            created_at: now,
            updated_at: now,
          };
          deps.db.withWriteTransaction((db) => {
            retryRepository.insertTrace(db, traceRow);
            retryRepository.insertAttempt(db, {
              id: deps.idGenerator(),
              trace_id: traceId,
              attempt_number: asNumber(payload.currentAttemptNumber, 1),
              classified_failure_json: JSON.stringify(classifiedFailure),
              decision_json: JSON.stringify(decision),
              delay_ms: decision.delayMs,
              execution_id: asString(payload.executionId) ?? null,
              outcome: decision.shouldRetry ? "failure" : decision.budgetConstrained ? "budget_exceeded" : decision.rulesOverride ? "rules_denied" : "failure",
              cost_record_json: JSON.stringify(cumulativeCost),
              rules_result_json: null,
              error_code: classifiedFailure.originalErrorCode ?? null,
              error_message: classifiedFailure.originalErrorMessage ?? null,
              started_at: now,
              completed_at: now,
              metadata_json: JSON.stringify(asRecord(payload.metadata)),
            });
            retryRepository.insertCostRecord(db, {
              id: deps.idGenerator(),
              trace_id: traceId,
              attempt_number: asNumber(payload.currentAttemptNumber, 1),
              run_id: traceRow.run_id,
              node_id: traceRow.node_id,
              cost_tokens: cumulativeCost.tokens,
              cost_api_calls: cumulativeCost.apiCalls,
              cost_compute_ms: cumulativeCost.computeMs,
              cumulative_tokens: cumulativeCost.tokens,
              cumulative_api_calls: cumulativeCost.apiCalls,
              cumulative_compute_ms: cumulativeCost.computeMs,
              per_attempt_budget_exceeded: 0,
              total_budget_exceeded: decision.budgetConstrained ? 1 : 0,
              recorded_at: now,
            });
            retryRepository.upsertCircuitBreaker(db, {
              target_id: targetId,
              state: snapshot.state,
              consecutive_failures: snapshot.consecutiveFailures,
              failure_threshold: pipelineRetryConfig.circuitBreakerThreshold,
              last_opened_at: snapshot.lastOpenedAt ? new Date(snapshot.lastOpenedAt).toISOString() : null,
              trip_count: snapshot.totalTrips,
              updated_at: now,
            });
            if (decision.escalate) {
              retryRepository.insertEscalation(db, {
                id: deps.idGenerator(),
                trace_id: traceId,
                target: decision.escalationChannel === "operator" ? "operator" : "developer",
                channel: decision.escalationChannel ?? "operator",
                reason: decision.reason,
                failure_category: classifiedFailure.category,
                attempt_count: asNumber(payload.currentAttemptNumber, 1),
                total_cost_tokens: cumulativeCost.tokens,
                total_cost_api_calls: cumulativeCost.apiCalls,
                total_cost_compute_ms: cumulativeCost.computeMs,
                acknowledged: 0,
                escalated_at: now,
                acknowledged_at: null,
              });
            }
          });
        }
        return { classifiedFailure, decision };
      },

      getCostSummary: (query) => {
        if (!retryPersistenceAvailable) {
          return {
            summary: {
              totalCost: zeroRetryCost(),
              originalOperationCost: zeroRetryCost(),
              overheadPercent: { tokensPercent: 0, apiCallsPercent: 0, computeMsPercent: 0 },
              budget: defaultRetryPolicy.costBudget,
              budgetExceeded: false,
              budgetUtilization: { tokensPercent: 0, apiCallsPercent: 0, computeMsPercent: 0 },
              recordCount: 0,
            },
            byCategory: [],
          };
        }
        const traces = deps.db.withReadConnection((db) =>
          retryRepository.listTraces(db, {
            runId: asString(query.runId) ?? undefined,
            workflowId: asString(query.workflowId) ?? undefined,
            nodeId: asString(query.nodeId) ?? undefined,
            policyId: asString(query.policyId) ?? undefined,
            after: asString(query.after) ?? undefined,
            before: asString(query.before) ?? undefined,
            limit: 1000,
            offset: 0,
          }),
        );
        const total = traces.reduce((acc, trace) => addRetryCost(acc, trace.costSummary.totalCost), zeroRetryCost());
        const byCategoryMap = new Map<string, { cost: FridayRetryCostDimensions; attempts: number; resolved: number; escalated: number }>();
        for (const trace of traces) {
          const current = byCategoryMap.get(trace.originalFailureCategory) ?? {
            cost: zeroRetryCost(),
            attempts: 0,
            resolved: 0,
            escalated: 0,
          };
          current.cost = addRetryCost(current.cost, trace.costSummary.totalCost);
          current.attempts += trace.totalAttempts;
          if (trace.status === "resolved") current.resolved += 1;
          if (trace.status === "escalated") current.escalated += 1;
          byCategoryMap.set(trace.originalFailureCategory, current);
        }
        return {
          summary: {
            totalCost: total,
            originalOperationCost: zeroRetryCost(),
            overheadPercent: { tokensPercent: 0, apiCallsPercent: 0, computeMsPercent: 0 },
            budget: defaultRetryPolicy.costBudget,
            budgetExceeded: traces.some((trace) => trace.costSummary.budgetExceeded),
            budgetUtilization: { tokensPercent: 0, apiCallsPercent: 0, computeMsPercent: 0 },
            recordCount: traces.length,
          },
          byCategory: [...byCategoryMap.entries()].map(([category, value]) => ({
            category,
            totalCost: value.cost,
            totalAttempts: value.attempts,
            resolved: value.resolved,
            escalated: value.escalated,
          })),
        };
      },

      listEscalations: (query) => {
        if (!retryPersistenceAvailable) {
          return { items: [], total: 0 };
        }
        const items = deps.db.withReadConnection((db) =>
          retryRepository.listEscalations(db, {
            traceId: asString(query.traceId) ?? undefined,
            acknowledged: typeof query.acknowledged === "boolean"
              ? query.acknowledged
              : typeof query.acknowledged === "string"
                ? query.acknowledged === "true"
                : undefined,
            failureCategory: asString(query.failureCategory) ?? undefined,
            after: asString(query.after) ?? undefined,
            before: asString(query.before) ?? undefined,
            limit: asNumber(query.limit, 100),
            offset: asNumber(query.offset, 0),
          }),
        );
        return { items, total: items.length };
      },

      acknowledgeEscalation(escalationId) {
        assertRetryPipelineExecutionAllowed();
        if (!retryPersistenceAvailable) {
          throw new FridayDomainError("RETRY_ESCALATION_NOT_FOUND", "Retry escalation not found", { httpStatus: 404 });
        }
        const escalation = deps.db.withWriteTransaction((db) =>
          retryRepository.acknowledgeEscalation(db, escalationId, deps.nowIso()),
        );
        if (!escalation) {
          throw new FridayDomainError("RETRY_ESCALATION_NOT_FOUND", "Retry escalation not found", { httpStatus: 404 });
        }
        return { escalation };
      },

      listCircuitBreakers: () => {
        const items = retryPersistenceAvailable
          ? deps.db.withReadConnection((db) => retryRepository.listCircuitBreakers(db))
          : [];
        return { items };
      },
    },

    playbook: {
      selectPlaybook: async (body) => {
        const payload = asRecord(body);
        const selector: FridayPlaybookSelector = {
          workflowType: asString(payload.workflowType) ?? "default",
          workflowId: asString(payload.workflowId) ?? deps.idGenerator(),
          runId: asString(payload.runId) ?? deps.idGenerator(),
          nodeSequence: Array.isArray(payload.nodeSequence)
            ? payload.nodeSequence
              .map((item) => asRecord(item))
              .map((item) => ({
                nodeType: asString(item.nodeType) ?? "action",
                adapterType: asString(item.adapterType) ?? undefined,
              }))
            : [],
          inputSchemas: Array.isArray(payload.inputSchemas) ? payload.inputSchemas as JsonObject[] : undefined,
          tags: Array.isArray(payload.tags)
            ? payload.tags.filter((tag): tag is string => typeof tag === "string")
            : [],
          metadata: asRecord(payload.metadata) as JsonObject,
        };
        const match: FridayPlaybookMatch = await playbookMatcher.select(selector);
        return { match };
      },

      listPlaybooks: (query) => {
        const status = asString(query.status);
        const workflowType = asString(query.workflowType);
        const items = workflowType
          ? playbookStore.getPlaybooksByWorkflowType(workflowType, status as "active" | "rolled_back" | "archived" | undefined)
          : playbookStore.getAllPlaybooks(status as "active" | "rolled_back" | "archived" | undefined);
        return { items };
      },

      getPlaybook: (playbookId) => {
        const playbook = playbookStore.getPlaybook(playbookId);
        if (!playbook) {
          throw new FridayDomainError("PLAYBOOK_NOT_FOUND", "Playbook not found", { httpStatus: 404 });
        }
        const activeVersion = playbookStore.getVersionByNumber(playbookId, playbook.activeVersionNumber) ?? null;
        const latestScore = playbookStore.getLatestScore(playbookId) ?? null;
        return { playbook, activeVersion, latestScore };
      },

      promoteCandidate: async (candidateId, _body) => {
        const candidate = playbookStore.getCandidate(candidateId);
        if (!candidate) {
          throw new FridayDomainError("PLAYBOOK_CANDIDATE_NOT_FOUND", "Playbook candidate not found", { httpStatus: 404 });
        }
        const decision = await promotionEngine.evaluate(candidateId);
        let playbook = null;
        let version = null;
        if (decision.decision === "promote") {
          const promotedCandidate = playbookStore.getCandidate(candidateId);
          if (promotedCandidate) {
            const existingPlaybook = promotedCandidate.promotedPlaybookId
              ? playbookStore.getPlaybook(promotedCandidate.promotedPlaybookId) ?? null
              : playbookStore.getPlaybooksByWorkflowType(promotedCandidate.workflowType, "active")[0] ?? null;

            if (existingPlaybook) {
              version = versionManager.evolve(
                existingPlaybook.id,
                promotedCandidate,
                `Promoted candidate ${candidateId} for workflow type ${promotedCandidate.workflowType}.`,
              );
              playbook = playbookStore.getPlaybook(existingPlaybook.id) ?? existingPlaybook;
            }

            if (!playbook || !version) {
              const created = versionManager.createFromCandidate(promotedCandidate);
              playbook = created.playbook;
              version = created.version;
            }

            await scoreCalculator.recalculate(playbook.id);
          }
        }
        return { decision, playbook, version };
      },

      listCandidates: (query) => {
        const status = asString(query.status);
        const workflowType = asString(query.workflowType);
        const items = status
          ? playbookStore.getCandidatesByStatus(status as "observed" | "pending" | "promoted" | "rejected")
          : workflowType
            ? playbookStore.getCandidatesByWorkflowType(workflowType)
            : [
              ...playbookStore.getCandidatesByStatus("observed"),
              ...playbookStore.getCandidatesByStatus("pending"),
              ...playbookStore.getCandidatesByStatus("promoted"),
              ...playbookStore.getCandidatesByStatus("rejected"),
            ];
        return { items };
      },

      rollbackPlaybook: async (playbookId, body) => {
        const payload = asRecord(body);
        const targetVersionNumber = payload.targetVersionNumber;
        const reason = asString(payload.reason) ?? "Rollback requested";

        const playbook = typeof targetVersionNumber === "number"
          ? versionManager.rollback(playbookId, targetVersionNumber, reason)
          : versionManager.deactivate(playbookId, reason);
        if (!playbook) {
          throw new FridayDomainError("PLAYBOOK_ROLLBACK_FAILED", "Playbook rollback failed", { httpStatus: 400 });
        }
        return { playbook };
      },

      getScoreHistory: (playbookId) => {
        return { items: playbookStore.getScoresByPlaybookId(playbookId) };
      },
    },
  };
}
