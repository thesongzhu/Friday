import { describe, it, expect, vi } from "vitest";
import { createFridaySkillConverterRoutes } from "#api";
import type { FridaySkillConverterService } from "#hub";
import type { FridayHttpContext } from "#api";

const NOW = "2026-02-17T10:00:00.000Z";
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
    import: vi.fn(async () => ({
      converterId: "clawdbot-skill-md",
      detectedFormat: "clawdbot-skill-md" as const,
      imports: [
        {
          skillId: "test-skill",
          skillDir: "/tmp/skills/test-skill",
          installed: true,
          issues: [],
        },
      ],
      registryRefreshed: true,
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
    const routes = createFridaySkillConverterRoutes({ converterService });
    return { routes, converterService };
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
    expect(listRoute.auth).toEqual({ public: false, anyOfScopes: ["skill.read"] });

    const convertRoute = find("skills.convert")!;
    expect(convertRoute.auth).toEqual({ public: false, anyOfScopes: ["skill.write"] });

    const importRoute = find("skills.import")!;
    expect(importRoute.auth).toEqual({ public: false, anyOfScopes: ["skill.write"] });

    const packRoute = find("skills.pack")!;
    expect(packRoute.auth).toEqual({ public: false, anyOfScopes: ["skill.write"] });
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

    it("calls import with valid body (managed target)", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.import")!;

      const result = await route.handler(
        makeCtx({
          body: {
            source: { uri: "/path/to/skill.md" },
            target: "managed",
            replace: true,
            refreshRegistry: true,
          },
        }),
      ) as { converterId: string; imports: unknown[]; registryRefreshed: boolean };

      expect(converterService.import).toHaveBeenCalledOnce();
      expect(result.converterId).toBe("clawdbot-skill-md");
      expect(result.imports).toHaveLength(1);
      expect(result.registryRefreshed).toBe(true);
    });

    it("calls import with custom path target", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.import")!;

      await route.handler(
        makeCtx({
          body: {
            source: { uri: "/path/to/skill" },
            target: { path: "/custom/install/dir" },
          },
        }),
      );

      expect(converterService.import).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { path: "/custom/install/dir" },
        }),
      );
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

    it("validates missing outputFile", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.pack")!;

      await expect(
        route.handler(makeCtx({ body: { skillDir: "/skills/test" } })),
      ).rejects.toThrow("outputFile is required");
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

    it("calls pack with valid body", async () => {
      const { routes, converterService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.pack")!;

      const result = await route.handler(
        makeCtx({
          body: {
            skillDir: "/path/to/skill",
            outputFile: "/tmp/skill.friday.tgz",
          },
        }),
      ) as { packageFile: string; checksumSha256: string };

      expect(converterService.pack).toHaveBeenCalledWith({
        skillDir: "/path/to/skill",
        outputFile: "/tmp/skill.friday.tgz",
      });
      expect(result.packageFile).toBe("/tmp/test-skill-1.0.0.friday.tgz");
      expect(result.checksumSha256).toBe("abc123def456");
    });
  });
});
