import { describe, it, expect } from "vitest";
import type {
  FridaySkillSourceFormat,
  FridaySkillConversionSource,
  FridaySkillConverterDetection,
  FridayConvertedSkillFile,
  FridayConvertedSkillDraft,
  FridaySkillConverterResult,
  FridaySkillConverterContext,
  FridaySkillConverter,
} from "#skills/converter";

describe("FridaySkillConverter types", () => {
  it("FridaySkillSourceFormat accepts valid string literals", () => {
    const formats: FridaySkillSourceFormat[] = [
      "friday-package",
      "clawdbot-skill-md",
      "n8n-node",
      "openai-gpt-action",
      "code-repo",
      "undocumented-api",
      "unknown",
    ];
    expect(formats).toHaveLength(7);
  });

  it("FridaySkillConversionSource allows minimal construction", () => {
    const source: FridaySkillConversionSource = {};
    expect(source.uri).toBeUndefined();
    expect(source.contentBase64).toBeUndefined();
    expect(source.formatHint).toBeUndefined();
  });

  it("FridaySkillConversionSource accepts all fields", () => {
    const source: FridaySkillConversionSource = {
      uri: "/path/to/skill",
      contentBase64: "dGVzdA==",
      formatHint: "auto",
    };
    expect(source.uri).toBe("/path/to/skill");
    expect(source.contentBase64).toBe("dGVzdA==");
    expect(source.formatHint).toBe("auto");
  });

  it("FridaySkillConverterDetection has correct shape", () => {
    const detection: FridaySkillConverterDetection = {
      converterId: "test",
      format: "clawdbot-skill-md",
      confidence: 0.9,
      reasons: ["found SKILL.md"],
    };
    expect(detection.confidence).toBe(0.9);
    expect(detection.reasons).toHaveLength(1);
  });

  it("FridayConvertedSkillFile accepts optional executable flag", () => {
    const file: FridayConvertedSkillFile = {
      path: "run.sh",
      content: "#!/bin/bash\necho hello",
      executable: true,
    };
    expect(file.executable).toBe(true);

    const fileNoExec: FridayConvertedSkillFile = {
      path: "README.md",
      content: "# Hello",
    };
    expect(fileNoExec.executable).toBeUndefined();
  });

  it("FridaySkillConverterContext provides required fields", () => {
    const ctx: FridaySkillConverterContext = {
      workspaceDir: "/workspace",
      managedSkillsDir: "/managed",
      nowIso: () => "2026-01-01T00:00:00.000Z",
    };
    expect(ctx.nowIso()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("FridaySkillConverter interface shape can be satisfied", () => {
    const converter: FridaySkillConverter = {
      id: "test-converter",
      displayName: "Test Converter",
      priority: 50,
      detect: async () => null,
      convert: async (_source, ctx) => ({
        converterId: "test-converter",
        detectedFormat: "unknown",
        drafts: [],
      }),
    };
    expect(converter.id).toBe("test-converter");
  });
});
