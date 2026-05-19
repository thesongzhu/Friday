import { describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FridayDomainError } from "#errors";
import { FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV } from "#skills";
import {
  createFridaySkillLifecycleRouteMutatingActionRequest,
  createFridaySkillRoutes,
} from "../../../../../src/api/http/routes/friday-skill-routes.js";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
} from "../../../../../src/security/friday-mutating-action-gate.js";

const NOW = "2026-03-07T00:00:00.000Z";

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
      issuedAt: NOW,
    },
    requestId: "req-1",
    receivedAt: NOW,
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
      verifiedAt: NOW,
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

function makeCanonicalMutationGate() {
  return createFridayMutatingActionGate({
    nowIso: () => NOW,
    ticketIdGenerator: () => "ticket-1",
  });
}

function makeLifecycleRouteApproval(input: {
  action: "update" | "delete";
  skillId: string;
  body?: Record<string, unknown>;
}) {
  const body = input.body ?? {};
  const request = createFridaySkillLifecycleRouteMutatingActionRequest({
    action: input.action,
    skillId: input.skillId,
    version: typeof body.version === "string" ? body.version : undefined,
    sourceId: typeof body.sourceId === "string" ? body.sourceId : undefined,
    targetSatelliteIds: input.action === "update"
      ? Array.isArray(body.targetSatelliteIds) ? body.targetSatelliteIds as string[] : []
      : undefined,
    grantPermissions: input.action === "update"
      ? Array.isArray(body.grantPermissions) ? body.grantPermissions as string[] : []
      : undefined,
    actor: {
      kind: "user",
      id: "user-1",
      principalId: "user-1",
    },
    surface: input.action === "update" ? "api:/v1/skills/:skillId/update" : "api:/v1/skills/:skillId",
    idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
  });
  return {
    decision: "approved" as const,
    approvalId: `${input.action}-approval-1`,
    decidedByPrincipalId: "user-1",
    actionDigest: createFridayMutatingActionDigest(request),
    expiresAt: "2026-03-07T01:00:00.000Z",
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

  it("uses persisted lifecycle status over registry status in GET /v1/skills fallback", async () => {
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
      getSkillLifecycleStatus: (skillId) =>
        skillId === "skill.alpha" ? "not_installed" : undefined,
    });

    const route = routes.find((item) => item.operationId === "skills.list");
    const result = await route!.handler(makeCtx());
    expect(result).toHaveProperty("items.0.skillId", "skill.alpha");
    expect(result).toHaveProperty("items.0.status", "not_installed");
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

	  it("keeps retired legacy mutation operation ids when the lifecycle service is unavailable", async () => {
	    const routes = createFridaySkillRoutes({
	      skillRegistry: { list: () => [] } as never,
	      registerRetiredLegacySkillMutationRoutes: true,
	    });

	    expect(routes.map((route) => route.operationId)).toEqual([
	      "skills.list",
	      "skills.install",
	      "skills.update",
	      "skills.delete",
	      "skills.run",
	    ]);

	    await expect(
	      routes.find((item) => item.operationId === "skills.install")!
	        .handler(makeCtx({ body: { skillId: "skill.alpha" } })),
	    ).rejects.toMatchObject({ code: "SKILL_LEGACY_LIFECYCLE_ROUTE_RETIRED" });
	    await expect(
	      routes.find((item) => item.operationId === "skills.update")!
	        .handler(makeCtx({ params: { skillId: "skill.alpha" } })),
	    ).rejects.toMatchObject({ code: "SKILL_LEGACY_LIFECYCLE_ROUTE_RETIRED" });
	    await expect(
	      routes.find((item) => item.operationId === "skills.delete")!
	        .handler(makeCtx({ params: { skillId: "skill.alpha" } })),
	    ).rejects.toMatchObject({ code: "SKILL_LEGACY_LIFECYCLE_ROUTE_RETIRED" });
	  });

	  it("blocks legacy install/update/delete for managed external skills while keeping read verification routes active", async () => {
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

    await expect(install.handler(makeCtx({ body: { skillId: "skill.alpha", sourceId: "src-1" } })))
      .rejects.toMatchObject({ code: "SKILL_LEGACY_LIFECYCLE_ROUTE_RETIRED" });
    await expect(update.handler(makeCtx({ params: { skillId: "skill.alpha" }, body: { version: "1.1.0" } })))
      .rejects.toMatchObject({ code: "SKILL_LEGACY_LIFECYCLE_ROUTE_RETIRED" });
    await expect(remove.handler(makeCtx({ params: { skillId: "skill.alpha" } })))
      .rejects.toMatchObject({ code: "SKILL_LEGACY_LIFECYCLE_ROUTE_RETIRED" });
    await verify.handler(makeCtx({ params: { skillId: "skill.alpha" } }));
    await validate.handler(makeCtx({ body: { manifest: { id: "skill.alpha" } } }));

    expect(lifecycle.install).not.toHaveBeenCalled();
    expect(lifecycle.update).not.toHaveBeenCalled();
    expect(lifecycle.deleteSkill).not.toHaveBeenCalled();
    expect(lifecycle.verifySkill).toHaveBeenCalledWith({
      skillId: "skill.alpha",
      userId: "user-1",
    });
    expect(lifecycle.validateManifest).toHaveBeenCalledWith({ id: "skill.alpha" });
  });

  it("requires canonical approval before non-managed lifecycle update/delete", async () => {
    const lifecycle = makeLifecycle();
    lifecycle.getSkill.mockImplementation((skillId: string) => ({
      skillId,
      name: "Workspace Skill",
      source: "workspace",
      origin: "workspace",
      status: "installed",
      starter: false,
      tags: [],
      updateAvailable: false,
      managed: false,
      registryLoaded: true,
      versions: [],
      installations: [],
    }));
    const routes = createFridaySkillRoutes({
      skillRegistry: { list: () => [] } as never,
      lifecycle: lifecycle as never,
      canonicalMutationGate: makeCanonicalMutationGate(),
    });

    const update = routes.find((item) => item.operationId === "skills.update")!;
    const remove = routes.find((item) => item.operationId === "skills.delete")!;

    await expect(
      update.handler(makeCtx({ params: { skillId: "skill.alpha" }, body: { version: "1.1.0" } })),
    ).rejects.toMatchObject({
      code: "SKILL_LIFECYCLE_UPDATE_APPROVAL_REQUIRED",
      httpStatus: 403,
    });
    await expect(
      remove.handler(makeCtx({ params: { skillId: "skill.alpha" } })),
    ).rejects.toMatchObject({
      code: "SKILL_LIFECYCLE_DELETE_APPROVAL_REQUIRED",
      httpStatus: 403,
    });

    expect(lifecycle.update).not.toHaveBeenCalled();
    expect(lifecycle.deleteSkill).not.toHaveBeenCalled();
  });

  it("passes canonical approval through non-managed lifecycle update/delete", async () => {
    const lifecycle = makeLifecycle();
    lifecycle.getSkill.mockImplementation((skillId: string) => ({
      skillId,
      name: "Workspace Skill",
      source: "workspace",
      origin: "workspace",
      status: "installed",
      starter: false,
      tags: [],
      updateAvailable: false,
      managed: false,
      registryLoaded: true,
      versions: [],
      installations: [],
    }));
    const routes = createFridaySkillRoutes({
      skillRegistry: { list: () => [] } as never,
      lifecycle: lifecycle as never,
      canonicalMutationGate: makeCanonicalMutationGate(),
    });

    const update = routes.find((item) => item.operationId === "skills.update")!;
    const remove = routes.find((item) => item.operationId === "skills.delete")!;
    const updateBody = { version: "1.1.0", idempotencyKey: "update-1" };

    await update.handler(makeCtx({
      params: { skillId: "skill.alpha" },
      body: {
        ...updateBody,
        canonicalApproval: makeLifecycleRouteApproval({
          action: "update",
          skillId: "skill.alpha",
          body: updateBody,
        }),
      },
    }));
    await remove.handler(makeCtx({
      params: { skillId: "skill.alpha" },
      body: {
        canonicalApproval: makeLifecycleRouteApproval({
          action: "delete",
          skillId: "skill.alpha",
        }),
      },
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
      skillRegistry: {
        list: () => [],
        get: vi.fn(() => ({
          source: "bundled",
          origin: "bundled",
          manifest: {
            id: "skill.alpha",
            kind: "conversation",
            runtime: { kind: "shell" },
            requirements: { bins: [], env: [], config: [], os: [] },
            executionTargets: {
              allowedSatelliteTypes: ["desktop"],
              requiredCapabilities: [],
            },
          },
        })),
      } as never,
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

  it("blocks lifecycle-visible skills that are staged but not installed", async () => {
    const lifecycle = makeLifecycle();
    lifecycle.getSkill.mockReturnValueOnce({
      skillId: "skill.staged",
      name: "Staged",
      source: "external",
      origin: "managed",
      status: "not_installed",
      starter: false,
      tags: [],
      updateAvailable: false,
      managed: true,
      registryLoaded: false,
      currentManifest: {
        kind: "conversation",
        runtime: { kind: "shell" },
      },
      versions: [],
      installations: [],
    });
    const executor = makeExecutor();
    const routes = createFridaySkillRoutes({
      skillRegistry: {
        list: () => [],
        get: vi.fn(() => null),
      } as never,
      lifecycle: lifecycle as never,
      skillExecutor: executor as never,
    });

    await expect(
      routes.find((item) => item.operationId === "skills.run")!.handler(makeCtx({
        params: { skillId: "skill.staged" },
        body: { input: {} },
      })),
    ).rejects.toMatchObject({
      code: "SKILL_NOT_AVAILABLE",
      httpStatus: 409,
      details: {
        skillId: "skill.staged",
        status: "not_installed",
      },
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("blocks registry-visible skills when persisted lifecycle status is unavailable", async () => {
    const executor = makeExecutor();
    const routes = createFridaySkillRoutes({
      skillRegistry: {
        list: () => [],
        get: vi.fn(() => ({
          status: "installed",
          manifest: {
            id: "skill.alpha",
            kind: "conversation",
            runtime: { kind: "shell" },
            requirements: { bins: [], env: [], config: [], os: [] },
            executionTargets: {
              allowedSatelliteTypes: ["desktop"],
              requiredCapabilities: [],
            },
          },
        })),
      } as never,
      getSkillLifecycleStatus: (skillId) =>
        skillId === "skill.alpha" ? "not_installed" : undefined,
      skillExecutor: executor as never,
    });

    await expect(
      routes.find((item) => item.operationId === "skills.run")!.handler(makeCtx({
        params: { skillId: "skill.alpha" },
        body: { input: {} },
      })),
    ).rejects.toMatchObject({
      code: "SKILL_NOT_AVAILABLE",
      httpStatus: 409,
      details: {
        skillId: "skill.alpha",
        status: "not_installed",
      },
    });
    expect(executor.execute).not.toHaveBeenCalled();
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

  it("rejects in-place content edits for promoted managed external skills", async () => {
    const managedSkillsDir = join(tmpdir(), `friday-skill-route-managed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const skillDir = join(managedSkillsDir, "skill.external");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Original\n", "utf8");
    writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify({
      id: "skill.external",
      name: "Original",
      version: "1.0.0",
      runtime: { kind: "shell" },
    }, null, 2), "utf8");
    try {
      const routes = createFridaySkillRoutes({
        managedSkillsDir,
        skillRegistry: {
          list: () => [],
          get: vi.fn(() => ({
            source: "local",
            origin: "managed",
            status: "installed",
            manifest: {
              id: "skill.external",
              name: "Original",
              kind: "conversation",
              runtime: { kind: "shell" },
            },
          })),
        } as never,
      });

      await expect(
        routes.find((item) => item.operationId === "skills.content.update")!.handler(makeCtx({
          params: { skillId: "skill.external" },
          body: {
            name: "Changed",
            description: "Changed description",
            tags: ["changed"],
          },
        })),
      ).rejects.toMatchObject({
        code: "SKILL_CONTENT_UPDATE_REQUIRES_LIFECYCLE",
        httpStatus: 409,
      });

      expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe("# Original\n");
      expect(JSON.parse(readFileSync(join(skillDir, "skill.manifest.json"), "utf8"))).toMatchObject({
        name: "Original",
      });
    } finally {
      rmSync(managedSkillsDir, { recursive: true, force: true });
    }
  });

  it("rejects content update skill IDs that would alias to another managed directory", async () => {
    const managedSkillsDir = join(tmpdir(), `friday-skill-route-managed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const skillDir = join(managedSkillsDir, "skill-alpha");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Original\n", "utf8");

    try {
      const routes = createFridaySkillRoutes({ managedSkillsDir });

      await expect(
        routes.find((item) => item.operationId === "skills.content.update")!.handler(makeCtx({
          params: { skillId: "skill+alpha" },
          body: {
            description: "Changed description",
          },
        })),
      ).rejects.toMatchObject({
        code: "SKILL_INVALID_ID",
        httpStatus: 400,
      });

      expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe("# Original\n");
    } finally {
      rmSync(managedSkillsDir, { recursive: true, force: true });
    }
  });
});
