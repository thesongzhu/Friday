import { afterEach, describe, it, expect, vi } from "vitest";

import { createFridayApiRuntime } from "#api";
import type { CreateFridayApiRuntimeDeps } from "#api";
import type { FridayProviderService } from "#providers";
import type { FridayWorkflowGeneratorService } from "#workflows";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";

const NOW = "2026-02-18T10:00:00.000Z";

// ─── Minimal mock deps for API runtime ───

const allocatedDbs: FridaySqliteLayer[] = [];

function makeMockProviderService(): FridayProviderService {
  return {
    listProviders: vi.fn(async () => []),
    getProvider: vi.fn(async () => null),
    createProvider: vi.fn(async () => ({} as never)),
    updateProvider: vi.fn(async () => ({} as never)),
    deleteProvider: vi.fn(async () => undefined),
    validateProvider: vi.fn(async () => ({ status: "ok" as const, checkedAt: NOW })),
    getRoutingConfig: vi.fn(async () => ({ defaultProviderId: "p-1", fallbackProviderIds: [] })),
    setRoutingConfig: vi.fn(async (input) => input),
    resolveRoute: vi.fn(async () => ({
      provider: { id: "p-1", kind: "openai" as const, name: "OpenAI", baseUrl: "https://api.openai.com", enabled: true, config: { api: "openai-completions" as const, authMode: "api-key" as const, keySource: { kind: "env-ref" as const, envVar: "OPENAI_API_KEY" }, supportedModels: ["gpt-4o"], validation: { status: "ok" as const, checkedAt: NOW } }, createdAt: NOW, updatedAt: NOW },
      model: "gpt-4o",
    })),
    runWithFallback: vi.fn(async () => ({} as never)),
  } as unknown as FridayProviderService;
}

function makeMockWorkflowGenerator(): FridayWorkflowGeneratorService {
  return {
    startSession: vi.fn(async () => ({} as never)),
    submitTurn: vi.fn(async () => ({} as never)),
    getSession: vi.fn(async () => null),
    generateDraft: vi.fn(async () => ({} as never)),
    approveAndSave: vi.fn(async () => ({} as never)),
    cancelSession: vi.fn(async () => undefined),
  };
}

function makeBaseDeps(): CreateFridayApiRuntimeDeps {
  const db = createTestDb();
  allocatedDbs.push(db);
  return {
    db,
    idGenerator: () => "id-1",
    nowIso: () => NOW,
    providerService: makeMockProviderService(),
    tokenSecret: "test-secret",
    computeChecksum: (content: string) => `checksum-${content.length}`,
    resolveSkill: () => null,
    invokeSkill: async () => ({}),
  };
}

// ─── Tests ───

describe("API Runtime — Workflow Generator Registration", () => {
  afterEach(() => {
    while (allocatedDbs.length > 0) {
      allocatedDbs.pop()!.close();
    }
  });

  it("registers generator routes when workflowGenerator is provided", () => {
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      workflowGenerator: makeMockWorkflowGenerator(),
    });

    const allRoutes = runtime.routes.getRoutes();
    const generatorRoutes = allRoutes.filter((r) =>
      r.operationId.startsWith("workflows.generator."),
    );

    expect(generatorRoutes.length).toBe(6);
  });

  it("does not register generator routes when workflowGenerator is omitted", () => {
    const runtime = createFridayApiRuntime(makeBaseDeps());

    const allRoutes = runtime.routes.getRoutes();
    const generatorRoutes = allRoutes.filter((r) =>
      r.operationId.startsWith("workflows.generator."),
    );

    expect(generatorRoutes).toHaveLength(0);
  });

  it("runtime exposes workflowGenerator when provided", () => {
    const wfGen = makeMockWorkflowGenerator();
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      workflowGenerator: wfGen,
    });

    expect(runtime.workflowGenerator).toBe(wfGen);
  });

  it("runtime workflowGenerator is undefined when not provided", () => {
    const runtime = createFridayApiRuntime(makeBaseDeps());
    expect(runtime.workflowGenerator).toBeUndefined();
  });
});
