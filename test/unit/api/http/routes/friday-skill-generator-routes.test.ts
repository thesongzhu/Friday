import { describe, it, expect, vi } from "vitest";
import { createFridaySkillGeneratorRoutes } from "#api";
import type { FridaySkillGeneratorService } from "#skills/generator";
import type { FridaySkillRegistry, FridayRegisteredSkill } from "#skills";
import type { FridayHttpContext } from "#api";
import type { SkillManifestV2 } from "#skills";
import type { FridaySkillGenerationTurnResponse } from "#skills/generator";

const NOW = "2026-02-17T10:00:00.000Z";

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

function makeMockSession(): FridaySkillGenerationTurnResponse {
  return {
    session: {
      sessionId: "sess-1",
      userId: "user-1",
      channel: "discord",
      status: "needs_clarification",
      goal: "Build a timer",
      specSummary: "",
      openQuestions: ["How long?"],
      decisions: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
    mode: "clarification_required",
    questions: ["How long?"],
  };
}

function makeMockDraft() {
  return {
    manifest: {
      schemaVersion: "2.0",
      id: "test-skill",
      name: "Test Skill",
      description: "A generated test skill",
      version: "1.0.0",
      kind: "conversation",
      category: "utility",
      author: { name: "Friday" },
      tags: [],
      runtime: {
        kind: "shell",
        entrypoint: "run.sh",
        minHubVersion: "1.0.0",
        apiVersion: "1",
        timeoutMsDefault: 30_000,
      },
      triggers: {
        intents: [],
        phrases: [],
        channels: ["*"],
      },
      invocation: {
        userInvocable: true,
        modelInvocable: true,
        priority: 50,
        modes: ["intent"],
      },
      requirements: {
        bins: [],
        env: [],
        config: [],
        os: ["darwin", "linux", "win32"],
      },
      inputs: [],
      outputs: [
        {
          key: "result",
          type: "string",
          description: "Result text",
        },
      ],
      permissions: {
        grants: [],
        promptOn: [],
      },
      schemas: null,
      flow: null,
      executionTargets: {
        allowedSatelliteTypes: ["desktop", "cloud-vm"],
        requiredCapabilities: [],
      },
      telemetry: {
        events: [],
      },
    } as SkillManifestV2,
    files: [
      {
        path: "run.sh",
        language: "bash" as const,
        executable: true,
        content: "#!/usr/bin/env bash\nprintf '{\"result\":\"ok\"}'\n",
      },
    ],
    uiSchema: {
      schemaVersion: "1.0" as const,
      title: "Test Skill",
      sections: [],
      fields: [],
      outputs: [],
      actions: [{ id: "run" as const, label: "Run", style: "primary" as const }],
    },
    runtimeKind: "shell" as const,
    validation: { ok: true, issues: [], repaired: false, repairAttempts: 0 },
  };
}

function makeMockGeneratorService(): FridaySkillGeneratorService {
  return {
    startSession: vi.fn(async () => makeMockSession()),
    submitTurn: vi.fn(async () => makeMockSession()),
    getSession: vi.fn(async (sessionId: string) => {
      if (sessionId === "not-found") return null;
      return {
        session: {
          ...makeMockSession().session,
          draftSkillId: "test-skill",
          status: "ready_for_review",
        },
        turns: [
          {
            turnId: "t-1",
            sessionId,
            role: "user" as const,
            content: "Build a timer",
            createdAt: NOW,
          },
        ],
        draft: makeMockDraft(),
      };
    }),
    generateDraft: vi.fn(async () => makeMockDraft()),
    approveAndSave: vi.fn(async () => ({
      sessionId: "sess-1",
      skillId: "test-skill",
      skillDir: "/tmp/test/skills/test-skill",
      savedFiles: ["skill.manifest.json", "index.mjs"],
      registryRefreshed: true,
    })),
    cancelSession: vi.fn(async () => undefined),
  };
}

function makeMockRegistry(): FridaySkillRegistry {
  return {
    list: vi.fn(() => []),
    get: vi.fn((skillId: string) => {
      if (skillId === "existing-skill") {
        return {
          manifest: { id: "existing-skill" } as SkillManifestV2,
          skillDir: "/tmp/test/skills/existing-skill",
        } as FridayRegisteredSkill;
      }
      return null;
    }),
    resolveByIntent: vi.fn(() => null),
    validateAll: vi.fn(() => []),
    reload: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    isCompatible: vi.fn(() => ({ compatible: true, reasons: [] })),
    startWatching: vi.fn(async () => undefined),
    stopWatching: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe("FridaySkillGeneratorRoutes", () => {
  function createRoutes() {
    const generatorService = makeMockGeneratorService();
    const registry = makeMockRegistry();
    const routes = createFridaySkillGeneratorRoutes({
      skillGenerator: generatorService,
      registry,
    });
    return { routes, generatorService, registry };
  }

  it("creates 7 route definitions", () => {
    const { routes } = createRoutes();
    expect(routes).toHaveLength(9);
  });

  it("creates routes with correct operation IDs", () => {
    const { routes } = createRoutes();
    const opIds = routes.map((r) => r.operationId);
    expect(opIds).toContain("skills.generator.sessions.create");
    expect(opIds).toContain("skills.generator.sessions.get");
    expect(opIds).toContain("skills.generator.sessions.messages.create");
    expect(opIds).toContain("skills.generator.sessions.generate");
    expect(opIds).toContain("skills.generator.sessions.approve");
    expect(opIds).toContain("skills.generator.sessions.test");
    expect(opIds).toContain("skills.generator.sessions.evidence.get");
    expect(opIds).toContain("skills.generator.sessions.cancel");
    expect(opIds).toContain("skills.ui.get");
  });

  it("creates routes with correct HTTP methods", () => {
    const { routes } = createRoutes();
    const find = (opId: string) => routes.find((r) => r.operationId === opId);

    expect(find("skills.generator.sessions.create")!.method).toBe("POST");
    expect(find("skills.generator.sessions.get")!.method).toBe("GET");
    expect(find("skills.generator.sessions.messages.create")!.method).toBe("POST");
    expect(find("skills.generator.sessions.generate")!.method).toBe("POST");
    expect(find("skills.generator.sessions.approve")!.method).toBe("POST");
    expect(find("skills.generator.sessions.test")!.method).toBe("POST");
    expect(find("skills.generator.sessions.evidence.get")!.method).toBe("GET");
    expect(find("skills.generator.sessions.cancel")!.method).toBe("DELETE");
    expect(find("skills.ui.get")!.method).toBe("GET");
  });

  describe("POST /v1/skills/generator/sessions", () => {
    it("validates missing body", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.generator.sessions.create")!;

      await expect(route.handler(makeCtx({ body: null }))).rejects.toThrow(
        "Request body is required",
      );
    });

    it("validates missing goal", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.generator.sessions.create")!;

      await expect(
        route.handler(makeCtx({ body: { userId: "u1", channel: "discord" } })),
      ).rejects.toThrow("goal is required");
    });

    it("validates missing userId", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.generator.sessions.create")!;

      await expect(
        route.handler(makeCtx({ body: { goal: "test", channel: "discord" } })),
      ).rejects.toThrow("userId is required");
    });

    it("calls startSession with valid body", async () => {
      const { routes, generatorService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.generator.sessions.create")!;

      const result = await route.handler(
        makeCtx({
          body: { goal: "Build a timer", userId: "user-1", channel: "discord" },
        }),
      );

      expect(generatorService.startSession).toHaveBeenCalledOnce();
      expect(result).toHaveProperty("session");
      expect(result).toHaveProperty("mode", "clarification_required");
    });
  });

  describe("GET /v1/skills/generator/sessions/:sessionId", () => {
    it("returns 404 for non-existent session", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.generator.sessions.get")!;

      await expect(
        route.handler(makeCtx({ params: { sessionId: "not-found" } })),
      ).rejects.toThrow("Generation session not found");
    });

    it("returns session with turns", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.generator.sessions.get")!;

      const result = await route.handler(
        makeCtx({ params: { sessionId: "sess-1" } }),
      ) as { session: unknown; turns: unknown[] };

      expect(result.session).toBeDefined();
      expect(result.turns).toHaveLength(1);
    });
  });

  describe("POST /v1/skills/generator/sessions/:sessionId/messages", () => {
    it("validates missing message", async () => {
      const { routes } = createRoutes();
      const route = routes.find(
        (r) => r.operationId === "skills.generator.sessions.messages.create",
      )!;

      await expect(
        route.handler(
          makeCtx({ params: { sessionId: "sess-1" }, body: {} }),
        ),
      ).rejects.toThrow("message is required");
    });

    it("calls submitTurn with valid body", async () => {
      const { routes, generatorService } = createRoutes();
      const route = routes.find(
        (r) => r.operationId === "skills.generator.sessions.messages.create",
      )!;

      const result = await route.handler(
        makeCtx({
          params: { sessionId: "sess-1" },
          body: { message: "JSON format please" },
        }),
      );

      expect(generatorService.submitTurn).toHaveBeenCalledWith("sess-1", {
        message: "JSON format please",
        requestedModel: undefined,
      });
      expect(result).toHaveProperty("mode");
    });
  });

  describe("POST /v1/skills/generator/sessions/:sessionId/generate", () => {
    it("calls generateDraft", async () => {
      const { routes, generatorService } = createRoutes();
      const route = routes.find(
        (r) => r.operationId === "skills.generator.sessions.generate",
      )!;

      const result = await route.handler(
        makeCtx({ params: { sessionId: "sess-1" }, body: {} }),
      ) as { draft: unknown };

      expect(generatorService.generateDraft).toHaveBeenCalledWith("sess-1", undefined);
      expect(result.draft).toBeDefined();
    });

    it("passes requestedModel when provided", async () => {
      const { routes, generatorService } = createRoutes();
      const route = routes.find(
        (r) => r.operationId === "skills.generator.sessions.generate",
      )!;

      await route.handler(
        makeCtx({
          params: { sessionId: "sess-1" },
          body: { requestedModel: "gpt-4o" },
        }),
      );

      expect(generatorService.generateDraft).toHaveBeenCalledWith("sess-1", "gpt-4o");
    });
  });

  describe("POST /v1/skills/generator/sessions/:sessionId/approve", () => {
    it("calls approveAndSave", async () => {
      const { routes, generatorService } = createRoutes();
      const route = routes.find(
        (r) => r.operationId === "skills.generator.sessions.approve",
      )!;

      const result = await route.handler(
        makeCtx({ params: { sessionId: "sess-1" } }),
      ) as { skillId: string };

      expect(generatorService.approveAndSave).toHaveBeenCalledWith("sess-1");
      expect(result.skillId).toBe("test-skill");
    });
  });

  describe("POST /v1/skills/generator/sessions/:sessionId/test", () => {
    it("runs the explicit draft self-test", async () => {
      const { routes } = createRoutes();
      const route = routes.find(
        (r) => r.operationId === "skills.generator.sessions.test",
      )!;

      const result = await route.handler(
        makeCtx({ params: { sessionId: "sess-1" } }),
      ) as { test: { ok: boolean; executable: boolean } };

      expect(result.test.ok).toBe(true);
      expect(result.test.executable).toBe(true);
    });
  });

  describe("GET /v1/skills/generator/sessions/:sessionId/evidence", () => {
    it("returns validation, test, and approval readiness evidence", async () => {
      const { routes } = createRoutes();
      const route = routes.find(
        (r) => r.operationId === "skills.generator.sessions.evidence.get",
      )!;

      const result = await route.handler(
        makeCtx({ params: { sessionId: "sess-1" } }),
      ) as { evidence: { approvalReadiness: { ready: boolean }; validationSummary: { ok: boolean } } };

      expect(result.evidence.validationSummary.ok).toBe(true);
      expect(result.evidence.approvalReadiness.ready).toBe(true);
    });
  });

  describe("DELETE /v1/skills/generator/sessions/:sessionId", () => {
    it("calls cancelSession", async () => {
      const { routes, generatorService } = createRoutes();
      const route = routes.find(
        (r) => r.operationId === "skills.generator.sessions.cancel",
      )!;

      const result = await route.handler(
        makeCtx({ params: { sessionId: "sess-1" } }),
      ) as { cancelled: boolean };

      expect(generatorService.cancelSession).toHaveBeenCalledWith("sess-1");
      expect(result.cancelled).toBe(true);
    });
  });

  describe("GET /v1/skills/:skillId/ui", () => {
    it("returns 404 for unknown skill", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.ui.get")!;

      await expect(
        route.handler(makeCtx({ params: { skillId: "unknown" } })),
      ).rejects.toThrow("Skill 'unknown' not found");
    });

    it("returns 404 when skill.ui.json does not exist", async () => {
      const { routes } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.ui.get")!;

      // "existing-skill" is recognized by the mock registry but
      // /tmp/test/skills/existing-skill/skill.ui.json doesn't exist
      await expect(
        route.handler(makeCtx({ params: { skillId: "existing-skill" } })),
      ).rejects.toThrow("No UI schema found");
    });
  });
});
