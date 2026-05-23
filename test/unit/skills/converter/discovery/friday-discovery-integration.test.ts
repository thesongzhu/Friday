import { describe, it, expect, vi } from "vitest";

import {
  createFridayDiscoveryIntegrationConverter,
  type FridayDiscoveryIntegrationPayload,
} from "../../../../../src/skills/converter/converters/friday-discovery-integration-converter.js";
import { buildDiscoveryIntegrationSource } from "../../../../../src/skills/converter/discovery/friday-discovery-integration-bridge.js";
import {
  createFridayDiscoveryIntegrationRoutes,
  type FridayDiscoveryIntegrationRoutesDeps,
} from "../../../../../src/api/http/routes/friday-discovery-integration-routes.js";
import {
  createFridayMutatingActionGate,
  signFridayCanonicalApproval,
  type FridayMutatingActionGate,
} from "../../../../../src/security/friday-mutating-action-gate.js";
import {
  createFridaySkillStageMutatingActionRequest,
} from "../../../../../src/skills/converter/services/friday-skill-staging-approval.js";
import type { FridayDiscoveredProgram, FridayIntegrationRecommendation, FridayProgramCatalog, FridayRecommendationResult } from "../../../../../src/skills/converter/discovery/friday-program-discovery.types.js";
import type { FridayExternalSkillCandidate } from "../../../../../src/skills/converter/services/friday-skill-candidate-store.js";
import type { FridaySkillConverterService, FridaySkillImportOutput } from "../../../../../src/skills/converter/services/friday-skill-converter-service.types.js";

const NOW = "2026-05-14T00:00:00.000Z";
const TOKEN_SECRET = "test-secret"; // pragma: allowlist secret
const PAYLOAD_SCHEMA = "friday.discovery.integration.candidate-source.v1";

function makeProgram(overrides: Partial<FridayDiscoveredProgram> = {}): FridayDiscoveredProgram {
  return {
    id: "com.example.testapp",
    name: "TestApp",
    version: "2.1.0",
    executablePath: "/usr/local/bin/testapp",
    category: "development",
    platform: "darwin",
    isCli: true,
    metadata: {},
    discoveredAt: NOW,
    ...overrides,
  };
}

function makeRecommendation(overrides: Partial<FridayIntegrationRecommendation> = {}): FridayIntegrationRecommendation {
  return {
    programId: "com.example.testapp",
    programName: "TestApp",
    integrationPath: "code-repo",
    confidence: 0.85,
    rationale: "CLI development tool with code repo",
    context: {},
    ...overrides,
  };
}

function makePayload(overrides: Partial<FridayDiscoveryIntegrationPayload> = {}): FridayDiscoveryIntegrationPayload {
  return {
    $schema: PAYLOAD_SCHEMA,
    programId: "com.example.testapp",
    programName: "TestApp",
    programCategory: "development",
    integrationPath: "code-repo",
    skillId: "discovery-com.example.testapp",
    skillName: "TestApp Integration",
    skillDescription: "Discovered integration for TestApp via code-repo path.",
    skillVersion: "1.0.0",
    skillKind: "conversation",
    runtimeKind: "shell",
    runtimeEntrypoint: "run.sh",
    tags: ["discovery", "integration-path:code-repo", "category:development"],
    recommendationConfidence: 0.85,
    recommendationRationale: "CLI development tool with code repo",
    ...overrides,
  };
}

