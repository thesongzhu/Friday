import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FridaySkillConverterService } from "#skills/converter";
import type { FridaySkillGeneratorService } from "#skills/generator";
import type { FridaySkillRegistry } from "#skills";
import {
  createFridayApiTestEnv,
  loginTestUser,
  authHeaders,
  type FridayApiTestEnv,
} from "./_helpers/friday-api-test-server.helper.js";

const NOW = "2025-06-15T10:00:00.000Z";

function createStubConverterService(): FridaySkillConverterService {
  return {
    listConverters() {
      return [
        {
          id: "mock-skill-converter",
          displayName: "Mock Skill Converter",
          sourceFormats: ["clawdbot-skill-md"],
        },
      ];
    },
    async detect() {
      return {
        converterId: "mock-skill-converter",
        format: "clawdbot-skill-md",
        confidence: 1,
        reasons: ["stub"],
      };
    },
    async convert() {
      return {
        converterId: "mock-skill-converter",
        detectedFormat: "clawdbot-skill-md",
        drafts: [
          {
            manifest: {
              id: "mock.skill",
            } as never,
            uiSchema: {
              schemaVersion: "1.0",
              skillId: "mock.skill",
              title: "Mock skill",
              description: "Mock UI",
              submitLabel: "Run",
              fields: [],
            } as never,
            files: [],
            warnings: [],
            conversionReport: {
              sourceFormat: "clawdbot-skill-md",
              convertedAt: NOW,
              converterId: "mock-skill-converter",
            },
          },
        ],
        validation: [
          {
            skillId: "mock.skill",
            ok: true,
            issues: [],
          },
        ],
      };
    },
    async import() {
      return {
        converterId: "mock-skill-converter",
        detectedFormat: "clawdbot-skill-md",
        imports: [],
        registryRefreshed: false,
      };
    },
    async pack() {
      return {
        packageFile: "/tmp/mock-skill.friday.tgz",
        checksumSha256: "mock-checksum",
      };
    },
  };
}

function createStubSkillGeneratorService(): FridaySkillGeneratorService {
  return {
    async startSession() {
      return {
        session: {
          sessionId: "sg-001",
          status: "collecting",
          goal: "mock-goal",
          createdAt: NOW,
          updatedAt: NOW,
        },
        assistantMessage: "What should this skill do?",
        mode: "clarification_required",
      };
    },
    async submitTurn() {
      return {
        session: {
          sessionId: "sg-001",
          status: "ready_to_generate",
          goal: "mock-goal",
          createdAt: NOW,
          updatedAt: NOW,
        },
        assistantMessage: "Ready.",
        mode: "ready_to_generate",
      };
    },
    async getSession() {
      return null;
    },
    async generateDraft() {
      return {
        manifest: {
          id: "mock.skill",
        } as never,
        uiSchema: {
          schemaVersion: "1.0",
          skillId: "mock.skill",
          title: "Mock skill",
          description: "Mock UI",
          submitLabel: "Run",
          fields: [],
        } as never,
        files: [],
        warnings: [],
      };
    },
    async approveAndSave() {
      return {
        sessionId: "sg-001",
        skillId: "mock.skill",
        skillDir: "/tmp/mock.skill",
        savedFiles: [],
        registryRefreshed: false,
      };
    },
    async cancelSession() {
      return;
    },
  };
}

function createStubSkillRegistry(): FridaySkillRegistry {
  return {
    list: () => [],
    get: () => null,
    resolveByIntent: () => null,
    validateAll: () => [],
    reload: async () => {
      return;
    },
    refresh: async () => {
      return;
    },
    isCompatible: () => ({ compatible: true, reasons: [] }),
    startWatching: async () => {
      return;
    },
    stopWatching: async () => {
      return;
    },
    close: async () => {
      return;
    },
  };
}

describe("API — Skill converter and generator routes", () => {
  let env: FridayApiTestEnv;
  let token: string;

  beforeAll(async () => {
    env = await createFridayApiTestEnv({
      converterService: createStubConverterService(),
      skillGenerator: createStubSkillGeneratorService(),
      skillRegistry: createStubSkillRegistry(),
    });
    const login = await loginTestUser(env.baseUrl);
    token = login.accessToken;
  });

  afterAll(async () => {
    await env.close();
  });

  it("skills_converters_list — GET /v1/skills/converters returns converter metadata", async () => {
    const res = await fetch(`${env.baseUrl}/v1/skills/converters`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      ok: boolean;
      data: {
        converters: Array<{ id: string; displayName: string; sourceFormats: string[] }>;
      };
    };
    expect(json.ok).toBe(true);
    expect(json.data.converters.length).toBe(1);
    expect(json.data.converters[0]?.id).toBe("mock-skill-converter");
  });

  it("skills_convert_dry_run — POST /v1/skills/convert with dryRun returns drafts and validation", async () => {
    const res = await fetch(`${env.baseUrl}/v1/skills/convert`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        source: {
          contentBase64: Buffer.from("# mock skill").toString("base64"),
        },
        formatHint: "clawdbot-skill-md",
        dryRun: true,
      }),
    });
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      ok: boolean;
      data: {
        converterId: string;
        detectedFormat: string;
        drafts: Array<{ manifest: { id: string } }>;
        validation: Array<{ skillId: string; ok: boolean }>;
      };
    };
    expect(json.ok).toBe(true);
    expect(json.data.converterId).toBe("mock-skill-converter");
    expect(json.data.drafts[0]?.manifest.id).toBe("mock.skill");
    expect(json.data.validation[0]?.ok).toBe(true);
  });

  it("skills_generator_create_session_validation_error — POST /v1/skills/generator/sessions returns 400 on empty goal", async () => {
    const res = await fetch(`${env.baseUrl}/v1/skills/generator/sessions`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        goal: "",
        userId: "test-user",
        channel: "e2e",
      }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  it("skills_generator_get_session_not_found — GET /v1/skills/generator/sessions/:id returns 404", async () => {
    const res = await fetch(`${env.baseUrl}/v1/skills/generator/sessions/nonexistent`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("SESSION_NOT_FOUND");
  });

  it("skills_ui_get_not_found — GET /v1/skills/:skillId/ui returns 404 when skill is missing", async () => {
    const res = await fetch(`${env.baseUrl}/v1/skills/nonexistent/ui`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("SKILL_NOT_FOUND");
  });
});
