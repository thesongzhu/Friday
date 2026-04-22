import { describe, expect, it } from "vitest";
import { createFridayAgentSkillsListTool } from "#agent";
import type { FridaySkillRegistry, FridayRegisteredSkill, SkillManifestV2 } from "#skills";

function buildManifest(overrides: Partial<SkillManifestV2>): SkillManifestV2 {
  const base: SkillManifestV2 = {
    schemaVersion: "2.0",
    id: "skill.test",
    name: "Skill Test",
    description: "A test skill",
    version: "1.0.0",
    kind: "conversation",
    category: "utility",
    author: { name: "Friday" },
    tags: [],
    runtime: {
      kind: "node",
      entrypoint: "index.mjs",
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
      os: ["darwin", "linux"],
      mcpServers: [],
    },
    inputs: [],
    outputs: [],
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
  };

  return {
    ...base,
    ...overrides,
    author: { ...base.author, ...(overrides.author ?? {}) },
    runtime: {
      ...base.runtime,
      ...(overrides.runtime ?? {}),
    },
    triggers: {
      ...base.triggers,
      ...(overrides.triggers ?? {}),
    },
    invocation: {
      ...base.invocation,
      ...(overrides.invocation ?? {}),
    },
    requirements: {
      ...base.requirements,
      ...(overrides.requirements ?? {}),
    },
    permissions: {
      ...base.permissions,
      ...(overrides.permissions ?? {}),
    },
    executionTargets: {
      ...base.executionTargets,
      ...(overrides.executionTargets ?? {}),
    },
    telemetry: {
      ...base.telemetry,
      ...(overrides.telemetry ?? {}),
    },
  };
}

function buildRegisteredSkill(input: {
  manifest: SkillManifestV2;
  status?: FridayRegisteredSkill["status"];
  origin?: FridayRegisteredSkill["origin"];
}): FridayRegisteredSkill {
  return {
    manifest: input.manifest,
    skillDir: "/tmp/test-skill",
    source: input.origin === "bundled" ? "bundled" : "local",
    origin: input.origin ?? "bundled",
    status: input.status ?? "installed",
    loaded: {
      skillDir: "/tmp/test-skill",
      manifest: input.manifest,
      loadMode: "manifest-v2",
      declaredFiles: [],
    },
    validation: {
      ok: true,
      issues: [],
    },
    trust: {
      trustTier: "bundled",
      executionMode: "trusted",
      sandboxPolicy: {
        trustTier: "bundled",
        defaultExecutionMode: "trusted",
        allowedExecutionModes: ["trusted", "restricted"],
      },
    },
  };
}

function createRegistry(skills: FridayRegisteredSkill[]): FridaySkillRegistry {
  return {
    list: () => skills,
    get: (skillId) => skills.find((skill) => skill.manifest.id === skillId) ?? null,
    resolveByIntent: () => null,
    validateAll: () => [],
    reload: async () => {},
    refresh: async () => {},
    isCompatible: () => ({ compatible: true, reasons: [] }),
    startWatching: async () => {},
    stopWatching: async () => {},
    close: async () => {},
  };
}

