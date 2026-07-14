/**
 * MECHANISM-4 — API Route Surface Contract (Snapshot Test)
 *
 * Captures every registered route as a deterministic JSON contract.
 * If a route is added, removed, or its auth/scope/role shape changes,
 * the snapshot diff will surface it during code review.
 *
 * Run `npm run test:contracts:update` to accept intentional changes.
 */

import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";

import { createFridayApiRuntime } from "#api";
import { createFridayProviderService } from "#providers";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";
import {
  FRIDAY_ROUTE_OPERATION_ID_RENAMES,
  FRIDAY_ROUTE_OPERATION_ID_PATTERN,
} from "../../../src/api/http/friday-http-route-contract.js";

import type {
  FridayAutoFixRoutesDeps,
  FridayChannelRoutesDeps,
  FridayCrossBorderPackRoutesDeps,
  FridayDesktopRoutesDeps,
  FridayDiagnosisRoutesDeps,
  FridayDiscoveryRoutesDeps,
  FridayMcpServerRoutesDeps,
  FridayMultiTenantSecurityRoutesDeps,
  FridayObservabilityRoutesDeps,
  FridaySatellitePairingRoutesDeps,
  FridaySatelliteRuntimeRoutesDeps,
  FridaySystemRoutesDeps,
  FridayUixRoutesDeps,
} from "#api";
import type { FridayHubConfigManagerService } from "#hub";
import type { FridaySkillRegistry } from "#skills";
import type { FridaySkillGeneratorService } from "#skills";
import type { FridaySkillConverterService } from "#skills/converter";
import type { FridayWorkflowGeneratorService } from "#workflows";
import type { FridayMemoryService } from "#memory";
import type { FridayPluginService } from "#plugins";
import type { FridayPluginManifestLoader } from "#plugins";
import type {
  FridayAgentRuntime,
  FridayAgentEventEmitter,
  FridaySubagentRegistry,
} from "#agent";
import type { FridayDeterministicPipelineRoutesDeps } from "../../../src/api/http/routes/friday-deterministic-pipeline-routes.js";

// ─── Deterministic fixtures ────────────────────────────────────────────────

const FIXED_NOW = "2025-06-15T10:00:00.000Z";
const FIXED_TOKEN_SECRET = "contract-test-secret-32-bytes!!";
const EXPLICIT_AUTHENTICATED_ROUTE_EXCEPTIONS = new Set([
  "tui.status.get",
  "tui.jobs.list",
]);

import type { FridayPluginManifest, FridayPluginEntity } from "#plugins";

/** Minimal valid plugin manifest matching FridayPluginManifest. */
const STUB_PLUGIN_MANIFEST: FridayPluginManifest = {
  schemaVersion: "1.0",
  id: "stub.plugin",
  version: "0.0.0",
  name: "Stub Plugin",
  description: "Stub plugin for contract tests",
  kinds: ["skill"],
  entrypoints: { skill: "index.js" },
  permissions: { grants: [], promptOn: [] },
  compatibility: { minHubVersion: "0.0.0", apiVersion: "1" },
};

/** Minimal valid plugin entity matching FridayPluginEntity. */
const STUB_PLUGIN_ENTITY: FridayPluginEntity = {
  id: "stub.plugin",
  name: "Stub Plugin",
  description: "Stub plugin for contract tests",
  version: "0.0.0",
  source: "local",
  status: "installed",
  enabled: false,
  trustMode: "trust_on_install",
  installPath: "/tmp/stub-plugin",
  kinds: ["skill"],
  manifest: STUB_PLUGIN_MANIFEST,
  config: {},
  signatureAlgorithm: null,
  signatureKeyId: null,
  signatureValue: null,
  signatureVerified: false,
  trustedFingerprintSha256: null,
  lastVerifiedAt: null,
  installedAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
  lastErrorCode: null,
  lastErrorMessage: null,
};

const EXTENDED_ROUTE_SENTINELS = {
  multiTenantSecurity: "security.tenants.list",
  observability: "observability.traces.search",
  desktop: "desktop.actions.execute",
  channels: "channels.list",
  system: "system.session.get",
  discovery: "discovery.scan",
  mcpServer: "mcp.server.rpc",
  satellitePairing: "satellites.register",
  satelliteRuntime: "satellites.heartbeat",
} as const;

// ─── Minimal stubs for optional services ───────────────────────────────────

