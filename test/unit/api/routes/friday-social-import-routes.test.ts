import { describe, it, expect, vi } from "vitest";

import {
  createFridaySocialImportRoutes,
  type FridaySocialImportRoutesRegistrationDeps,
} from "../../../../src/api/http/routes/friday-social-import-routes.js";
import type {
  FridaySocialImportService,
  FridaySocialImportStageContext,
} from "../../../../src/skills/social-import/friday-social-import.types.js";
import type {
  FridaySkillConverterService,
  FridaySkillImportOutput,
} from "../../../../src/skills/converter/services/friday-skill-converter-service.types.js";
import type { FridayExternalSkillCandidate } from "../../../../src/skills/converter/services/friday-skill-candidate-store.js";
import {
  createFridayMutatingActionGate,
  signFridayCanonicalApproval,
  type FridayMutatingActionGate,
  type FridayMutatingActionGateResult,
} from "../../../../src/security/friday-mutating-action-gate.js";
import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";

// ─── Helpers ───

const NOW = "2026-05-13T00:00:00.000Z";
const TOKEN_SECRET = "test-secret"; // pragma: allowlist secret

function makeStageContext(overrides: Partial<FridaySocialImportStageContext> = {}): FridaySocialImportStageContext {
  return {
    request: {
      socialUrl: "https://www.xiaohongshu.com/explore/abc",
      targetGithubRepoUrl: "https://github.com/octocat/Hello-World",
    },
    sessionId: "xhs-default",
    source: {
      uri: "https://github.com/octocat/Hello-World",
      formatHint: "code-repo",
    },
    sourceProvenanceDigest: "abcdef0123456789",
    redactedSocialUri: "https://www.xiaohongshu.com/explore/abc",
    redactedTargetUri: "https://github.com/octocat/Hello-World",
    extraction: {
      socialDomain: "xiaohongshu.com",
      fieldsPresent: ["author", "content", "likes"],
      commentCount: 2,
      extractionDurationMs: 12,
    },
    planDigest: "test-plan-digest",
    ...overrides,
  };
}

function makeService(overrides: Partial<FridaySocialImportService> = {}): FridaySocialImportService {
  return {
    prepareStageContext: vi.fn(async () => makeStageContext()),
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<FridayExternalSkillCandidate> = {}): FridayExternalSkillCandidate {
  return {
    candidateId: "Hello-World-1.0.0-abcdef",
    shadowVersionId: "Hello-World-1.0.0-abcdef",
    skillId: "Hello-World",
    version: "1.0.0",
    converterId: "code-repo",
    detectedFormat: "code-repo",
    sourceProvenance: {
      sourceKind: "uri",
      sourceDigest: "deadbeef",
      redactedUri: "https://github.com/octocat/Hello-World",
      formatHint: "code-repo",
    },
    canonicalApprovalProof: {
      gateId: "friday_canonical_mutating_action_gate",
      ticketId: "ticket-1",
      actionDigest: "digest-1",
      action: "skills.import.stage_candidate",
      surface: "api:/v1/skills/social-import",
      resource: {
        type: "external_skill_candidate",
        id: "skill-source:abcdef",
      },
      risk: "high",
      approvalId: "approval-1",
      approvedByPrincipalId: "tenant-a",
      issuedAt: NOW,
    },
    candidateDir: "/tmp/test/skill-candidates/Hello-World-1.0.0-abcdef",
    filesDir: "/tmp/test/skill-candidates/Hello-World-1.0.0-abcdef/files",
    stagedAt: NOW,
    validation: { ok: true, issues: [], verifiedAt: NOW },
    ...overrides,
  };
}

function makeConverter(overrides: Partial<FridaySkillConverterService> = {}): FridaySkillConverterService {
  const importResult: FridaySkillImportOutput = {
    converterId: "code-repo",
    detectedFormat: "code-repo",
    candidates: [makeCandidate()],
    validation: [{ skillId: "Hello-World", ok: true, issues: [] }],
    registryRefreshed: false,
  };
  return {
    listConverters: vi.fn(() => []),
    detect: vi.fn(),
    convert: vi.fn(),
    getCandidate: vi.fn(),
    import: vi.fn(async () => importResult),
    pack: vi.fn(),
    ...overrides,
  };
}

function makeGate(): FridayMutatingActionGate {
  return createFridayMutatingActionGate({
    nowIso: () => NOW,
    ticketIdGenerator: () => "ticket-1",
    approvalSignatureSecret: TOKEN_SECRET,
    requireApprovalSignature: true,
  });
}

function makeDeps(overrides: Partial<FridaySocialImportRoutesRegistrationDeps> = {}): FridaySocialImportRoutesRegistrationDeps {
  return {
    service: makeService(),
    converterService: makeConverter(),
    canonicalMutationGate: makeGate(),
    disabledReason: null,
    ...overrides,
  };
}

function makeDisabledDeps(reason: string): FridaySocialImportRoutesRegistrationDeps {
  return {
    service: null,
    converterService: null,
    canonicalMutationGate: null,
    disabledReason: reason,
  };
}

function makeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req-1",
    receivedAt: NOW,
    params: {},
    query: {},
    body: {
      socialUrl: "https://www.xiaohongshu.com/explore/abc",
      targetGithubRepoUrl: "https://github.com/octocat/Hello-World",
    },
    headers: {},
    principal: { principalType: "user", principalId: "tenant-a" },
    ...overrides,
  };
}

