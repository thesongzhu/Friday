import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { createFridaySkillConverterRoutes } from "#api";
import { FridayDomainError } from "#errors";
import type { FridaySkillConverterService } from "#hub";
import type { FridayHttpContext } from "#api";
import {
  createFridaySkillStageMutatingActionRequest,
} from "#skills/converter";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  signFridayCanonicalApproval,
} from "../../../../../src/security/friday-mutating-action-gate.js";
import type { FridayApiImportRequest } from "../../../../../src/api/model/friday-api-skill-converter.types.js";

const NOW = "2026-02-17T10:00:00.000Z";
const PACK_OUTPUT_DIR = "/tmp/friday-contained-pack-output";
const PRINCIPAL = {
  principalType: "user" as const,
  principalId: "user-1",
  scopes: ["skill.write" as const],
  tokenId: "token-1",
  tokenKind: "access" as const,
  issuedAt: NOW,
};
const DESKTOP_RECORDING_BASE64_FIXTURE = Buffer.from(JSON.stringify({
  id: "rec-1",
  name: "Test",
  platform: "darwin",
  state: "stopped",
  steps: [
    {
      id: "s1",
      recordingId: "rec-1",
      stepIndex: 0,
      action: { type: "click" },
      parameterBindings: {},
      timestamp: "2026-01-01T00:00:00Z",
    },
  ],
  parameters: {},
  tags: [],
  stepCount: 1,
  createdBy: "test",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}), "utf8").toString("base64");

function makeCtx(
  overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {},
): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-1",
    receivedAt: NOW,
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: null,
    ...overrides,
  };
}

function makeMockConverterService(): FridaySkillConverterService {
  return {
    listConverters: vi.fn(() => [
      { id: "native-friday-package", displayName: "Native Friday Package", sourceFormats: ["friday-package" as const] },
      { id: "clawdbot-skill-md", displayName: "Clawdbot SKILL.md", sourceFormats: ["clawdbot-skill-md" as const] },
    ]),
    detect: vi.fn(async () => ({
      converterId: "clawdbot-skill-md",
      format: "clawdbot-skill-md" as const,
      confidence: 0.9,
      reasons: ["Detected SKILL.md frontmatter"],
    })),
    convert: vi.fn(async () => ({
      converterId: "clawdbot-skill-md",
      detectedFormat: "clawdbot-skill-md" as const,
      drafts: [],
      validation: [],
    })),
    getCandidate: vi.fn(() => null),
    import: vi.fn(async () => ({
      converterId: "clawdbot-skill-md",
      detectedFormat: "clawdbot-skill-md" as const,
      candidates: [
        {
          candidateId: "test-skill-1.0.0-candidate",
          shadowVersionId: "test-skill-1.0.0-candidate",
          skillId: "test-skill",
          version: "1.0.0",
          converterId: "clawdbot-skill-md",
          detectedFormat: "clawdbot-skill-md" as const,
          sourceProvenance: {
            sourceKind: "uri",
            sourceDigest: "source-digest-1",
            redactedUri: "local-path:source-digest-1",
          },
          candidateDir: "/tmp/candidates/test-skill",
          filesDir: "/tmp/candidates/test-skill/files",
          stagedAt: NOW,
          validation: {
            ok: true,
            issues: [],
            verifiedAt: NOW,
          },
        },
      ],
      validation: [{ skillId: "test-skill", ok: true, issues: [] }],
      registryRefreshed: false,
    })),
    pack: vi.fn(async () => ({
      packageFile: "/tmp/test-skill-1.0.0.friday.tgz",
      checksumSha256: "abc123def456",
    })),
  };
}

