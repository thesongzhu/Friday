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
  FridayMarketplaceCommerceRoutesDeps,
  FridayMarketplaceAssetRoutesDeps,
  FridayMarketplaceCreatorRoutesDeps,
  FridayMarketplaceRequestRoutesDeps,
  FridayMultiTenantSecurityRoutesDeps,
  FridayObservabilityRoutesDeps,
  FridaySatellitePairingRoutesDeps,
  FridaySatelliteRuntimeRoutesDeps,
  FridaySkillMarketplaceRoutesDeps,
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

import type { FridayPluginManifest, FridayPluginEntity } from "#plugins";
import type { FridayMarketplacePluginDetail } from "#plugins";

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

/** Minimal valid marketplace plugin detail matching FridayMarketplacePluginDetail. */
const STUB_MARKETPLACE_PLUGIN_DETAIL: FridayMarketplacePluginDetail = {
  id: "stub.plugin",
  name: "Stub Plugin",
  description: "Stub plugin for contract tests",
  version: "0.0.0",
  author: "stub",
  downloads: 0,
  manifest: STUB_PLUGIN_MANIFEST,
  checksum: "0000000000000000000000000000000000000000000000000000000000000000",
  packageUrl: "https://example.com/stub-plugin.tar.gz",
  updatedAt: FIXED_NOW,
};

const EXTENDED_ROUTE_SENTINELS = {
  multiTenantSecurity: "security.tenants.list",
  observability: "observability.traces.search",
  desktop: "desktop.actions.execute",
  channels: "channels.list",
  system: "system.session.get",
  discovery: "discovery.scan",
  mcpServer: "mcp.server.rpc",
  marketplaceCommerce: "marketplace.publishers.create",
  marketplaceAssets: "marketplace.assets.list",
  marketplaceCreators: "marketplace.creators.list",
  marketplaceRequests: "marketplace.requests.list",
  skillMarketplace: "marketplace.sources.list",
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
    savedFiles: [],
    registryRefreshed: false,
    promotionStage: "stabilized" as const,
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
  import: async () => ({
    converterId: "stub",
    detectedFormat: "openai-gpt-action",
    imports: [],
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
  searchMarketplace: async () => ({ items: [], total: 0 }),
  getMarketplacePlugin: async () => STUB_MARKETPLACE_PLUGIN_DETAIL,
  listMarketplacePluginVersions: async () => [],
  installFromMarketplace: async () => ({ ...STUB_PLUGIN_ENTITY, source: "marketplace" as const }),
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
        marketplaceCommerce: {} as FridayMarketplaceCommerceRoutesDeps,
        marketplaceAssets: {
          service: {
            listAssets: async () => [],
            getAsset: async () => null,
          },
        } as FridayMarketplaceAssetRoutesDeps,
        marketplaceCreators: {
          service: {
            listCreators: async () => [],
            getCreator: async () => null,
            recordSupport: async () => ({
              supportEvent: {} as never,
              creator: {} as never,
            }),
          },
        } as FridayMarketplaceCreatorRoutesDeps,
        marketplaceRequests: {
          service: {
            listRequests: async () => [],
            createRequest: async () => ({} as never),
            getRequest: async () => null,
            createResponse: async () => ({} as never),
            acceptResponse: async () => ({} as never),
            closeRequest: async () => ({} as never),
          },
        } as FridayMarketplaceRequestRoutesDeps,
        skillMarketplace: {} as FridaySkillMarketplaceRoutesDeps,
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
        discovery: false,
        mcpServer: true,
        marketplaceCommerce: false,
        marketplaceAssets: false,
        marketplaceCreators: false,
        marketplaceRequests: false,
        skillMarketplace: false,
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
        marketplaceCommerce: true,
        marketplaceAssets: true,
        marketplaceCreators: true,
        marketplaceRequests: true,
        skillMarketplace: true,
        satellitePairing: true,
        satelliteRuntime: true,
      });
      expect(extendedIds.length).toBeGreaterThan(baselineIds.length);
    } finally {
      baselineFixture.close();
      extendedFixture.close();
    }
  });

  it("keeps the route rename migration explicit while exposing only canonical operationIds", () => {
    const fixture = createContractRuntime({ includeExtendedRouteFamilies: true });

    try {
      const renameEntries = Object.entries(FRIDAY_ROUTE_OPERATION_ID_RENAMES).sort(([left], [right]) =>
        left.localeCompare(right),
      );
      expect(renameEntries).toHaveLength(24);
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
