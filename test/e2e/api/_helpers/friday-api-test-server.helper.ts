/**
 * Shared helper: spins up a real in-memory API test server.
 *
 * Creates real FridayApiRuntime + real FridayHttpServer (from prod) against
 * an in-memory SQLite database.  This ensures all middleware (auth, scopes,
 * roles, rate-limiting, body-size enforcement, error mapping) behaves
 * identically to production.
 */

import * as net from "node:net";
import * as crypto from "node:crypto";

import Database from "better-sqlite3";
import type { FridaySqliteLayer } from "#state";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";
import { createFridayApiRuntime, hashPasswordScrypt } from "#api";
import type { FridayApiRuntime } from "#api";
import { createFridayHttpServer } from "#api";
import type { FridayHttpServer } from "#api";
import { createFridayProviderService, resetMasterKeyCache } from "#providers";
import type { FridayProviderService } from "#providers";
import { createFridayMemoryService } from "#memory";
import type { FridayMemoryService } from "#memory";
import { encodeToken } from "#api";
import type { FridayAccessTokenClaims, FridayScope, FridayRole } from "#api";
import {
  createFridayApprovalRequestRepository,
  createFridayAutoFixActionRepository,
  createFridayDiagnosisRecordRepository,
  createFridayErrorIncidentRepository,
  createFridayLearnedLessonRepository,
  createFridayPreferenceFactRepository,
  createFridaySelfHealingApiService,
  createFridaySelfLearningRuntime,
} from "#learning";
import type { FridaySelfHealingApiService } from "#learning";
import type { FridaySkillConverterService } from "#skills/converter";
import type { FridaySkillGeneratorService } from "#skills/generator";
import type { FridaySkillRegistry } from "#skills";
import type { FridayPluginManifestLoader, FridayPluginService } from "#plugins";
import type { FridayChannelRoutesDeps } from "#api";
import { createFridayUixSurfaceService } from "../../../../src/uix/services/friday-uix-surface-service.js";

// ─── Constants ─────────────────────────────────────────────────────────────

const TOKEN_SECRET = "test-secret-key-for-e2e-tests";
const TEST_API_MASTER_KEY = "17".repeat(32);
const ACCESS_TTL = 900;
const REFRESH_TTL = 604_800;
const NOW = "2025-06-15T10:00:00.000Z";

// ─── In-memory DB ──────────────────────────────────────────────────────────

