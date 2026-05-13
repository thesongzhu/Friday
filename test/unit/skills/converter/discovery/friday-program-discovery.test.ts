import { describe, it, expect, vi } from "vitest";
import { generateRecommendations } from "../../../../../src/skills/converter/discovery/friday-integration-recommendation-engine.js";
import { createFridayProgramDiscoveryService } from "../../../../../src/skills/converter/discovery/friday-program-discovery-service.js";
import { createFridayDiscoveryRoutes } from "../../../../../src/api/http/routes/friday-discovery-routes.js";
import type {
  FridayDiscoveredProgram,
  FridayDiscoveryPolicy,
  FridayProgramScanner,
  FridayProgramCategory,
  FridayIntegrationPath,
} from "../../../../../src/skills/converter/discovery/friday-program-discovery.types.js";
import { DEFAULT_DISCOVERY_POLICY } from "../../../../../src/skills/converter/discovery/friday-program-discovery.types.js";

// ─── Fixtures ───

function makeProgram(overrides: Partial<FridayDiscoveredProgram> = {}): FridayDiscoveredProgram {
  return {
    id: "com.example.app",
    name: "Example App",
    version: "1.0.0",
    executablePath: "/Applications/Example.app",
    bundleId: "com.example.app",
    category: "productivity",
    platform: "darwin",
    isCli: false,
    metadata: {},
    discoveredAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeCliTool(overrides: Partial<FridayDiscoveredProgram> = {}): FridayDiscoveredProgram {
  return makeProgram({
    id: "cli:git",
    name: "git",
    executablePath: "/usr/bin/git",
    category: "development",
    isCli: true,
    bundleId: undefined,
    ...overrides,
  });
}

function makeMockScanner(programs: FridayDiscoveredProgram[] = []): FridayProgramScanner {
  return {
    platform: "darwin",
    scan: vi.fn().mockResolvedValue(programs),
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "test-req-1",
    receivedAt: "2026-01-01T00:00:00Z",
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: null,
    ...overrides,
  } as any;
}

// ─── Recommendation Engine Tests ───

describe("generateRecommendations", () => {
  describe("integration path mapping", () => {
    it("recommends web-flow for browser apps", () => {
      const programs = [makeProgram({ id: "chrome", name: "Google Chrome", category: "browser" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0].integrationPath).toBe("web-flow");
      expect(result.recommendations[0].confidence).toBeGreaterThanOrEqual(0.9);
    });

    it("recommends code-repo for CLI development tools", () => {
      const programs = [makeCliTool()];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].integrationPath).toBe("code-repo");
    });

    it("recommends desktop-recording for GUI editors", () => {
      const programs = [makeProgram({ id: "vscode", name: "VS Code", category: "editor" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].integrationPath).toBe("desktop-recording");
    });

    it("recommends desktop-control for CLI editors", () => {
      const programs = [makeCliTool({ name: "vim", id: "cli:vim", category: "editor" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].integrationPath).toBe("desktop-control");
    });

    it("recommends desktop-recording for communication apps", () => {
      const programs = [makeProgram({ id: "slack", name: "Slack", category: "communication" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].integrationPath).toBe("desktop-recording");
    });

    it("recommends rest-api for cloud CLI tools", () => {
      const programs = [makeCliTool({ name: "aws", id: "cli:aws", category: "cloud" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].integrationPath).toBe("rest-api");
    });

    it("recommends web-flow for cloud GUI apps", () => {
      const programs = [makeProgram({ name: "AWS Console", category: "cloud" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].integrationPath).toBe("web-flow");
    });

    it("recommends desktop-control for automation tools", () => {
      const programs = [makeProgram({ name: "Automator", category: "automation" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].integrationPath).toBe("desktop-control");
    });

    it("recommends desktop-recording for productivity apps", () => {
      const programs = [makeProgram({ name: "Pages", category: "productivity" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].integrationPath).toBe("desktop-recording");
    });

    it("recommends desktop-control for terminal emulators", () => {
      const programs = [makeProgram({ name: "iTerm", category: "terminal" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].integrationPath).toBe("desktop-control");
    });

    it("recommends rest-api for database GUI clients", () => {
      const programs = [makeProgram({ name: "TablePlus", category: "database" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].integrationPath).toBe("rest-api");
    });

    it("recommends code-repo for database CLI tools", () => {
      const programs = [makeCliTool({ name: "psql", id: "cli:psql", category: "database" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].integrationPath).toBe("code-repo");
    });

    it("recommends desktop-recording for design tools", () => {
      const programs = [makeProgram({ name: "Figma", category: "design" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].integrationPath).toBe("desktop-recording");
    });

    it("recommends code-repo for media CLI tools", () => {
      const programs = [makeCliTool({ name: "ffmpeg", id: "cli:ffmpeg", category: "media" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].integrationPath).toBe("code-repo");
    });

    it("recommends desktop-recording for media GUI apps", () => {
      const programs = [makeProgram({ name: "Spotify", category: "media" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].integrationPath).toBe("desktop-recording");
    });
  });

  describe("rationale and context", () => {
    it("includes rationale for each recommendation", () => {
      const programs = [makeProgram({ name: "Chrome", category: "browser" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].rationale).toBeTruthy();
      expect(result.recommendations[0].rationale.length).toBeGreaterThan(10);
    });

    it("includes context with category and platform", () => {
      const programs = [makeProgram({ name: "Chrome", category: "browser" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].context.category).toBe("browser");
      expect(result.recommendations[0].context.platform).toBe("darwin");
    });

    it("includes bundleId in context when available", () => {
      const programs = [makeProgram({ bundleId: "com.google.Chrome" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].context.bundleId).toBe("com.google.Chrome");
    });
  });

  describe("filtering", () => {
    const programs = [
      makeProgram({ id: "chrome", name: "Chrome", category: "browser" }),
      makeProgram({ id: "slack", name: "Slack", category: "communication" }),
      makeCliTool({ id: "cli:git", name: "git", category: "development" }),
      makeCliTool({ id: "cli:aws", name: "aws", category: "cloud" }),
    ];

    it("filters by category", () => {
      const result = generateRecommendations(programs, { category: "browser" });
      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0].programId).toBe("chrome");
    });

    it("filters by minConfidence", () => {
      const result = generateRecommendations(programs, { minConfidence: 0.85 });
      for (const rec of result.recommendations) {
        expect(rec.confidence).toBeGreaterThanOrEqual(0.85);
      }
    });

    it("filters by integrationPath", () => {
      const result = generateRecommendations(programs, { integrationPath: "code-repo" });
      for (const rec of result.recommendations) {
        expect(rec.integrationPath).toBe("code-repo");
      }
    });

    it("filters by query (name search)", () => {
      const result = generateRecommendations(programs, { query: "chr" });
      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0].programName).toBe("Chrome");
    });

    it("query search is case-insensitive", () => {
      const result = generateRecommendations(programs, { query: "SLACK" });
      expect(result.recommendations).toHaveLength(1);
    });

    it("returns empty for no matches", () => {
      const result = generateRecommendations(programs, { category: "finance" });
      expect(result.recommendations).toHaveLength(0);
    });
  });

  describe("sorting and unmatched", () => {
    it("sorts recommendations by confidence descending", () => {
      const programs = [
        makeProgram({ id: "sys", name: "SystemPrefs", category: "system" }),
        makeProgram({ id: "chrome", name: "Chrome", category: "browser" }),
      ];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].confidence).toBeGreaterThanOrEqual(
        result.recommendations[1].confidence,
      );
    });

    it("counts unmatched programs", () => {
      const result = generateRecommendations([]);
      expect(result.unmatched).toBe(0);
    });

    it("includes generatedAt timestamp", () => {
      const result = generateRecommendations([]);
      expect(result.generatedAt).toBeTruthy();
    });
  });

  describe("catch-all rules", () => {
    it("falls back to desktop-recording for unknown GUI apps", () => {
      const programs = [makeProgram({ name: "UnknownApp", category: "other" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].integrationPath).toBe("desktop-recording");
      expect(result.recommendations[0].confidence).toBe(0.50);
    });

    it("falls back to code-repo for unknown CLI tools", () => {
      const programs = [makeCliTool({ name: "unknowntool", category: "other" })];
      const result = generateRecommendations(programs);
      expect(result.recommendations[0].integrationPath).toBe("code-repo");
      expect(result.recommendations[0].confidence).toBe(0.45);
    });
  });
});

// ─── Discovery Service Tests ───

describe("FridayProgramDiscoveryService", () => {
  describe("discover", () => {
    it("returns a catalog from the scanner", async () => {
      const programs = [makeProgram(), makeCliTool()];
      const scanner = makeMockScanner(programs);
      const service = createFridayProgramDiscoveryService({ scanner });

      const catalog = await service.discover();
      expect(catalog.programs).toHaveLength(2);
      expect(catalog.platform).toBe("darwin");
      expect(catalog.id).toBeTruthy();
      expect(catalog.generatedAt).toBeTruthy();
      expect(catalog.scanDurationMs).toBeGreaterThanOrEqual(0);
      expect(catalog.scanErrors).toBe(0);
    });

    it("caches the catalog", async () => {
      const scanner = makeMockScanner([makeProgram()]);
      const service = createFridayProgramDiscoveryService({ scanner });

      expect(service.getCachedCatalog()).toBeNull();
      await service.discover();
      expect(service.getCachedCatalog()).not.toBeNull();
    });

    it("throws when discovery is disabled", async () => {
      const scanner = makeMockScanner();
      const service = createFridayProgramDiscoveryService({
        scanner,
        initialPolicy: { enabled: false },
      });

      await expect(service.discover()).rejects.toThrow("disabled");
    });

    it("handles scanner errors gracefully", async () => {
      const scanner: FridayProgramScanner = {
        platform: "darwin",
        scan: vi.fn().mockRejectedValue(new Error("scan failed")),
      };
      const service = createFridayProgramDiscoveryService({ scanner });
      const catalog = await service.discover();
      expect(catalog.programs).toHaveLength(0);
      expect(catalog.scanErrors).toBe(1);
    });
  });

  describe("recommend", () => {
    it("returns recommendations for discovered programs", async () => {
      const programs = [
        makeProgram({ id: "chrome", name: "Chrome", category: "browser" }),
        makeCliTool(),
      ];
      const scanner = makeMockScanner(programs);
      const service = createFridayProgramDiscoveryService({ scanner });

      const result = await service.recommend();
      expect(result.recommendations.length).toBeGreaterThanOrEqual(2);
    });

    it("runs a scan if no cached catalog", async () => {
      const scanner = makeMockScanner([makeProgram()]);
      const service = createFridayProgramDiscoveryService({ scanner });

      await service.recommend();
      expect(scanner.scan).toHaveBeenCalled();
    });

    it("uses cached catalog if available", async () => {
      const scanner = makeMockScanner([makeProgram()]);
      const service = createFridayProgramDiscoveryService({ scanner });

      await service.discover();
      (scanner.scan as ReturnType<typeof vi.fn>).mockClear();
      await service.recommend();
      expect(scanner.scan).not.toHaveBeenCalled();
    });

    it("passes filter to recommendation engine", async () => {
      const programs = [
        makeProgram({ id: "chrome", name: "Chrome", category: "browser" }),
        makeCliTool(),
      ];
      const scanner = makeMockScanner(programs);
      const service = createFridayProgramDiscoveryService({ scanner });

      const result = await service.recommend({ category: "browser" });
      expect(result.recommendations).toHaveLength(1);
    });

    it("throws when disabled", async () => {
      const scanner = makeMockScanner();
      const service = createFridayProgramDiscoveryService({
        scanner,
        initialPolicy: { enabled: false },
      });
      await expect(service.recommend()).rejects.toThrow("disabled");
    });
  });

  describe("policy management", () => {
    it("returns default policy", () => {
      const scanner = makeMockScanner();
      const service = createFridayProgramDiscoveryService({ scanner });
      const policy = service.getPolicy();
      expect(policy.enabled).toBe(true);
      expect(policy.scheduledRefreshEnabled).toBe(false);
    });

    it("merges initial policy overrides", () => {
      const scanner = makeMockScanner();
      const service = createFridayProgramDiscoveryService({
        scanner,
        initialPolicy: { redactSensitiveDetails: true },
      });
      expect(service.getPolicy().redactSensitiveDetails).toBe(true);
    });

    it("updates policy via setPolicy", () => {
      const scanner = makeMockScanner();
      const service = createFridayProgramDiscoveryService({ scanner });

      service.setPolicy({ enabled: false });
      expect(service.getPolicy().enabled).toBe(false);
      expect(service.isEnabled()).toBe(false);
    });

    it("preserves other fields when updating policy", () => {
      const scanner = makeMockScanner();
      const service = createFridayProgramDiscoveryService({
        scanner,
        initialPolicy: { redactSensitiveDetails: true },
      });

      service.setPolicy({ enabled: false });
      expect(service.getPolicy().redactSensitiveDetails).toBe(true);
    });

    it("isEnabled reflects policy state", () => {
      const scanner = makeMockScanner();
      const service = createFridayProgramDiscoveryService({ scanner });
      expect(service.isEnabled()).toBe(true);
      service.setPolicy({ enabled: false });
      expect(service.isEnabled()).toBe(false);
    });
  });
});

// ─── Discovery Routes Tests ───

describe("FridayDiscoveryRoutes", () => {
  function makeTestDeps() {
    const catalog = {
      id: "cat-1",
      platform: "darwin" as const,
      programs: [
        makeProgram({ id: "chrome", name: "Chrome", category: "browser" }),
        makeCliTool({ id: "cli:git", name: "git" }),
      ],
      generatedAt: "2026-01-01T00:00:00Z",
      scanDurationMs: 500,
      scanErrors: 0,
    };

    let cachedCatalog: typeof catalog | null = null;
    let policy = { ...DEFAULT_DISCOVERY_POLICY };

    return {
      deps: {
        discovery: {
          discover: vi.fn().mockImplementation(async () => {
            cachedCatalog = catalog;
            return catalog;
          }),
          getCachedCatalog: vi.fn().mockImplementation(() => cachedCatalog),
          recommend: vi.fn().mockResolvedValue({
            recommendations: [
              {
                programId: "chrome",
                programName: "Chrome",
                integrationPath: "web-flow",
                confidence: 0.95,
                rationale: "Browser",
                context: { category: "browser", platform: "darwin" },
              },
            ],
            unmatched: 0,
            generatedAt: "2026-01-01T00:00:00Z",
          }),
          getPolicy: vi.fn().mockImplementation(() => ({ ...policy })),
          setPolicy: vi.fn().mockImplementation((updates: Record<string, unknown>) => {
            policy = { ...policy, ...updates } as typeof policy;
          }),
          isEnabled: vi.fn().mockReturnValue(true),
        },
      },
      setCachedCatalog: (cat: typeof catalog | null) => { cachedCatalog = cat; },
    };
  }

  describe("route array", () => {
    it("creates 7 routes", () => {
      const { deps } = makeTestDeps();
      const routes = createFridayDiscoveryRoutes(deps);
      expect(routes).toHaveLength(7);
    });

    it("every route declares public auth (auth-boundary product invariant)", () => {
      const { deps } = makeTestDeps();
      const routes = createFridayDiscoveryRoutes(deps);
      for (const route of routes) {
        expect(route.auth).toEqual({ public: true });
      }
    });

    it("covers all expected operation IDs", () => {
      const { deps } = makeTestDeps();
      const routes = createFridayDiscoveryRoutes(deps);
      const ids = routes.map((r) => r.operationId);
      expect(ids).toEqual(
        expect.arrayContaining([
          "discovery.scan",
          "discovery.catalog.get",
          "discovery.programs.list",
          "discovery.recommend",
          "discovery.policy.get",
          "discovery.policy.update",
          "discovery.status",
        ]),
      );
    });
  });

  describe("POST /v1/discovery/scan", () => {
    it("triggers scan and returns catalog summary", async () => {
      const { deps } = makeTestDeps();
      const routes = createFridayDiscoveryRoutes(deps);
      const route = routes.find((r) => r.operationId === "discovery.scan")!;

      const result = await route.handler(makeCtx());
      expect(result).toEqual({
        status: 200,
        body: {
          catalog: {
            id: "cat-1",
            platform: "darwin",
            programCount: 2,
            generatedAt: "2026-01-01T00:00:00Z",
            scanDurationMs: 500,
            scanErrors: 0,
          },
        },
      });
    });
  });

  describe("GET /v1/discovery/catalog", () => {
    it("returns 404 when no catalog cached", async () => {
      const { deps } = makeTestDeps();
      const routes = createFridayDiscoveryRoutes(deps);
      const route = routes.find((r) => r.operationId === "discovery.catalog.get")!;

      await expect(route.handler(makeCtx())).rejects.toThrow("No catalog available");
    });

    it("returns catalog when cached", async () => {
      const { deps, setCachedCatalog } = makeTestDeps();
      const catalog = {
        id: "cat-1",
        platform: "darwin",
        programs: [],
        generatedAt: "2026-01-01T00:00:00Z",
        scanDurationMs: 0,
        scanErrors: 0,
      };
      setCachedCatalog(catalog as any);
      (deps.discovery.getCachedCatalog as any).mockReturnValue(catalog);

      const routes = createFridayDiscoveryRoutes(deps);
      const route = routes.find((r) => r.operationId === "discovery.catalog.get")!;
      const result = await route.handler(makeCtx());
      expect((result as any).status).toBe(200);
    });
  });

  describe("GET /v1/discovery/programs", () => {
    it("returns 404 when no catalog", async () => {
      const { deps } = makeTestDeps();
      const routes = createFridayDiscoveryRoutes(deps);
      const route = routes.find((r) => r.operationId === "discovery.programs.list")!;

      await expect(route.handler(makeCtx())).rejects.toThrow("No catalog available");
    });

    it("returns programs with filtering", async () => {
      const { deps, setCachedCatalog } = makeTestDeps();
      const catalog = {
        id: "cat-1",
        platform: "darwin",
        programs: [
          makeProgram({ id: "chrome", name: "Chrome", category: "browser" }),
          makeCliTool({ id: "cli:git", name: "git" }),
        ],
        generatedAt: "2026-01-01T00:00:00Z",
        scanDurationMs: 0,
        scanErrors: 0,
      };
      setCachedCatalog(catalog as any);
      (deps.discovery.getCachedCatalog as any).mockReturnValue(catalog);

      const routes = createFridayDiscoveryRoutes(deps);
      const route = routes.find((r) => r.operationId === "discovery.programs.list")!;
      const result = await route.handler(makeCtx({ query: { category: "browser" } })) as any;
      expect(result.status).toBe(200);
      expect(result.body.programs).toHaveLength(1);
      expect(result.body.programs[0].id).toBe("chrome");
    });
  });

  describe("GET /v1/discovery/recommendations", () => {
    it("returns recommendations", async () => {
      const { deps } = makeTestDeps();
      const routes = createFridayDiscoveryRoutes(deps);
      const route = routes.find((r) => r.operationId === "discovery.recommend")!;

      const result = await route.handler(makeCtx()) as any;
      expect(result.status).toBe(200);
      expect(result.body.recommendations).toHaveLength(1);
    });

    it("passes query params as filter", async () => {
      const { deps } = makeTestDeps();
      const routes = createFridayDiscoveryRoutes(deps);
      const route = routes.find((r) => r.operationId === "discovery.recommend")!;

      await route.handler(makeCtx({ query: { category: "browser", minConfidence: "0.8" } }));
      expect(deps.discovery.recommend).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "browser",
          minConfidence: 0.8,
        }),
      );
    });
  });

  describe("GET /v1/discovery/policy", () => {
    it("returns current policy", async () => {
      const { deps } = makeTestDeps();
      const routes = createFridayDiscoveryRoutes(deps);
      const route = routes.find((r) => r.operationId === "discovery.policy.get")!;

      const result = await route.handler(makeCtx()) as any;
      expect(result.status).toBe(200);
      expect(result.body.policy.enabled).toBe(true);
    });

    it("discovery.policy.get is public under auth-boundary product invariant", () => {
      const { deps } = makeTestDeps();
      const routes = createFridayDiscoveryRoutes(deps);
      const route = routes.find((r) => r.operationId === "discovery.policy.get")!;
      expect(route.auth).toEqual({ public: true });
    });
  });

  describe("PATCH /v1/discovery/policy", () => {
    it("updates policy and returns new state", async () => {
      const { deps } = makeTestDeps();
      const routes = createFridayDiscoveryRoutes(deps);
      const route = routes.find((r) => r.operationId === "discovery.policy.update")!;

      const result = await route.handler(
        makeCtx({ body: { enabled: false, redactSensitiveDetails: true } }),
      ) as any;
      expect(result.status).toBe(200);
      expect(deps.discovery.setPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false, redactSensitiveDetails: true }),
      );
    });

    it("discovery.policy.update is public under auth-boundary product invariant", () => {
      const { deps } = makeTestDeps();
      const routes = createFridayDiscoveryRoutes(deps);
      const route = routes.find((r) => r.operationId === "discovery.policy.update")!;
      expect(route.auth).toEqual({ public: true });
    });

    it("ignores invalid field types in body", async () => {
      const { deps } = makeTestDeps();
      const routes = createFridayDiscoveryRoutes(deps);
      const route = routes.find((r) => r.operationId === "discovery.policy.update")!;

      await route.handler(makeCtx({ body: { enabled: "yes", unknown: 123 } }));
      expect(deps.discovery.setPolicy).toHaveBeenCalledWith({});
    });
  });

  describe("GET /v1/discovery/status", () => {
    it("returns status with no catalog", async () => {
      const { deps } = makeTestDeps();
      const routes = createFridayDiscoveryRoutes(deps);
      const route = routes.find((r) => r.operationId === "discovery.status")!;

      const result = await route.handler(makeCtx()) as any;
      expect(result.status).toBe(200);
      expect(result.body.enabled).toBe(true);
      expect(result.body.hasCatalog).toBe(false);
      expect(result.body.programCount).toBe(0);
    });
  });

  describe("route shape under auth-boundary product invariant", () => {
    it("former read routes are present and public", () => {
      const { deps } = makeTestDeps();
      const routes = createFridayDiscoveryRoutes(deps);
      const readRoutes = routes.filter((r) =>
        ["discovery.catalog.get", "discovery.programs.list", "discovery.recommend", "discovery.status"].includes(r.operationId),
      );
      expect(readRoutes.length).toBe(4);
      for (const route of readRoutes) {
        expect(route.auth).toEqual({ public: true });
      }
    });

    it("former write route (discovery.policy.update) is present and public", () => {
      const { deps } = makeTestDeps();
      const routes = createFridayDiscoveryRoutes(deps);
      const writeRoute = routes.find((r) => r.operationId === "discovery.policy.update")!;
      expect(writeRoute).toBeDefined();
      expect(writeRoute.auth).toEqual({ public: true });
    });
  });
});

// ─── Default Policy Tests ───

describe("DEFAULT_DISCOVERY_POLICY", () => {
  it("has expected defaults", () => {
    expect(DEFAULT_DISCOVERY_POLICY.enabled).toBe(true);
    expect(DEFAULT_DISCOVERY_POLICY.scheduledRefreshEnabled).toBe(false);
    expect(DEFAULT_DISCOVERY_POLICY.refreshIntervalMs).toBe(86_400_000);
    expect(DEFAULT_DISCOVERY_POLICY.excludedPaths).toEqual([]);
    expect(DEFAULT_DISCOVERY_POLICY.excludedProgramIds).toEqual([]);
    expect(DEFAULT_DISCOVERY_POLICY.redactSensitiveDetails).toBe(false);
  });
});
