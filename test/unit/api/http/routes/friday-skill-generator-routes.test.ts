import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFridaySkillGeneratorRoutes } from "#api";
import {
  createFridaySkillGeneratorStageMutatingActionRequest,
  type FridaySkillGeneratorService,
} from "#skills/generator";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
} from "../../../../../src/security/friday-mutating-action-gate.js";
import {
  FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
  FRIDAY_SKILL_PYTHON_BIN_ENV,
  type FridaySkillRegistry,
  type FridayRegisteredSkill,
} from "#skills";
import type { FridayHttpContext } from "#api";
import type { SkillManifestV2 } from "#skills";
import type { FridaySkillGenerationTurnResponse } from "#skills/generator";

const NOW = "2026-02-17T10:00:00.000Z";
const PRINCIPAL = {
  principalType: "user" as const,
  principalId: "user-1",
  scopes: ["skill.write" as const],
  tokenId: "token-1",
  tokenKind: "access" as const,
  issuedAt: NOW,
};

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
        content: "#!/usr/bin/env bash\nprintf '{\"result\":\"OK-MARKER\"}'\n",
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
          explicitTest: {
            ok: true,
            executable: true,
            issues: [],
            durationMs: 12,
            testedAt: NOW,
          },
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
    recordExplicitTestResult: vi.fn(async () => undefined),
    getQaVerdict: vi.fn(async () => null),
    getHarnessSummary: vi.fn(async () => null),
    approveAndSave: vi.fn(async () => ({
      sessionId: "sess-1",
      skillId: "test-skill",
      skillDir: "/tmp/test/skill-candidates/test-skill/files",
      candidateId: "test-skill-1.0.0-candidate",
      candidateDir: "/tmp/test/skill-candidates/test-skill",
      savedFiles: ["skill.manifest.json", "index.mjs"],
      registryRefreshed: false,
      promotionStage: "candidate_staged" as const,
      candidateManifestTags: ["starter.cli", "generated.candidate"],
      promotedManifestTags: [],
      evidence: {
        sessionId: "sess-1",
        validationSummary: {
          ok: true,
          repaired: false,
          repairAttempts: 0,
          issueCount: 0,
        },
        repairSummary: {
          attempted: false,
          attempts: 0,
        },
        executableTestSummary: {
          ok: true,
          executable: true,
          issues: [],
          durationMs: 12,
          testedAt: NOW,
        },
        approvalReadiness: {
          ready: true,
          reason: "Draft is ready",
        },
        stagedCandidateIdentity: {
          skillId: "test-skill",
          candidateId: "test-skill-1.0.0-candidate",
          candidateDir: "/tmp/test/skill-candidates/test-skill",
          filesDir: "/tmp/test/skill-candidates/test-skill/files",
        },
      },
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
    const canonicalMutationGate = createFridayMutatingActionGate({
      nowIso: () => NOW,
      ticketIdGenerator: () => "ticket-1",
    });
    const routes = createFridaySkillGeneratorRoutes({
      skillGenerator: generatorService,
      registry,
      canonicalMutationGate,
    });
    return { routes, generatorService, registry };
  }

  function withCanonicalApproval(body: {
    idempotencyKey?: string;
    planDigest?: string;
  } = {}) {
    const session = makeMockSession().session;
    const draft = makeMockDraft();
    const request = createFridaySkillGeneratorStageMutatingActionRequest({
      session: {
        ...session,
        draftSkillId: "test-skill",
        status: "ready_for_review",
      },
      draft,
      actor: {
        kind: PRINCIPAL.principalType,
        id: PRINCIPAL.principalId,
        principalId: PRINCIPAL.principalId,
      },
      surface: "api:/v1/skills/generator/sessions/:sessionId/approve",
      idempotencyKey: body.idempotencyKey,
      planDigest: body.planDigest,
    });
    return {
      ...body,
      canonicalApproval: {
        decision: "approved" as const,
        approvalId: "approval-1",
        decidedByPrincipalId: PRINCIPAL.principalId,
        actionDigest: createFridayMutatingActionDigest(request),
        expiresAt: "2026-02-17T11:00:00.000Z",
      },
    };
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
          principal: { userId: "user-1", principalId: "user-1", tenantId: "tenant-1" },
        }),
      );

      expect(generatorService.startSession).toHaveBeenCalledOnce();
      expect(generatorService.startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          tenantContext: expect.objectContaining({
            userId: "user-1",
            hubId: "tenant-1",
            channelKind: "discord",
          }),
        }),
      );
      expect(result).toHaveProperty("session");
      expect(result).toHaveProperty("mode", "clarification_required");
    });

    it("rejects a userId that does not match the authenticated principal", async () => {
      const { routes, generatorService } = createRoutes();
      const route = routes.find((r) => r.operationId === "skills.generator.sessions.create")!;

      await expect(
        route.handler(
          makeCtx({
            body: { goal: "Build a timer", userId: "victim-999", channel: "discord" },
            principal: { userId: "admin-001", principalId: "admin-001", tenantId: "tenant-1" },
          }),
        ),
      ).rejects.toThrow("userId must match the authenticated principal");

      expect(generatorService.startSession).not.toHaveBeenCalled();
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
    it("requires canonical approval before staging the generated skill candidate", async () => {
      const { routes, generatorService } = createRoutes();
      const route = routes.find(
        (r) => r.operationId === "skills.generator.sessions.approve",
      )!;

      await expect(
        route.handler(
          makeCtx({
            params: { sessionId: "sess-1" },
            principal: PRINCIPAL,
          }),
        ),
      ).rejects.toThrow("requires canonical approval");
      expect(generatorService.approveAndSave).not.toHaveBeenCalled();
    });

    it("calls approveAndSave with a canonical candidate staging ticket", async () => {
      const { routes, generatorService } = createRoutes();
      const route = routes.find(
        (r) => r.operationId === "skills.generator.sessions.approve",
      )!;

      const result = await route.handler(
        makeCtx({
          params: { sessionId: "sess-1" },
          principal: PRINCIPAL,
          body: withCanonicalApproval({ idempotencyKey: "approve-1" }),
        }),
      ) as {
        skillId: string;
        candidateId: string;
        promotionStage: string;
        candidateManifestTags: string[];
        promotedManifestTags: string[];
      };

      expect(generatorService.approveAndSave).toHaveBeenCalledWith("sess-1", {
        canonicalApprovalTicket: expect.objectContaining({
          action: "skills.import.stage_candidate",
          approvalId: "approval-1",
          ticketId: "ticket-1",
        }),
      });
      expect(result.skillId).toBe("test-skill");
      expect(result.candidateId).toBe("test-skill-1.0.0-candidate");
      expect(result.promotionStage).toBe("candidate_staged");
      expect(result.candidateManifestTags).toEqual(["starter.cli", "generated.candidate"]);
      expect(result.promotedManifestTags).toEqual([]);
    });
  });

  describe("POST /v1/skills/generator/sessions/:sessionId/test", () => {
    it("runs the explicit draft self-test", async () => {
      const { routes, generatorService } = createRoutes();
      const route = routes.find(
        (r) => r.operationId === "skills.generator.sessions.test",
      )!;
      generatorService.getSession = vi.fn(async (sessionId: string) => {
        if (sessionId === "not-found") return null;
        return {
          session: {
            ...makeMockSession().session,
            sessionId,
            draftSkillId: "test-skill",
            status: "ready_for_review",
            goal: 'Build a timer and must output the exact string "OK-MARKER"',
          },
          turns: [
            {
              turnId: "t-1",
              sessionId,
              role: "user" as const,
              content: 'Build a timer and must output the exact string "OK-MARKER"',
              createdAt: NOW,
            },
          ],
          draft: makeMockDraft(),
        };
      });

      const result = await route.handler(
        makeCtx({ params: { sessionId: "sess-1" } }),
      ) as { test: { ok: boolean; executable: boolean } };

      expect(result.test.ok).toBe(true);
      expect(result.test.executable).toBe(true);
      expect(generatorService.recordExplicitTestResult).toHaveBeenCalledWith(
        "sess-1",
        expect.objectContaining({
          ok: true,
          executable: true,
        }),
      );
    });

    it("runs shell draft self-tests that require the local shell capability", async () => {
      const { routes, generatorService } = createRoutes();
      const route = routes.find(
        (r) => r.operationId === "skills.generator.sessions.test",
      )!;
      generatorService.getSession = vi.fn(async (sessionId: string) => {
        if (sessionId === "not-found") return null;
        const draft = makeMockDraft();
        return {
          session: {
            ...makeMockSession().session,
            sessionId,
            draftSkillId: "test-skill",
            status: "ready_for_review",
            goal: 'Build a timer and must output the exact string "OK-MARKER"',
          },
          turns: [],
          draft: {
            ...draft,
            manifest: {
              ...draft.manifest,
              executionTargets: {
                ...draft.manifest.executionTargets,
                requiredCapabilities: ["shell"],
              },
            },
          },
        };
      });

      const result = await route.handler(
        makeCtx({ params: { sessionId: "sess-1" } }),
      ) as { test: { ok: boolean; executable: boolean } };

      expect(result.test.ok).toBe(true);
      expect(result.test.executable).toBe(true);
    });

    it("fails closed when the extracted contract has no required output markers", async () => {
      const { routes, generatorService } = createRoutes();
      const route = routes.find(
        (r) => r.operationId === "skills.generator.sessions.test",
      )!;

      const result = await route.handler(
        makeCtx({ params: { sessionId: "sess-1" } }),
      ) as {
        test: {
          ok: boolean;
          executable: boolean;
          behavioralCheck?: { attempted: boolean; satisfied: boolean; reason?: string };
          issues: Array<{ code: string }>;
        };
      };

      expect(result.test.ok).toBe(false);
      expect(result.test.executable).toBe(false);
      expect(result.test.behavioralCheck).toMatchObject({
        attempted: false,
        satisfied: false,
      });
      expect(result.test.behavioralCheck?.reason).toContain("required output marker");
      expect(result.test.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "BEHAVIOR_TEST_MARKERS_REQUIRED" }),
        ]),
      );
      expect(generatorService.recordExplicitTestResult).toHaveBeenCalledWith(
        "sess-1",
        expect.objectContaining({
          ok: false,
          executable: false,
        }),
      );
    });

    it("rejects draft self-test files that escape the temporary test root", async () => {
      const { routes, generatorService } = createRoutes();
      const route = routes.find(
        (r) => r.operationId === "skills.generator.sessions.test",
      )!;
      generatorService.getSession = vi.fn(async (sessionId: string) => {
        const draft = makeMockDraft();
        return {
          session: {
            ...makeMockSession().session,
            sessionId,
            draftSkillId: "test-skill",
            status: "ready_for_review",
            goal: 'Build a timer and must output the exact string "OK-MARKER"',
          },
          turns: [],
          draft: {
            ...draft,
            files: [
              ...draft.files,
              {
                path: "../escape.txt",
                language: "text" as const,
                content: "outside",
              },
            ],
          },
        };
      });

      await expect(
        route.handler(makeCtx({ params: { sessionId: "sess-1" } })),
      ).rejects.toThrow("Path must not contain");
      expect(generatorService.recordExplicitTestResult).not.toHaveBeenCalled();
    });

    it("returns CAPABILITY_DISABLED for node-runtime draft self-tests when the gate is off", async () => {
      const previousGate = process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
      delete process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
      try {
        const generatorService = makeMockGeneratorService();
        generatorService.getSession = vi.fn(async (sessionId: string) => {
          if (sessionId === "not-found") return null;
          const draft = makeMockDraft();
          return {
            session: {
              ...makeMockSession().session,
              sessionId,
              draftSkillId: "test-skill",
              status: "ready_for_review",
              goal: 'Build a timer and must output the exact string "OK-MARKER"',
            },
            turns: [],
            draft: {
              ...draft,
              runtimeKind: "node" as const,
              manifest: {
                ...draft.manifest,
                runtime: {
                  kind: "node",
                  entrypoint: "index.mjs",
                  minHubVersion: "1.0.0",
                  apiVersion: "1",
                  timeoutMsDefault: 30_000,
                },
              },
              files: [
                {
                  path: "index.mjs",
                  language: "javascript" as const,
                  executable: false,
                  content: "export async function execute() { return { result: 'ok' }; }",
                },
              ],
            },
          };
        });

        const routes = createFridaySkillGeneratorRoutes({
          skillGenerator: generatorService,
          registry: makeMockRegistry(),
        });
        const route = routes.find(
          (r) => r.operationId === "skills.generator.sessions.test",
        )!;

        await expect(
          route.handler(makeCtx({ params: { sessionId: "sess-1" } })),
        ).rejects.toMatchObject({
          code: "CAPABILITY_DISABLED",
          httpStatus: 501,
        });
        expect(generatorService.recordExplicitTestResult).not.toHaveBeenCalled();
      } finally {
        if (previousGate === undefined) {
          delete process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
        } else {
          process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV] = previousGate;
        }
      }
    });

    it("runs python draft self-tests through the configured interpreter", async () => {
      const fs = await import("node:fs/promises");
      const tempDir = await fs.mkdtemp(join(tmpdir(), "friday-generator-python-"));
      const previousPythonBin = process.env[FRIDAY_SKILL_PYTHON_BIN_ENV];

      try {
        process.env[FRIDAY_SKILL_PYTHON_BIN_ENV] = process.execPath;

        const generatorService = makeMockGeneratorService();
        generatorService.getSession = vi.fn(async (sessionId: string) => {
          if (sessionId === "not-found") return null;
          const draft = makeMockDraft();
          return {
            session: {
              ...makeMockSession().session,
              sessionId,
              draftSkillId: "test-skill",
              status: "ready_for_review",
              goal: 'Build a timer and must output the exact string "OK-MARKER"',
            },
            turns: [],
            draft: {
              ...draft,
              runtimeKind: "python" as const,
              manifest: {
                ...draft.manifest,
                runtime: {
                  kind: "python",
                  entrypoint: "index.py",
                  minHubVersion: "1.0.0",
                  apiVersion: "1",
                  timeoutMsDefault: 30_000,
                },
              },
              files: [
                {
                  path: "index.py",
                  language: "python" as const,
                  executable: false,
                  content: "process.stdout.write('{\"result\":\"OK-MARKER\"}')\n",
                },
              ],
            },
          };
        });

        const routes = createFridaySkillGeneratorRoutes({
          skillGenerator: generatorService,
          registry: makeMockRegistry(),
        });
        const route = routes.find(
          (r) => r.operationId === "skills.generator.sessions.test",
        )!;

        const result = await route.handler(
          makeCtx({ params: { sessionId: "sess-1" } }),
        ) as { test: { ok: boolean; executable: boolean } };

        expect(result.test.ok).toBe(true);
        expect(result.test.executable).toBe(true);
      } finally {
        if (previousPythonBin === undefined) {
          delete process.env[FRIDAY_SKILL_PYTHON_BIN_ENV];
        } else {
          process.env[FRIDAY_SKILL_PYTHON_BIN_ENV] = previousPythonBin;
        }
        await fs.rm(tempDir, { recursive: true, force: true });
      }
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

    it("keeps approval readiness false when the recorded self-test was not executable", async () => {
      const { routes, generatorService } = createRoutes();
      const route = routes.find(
        (r) => r.operationId === "skills.generator.sessions.evidence.get",
      )!;
      generatorService.getSession = vi.fn(async (sessionId: string) => {
        if (sessionId === "not-found") return null;
        return {
          session: {
            ...makeMockSession().session,
            sessionId,
            draftSkillId: "test-skill",
            status: "ready_for_review",
            explicitTest: {
              ok: true,
              executable: false,
              issues: [],
              durationMs: 5,
              testedAt: NOW,
            },
          },
          turns: [],
          draft: makeMockDraft(),
        };
      });

      const result = await route.handler(
        makeCtx({ params: { sessionId: "sess-1" } }),
      ) as { evidence: { approvalReadiness: { ready: boolean; reason: string } } };

      expect(result.evidence.approvalReadiness.ready).toBe(false);
      expect(result.evidence.approvalReadiness.reason).toContain("did not execute runtime behavior");
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