describe("createFridayAgentSkillsListTool", () => {
  it("lists starter skills first with trigger metadata", async () => {
    const tool = createFridayAgentSkillsListTool({
      skillRegistry: createRegistry([
        buildRegisteredSkill({
          manifest: buildManifest({
            id: "review-open-issues",
            name: "Review Open Issues",
            description: "Inspect current issues",
            tags: ["starter", "starter.diagnosis"],
            triggers: {
              intents: ["review_open_issues"],
              phrases: ["review open issues"],
              channels: ["*"],
            },
          }),
        }),
        buildRegisteredSkill({
          manifest: buildManifest({
            id: "repo-health-check",
            name: "Repo Health Check",
            description: "Inspect repo health",
            tags: ["starter", "starter.devops"],
            triggers: {
              intents: ["repo_health_check"],
              phrases: ["review repo health"],
              channels: ["*"],
            },
          }),
        }),
        buildRegisteredSkill({
          manifest: buildManifest({
            id: "idea-clarifier",
            name: "Idea Clarifier",
            description: "Clarify an idea",
            tags: ["starter", "starter.builder"],
            triggers: {
              intents: ["clarify_idea"],
              phrases: ["clarify this idea"],
              channels: ["*"],
            },
          }),
        }),
        buildRegisteredSkill({
          manifest: buildManifest({
            id: "security-review",
            name: "Security Review",
            description: "Audit auth and token safety",
            tags: ["starter", "starter.security"],
            triggers: {
              intents: ["security_review"],
              phrases: ["run a security review"],
              channels: ["*"],
            },
          }),
        }),
        buildRegisteredSkill({
          manifest: buildManifest({
            id: "engineering-retro",
            name: "Engineering Retro",
            description: "Summarize what shipped",
            tags: ["starter", "starter.retro"],
            triggers: {
              intents: ["engineering_retro"],
              phrases: ["run an engineering retro"],
              channels: ["*"],
            },
          }),
        }),
        buildRegisteredSkill({
          manifest: buildManifest({
            id: "custom-skill",
            name: "Custom Skill",
            description: "Other skill",
            tags: ["custom"],
          }),
          origin: "managed",
        }),
      ]),
    });

    const result = await tool.execute({}, new AbortController().signal);
    const parsed = JSON.parse(result.content) as { skills: Array<Record<string, unknown>> };

    expect(parsed.skills[0]?.skillId).toBe("review-open-issues");
    expect(parsed.skills[1]?.skillId).toBe("idea-clarifier");
    expect(parsed.skills[2]?.skillId).toBe("security-review");
    expect(parsed.skills[3]?.skillId).toBe("engineering-retro");
    expect(parsed.skills[0]?.starter).toBe(true);
    expect(parsed.skills[0]?.phrases).toEqual(["review open issues"]);
  });

  it("filters installed status, origin, tag, and free-text query", async () => {
    const tool = createFridayAgentSkillsListTool({
      skillRegistry: createRegistry([
        buildRegisteredSkill({
          manifest: buildManifest({
            id: "repo-health-check",
            name: "Repo Health Check",
            description: "Inspect repo health",
            tags: ["starter", "starter.devops"],
          }),
          origin: "bundled",
          status: "installed",
        }),
        buildRegisteredSkill({
          manifest: buildManifest({
            id: "market-analysis",
            name: "Market Analysis",
            description: "Analyze market logs",
            tags: ["analysis"],
          }),
          origin: "managed",
          status: "disabled",
        }),
      ]),
    });

    const result = await tool.execute(
      {
        installedOnly: true,
        origin: "bundled",
        tag: "starter.devops",
        q: "repo",
      },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result.content) as { count: number; skills: Array<Record<string, unknown>> };

    expect(parsed.count).toBe(1);
    expect(parsed.skills[0]?.skillId).toBe("repo-health-check");
  });

  it("prioritizes CLI-backed starter skills for local repo and ops work", async () => {
    const tool = createFridayAgentSkillsListTool({
      skillRegistry: createRegistry([
        buildRegisteredSkill({
          manifest: buildManifest({
            id: "repo-health-check",
            name: "Repo Health Check",
            description: "Inspect repo health",
            tags: ["starter", "starter.devops", "starter.cli", "cli-backed", "skill.stabilized"],
          }),
          origin: "bundled",
          status: "installed",
        }),
        buildRegisteredSkill({
          manifest: buildManifest({
            id: "workspace-diff-review",
            name: "Workspace Diff Review",
            description: "Review risky changes",
            tags: ["starter", "starter.devops"],
          }),
          origin: "bundled",
          status: "installed",
        }),
      ]),
    });

    const result = await tool.execute(
      { q: "repo health" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result.content) as { skills: Array<Record<string, unknown>> };

    expect(parsed.skills[0]?.skillId).toBe("repo-health-check");
    expect(parsed.skills[0]?.tags).toEqual(
      expect.arrayContaining(["starter.cli", "cli-backed", "skill.stabilized"]),
    );
  });

  it("reports MCP blockers for skills that require authenticated servers", async () => {
    const tool = createFridayAgentSkillsListTool({
      skillRegistry: createRegistry([
        buildRegisteredSkill({
          manifest: buildManifest({
            id: "secure-review",
            name: "Secure Review",
            description: "Review GitHub and SSO setup",
            tags: ["starter", "starter.security"],
            runtime: {
              kind: "shell",
              entrypoint: "run.sh",
              minHubVersion: "1.0.0",
              apiVersion: "1",
              timeoutMsDefault: 30_000,
            },
            requirements: {
              bins: [],
              env: [],
              config: [],
              os: ["darwin", "linux"],
              mcpServers: [{ name: "github", auth: "authenticated" }],
            },
          }),
        }),
      ]),
      listMcpServerReadiness: () => [
        { name: "github", connected: true, authenticated: false },
      ],
    });

    const result = await tool.execute({}, new AbortController().signal);
    const parsed = JSON.parse(result.content) as { skills: Array<Record<string, unknown>> };

    expect(parsed.skills[0]?.ready).toBe(false);
    expect(parsed.skills[0]?.blockers).toEqual([
      'Required MCP server "github" is not authenticated.',
    ]);
    expect(parsed.skills[0]?.requirements).toMatchObject({
      mcpServers: [{ name: "github", auth: "authenticated" }],
    });
  });

  it("reports runtime readiness blockers for missing environment variables", async () => {
    const tool = createFridayAgentSkillsListTool({
      skillRegistry: createRegistry([
        buildRegisteredSkill({
          manifest: buildManifest({
            id: "env-review",
            name: "Env Review",
            description: "Needs a configured token",
            runtime: {
              kind: "shell",
              entrypoint: "run.sh",
              minHubVersion: "1.0.0",
              apiVersion: "1",
              timeoutMsDefault: 30_000,
            },
            requirements: {
              bins: [],
              env: ["FRIDAY_TEST_REQUIRED_ENV"],
              config: [],
              os: ["darwin", "linux"],
              mcpServers: [],
            },
          }),
        }),
      ]),
    });

    const previous = process.env.FRIDAY_TEST_REQUIRED_ENV;
    delete process.env.FRIDAY_TEST_REQUIRED_ENV;
    try {
      const result = await tool.execute({}, new AbortController().signal);
      const parsed = JSON.parse(result.content) as { skills: Array<Record<string, unknown>> };

      expect(parsed.skills[0]?.ready).toBe(false);
      expect(parsed.skills[0]?.blockers).toContain(
        "Missing required environment variables: FRIDAY_TEST_REQUIRED_ENV",
      );
      expect(parsed.skills[0]?.requirements).toMatchObject({
        env: ["FRIDAY_TEST_REQUIRED_ENV"],
      });
    } finally {
      if (previous === undefined) {
        delete process.env.FRIDAY_TEST_REQUIRED_ENV;
      } else {
        process.env.FRIDAY_TEST_REQUIRED_ENV = previous;
      }
    }
  });
});