describe("FridaySkillConverterRoutes", () => {
  function createRoutes() {
    const converterService = makeMockConverterService();
    const canonicalMutationGate = createFridayMutatingActionGate({
      nowIso: () => NOW,
      ticketIdGenerator: () => "ticket-1",
    });
    const routes = createFridaySkillConverterRoutes({ converterService, canonicalMutationGate, packOutputDir: PACK_OUTPUT_DIR, allowTestOnlySkillConverterExecution: true });
    return { routes, converterService };
  }

  function createRoutesWithSignedGate(secret: string) {
    const converterService = makeMockConverterService();
    const canonicalMutationGate = createFridayMutatingActionGate({
      nowIso: () => NOW,
      ticketIdGenerator: () => "signed-ticket-1",
      approvalSignatureSecret: secret,
    });
    const routes = createFridaySkillConverterRoutes({ converterService, canonicalMutationGate, packOutputDir: PACK_OUTPUT_DIR, allowTestOnlySkillConverterExecution: true });
    return { routes, converterService };
  }

  function withCanonicalApproval(body: FridayApiImportRequest): FridayApiImportRequest {
    const request = createFridaySkillStageMutatingActionRequest({
      source: body.source,
      formatHint: body.formatHint,
      target: body.target,
      replace: body.replace,
      refreshRegistry: body.refreshRegistry,
      options: body.options,
      actor: {
        kind: PRINCIPAL.principalType,
        id: PRINCIPAL.principalId,
        principalId: PRINCIPAL.principalId,
      },
      surface: "api:/v1/skills/import",
      idempotencyKey: body.idempotencyKey,
      planDigest: body.planDigest,
    });
    return {
      ...body,
      canonicalApproval: {
        decision: "approved",
        approvalId: "approval-1",
        decidedByPrincipalId: PRINCIPAL.principalId,
        actionDigest: createFridayMutatingActionDigest(request),
        expiresAt: "2026-02-17T11:00:00.000Z",
      },
    };
  }

  function withSignedCanonicalApproval(body: FridayApiImportRequest, secret: string): FridayApiImportRequest {
    const request = createFridaySkillStageMutatingActionRequest({
      source: body.source,
      formatHint: body.formatHint,
      target: body.target,
      replace: body.replace,
      refreshRegistry: body.refreshRegistry,
      options: body.options,
      actor: {
        kind: PRINCIPAL.principalType,
        id: PRINCIPAL.principalId,
        principalId: PRINCIPAL.principalId,
      },
      surface: "api:/v1/skills/import",
      idempotencyKey: body.idempotencyKey,
      planDigest: body.planDigest,
    });
    return {
      ...body,
      canonicalApproval: signFridayCanonicalApproval({
        decision: "approved",
        approvalId: "approval-signed-1",
        decidedByPrincipalId: PRINCIPAL.principalId,
        actionDigest: createFridayMutatingActionDigest(request),
        expiresAt: "2026-02-17T11:00:00.000Z",
      }, secret),
    };
  }

  it("creates 4 route definitions", () => {
    const { routes } = createRoutes();
    expect(routes).toHaveLength(4);
  });

  it("creates routes with correct operation IDs", () => {
    const { routes } = createRoutes();
    const opIds = routes.map((r) => r.operationId);
    expect(opIds).toContain("skills.converters.list");
    expect(opIds).toContain("skills.convert");
    expect(opIds).toContain("skills.import");
    expect(opIds).toContain("skills.pack");
  });

  it("creates routes with correct HTTP methods", () => {
    const { routes } = createRoutes();
    const find = (opId: string) => routes.find((r) => r.operationId === opId);

    expect(find("skills.converters.list")!.method).toBe("GET");
    expect(find("skills.convert")!.method).toBe("POST");
    expect(find("skills.import")!.method).toBe("POST");
    expect(find("skills.pack")!.method).toBe("POST");
  });

  it("creates routes with correct paths", () => {
    const { routes } = createRoutes();
    const find = (opId: string) => routes.find((r) => r.operationId === opId);

    expect(find("skills.converters.list")!.path).toBe("/v1/skills/converters");
    expect(find("skills.convert")!.path).toBe("/v1/skills/convert");
    expect(find("skills.import")!.path).toBe("/v1/skills/import");
    expect(find("skills.pack")!.path).toBe("/v1/skills/pack");
  });

  it("creates routes with correct auth scopes", () => {
    const { routes } = createRoutes();
    const find = (opId: string) => routes.find((r) => r.operationId === opId);

    const listRoute = find("skills.converters.list")!;
    expect(listRoute.auth).toEqual({ public: true });

    const convertRoute = find("skills.convert")!;
    expect(convertRoute.auth).toEqual({ public: true });

    const importRoute = find("skills.import")!;
    expect(importRoute.auth).toEqual({ public: true });

    const packRoute = find("skills.pack")!;
    expect(packRoute.auth).toEqual({ public: true });
  });

  describe("TS-runtime retirement (default/live fail-close)", () => {
    // Build routes WITHOUT the test-oracle flag = production/live wiring.
    function createRetiredRoutes() {
      const converterService = makeMockConverterService();
      const canonicalMutationGate = createFridayMutatingActionGate({
        nowIso: () => NOW,
        ticketIdGenerator: () => "ticket-1",
      });
      const routes = createFridaySkillConverterRoutes({ converterService, canonicalMutationGate, packOutputDir: PACK_OUTPUT_DIR });
      return { routes, converterService };
    }

    it("fail-closes convert with 503 TS_RUNTIME_SKILL_CONVERTER_RETIRED and does not call the service", async () => {
      const { routes, converterService } = createRetiredRoutes();
      const route = routes.find((r) => r.operationId === "skills.convert")!;
      await expect(
        route.handler(makeCtx({ body: { source: { uri: "/path/to/skill" }, formatHint: "auto", dryRun: true } })),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_SKILL_CONVERTER_RETIRED", httpStatus: 503 });
      expect(converterService.convert).not.toHaveBeenCalled();
    });

    it("still validates the convert body (400) BEFORE the retirement guard", async () => {
      const { routes } = createRetiredRoutes();
      const route = routes.find((r) => r.operationId === "skills.convert")!;
      await expect(route.handler(makeCtx({ body: {} }))).rejects.toThrow("source is required");
    });

    it("fail-closes import with 503 after a VALID canonical approval, without staging", async () => {
      const { routes, converterService } = createRetiredRoutes();
      const route = routes.find((r) => r.operationId === "skills.import")!;
      const body = withCanonicalApproval({
        source: { uri: "/path/to/skill.md" },
        target: "managed",
        replace: true,
        refreshRegistry: true,
        idempotencyKey: "stage-managed-1",
      });
      await expect(
        route.handler(makeCtx({ principal: PRINCIPAL, body })),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_SKILL_CONVERTER_RETIRED", httpStatus: 503 });
      expect(converterService.import).not.toHaveBeenCalled();
    });

    it("still enforces the canonical approval gate (403) BEFORE the retirement guard", async () => {
      const { routes, converterService } = createRetiredRoutes();
      const route = routes.find((r) => r.operationId === "skills.import")!;
      // No canonicalApproval on the body -> approval gate rejects before the 503.
      await expect(
        route.handler(makeCtx({ principal: PRINCIPAL, body: { source: { uri: "/path/to/skill.md" }, target: "managed" } })),
      ).rejects.toMatchObject({ httpStatus: 403 });
      expect(converterService.import).not.toHaveBeenCalled();
    });

    it("fail-closes pack with 503 and does not write a package", async () => {
      const { routes, converterService } = createRetiredRoutes();
      const route = routes.find((r) => r.operationId === "skills.pack")!;
      await expect(
        route.handler(makeCtx({ body: { skillDir: "/skills/test-skill" } })),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_SKILL_CONVERTER_RETIRED", httpStatus: 503 });
      expect(converterService.pack).not.toHaveBeenCalled();
    });

    it("still rejects path-escape pack output (400) BEFORE the retirement guard", async () => {
      const { routes, converterService } = createRetiredRoutes();
      const route = routes.find((r) => r.operationId === "skills.pack")!;
      await expect(
        route.handler(makeCtx({ body: { skillDir: "/path/to/skill", outputFile: "/tmp/skill.friday.tgz" } })),
      ).rejects.toThrow("outputFile must be a contained filename");
      expect(converterService.pack).not.toHaveBeenCalled();
    });

    it("leaves the GET converters list ungated (pure read)", async () => {
      const { routes, converterService } = createRetiredRoutes();
      const route = routes.find((r) => r.operationId === "skills.converters.list")!;
      const result = await route.handler(makeCtx()) as { converters: unknown[] };
      expect(converterService.listConverters).toHaveBeenCalledOnce();
      expect(result.converters).toHaveLength(2);
    });
  });

  describe("GET /v1/skills/converters", () => {
    it("returns list of converters", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.converters.list")!;

      const result = await route.handler(makeCtx()) as { converters: unknown[] };

      expect(converterService.listConverters).toHaveBeenCalledOnce();
      expect(result.converters).toHaveLength(2);
      expect(result.converters[0]).toEqual({
        id: "native-friday-package",
        displayName: "Native Friday Package",
        sourceFormats: ["friday-package"],
      });
    });
  });

  describe("POST /v1/skills/convert", () => {
    it("validates missing body", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.convert")!;

      await expect(route.handler(makeCtx({ body: null }))).rejects.toThrow(
        "Request body is required",
      );
    });

    it("validates missing source", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.convert")!;

      await expect(
        route.handler(makeCtx({ body: {} })),
      ).rejects.toThrow("source is required");
    });

    it("validates source without uri or contentBase64", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.convert")!;

      await expect(
        route.handler(makeCtx({ body: { source: {} } })),
      ).rejects.toThrow("source must include uri or contentBase64");
    });

    it("validates invalid formatHint", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.convert")!;

      await expect(
        route.handler(
          makeCtx({ body: { source: { uri: "/test" }, formatHint: "bogus" } }),
        ),
      ).rejects.toThrow("formatHint must be one of");
    });

    it("validates invalid options.splitOperations type", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.convert")!;

      await expect(
        route.handler(
          makeCtx({
            body: {
              source: { uri: "/test" },
              options: { splitOperations: "yes" },
            },
          }),
        ),
      ).rejects.toThrow("options.splitOperations must be a boolean");
    });

    it("calls convert with valid body", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.convert")!;

      const result = await route.handler(
        makeCtx({
          body: {
            source: { uri: "/path/to/skill" },
            formatHint: "auto",
            dryRun: true,
          },
        }),
      ) as {
        converterId: string;
        detectedFormat: string;
        quality: {
          score: number;
          status: string;
          draftPassRate: number;
        };
      };

      expect(converterService.convert).toHaveBeenCalledOnce();
      expect(result.converterId).toBe("clawdbot-skill-md");
      expect(result.detectedFormat).toBe("clawdbot-skill-md");
      expect(result.quality).toMatchObject({
        score: 100,
        status: "high",
        draftPassRate: 1,
      });
    });

    it("passes through converter-provided quality summary when available", async () => {
      const { routes, converterService } = createRoutes();
      (converterService.convert as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        converterId: "clawdbot-skill-md",
        detectedFormat: "clawdbot-skill-md",
        drafts: [],
        validation: [],
        quality: {
          score: 52,
          status: "low",
          draftPassRate: 0.5,
          issueCounts: { error: 1, warning: 3, info: 0 },
        },
      });
      const route = routes.find((r) => r.operationId === "skills.convert")!;

      const result = await route.handler(
        makeCtx({
          body: {
            source: { uri: "/path/to/skill" },
          },
        }),
      ) as { quality: { score: number; status: string; issueCounts: { error: number } } };

      expect(result.quality).toMatchObject({
        score: 52,
        status: "low",
      });
      expect(result.quality.issueCounts.error).toBe(1);
    });

    it("redacts token-bearing source material from convert preview responses", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.convert")!;
      const tokenBearingUri = "https://example.com/skill-repo?token=route-preview-secret-token";
      (converterService.convert as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        converterId: "clawdbot-skill-md",
        detectedFormat: "clawdbot-skill-md",
        drafts: [{
          manifest: { id: "preview-skill" },
          uiSchema: {},
          files: [{
            path: "conversion.report.json",
            content: JSON.stringify({ sourceRef: tokenBearingUri }),
          }],
          warnings: [`review source ${tokenBearingUri}`],
          conversionReport: {
            sourceFormat: "clawdbot-skill-md",
            sourceRef: tokenBearingUri,
            convertedAt: NOW,
            converterId: "clawdbot-skill-md",
          },
        }],
        validation: [{
          skillId: "preview-skill",
          ok: false,
          issues: [{
            stage: "manifest",
            severity: "warning",
            code: "SOURCE_WARNING",
            message: `source needs review: ${tokenBearingUri}`,
          }],
        }],
      });

      const result = await route.handler(makeCtx({
        body: {
          source: { uri: tokenBearingUri },
        },
      }));

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(tokenBearingUri);
      expect(serialized).not.toContain("route-preview-secret-token");
      expect(serialized).toContain("https://example.com/skill-repo?redacted=1");
    });

    it("redacts token-bearing source material from convert preview errors", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.convert")!;
      const tokenBearingUri = "https://example.com/skill-repo?token=route-error-secret-token";
      (converterService.convert as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new FridayDomainError(
          "CONVERTER_SOURCE_FAILED",
          `Failed to read ${tokenBearingUri}`,
          {
            httpStatus: 422,
            details: { source: tokenBearingUri },
          },
        ),
      );

      try {
        await route.handler(makeCtx({
          body: {
            source: { uri: tokenBearingUri },
          },
        }));
        throw new Error("Expected convert route to fail");
      } catch (err) {
        expect(err).toBeInstanceOf(FridayDomainError);
        const serialized = JSON.stringify({
          message: err instanceof Error ? err.message : String(err),
          details: err instanceof FridayDomainError ? err.details : undefined,
        });
        expect(serialized).not.toContain(tokenBearingUri);
        expect(serialized).not.toContain("route-error-secret-token");
        expect(serialized).toContain("https://example.com/skill-repo?redacted=1");
      }
    });

    it("accepts contentBase64 as source", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.convert")!;

      await route.handler(
        makeCtx({
          body: {
            source: { contentBase64: "dGVzdA==" },
          },
        }),
      );

      expect(converterService.convert).toHaveBeenCalledOnce();
    });

    it("accepts undocumented-api format hint", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.convert")!;

      await route.handler(
        makeCtx({
          body: {
            source: { uri: "https://docs.example.com/api" },
            formatHint: "undocumented-api",
          },
        }),
      );

      expect(converterService.convert).toHaveBeenCalledWith(
        expect.objectContaining({ formatHint: "undocumented-api" }),
      );
    });

    it("accepts code-repo format hint", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.convert")!;

      await route.handler(
        makeCtx({
          body: {
            source: { uri: "/tmp/repo" },
            formatHint: "code-repo",
          },
        }),
      );

      expect(converterService.convert).toHaveBeenCalledWith(
        expect.objectContaining({ formatHint: "code-repo" }),
      );
    });

    it("accepts desktop-recording format hint", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.convert")!;

      await route.handler(
        makeCtx({
          body: {
            source: { contentBase64: DESKTOP_RECORDING_BASE64_FIXTURE },
            formatHint: "desktop-recording",
          },
        }),
      );

      expect(converterService.convert).toHaveBeenCalledWith(
        expect.objectContaining({ formatHint: "desktop-recording" }),
      );
    });
  });

  describe("POST /v1/skills/import", () => {
    it("validates missing body", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.import")!;

      await expect(route.handler(makeCtx({ body: null }))).rejects.toThrow(
        "Request body is required",
      );
    });

    it("validates missing source", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.import")!;

      await expect(
        route.handler(makeCtx({ body: {} })),
      ).rejects.toThrow("source is required");
    });

    it("validates invalid target string", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.import")!;

      await expect(
        route.handler(
          makeCtx({
            body: { source: { uri: "/test" }, target: "invalid" },
          }),
        ),
      ).rejects.toThrow("target must be");
    });

    it("validates invalid target object (missing path)", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.import")!;

      await expect(
        route.handler(
          makeCtx({
            body: { source: { uri: "/test" }, target: { path: "" } },
          }),
        ),
      ).rejects.toThrow("target.path must be a non-empty string");
    });

    it("validates invalid replace type", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.import")!;

      await expect(
        route.handler(
          makeCtx({
            body: { source: { uri: "/test" }, replace: "yes" },
          }),
        ),
      ).rejects.toThrow("replace must be a boolean");
    });

    it("requires canonical approval before staging candidates", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.import")!;

      await expect(
        route.handler(
          makeCtx({
            principal: PRINCIPAL,
            body: {
              source: { uri: "/path/to/skill.md" },
              idempotencyKey: "stage-without-approval",
            },
          }),
        ),
      ).rejects.toThrow("requires canonical approval");
      expect(converterService.import).not.toHaveBeenCalled();
    });

    it("stages candidates instead of installing external skills outside lifecycle", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.import")!;
      const body = withCanonicalApproval({
        source: { uri: "/path/to/skill.md" },
        target: "managed",
        replace: true,
        refreshRegistry: true,
        idempotencyKey: "stage-managed-1",
      });

      const result = await route.handler(
        makeCtx({
          principal: PRINCIPAL,
          body,
        }),
      ) as { candidates: Array<{ skillId: string; candidateId: string }>; registryRefreshed: boolean };

      expect(converterService.import).toHaveBeenCalledWith(expect.objectContaining({
        source: { uri: "/path/to/skill.md" },
        formatHint: undefined,
        target: "managed",
        replace: true,
        refreshRegistry: true,
        options: undefined,
        canonicalApprovalTicket: expect.objectContaining({
          action: "skills.import.stage_candidate",
          approvalId: "approval-1",
          ticketId: "ticket-1",
        }),
      }));
      expect(result.candidates).toEqual([
        expect.objectContaining({ skillId: "test-skill", candidateId: "test-skill-1.0.0-candidate" }),
      ]);
      expect(result.registryRefreshed).toBe(false);
    });

    it("accepts production-signed canonical approval and passes the issued ticket to import", async () => {
      const secret = "route-production-secret"; // pragma: allowlist secret
      const { routes, converterService } = createRoutesWithSignedGate(secret);
      const route = routes.find((r) => r.operationId === "skills.import")!;
      const body = withSignedCanonicalApproval({
        source: { uri: "/path/to/skill.md" },
        idempotencyKey: "stage-signed-1",
      }, secret);

      await route.handler(makeCtx({
        principal: PRINCIPAL,
        body,
      }));

      expect(converterService.import).toHaveBeenCalledWith(expect.objectContaining({
        canonicalApprovalTicket: expect.objectContaining({
          ticketId: "signed-ticket-1",
          approvalId: "approval-signed-1",
          action: "skills.import.stage_candidate",
        }),
      }));
    });

    it("does not return raw token-bearing source material in staged candidate responses", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.import")!;
      const tokenBearingUri = "https://example.com/skill-repo?token=route-secret-token";
      const body = withCanonicalApproval({
        source: { uri: tokenBearingUri },
        idempotencyKey: "stage-redacted-source-1",
      });

      const result = await route.handler(
        makeCtx({
          principal: PRINCIPAL,
          body,
        }),
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(tokenBearingUri);
      expect(serialized).not.toContain("route-secret-token");
      expect(serialized).not.toContain("\"source\"");
      expect(serialized).toContain("sourceProvenance");
    });

    it("redacts token-bearing source material from successful import validation issues", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.import")!;
      const tokenBearingUri = "https://example.com/skill-repo?token=route-validation-secret-token";
      (converterService.import as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        converterId: "clawdbot-skill-md",
        detectedFormat: "clawdbot-skill-md",
        candidates: [],
        validation: [{
          skillId: "test-skill",
          ok: false,
          issues: [{
            stage: "manifest",
            severity: "warning",
            code: "SOURCE_WARNING",
            message: `source needs review: ${tokenBearingUri}`,
          }],
        }],
        registryRefreshed: false,
      });
      const body = withCanonicalApproval({
        source: { uri: tokenBearingUri },
        idempotencyKey: "stage-redacted-validation-source-1",
      });

      const result = await route.handler(makeCtx({
        principal: PRINCIPAL,
        body,
      }));

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(tokenBearingUri);
      expect(serialized).not.toContain("route-validation-secret-token");
      expect(serialized).toContain("https://example.com/skill-repo?redacted=1");
    });

    it("redacts token-bearing source material from import errors", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.import")!;
      const tokenBearingUri = "https://example.com/skill-repo?token=route-error-secret-token";
      (converterService.import as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new FridayDomainError(
          "CONVERTER_GIT_CLONE_FAILED",
          `Failed to clone git repository: ${tokenBearingUri}`,
          {
            httpStatus: 422,
            details: {
              sourceUri: tokenBearingUri,
              nested: { stderr: `fatal: could not read from ${tokenBearingUri}` },
            },
          },
        ),
      );
      const body = withCanonicalApproval({
        source: { uri: tokenBearingUri },
        idempotencyKey: "stage-redacted-error-source-1",
      });

      let thrown: unknown;
      try {
        await route.handler(
          makeCtx({
            principal: PRINCIPAL,
            body,
          }),
        );
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(FridayDomainError);
      expect((thrown as FridayDomainError).message).not.toContain(tokenBearingUri);
      expect(JSON.stringify((thrown as FridayDomainError).details)).not.toContain(tokenBearingUri);
      expect(JSON.stringify((thrown as FridayDomainError).details)).not.toContain("route-error-secret-token");
      expect(JSON.stringify((thrown as FridayDomainError).details)).toContain("sourceProvenance");
    });

    it("validates custom path shape but still only stages candidates", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.import")!;
      const body = withCanonicalApproval({
        source: { uri: "/path/to/skill" },
        target: { path: "/custom/install/dir" },
        idempotencyKey: "stage-custom-path-1",
      });

      const result = await route.handler(
        makeCtx({
          principal: PRINCIPAL,
          body,
        }),
      ) as { candidates: Array<{ skillId: string }>; registryRefreshed: boolean };

      expect(converterService.import).toHaveBeenCalledWith(expect.objectContaining({
        source: { uri: "/path/to/skill" },
        target: { path: "/custom/install/dir" },
      }));
      expect(result.candidates[0]?.skillId).toBe("test-skill");
      expect(result.registryRefreshed).toBe(false);
    });
  });

  describe("POST /v1/skills/pack", () => {
    it("validates missing body", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.pack")!;

      await expect(route.handler(makeCtx({ body: null }))).rejects.toThrow(
        "Request body is required",
      );
    });

    it("validates missing skillDir", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.pack")!;

      await expect(
        route.handler(makeCtx({ body: { outputFile: "/out.tgz" } })),
      ).rejects.toThrow("skillDir is required");
    });

    it("accepts missing outputFile and writes to the contained pack directory", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.pack")!;

      await route.handler(makeCtx({ body: { skillDir: "/skills/test-skill" } }));

      expect(converterService.pack).toHaveBeenCalledWith({
        skillDir: "/skills/test-skill",
        outputFile: join(PACK_OUTPUT_DIR, "test-skill.friday.tgz"),
      });
    });

    it("validates empty skillDir", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.pack")!;

      await expect(
        route.handler(
          makeCtx({ body: { skillDir: "  ", outputFile: "/out.tgz" } }),
        ),
      ).rejects.toThrow("skillDir is required");
    });

    it("rejects caller-selected filesystem paths for API pack output", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.pack")!;

      await expect(
        route.handler(
          makeCtx({ body: { skillDir: "/path/to/skill", outputFile: "/tmp/skill.friday.tgz" } }),
        ),
      ).rejects.toThrow("outputFile must be a contained filename");
      expect(converterService.pack).not.toHaveBeenCalled();
    });

    it("calls pack with valid body", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.pack")!;

      const result = await route.handler(
        makeCtx({
          body: {
            skillDir: "/path/to/skill",
            outputFile: "skill.friday.tgz",
          },
        }),
      ) as { packageFile: string; checksumSha256: string };

      expect(converterService.pack).toHaveBeenCalledWith({
        skillDir: "/path/to/skill",
        outputFile: join(PACK_OUTPUT_DIR, "skill.friday.tgz"),
      });
      expect(result.packageFile).toBe("/tmp/test-skill-1.0.0.friday.tgz");
      expect(result.checksumSha256).toBe("abc123def456");
    });
  });
});
