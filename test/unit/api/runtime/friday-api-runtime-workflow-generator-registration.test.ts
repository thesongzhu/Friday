import { readFileSync } from "node:fs";

import { afterEach, describe, it, expect, vi } from "vitest";

import { createFridayApiRuntime } from "#api";
import type { CreateFridayApiRuntimeDeps } from "#api";
import type { FridayProviderService } from "#providers";
import type { FridayCompiledWorkflowGraphV2, FridayWorkflowGeneratorService } from "#workflows";
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

async function waitForWorkflowRunSettled(
  runtime: ReturnType<typeof createFridayApiRuntime>,
  runId: string,
): Promise<void> {
  await vi.waitFor(() => {
    const run = runtime.workflowExecution.getRun(runId);
    expect(run?.status).toMatch(/^(completed|failed|cancelled)$/u);
  });
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
    const generatorRouteIds = allRoutes
      .filter((r) => r.operationId.startsWith("workflows.generator."))
      .map((r) => r.operationId)
      .sort();

    expect(generatorRouteIds).toEqual([
      "workflows.generator.sessions.approve",
      "workflows.generator.sessions.cancel",
      "workflows.generator.sessions.create",
      "workflows.generator.sessions.evidence.get",
      "workflows.generator.sessions.generate",
      "workflows.generator.sessions.get",
      "workflows.generator.sessions.messages.create",
    ]);
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

  it("passes user rules context into fallback workflow runtime AI nodes", async () => {
    let idCounter = 0;
    const invokeSkill = vi.fn(async () => ({ text: "ok" }));
    const userRulesContextProvider = vi.fn().mockResolvedValue(
      "<friday-user-project-rules>Ask Alice before generating durable files.</friday-user-project-rules>",
    );
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      // TS-retirement method guard: this test exercises the fallback workflow
      // runtime's startRun, so opt the fallback into the test-oracle path.
      allowTestOnlyWorkflowRunExecution: true,
      idGenerator: () => `fallback-ai-id-${String(++idCounter)}`,
      invokeSkill,
      resolveSkill: () => ({ id: "ai-inference" }),
      userRulesContextProvider,
    });

    const workflow = runtime.workflowCrud.createWorkflow({
      slug: "fallback-ai-user-rules",
      name: "Fallback AI User Rules",
    });
    const graph: FridayCompiledWorkflowGraphV2 = {
      schemaVersion: "2.0",
      workflowId: workflow.id,
      workflowVersionId: "placeholder",
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: [
          { id: "trigger", type: "trigger", label: "Trigger", config: {} },
          {
            id: "ai1",
            type: "ai",
            label: "AI",
            config: { prompt: "Summarize launch notes", model: "test-model" },
          },
        ],
        edges: [{ id: "edge1", sourceNodeId: "trigger", targetNodeId: "ai1" }],
      },
      failurePolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
      checksum: "placeholder",
    };
    const version = runtime.workflowCrud.createVersion(workflow.id, graph);
    runtime.workflowCrud.publishVersion(workflow.id, version.versionNumber);

    const run = await runtime.workflowExecution.startRun({
      workflowId: workflow.id,
      workflowVersionId: version.id,
      triggerType: "manual",
    });
    await waitForWorkflowRunSettled(runtime, run.id);

    expect(userRulesContextProvider).toHaveBeenCalledWith({
      task: "Summarize launch notes",
      workflowId: workflow.id,
      runId: run.id,
      nodeId: "ai1",
      surface: "workflow_ai_node",
    });
    expect(invokeSkill).toHaveBeenCalledWith(
      "ai-inference",
      run.id,
      "ai1",
      expect.objectContaining({
        prompt: expect.stringContaining("Ask Alice before generating durable files."),
      }),
      expect.anything(),
    );
  });

  it("redacts workflow realtime payloads before the runtime publish sink", () => {
    const source = readFileSync(
      new URL("../../../../src/api/runtime/friday-api-runtime.ts", import.meta.url),
      "utf8",
    );
    const publishWorkflowRealtimeEvent = source.match(
      /const publishWorkflowRealtimeEvent = async \([\s\S]*?\n  \};/u,
    )?.[0];

    // SEC-EVENT-REDACTION-001 / FINDING 1: identifier VALUES are pseudonymized and
    // content is redacted BEFORE the publish sink, and the streamId is the opaque
    // (pseudonymized) form — no raw identifier bytes reach realtime_events.
    expect(publishWorkflowRealtimeEvent).toContain(
      "pseudonymizeEventIdentifiers(\n      normalizedPayload,",
    );
    expect(publishWorkflowRealtimeEvent).toContain("redactEventPayload(pseudonymizedPayload)");
    expect(publishWorkflowRealtimeEvent).toContain(
      "realtimePseudonymizer.streamId(rawStreamId)",
    );
    expect(publishWorkflowRealtimeEvent).toMatch(
      /eventBus\.publish\(\s*opaqueStreamId,\s*event as never,\s*redactedPayload as never,\s*\)/u,
    );
  });
});