/** Stub skill registry — matches FridaySkillRegistry interface. */
const stubSkillRegistry: FridaySkillRegistry = {
  list: () => [],
  get: () => null,
  resolveByIntent: () => null,
  validateAll: () => [],
  reload: async () => {},
  refresh: async () => {},
  isCompatible: () => ({ compatible: true, reasons: [] }),
  startWatching: async () => {},
  stopWatching: async () => {},
  close: async () => {},
};

/** Stub skill generator service — matches FridaySkillGeneratorService interface. */
const stubSkillGenerator: FridaySkillGeneratorService = {
  startSession: async () => ({
    session: {} as any,
    mode: "clarification_required",
    questions: [],
  }),
  submitTurn: async () => ({
    session: {} as any,
    mode: "clarification_required",
    questions: [],
  }),
  getSession: async () => null,
  generateDraft: async () => ({} as any),
  approveAndSave: async () => ({
    sessionId: "stub",
    skillId: "stub",
    skillDir: "stub",
    candidateId: "stub-candidate",
    candidateDir: "stub-candidate-dir",
    savedFiles: [],
    registryRefreshed: false,
    promotionStage: "candidate_staged" as const,
    candidateManifestTags: [],
    promotedManifestTags: [],
    evidence: {
      sessionId: "stub",
      validationSummary: {
        ok: true,
        repaired: false,
        repairAttempts: 0,
        issueCount: 0,
      },
      repairSummary: {
        attempted: false,
        attempts: 0,
      },
      executableTestSummary: null,
      approvalReadiness: {
        ready: true,
        reason: "stub",
      },
    },
  }),
  cancelSession: async () => {},
};

const stubSkillLifecycle = {
  listSkills: () => [],
  listCatalog: () => ({ items: [], nextCursor: undefined, total: 0 }),
  getSkill: () => null,
  install: async () => ({
    skill: null,
    installation: null,
  }),
  update: async () => ({
    skill: null,
    installation: null,
    updated: false,
  }),
  deleteSkill: async () => ({
    deleted: true,
    skillId: "stub.skill",
  }),
  verifySkill: async () => ({
    skillId: "stub.skill",
    verifiedAt: FIXED_NOW,
    ok: true,
    manifestVerdict: { ok: true, issues: [] },
    packageIntegrity: { available: false, ok: false },
    dependencyCheck: { ok: true, checkedBins: [], missingBins: [] },
    runtimeDryRun: { attempted: false, ok: false, executable: false, reason: "stub" },
    trustSummary: { verdict: "warning" as const, reasons: [] },
  }),
  validateManifest: () => ({ ok: true, issues: [] }),
};

const stubSelfHealingService = {
  listIncidents: () => [],
  getIncident: () => null,
  getIncidentDiagnosis: () => null,
  listActions: () => [],
  getAction: () => null,
  approveAction: async () => ({} as any),
  denyAction: async () => ({} as any),
  executeAction: async () => ({} as any),
  runReadyActions: async () => ({
    summary: {
      inspected: 0,
      executed: 0,
      succeeded: 0,
      failed: 0,
      requiresApproval: 0,
      blockedByPolicy: 0,
      notReady: 0,
      dataProtected: true,
      maxRiskTier: 1,
      limit: 20,
    },
    executed: [],
    skipped: [],
  }),
  rollbackAction: async () => ({} as any),
  getMetrics: () => ({
    day: FIXED_NOW.slice(0, 10),
    incidentsTotal: 0,
    factsUpdated: 0,
    actionsExecuted: 0,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  }),
  listIssueCards: () => [],
  reportStructuredFailure: () => ({
    eventId: "stub-event",
    inserted: true,
    extractedSignals: [],
    factsUpdated: [],
    incidentsCreated: [],
    diagnosisCreated: [],
    lessonsUpdated: [],
    lifecycleState: "steady_state" as const,
  }),
  emitProcessResults: () => {},
} as unknown as FridayDiagnosisRoutesDeps["service"];