function createTestDb(): FridaySqliteLayer {
  const db = new Database(":memory:");
  runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

  // Insert a test user (admin, local-only) with password hash — used for auth + FK constraints
  const passwordHash = hashPasswordScrypt("any");
  db.prepare(
    `INSERT OR IGNORE INTO users (id, display_name, role, is_local_only, password_hash, created_at, updated_at)
     VALUES ('test-user', 'Test User', 'admin', 1, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run(passwordHash);

  return {
    dbPath: ":memory:",
    writer: db,
    reads: {
      size: 1,
      withReadConnection<T>(fn: (d: Database.Database) => T): T {
        return fn(db);
      },
      close() {},
    },
    withWriteTransaction<T>(fn: (writerDb: Database.Database) => T): T {
      return db.transaction(() => fn(db))();
    },
    withReadConnection<T>(fn: (d: Database.Database) => T): T {
      return fn(db);
    },
    checkpoint() {},
    optimize() {},
    close() {
      db.close();
    },
  };
}

// ─── ID generator ──────────────────────────────────────────────────────────

function createIdGenerator(): () => string {
  let counter = 0;
  return () => `tid-${String(++counter).padStart(6, "0")}`;
}

// ─── Free port discovery ───────────────────────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Could not determine free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// ─── Test environment ──────────────────────────────────────────────────────

export interface FridayApiTestEnv {
  baseUrl: string;
  apiRuntime: FridayApiRuntime;
  db: FridaySqliteLayer;
  providerService: FridayProviderService;
  selfHealingService?: FridaySelfHealingApiService;
  close(): Promise<void>;
}

export interface CreateFridayApiTestEnvOptions {
  converterService?: FridaySkillConverterService;
  skillGenerator?: FridaySkillGeneratorService;
  skillRegistry?: FridaySkillRegistry;
  pluginService?: FridayPluginService;
  pluginManifestLoader?: FridayPluginManifestLoader;
  memoryService?: FridayMemoryService;
  enableDefaultMemoryService?: boolean;
  enableSelfHealing?: boolean;
  channels?: FridayChannelRoutesDeps;
  /**
   * Test-oracle opt-in for legacy TS workflow-run execution. Default/live runtime
   * leaves workflow start/control surfaces fail-closed while Rust ownership lands.
   */
  allowTestOnlyWorkflowRunExecution?: boolean;
  /**
   * Test-oracle opt-in for legacy TS skill-run execution. Default/live runtime
   * leaves skill run execution fail-closed while Rust ownership lands.
   */
  allowTestOnlySkillRunExecution?: boolean;
  /**
   * Test-oracle opt-in for legacy TS skill verification. Default/live runtime
   * leaves skill verification fail-closed while Rust ownership lands.
   */
  allowTestOnlySkillVerifyExecution?: boolean;
  /**
   * Test-oracle opt-in for legacy TS skill generator sessions. Default/live
   * runtime leaves generator session routes fail-closed while Rust ownership
   * lands.
   */
  allowTestOnlySkillGeneratorExecution?: boolean;
  /**
   * Test-oracle opt-in for legacy TS workflow generator sessions. Default/live
   * runtime leaves generator session routes fail-closed while Rust ownership
   * lands.
   */
  allowTestOnlyWorkflowGeneratorExecution?: boolean;
  /**
   * Test-oracle opt-in for legacy TS workflow catalog mutations. Default/live
   * runtime leaves workflow catalog writes fail-closed while Rust ownership lands.
   */
  allowTestOnlyWorkflowCatalogMutationExecution?: boolean;
  allowTestOnlyWorkflowBuilderDraftExecution?: boolean;
  /**
   * Test-oracle opt-in for legacy TS workflow deploy execution. Default/live
   * runtime leaves workflow deploy fail-closed while Rust ownership lands.
   */
  allowTestOnlyWorkflowDeployExecution?: boolean;
  /**
   * Test-oracle opt-in for legacy TS auto-fix execution. Default/live runtime
   * leaves auto-fix run/execute/rollback surfaces fail-closed while Rust ownership lands.
   */
  allowTestOnlyAutoFixExecution?: boolean;
  /**
   * Test-oracle opt-in for legacy TS session lifecycle/agent-run/memory
   * mutations. Default/live runtime leaves these fail-closed while Rust
   * ownership lands.
   */
  allowTestOnlySessionExecution?: boolean;
  allowTestOnlySessionRunExecution?: boolean;
  allowTestOnlySessionMemoryExtractionExecution?: boolean;
  allowTestOnlyTsMemoryWrites?: boolean;
  allowTestOnlyCrossBorderPackExecution?: boolean;
  allowTestOnlyRealtimeExecution?: boolean;
  allowTestOnlySkillConverterExecution?: boolean;
  resolveSkill?: (skillId: string) => unknown | null;
  invokeSkill?: (
    skillId: string,
    runId: string,
    nodeId: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
}

/**
 * Boots the full API stack in-memory with the real prod HTTP server
 * and returns a handle.
 *
 * Call `close()` in afterAll/afterEach to shut down cleanly.
 */
export async function createFridayApiTestEnv(
  options: CreateFridayApiTestEnvOptions = {},
): Promise<FridayApiTestEnv> {
  const originalMasterKey = process.env.FRIDAY_MASTER_KEY;
  const originalMasterKeySource = process.env.FRIDAY_MASTER_KEY_SOURCE;
  process.env.FRIDAY_MASTER_KEY = TEST_API_MASTER_KEY;
  delete process.env.FRIDAY_MASTER_KEY_SOURCE;
  resetMasterKeyCache();

  const db = createTestDb();
  const idGenerator = createIdGenerator();

  const providerService = createFridayProviderService({
    db,
    idGenerator,
    nowIso: () => NOW,
  });

  const memoryService =
    options.memoryService ??
    (options.enableDefaultMemoryService
      ? createFridayMemoryService({
          db,
          providerService,
          idGenerator,
          nowIso: () => NOW,
        })
      : undefined);

  const selfLearningRuntime = options.enableSelfHealing
    ? createFridaySelfLearningRuntime({
      db,
      idGenerator,
      nowIso: () => NOW,
      // TS Runtime Retirement (G1): opt in so the route-backed executeAction /
      // run-ready / dispatcher paths reach the now-method-guarded execute().
      allowTestOnlyAutoFixExecution: options.allowTestOnlyAutoFixExecution ?? false,
    })
    : undefined;
  const selfHealingService = selfLearningRuntime
    ? createFridaySelfHealingApiService({
      db,
      idGenerator,
      nowIso: () => NOW,
      incidentRepo: createFridayErrorIncidentRepository(),
      diagnosisRepo: createFridayDiagnosisRecordRepository(),
      lessonRepo: createFridayLearnedLessonRepository(),
      actionRepo: createFridayAutoFixActionRepository(),
      approvalRepo: createFridayApprovalRequestRepository(),
      factRepo: createFridayPreferenceFactRepository(),
      diagnosisService: selfLearningRuntime.diagnosis,
      planService: selfLearningRuntime.autoFixPlan,
      riskService: selfLearningRuntime.autoFixRisk,
      executionService: selfLearningRuntime.autoFixExecution,
      rollbackService: selfLearningRuntime.autoFixRollback,
      approvalService: selfLearningRuntime.approvals,
      autoFixDispatcher: selfLearningRuntime.autoFixDispatcher,
      metricsService: selfLearningRuntime.metrics,
      pipeline: selfLearningRuntime.pipeline,
    })
    : undefined;
  const uixService = selfHealingService
    ? createFridayUixSurfaceService({
      idGenerator,
      skillGenerator: options.skillGenerator,
      selfHealing: selfHealingService,
    })
    : undefined;

  const apiRuntime = createFridayApiRuntime({
    db,
    // This harness provisions a master key but no canonical realtime owner
    // (learningUserId), so the identifier pseudonymizer is inactive. Opt into the
    // TEST-ONLY inactive (identity) path so workflow-run realtime publishes do not
    // fail-closed (SEC-REALTIME-EVENT-PII-BY-VALUE / round-6 P0-1); these API e2e
    // tests assert route behavior, not realtime identifier opacity.
    allowTestOnlyInactiveRealtimePseudonym: true,
    idGenerator,
    nowIso: () => NOW,
    tokenSecret: TOKEN_SECRET,
    accessTokenTtlSec: ACCESS_TTL,
    refreshTokenTtlSec: REFRESH_TTL,
    providerService,
    memoryService,
    converterService: options.converterService,
    skillGenerator: options.skillGenerator,
    skillRegistry: options.skillRegistry,
    diagnosis: selfHealingService ? { service: selfHealingService, allowTestOnlyDiagnosisExecution: true } : undefined,
    autoFix: selfHealingService
      ? {
          service: selfHealingService,
          allowTestOnlyAutoFixExecution: options.allowTestOnlyAutoFixExecution ?? false,
        }
      : undefined,
    uix: uixService ? { service: uixService } : undefined,
    pluginService: options.pluginService,
    pluginManifestLoader: options.pluginManifestLoader,
    channels: options.channels,
    allowTestOnlyWorkflowRunExecution: options.allowTestOnlyWorkflowRunExecution ?? true,
    allowTestOnlySkillRunExecution: options.allowTestOnlySkillRunExecution ?? true,
    allowTestOnlySkillVerifyExecution: options.allowTestOnlySkillVerifyExecution ?? true,
    allowTestOnlySkillGeneratorExecution: options.allowTestOnlySkillGeneratorExecution ?? true,
    allowTestOnlyWorkflowGeneratorExecution: options.allowTestOnlyWorkflowGeneratorExecution ?? true,
    allowTestOnlyWorkflowCatalogMutationExecution: options.allowTestOnlyWorkflowCatalogMutationExecution ?? true,
    allowTestOnlyWorkflowBuilderDraftExecution: options.allowTestOnlyWorkflowBuilderDraftExecution ?? true,
    allowTestOnlyWorkflowDeployExecution: options.allowTestOnlyWorkflowDeployExecution ?? true,
    allowTestOnlySessionExecution: options.allowTestOnlySessionExecution ?? true,
    allowTestOnlySessionRunExecution: options.allowTestOnlySessionRunExecution ?? true,
    allowTestOnlySessionMemoryExtractionExecution: options.allowTestOnlySessionMemoryExtractionExecution ?? true,
    allowTestOnlyTsMemoryWrites: options.allowTestOnlyTsMemoryWrites ?? true,
    allowTestOnlyCrossBorderPackExecution: options.allowTestOnlyCrossBorderPackExecution ?? true,
    allowTestOnlyRealtimeExecution: options.allowTestOnlyRealtimeExecution ?? true,
    allowTestOnlySkillConverterExecution: options.allowTestOnlySkillConverterExecution ?? true,
    computeChecksum: (content: string) =>
      crypto.createHash("sha256").update(content).digest("hex"),
    resolveSkill: options.resolveSkill ?? ((_skillId: string) => ({ id: _skillId })),
    invokeSkill: options.invokeSkill ?? (async (_skillId, _runId, _nodeId, payload) =>
      ({ output: payload })),
  });

  const port = await findFreePort();

  const httpServer: FridayHttpServer = createFridayHttpServer({
    routes: apiRuntime.routes,
    wsGateway: apiRuntime.wsGateway,
    middleware: apiRuntime.middleware,
    port,
    host: "127.0.0.1",
  });

  await httpServer.listen();

  const baseUrl = `http://127.0.0.1:${port}`;

  const restoreMasterKey = (): void => {
    if (originalMasterKey === undefined) {
      delete process.env.FRIDAY_MASTER_KEY;
    } else {
      process.env.FRIDAY_MASTER_KEY = originalMasterKey;
    }
    if (originalMasterKeySource === undefined) {
      delete process.env.FRIDAY_MASTER_KEY_SOURCE;
    } else {
      process.env.FRIDAY_MASTER_KEY_SOURCE = originalMasterKeySource;
    }
    resetMasterKeyCache();
  };

  return {
    baseUrl,
    apiRuntime,
    db,
    providerService,
    selfHealingService,
    async close() {
      try {
        await httpServer.close();
        db.close();
      } finally {
        restoreMasterKey();
      }
    },
  };
}

// ─── Auth helpers ──────────────────────────────────────────────────────────

/**
 * Login the default test user and return tokens.
 */
export async function loginTestUser(baseUrl: string): Promise<{
  accessToken: string;
  refreshToken: string;
}> {
  const res = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ localPassphrase: "any" }),
  });
  const json = (await res.json()) as {
    ok: boolean;
    data: { accessToken: string; refreshToken: string };
  };
  if (!json.ok) throw new Error("Login failed in test helper");
  return {
    accessToken: json.data.accessToken,
    refreshToken: json.data.refreshToken,
  };
}

/**
 * Convenience: return headers with Authorization bearer token.
 */
export function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/**
 * Create a token with specific scopes (for testing scope enforcement).
 * Uses the real token encoding from prod.
 */
export function createTokenWithScopes(
  scopes: FridayScope[],
  opts?: { role?: FridayRole; userId?: string },
): string {
  const nowSec = Math.floor(new Date(NOW).getTime() / 1000);
  const claims: FridayAccessTokenClaims = {
    tokenId: `test-token-${crypto.randomUUID()}`,
    principalType: "user",
    principalId: opts?.userId ?? "test-user",
    userId: opts?.userId ?? "test-user",
    role: opts?.role ?? "admin",
    scopes,
    iat: nowSec,
    exp: nowSec + ACCESS_TTL,
  };
  return encodeToken(claims, TOKEN_SECRET);
}

export { TOKEN_SECRET, NOW };
