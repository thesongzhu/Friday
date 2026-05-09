import { describe, expect, it, vi } from "vitest";

import { createFridayAgentSkillImportTool } from "../../../../src/agent/tools/friday-agent-skill-import-tool.js";

describe("createFridayAgentSkillImportTool", () => {
  it("converts import requests to draft candidates without installing external skills", async () => {
    const converterService = {
      listConverters: vi.fn(() => []),
      detect: vi.fn(),
      convert: vi.fn(async () => ({
        converterId: "code-repo",
        detectedFormat: "code-repo",
        drafts: [{
          manifest: { id: "draft-skill" },
          warnings: ["needs permission review"],
        }],
        validation: [{
          skillId: "draft-skill",
          ok: true,
          issues: [],
        }],
      })),
      getCandidate: vi.fn(() => null),
      import: vi.fn(),
      pack: vi.fn(),
    };

    const tool = createFridayAgentSkillImportTool({ converterService });
    const result = await tool.execute({
      action: "import",
      uri: "https://example.com/skill.git",
      target: "managed",
      replace: true,
      dryRun: false,
    });

    expect(result.isError).not.toBe(true);
    expect(converterService.convert).toHaveBeenCalledWith({
      source: { uri: "https://example.com/skill.git", contentBase64: undefined },
      formatHint: "auto",
      dryRun: true,
    });
    expect(converterService.import).not.toHaveBeenCalled();

    const payload = JSON.parse(result.content) as {
      applied: boolean;
      directInstallRetired: boolean;
      drafts: Array<{ skillId: string; installed: boolean }>;
      registryRefreshed: boolean;
    };
    expect(payload.applied).toBe(false);
    expect(payload.directInstallRetired).toBe(true);
    expect(payload.drafts).toEqual([
      expect.objectContaining({ skillId: "draft-skill", installed: false }),
    ]);
    expect(payload.registryRefreshed).toBe(false);
  });

  it("redacts source material from agent preview errors", async () => {
    const tokenBearingUri = "https://example.com/skill.git?token=agent-secret-token";
    const converterService = {
      listConverters: vi.fn(() => []),
      detect: vi.fn(),
      convert: vi.fn(async () => {
        throw new Error(`Failed to clone git repository: ${tokenBearingUri}`);
      }),
      getCandidate: vi.fn(() => null),
      import: vi.fn(),
      pack: vi.fn(),
    };

    const tool = createFridayAgentSkillImportTool({ converterService });
    const result = await tool.execute({
      action: "import",
      uri: tokenBearingUri,
    });

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain(tokenBearingUri);
    expect(result.content).not.toContain("agent-secret-token");
    expect(result.content).toContain("https://example.com/skill.git?redacted=1");
  });

  it("redacts source material from agent preview warnings and validation issues", async () => {
    const tokenBearingUri = "https://example.com/skill.git?token=agent-warning-secret-token";
    const converterService = {
      listConverters: vi.fn(() => []),
      detect: vi.fn(),
      convert: vi.fn(async () => ({
        converterId: "code-repo",
        detectedFormat: "code-repo",
        drafts: [{
          manifest: { id: "draft-skill" },
          warnings: [`review source ${tokenBearingUri}`],
        }],
        validation: [{
          skillId: "draft-skill",
          ok: false,
          issues: [{
            stage: "manifest",
            severity: "warning",
            code: "SOURCE_WARNING",
            message: `source needs review: ${tokenBearingUri}`,
          }],
        }],
      })),
      getCandidate: vi.fn(() => null),
      import: vi.fn(),
      pack: vi.fn(),
    };

    const tool = createFridayAgentSkillImportTool({ converterService });
    const result = await tool.execute({
      action: "import",
      uri: tokenBearingUri,
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).not.toContain(tokenBearingUri);
    expect(result.content).not.toContain("agent-warning-secret-token");
    expect(result.content).toContain("https://example.com/skill.git?redacted=1");
  });
});
