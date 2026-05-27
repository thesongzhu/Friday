/**
 * Phase 14 release-proof catch-up for Phase 06 — full live HTTP skill upgrade
 * lifecycle proof.
 *
 * Closes the Phase 06 release-proof debts:
 *   1. Full HTTP proof of the upgrade lifecycle (prior local proof was
 *      route-handler in-process only).
 *   2. Rollback route success — the prior attempt failed with
 *      CANONICAL_APPROVAL_DENIED / canonical_approval_digest_mismatch because
 *      the approval was not constructed against the exact request shape the
 *      route+lifecycle service hashes.
 *
 * The flow exercised against a real TCP HTTP server is:
 *   1. Stage v1 candidate (managed-skills tmp dir, real shell entrypoint).
 *   2. POST /v1/autonomy/skills/:skillId/shadow      (v1)
 *   3. POST /v1/autonomy/skills/:skillId/canary      (v1)
 *   4. POST /v1/autonomy/skills/:skillId/promote     (v1 → installed)
 *   5. POST /v1/workflows + POST .../publish         (workflow refers to skill)
 *   6. Stage v2 candidate.
 *   7. POST /v1/autonomy/skills/:skillId/shadow      (v2; previous = v1 active)
 *   8. POST /v1/skills/:skillId/upgrade/analyze
 *   9. POST /v1/skills/:skillId/upgrade/decide       (replace; canonical approval)
 *      → skill status === "upgrade_available"
 *  10. POST /v1/autonomy/skills/:skillId/canary      (v2)
 *  11. POST /v1/autonomy/skills/:skillId/promote     (v2 → installed, rollbackDir=v1)
 *  12. POST /v1/autonomy/skills/:skillId/rollback    (v2.candidateId)
 *  13. Assert lifecycle evidence file: record.rollback.result === "restored_previous"
 *      and lifecycle restored to installed v1.
 *
 * v2 must traverse autonomy shadow → canary → promote so the on-disk rollback
 * directory holds v1's active artifact when rollback executes. The embedded
 * Codex prompt names this flow as "POST .../decide → POST .../rollback"; the
 * "restored_previous" verification criterion is binding, which requires the
 * shadow → canary → promote intermediates this test runs explicitly.
 *
 * The test does NOT change src/security, src/api/runtime, lifecycle services,
 * route shapes, gate semantics, approval semantics, or release proof policy.
 * Every canonical approval is constructed and signed via the focused helper at
 * `_helpers/friday-skill-upgrade-canonical-approval.helper.ts`, which mirrors
 * the exact request shape each route+service hashes.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as net from "node:net";
import * as crypto from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { createFridayApiRuntime, encodeToken, createFridayHttpServer } from "#api";
import type { FridayApiRuntime, FridayHttpServer } from "#api";
import type { FridaySqliteLayer } from "#state";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";
import { createFridayProviderService } from "#providers";
import {
  createFridayLinkCacheRepository,
  createFridayLinkUnderstandingService,
} from "#link-understanding";
import { createFridayMutatingActionGate } from "../../../src/security/friday-mutating-action-gate.js";
import {
  buildFridayLinkToSkillCandidateSource,
  createFridayLinkToSkillService,
  FridaySkillRegistryImpl,
  createFridaySkillExecutor,
  FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
  createFridaySkillRepository,
  createFridaySkillRunMutatingActionRequest,
} from "#skills";
import type {
  FridaySkillConverterService,
  FridayExternalSkillCandidate,
} from "#skills/converter";
import {
  createFridayLinkEvidenceSkillConverter,
  createFridaySkillConverterRegistry,
  createFridaySkillConverterService,
  createFridaySkillImportInstaller,
  createFridaySkillPackageArchiver,
  createFridaySkillStageMutatingActionRequest,
} from "#skills/converter";
import { createFridaySkillRunStore } from "#ledger";
import type {
  FridayDiscoveredSkillRecord,
  FridayHubConfigManagerService,
  FridayHubMemoryStateService,
  FridaySkillRegistrySettings,
} from "#hub";
import type {
  FridaySkillSecurityProfile,
  SkillLifecycleStatus,
  SkillManifestV2,
} from "#skills";
import type { FridayAccessTokenClaims, FridayScope } from "#api";

import {
  buildSkillLifecycleApprovalRequest,
  buildSkillUpgradeDecideApprovalRequest,
  signCanonicalApproval,
} from "./_helpers/friday-skill-upgrade-canonical-approval.helper.js";

const HMAC_TEST_MATERIAL = "phase14-skill-upgrade-lifecycle-material";
const ACCESS_TTL = 900;
const SKILL_ID = "phase14-skill-upgrade-proof";
const RUNTIME_VERSION = "runtime-phase14";
const PROVIDER_MODEL = "phase14-no-provider";
const PLAN_DIGEST = "phase14-upgrade-plan-digest";
const LINK_TO_SKILL_SOURCE_URL = "https://example.com/friday-link-skill?token=deeplink-proof-token";

// ── Local helpers ─────────────────────────────────────────────────────────

function createTestDb(): FridaySqliteLayer {
  const db = new Database(":memory:");
  runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });
  db.prepare(
    `INSERT OR IGNORE INTO users (id, display_name, role, is_local_only, created_at, updated_at)
     VALUES ('phase14-user', 'Phase 14', 'admin', 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run();
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

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function buildManifest(version: string, overrides: Partial<SkillManifestV2> = {}): SkillManifestV2 {
  return {
    schemaVersion: "2.0",
    id: SKILL_ID,
    name: `Phase 14 Skill v${version}`,
    description: "Phase 14 skill upgrade lifecycle proof skill",
    version,
    kind: "conversation",
    category: "utility",
    author: { name: "phase14" },
    tags: ["phase-14", "release-proof"],
    runtime: {
      kind: "shell",
      entrypoint: "run.sh",
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: 5_000,
    },
    triggers: { intents: [], phrases: [], channels: ["*"] },
    invocation: {
      userInvocable: true,
      modelInvocable: true,
      priority: 50,
      modes: ["intent", "workflow"],
    },
    requirements: { bins: [], env: [], config: [], os: ["darwin", "linux", "win32"] },
    inputs: version === "1.0.0"
      ? [
        { key: "query", type: "string", required: false, label: "Query input" },
      ]
      : [
        { key: "query", type: "string", required: false, label: "Query input" },
        { key: "format", type: "string", required: false, label: "Output format" },
      ],
    outputs: [{ key: "result", type: "string", description: "Run result" }],
    permissions: version === "1.0.0"
      ? { grants: [], promptOn: [] }
      : {
        grants: [
          {
            id: "phase14-network-read",
            resource: "network",
            action: "read",
            required: true,
            reason: "Phase 14 lifecycle proof skill reads remote feed",
          },
        ],
        promptOn: [],
      },
    schemas: { input: null, state: null, output: null },
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: { events: [] },
    ...overrides,
  };
}

function writeSkillFiles(dir: string, manifest: SkillManifestV2): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "skill.manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  writeFileSync(join(dir, "SKILL.md"), `# ${manifest.name}\n`, "utf8");
  writeFileSync(
    join(dir, "skill.ui.json"),
    JSON.stringify({
      schemaVersion: "1.0",
      title: manifest.name,
      sections: [],
      fields: [],
      outputs: [],
      actions: [],
    }, null, 2),
    "utf8",
  );
  const entryPath = join(dir, manifest.runtime.entrypoint);
  writeFileSync(
    entryPath,
    `#!/usr/bin/env bash\necho '{"result":"phase14-${manifest.version}"}'\n`,
    "utf8",
  );
  chmodSync(entryPath, 0o755);
  return dir;
}

function buildCandidate(input: {
  candidateId: string;
  filesDir: string;
  manifest: SkillManifestV2;
  stagedAt: string;
}): FridayExternalSkillCandidate {
  return {
    candidateId: input.candidateId,
    shadowVersionId: input.candidateId,
    skillId: input.manifest.id,
    version: input.manifest.version,
    converterId: "phase14-local-converter",
    detectedFormat: "friday-package",
    sourceProvenance: {
      sourceKind: "uri",
      sourceDigest: input.candidateId,
      redactedUri: `file-uri:${input.candidateId}`,
      formatHint: "friday-package",
    },
    canonicalApprovalProof: {
      gateId: "friday_canonical_mutating_action_gate",
      ticketId: `stage-${input.candidateId}`,
      actionDigest: `stage-digest-${input.candidateId}`,
      action: "skills.import.stage_candidate",
      surface: "test:phase14",
      resource: { type: "external_skill_candidate", id: input.candidateId },
      risk: "high",
      approvalId: `stage-approval-${input.candidateId}`,
      approvedByPrincipalId: "phase14-user",
      issuedAt: input.stagedAt,
      planDigest: PLAN_DIGEST,
    },
    candidateDir: join(input.filesDir, ".."),
    filesDir: input.filesDir,
    stagedAt: input.stagedAt,
    validation: {
      ok: true,
      issues: [],
      verifiedAt: input.stagedAt,
    },
  };
}

function createConverterServiceStub(fallback?: FridaySkillConverterService): FridaySkillConverterService & {
  registerCandidate(candidate: FridayExternalSkillCandidate, sourceUri?: string): void;
} {
  const sourceCandidates = new Map<string, FridayExternalSkillCandidate>();
  const stagedCandidates = new Map<string, FridayExternalSkillCandidate>();
  return {
    registerCandidate(candidate, sourceUri) {
      sourceCandidates.set(`file://${candidate.candidateId}`, candidate);
      if (sourceUri) {
        sourceCandidates.set(sourceUri, candidate);
      }
    },
    listConverters: () => fallback?.listConverters() ?? [],
    detect: async (source) => fallback?.detect(source) ?? null,
    convert: async (input) => {
      if (fallback) return fallback.convert(input);
      throw new Error("convert is not supported in the Phase 14 lifecycle proof test");
    },
    getCandidate: ({ skillId, candidateId }) =>
      stagedCandidates.get(`${skillId}::${candidateId}`)
        ?? fallback?.getCandidate({ skillId, candidateId })
        ?? null,
    import: async (input) => {
      const candidate = input.source.uri ? sourceCandidates.get(input.source.uri) : undefined;
      if (!candidate && fallback) {
        return fallback.import(input);
      }
      if (!candidate) {
        throw new Error("unknown Phase 14 lifecycle proof skill source");
      }
      stagedCandidates.set(`${candidate.skillId}::${candidate.candidateId}`, candidate);
      return {
        converterId: candidate.converterId,
        detectedFormat: candidate.detectedFormat,
        candidates: [candidate],
        validation: [
          {
            skillId: candidate.skillId,
            ok: candidate.validation.ok,
            issues: candidate.validation.issues,
          },
        ],
        registryRefreshed: false,
      };
    },
    pack: async (input) => {
      if (fallback) return fallback.pack(input);
      throw new Error("pack is not supported in the Phase 14 lifecycle proof test");
    },
  };
}

function createLinkEvidenceConverterService(input: {
  db: FridaySqliteLayer;
  workspaceDir: string;
  managedSkillsDir: string;
  nowIso: () => string;
}): FridaySkillConverterService {
  const registry = createFridaySkillConverterRegistry();
  registry.register(createFridayLinkEvidenceSkillConverter());
  return createFridaySkillConverterService({
    registry,
    installer: createFridaySkillImportInstaller(),
    archiver: createFridaySkillPackageArchiver(),
    context: {
      workspaceDir: input.workspaceDir,
      managedSkillsDir: input.managedSkillsDir,
      nowIso: input.nowIso,
    },
    onSkillCandidateStaged: ({ candidate, draft }) => {
      input.db.withWriteTransaction((conn) => {
        createFridaySkillRepository().upsertSkillFromCatalog(conn, {
          id: candidate.skillId,
          name: draft.manifest.name,
          source: "local",
          origin: "managed",
          latestVersion: draft.manifest.version,
          status: "not_installed",
          currentManifest: draft.manifest,
          nowIso: candidate.stagedAt,
        });
      });
    },
  });
}

function createStubConfigManager(input: {
  workspaceDir: string;
  managedSkillsDir: string;
}): FridayHubConfigManagerService {
  const settings: FridaySkillRegistrySettings = {
    workspaceDir: input.workspaceDir,
    bundledSkillsDir: join(input.workspaceDir, "bundled-skills"),
    managedSkillsDir: input.managedSkillsDir,
    extraSkillDirs: [],
    watchEnabled: false,
    watchDebounceMs: 300,
  };
  const securityProfile: FridaySkillSecurityProfile = {};
  return {
    getCurrentConfig: async () => {
      throw new Error("Not implemented in test stub");
    },
    getConfig: async () => ({ revision: 1, settings: {} }),
    validatePatch: async () => ({ valid: true, errors: [] }),
    applyPatch: async () => ({ revision: 1, changedKeys: [] }),
    listRevisions: async () => ({ items: [] }),
    revertToRevision: async () => ({
      revision: 1,
      changedKeys: [],
      revertedFrom: 1,
    }),
    getSkillRegistrySettings: async () => settings,
    getSkillSecurityProfile: async () => securityProfile,
  };
}

function createStubMemoryState(): FridayHubMemoryStateService {
  const statuses: Record<string, SkillLifecycleStatus> = {};
  return {
    listSkillStatuses: async () => statuses,
    upsertDiscoveredSkills: async (records: FridayDiscoveredSkillRecord[]) => {
      for (const r of records) {
        statuses[r.id] = r.status;
      }
    },
    updateSkillStatus: async (skillId: string, status: SkillLifecycleStatus) => {
      statuses[skillId] = status;
    },
    appendAuditLog: async () => {},
    getSession: async () => null,
    appendSessionMessage: async (msg) => ({
      ...msg,
      id: crypto.randomUUID(),
      sequence: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    getMemoryItems: async () => [],
    putMemoryItem: async () => {},
  };
}

function tokenWithScopes(scopes: FridayScope[]): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims: FridayAccessTokenClaims = {
    tokenId: `phase14-token-${crypto.randomUUID()}`,
    principalType: "user",
    principalId: "phase14-user",
    userId: "phase14-user",
    role: "admin",
    scopes,
    iat: nowSec,
    exp: nowSec + ACCESS_TTL,
  };
  return encodeToken(claims, HMAC_TEST_MATERIAL);
}

function actorForTestUser(): {
  kind: string;
  id: string;
  principalId: string;
} {
  return { kind: "user", id: "phase14-user", principalId: "phase14-user" };
}

function expiresIn(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

// ── Test ────────────────────────────────────────────────────────────────

describe("Phase 14 — live HTTP skill upgrade lifecycle proof (Phase 06 debt)", () => {
  let db: FridaySqliteLayer;
  let workspaceDir: string;
  let managedSkillsDir: string;
  let candidateRoot: string;
  let v1Candidate: FridayExternalSkillCandidate;
  let v2Candidate: FridayExternalSkillCandidate;
  let overreachCandidate: FridayExternalSkillCandidate;
  let linkCandidate: FridayExternalSkillCandidate;
  let apiRuntime: FridayApiRuntime;
  let httpServer: FridayHttpServer;
  let baseUrl: string;
  let registry: FridaySkillRegistryImpl;
  let converterService: ReturnType<typeof createConverterServiceStub>;
  const tempDirs: string[] = [];
  let previousNodeSkillsFlag: string | undefined;

  beforeEach(async () => {
    previousNodeSkillsFlag = process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];

    workspaceDir = join(
      tmpdir(),
      `phase14-lifecycle-workspace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    managedSkillsDir = join(workspaceDir, "managed-skills");
    candidateRoot = join(workspaceDir, "skill-candidates");
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(managedSkillsDir, { recursive: true });
    mkdirSync(candidateRoot, { recursive: true });
    tempDirs.push(workspaceDir);

    db = createTestDb();

    const v1Manifest = buildManifest("1.0.0");
    const v2Manifest = buildManifest("2.0.0");
    const overreachManifest = buildManifest("3.0.0", {
      permissions: {
        grants: [
          {
            id: "phase14-filesystem-write-root",
            resource: "filesystem",
            action: "write",
            required: true,
            reason: "Phase 14 negative proof requests broad filesystem write access.",
          },
        ],
        promptOn: [],
      },
    });
    const v1CandidateId = `${SKILL_ID}-v1-${Math.random().toString(36).slice(2, 10)}`;
    const v2CandidateId = `${SKILL_ID}-v2-${Math.random().toString(36).slice(2, 10)}`;
    const overreachCandidateId = `${SKILL_ID}-overreach-${Math.random().toString(36).slice(2, 10)}`;
    const linkCandidateId = `${SKILL_ID}-link-${Math.random().toString(36).slice(2, 10)}`;
    const v1FilesDir = writeSkillFiles(join(candidateRoot, v1CandidateId, "files"), v1Manifest);
    const v2FilesDir = writeSkillFiles(join(candidateRoot, v2CandidateId, "files"), v2Manifest);
    const overreachFilesDir = writeSkillFiles(
      join(candidateRoot, overreachCandidateId, "files"),
      overreachManifest,
    );
    const linkFilesDir = writeSkillFiles(join(candidateRoot, linkCandidateId, "files"), v1Manifest);
    const stagedAt = new Date().toISOString();
    v1Candidate = buildCandidate({
      candidateId: v1CandidateId,
      filesDir: v1FilesDir,
      manifest: v1Manifest,
      stagedAt,
    });
    v2Candidate = buildCandidate({
      candidateId: v2CandidateId,
      filesDir: v2FilesDir,
      manifest: v2Manifest,
      stagedAt,
    });
    overreachCandidate = {
      ...buildCandidate({
        candidateId: overreachCandidateId,
        filesDir: overreachFilesDir,
        manifest: overreachManifest,
        stagedAt,
      }),
      validation: {
        ok: false,
        verifiedAt: stagedAt,
        issues: [
          {
            stage: "trust-policy",
            severity: "error",
            code: "PERMISSION_OVERREACH",
            message: "Broad filesystem write access is refused for staged skill candidates.",
            path: "permissions.grants[0]",
          },
        ],
      },
    };
    linkCandidate = buildCandidate({
      candidateId: linkCandidateId,
      filesDir: linkFilesDir,
      manifest: v1Manifest,
      stagedAt,
    });

    db.withWriteTransaction((conn) => {
      createFridaySkillRepository().upsertSkillFromCatalog(conn, {
        id: SKILL_ID,
        name: v1Manifest.name,
        source: "local",
        origin: "managed",
        latestVersion: v1Manifest.version,
        status: "not_installed",
        currentManifest: v1Manifest,
        nowIso: stagedAt,
      });
    });

    const idCounter = { count: 0 };
    const idGenerator = () => `phase14-${String(++idCounter.count).padStart(6, "0")}`;
    const nowIsoMutable = { value: stagedAt };
    const nowIso = () => {
      const current = new Date(nowIsoMutable.value).getTime();
      nowIsoMutable.value = new Date(current + 100).toISOString();
      return nowIsoMutable.value;
    };

    converterService = createConverterServiceStub(createLinkEvidenceConverterService({
      db,
      workspaceDir,
      managedSkillsDir,
      nowIso,
    }));
    converterService.registerCandidate(v1Candidate);
    converterService.registerCandidate(v2Candidate);
    converterService.registerCandidate(overreachCandidate);
    converterService.registerCandidate(linkCandidate, LINK_TO_SKILL_SOURCE_URL);

    const providerService = createFridayProviderService({
      db,
      idGenerator,
      nowIso,
    });

    const configManager = createStubConfigManager({ workspaceDir, managedSkillsDir });
    const memoryState = createStubMemoryState();
    registry = new FridaySkillRegistryImpl({
      workspaceDir,
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
      configManager,
      memoryStateService: memoryState,
    });
    await registry.refresh();

    const runStore = createFridaySkillRunStore({ db });
    const executorCanonicalGate = createFridayMutatingActionGate({
      nowIso,
      ticketIdGenerator: () => idGenerator(),
      approvalSignatureSecret: HMAC_TEST_MATERIAL,
      requireApprovalSignature: true,
    });
    const skillExecutor = createFridaySkillExecutor({
      db,
      registry,
      runStore,
      idGenerator,
      nowIso,
      canonicalMutationGate: executorCanonicalGate,
    });

    apiRuntime = createFridayApiRuntime({
      db,
      idGenerator,
      nowIso,
      providerService,
      converterService,
      skillRegistry: registry,
      skillExecutor,
      tokenSecret: HMAC_TEST_MATERIAL,
      accessTokenTtlSec: ACCESS_TTL,
      managedSkillsDir,
      stateDir: workspaceDir,
      computeChecksum: (content: string) =>
        crypto.createHash("sha256").update(content).digest("hex"),
      resolveSkill: (skillId: string) => ({ id: skillId }),
      invokeSkill: async (_skillId, _runId, _nodeId, payload) => ({ output: payload }),
      updateSkillStatus: async (skillId, status) => {
        await memoryState.updateSkillStatus(skillId, status);
      },
    });

    const port = await findFreePort();
    httpServer = createFridayHttpServer({
      routes: apiRuntime.routes,
      wsGateway: apiRuntime.wsGateway,
      middleware: apiRuntime.middleware,
      port,
      host: "127.0.0.1",
    });
    await httpServer.listen();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (httpServer) {
      await httpServer.close();
    }
    if (registry) {
      await registry.close();
    }
    if (db) {
      db.close();
    }
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
    if (previousNodeSkillsFlag === undefined) {
      delete process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
    } else {
      process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV] = previousNodeSkillsFlag;
    }
  });

  it(
    "live HTTP: v1 shadow→canary→promote → analyze/decide → v2 shadow→canary→promote → rollback restores v1",
    { timeout: 60_000 },
    async () => {
      const adminToken = tokenWithScopes([
        "hub.admin",
        "skill.read",
        "skill.write",
        "workflow.read",
        "workflow.write",
      ]);
      const auth = { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" };
      const actor = actorForTestUser();

      async function callJson<T = Record<string, unknown>>(
        method: string,
        path: string,
        body?: Record<string, unknown>,
      ): Promise<{ status: number; json: { ok: boolean; data?: T; error?: { code: string; message: string; details?: unknown } } }> {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: auth,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        const parsed = text.length > 0 ? JSON.parse(text) : { ok: res.ok };
        return { status: res.status, json: parsed };
      }

      function signFor(action: "shadow" | "canary" | "promote" | "rollback", candidateId: string, opts?: { canaryInput?: Record<string, unknown> }) {
        const request = buildSkillLifecycleApprovalRequest({
          action,
          skillId: SKILL_ID,
          candidateId,
          runtimeVersion: RUNTIME_VERSION,
          providerModel: PROVIDER_MODEL,
          actor,
          planDigest: action === "shadow" || action === "canary" ? undefined : PLAN_DIGEST,
          canaryInput: opts?.canaryInput,
        });
        return signCanonicalApproval({
          request,
          tokenSecret: HMAC_TEST_MATERIAL,
          approvalId: `phase14-${action}-${candidateId}`,
          decidedByPrincipalId: "phase14-user",
          expiresAt: expiresIn(15),
        });
      }

      function importBodyFor(candidate: FridayExternalSkillCandidate, idempotencyKey: string) {
        return {
          source: { uri: `file://${candidate.candidateId}`, formatHint: "friday-package" as const },
          formatHint: "friday-package" as const,
          target: "managed" as const,
          replace: true,
          refreshRegistry: false,
          idempotencyKey,
          planDigest: PLAN_DIGEST,
        };
      }

      function signImportStage(
        body: ReturnType<typeof importBodyFor>,
        approvalId: string,
      ) {
        const request = createFridaySkillStageMutatingActionRequest({
          source: body.source,
          formatHint: body.formatHint,
          target: body.target,
          replace: body.replace,
          refreshRegistry: body.refreshRegistry,
          actor,
          surface: "api:/v1/skills/import",
          idempotencyKey: body.idempotencyKey,
          planDigest: body.planDigest,
        });
        return signCanonicalApproval({
          request,
          tokenSecret: HMAC_TEST_MATERIAL,
          approvalId,
          decidedByPrincipalId: "phase14-user",
          expiresAt: expiresIn(15),
        });
      }

      function signRun(
        input: Record<string, unknown>,
        sessionId: string,
        approvalId: string,
      ) {
        const request = createFridaySkillRunMutatingActionRequest({
          skillId: SKILL_ID,
          input,
          channel: "api",
          sessionId,
          actor,
          surface: "api:/v1/skills/:skillId/run",
        });
        return signCanonicalApproval({
          request,
          tokenSecret: HMAC_TEST_MATERIAL,
          approvalId,
          decidedByPrincipalId: "phase14-user",
          expiresAt: expiresIn(15),
        });
      }

      async function runSkillAndExpectVersion(
        version: string,
        sessionId: string,
      ): Promise<void> {
        const input = { query: `expect-${version}` };
        const runRes = await callJson(
          "POST",
          `/v1/skills/${encodeURIComponent(SKILL_ID)}/run`,
          {
            input,
            channel: "api",
            sessionId,
            canonicalApproval: signRun(input, sessionId, `phase14-run-${version}-${sessionId}`),
          },
        );
        expect(runRes.status, JSON.stringify(runRes.json)).toBe(200);
        const data = runRes.json.data as Record<string, unknown>;
        expect(data.status).toBe("completed");
        expect(String(data.stdout)).toContain(`phase14-${version}`);
      }

      // 1. Import-stage v1 through the public converter route.
      const importV1Body = importBodyFor(v1Candidate, "phase14-import-v1");
      const importV1Denied = await callJson("POST", "/v1/skills/import", importV1Body);
      expect(importV1Denied.status, JSON.stringify(importV1Denied.json)).toBe(403);
      expect(importV1Denied.json.error?.code).toBe("CANONICAL_APPROVAL_REQUIRED");
      const importV1 = await callJson(
        "POST",
        "/v1/skills/import",
        {
          ...importV1Body,
          canonicalApproval: signImportStage(importV1Body, "phase14-import-v1"),
        },
      );
      expect(importV1.status, JSON.stringify(importV1.json)).toBe(200);
      const importV1Candidates = (importV1.json.data as Record<string, unknown>)
        .candidates as Array<Record<string, unknown>>;
      expect(importV1Candidates[0]?.candidateId).toBe(v1Candidate.candidateId);

      // 2. Permission-overreach candidate stages with validation evidence but
      //    is refused before it can enter the lifecycle.
      const overreachImportBody = importBodyFor(
        overreachCandidate,
        "phase14-import-overreach",
      );
      const importOverreach = await callJson(
        "POST",
        "/v1/skills/import",
        {
          ...overreachImportBody,
          canonicalApproval: signImportStage(
            overreachImportBody,
            "phase14-import-overreach",
          ),
        },
      );
      expect(importOverreach.status, JSON.stringify(importOverreach.json)).toBe(200);
      const overreachValidation = (importOverreach.json.data as Record<string, unknown>)
        .validation as Array<Record<string, unknown>>;
      expect(overreachValidation[0]?.ok).toBe(false);
      const overreachShadow = await callJson(
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(SKILL_ID)}/shadow`,
        {
          candidateId: overreachCandidate.candidateId,
          shadowVersionId: overreachCandidate.candidateId,
          runtimeVersion: RUNTIME_VERSION,
          providerModel: PROVIDER_MODEL,
          canonicalApproval: signFor("shadow", overreachCandidate.candidateId),
        },
      );
      expect(overreachShadow.status, JSON.stringify(overreachShadow.json)).toBe(422);
      expect(overreachShadow.json.error?.code).toBe("SKILL_CANDIDATE_VALIDATION_FAILED");

      // 3. Shadow v1
      const shadowV1Body = {
        candidateId: v1Candidate.candidateId,
        shadowVersionId: v1Candidate.candidateId,
        runtimeVersion: RUNTIME_VERSION,
        providerModel: PROVIDER_MODEL,
        canonicalApproval: signFor("shadow", v1Candidate.candidateId),
      };
      const shadowV1Denied = await callJson(
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(SKILL_ID)}/shadow`,
        { ...shadowV1Body, canonicalApproval: undefined },
      );
      expect(shadowV1Denied.status, JSON.stringify(shadowV1Denied.json)).toBe(403);
      expect(shadowV1Denied.json.error?.code).toBe("CANONICAL_APPROVAL_REQUIRED");
      const shadowV1 = await callJson(
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(SKILL_ID)}/shadow`,
        shadowV1Body,
      );
      expect(shadowV1.status, JSON.stringify(shadowV1.json)).toBe(200);
      expect(shadowV1.json.ok).toBe(true);

      // 4. Canary v1
      const canaryV1Body = {
        candidateId: v1Candidate.candidateId,
        runtimeVersion: RUNTIME_VERSION,
        providerModel: PROVIDER_MODEL,
        canonicalApproval: signFor("canary", v1Candidate.candidateId),
      };
      const canaryV1 = await callJson(
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(SKILL_ID)}/canary`,
        canaryV1Body,
      );
      expect(canaryV1.status, JSON.stringify(canaryV1.json)).toBe(200);

      // 5. Promote v1
      const promoteV1Body = {
        candidateId: v1Candidate.candidateId,
        runtimeVersion: RUNTIME_VERSION,
        providerModel: PROVIDER_MODEL,
        planDigest: PLAN_DIGEST,
        canonicalApproval: signFor("promote", v1Candidate.candidateId),
      };
      const promoteV1Denied = await callJson(
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(SKILL_ID)}/promote`,
        { ...promoteV1Body, canonicalApproval: undefined },
      );
      expect(promoteV1Denied.status, JSON.stringify(promoteV1Denied.json)).toBe(403);
      expect(promoteV1Denied.json.error?.code).toBe("CANONICAL_APPROVAL_REQUIRED");
      const promoteV1 = await callJson(
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(SKILL_ID)}/promote`,
        promoteV1Body,
      );
      expect(promoteV1.status, JSON.stringify(promoteV1.json)).toBe(200);
      expect(existsSync(join(managedSkillsDir, SKILL_ID, "skill.manifest.json"))).toBe(true);

      const runV1Denied = await callJson(
        "POST",
        `/v1/skills/${encodeURIComponent(SKILL_ID)}/run`,
        { input: { query: "unsigned-v1" }, channel: "api", sessionId: "phase14-run-v1-denied" },
      );
      expect(runV1Denied.status, JSON.stringify(runV1Denied.json)).toBe(403);
      expect(runV1Denied.json.error?.code).toBe("SKILL_RUN_APPROVAL_REQUIRED");
      await runSkillAndExpectVersion("1.0.0", "phase14-run-v1");

      // 6. Publish a workflow that references the skill so analyze sees an
      //    affected workflow with the candidate's input mapping.
      const workflowGraphBody = {
        schemaVersion: "2.0",
        workflowId: "placeholder",
        workflowVersionId: "placeholder-v1",
        sourceSpecSchemaVersion: "1.0",
        graph: {
          nodes: [
            { id: "t-1", type: "trigger", label: "Manual", config: { triggerType: "manual" } },
            {
              id: "skill-1",
              type: "ai",
              label: "Phase 14 Skill Step",
              config: {
                prompt: "echo",
                skillId: SKILL_ID,
                inputMapping: { query: "{{trigger.payload.query}}" },
              },
            },
          ],
          edges: [{ id: "e1", sourceNodeId: "t-1", targetNodeId: "skill-1" }],
        },
        failurePolicy: { onFailure: "fail_fast", notifyUser: false },
        tests: [],
      };
      const workflowChecksum = crypto
        .createHash("sha256")
        .update(JSON.stringify(workflowGraphBody))
        .digest("hex");
      const createWorkflow = await callJson("POST", "/v1/workflows", {
        slug: `phase14-upgrade-${Date.now().toString(36)}`,
        name: "Phase 14 upgrade workflow",
        graph: { ...workflowGraphBody, checksum: workflowChecksum },
      });
      expect(createWorkflow.status, JSON.stringify(createWorkflow.json)).toBe(200);
      const workflowId = (createWorkflow.json.data as Record<string, Record<string, unknown>>)
        .workflow.id as string;
      const versionNumber = (createWorkflow.json.data as Record<string, Record<string, unknown>>)
        .version.versionNumber as number ?? 1;
      const publishRes = await callJson(
        "POST",
        `/v1/workflows/${encodeURIComponent(workflowId)}/publish`,
        { versionNumber },
      );
      expect(publishRes.status, JSON.stringify(publishRes.json)).toBe(200);

      // 7. Import-stage and shadow v2 (previous = v1 active)
      const importV2Body = importBodyFor(v2Candidate, "phase14-import-v2");
      const importV2Denied = await callJson("POST", "/v1/skills/import", importV2Body);
      expect(importV2Denied.status, JSON.stringify(importV2Denied.json)).toBe(403);
      expect(importV2Denied.json.error?.code).toBe("CANONICAL_APPROVAL_REQUIRED");
      const importV2 = await callJson(
        "POST",
        "/v1/skills/import",
        {
          ...importV2Body,
          canonicalApproval: signImportStage(importV2Body, "phase14-import-v2"),
        },
      );
      expect(importV2.status, JSON.stringify(importV2.json)).toBe(200);
      const shadowV2Body = {
        candidateId: v2Candidate.candidateId,
        shadowVersionId: v2Candidate.candidateId,
        runtimeVersion: RUNTIME_VERSION,
        providerModel: PROVIDER_MODEL,
        canonicalApproval: signFor("shadow", v2Candidate.candidateId),
      };
      const shadowV2 = await callJson(
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(SKILL_ID)}/shadow`,
        shadowV2Body,
      );
      expect(shadowV2.status, JSON.stringify(shadowV2.json)).toBe(200);

      // 8. Analyze v2
      const analyzeRes = await callJson(
        "POST",
        `/v1/skills/${encodeURIComponent(SKILL_ID)}/upgrade/analyze`,
        { candidateId: v2Candidate.candidateId },
      );
      expect(analyzeRes.status, JSON.stringify(analyzeRes.json)).toBe(200);
      const analysis = (analyzeRes.json.data as Record<string, Record<string, unknown>>)
        .analysis as Record<string, unknown>;
      expect(analysis.isDuplicate).toBe(true);
      expect(analysis.existingVersion).toBe("1.0.0");
      expect(analysis.candidateVersion).toBe("2.0.0");
      expect(analysis.recommendation).toBe("replace");
      expect(typeof analysis.analysisDigest).toBe("string");
      const regression = analysis.regressionProof as { overallVerdict: string };
      expect(["pass", "fail", "no_affected_workflows"]).toContain(regression.overallVerdict);

      // 9. Decide(replace) v2
      const decideRequest = buildSkillUpgradeDecideApprovalRequest({
        skillId: SKILL_ID,
        candidateId: v2Candidate.candidateId,
        decision: "replace",
        analysisDigest: String(analysis.analysisDigest),
        recommendation: analysis.recommendation as "replace" | "keep" | "review_required",
        regressionVerdict: regression.overallVerdict as "pass" | "fail" | "no_affected_workflows",
        actor,
      });
      const decideApproval = signCanonicalApproval({
        request: decideRequest,
        tokenSecret: HMAC_TEST_MATERIAL,
        approvalId: `phase14-decide-${v2Candidate.candidateId}`,
        decidedByPrincipalId: "phase14-user",
        expiresAt: expiresIn(15),
      });
      const decideRes = await callJson(
        "POST",
        `/v1/skills/${encodeURIComponent(SKILL_ID)}/upgrade/decide`,
        {
          candidateId: v2Candidate.candidateId,
          decision: "replace",
          canonicalApproval: decideApproval,
        },
      );
      expect(decideRes.status, JSON.stringify(decideRes.json)).toBe(200);

      // Verify status === "upgrade_available"
      const skillRow = db.withReadConnection((conn) =>
        createFridaySkillRepository().getSkillById(conn, SKILL_ID),
      );
      expect(skillRow?.status).toBe("upgrade_available");

      // 10. Canary v2
      const canaryV2 = await callJson(
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(SKILL_ID)}/canary`,
        {
          candidateId: v2Candidate.candidateId,
          runtimeVersion: RUNTIME_VERSION,
          providerModel: PROVIDER_MODEL,
          canonicalApproval: signFor("canary", v2Candidate.candidateId),
        },
      );
      expect(canaryV2.status, JSON.stringify(canaryV2.json)).toBe(200);

      // 11. Promote v2 -> active=v2, rollbackDir=v1 backup
      const promoteV2 = await callJson(
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(SKILL_ID)}/promote`,
        {
          candidateId: v2Candidate.candidateId,
          runtimeVersion: RUNTIME_VERSION,
          providerModel: PROVIDER_MODEL,
          planDigest: PLAN_DIGEST,
          canonicalApproval: signFor("promote", v2Candidate.candidateId),
        },
      );
      expect(promoteV2.status, JSON.stringify(promoteV2.json)).toBe(200);
      const installedRowAfterV2 = db.withReadConnection((conn) =>
        createFridaySkillRepository().getSkillById(conn, SKILL_ID),
      );
      expect(installedRowAfterV2?.installedVersion).toBe("2.0.0");
      expect(installedRowAfterV2?.status).toBe("installed");
      await runSkillAndExpectVersion("2.0.0", "phase14-run-v2");

      // 12. Rollback v2 -> restore v1
      const rollbackDenied = await callJson(
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(SKILL_ID)}/rollback`,
        {
          candidateId: v2Candidate.candidateId,
          runtimeVersion: RUNTIME_VERSION,
          providerModel: PROVIDER_MODEL,
          planDigest: PLAN_DIGEST,
        },
      );
      expect(rollbackDenied.status, JSON.stringify(rollbackDenied.json)).toBe(403);
      expect(rollbackDenied.json.error?.code).toBe("CANONICAL_APPROVAL_REQUIRED");
      const rollbackRes = await callJson(
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(SKILL_ID)}/rollback`,
        {
          candidateId: v2Candidate.candidateId,
          runtimeVersion: RUNTIME_VERSION,
          providerModel: PROVIDER_MODEL,
          planDigest: PLAN_DIGEST,
          canonicalApproval: signFor("rollback", v2Candidate.candidateId),
        },
      );
      expect(rollbackRes.status, JSON.stringify(rollbackRes.json)).toBe(200);
      const rollbackEvidence = (rollbackRes.json.data as Record<string, Record<string, unknown>>)
        .evidence as Record<string, unknown>;
      expect(rollbackEvidence.stage).toBe("rolled_back");

      // 13. Read raw lifecycle evidence to assert result === "restored_previous"
      const evidencePath = join(
        managedSkillsDir,
        ".lifecycle",
        SKILL_ID,
        `${v2Candidate.candidateId}.json`,
      );
      expect(existsSync(evidencePath)).toBe(true);
      const evidenceRecord = JSON.parse(readFileSync(evidencePath, "utf8")) as {
        rollback?: { result?: string };
      };
      expect(evidenceRecord.rollback?.result).toBe("restored_previous");

      // 14. Confirm lifecycle restored to installed v1
      const restoredRow = db.withReadConnection((conn) =>
        createFridaySkillRepository().getSkillById(conn, SKILL_ID),
      );
      expect(restoredRow?.installedVersion).toBe("1.0.0");
      expect(restoredRow?.currentManifest?.version).toBe("1.0.0");
      await runSkillAndExpectVersion("1.0.0", "phase14-run-v1-restored");
    },
  );

  it(
    "live HTTP: skill-source deeplink preview/apply stages a candidate that must pass lifecycle promotion before run",
    { timeout: 60_000 },
    async () => {
      const adminToken = tokenWithScopes([
        "hub.admin",
        "skill.read",
        "skill.write",
      ]);
      const auth = { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" };
      const actor = actorForTestUser();

      async function callJson<T = Record<string, unknown>>(
        method: string,
        path: string,
        body?: Record<string, unknown>,
      ): Promise<{ status: number; json: { ok: boolean; data?: T; error?: { code: string; message: string; details?: unknown } } }> {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: auth,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        const parsed = text.length > 0 ? JSON.parse(text) : { ok: res.ok };
        return { status: res.status, json: parsed };
      }

      function signFor(action: "shadow" | "canary" | "promote", candidateId: string) {
        const request = buildSkillLifecycleApprovalRequest({
          action,
          skillId: SKILL_ID,
          candidateId,
          runtimeVersion: RUNTIME_VERSION,
          providerModel: PROVIDER_MODEL,
          actor,
          planDigest: action === "shadow" || action === "canary" ? undefined : PLAN_DIGEST,
        });
        return signCanonicalApproval({
          request,
          tokenSecret: HMAC_TEST_MATERIAL,
          approvalId: `phase14-link-${action}-${candidateId}`,
          decidedByPrincipalId: "phase14-user",
          expiresAt: expiresIn(15),
        });
      }

      function signDeepLinkStage(approvalId: string) {
        const request = createFridaySkillStageMutatingActionRequest({
          source: { uri: LINK_TO_SKILL_SOURCE_URL },
          formatHint: "auto",
          actor,
          surface: "api:/v1/deeplink/apply",
          idempotencyKey: "phase14-link-to-skill-apply",
          planDigest: PLAN_DIGEST,
        });
        return signCanonicalApproval({
          request,
          tokenSecret: HMAC_TEST_MATERIAL,
          approvalId,
          decidedByPrincipalId: "phase14-user",
          expiresAt: expiresIn(15),
        });
      }

      function signRun(input: Record<string, unknown>, sessionId: string) {
        const request = createFridaySkillRunMutatingActionRequest({
          skillId: SKILL_ID,
          input,
          channel: "api",
          sessionId,
          actor,
          surface: "api:/v1/skills/:skillId/run",
        });
        return signCanonicalApproval({
          request,
          tokenSecret: HMAC_TEST_MATERIAL,
          approvalId: `phase14-link-run-${sessionId}`,
          decidedByPrincipalId: "phase14-user",
          expiresAt: expiresIn(15),
        });
      }

      const payload = {
        version: 1,
        type: "skill-source",
        label: "Phase 14 link-to-skill proof",
        skillSource: { url: LINK_TO_SKILL_SOURCE_URL },
      };

      const preview = await callJson<{
        preview: {
          verdict: string;
          payload: { skillSource?: { url?: string } };
          permissionSummary: string[];
        };
      }>("POST", "/v1/deeplink/preview", { payload });
      expect(preview.status, JSON.stringify(preview.json)).toBe(200);
      expect(preview.json.data?.preview.verdict).toBe("ready");
      expect(preview.json.data?.preview.payload.skillSource?.url).toBe(
        "https://example.com/friday-link-skill?redacted=1",
      );
      expect(preview.json.data?.preview.permissionSummary).toContain(
        "Will stage an external skill candidate for review.",
      );

      const privatePayload = {
        version: 1,
        type: "skill-source",
        label: "Blocked private link-to-skill proof",
        skillSource: { url: "http://localhost:3000/private-skill?token=private-proof-token" },
      };
      const privatePreview = await callJson<{
        preview: { verdict: string; checks: Array<{ id: string; level: string }> };
      }>("POST", "/v1/deeplink/preview", { payload: privatePayload });
      expect(privatePreview.status, JSON.stringify(privatePreview.json)).toBe(200);
      expect(privatePreview.json.data?.preview.verdict).toBe("blocked");
      expect(privatePreview.json.data?.preview.checks.some((check) =>
        check.id === "skill-url-private" && check.level === "blocking"
      )).toBe(true);

      const privateApply = await callJson("POST", "/v1/deeplink/apply", {
        payload: privatePayload,
        confirmed: true,
      });
      expect(privateApply.status, JSON.stringify(privateApply.json)).toBe(422);
      expect(privateApply.json.error?.code).toBe("VALIDATION_FAILED");

      const unconfirmedApply = await callJson("POST", "/v1/deeplink/apply", {
        payload,
        confirmed: false,
      });
      expect(unconfirmedApply.status, JSON.stringify(unconfirmedApply.json)).toBe(400);
      expect(unconfirmedApply.json.error?.code).toBe("VALIDATION_FAILED");

      const unsignedApply = await callJson("POST", "/v1/deeplink/apply", {
        payload,
        confirmed: true,
        idempotencyKey: "phase14-link-to-skill-apply",
        planDigest: PLAN_DIGEST,
      });
      expect(unsignedApply.status, JSON.stringify(unsignedApply.json)).toBe(403);
      expect(unsignedApply.json.error?.code).toBe("CANONICAL_APPROVAL_REQUIRED");

      const signedApply = await callJson<{
        result: { applied: boolean; resourceType: string; resourceId?: string; message: string };
      }>("POST", "/v1/deeplink/apply", {
        payload,
        confirmed: true,
        idempotencyKey: "phase14-link-to-skill-apply",
        planDigest: PLAN_DIGEST,
        canonicalApproval: signDeepLinkStage("phase14-link-to-skill-stage"),
      });
      expect(signedApply.status, JSON.stringify(signedApply.json)).toBe(200);
      expect(signedApply.json.data?.result.applied).toBe(true);
      expect(signedApply.json.data?.result.resourceType).toBe("skill-source");
      expect(signedApply.json.data?.result.resourceId).toBe(linkCandidate.candidateId);
      expect(signedApply.json.data?.result.message).toContain("staged");

      const runBeforeLifecycle = await callJson("POST", `/v1/skills/${encodeURIComponent(SKILL_ID)}/run`, {
        input: { query: "before-lifecycle" },
        channel: "api",
        sessionId: "phase14-link-run-before-lifecycle",
      });
      expect(runBeforeLifecycle.status).not.toBe(200);

      const shadow = await callJson(
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(SKILL_ID)}/shadow`,
        {
          candidateId: linkCandidate.candidateId,
          shadowVersionId: linkCandidate.candidateId,
          runtimeVersion: RUNTIME_VERSION,
          providerModel: PROVIDER_MODEL,
          canonicalApproval: signFor("shadow", linkCandidate.candidateId),
        },
      );
      expect(shadow.status, JSON.stringify(shadow.json)).toBe(200);

      const canary = await callJson(
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(SKILL_ID)}/canary`,
        {
          candidateId: linkCandidate.candidateId,
          runtimeVersion: RUNTIME_VERSION,
          providerModel: PROVIDER_MODEL,
          canonicalApproval: signFor("canary", linkCandidate.candidateId),
        },
      );
      expect(canary.status, JSON.stringify(canary.json)).toBe(200);

      const promote = await callJson(
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(SKILL_ID)}/promote`,
        {
          candidateId: linkCandidate.candidateId,
          runtimeVersion: RUNTIME_VERSION,
          providerModel: PROVIDER_MODEL,
          planDigest: PLAN_DIGEST,
          canonicalApproval: signFor("promote", linkCandidate.candidateId),
        },
      );
      expect(promote.status, JSON.stringify(promote.json)).toBe(200);

      const input = { query: "after-link-promotion" };
      const runAfterLifecycle = await callJson<{ status: string; stdout: string }>(
        "POST",
        `/v1/skills/${encodeURIComponent(SKILL_ID)}/run`,
        {
          input,
          channel: "api",
          sessionId: "phase14-link-run-after-lifecycle",
          canonicalApproval: signRun(input, "phase14-link-run-after-lifecycle"),
        },
      );
      expect(runAfterLifecycle.status, JSON.stringify(runAfterLifecycle.json)).toBe(200);
      expect(runAfterLifecycle.json.data?.status).toBe("completed");
      expect(runAfterLifecycle.json.data?.stdout).toContain("phase14-1.0.0");
    },
  );

  it(
    "live HTTP: extracted link evidence candidate promotes, runs after restart, and rollback cleans the active artifact",
    { timeout: 60_000 },
    async () => {
      const adminToken = tokenWithScopes([
        "hub.admin",
        "skill.read",
        "skill.write",
      ]);
      const auth = { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" };
      const actor = actorForTestUser();
      const linkSkillId = `phase14-link-evidence-${Math.random().toString(36).slice(2, 8)}`;
      const linkUrl = "https://example.com/friday-link-evidence-skill?token=restart-cleanup-secret";
      const stageSurface = "api:/v1/link-to-skill/stage";
      const stageIdempotencyKey = "phase14-link-evidence-stage";
      let fetchCount = 0;

      async function callJson<T = Record<string, unknown>>(
        method: string,
        path: string,
        body?: Record<string, unknown>,
      ): Promise<{ status: number; json: { ok: boolean; data?: T; error?: { code: string; message: string; details?: unknown } } }> {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: auth,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        const parsed = text.length > 0 ? JSON.parse(text) : { ok: res.ok };
        return { status: res.status, json: parsed };
      }

      function signStage(source: ReturnType<typeof buildFridayLinkToSkillCandidateSource>["source"]) {
        const request = createFridaySkillStageMutatingActionRequest({
          source,
          formatHint: "auto",
          actor,
          surface: stageSurface,
          idempotencyKey: stageIdempotencyKey,
          planDigest: PLAN_DIGEST,
        });
        return signCanonicalApproval({
          request,
          tokenSecret: HMAC_TEST_MATERIAL,
          approvalId: "phase14-link-evidence-stage",
          decidedByPrincipalId: "phase14-user",
          expiresAt: expiresIn(15),
        });
      }

      function signFor(action: "shadow" | "canary" | "promote" | "rollback", candidateId: string) {
        const request = buildSkillLifecycleApprovalRequest({
          action,
          skillId: linkSkillId,
          candidateId,
          runtimeVersion: RUNTIME_VERSION,
          providerModel: PROVIDER_MODEL,
          actor,
          planDigest: action === "shadow" || action === "canary" ? undefined : PLAN_DIGEST,
        });
        return signCanonicalApproval({
          request,
          tokenSecret: HMAC_TEST_MATERIAL,
          approvalId: `phase14-link-evidence-${action}-${candidateId}`,
          decidedByPrincipalId: "phase14-user",
          expiresAt: expiresIn(15),
        });
      }

      function signRun(input: Record<string, unknown>, sessionId: string) {
        const request = createFridaySkillRunMutatingActionRequest({
          skillId: linkSkillId,
          input,
          channel: "api",
          sessionId,
          actor,
          surface: "api:/v1/skills/:skillId/run",
        });
        return signCanonicalApproval({
          request,
          tokenSecret: HMAC_TEST_MATERIAL,
          approvalId: `phase14-link-evidence-run-${sessionId}`,
          decidedByPrincipalId: "phase14-user",
          expiresAt: expiresIn(15),
        });
      }

      async function restartHttpRuntime(): Promise<void> {
        await httpServer.close();
        await registry.close();

        const idCounter = { count: 0 };
        const idGenerator = () => `phase14-restart-${String(++idCounter.count).padStart(6, "0")}`;
        const nowIsoMutable = { value: new Date().toISOString() };
        const nowIso = () => {
          const current = new Date(nowIsoMutable.value).getTime();
          nowIsoMutable.value = new Date(current + 100).toISOString();
          return nowIsoMutable.value;
        };
        const providerService = createFridayProviderService({
          db,
          idGenerator,
          nowIso,
        });
        const configManager = createStubConfigManager({ workspaceDir, managedSkillsDir });
        const memoryState = createStubMemoryState();
        registry = new FridaySkillRegistryImpl({
          workspaceDir,
          hubVersion: "1.0.0",
          supportedApiVersions: ["1"],
          configManager,
          memoryStateService: memoryState,
        });
        const persistedLinkSkill = db.withReadConnection((conn) =>
          createFridaySkillRepository().getSkillById(conn, linkSkillId),
        );
        if (persistedLinkSkill?.status) {
          await memoryState.updateSkillStatus(linkSkillId, persistedLinkSkill.status);
        }
        await registry.refresh();

        converterService = createConverterServiceStub(createLinkEvidenceConverterService({
          db,
          workspaceDir,
          managedSkillsDir,
          nowIso,
        }));
        const runStore = createFridaySkillRunStore({ db });
        const executorCanonicalGate = createFridayMutatingActionGate({
          nowIso,
          ticketIdGenerator: () => idGenerator(),
          approvalSignatureSecret: HMAC_TEST_MATERIAL,
          requireApprovalSignature: true,
        });
        const skillExecutor = createFridaySkillExecutor({
          db,
          registry,
          runStore,
          idGenerator,
          nowIso,
          canonicalMutationGate: executorCanonicalGate,
        });
        apiRuntime = createFridayApiRuntime({
          db,
          idGenerator,
          nowIso,
          providerService,
          converterService,
          skillRegistry: registry,
          skillExecutor,
          tokenSecret: HMAC_TEST_MATERIAL,
          accessTokenTtlSec: ACCESS_TTL,
          managedSkillsDir,
          stateDir: workspaceDir,
          computeChecksum: (content: string) =>
            crypto.createHash("sha256").update(content).digest("hex"),
          resolveSkill: (skillId: string) => ({ id: skillId }),
          invokeSkill: async (_skillId, _runId, _nodeId, payload) => ({ output: payload }),
          updateSkillStatus: async (skillId, status) => {
            await memoryState.updateSkillStatus(skillId, status);
          },
        });
        const port = await findFreePort();
        httpServer = createFridayHttpServer({
          routes: apiRuntime.routes,
          wsGateway: apiRuntime.wsGateway,
          middleware: apiRuntime.middleware,
          port,
          host: "127.0.0.1",
        });
        await httpServer.listen();
        baseUrl = `http://127.0.0.1:${port}`;
      }

      const linkUnderstanding = createFridayLinkUnderstandingService({
        fetchFn: async () => {
          fetchCount += 1;
          return {
            statusCode: 200,
            contentType: "text/html",
            body: `
              <html>
                <head><title>Restart Link Evidence Skill</title></head>
                <body>
                  <main>
                    <h1>Restart Link Evidence Skill</h1>
                    <p>Build a Friday skill that summarizes restart-safe link evidence for the workspace.</p>
                    <p>The deterministic proof phrase is LINK_SKILL_RESTART_READY and the skill must not fetch the source URL when it runs.</p>
                    <p>This article text is intentionally long enough for stable extraction by the link-understanding pipeline.</p>
                  </main>
                </body>
              </html>
            `,
          };
        },
        cache: createFridayLinkCacheRepository(() => new Date().toISOString()),
        nowIso: () => new Date().toISOString(),
      });
      const evidence = (await linkUnderstanding.processText(`Turn this into a skill: ${linkUrl}`))[0]!;
      expect(evidence.summary).toContain("LINK_SKILL_RESTART_READY");
      const built = buildFridayLinkToSkillCandidateSource({
        evidence,
        skillId: linkSkillId,
        skillName: "Restart Link Evidence Skill",
      });
      expect(JSON.stringify(built.payload)).not.toContain("restart-cleanup-secret");
      expect(built.payload.redactedUrl).toBe(
        "https://example.com/friday-link-evidence-skill?redacted=1",
      );

      const linkToSkill = createFridayLinkToSkillService({
        linkUnderstanding,
        converterService,
        canonicalMutationGate: createFridayMutatingActionGate({
          nowIso: () => new Date().toISOString(),
          ticketIdGenerator: () => "phase14-link-evidence-ticket",
          approvalSignatureSecret: HMAC_TEST_MATERIAL,
          requireApprovalSignature: true,
        }),
      });
      const staged = await linkToSkill.stageFromText({
        text: `Turn this into a skill: ${linkUrl}`,
        actor,
        surface: stageSurface,
        idempotencyKey: stageIdempotencyKey,
        planDigest: PLAN_DIGEST,
        canonicalApproval: signStage(built.source),
        skillId: linkSkillId,
        skillName: "Restart Link Evidence Skill",
      });
      expect(staged.importResult.converterId).toBe("link-evidence-skill");
      const candidate = staged.importResult.candidates[0]!;
      expect(candidate.skillId).toBe(linkSkillId);
      expect(candidate.validation.ok).toBe(true);
      expect(candidate.sourceProvenance.sourceKind).toBe("contentBase64");
      expect(readFileSync(join(candidate.filesDir, "run.sh"), "utf8")).not.toContain(
        "restart-cleanup-secret",
      );

      const runBeforeLifecycle = await callJson("POST", `/v1/skills/${encodeURIComponent(linkSkillId)}/run`, {
        input: { query: "before-lifecycle" },
        channel: "api",
        sessionId: "phase14-link-evidence-before-lifecycle",
      });
      expect(runBeforeLifecycle.status).not.toBe(200);

      for (const action of ["shadow", "canary", "promote"] as const) {
        const res = await callJson(
          "POST",
          `/v1/autonomy/skills/${encodeURIComponent(linkSkillId)}/${action}`,
          {
            candidateId: candidate.candidateId,
            ...(action === "shadow" ? { shadowVersionId: candidate.candidateId } : {}),
            runtimeVersion: RUNTIME_VERSION,
            providerModel: PROVIDER_MODEL,
            ...(action === "promote" ? { planDigest: PLAN_DIGEST } : {}),
            canonicalApproval: signFor(action, candidate.candidateId),
          },
        );
        expect(res.status, JSON.stringify(res.json)).toBe(200);
      }

      await restartHttpRuntime();

      const runInput = { query: "after-restart" };
      const runAfterRestart = await callJson<{ status: string; stdout: string }>(
        "POST",
        `/v1/skills/${encodeURIComponent(linkSkillId)}/run`,
        {
          input: runInput,
          channel: "api",
          sessionId: "phase14-link-evidence-after-restart",
          canonicalApproval: signRun(runInput, "phase14-link-evidence-after-restart"),
        },
      );
      expect(runAfterRestart.status, JSON.stringify(runAfterRestart.json)).toBe(200);
      expect(runAfterRestart.json.data?.status).toBe("completed");
      expect(runAfterRestart.json.data?.stdout).toContain("link_evidence_ready");
      expect(runAfterRestart.json.data?.stdout).toContain("LINK_SKILL_RESTART_READY");
      expect(runAfterRestart.json.data?.stdout).toContain(
        "https://example.com/friday-link-evidence-skill?redacted=1",
      );
      expect(runAfterRestart.json.data?.stdout).not.toContain("restart-cleanup-secret");
      expect(fetchCount).toBeGreaterThanOrEqual(1);

      const rollbackDenied = await callJson(
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(linkSkillId)}/rollback`,
        {
          candidateId: candidate.candidateId,
          runtimeVersion: RUNTIME_VERSION,
          providerModel: PROVIDER_MODEL,
          planDigest: PLAN_DIGEST,
        },
      );
      expect(rollbackDenied.status, JSON.stringify(rollbackDenied.json)).toBe(403);
      expect(rollbackDenied.json.error?.code).toBe("CANONICAL_APPROVAL_REQUIRED");
      const rollback = await callJson(
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(linkSkillId)}/rollback`,
        {
          candidateId: candidate.candidateId,
          runtimeVersion: RUNTIME_VERSION,
          providerModel: PROVIDER_MODEL,
          planDigest: PLAN_DIGEST,
          canonicalApproval: signFor("rollback", candidate.candidateId),
        },
      );
      expect(rollback.status, JSON.stringify(rollback.json)).toBe(200);
      const activeDir = join(managedSkillsDir, linkSkillId);
      expect(existsSync(activeDir)).toBe(false);
      const lifecycleEvidencePath = join(
        managedSkillsDir,
        ".lifecycle",
        linkSkillId,
        `${candidate.candidateId}.json`,
      );
      const lifecycleEvidence = JSON.parse(readFileSync(lifecycleEvidencePath, "utf8")) as {
        rollback?: { result?: string };
      };
      expect(lifecycleEvidence.rollback?.result).toBe("cleared_active");
      const rowAfterRollback = db.withReadConnection((conn) =>
        createFridaySkillRepository().getSkillById(conn, linkSkillId),
      );
      expect(rowAfterRollback?.status).toBe("not_installed");

      const runAfterRollback = await callJson("POST", `/v1/skills/${encodeURIComponent(linkSkillId)}/run`, {
        input: { query: "after-rollback" },
        channel: "api",
        sessionId: "phase14-link-evidence-after-rollback",
        canonicalApproval: signRun({ query: "after-rollback" }, "phase14-link-evidence-after-rollback"),
      });
      expect(runAfterRollback.status).not.toBe(200);
    },
  );
});