const stubUixService = {
  resolveIntent: () => ({
    intent: "general_help" as const,
    confidence: 0.5,
    summary: "General help",
    routeTarget: "/assistant" as const,
    suggestedTemplateIds: [],
  }),
  listTemplates: () => [],
  getDiagnostics: () => ({
    generatedAt: FIXED_NOW,
    taskProfilePresets: [],
    recentRuns: [],
    mcpServerStates: [],
    supportedPreprocessors: [],
  }),
  executeTemplate: async () => ({
    templateId: "stub",
    status: "preview" as const,
    summary: "stub",
    routeTarget: "/assistant" as const,
  }),
  startWizard: () => ({
    wizard: {
      wizardId: "guided-assistant",
      contextId: "ctx-1",
      title: "Guided Assistant",
      status: "awaiting_input" as const,
      currentStepId: "goal",
      steps: [],
      collectedValues: {},
    },
  }),
  continueWizard: async () => ({
    wizard: {
      wizardId: "guided-assistant",
      contextId: "ctx-1",
      title: "Guided Assistant",
      status: "ready" as const,
      currentStepId: "goal",
      steps: [],
      collectedValues: {},
    },
  }),
  listIssues: () => [],
} as unknown as FridayUixRoutesDeps["service"];

const stubConfigManager: FridayHubConfigManagerService = {
  getCurrentConfig: async () => ({ channels: {} } as never),
  getConfig: async () => ({ revision: 1, settings: {} }),
  validatePatch: async () => ({ valid: true, errors: [] }),
  applyPatch: async () => ({ revision: 2, changedKeys: [] }),
  listRevisions: async () => ({ items: [] }),
  revertToRevision: async () => ({ revision: 3, changedKeys: [], revertedFrom: 2 }),
  getSkillRegistrySettings: async () => ({
    workspaceDir: ".",
    bundledSkillsDir: "skills",
    managedSkillsDir: "managed-skills",
    extraSkillDirs: [],
    watchEnabled: false,
    watchDebounceMs: 300,
  }),
  getSkillSecurityProfile: async () => ({}),
};

const stubCrossBorderPackService = {
  getProfile: () => null,
  upsertProfile: () => ({
    packId: "industry-cross-border-ecommerce",
    regionFocus: "sea_tiktok" as const,
    platformPrimary: "tiktok_shop" as const,
    platformSecondary: "public_web" as const,
    storeStage: "new_store" as const,
    categoryL1: "Beauty",
    categoryL2: "Hair Dryers",
    fulfillmentMode: "platform_fulfilled" as const,
    priceBand: "US$19-29",
    adUsage: "light" as const,
    customerServiceMode: "solo_inbox" as const,
    monitoringDepth: "standard" as const,
    watchTargets: [],
    competitorTargets: [],
    workflowPreset: [
      "daily-store-health-check",
      "daily-category-top10-watch",
      "daily-price-gap-watch",
      "daily-customer-service-sweep",
      "weekly-hot-product-review",
      "weekly-operating-profile-tune",
    ],
    adaptationState: {
      status: "tracking" as const,
      firstReviewDueAt: FIXED_NOW,
      stableReviewDueAt: FIXED_NOW,
    },
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  }),
  importBatch: () => ({
    id: "import-1",
    kind: "store_report" as const,
    source: "paste" as const,
    title: "Store report",
    publicLinks: [],
    fileNames: [],
    createdAt: FIXED_NOW,
  }),
  getSnapshot: () => ({
    generatedAt: FIXED_NOW,
    profile: null,
    storeHealth: null,
    categoryWatch: null,
    spikingProducts: null,
    priceGapBoard: null,
    listingQualityBoard: null,
    customerServiceBoard: null,
    workflowRecommendations: [],
    riskClusters: [],
    nextActions: [],
    importSummary: {
      lastImportedAt: null,
      totalImports: 0,
      sourceTypes: [],
    },
  }),
};

/** Stub converter service — matches FridaySkillConverterService interface. */
const stubConverterService: FridaySkillConverterService = {
  listConverters: () => [],
  detect: async () => null,
  convert: async () => ({
    converterId: "stub",
    detectedFormat: "openai-gpt-action",
    drafts: [],
    validation: [],
  }),
  getCandidate: () => null,
  import: async () => ({
    converterId: "stub",
    detectedFormat: "openai-gpt-action",
    candidates: [],
    validation: [],
    registryRefreshed: false,
  }),
  pack: async () => ({
    packageFile: "stub",
    checksumSha256: "stub",
  }),
};

/** Stub workflow generator service — matches FridayWorkflowGeneratorService interface. */
const stubWorkflowGenerator: FridayWorkflowGeneratorService = {
  startSession: async () => ({
    session: {} as any,
    mode: "clarification_required",
    questions: [],
  }),
  submitTurn: async () => ({
    session: {} as any,
    mode: "clarification_required",
    questions: [],
  }),
  getSession: async () => null,
  generateDraft: async () => ({} as any),
  approveAndSave: async () => ({
    sessionId: "stub",
    workflowId: "stub",
    workflowVersionId: "stub",
    versionNumber: 1,
    slug: "stub",
    published: false,
  }),
  cancelSession: async () => {},
};