function encodePayload(payload: FridayDiscoveryIntegrationPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function makeCandidate(overrides: Partial<FridayExternalSkillCandidate> = {}): FridayExternalSkillCandidate {
  return {
    candidateId: "discovery-testapp-1.0.0-abc123",
    shadowVersionId: "discovery-testapp-1.0.0-abc123",
    skillId: "discovery-com.example.testapp",
    version: "1.0.0",
    converterId: "discovery-integration",
    detectedFormat: "friday-package",
    sourceProvenance: {
      sourceKind: "contentBase64",
      sourceDigest: "deadbeef",
      formatHint: "friday-package",
    },
    canonicalApprovalProof: {
      gateId: "friday_canonical_mutating_action_gate",
      ticketId: "ticket-1",
      actionDigest: "digest-1",
      action: "skills.import.stage_candidate",
      surface: "api:/v1/discovery/integrate",
      resource: { type: "external_skill_candidate", id: "skill-source:abc123" },
      risk: "high",
      approvalId: "approval-1",
      approvedByPrincipalId: "user-1",
      issuedAt: NOW,
    },
    candidateDir: "/tmp/candidates/test",
    filesDir: "/tmp/candidates/test/files",
    stagedAt: NOW,
    validation: { ok: true, issues: [], verifiedAt: NOW },
    ...overrides,
  };
}

describe("FridayDiscoveryIntegrationConverter", () => {
  const converter = createFridayDiscoveryIntegrationConverter();
  const ctx = { workspaceDir: "/tmp", managedSkillsDir: "/tmp/skills", nowIso: () => NOW };

  describe("detect", () => {
    it("detects a valid discovery integration contentBase64 payload", async () => {
      const payload = makePayload();
      const detection = await converter.detect({ contentBase64: encodePayload(payload) });
      expect(detection).not.toBeNull();
      expect(detection!.format).toBe("friday-package");
      expect(detection!.converterId).toBe("discovery-integration");
      expect(detection!.confidence).toBe(1.0);
    });

    it("returns null for a uri-only source", async () => {
      const detection = await converter.detect({ uri: "/some/path" });
      expect(detection).toBeNull();
    });

    it("returns null for contentBase64 with wrong schema", async () => {
      const bad = { ...makePayload(), $schema: "some.other.schema" };
      const detection = await converter.detect({ contentBase64: encodePayload(bad as never) });
      expect(detection).toBeNull();
    });

    it("returns null for invalid base64", async () => {
      const detection = await converter.detect({ contentBase64: "not-valid-base64!!!" });
      expect(detection).toBeNull();
    });

    it("returns null for contentBase64 with missing required fields", async () => {
      const bad = { $schema: PAYLOAD_SCHEMA };
      const encoded = Buffer.from(JSON.stringify(bad)).toString("base64");
      const detection = await converter.detect({ contentBase64: encoded });
      expect(detection).toBeNull();
    });

    it("returns null for contentBase64 with incomplete required fields", async () => {
      const bad = { ...makePayload(), runtimeEntrypoint: "", tags: ["discovery", ""] };
      const detection = await converter.detect({ contentBase64: encodePayload(bad as never) });
      expect(detection).toBeNull();
    });

    it("rejects direct payloads with path-like program or skill identifiers", async () => {
      const badProgramId = makePayload({ programId: "/Users/jarvis/Applications/TestApp.app" });
      const badSkillId = makePayload({ skillId: "discovery-/Users/jarvis/Applications/TestApp.app" });
      const badShellId = makePayload({ programId: "testapp'; rm -rf / #" });

      await expect(converter.detect({ contentBase64: encodePayload(badProgramId) }))
        .resolves.toBeNull();
      await expect(converter.detect({ contentBase64: encodePayload(badSkillId) }))
        .resolves.toBeNull();
      await expect(converter.detect({ contentBase64: encodePayload(badShellId) }))
        .resolves.toBeNull();
      await expect(converter.convert({ contentBase64: encodePayload(badProgramId) }, ctx))
        .rejects.toThrow();
    });

    it("rejects direct payloads with raw path-like integration paths", async () => {
      const bad = makePayload({ integrationPath: "/Users/jarvis/secret/integration" as never });

      await expect(converter.detect({ contentBase64: encodePayload(bad) }))
        .resolves.toBeNull();
      await expect(converter.convert({ contentBase64: encodePayload(bad) }, ctx))
        .rejects.toThrow();
    });
  });

  describe("convert", () => {
    it("builds a valid SkillManifestV2 draft from a valid payload", async () => {
      const payload = makePayload();
      const result = await converter.convert({ contentBase64: encodePayload(payload) }, ctx);

      expect(result.converterId).toBe("discovery-integration");
      expect(result.detectedFormat).toBe("friday-package");
      expect(result.drafts).toHaveLength(1);

      const draft = result.drafts[0]!;
      expect(draft.manifest.schemaVersion).toBe("2.0");
      expect(draft.manifest.id).toBe("discovery-com.example.testapp");
      expect(draft.manifest.name).toBe("TestApp Integration");
      expect(draft.manifest.kind).toBe("conversation");
      expect(draft.manifest.runtime.kind).toBe("shell");
      expect(draft.manifest.runtime.entrypoint).toBe("run.sh");
      expect(draft.manifest.runtime.apiVersion).toBe("1");
      expect(draft.manifest.executionTargets).toBeDefined();
      expect(draft.manifest.permissions).toBeDefined();
      expect(draft.manifest.triggers.intents).toContain("discovery.com.example.testapp");
    });

    it("includes all required manifest fields", async () => {
      const payload = makePayload();
      const result = await converter.convert({ contentBase64: encodePayload(payload) }, ctx);
      const m = result.drafts[0]!.manifest;

      const requiredFields = [
        "schemaVersion", "id", "name", "description", "version", "kind",
        "category", "author", "tags", "runtime", "triggers", "invocation",
        "requirements", "inputs", "outputs", "permissions", "executionTargets",
      ];
      for (const field of requiredFields) {
        expect(m).toHaveProperty(field);
      }
    });

    it("produces files including skill.manifest.json and entrypoint", async () => {
      const payload = makePayload();
      const result = await converter.convert({ contentBase64: encodePayload(payload) }, ctx);
      const draft = result.drafts[0]!;

      const filePaths = draft.files.map((f) => f.path);
      expect(filePaths).toContain("skill.manifest.json");
      expect(filePaths).toContain("skill.ui.json");
      expect(filePaths).toContain("run.sh");
      expect(filePaths).toContain("conversion.report.json");

      const entrypoint = draft.files.find((f) => f.path === "run.sh")!;
      expect(entrypoint.executable).toBe(true);
      expect(entrypoint.content).toContain("printf '%s\\n'");
      expect(entrypoint.content).not.toContain("echo '{");
    });

    it("throws on missing contentBase64", async () => {
      await expect(converter.convert({ uri: "/path" }, ctx)).rejects.toThrow();
    });
  });
});

describe("buildDiscoveryIntegrationSource", () => {
  it("builds a valid contentBase64 source from program and recommendation", () => {
    const program = makeProgram();
    const recommendation = makeRecommendation();
    const result = buildDiscoveryIntegrationSource({ program, recommendation });

    expect(result.source.contentBase64).toBeDefined();
    expect(result.source.formatHint).toBe("friday-package");
    expect(result.redactedProgramName).toBe("TestApp");

    const decoded = JSON.parse(
      Buffer.from(result.source.contentBase64!, "base64").toString("utf8"),
    );
    expect(decoded.$schema).toBe(PAYLOAD_SCHEMA);
    expect(decoded.programId).toBe("com.example.testapp");
    expect(decoded.skillId).toBe("discovery-com.example.testapp");
  });

  it("does not include raw executable paths or path-like program ids in the payload", () => {
    const program = makeProgram({
      id: "/Users/jarvis/Applications/TestApp.app",
      executablePath: "/Users/jarvis/secret/path/bin",
    });
    const recommendation = makeRecommendation();
    const result = buildDiscoveryIntegrationSource({ program, recommendation });

    const decoded = JSON.parse(
      Buffer.from(result.source.contentBase64!, "base64").toString("utf8"),
    );
    const serialized = JSON.stringify(decoded);
    expect(serialized).not.toContain("/Users/jarvis");
    expect(serialized).not.toContain("secret/path");
    expect(decoded.programId).toMatch(/^local-[a-f0-9]{16}$/);
    expect(decoded.skillId).toMatch(/^discovery-local-[a-f0-9]{16}$/);
  });

  it("round-trips through the converter detect", async () => {
    const converter = createFridayDiscoveryIntegrationConverter();
    const result = buildDiscoveryIntegrationSource({
      program: makeProgram(),
      recommendation: makeRecommendation(),
    });
    const detection = await converter.detect(result.source);
    expect(detection).not.toBeNull();
    expect(detection!.format).toBe("friday-package");
  });
});

describe("createFridayDiscoveryIntegrationRoutes", () => {
  function makeGate(): FridayMutatingActionGate {
    return createFridayMutatingActionGate({
      nowIso: () => NOW,
      ticketIdGenerator: () => "ticket-1",
      approvalSignatureSecret: TOKEN_SECRET,
      requireApprovalSignature: true,
    });
  }

  function makeCatalog(programs: FridayDiscoveredProgram[] = [makeProgram()]): FridayProgramCatalog {
    return {
      id: "cat-1",
      platform: "darwin",
      programs,
      generatedAt: NOW,
      scanDurationMs: 100,
      scanErrors: 0,
    };
  }

  function makeDiscoveryService(
    catalog: FridayProgramCatalog | null = makeCatalog(),
    recommendations: readonly FridayIntegrationRecommendation[] = [makeRecommendation()],
  ) {
    return {
      discover: vi.fn(async () => catalog ?? makeCatalog()),
      getCachedCatalog: vi.fn(() => catalog),
      recommend: vi.fn(async (): Promise<FridayRecommendationResult> => ({
        recommendations,
        unmatched: 0,
        generatedAt: NOW,
      })),
      getPolicy: vi.fn(() => ({ enabled: true, scheduledRefreshEnabled: false, refreshIntervalMs: 86400000, excludedPaths: [], excludedProgramIds: [], redactSensitiveDetails: false })),
      setPolicy: vi.fn(),
      isEnabled: vi.fn(() => true),
    };
  }

  function makeConverterService(): FridaySkillConverterService {
    const candidate = makeCandidate();
    return {
      listConverters: vi.fn(() => []),
      detect: vi.fn(async () => null),
      convert: vi.fn(async () => ({ converterId: "test", detectedFormat: "friday-package" as const, drafts: [], validation: [] })),
      getCandidate: vi.fn(() => null),
      import: vi.fn(async (): Promise<FridaySkillImportOutput> => ({
        converterId: "discovery-integration",
        detectedFormat: "friday-package",
        candidates: [candidate],
        validation: [{ skillId: candidate.skillId, ok: true, issues: [] }],
        registryRefreshed: false,
      })),
      pack: vi.fn(async () => ({ packageFile: "test.tgz", checksumSha256: "abc" })),
    };
  }

  function makeCtx(body: unknown = {}) {
    return {
      params: {},
      query: {},
      body,
      headers: {},
      principal: { principalId: "user-1", principalType: "api" as const },
      requestId: "req-1",
      receivedAt: NOW,
    } as never;
  }

  it("returns 503 when discovery deps are null", async () => {
    const routes = createFridayDiscoveryIntegrationRoutes({
      discovery: null,
      converterService: null,
      canonicalMutationGate: null,
      disabledReason: "test disabled",
    });
    const route = routes.find((r) => r.path === "/v1/discovery/integrate")!;
    await expect(route.handler(makeCtx({ programId: "test" }))).rejects.toThrow(
      expect.objectContaining({ code: "DISCOVERY_INTEGRATION_DISABLED" }),
    );
  });

  it("returns 400 when programId is missing", async () => {
    const deps: FridayDiscoveryIntegrationRoutesDeps = {
      discovery: makeDiscoveryService(),
      converterService: makeConverterService(),
      canonicalMutationGate: makeGate(),
      disabledReason: null,
    };
    const routes = createFridayDiscoveryIntegrationRoutes(deps);
    const route = routes.find((r) => r.path === "/v1/discovery/integrate")!;
    await expect(route.handler(makeCtx({}))).rejects.toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
  });

  it("returns 404 when no catalog is available", async () => {
    const deps: FridayDiscoveryIntegrationRoutesDeps = {
      discovery: makeDiscoveryService(null),
      converterService: makeConverterService(),
      canonicalMutationGate: makeGate(),
      disabledReason: null,
    };
    const routes = createFridayDiscoveryIntegrationRoutes(deps);
    const route = routes.find((r) => r.path === "/v1/discovery/integrate")!;
    await expect(route.handler(makeCtx({ programId: "com.example.testapp" }))).rejects.toThrow(
      expect.objectContaining({ code: "CATALOG_NOT_AVAILABLE" }),
    );
  });

  it("returns 404 when program not found in catalog", async () => {
    const deps: FridayDiscoveryIntegrationRoutesDeps = {
      discovery: makeDiscoveryService(),
      converterService: makeConverterService(),
      canonicalMutationGate: makeGate(),
      disabledReason: null,
    };
    const routes = createFridayDiscoveryIntegrationRoutes(deps);
    const route = routes.find((r) => r.path === "/v1/discovery/integrate")!;
    await expect(route.handler(makeCtx({ programId: "com.example.nonexistent" }))).rejects.toThrow(
      expect.objectContaining({ code: "PROGRAM_NOT_FOUND" }),
    );
  });

  it("returns 403 when canonical approval is missing", async () => {
    const deps: FridayDiscoveryIntegrationRoutesDeps = {
      discovery: makeDiscoveryService(),
      converterService: makeConverterService(),
      canonicalMutationGate: makeGate(),
      disabledReason: null,
    };
    const routes = createFridayDiscoveryIntegrationRoutes(deps);
    const route = routes.find((r) => r.path === "/v1/discovery/integrate")!;
    await expect(route.handler(makeCtx({ programId: "com.example.testapp" }))).rejects.toThrow(
      expect.objectContaining({ code: "CANONICAL_APPROVAL_REQUIRED" }),
    );
  });

  it("redacts path-like program ids from canonical approval error details", async () => {
    const program = makeProgram({
      id: "/Users/jarvis/Applications/TestApp.app",
      executablePath: "/Users/jarvis/secret/bin/app",
    });
    const recommendation = makeRecommendation({ programId: program.id });
    const deps: FridayDiscoveryIntegrationRoutesDeps = {
      discovery: makeDiscoveryService(makeCatalog([program]), [recommendation]),
      converterService: makeConverterService(),
      canonicalMutationGate: makeGate(),
      disabledReason: null,
    };
    const routes = createFridayDiscoveryIntegrationRoutes(deps);
    const route = routes.find((r) => r.path === "/v1/discovery/integrate")!;

    let thrown: unknown;
    try {
      await route.handler(makeCtx({ programId: program.id }));
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toMatchObject({
      code: "CANONICAL_APPROVAL_REQUIRED",
      details: expect.objectContaining({
        programId: expect.stringMatching(/^local-[a-f0-9]{16}$/),
      }),
    });
    const details = (thrown as { details?: unknown }).details;
    expect(JSON.stringify(details)).not.toContain("/Users/jarvis");
    expect(JSON.stringify(details)).not.toContain("secret/bin");
  });

  it("stages a candidate successfully with valid approval", async () => {
    const gate = makeGate();
    const converterService = makeConverterService();
    const discoveryService = makeDiscoveryService();

    const deps: FridayDiscoveryIntegrationRoutesDeps = {
      discovery: discoveryService,
      converterService,
      canonicalMutationGate: gate,
      disabledReason: null,
    };
    const routes = createFridayDiscoveryIntegrationRoutes(deps);
    const route = routes.find((r) => r.path === "/v1/discovery/integrate")!;

    const program = makeProgram();
    const recommendation = makeRecommendation({ programId: program.id });
    const bridgeResult = buildDiscoveryIntegrationSource({ program, recommendation });

    const stageRequest = createFridaySkillStageMutatingActionRequest({
      source: bridgeResult.source,
      formatHint: "friday-package",
      actor: { kind: "api", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/discovery/integrate",
      canonicalApproval: undefined,
    });
    const preEval = gate.evaluate(stageRequest);
    const approval = signFridayCanonicalApproval(
      {
        actionDigest: preEval.actionDigest,
        decision: "approved",
        decidedByPrincipalId: "user-1",
        approvalId: "approval-1",
        expiresAt: "2026-05-15T00:00:00.000Z",
      },
      TOKEN_SECRET,
    );

    const result = await route.handler(makeCtx({
      programId: "com.example.testapp",
      canonicalApproval: approval,
    })) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.candidateId).toBe("discovery-testapp-1.0.0-abc123");
    expect(result.skillId).toBe("discovery-com.example.testapp");
    expect(result.integrationPath).toBe("code-repo");
    expect(result.nextSteps).toBeDefined();
    expect(Array.isArray(result.nextSteps)).toBe(true);

    expect(converterService.import).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ contentBase64: expect.any(String) }),
        formatHint: "friday-package",
        canonicalApprovalTicket: expect.objectContaining({ ticketId: "ticket-1" }),
      }),
    );
  });

  it("does not leak raw executable paths or path-like program ids in the response", async () => {
    const gate = makeGate();
    const converterService = makeConverterService();
    const program = makeProgram({
      id: "/Users/jarvis/Applications/TestApp.app",
      executablePath: "/Users/jarvis/secret/bin/app",
    });
    const recommendation = makeRecommendation({ programId: program.id });

    const catalog = {
      id: "cat-1",
      platform: "darwin" as const,
      programs: [program],
      generatedAt: NOW,
      scanDurationMs: 100,
      scanErrors: 0,
    };
    const discoveryService = makeDiscoveryService(catalog, [recommendation]);

    const deps: FridayDiscoveryIntegrationRoutesDeps = {
      discovery: discoveryService,
      converterService,
      canonicalMutationGate: gate,
      disabledReason: null,
    };
    const routes = createFridayDiscoveryIntegrationRoutes(deps);
    const route = routes.find((r) => r.path === "/v1/discovery/integrate")!;

    const bridgeResult = buildDiscoveryIntegrationSource({ program, recommendation });
    const stageRequest = createFridaySkillStageMutatingActionRequest({
      source: bridgeResult.source,
      formatHint: "friday-package",
      actor: { kind: "api", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/discovery/integrate",
    });
    const preEval = gate.evaluate(stageRequest);
    const approval = signFridayCanonicalApproval(
      {
        actionDigest: preEval.actionDigest,
        decision: "approved",
        decidedByPrincipalId: "user-1",
        approvalId: "approval-1",
        expiresAt: "2026-05-15T00:00:00.000Z",
      },
      TOKEN_SECRET,
    );

    const result = await route.handler(makeCtx({
      programId: "/Users/jarvis/Applications/TestApp.app",
      canonicalApproval: approval,
    }));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/Users/jarvis");
    expect(serialized).not.toContain("secret/bin");
    expect(serialized).toContain("local-");
  });

  it("does not auto-install or promote - returns nextSteps pointing to lifecycle routes", async () => {
    const gate = makeGate();
    const converterService = makeConverterService();
    const discoveryService = makeDiscoveryService();

    const deps: FridayDiscoveryIntegrationRoutesDeps = {
      discovery: discoveryService,
      converterService,
      canonicalMutationGate: gate,
      disabledReason: null,
    };
    const routes = createFridayDiscoveryIntegrationRoutes(deps);
    const route = routes.find((r) => r.path === "/v1/discovery/integrate")!;

    const bridgeResult = buildDiscoveryIntegrationSource({
      program: makeProgram(),
      recommendation: makeRecommendation(),
    });
    const stageRequest = createFridaySkillStageMutatingActionRequest({
      source: bridgeResult.source,
      formatHint: "friday-package",
      actor: { kind: "api", id: "user-1", principalId: "user-1" },
      surface: "api:/v1/discovery/integrate",
    });
    const preEval = gate.evaluate(stageRequest);
    const approval = signFridayCanonicalApproval(
      {
        actionDigest: preEval.actionDigest,
        decision: "approved",
        decidedByPrincipalId: "user-1",
        approvalId: "approval-1",
        expiresAt: "2026-05-15T00:00:00.000Z",
      },
      TOKEN_SECRET,
    );

    const result = await route.handler(makeCtx({
      programId: "com.example.testapp",
      canonicalApproval: approval,
    })) as Record<string, unknown>;

    const nextSteps = result.nextSteps as Array<{ action: string; path: string }>;
    const actions = nextSteps.map((s) => s.action);
    expect(actions).toContain("shadow");
    expect(actions).toContain("promote");
    expect(actions).toContain("rollback");
    expect(actions).not.toContain("delete");

    const paths = nextSteps.map((s) => s.path);
    expect(paths.some((p) => p.includes("/v1/autonomy/skills/"))).toBe(true);
  });
});
