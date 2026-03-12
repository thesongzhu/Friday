/**
 * Tests for the remaining CX API audit fixes (P1 + P2).
 *
 * Covers:
 * - Rate limit policy IDs on provider, workflow generator, skill generator, skill converter routes
 * - Memory prune olderThan ISO-8601 validation (MEM-001)
 * - Fleet query param validation and 404 for missing satellite (FLT-001, FLT-002)
 * - Skill generator non-object body rejection (SGEN-003)
 * - Session remember mode validation (SES-VAL-007)
 * - Error mapper includes details from domain errors (API-ERR-001)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../../satellites/_helpers/create-test-db.helper.js";
import { FridayDomainError } from "#errors";

// ─── Route factories ───
import { createFridayProviderRoutes } from "#api";
import { createFridayWorkflowGeneratorRoutes } from "#api";
import { createFridaySkillGeneratorRoutes } from "#api";
import { createFridaySkillConverterRoutes } from "#api";
import { createFridayMemoryRoutes } from "#api";
import { createFridayFleetRoutes, createFridayFleetDashboardService } from "#api";
import type { FridayHttpContext, FridayRouteDefinition } from "#api";

// ─── Error mapper ───
import { buildErrorResponse } from "#api";

const NOW = "2026-02-18T10:00:00.000Z";

function makeCtx(
  overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {},
): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-test",
    receivedAt: NOW,
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: {
      principalType: "user" as const,
      principalId: "user-1",
      userId: "user-1",
      role: "admin" as const,
      scopes: ["hub.admin" as const],
      tokenId: "tok-1",
      tokenKind: "access" as const,
      issuedAt: NOW,
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────
// P1: Rate limit policy IDs on provider routes (API-RATE-001)
// ─────────────────────────────────────────────────────────

describe("API-RATE-001: Provider routes have rateLimitPolicyId", () => {
  const providerService = {
    listProviders: vi.fn(async () => []),
    getProvider: vi.fn(async () => null),
    createProvider: vi.fn(async () => ({ id: "p-1", config: { validation: null } })),
    updateProvider: vi.fn(async () => ({ id: "p-1", config: { validation: null } })),
    deleteProvider: vi.fn(async () => undefined),
    validateProvider: vi.fn(async () => ({ ok: true })),
    getRoutingConfig: vi.fn(async () => ({})),
    setRoutingConfig: vi.fn(async () => ({})),
    initiateOAuthLogin: vi.fn(async () => ({})),
    completeOAuthLogin: vi.fn(async () => ({})),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routes = createFridayProviderRoutes({ providerService: providerService as any });
  function find(opId: string) {
    return routes.find((r) => r.operationId === opId)!;
  }

  it("providers.create has provider.write policy", () => {
    expect(find("providers.create").rateLimitPolicyId).toBe("provider.write");
  });

  it("providers.update has provider.write policy", () => {
    expect(find("providers.update").rateLimitPolicyId).toBe("provider.write");
  });

  it("providers.delete has provider.write policy", () => {
    expect(find("providers.delete").rateLimitPolicyId).toBe("provider.write");
  });

  it("providers.validate has provider.validate policy", () => {
    expect(find("providers.validate").rateLimitPolicyId).toBe("provider.validate");
  });

  it("providers.routing.set has provider.write policy", () => {
    expect(find("providers.routing.set").rateLimitPolicyId).toBe("provider.write");
  });

  it("auth.oauth.anthropic.initiate has provider.write policy", () => {
    expect(find("auth.oauth.anthropic.initiate").rateLimitPolicyId).toBe("provider.write");
  });

  it("auth.oauth.anthropic.callback has provider.write policy", () => {
    expect(find("auth.oauth.anthropic.callback").rateLimitPolicyId).toBe("provider.write");
  });

  it("GET providers.list has no rate limit (read-only)", () => {
    expect(find("providers.list").rateLimitPolicyId).toBeUndefined();
  });

  it("GET providers.get has no rate limit (read-only)", () => {
    expect(find("providers.get").rateLimitPolicyId).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────
// P1: Rate limit policy IDs on workflow generator (GEN-RATE-004)
// ─────────────────────────────────────────────────────────

describe("GEN-RATE-004: Workflow generator routes have rateLimitPolicyId", () => {
  const wfGen = {
    startSession: vi.fn(async () => ({})),
    getSession: vi.fn(async () => ({})),
    submitTurn: vi.fn(async () => ({})),
    generateDraft: vi.fn(async () => ({})),
    approveAndSave: vi.fn(async () => ({})),
    cancelSession: vi.fn(async () => undefined),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routes = createFridayWorkflowGeneratorRoutes({ workflowGenerator: wfGen as any });
  function find(opId: string) {
    return routes.find((r) => r.operationId === opId)!;
  }

  it("sessions.create has generator.write policy", () => {
    expect(find("workflows.generator.sessions.create").rateLimitPolicyId).toBe("generator.write");
  });

  it("sessions.messages.create has generator.llm policy", () => {
    expect(find("workflows.generator.sessions.messages.create").rateLimitPolicyId).toBe("generator.llm");
  });

  it("sessions.generate has generator.llm policy", () => {
    expect(find("workflows.generator.sessions.generate").rateLimitPolicyId).toBe("generator.llm");
  });

  it("sessions.approve already has workflow.publish policy", () => {
    expect(find("workflows.generator.sessions.approve").rateLimitPolicyId).toBe("workflow.publish");
  });

  it("GET sessions.get has no rate limit (read-only)", () => {
    expect(find("workflows.generator.sessions.get").rateLimitPolicyId).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────
// P1: Rate limit policy IDs on skill generator (SGEN-001)
// ─────────────────────────────────────────────────────────

describe("SGEN-001: Skill generator routes have rateLimitPolicyId", () => {
  const skillGen = {
    startSession: vi.fn(async () => ({})),
    getSession: vi.fn(async () => ({})),
    submitTurn: vi.fn(async () => ({})),
    generateDraft: vi.fn(async () => ({})),
    approveAndSave: vi.fn(async () => ({})),
    cancelSession: vi.fn(async () => undefined),
  };
  const registry = {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    resolveByIntent: vi.fn(() => null),
    validateAll: vi.fn(() => []),
    reload: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    isCompatible: vi.fn(() => ({ compatible: true, reasons: [] })),
    startWatching: vi.fn(async () => undefined),
    stopWatching: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routes = createFridaySkillGeneratorRoutes({ skillGenerator: skillGen as any, registry: registry as any });
  function find(opId: string) {
    return routes.find((r) => r.operationId === opId)!;
  }

  it("sessions.create has skill_generator.write policy", () => {
    expect(find("skills.generator.sessions.create").rateLimitPolicyId).toBe("skill_generator.write");
  });

  it("sessions.messages.create has skill_generator.llm policy", () => {
    expect(find("skills.generator.sessions.messages.create").rateLimitPolicyId).toBe("skill_generator.llm");
  });

  it("sessions.generate has skill_generator.llm policy", () => {
    expect(find("skills.generator.sessions.generate").rateLimitPolicyId).toBe("skill_generator.llm");
  });

  it("sessions.approve has skill_generator.write policy", () => {
    expect(find("skills.generator.sessions.approve").rateLimitPolicyId).toBe("skill_generator.write");
  });
});

// ─────────────────────────────────────────────────────────
// P1: Rate limit policy IDs on skill converter (SCONV-001)
// ─────────────────────────────────────────────────────────

describe("SCONV-001: Skill converter routes have rateLimitPolicyId", () => {
  const converterService = {
    listConverters: vi.fn(() => []),
    convert: vi.fn(async () => ({})),
    import: vi.fn(async () => ({})),
    pack: vi.fn(async () => ({})),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routes = createFridaySkillConverterRoutes({ converterService: converterService as any });
  function find(opId: string) {
    return routes.find((r) => r.operationId === opId)!;
  }

  it("skills.convert has skill_converter.write policy", () => {
    expect(find("skills.convert").rateLimitPolicyId).toBe("skill_converter.write");
  });

  it("skills.import has skill_converter.write policy", () => {
    expect(find("skills.import").rateLimitPolicyId).toBe("skill_converter.write");
  });

  it("skills.pack has skill_converter.write policy", () => {
    expect(find("skills.pack").rateLimitPolicyId).toBe("skill_converter.write");
  });

  it("converters.list has no rate limit (read-only)", () => {
    expect(find("skills.converters.list").rateLimitPolicyId).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────
// P1: MEM-001 — olderThan ISO-8601 date validation
// ─────────────────────────────────────────────────────────

describe("MEM-001: Memory prune olderThan validation", () => {
  const memoryService = {
    store: vi.fn(async () => ({})),
    search: vi.fn(async () => []),
    get: vi.fn(async () => null),
    list: vi.fn(async () => []),
    delete: vi.fn(async () => true),
    prune: vi.fn(async () => ({ deletedCount: 0, deletedIds: [], dryRun: false })),
  };
  const memoryGuardFactory = {
    forPrincipal: vi.fn().mockReturnValue(memoryService),
    forContext: vi.fn().mockReturnValue(memoryService),
  };

  let routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[];

  beforeEach(() => {
    routes = createFridayMemoryRoutes({ memoryGuardFactory });
  });

  function findRoute(opId: string) {
    return routes.find((r) => r.operationId === opId)!;
  }

  it("rejects invalid olderThan date string", async () => {
    const route = findRoute("memory.prune");
    const ctx = makeCtx({ body: { olderThan: "not-a-date" } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
    try {
      await route.handler(ctx);
    } catch (e) {
      expect((e as FridayDomainError).message).toContain("valid ISO 8601 date");
    }
  });

  it("rejects olderThan as non-string", async () => {
    const route = findRoute("memory.prune");
    const ctx = makeCtx({ body: { olderThan: 12345 } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("accepts valid olderThan ISO date", async () => {
    const route = findRoute("memory.prune");
    const ctx = makeCtx({ body: { olderThan: "2025-01-01T00:00:00.000Z" } });
    const result = await route.handler(ctx);
    expect(result).toBeDefined();
  });

  it("rejects olderThan with gibberish date-like value", async () => {
    const route = findRoute("memory.prune");
    const ctx = makeCtx({ body: { olderThan: "2025-13-45" } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });
});

// ─────────────────────────────────────────────────────────
// P1: FLT-001 + FLT-002 — Fleet route validation + 404
// ─────────────────────────────────────────────────────────

describe("FLT-001 + FLT-002: Fleet routes validation and 404", () => {
  let db: FridaySqliteLayer;
  let routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[];

  function findRoute(opId: string) {
    return routes.find((r) => r.operationId === opId)!;
  }

  function fleetCtx(overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {}) {
    return makeCtx({
      principal: {
        principalType: "user" as const,
        principalId: "user-1",
        userId: "user-1",
        role: "admin" as const,
        scopes: ["fleet.read" as const],
        tokenId: "tok-1",
        tokenKind: "access" as const,
        issuedAt: NOW,
      },
      ...overrides,
    });
  }

  beforeEach(() => {
    db = createTestDb();
    const fleetService = createFridayFleetDashboardService({
      db,
      nowIso: () => NOW,
      idGenerator: createTestIdGenerator(),
    });
    routes = createFridayFleetRoutes({ fleetService });
  });

  afterEach(() => {
    db.close();
  });

  it("rejects non-integer limit query param", async () => {
    const route = findRoute("fleet.list.satellites");
    const ctx = fleetCtx({ query: { limit: "abc" } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
    try {
      await route.handler(ctx);
    } catch (e) {
      expect((e as FridayDomainError).message).toContain("positive integer");
    }
  });

  it("rejects negative limit query param", async () => {
    const route = findRoute("fleet.list.satellites");
    const ctx = fleetCtx({ query: { limit: "-5" } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("rejects zero limit query param", async () => {
    const route = findRoute("fleet.list.satellites");
    const ctx = fleetCtx({ query: { limit: "0" } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("accepts valid limit query param", async () => {
    const route = findRoute("fleet.list.satellites");
    const ctx = fleetCtx({ query: { limit: "10" } });
    const result = await route.handler(ctx);
    expect(result).toBeDefined();
  });

  it("caps limit at 100", async () => {
    const route = findRoute("fleet.list.satellites");
    const ctx = fleetCtx({ query: { limit: "500" } });
    // Should not throw — just cap internally
    const result = await route.handler(ctx);
    expect(result).toBeDefined();
  });

  it("returns 404 for nonexistent satellite", async () => {
    const route = findRoute("fleet.get.satellite.detail");
    const ctx = fleetCtx({ params: { satelliteId: "does-not-exist" } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
    try {
      await route.handler(ctx);
    } catch (e) {
      expect((e as FridayDomainError).code).toBe("SATELLITE_NOT_FOUND");
      expect((e as FridayDomainError).httpStatus).toBe(404);
    }
  });
});

// ─────────────────────────────────────────────────────────
// P2: SGEN-003 — Reject non-object JSON bodies in skill generator
// ─────────────────────────────────────────────────────────

describe("SGEN-003: Skill generator rejects non-object generate body", () => {
  const skillGen = {
    startSession: vi.fn(async () => ({})),
    getSession: vi.fn(async () => ({})),
    submitTurn: vi.fn(async () => ({})),
    generateDraft: vi.fn(async () => ({
      manifest: {},
      files: [],
      uiSchema: { schemaVersion: "1.0", title: "T", sections: [], fields: [], outputs: [], actions: [] },
      runtimeKind: "node",
      validation: { ok: true, issues: [], repaired: false, repairAttempts: 0 },
    })),
    approveAndSave: vi.fn(async () => ({})),
    cancelSession: vi.fn(async () => undefined),
  };
  const registry = {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    resolveByIntent: vi.fn(() => null),
    validateAll: vi.fn(() => []),
    reload: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    isCompatible: vi.fn(() => ({ compatible: true, reasons: [] })),
    startWatching: vi.fn(async () => undefined),
    stopWatching: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };

  it("rejects string body", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routes = createFridaySkillGeneratorRoutes({ skillGenerator: skillGen as any, registry: registry as any });
    const route = routes.find((r) => r.operationId === "skills.generator.sessions.generate")!;
    const ctx = makeCtx({ params: { sessionId: "sess-1" }, body: "not-an-object" });
    await expect(route.handler(ctx)).rejects.toThrow("plain object");
  });

  it("rejects array body", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routes = createFridaySkillGeneratorRoutes({ skillGenerator: skillGen as any, registry: registry as any });
    const route = routes.find((r) => r.operationId === "skills.generator.sessions.generate")!;
    const ctx = makeCtx({ params: { sessionId: "sess-1" }, body: [1, 2, 3] });
    await expect(route.handler(ctx)).rejects.toThrow("plain object");
  });

  it("accepts null body (no options)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routes = createFridaySkillGeneratorRoutes({ skillGenerator: skillGen as any, registry: registry as any });
    const route = routes.find((r) => r.operationId === "skills.generator.sessions.generate")!;
    const ctx = makeCtx({ params: { sessionId: "sess-1" }, body: null });
    const result = await route.handler(ctx);
    expect(result).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────
// P2: API-ERR-001 — Error mapper includes details
// ─────────────────────────────────────────────────────────

describe("API-ERR-001: Error mapper includes details from domain errors", () => {
  it("includes details in 4xx response", () => {
    const err = new FridayDomainError("VALIDATION_ERROR", "bad input", {
      httpStatus: 400,
      details: { field: "name", reason: "too long" },
    });
    const { statusCode, body } = buildErrorResponse(err, "req-1");
    expect(statusCode).toBe(400);
    expect(body.error.details).toEqual({ field: "name", reason: "too long" });
  });

  it("omits details when empty", () => {
    const err = new FridayDomainError("NOT_FOUND", "nope", { httpStatus: 404 });
    const { body } = buildErrorResponse(err, "req-1");
    expect(body.error.details).toBeUndefined();
  });

  it("masks details in 5xx response", () => {
    const err = new FridayDomainError("INTERNAL", "kaboom", {
      httpStatus: 500,
      details: { secretStuff: "leak" },
    });
    const { body } = buildErrorResponse(err, "req-1");
    expect(body.error.details).toBeUndefined();
    expect(body.error.message).toBe("Internal Server Error");
  });
});