function findRoute(
  routes: ReturnType<typeof createFridaySocialImportRoutes>,
  operationId: string,
) {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route not found: ${operationId}`);
  return route;
}

// ─── Registration contract ───

describe("createFridaySocialImportRoutes — registration", () => {
  it("always registers exactly 1 route (skills.social.import)", () => {
    const enabled = createFridaySocialImportRoutes(makeDeps());
    const disabled = createFridaySocialImportRoutes(makeDisabledDeps("deps absent"));
    expect(enabled).toHaveLength(1);
    expect(disabled).toHaveLength(1);
  });

  it("registers POST /v1/skills/social-import with public auth", () => {
    const routes = createFridaySocialImportRoutes(makeDeps());
    const route = findRoute(routes, "skills.social.import");
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/v1/skills/social-import");
    expect(route.auth).toEqual({ public: true });
  });
});

// ─── Disabled state ───

describe("createFridaySocialImportRoutes — disabled state", () => {
  it("returns 503 SOCIAL_IMPORT_DISABLED when service is absent", async () => {
    const deps = makeDisabledDeps("XHS browser deps not initialised in this runtime");
    const route = findRoute(createFridaySocialImportRoutes(deps), "skills.social.import");
    let thrown: unknown = null;
    try {
      await route.handler(makeCtx() as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FridayDomainError);
    expect((thrown as FridayDomainError).code).toBe("SOCIAL_IMPORT_DISABLED");
    expect((thrown as FridayDomainError).httpStatus).toBe(503);
    expect((thrown as FridayDomainError).message).toContain(
      "XHS browser deps not initialised",
    );
  });

  it("returns 503 SOCIAL_IMPORT_DISABLED when converter or gate is absent", async () => {
    const deps: FridaySocialImportRoutesRegistrationDeps = {
      service: makeService(),
      converterService: null,
      canonicalMutationGate: null,
      disabledReason: null,
    };
    const route = findRoute(createFridaySocialImportRoutes(deps), "skills.social.import");
    await expect(route.handler(makeCtx() as never)).rejects.toMatchObject({
      code: "SOCIAL_IMPORT_DISABLED",
      httpStatus: 503,
    });
  });
});

// ─── Body validation ───

describe("createFridaySocialImportRoutes — body validation", () => {
  it("rejects non-object body with 400 VALIDATION_ERROR", async () => {
    const route = findRoute(createFridaySocialImportRoutes(makeDeps()), "skills.social.import");
    await expect(
      route.handler(makeCtx({ body: "not-an-object" }) as never),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", httpStatus: 400 });
  });

  it("rejects body missing socialUrl with 400", async () => {
    const route = findRoute(createFridaySocialImportRoutes(makeDeps()), "skills.social.import");
    await expect(
      route.handler(
        makeCtx({
          body: { targetGithubRepoUrl: "https://github.com/octocat/Hello-World" },
        }) as never,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects body missing targetGithubRepoUrl with 400", async () => {
    const route = findRoute(createFridaySocialImportRoutes(makeDeps()), "skills.social.import");
    await expect(
      route.handler(
        makeCtx({
          body: { socialUrl: "https://www.xiaohongshu.com/explore/abc" },
        }) as never,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("does not accept userId from body; principal comes from ctx", async () => {
    const service = makeService();
    const route = findRoute(
      createFridaySocialImportRoutes(makeDeps({ service })),
      "skills.social.import",
    );
    try {
      await route.handler(
        makeCtx({
          body: {
            socialUrl: "https://www.xiaohongshu.com/explore/abc",
            targetGithubRepoUrl: "https://github.com/octocat/Hello-World",
            userId: "attacker-impersonating",
          },
        }) as never,
      );
    } catch {
      // Expected — the gate will reject without canonicalApproval; we only
      // care that the service was called with the ctx principal id.
    }
    expect(service.prepareStageContext).toHaveBeenCalledWith(
      expect.objectContaining({
        actorPrincipalId: "tenant-a",
      }),
    );
    // Ensure the body userId was NOT used as the actor id.
    expect(service.prepareStageContext).not.toHaveBeenCalledWith(
      expect.objectContaining({ actorPrincipalId: "attacker-impersonating" }),
    );
  });
});

// ─── Approval-pending branch ───

describe("createFridaySocialImportRoutes — approval-pending branch", () => {
  it("returns 403 CANONICAL_APPROVAL_REQUIRED when canonicalApproval is absent", async () => {
    const deps = makeDeps();
    const route = findRoute(createFridaySocialImportRoutes(deps), "skills.social.import");
    let thrown: unknown = null;
    try {
      await route.handler(makeCtx() as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FridayDomainError);
    expect((thrown as FridayDomainError).code).toBe("CANONICAL_APPROVAL_REQUIRED");
    expect((thrown as FridayDomainError).httpStatus).toBe(403);
    const details = (thrown as FridayDomainError).details as Record<string, unknown>;
    expect(details.planDigest).toBeDefined();
    expect(details.redactedSocialUri).toBeDefined();
    expect(details.redactedTargetUri).toBeDefined();
    expect(details.socialDomain).toBe("xiaohongshu.com");
    expect(details.extraction).toBeDefined();
    expect(deps.converterService?.import).not.toHaveBeenCalled();
  });
});

// ─── Candidate-staged branch ───

describe("createFridaySocialImportRoutes — candidate-staged branch", () => {
  async function stageCandidate(): Promise<{ result: unknown; deps: FridaySocialImportRoutesRegistrationDeps }> {
    const deps = makeDeps();
    const route = findRoute(createFridaySocialImportRoutes(deps), "skills.social.import");
    // First call to extract the actionDigest from the gate-thrown 403.
    let actionDigest = "";
    try {
      await route.handler(makeCtx() as never);
    } catch (err) {
      const details = (err as FridayDomainError).details as { canonicalGate?: { actionDigest?: string } };
      actionDigest = details.canonicalGate?.actionDigest ?? "";
    }
    expect(actionDigest).toBeTruthy();
    const canonicalApproval = signFridayCanonicalApproval(
      {
        decision: "approved",
        approvalId: "approval-1",
        decidedByPrincipalId: "tenant-a",
        actionDigest,
        expiresAt: "2026-05-13T01:00:00.000Z",
      },
      TOKEN_SECRET,
    );
    const result = await route.handler(
      makeCtx({
        body: {
          socialUrl: "https://www.xiaohongshu.com/explore/abc",
          targetGithubRepoUrl: "https://github.com/octocat/Hello-World",
          canonicalApproval,
        },
      }) as never,
    );
    return { result, deps };
  }

  it("stages the candidate and returns the redacted-only response shape", async () => {
    const { result, deps } = await stageCandidate();
    const response = result as Record<string, unknown>;
    expect(response.ok).toBe(true);
    expect(response.candidateId).toBe("Hello-World-1.0.0-abcdef");
    expect(response.skillId).toBe("Hello-World");
    expect(response.socialDomain).toBe("xiaohongshu.com");
    expect(typeof response.redactedSocialUri).toBe("string");
    expect(typeof response.redactedTargetUri).toBe("string");
    expect(typeof response.sourceProvenanceDigest).toBe("string");
    expect(typeof response.planDigest).toBe("string");
    expect(typeof response.ticketId).toBe("string");
    expect(typeof response.stagedAt).toBe("string");
    expect(response.extraction).toBeDefined();
    expect(Array.isArray(response.nextSteps)).toBe(true);
    // The response body must NOT contain raw URLs or a `source` field that
    // would echo the targetGithubRepoUrl.
    expect("source" in response).toBe(false);
    expect("request" in response).toBe(false);
    expect(deps.converterService?.import).toHaveBeenCalledTimes(1);
  });

  it("includes the canonical next-step route sequence", async () => {
    const { result } = await stageCandidate();
    const response = result as { nextSteps: string[] };
    expect(response.nextSteps).toContain(
      "POST /v1/autonomy/skills/:skillId/shadow",
    );
    expect(response.nextSteps).toContain(
      "POST /v1/autonomy/skills/:skillId/canary",
    );
    expect(response.nextSteps).toContain(
      "POST /v1/autonomy/skills/:skillId/promote",
    );
    expect(response.nextSteps).toContain(
      "POST /v1/skills/:skillId/verify",
    );
  });

  it("never echoes raw cookie/session/secret-shaped material or a source/request object", async () => {
    const { result } = await stageCandidate();
    const serialised = JSON.stringify(result);
    // The redacted URIs are intentionally present (and may equal the raw
    // input when there is no credential-shaped query string). What the
    // response MUST NOT echo: a `source` object, a `request` mirror, a
    // `userId` field, cookies, session-string shapes, or query-string
    // credentials.
    expect(serialised).not.toMatch(/"source":/);
    expect(serialised).not.toMatch(/"request":/);
    expect(serialised).not.toMatch(/"userId":/);
    expect(serialised).not.toMatch(/web_session=/);
    expect(serialised).not.toMatch(/a1=/);
    expect(serialised).not.toMatch(/Authorization/i);
    expect(serialised).not.toMatch(/Bearer /);
  });
});

// ─── Denied gate ───

describe("createFridaySocialImportRoutes — denied gate", () => {
  it("returns 403 CANONICAL_APPROVAL_DENIED when gate decision is deny", async () => {
    const denyGate: FridayMutatingActionGate = {
      evaluate: vi.fn(
        (): FridayMutatingActionGateResult => ({
          decision: "deny",
          reason: "policy_blocks_external_skill",
          risk: "high",
          actionDigest: "digest-1",
          approvalRequired: true,
          localClaims: [],
          evidenceRecord: {
            gateId: "friday_canonical_mutating_action_gate",
            evaluatedAt: NOW,
            decision: "deny",
            reason: "policy_blocks_external_skill",
            actionDigest: "digest-1",
            action: "skills.import.stage_candidate",
            actor: { kind: "user", id: "tenant-a", principalId: "tenant-a" },
            surface: "api:/v1/skills/social-import",
            resource: { type: "external_skill_candidate", id: "skill-source:abc" },
            mutating: true,
            risk: "high",
            approvalRequired: true,
            localClaims: [],
          },
        }),
      ),
    } as unknown as FridayMutatingActionGate;
    const deps = makeDeps({ canonicalMutationGate: denyGate });
    const route = findRoute(
      createFridaySocialImportRoutes(deps),
      "skills.social.import",
    );
    await expect(route.handler(makeCtx() as never)).rejects.toMatchObject({
      code: "CANONICAL_APPROVAL_DENIED",
      httpStatus: 403,
    });
  });
});