/** Stub memory service — matches FridayMemoryService interface. */
const stubMemoryService: FridayMemoryService = {
  store: async () => ({
    id: "stub",
    namespace: "general",
    key: "stub",
    content: "",
    source: "stub",
    tags: [],
    metadata: {},
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  }),
  search: async () => [],
  get: async () => null,
  list: async () => [],
  delete: async () => true,
  prune: async () => ({ deletedCount: 0, deletedIds: [], dryRun: false }),
};

/** Stub plugin service — matches FridayPluginService interface. */
const stubPluginService: FridayPluginService = {
  listPlugins: () => [],
  getPlugin: () => null,
  listPluginVersions: () => [],
  installPlugin: () => STUB_PLUGIN_ENTITY,
  enablePlugin: async () => ({ ...STUB_PLUGIN_ENTITY, enabled: true, status: "enabled" as const }),
  disablePlugin: async () => ({ ...STUB_PLUGIN_ENTITY, enabled: false, status: "disabled" as const }),
  uninstallPlugin: async () => {},
};

/** Stub manifest loader — matches FridayPluginManifestLoader interface. */
const stubPluginManifestLoader: FridayPluginManifestLoader = {
  loadFromDirectory: () => STUB_PLUGIN_MANIFEST,
  validate: () => STUB_PLUGIN_MANIFEST,
};

/** Stub agent runtime — matches FridayAgentRuntime interface. */
const stubAgentRuntime: FridayAgentRuntime = {
  executeRun: async () => ({
    runId: "stub",
    status: "completed" as const,
    response: "",
    toolCallCount: 0,
    durationMs: 0,
    usageInput: 0,
    usageOutput: 0,
  }),
};

/** Stub agent event emitter — matches FridayAgentEventEmitter interface. */
const stubAgentEventEmitter: FridayAgentEventEmitter = {
  on: () => {},
  off: () => {},
  emit: () => {},
};

/** Stub sub-agent registry — matches FridaySubagentRegistry interface. */
const stubSubagentRegistry: FridaySubagentRegistry = {
  spawn: async () => ({
    status: "completed" as const,
    response: "",
    toolCallCount: 0,
    durationMs: 0,
    usageInput: 0,
    usageOutput: 0,
  }),
  listByParentRunId: () => [],
  getById: () => null,
  list: () => [],
  activeCountForParent: () => 0,
};

/** Stub deterministic pipeline routes deps — enables global deterministic API surface in contract snapshots. */
const stubDeterministicPipeline: FridayDeterministicPipelineRoutesDeps = {
  rules: {
    listBundles: () => ({ items: [] }),
    getBundle: () => ({ bundle: null }),
    createBundle: () => ({ bundle: null }),
    listRules: () => ({ items: [] }),
    evaluateRules: () => ({ result: { decision: "allow" } }),
    simulateRules: () => ({ result: { decision: "warn" } }),
    listRuleVersions: () => ({ items: [] }),
    listEvaluationAuditLog: () => ({ items: [] }),
  },
  nodeRunner: {
    executeNode: async () => ({ execution: null }),
    getExecution: () => ({ execution: null }),
    listExecutions: () => ({ items: [] }),
  },
  acceptance: {
    runChecks: async () => ({ result: null }),
    getResult: () => ({ result: null }),
    listResults: () => ({ items: [] }),
    listTests: () => ({ items: [] }),
    getTest: () => ({ test: null }),
    createTest: () => ({ test: null }),
    updateTest: () => ({ test: null }),
    deleteTest: () => ({ deleted: true, testId: "test-1" }),
    listVersions: () => ({ items: [] }),
    listArtifactHistory: () => ({ items: [] }),
  },
  retry: {
    getPolicy: () => ({ policy: null }),
    listPolicies: () => ({ items: [] }),
    createPolicy: () => ({ policy: null }),
    updatePolicy: () => ({ policy: null }),
    deletePolicy: () => ({ deleted: true, policyId: "policy-1" }),
    getTrace: () => ({ trace: null }),
    listTraces: () => ({ items: [] }),
    classifyFailure: () => ({ classifiedFailure: null }),
    decideRetry: () => ({ decision: null }),
    getCostSummary: () => ({ summary: null, byCategory: [] }),
    listEscalations: () => ({ items: [] }),
    acknowledgeEscalation: () => ({ escalation: null }),
    listCircuitBreakers: () => ({ items: [] }),
  },
  playbook: {
    selectPlaybook: async () => ({ match: null }),
    listPlaybooks: () => ({ items: [] }),
    getPlaybook: () => ({ playbook: null }),
    promoteCandidate: async () => ({ decision: null }),
    listCandidates: () => ({ items: [] }),
    rollbackPlaybook: async () => ({ playbook: null }),
    getScoreHistory: () => ({ items: [] }),
  },
};

