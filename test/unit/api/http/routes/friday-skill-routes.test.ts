import { describe, expect, it, vi } from "vitest";
import { FridayDomainError } from "#errors";
import { FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV } from "#skills";
import { createFridaySkillRoutes } from "../../../../../src/api/http/routes/friday-skill-routes.js";

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: {
      principalId: "user-1",
      principalType: "user",
      role: "admin",
      scopes: ["skill.read", "skill.write", "hub.admin"],
      tokenId: "token-1",
      tokenKind: "access",
      issuedAt: "2026-03-07T00:00:00.000Z",
    },
    requestId: "req-1",
    receivedAt: "2026-03-07T00:00:00.000Z",
    ...overrides,
  } as never;
}

function makeLifecycle() {
  return {
    listSkills: vi.fn(() => [
      {
        skillId: "skill.alpha",
        name: "Alpha",
        source: "local",
        origin: "managed",
        status: "installed",
        starter: false,
        tags: [],
        updateAvailable: false,
        managed: true,
        registryLoaded: true,
      },
    ]),
    listCatalog: vi.fn(() => ({ items: [], nextCursor: undefined, total: 0 })),
    getSkill: vi.fn((skillId: string) => ({
      skillId,
      name: "Alpha",
      source: "local",
      origin: "managed",
      status: "installed",
      starter: false,
      tags: [],
      updateAvailable: false,
      managed: true,
      registryLoaded: true,
      versions: [],
      installations: [],
    })),
    install: vi.fn(async (input) => ({
      skill: {
        skillId: input.skillId,
        name: "Alpha",
        source: "local",
        origin: "managed",
        status: "installed",
        starter: false,
        tags: [],
        updateAvailable: false,
        managed: true,
        registryLoaded: true,
        versions: [],
        installations: [],
      },
      installation: {
        installationIds: ["inst-1"],
        resolvedVersion: "1.0.0",
        verification: { integrityValid: true, signatureValid: true, checks: ["integrity:pass"] },
        trust: {
          total: 90,
          signature: 30,
          integrity: 30,
          keyPinning: 10,
          sourcePolicy: 10,
          publisher: 5,
          freshness: 5,
          reasons: [],
        },
      },
    })),
    update: vi.fn(async (input) => ({
      skill: {
        skillId: input.skillId,
        name: "Alpha",
        source: "local",
        origin: "managed",
        status: "installed",
        starter: false,
        tags: [],
        updateAvailable: false,
        managed: true,
        registryLoaded: true,
        versions: [],
        installations: [],
      },
      installation: {
        installationIds: ["inst-1"],
        resolvedVersion: "1.1.0",
        verification: { integrityValid: true, signatureValid: true, checks: ["integrity:pass"] },
        trust: {
          total: 92,
          signature: 30,
          integrity: 30,
          keyPinning: 10,
          sourcePolicy: 10,
          publisher: 7,
          freshness: 5,
          reasons: [],
        },
      },
      updated: true,
      previousVersion: "1.0.0",
    })),
    deleteSkill: vi.fn(async ({ skillId }: { skillId: string }) => ({ deleted: true, skillId })),
    verifySkill: vi.fn(async (input) => ({
      skillId: input.skillId,
      verifiedAt: "2026-03-07T00:00:00.000Z",
      ok: true,
      manifestVerdict: { ok: true, issues: [] },
      packageIntegrity: { available: true, ok: true },
      dependencyCheck: { ok: true, checkedBins: [], missingBins: [] },
      runtimeDryRun: { attempted: true, ok: true, executable: true, reason: "ok" },
      trustSummary: { verdict: "trusted", reasons: ["ok"] },
    })),
    validateManifest: vi.fn(() => ({ ok: true, issues: [] })),
  };
}

function makeExecutor() {
  return {
    execute: vi.fn(() => ({
      runId: "run-1",
      result: Promise.resolve({
        runId: "run-1",
        status: "completed",
        output: { result: "ok" },
        stdout: "{\"result\":\"ok\"}",
        stderr: "",
        durationMs: 12,
      }),
    })),
    cancel: vi.fn(),
  };
}