function createContractRuntime(options: { includeExtendedRouteFamilies?: boolean } = {}) {
  const db = createTestDb();
  const idGenerator = createTestIdGenerator();

  const providerService = createFridayProviderService({
    db,
    idGenerator,
    nowIso: () => FIXED_NOW,
  });

  const runtime = createFridayApiRuntime({
    db,
    idGenerator,
    nowIso: () => FIXED_NOW,
    tokenSecret: FIXED_TOKEN_SECRET,
    providerService,
    computeChecksum: (content: string) =>
      crypto.createHash("sha256").update(content).digest("hex"),
    resolveSkill: () => ({ id: "stub" }),
    invokeSkill: async () => ({ output: {} }),
    skillRegistry: stubSkillRegistry,
    skillLifecycle: stubSkillLifecycle as never,
    skillGenerator: stubSkillGenerator,
    diagnosis: { service: stubSelfHealingService } as FridayDiagnosisRoutesDeps,
    autoFix: { service: stubSelfHealingService } as FridayAutoFixRoutesDeps,
    uix: { service: stubUixService } as FridayUixRoutesDeps,
    crossBorderPack: { service: stubCrossBorderPackService } as FridayCrossBorderPackRoutesDeps,
    converterService: stubConverterService,
    workflowGenerator: stubWorkflowGenerator,
    memoryService: stubMemoryService,
    pluginService: stubPluginService,
    pluginManifestLoader: stubPluginManifestLoader,
    agentRuntime: stubAgentRuntime,
    agentEventEmitter: stubAgentEventEmitter,
    subagentRegistry: stubSubagentRegistry,
    deterministicPipeline: stubDeterministicPipeline,
    configManager: stubConfigManager,
    serverVersion: "1.0.0-contract-test",
    ...(options.includeExtendedRouteFamilies
      ? {
        multiTenantSecurity: {} as FridayMultiTenantSecurityRoutesDeps,
        observability: {} as FridayObservabilityRoutesDeps,
        desktop: {} as FridayDesktopRoutesDeps,
        channels: {
          registry: {
            listViews: () => [],
            describe: () => undefined,
          },
        } as FridayChannelRoutesDeps,
        system: {} as FridaySystemRoutesDeps,
        discovery: {} as FridayDiscoveryRoutesDeps,
        mcpServer: {} as FridayMcpServerRoutesDeps,
        satellitePairing: {} as FridaySatellitePairingRoutesDeps,
        satelliteRuntime: {
          recordHeartbeat: async () => ({ accepted: true as const, now: FIXED_NOW, expectedIntervalMs: 15_000, status: "online" }),
          updateCapabilities: async () => ({ accepted: true }),
          pullSync: async () => ({ streamId: "fleet", events: [], queueItems: [], nextCursor: undefined }),
          pushSync: async () => ({ acceptedAcks: 0, rejectedAcks: 0, acceptedEvents: 0, rejectedEvents: 0 }),
          pollCommands: async () => [],
          ackCommand: async () => ({ acked: true }),
        } as Omit<FridaySatelliteRuntimeRoutesDeps, "pullEvents" | "getCheckpoint">,
      }
      : {}),
  });

  return {
    runtime,
    close() {
      db.close();
    },
  };
}

function summariseExtendedRoutePresence(operationIds: readonly string[]) {
  return Object.fromEntries(
    Object.entries(EXTENDED_ROUTE_SENTINELS).map(([family, sentinel]) => [
      family,
      operationIds.includes(sentinel),
    ]),
  );
}

// ─── Test ──────────────────────────────────────────────────────────────────

describe("MECHANISM-4 — API Route Contract (Snapshot)", () => {
  it("captures the full route surface as a stable contract", () => {
    const fixture = createContractRuntime();

    try {
      const rawRoutes = fixture.runtime.routes.getRoutes();

      // ─── Map to pure JSON contract ───
      const contract = rawRoutes.map((route, index) => ({
        index,
        operationId: route.operationId,
        method: route.method,
        path: route.path,
        authKind: route.auth.public ? "public" : "authenticated",
        scopes: route.auth.public ? [] : (route.auth as any).anyOfScopes ?? [],
        roles: route.auth.public ? [] : (route.auth as any).anyOfRoles ?? [],
        rateLimitPolicyId: route.rateLimitPolicyId ?? null,
      }));

      // ─── Assert unique operationIds ───
      const operationIds = contract.map((r) => r.operationId);
      const uniqueIds = new Set(operationIds);
      expect(uniqueIds.size).toBe(operationIds.length);

      // ─── Snapshot ───
      expect(contract).toMatchSnapshot();
    } finally {
      fixture.close();
    }
  });

  it("enforces that all operationIds are unique across the route registry", () => {
    const fixture = createContractRuntime();

    try {
      const routes = fixture.runtime.routes.getRoutes();
      const ids = routes.map((r) => r.operationId);
      const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);

      expect(duplicates).toEqual([]);
      expect(routes.length).toBeGreaterThan(0);
    } finally {
      fixture.close();
    }
  });

  it("captures route count to detect accidental additions/removals", () => {
    const fixture = createContractRuntime();

    try {
      const count = fixture.runtime.routes.getRouteCount();
      expect(count).toMatchSnapshot();
    } finally {
      fixture.close();
    }
  });

  it("keeps authenticated HTTP routes limited to explicit RBAC exceptions", () => {
    const fixture = createContractRuntime({ includeExtendedRouteFamilies: true });

    try {
      const routes = fixture.runtime.routes.getRoutes();
      const offenders: { method: string; path: string; operationId: string; auth: unknown }[] = [];
      for (const route of routes) {
        if (route.auth.public !== true && !EXPLICIT_AUTHENTICATED_ROUTE_EXCEPTIONS.has(route.operationId)) {
          offenders.push({
            method: route.method,
            path: route.path,
            operationId: route.operationId,
            auth: route.auth,
          });
        }
      }
      expect(offenders).toEqual([]);
      expect(routes.length).toBeGreaterThan(0);
    } finally {
      fixture.close();
    }
  });

  it("keeps extended capability-gated route families explicit in contract coverage", () => {
    const baselineFixture = createContractRuntime();
    const extendedFixture = createContractRuntime({ includeExtendedRouteFamilies: true });

    try {
      const baselineIds = baselineFixture.runtime.routes.getRoutes().map((route) => route.operationId);
      const extendedIds = extendedFixture.runtime.routes.getRoutes().map((route) => route.operationId);

      expect(summariseExtendedRoutePresence(baselineIds)).toEqual({
        multiTenantSecurity: false,
        observability: false,
        desktop: false,
        channels: false,
        system: false,
        discovery: true,
        mcpServer: true,
        satellitePairing: false,
        satelliteRuntime: false,
      });
      expect(summariseExtendedRoutePresence(extendedIds)).toEqual({
        multiTenantSecurity: true,
        observability: true,
        desktop: true,
        channels: true,
        system: true,
        discovery: true,
        mcpServer: true,
        satellitePairing: true,
        satelliteRuntime: true,
      });
      expect(extendedIds.length).toBeGreaterThan(baselineIds.length);
    } finally {
      baselineFixture.close();
      extendedFixture.close();
    }
  });

  it("Phase 14.5A WP-001: every public mutating route maps to an accepted gate family", () => {
    // Phase 14.5A / module_28a public-mutating route invariant.
    //
    // Reconciliation:
    //   - User-provided audit (narrow): 9 source-level public mutating routes.
    //   - origin/main cross-check: 229 public mutating routes.
    //   - Active worktree (this test): inventory is enumerated below and each
    //     route is classified by the gate family that protects it.
    //
    // Accepted gate families:
    //   - hmac_or_bearer_opt_in : workflow webhook ingress (HMAC default, bearer-only opt-in
    //     with entropy floor + URL/header redaction).
    //   - channel_signature     : channel webhook ingress (LINE/WhatsApp/Lark) validated by
    //     the channel relay's signature/token (service-level, not runtime-auth).
    //   - bound_principal       : public route handler refuses the synthetic public principal
    //     via assertBoundPrincipalForOperation (Phase 14.5A capability gate).
    //   - rate_limited_pending  : public registration that lands in pending state with an
    //     anti-spam rate limit (e.g. satellite registration / public auth bootstrap).
    //   - public_low_risk       : read-shaped or low-risk mutation that does not need a
    //     bound owner principal (e.g. token refresh which is bound by token replay rules).
    //
    // If a new public mutating route is added, this test fails until it is
    // explicitly classified, preserving the WP-001 invariant.
    const fixture = createContractRuntime({ includeExtendedRouteFamilies: true });
    try {
      const routes = fixture.runtime.routes.getRoutes();
      const mutating = routes.filter((r) =>
        r.auth.public === true && (r.method === "POST" || r.method === "PUT" || r.method === "PATCH" || r.method === "DELETE"),
      );

      // hmac_or_bearer_opt_in
      const HMAC_OR_BEARER_OPT_IN: ReadonlySet<string> = new Set([
        "workflows.webhooks.invoke",
      ]);
      // channel_signature
      const CHANNEL_SIGNATURE: ReadonlySet<string> = new Set([
        "channels.webhooks.line",
        "channels.webhooks.whatsapp",
        "channels.webhooks.telegram",
        "channels.webhooks.lark",
      ]);
      // bound_principal (Phase 14.5A + Phase 14.5B module_28b explicit bound-principal gate)
      const BOUND_PRINCIPAL: ReadonlySet<string> = new Set([
        "agent.runs.approve.plan",
        "agent.runs.reject.plan",
        "agent.runs.approve.tool",
        "agent.runs.reject.tool",
        "satellites.pairing.approve",
        "satellites.pairing.reject",
        "satellites.revoke",
        "security.revoke.satellite",
        "security.revoke.token",
        "workflows.approvals.approve",
        "workflows.approvals.reject",
        "approvals.approve",
        "approvals.reject",
        "task.workflows.claims.evidence.attach",
        "task.workflows.claims.verify",
        "task.workflows.claims.block",
        "task.workflows.closeout",
        // Post-global follow-up: runtime config and standalone secret admin writes.
        "config.update",
        "config.revisions.revert",
        "secrets.create",
        "secrets.update",
        "secrets.delete",
        // Phase 14.5B module_28b: one-click repair / recovery doctor.
        "autofix.actions.run.ready",
        "autofix.actions.approve",
        "autofix.actions.deny",
        "autofix.actions.execute",
        "autofix.actions.rollback",
        // B1 gate surfaces: grant revoke + workflow-family mutating routes.
        "grants.revoke",
        "workflows.create",
        "workflows.update",
        "workflows.archive",
        "workflows.publish",
        "templates.instantiate",
        "drafts.create",
        "workflows.bundles.import",
        "drafts.save",
        "drafts.autosave",
        "drafts.compile",
        "drafts.publish",
        "locks.acquire",
        "locks.renew",
        "locks.release",
        "workflows.deploy",
        "workflows.generator.sessions.create",
        "workflows.generator.sessions.messages.create",
        "workflows.generator.sessions.generate",
        "workflows.generator.sessions.approve",
        "workflows.generator.sessions.cancel",
        "workflows.triggers.update",
        "workflows.triggers.resync",
        "conflicts.resolve",
        "runs.start",
        "runs.evidence.export",
        "runs.cancel",
        "runs.retry",
        "workflows.runs.resume",
        // Phase 17A: user-owned cloud worker setup UX bound-principal mutating ops.
        "cloud.workers.dns.validate",
        "cloud.workers.package.generate",
        "cloud.workers.teardown.receipt",
        // Lane B: organic mission-spine mutations driven over the sealed-WS dispatch arms.
        // Each handler refuses the synthetic public principal via
        // assertBoundPrincipalForOperation before any dispatch (and is flag-OFF/503 by default).
        "mission.spine.intake.create",
        "mission.spine.lifecycle.transition",
        "mission.spine.workitem.status.transition",
        "mission.spine.routedecision.control",
        "agent.d20.worktree.batch.dispatch",
        // Lane M: the memory-confirmation loop's terminal mutation driven over the sealed-WS
        // dispatch arm. Refuses the synthetic public principal before any dispatch; flag-OFF/503
        // by default (the merged Rust arm #753 is gated by FRIDAY_MEMORY_CONFIRM).
        "memory.spine.decide.apply",
        // A1 run-outcome learning decision courier. Refuses the synthetic public principal
        // before any dispatch; flag-OFF/503 by default until the Rust arm is configured.
        "run.outcome.learning.decide.apply",
      ]);
      // rate_limited_pending
      const RATE_LIMITED_PENDING: ReadonlySet<string> = new Set([
        "satellites.register",
        "satellites.handshake",
        "auth.bootstrap.local.passphrase",
        // SEC-SETUP-BOOTSTRAP-001: the device-bound first-run owner claim. Same
        // posture as auth.bootstrap.local.passphrase — public first-boot mutation
        // gated by a localhost-only IP check + single-use install nonce + owner
        // compare-and-set, under the auth.login rate-limit policy.
        "auth.bootstrap.challenge",
        "auth.bootstrap.device.claim",
        "auth.login",
      ]);
      // public_low_risk
      const PUBLIC_LOW_RISK: ReadonlySet<string> = new Set([
        "auth.refresh",
        "auth.logout",
      ]);

      const counts = {
        hmac_or_bearer_opt_in: 0,
        channel_signature: 0,
        bound_principal: 0,
        rate_limited_pending: 0,
        public_low_risk: 0,
        unclassified: 0,
      };
      const unclassified: Array<{ method: string; path: string; operationId: string }> = [];
      for (const route of mutating) {
        if (HMAC_OR_BEARER_OPT_IN.has(route.operationId)) {
          counts.hmac_or_bearer_opt_in += 1;
        } else if (CHANNEL_SIGNATURE.has(route.operationId)) {
          counts.channel_signature += 1;
        } else if (BOUND_PRINCIPAL.has(route.operationId)) {
          counts.bound_principal += 1;
        } else if (RATE_LIMITED_PENDING.has(route.operationId)) {
          counts.rate_limited_pending += 1;
        } else if (PUBLIC_LOW_RISK.has(route.operationId)) {
          counts.public_low_risk += 1;
        } else {
          counts.unclassified += 1;
          unclassified.push({ method: route.method, path: route.path, operationId: route.operationId });
        }
      }

      // Every known Phase 14.5A gate family must have at least one route covered.
      expect(counts.hmac_or_bearer_opt_in).toBe(1);
      expect(counts.channel_signature).toBe(4);
      expect(counts.bound_principal).toBe(BOUND_PRINCIPAL.size);
      expect(counts.rate_limited_pending).toBeGreaterThan(0);

      // The unclassified bucket exists to capture broader public-mutating
      // surfaces (autonomy/packaging/provider/setup/etc.) that still require
      // route-by-route reconciliation before they can be promoted into an
      // accepted gate family. Phase 14.5B module_28b moved the five
      // /v1/auto-fix/* mutating routes from this bucket into BOUND_PRINCIPAL;
      // this post-global follow-up moves runtime config writes and standalone
      // secret admin writes into BOUND_PRINCIPAL. The invariant records
      // the remaining count so any further expansion is visible in this snapshot
      // rather than silently shipping.
      expect(counts.unclassified + counts.hmac_or_bearer_opt_in + counts.channel_signature + counts.bound_principal + counts.rate_limited_pending + counts.public_low_risk).toBe(mutating.length);
      expect({
        total_public_mutating: mutating.length,
        classified: counts,
        unclassified_sample_max_5: unclassified.slice(0, 5).map((entry) => entry.operationId),
      }).toMatchSnapshot();
    } finally {
      fixture.close();
    }
  });

  it("keeps the route rename migration explicit while exposing only canonical operationIds", () => {
    const fixture = createContractRuntime({ includeExtendedRouteFamilies: true });

    try {
      const renameEntries = Object.entries(FRIDAY_ROUTE_OPERATION_ID_RENAMES).sort(([left], [right]) =>
        left.localeCompare(right),
      );
      expect(renameEntries).toHaveLength(20);
      expect(renameEntries.every(([from]) => !FRIDAY_ROUTE_OPERATION_ID_PATTERN.test(from))).toBe(true);
      expect(renameEntries.every(([, to]) => FRIDAY_ROUTE_OPERATION_ID_PATTERN.test(to))).toBe(true);
      expect(renameEntries.some(([, to]) => to.startsWith("packaging."))).toBe(false);

      const operationIds = fixture.runtime.routes
        .getRoutes()
        .map((route) => route.operationId)
        .sort();
      const renameTargets = renameEntries.map(([, to]) => to).sort();

      expect(operationIds.every((operationId) => FRIDAY_ROUTE_OPERATION_ID_PATTERN.test(operationId))).toBe(true);
      expect(renameTargets.every((operationId) => operationIds.includes(operationId))).toBe(true);
      expect(renameEntries.every(([from]) => !operationIds.includes(from))).toBe(true);
    } finally {
      fixture.close();
    }
  });
});