describe("createFridaySkillRoutes", () => {
  it("keeps GET /v1/skills backward compatible without lifecycle wiring", async () => {
    const routes = createFridaySkillRoutes({
      skillRegistry: {
        list: () => [{
          manifest: {
            id: "skill.alpha",
            name: "Alpha",
            version: "1.0.0",
            category: "utility",
            tags: [],
          },
          source: "local",
          origin: "workspace",
          status: "installed",
        } as never],
      } as never,
    });

    const route = routes.find((item) => item.operationId === "skills.list");
    const result = await route!.handler(makeCtx());
    expect(result).toHaveProperty("items.0.skillId", "skill.alpha");
    expect(result).toHaveProperty("items.0.id", "skill.alpha");
    expect(result).toHaveProperty("items.0.version", "1.0.0");
  });

  it("registers lifecycle routes when the lifecycle service is provided", () => {
    const routes = createFridaySkillRoutes({
      skillRegistry: { list: () => [] } as never,
      lifecycle: makeLifecycle() as never,
    });

    expect(routes.map((route) => route.operationId)).toEqual([
      "skills.list",
      "skills.catalog.list",
      "skills.get",
      "skills.install",
      "skills.update",
      "skills.delete",
      "skills.manifest.validate",
      "skills.verify",
      "skills.run",
    ]);
  });

  it("forwards install, update, delete, verify, and manifest validation to lifecycle service", async () => {
    const lifecycle = makeLifecycle();
    const routes = createFridaySkillRoutes({
      skillRegistry: { list: () => [] } as never,
      lifecycle: lifecycle as never,
    });

    const install = routes.find((item) => item.operationId === "skills.install")!;
    const update = routes.find((item) => item.operationId === "skills.update")!;
    const remove = routes.find((item) => item.operationId === "skills.delete")!;
    const verify = routes.find((item) => item.operationId === "skills.verify")!;
    const validate = routes.find((item) => item.operationId === "skills.manifest.validate")!;

    await install.handler(makeCtx({ body: { skillId: "skill.alpha", sourceId: "src-1" } }));
    await update.handler(makeCtx({ params: { skillId: "skill.alpha" }, body: { version: "1.1.0" } }));
    await remove.handler(makeCtx({ params: { skillId: "skill.alpha" } }));
    await verify.handler(makeCtx({ params: { skillId: "skill.alpha" } }));
    await validate.handler(makeCtx({ body: { manifest: { id: "skill.alpha" } } }));

    expect(lifecycle.install).toHaveBeenCalledWith(expect.objectContaining({
      skillId: "skill.alpha",
      sourceId: "src-1",
      userId: "user-1",
    }));
    expect(lifecycle.update).toHaveBeenCalledWith(expect.objectContaining({
      skillId: "skill.alpha",
      version: "1.1.0",
      userId: "user-1",
    }));
    expect(lifecycle.deleteSkill).toHaveBeenCalledWith({
      skillId: "skill.alpha",
      deletedBy: "user-1",
    });
    expect(lifecycle.verifySkill).toHaveBeenCalledWith({
      skillId: "skill.alpha",
      userId: "user-1",
    });
    expect(lifecycle.validateManifest).toHaveBeenCalledWith({ id: "skill.alpha" });
  });

  it("rejects missing install skillId and missing manifest payload", async () => {
    const routes = createFridaySkillRoutes({
      skillRegistry: { list: () => [] } as never,
      lifecycle: makeLifecycle() as never,
    });

    await expect(
      routes.find((item) => item.operationId === "skills.install")!.handler(makeCtx({ body: {} })),
    ).rejects.toThrow(FridayDomainError);

    await expect(
      routes.find((item) => item.operationId === "skills.manifest.validate")!.handler(makeCtx({ body: {} })),
    ).rejects.toThrow(FridayDomainError);
  });

  it("executes a skill through the runtime executor instead of returning a dispatch-only placeholder", async () => {
    const lifecycle = makeLifecycle();
    const executor = makeExecutor();
    const routes = createFridaySkillRoutes({
      skillRegistry: { list: () => [] } as never,
      lifecycle: lifecycle as never,
      skillExecutor: executor as never,
    });

    const result = await routes.find((item) => item.operationId === "skills.run")!.handler(makeCtx({
      params: { skillId: "skill.alpha" },
      body: {
        input: { name: "world" },
        channel: "api",
        timeoutMs: 1000,
      },
    }));

    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      skillId: "skill.alpha",
      input: { name: "world" },
      userId: "user-1",
      channel: "api",
      timeoutMs: 1000,
    }));
    expect(result).toHaveProperty("status", "completed");
    expect(result).toHaveProperty("completionDepth", "executed");
    expect(result).toHaveProperty("output.result", "ok");
  });

  it("runs registered shell skills that require the local shell capability", async () => {
    const lifecycle = makeLifecycle();
    const executor = makeExecutor();
    const routes = createFridaySkillRoutes({
      skillRegistry: {
        list: () => [],
        get: vi.fn(() => ({
          manifest: {
            id: "skill.alpha",
            kind: "conversation",
            runtime: { kind: "shell" },
            requirements: { bins: [], env: [], config: [], os: [] },
            executionTargets: {
              allowedSatelliteTypes: ["desktop"],
              requiredCapabilities: ["shell"],
            },
          },
        })),
      } as never,
      lifecycle: lifecycle as never,
      skillExecutor: executor as never,
    });

    const result = await routes.find((item) => item.operationId === "skills.run")!.handler(makeCtx({
      params: { skillId: "skill.alpha" },
      body: { input: {} },
    }));

    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      skillId: "skill.alpha",
    }));
    expect(result).toHaveProperty("status", "completed");
  });

  it("returns CAPABILITY_DISABLED for node-runtime skill execution when the gate is off", async () => {
    const previousGate = process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
    delete process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
    try {
      const lifecycle = makeLifecycle();
      const executor = makeExecutor();
      const routes = createFridaySkillRoutes({
        skillRegistry: {
          list: () => [],
          get: vi.fn(() => ({
            manifest: {
              id: "skill.alpha",
              runtime: { kind: "node" },
            },
          })),
        } as never,
        lifecycle: lifecycle as never,
        skillExecutor: executor as never,
      });

      await expect(
        routes.find((item) => item.operationId === "skills.run")!.handler(makeCtx({
          params: { skillId: "skill.alpha" },
          body: { input: {} },
        })),
      ).rejects.toMatchObject({
        code: "CAPABILITY_DISABLED",
        httpStatus: 501,
      });
      expect(executor.execute).not.toHaveBeenCalled();
    } finally {
      if (previousGate === undefined) {
        delete process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
      } else {
        process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV] = previousGate;
      }
    }
  });

  it("allows bundled system node skills when the runtime gate is off", async () => {
    const previousGate = process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
    delete process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
    try {
      const lifecycle = makeLifecycle();
      const executor = makeExecutor();
      const routes = createFridaySkillRoutes({
        skillRegistry: {
          list: () => [],
          get: vi.fn(() => ({
            source: "bundled",
            origin: "bundled",
            manifest: {
              id: "review-open-issues",
              kind: "system",
              runtime: { kind: "node" },
            },
          })),
        } as never,
        lifecycle: lifecycle as never,
        skillExecutor: executor as never,
      });

      const result = await routes.find((item) => item.operationId === "skills.run")!.handler(makeCtx({
        params: { skillId: "review-open-issues" },
        body: { input: { limit: 10 } },
      }));

      expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
        skillId: "review-open-issues",
        input: { limit: 10 },
      }));
      expect(result).toHaveProperty("status", "completed");
    } finally {
      if (previousGate === undefined) {
        delete process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
      } else {
        process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV] = previousGate;
      }
    }
  });
});
